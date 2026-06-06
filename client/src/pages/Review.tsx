import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getReviewQueue,
  getWordUsages,
  recordWordReview,
  type ReviewQueueRow,
} from "../api/client";
import { useVocab } from "../contexts/VocabContext";
import { parseAnnotatedText } from "../lib/furigana";
import { renderSnippet } from "../lib/renderSnippet";
import { extractSentenceSnippet } from "../lib/sentenceSnippet";
import AnimatedDots from "../components/AnimatedDots";
import HiddenWordsModal from "../components/HiddenWordsModal";
import WordPopover from "../components/WordPopover";
import type { WordUsage } from "../types";
import "./Review.css";

// Cooldowns passed to record_word_review. `null` means hide the word
// forever — server stores eligible_at = 'infinity'.
const NEXT_COOLDOWN_HOURS = 24;
const HIDE_COOLDOWN = null;

interface CardSnippet {
  text: string;
  annotations: ReturnType<typeof parseAnnotatedText>["annotations"];
  surfaceStart: number;
  surfaceEnd: number;
}

function buildSnippet(usage: WordUsage): CardSnippet | null {
  const { cleanText, annotations } = parseAnnotatedText(usage.sourceContent);
  const snippet = extractSentenceSnippet(
    cleanText,
    annotations,
    usage.startOffset,
    usage.endOffset
  );
  if (!snippet) return null;
  return {
    text: snippet.text,
    annotations: snippet.annotations,
    surfaceStart: snippet.surfaceStart,
    surfaceEnd: snippet.surfaceEnd,
  };
}

export default function Review() {
  const { vocabEncountersLoaded, getWordRank } = useVocab();
  // Snapshot the queue once per mount — reads in other tabs during the
  // session shouldn't reshuffle the order under the user.
  const [queue, setQueue] = useState<ReviewQueueRow[] | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [usage, setUsage] = useState<WordUsage | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getReviewQueue()
      .then((rows) => {
        if (!cancelled) setQueue(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setQueueError(
            err instanceof Error ? err.message : "Failed to load review queue"
          );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Client-side sort by JPDB rank ascending (most common first), tiebreak
  // by lastReadAt ascending (oldest exposure first). Unranked words sink
  // to the bottom. Postgres has no rank index — it lives in the client's
  // JPDB frequency cache — so the sort can't happen server-side.
  const sortedQueue = useMemo(() => {
    if (!queue || !vocabEncountersLoaded) return null;
    return [...queue].sort((a, b) => {
      const rankA = getWordRank(a.headword);
      const rankB = getWordRank(b.headword);
      if (rankA === null && rankB === null) {
        return a.lastReadAt.localeCompare(b.lastReadAt);
      }
      if (rankA === null) return 1;
      if (rankB === null) return -1;
      if (rankA !== rankB) return rankA - rankB;
      return a.lastReadAt.localeCompare(b.lastReadAt);
    });
  }, [queue, vocabEncountersLoaded, getWordRank]);

  const current =
    sortedQueue && index < sortedQueue.length ? sortedQueue[index] : null;

  // Fetch the usage for the active headword. For a once-seen word there's
  // exactly one row; we take the first per the spec. If the RPC returns
  // empty (shouldn't happen — the queue is built from indexed occurrences)
  // we just leave usage null and the card shows a fallback message.
  useEffect(() => {
    if (!current) {
      /* eslint-disable react-hooks/set-state-in-effect -- clear stale usage at end-of-queue */
      setUsage(null);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }
    let cancelled = false;
    setUsage(null);
    setUsageLoading(true);
    getWordUsages(current.headword)
      .then((rows) => {
        if (cancelled) return;
        setUsage(rows[0] ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setUsage(null);
      })
      .finally(() => {
        if (!cancelled) setUsageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [current]);

  const snippet = useMemo(
    () => (usage ? buildSnippet(usage) : null),
    [usage]
  );

  const advance = useCallback(
    (cooldownHours: number | null) => {
      if (current) {
        // Fire-and-forget — a failed upsert just means the word will
        // reappear next session. The api wrapper swallows the error.
        // Scoring is independent of review state so no vocab refresh
        // is needed here.
        void recordWordReview(current.headword, cooldownHours);
      }
      setRevealed(false);
      setIndex((i) => i + 1);
    },
    [current]
  );

  const handleNext = useCallback(
    () => advance(NEXT_COOLDOWN_HOURS),
    [advance]
  );
  const handleHide = useCallback(() => advance(HIDE_COOLDOWN), [advance]);

  if (queueError) {
    return (
      <div className="review-page review-page--message">
        <p>Couldn't load the review queue: {queueError}</p>
      </div>
    );
  }

  if (queue === null || !vocabEncountersLoaded || sortedQueue === null) {
    return (
      <div className="loading">
        Loading review
        <AnimatedDots />
      </div>
    );
  }

  // Always render the Hidden words affordance in the header — even on
  // empty / caught-up screens — so the user can still get to the list.
  const header = (
    <header className="review-header">
      <h1>Review</h1>
      <button
        type="button"
        className="review-hidden-link"
        onClick={() => setShowHidden(true)}
      >
        Hidden words
      </button>
      {sortedQueue.length > 0 && current && (
        <span className="review-progress">
          {index + 1} / {sortedQueue.length}
        </span>
      )}
    </header>
  );

  if (sortedQueue.length === 0) {
    return (
      <div className="review-page review-page--message">
        {header}
        <p className="review-empty">Nothing to review right now.</p>
        <p className="review-empty-hint">
          Words you've encountered exactly once will appear here, most
          common first. Read a story or chat to build up your queue.
        </p>
        <HiddenWordsModal
          open={showHidden}
          onClose={() => setShowHidden(false)}
        />
      </div>
    );
  }

  if (!current) {
    return (
      <div className="review-page review-page--message">
        {header}
        <p className="review-empty">All caught up ✓</p>
        <p className="review-empty-hint">
          You've reviewed every once-seen word in the queue. Come back
          later — new exposures and words coming off cooldown will show
          up here.
        </p>
        <HiddenWordsModal
          open={showHidden}
          onClose={() => setShowHidden(false)}
        />
      </div>
    );
  }

  return (
    <div className="review-page">
      {header}

      <div className="review-card">
        {usageLoading ? (
          <div className="review-card__loading">
            Loading
            <AnimatedDots />
          </div>
        ) : snippet ? (
          <div className="review-card__sentence">
            {renderSnippet(
              snippet.text,
              snippet.annotations,
              snippet.surfaceStart,
              snippet.surfaceEnd,
              "review-card__highlight"
            )}
          </div>
        ) : (
          <div className="review-card__sentence review-card__sentence--missing">
            (No example sentence available.)
          </div>
        )}
      </div>

      <div className="review-actions">
        {revealed ? (
          <button
            type="button"
            className="review-show-btn"
            onClick={handleNext}
          >
            Next →
          </button>
        ) : (
          <>
            <button
              type="button"
              className="review-skip-btn"
              onClick={handleHide}
            >
              Hide
            </button>
            <button
              type="button"
              className="review-show-btn"
              onClick={() => setRevealed(true)}
              disabled={usageLoading || !snippet}
            >
              Show Answer
            </button>
          </>
        )}
      </div>

      <WordPopover
        mode={{
          kind: "headword",
          headword: current.headword,
          entryId: null,
          reading: null,
        }}
        open={revealed}
        onOpenChange={setRevealed}
        onNext={handleNext}
      />

      <HiddenWordsModal
        open={showHidden}
        onClose={() => setShowHidden(false)}
      />
    </div>
  );
}
