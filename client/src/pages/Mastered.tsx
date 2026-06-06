import { useCallback, useEffect, useState } from "react";
import {
  clearWordReview,
  getMasteredWords,
  type MasteredWordRow,
} from "../api/client";
import { useVocab } from "../contexts/VocabContext";
import AnimatedDots from "../components/AnimatedDots";
import WordPopover from "../components/WordPopover";
import "./Mastered.css";

export default function Mastered() {
  const { prepareVocabRefresh } = useVocab();
  const [words, setWords] = useState<MasteredWordRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeHeadword, setActiveHeadword] = useState<string | null>(null);
  // Per-headword in-flight set so the user can't double-click Unmark
  // while the RPC is in flight (also disables the row visually).
  const [pending, setPending] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    getMasteredWords()
      .then((rows) => {
        if (!cancelled) setWords(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "Failed to load mastered words"
          );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleUnmark = useCallback(
    async (headword: string) => {
      setPending((prev) => {
        const next = new Set(prev);
        next.add(headword);
        return next;
      });
      try {
        await clearWordReview(headword);
        setWords((prev) => prev?.filter((w) => w.headword !== headword) ?? null);
        // Drop the encounter-cap override so the nav score + furigana
        // reflect the word's real encounter count again.
        void prepareVocabRefresh().then((commit) => commit());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to unmark word");
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(headword);
          return next;
        });
      }
    },
    [prepareVocabRefresh]
  );

  if (error && words === null) {
    return (
      <div className="mastered-page mastered-page--message">
        <p>Couldn't load: {error}</p>
      </div>
    );
  }

  if (words === null) {
    return (
      <div className="loading">
        Loading
        <AnimatedDots />
      </div>
    );
  }

  return (
    <div className="mastered-page">
      <header className="mastered-header">
        <h1>Mastered</h1>
        <span className="mastered-count">{words.length.toLocaleString()}</span>
      </header>

      <p className="mastered-hint">
        Words you've marked Never forget. Unmarking puts a word back into
        the Review queue immediately.
      </p>

      {error && <p className="mastered-error">{error}</p>}

      {words.length === 0 ? (
        <p className="mastered-empty">
          Nothing here yet — tap Never forget in the Review tab to add a
          word.
        </p>
      ) : (
        <ul className="mastered-list">
          {words.map((w) => {
            const isPending = pending.has(w.headword);
            return (
              <li key={w.headword} className="mastered-row">
                <button
                  type="button"
                  className="mastered-row__word"
                  onClick={() => setActiveHeadword(w.headword)}
                  disabled={isPending}
                >
                  {w.headword}
                </button>
                <button
                  type="button"
                  className="mastered-row__unmark"
                  onClick={() => handleUnmark(w.headword)}
                  disabled={isPending}
                >
                  {isPending ? "…" : "Unmark"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {activeHeadword && (
        <WordPopover
          mode={{
            kind: "headword",
            headword: activeHeadword,
            entryId: null,
            reading: null,
          }}
          open={true}
          onOpenChange={(open) => {
            if (!open) setActiveHeadword(null);
          }}
        />
      )}
    </div>
  );
}
