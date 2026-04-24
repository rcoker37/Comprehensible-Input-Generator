import { useEffect, useMemo, useState } from "react";
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
  FloatingFocusManager,
} from "@floating-ui/react";
import type { WordResult } from "@birchill/jpdict-idb";
import { useDictionary } from "../contexts/DictionaryContext";
import { explainWord } from "../api/client";
import { KANJI_REGEX } from "../lib/constants";
import { supabase } from "../lib/supabase";
import KanjiInlineDetail, { type KanjiRow } from "./KanjiInlineDetail";
import type { AnnotationToken, StoryAnnotations } from "../types";
import "./WordPopover.css";

interface WordPopoverProps {
  token: AnnotationToken;
  storyId: number;
  annotations: StoryAnnotations;
  referenceEl: HTMLElement | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onExplanationCached: (tokenIdx: number, text: string) => void;
}

const MAX_SENSES_COLLAPSED = 3;

export default function WordPopover({
  token,
  storyId,
  annotations,
  referenceEl,
  open,
  onOpenChange,
  onExplanationCached,
}: WordPopoverProps) {
  const { state: dictState, lookupWord } = useDictionary();
  const [results, setResults] = useState<WordResult[] | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [showAllSenses, setShowAllSenses] = useState(false);
  const [activeKanji, setActiveKanji] = useState<string | null>(null);
  const [activeKanjiRow, setActiveKanjiRow] = useState<KanjiRow | null>(null);
  const [loadingKanji, setLoadingKanji] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<string | null>(
    () => annotations.explanations[String(token.idx)]?.text ?? null
  );
  const [explaining, setExplaining] = useState(false);
  const [explainError, setExplainError] = useState<string | null>(null);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange,
    placement: "bottom",
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
    elements: { reference: referenceEl },
  });

  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "dialog" });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  // Reset transient state whenever we open against a different token.
  useEffect(() => {
    if (!open) return;
    setShowAllSenses(false);
    setActiveKanji(null);
    setActiveKanjiRow(null);
    setLoadingKanji(null);
    setExplainError(null);
    const cached = annotations.explanations[String(token.idx)];
    setExplanation(cached?.text ?? null);
  }, [open, token.idx, annotations.explanations]);

  useEffect(() => {
    if (!open) return;
    if (dictState !== "ready") {
      setResults(null);
      return;
    }
    let cancelled = false;
    setLookupError(null);
    (async () => {
      try {
        // Try the surface first. If nothing matches (inflected verb/adj),
        // fall back to the kuromoji base form — that matches JMdict's lemma.
        let primary = await lookupWord(token.s);
        if (primary.length === 0 && token.b) {
          primary = await lookupWord(token.b);
        }
        if (!cancelled) setResults(primary);
      } catch (err) {
        if (!cancelled) {
          setLookupError(err instanceof Error ? err.message : "Lookup failed");
          setResults([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, dictState, token.s, token.b, lookupWord]);

  const kanjiChars = useMemo(
    () => [...token.s].filter((ch) => KANJI_REGEX.test(ch)),
    [token.s]
  );

  const handleKanjiClick = async (ch: string) => {
    if (loadingKanji) return;
    setLoadingKanji(ch);
    try {
      const { data, error } = await supabase
        .from("kanji")
        .select("character, grade, jlpt, meanings, readings_on, readings_kun")
        .eq("character", ch)
        .single();
      if (error) throw new Error(error.message);
      setActiveKanjiRow(data as KanjiRow);
      setActiveKanji(ch);
    } catch {
      // Fall through to the inline detail view; it will re-fetch and surface
      // whatever error the DB returns there.
      setActiveKanjiRow(null);
      setActiveKanji(ch);
    } finally {
      setLoadingKanji(null);
    }
  };

  const handleExplain = async () => {
    if (explaining) return;
    setExplaining(true);
    setExplainError(null);
    try {
      const result = await explainWord(storyId, token.idx);
      setExplanation(result.text);
      onExplanationCached(token.idx, result.text);
    } catch (e) {
      setExplainError(e instanceof Error ? e.message : "Explain failed");
    } finally {
      setExplaining(false);
    }
  };

  if (!open || !referenceEl) return null;

  return (
    <FloatingPortal>
      <FloatingFocusManager context={context} modal={false} initialFocus={-1}>
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          className="word-popover"
          {...getFloatingProps()}
        >
          {activeKanji ? (
            <KanjiInlineDetail
              char={activeKanji}
              initialRow={activeKanjiRow ?? undefined}
              onBack={() => {
                setActiveKanji(null);
                setActiveKanjiRow(null);
              }}
            />
          ) : (
            <>
              <header className="word-popover__header">
                {token.r ? (
                  <ruby className="word-popover__surface">
                    {token.s}
                    <rt>{token.r}</rt>
                  </ruby>
                ) : (
                  <span className="word-popover__surface">{token.s}</span>
                )}
                {token.pos && <span className="word-popover__pos">{token.pos}</span>}
              </header>

              {token.gloss && (
                <section className="word-popover__gloss">
                  <div className="word-popover__gloss-text">{token.gloss}</div>
                  {token.note && <div className="word-popover__note">{token.note}</div>}
                </section>
              )}

              <section className="word-popover__senses">
                <SenseSection
                  state={dictState}
                  results={results}
                  error={lookupError}
                  showAll={showAllSenses}
                  onToggleShowAll={() => setShowAllSenses((s) => !s)}
                />
              </section>

              {kanjiChars.length > 0 && (
                <section className="word-popover__kanji">
                  {kanjiChars.map((ch) => (
                    <button
                      key={ch}
                      type="button"
                      className={`word-popover__kanji-chip${
                        loadingKanji === ch ? " is-loading" : ""
                      }`}
                      onClick={() => handleKanjiClick(ch)}
                      disabled={loadingKanji !== null}
                    >
                      {ch}
                    </button>
                  ))}
                </section>
              )}

              <footer className="word-popover__footer">
                {explanation ? (
                  <div className="word-popover__explanation">{explanation}</div>
                ) : (
                  <button
                    type="button"
                    className="word-popover__explain-btn"
                    onClick={handleExplain}
                    disabled={explaining}
                  >
                    {explaining ? "Explaining…" : "Explain here"}
                  </button>
                )}
                {explainError && (
                  <div className="word-popover__error">{explainError}</div>
                )}
              </footer>
            </>
          )}
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}

function SenseSection({
  state,
  results,
  error,
  showAll,
  onToggleShowAll,
}: {
  state: ReturnType<typeof useDictionary>["state"];
  results: WordResult[] | null;
  error: string | null;
  showAll: boolean;
  onToggleShowAll: () => void;
}) {
  if (state === "loading" || state === "idle") {
    return <div className="word-popover__status">Loading dictionary…</div>;
  }
  if (state === "error") {
    return <div className="word-popover__error">Dictionary unavailable</div>;
  }
  if (results === null) {
    return <div className="word-popover__status">Looking up…</div>;
  }
  if (error) {
    return <div className="word-popover__error">{error}</div>;
  }
  if (results.length === 0) {
    return <div className="word-popover__status">No dictionary entry.</div>;
  }

  // Flatten senses across the top word result — simplest useful render for v1.
  const primary = results[0];
  const senses = primary.s;
  const visible = showAll ? senses : senses.slice(0, MAX_SENSES_COLLAPSED);

  return (
    <>
      <ol className="word-popover__sense-list">
        {visible.map((sense, i) => (
          <li key={i} className="word-popover__sense">
            {sense.pos && sense.pos.length > 0 && (
              <span className="word-popover__sense-pos">{sense.pos.join(", ")}</span>
            )}
            <span className="word-popover__sense-text">
              {sense.g.map((g) => g.str).join("; ")}
            </span>
          </li>
        ))}
      </ol>
      {senses.length > MAX_SENSES_COLLAPSED && (
        <button
          type="button"
          className="word-popover__more-btn"
          onClick={onToggleShowAll}
        >
          {showAll
            ? "Show fewer"
            : `Show ${senses.length - MAX_SENSES_COLLAPSED} more`}
        </button>
      )}
    </>
  );
}
