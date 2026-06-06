import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getReviewQueue,
  getWordUsages,
  recordWordReview,
  type ReviewQueueRow,
} from "../api/client";
import { parseAnnotatedText } from "../lib/furigana";
import { renderSnippet } from "../lib/renderSnippet";
import { extractSentenceSnippet } from "../lib/sentenceSnippet";
import AnimatedDots from "../components/AnimatedDots";
import WordPopover from "../components/WordPopover";
import type { WordUsage } from "../types";
import "./Review.css";

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
  // Snapshot the queue once per mount — reads in other tabs during the
  // session shouldn't reshuffle the order under the user.
  const [queue, setQueue] = useState<ReviewQueueRow[] | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [usage, setUsage] = useState<WordUsage | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);

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

  const current = queue && index < queue.length ? queue[index] : null;

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

  const advance = useCallback(() => {
    if (current) {
      // Fire-and-forget — a failed upsert just means the word will reappear
      // next session. The api wrapper already swallows the error.
      void recordWordReview(current.headword);
    }
    setRevealed(false);
    setIndex((i) => i + 1);
  }, [current]);

  if (queueError) {
    return (
      <div className="review-page review-page--message">
        <p>Couldn't load the review queue: {queueError}</p>
      </div>
    );
  }

  if (queue === null) {
    return (
      <div className="loading">
        Loading review
        <AnimatedDots />
      </div>
    );
  }

  if (queue.length === 0) {
    return (
      <div className="review-page review-page--message">
        <h1>Review</h1>
        <p className="review-empty">Nothing to review right now.</p>
        <p className="review-empty-hint">
          Words you've encountered exactly once will appear here, oldest
          first. Read a story or chat to build up your queue.
        </p>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="review-page review-page--message">
        <h1>Review</h1>
        <p className="review-empty">All caught up ✓</p>
        <p className="review-empty-hint">
          You've reviewed every once-seen word in the queue. Come back
          later — new exposures and words coming off cooldown will show up
          here.
        </p>
      </div>
    );
  }

  return (
    <div className="review-page">
      <header className="review-header">
        <h1>Review</h1>
        <span className="review-progress">
          {index + 1} / {queue.length}
        </span>
      </header>

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
        {!revealed && (
          <button
            type="button"
            className="review-show-btn"
            onClick={() => setRevealed(true)}
            disabled={usageLoading || !snippet}
          >
            Show Answer
          </button>
        )}
        <button type="button" className="review-skip-btn" onClick={advance}>
          {revealed ? "Next →" : "Skip →"}
        </button>
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
        onNext={advance}
      />
    </div>
  );
}
