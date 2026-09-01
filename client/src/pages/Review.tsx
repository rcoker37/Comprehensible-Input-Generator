import { useCallback, useEffect, useState } from "react";
import {
  deleteSentenceCard,
  getSentenceCardQueue,
  recordSentenceCardReview,
} from "../api/client";
import { renderRuby } from "../lib/renderSnippet";
import { sentenceCardKeyFromIds } from "../lib/sentenceCardKey";
import { useSentenceCards } from "../contexts/SentenceCardsContext";
import AnimatedDots from "../components/AnimatedDots";
import { SentenceAudioButton } from "../components/SentenceAudioButton";
import type { SentenceCard, SentenceCardAudio } from "../types";
import "./Review.css";

export default function Review() {
  const { markRemoved } = useSentenceCards();
  // Snapshot the queue once per mount — cards coming due, or mined in
  // another tab mid-session, shouldn't reshuffle the deck under the user.
  const [queue, setQueue] = useState<SentenceCard[] | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSentenceCardQueue()
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

  const advance = useCallback(
    (passed: boolean) => {
      if (current) {
        // Fire-and-forget — a failed stamp just means the card reappears
        // next session. Scoring is independent of review state, so nothing
        // else needs refreshing.
        void recordSentenceCardReview(current.id, passed);
      }
      setRevealed(false);
      setIndex((i) => i + 1);
    },
    [current]
  );

  const handlePass = useCallback(() => advance(true), [advance]);
  const handleFail = useCallback(() => advance(false), [advance]);

  // A card generated its audio on demand (pre-feature card, or the
  // fire-and-forget generation from Add to Reviews hadn't landed when the
  // queue was snapshotted) — patch it in place so replays skip generation.
  const handleAudioGenerated = useCallback(
    (cardId: number, audio: SentenceCardAudio) => {
      setQueue((prev) =>
        prev ? prev.map((c) => (c.id === cardId ? { ...c, audio } : c)) : prev
      );
    },
    []
  );

  // Delete drops the card from the deck in place: the index stays put, so
  // the next card slides into view without a gap (and lands on the
  // end-of-queue state if it was the last one).
  const handleDelete = useCallback(async () => {
    if (!current) return;
    if (!window.confirm("Delete this card? This cannot be undone.")) return;
    try {
      await deleteSentenceCard(current.id);
      const key = sentenceCardKeyFromIds(
        current.storyId,
        current.chatMessageId,
        current.sentenceStart,
        current.sentenceEnd
      );
      // Let the word popover offer "Add to Reviews" on this sentence again.
      if (key) markRemoved(key);
      setQueue((prev) =>
        prev ? prev.filter((c) => c.id !== current.id) : prev
      );
      setRevealed(false);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to delete card"
      );
    }
  }, [current, markRemoved]);

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

  const header = (
    <header className="review-header">
      <h1>Review</h1>
      {queue.length > 0 && current && (
        <span className="review-progress">
          {index + 1} / {queue.length}
        </span>
      )}
    </header>
  );

  if (queue.length === 0) {
    return (
      <div className="review-page review-page--message">
        {header}
        <p className="review-empty">Nothing to review right now.</p>
        <p className="review-empty-hint">
          Tap a word while reading and choose "Add to Reviews" to save the
          sentence it's in. Saved sentences show up here.
        </p>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="review-page review-page--message">
        {header}
        <p className="review-empty">All caught up ✓</p>
        <p className="review-empty-hint">
          You've reviewed every card that's due. Come back later — cards
          coming off their interval will show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="review-page">
      {header}

      {actionError && <div className="error">{actionError}</div>}

      <div className="review-card">
        <button
          type="button"
          className="review-card__delete"
          onClick={() => void handleDelete()}
          title="Delete this card"
          aria-label="Delete this card"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <line x1="3" y1="3" x2="11" y2="11" />
            <line x1="11" y1="3" x2="3" y2="11" />
          </svg>
        </button>

        {/* The annotations argument is the reveal: the front passes none, so
            the sentence renders as bare Japanese; the back passes the card's
            full set, so every reading appears at once. */}
        <div className="review-card__sentence">
          {renderRuby(current.sentenceText, revealed ? current.annotations : [])}
        </div>

        {revealed && (
          <>
            <div className="review-card__translation">
              {current.translation}
            </div>
            <div className="review-card__audio">
              <SentenceAudioButton
                key={current.id}
                kind="card"
                cardId={current.id}
                audioPath={current.audio?.path ?? null}
                onGenerated={(audio) => handleAudioGenerated(current.id, audio)}
              />
            </div>
          </>
        )}
      </div>

      <div className="review-actions">
        {revealed ? (
          <>
            <button
              type="button"
              className="review-fail-btn"
              onClick={handleFail}
            >
              Fail
            </button>
            <button
              type="button"
              className="review-pass-btn"
              onClick={handlePass}
            >
              Pass
            </button>
          </>
        ) : (
          <button
            type="button"
            className="review-show-btn"
            onClick={() => setRevealed(true)}
          >
            Show Answer
          </button>
        )}
      </div>
    </div>
  );
}
