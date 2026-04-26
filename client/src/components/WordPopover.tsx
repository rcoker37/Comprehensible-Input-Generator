import { useEffect, useMemo, useRef, useState } from "react";
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
import { askWord } from "../api/client";
import { KANJI_REGEX } from "../lib/constants";
import { lookupAtCursor, type LookupHit } from "../lib/lookupAtCursor";
import { supabase } from "../lib/supabase";
import KanjiInlineDetail, { type KanjiRow } from "./KanjiInlineDetail";
import type { ChatMessage, StoryWordThreads, WordThread } from "../types";
import "./WordPopover.css";

interface WordPopoverProps {
  storyId: number;
  cleanText: string;
  offset: number | null;
  wordThreads: StoryWordThreads;
  referenceEl: HTMLElement | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onThreadUpdated: (key: string, thread: WordThread) => void;
}

const MAX_SENSES_COLLAPSED = 3;

function threadKey(hit: LookupHit): string {
  return `${hit.start}-${hit.end}`;
}

export default function WordPopover({
  storyId,
  cleanText,
  offset: cursorOffset,
  wordThreads,
  referenceEl,
  open,
  onOpenChange,
  onThreadUpdated,
}: WordPopoverProps) {
  const { state: dictState } = useDictionary();
  const [hit, setHit] = useState<LookupHit | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [showAllSenses, setShowAllSenses] = useState(false);
  const [activeKanji, setActiveKanji] = useState<string | null>(null);
  const [activeKanjiRow, setActiveKanjiRow] = useState<KanjiRow | null>(null);
  const [loadingKanji, setLoadingKanji] = useState<string | null>(null);
  const [thread, setThread] = useState<WordThread | null>(null);
  const [pending, setPending] = useState<boolean>(false);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);

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

  // Reset transient UI state when we open against a different tap point.
  useEffect(() => {
    if (!open) return;
    setShowAllSenses(false);
    setActiveKanji(null);
    setActiveKanjiRow(null);
    setLoadingKanji(null);
    setError(null);
    setHit(null);
    setThread(null);
    setQuestion("");
    setPending(false);
  }, [open, cursorOffset]);

  // Run the cursor lookup whenever we open against a new offset.
  useEffect(() => {
    if (!open || cursorOffset === null) return;
    if (dictState !== "ready") return;
    let cancelled = false;
    setLookingUp(true);
    lookupAtCursor(cleanText, cursorOffset)
      .then((result) => {
        if (cancelled) return;
        setHit(result);
        if (result) {
          setThread(wordThreads[threadKey(result)] ?? null);
        }
      })
      .finally(() => {
        if (!cancelled) setLookingUp(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cursorOffset, cleanText, dictState, wordThreads]);

  const asks = useMemo<ChatMessage[]>(
    () =>
      (thread?.messages ?? []).filter(
        (m) => m.role === "user" || m.role === "assistant"
      ),
    [thread]
  );

  // Auto-scroll the thread region to the bottom whenever the message count
  // grows (a new ask landed) so the latest answer is visible.
  useEffect(() => {
    const el = threadScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [thread?.messages.length]);

  const kanjiChars = useMemo(
    () => (hit ? [...hit.surface].filter((ch) => KANJI_REGEX.test(ch)) : []),
    [hit]
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

  const handleAsk = async () => {
    if (!hit || pending) return;
    const trimmed = question.trim();
    if (!trimmed) return;
    setPending(true);
    setError(null);
    try {
      const updated = await askWord(storyId, hit.start, hit.end, trimmed);
      setThread(updated);
      onThreadUpdated(threadKey(hit), updated);
      setQuestion("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ask failed");
    } finally {
      setPending(false);
    }
  };

  if (!open || !referenceEl) return null;

  const primary = hit?.results[0];
  const headerSurface = hit?.surface ?? "";
  // The JMdict reading is for the dictionary form; rendering it as ruby over
  // the surface is misleading whenever the surface is an inflection (e.g.
  // つかう over 使われる). Only show ruby when the lookup didn't deinflect; if
  // it did, the chain below carries the base + its reading.
  const headerReading = hit?.base ? undefined : primary?.r?.[0]?.ent;
  const baseReading = hit?.base ? primary?.r?.[0]?.ent : undefined;

  // Pair up asks into [user, assistant] tuples so we can render each Q&A as
  // a unit. A trailing user turn without an assistant reply (shouldn't happen
  // in practice — we only persist on success) renders alone.
  const askPairs: Array<{ q: ChatMessage; a: ChatMessage | null }> = [];
  for (let i = 0; i < asks.length; i++) {
    if (asks[i].role === "user") {
      const next = asks[i + 1];
      const a = next && next.role === "assistant" ? next : null;
      askPairs.push({ q: asks[i], a });
      if (a) i++;
    }
  }

  const askDisabled = pending || question.trim().length === 0 || !hit;

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
                {headerReading && headerSurface !== headerReading ? (
                  <ruby className="word-popover__surface">
                    {headerSurface}
                    <rt>{headerReading}</rt>
                  </ruby>
                ) : (
                  <span className="word-popover__surface">{headerSurface}</span>
                )}
              </header>

              {hit?.base && hit.derivations && hit.derivations.length > 0 && (
                <div className="word-popover__inflection">
                  from{" "}
                  <span className="word-popover__inflection-base">
                    {baseReading && baseReading !== hit.base ? (
                      <ruby>
                        {hit.base}
                        <rt>{baseReading}</rt>
                      </ruby>
                    ) : (
                      hit.base
                    )}
                  </span>
                  {" · "}
                  {hit.derivations.join(" → ")}
                </div>
              )}

              <section className="word-popover__senses">
                <SenseSection
                  state={dictState}
                  hit={hit}
                  lookingUp={lookingUp}
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

              <section className="word-popover__thread">
                <div
                  ref={threadScrollRef}
                  className="word-popover__thread-scroll"
                >
                  {askPairs.map((pair, i) => (
                    <div key={i} className="word-popover__qa">
                      <div className="word-popover__msg-user">
                        {pair.q.content}
                      </div>
                      {pair.a && (
                        <div className="word-popover__msg-assistant">
                          {pair.a.content}
                        </div>
                      )}
                    </div>
                  ))}

                  {pending && (
                    <div className="word-popover__msg-pending">Thinking…</div>
                  )}
                </div>

                <div className="word-popover__compose">
                  <textarea
                    className="word-popover__ask-input"
                    placeholder="Ask AI about this word…"
                    value={question}
                    rows={2}
                    disabled={pending || !hit}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && !askDisabled) {
                        e.preventDefault();
                        void handleAsk();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="word-popover__ask-btn"
                    onClick={() => void handleAsk()}
                    disabled={askDisabled}
                  >
                    {pending ? "Sending…" : "Send Message"}
                  </button>
                </div>

                {error && <div className="word-popover__error">{error}</div>}
              </section>
            </>
          )}
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}

function SenseSection({
  state,
  hit,
  lookingUp,
  showAll,
  onToggleShowAll,
}: {
  state: ReturnType<typeof useDictionary>["state"];
  hit: LookupHit | null;
  lookingUp: boolean;
  showAll: boolean;
  onToggleShowAll: () => void;
}) {
  if (state === "loading" || state === "idle") {
    return <div className="word-popover__status">Loading dictionary…</div>;
  }
  if (state === "error") {
    return <div className="word-popover__error">Dictionary unavailable</div>;
  }
  if (lookingUp || !hit) {
    return <div className="word-popover__status">Looking up…</div>;
  }
  if (hit.results.length === 0) {
    return <div className="word-popover__status">No dictionary entry.</div>;
  }

  // Flatten senses across the top word result — simplest useful render for v1.
  const primary: WordResult = hit.results[0];
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
