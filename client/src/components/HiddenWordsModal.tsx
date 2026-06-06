import { useCallback, useEffect, useState } from "react";
import {
  clearWordReview,
  getHiddenWords,
  type HiddenWordRow,
} from "../api/client";
import { useVocab } from "../contexts/VocabContext";
import { lookupFrequencyByCanonicalSync } from "../lib/frequency";
import AnimatedDots from "./AnimatedDots";
import Modal from "./Modal";
import WordPopover from "./WordPopover";
import "./HiddenWordsModal.css";

// Resolve the JMdict canonical headword the indexer stamped (e.g. 此処,
// the kanji form of an `uk` entry) to the JPDB-preferred display form
// (ここ). Falls back to the canonical when the word isn't in JPDB or
// the index isn't loaded yet. The canonical is still what the popover
// lookup keys on — only the rendered label changes.
function displayLabel(canonical: string, indexReady: boolean): string {
  if (!indexReady) return canonical;
  return lookupFrequencyByCanonicalSync(canonical)?.headword ?? canonical;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function HiddenWordsModal({ open, onClose }: Props) {
  const { vocabEncountersLoaded } = useVocab();
  const [words, setWords] = useState<HiddenWordRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeHeadword, setActiveHeadword] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());

  // Fetch on every open so the list reflects words hidden during this
  // session without keeping a stale snapshot around when the modal
  // is closed.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setWords(null);
    getHiddenWords()
      .then((rows) => {
        if (!cancelled) setWords(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "Failed to load hidden words"
          );
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleUnhide = useCallback(async (headword: string) => {
    setPending((prev) => {
      const next = new Set(prev);
      next.add(headword);
      return next;
    });
    try {
      await clearWordReview(headword);
      setWords((prev) => prev?.filter((w) => w.headword !== headword) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unhide word");
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(headword);
        return next;
      });
    }
  }, []);

  // Close the popover (if any) when the modal closes so it doesn't
  // strand open over the page beneath.
  useEffect(() => {
    if (!open) setActiveHeadword(null);
  }, [open]);

  return (
    <>
      <Modal open={open} onClose={onClose} className="hidden-words-modal">
        <div className="hidden-words-modal__inner">
          <header className="hidden-words-modal__header">
            <h2>Hidden words</h2>
            {words && (
              <span className="hidden-words-modal__count">
                {words.length.toLocaleString()}
              </span>
            )}
          </header>

          <p className="hidden-words-modal__hint">
            Hidden words don't appear in the review queue. Unhiding puts
            a word back in immediately on the next visit.
          </p>

          {error && <p className="hidden-words-modal__error">{error}</p>}

          {words === null ? (
            <div className="hidden-words-modal__loading">
              Loading
              <AnimatedDots />
            </div>
          ) : words.length === 0 ? (
            <p className="hidden-words-modal__empty">
              Nothing hidden yet — tap Hide in the review queue to add a
              word.
            </p>
          ) : (
            <ul className="hidden-words-modal__list">
              {words.map((w) => {
                const isPending = pending.has(w.headword);
                const label = displayLabel(w.headword, vocabEncountersLoaded);
                return (
                  <li key={w.headword} className="hidden-words-modal__row">
                    <button
                      type="button"
                      className="hidden-words-modal__word"
                      onClick={() => setActiveHeadword(w.headword)}
                      disabled={isPending}
                    >
                      {label}
                    </button>
                    <button
                      type="button"
                      className="hidden-words-modal__unhide"
                      onClick={() => handleUnhide(w.headword)}
                      disabled={isPending}
                    >
                      {isPending ? "…" : "Unhide"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Modal>

      {activeHeadword && (
        <WordPopover
          mode={{
            kind: "headword",
            headword: activeHeadword,
            entryId: null,
            reading: null,
          }}
          open={true}
          onOpenChange={(o) => {
            if (!o) setActiveHeadword(null);
          }}
        />
      )}
    </>
  );
}
