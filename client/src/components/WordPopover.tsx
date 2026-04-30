import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  FloatingOverlay,
} from "@floating-ui/react";
import type { WordResult } from "@birchill/jpdict-idb";
import { useDictionary } from "../contexts/DictionaryContext";
import { askWord } from "../api/client";
import { ASK_CHIPS, type AskChip } from "../lib/askChips";
import { KANJI_REGEX } from "../lib/constants";
import { parseAnnotatedText } from "../lib/furigana";
import { lookupAtCursor, type LookupHit } from "../lib/lookupAtCursor";
import { supabase } from "../lib/supabase";
import { useIsMobile } from "../hooks/useIsMobile";
import AnimatedDots from "./AnimatedDots";
import KanjiInlineDetail, { type KanjiRow } from "./KanjiInlineDetail";
import { pairThreadMessages } from "./wordPopoverHelpers";
import type { StoryWordThreads, WordThread } from "../types";
import "./WordPopover.css";

interface WordPopoverProps {
  storyId: number;
  cleanText: string;
  offset: number | null;
  wordThreads: StoryWordThreads;
  referenceEl: HTMLElement | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onThreadUpdated: (rangeKey: string, threadId: string, thread: WordThread) => void;
}

const MAX_SENSES_COLLAPSED = 3;

function rangeKey(hit: LookupHit): string {
  return `${hit.start}-${hit.end}`;
}

// Render the assistant's plain-text reply with Aozora ruby blocks
// (`漢字《かんじ》`) converted to <ruby> elements. Old replies stored before
// the prompt asked for furigana fall through unchanged.
function renderAssistant(content: string): ReactNode {
  const { cleanText, annotations } = parseAnnotatedText(content);
  if (annotations.length === 0) return cleanText;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < annotations.length; i++) {
    const a = annotations[i];
    if (a.start > cursor) parts.push(cleanText.slice(cursor, a.start));
    parts.push(
      <ruby key={i}>
        {cleanText.slice(a.start, a.end)}
        <rt>{a.reading}</rt>
      </ruby>
    );
    cursor = a.end;
  }
  if (cursor < cleanText.length) parts.push(cleanText.slice(cursor));
  return parts;
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
  const [activeChipId, setActiveChipId] = useState<string | null>(null);
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const userAskedRef = useRef(false);
  // Mirrors `pending` but updates synchronously so a second click in the
  // same tick (before React re-renders) is blocked. Without this, two fast
  // clicks on the same chip can both pass the `pending` check, race on the
  // server, and produce a thread with duplicated seed/reply turns.
  const pendingRef = useRef(false);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange,
    placement: "bottom",
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: isMobile ? undefined : autoUpdate,
    elements: { reference: referenceEl },
  });

  const dismiss = useDismiss(context, { outsidePress: false });
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
    setActiveChipId(null);
    setPending(false);
    userAskedRef.current = false;
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
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
      })
      .finally(() => {
        if (!cancelled) setLookingUp(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cursorOffset, cleanText, dictState]);

  const rangeThreads = useMemo(
    () => (hit ? wordThreads[rangeKey(hit)] ?? {} : {}),
    [hit, wordThreads]
  );
  const activeThread: WordThread | null =
    activeChipId !== null ? rangeThreads[activeChipId] ?? null : null;
  const askPairs = useMemo(
    () => pairThreadMessages(activeThread?.messages ?? []),
    [activeThread]
  );

  // Auto-scroll the popover body to the bottom only when the user has just
  // asked a question — initial cached-thread loads stay scrolled at the top.
  useEffect(() => {
    if (!userAskedRef.current) return;
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activeThread?.messages.length]);

  const kanjiChars = useMemo(
    () => (hit ? [...hit.surface].filter((ch) => KANJI_REGEX.test(ch)) : []),
    [hit]
  );

  const chipsWithState = useMemo(
    () =>
      ASK_CHIPS.map((c) => ({
        chip: c,
        active: activeChipId === c.id,
        hasThread: c.id in rangeThreads,
      })),
    [activeChipId, rangeThreads]
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

  const handleChipClick = (chip: AskChip) => {
    if (!hit || pendingRef.current) return;
    if (activeChipId === chip.id) {
      setActiveChipId(null);
      setError(null);
      return;
    }
    setActiveChipId(chip.id);
    setError(null);
    if (chip.id in rangeThreads) return;

    userAskedRef.current = true;
    pendingRef.current = true;
    setPending(true);
    void (async () => {
      try {
        const updated = await askWord(
          storyId,
          hit.start,
          hit.end,
          chip.id,
          chip.prompt
        );
        onThreadUpdated(rangeKey(hit), chip.id, updated);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Ask failed");
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    })();
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

  const showResponseArea = activeChipId !== null;
  const showAskingPlaceholder = pending && askPairs.length === 0;

  return (
    <FloatingPortal>
      <FloatingOverlay className="word-popover__backdrop" lockScroll>
        <FloatingFocusManager context={context} modal={false} initialFocus={-1}>
          <div
            ref={refs.setFloating}
            style={
              isMobile
                ? {
                    position: "fixed",
                    top: "50%",
                    left: "50%",
                    transform: "translate(-50%, -50%)",
                  }
                : floatingStyles
            }
            className={`word-popover ${isMobile ? "word-popover--centered" : ""}`}
            {...getFloatingProps()}
          >
            <button
              type="button"
              className="word-popover__close"
              onClick={() => onOpenChange(false)}
              title="Close"
              aria-label="Close"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M3 3l10 10" />
                <path d="M13 3L3 13" />
              </svg>
            </button>
            <div ref={bodyRef} className="word-popover__body">
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
                  className="word-popover__chips"
                  role="tablist"
                  aria-label="Suggested questions"
                >
                  {chipsWithState.map(({ chip, active, hasThread }) => {
                    const classNames = [
                      "word-popover__chip",
                      active ? "word-popover__chip--active" : "",
                      hasThread && !active
                        ? "word-popover__chip--has-thread"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <button
                        key={chip.id}
                        type="button"
                        className={classNames}
                        role="tab"
                        aria-selected={active}
                        disabled={pending || !hit}
                        onClick={() => handleChipClick(chip)}
                      >
                        {chip.label}
                      </button>
                    );
                  })}
                </div>

                {showResponseArea && (
                  <div className="word-popover__thread-scroll" role="tabpanel">
                    {askPairs.map((pair, i) => (
                      <div key={i} className="word-popover__qa">
                        {pair.q && (
                          <div className="word-popover__msg-user">
                            {pair.q.content}
                          </div>
                        )}
                        {pair.a && (
                          <div className="word-popover__msg-assistant">
                            {renderAssistant(pair.a.content)}
                          </div>
                        )}
                      </div>
                    ))}
                    {showAskingPlaceholder && (
                      <div className="word-popover__asking">
                        Loading<AnimatedDots />
                      </div>
                    )}
                  </div>
                )}

                {error && <div className="word-popover__error">{error}</div>}
              </section>
            </>
          )}
            </div>
          </div>
        </FloatingFocusManager>
      </FloatingOverlay>
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
