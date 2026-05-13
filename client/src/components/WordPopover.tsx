import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useFloating,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
  FloatingFocusManager,
  FloatingOverlay,
} from "@floating-ui/react";
import { Link } from "react-router-dom";
import { useDictionary } from "../contexts/DictionaryContext";
import {
  getWordEncounters,
  getWordUsages,
  recordWordLookup,
  translateSentence,
} from "../api/client";
import { KANJI_REGEX } from "../lib/constants";
import {
  parseAnnotatedText,
  stripAnnotations,
  type FuriganaAnnotation,
} from "../lib/furigana";
import { stripBold } from "../lib/text";
import { headwordFromHit } from "../lib/headword";
import {
  lookupBestFrequency,
  TIER_LABEL,
  type FrequencyResult,
} from "../lib/frequency";
import { lookupExactSpan, type LookupHit } from "../lib/lookupAtCursor";
import { posHintAtOffset } from "../lib/tokenizer";
import { extractSentenceSnippet } from "../lib/sentenceSnippet";
import { supabase } from "../lib/supabase";
import AnimatedDots from "./AnimatedDots";
import KanjiInlineDetail, { type KanjiRow } from "./KanjiInlineDetail";
import type {
  SentenceTranslation,
  StoryTranslations,
  WordUsage,
} from "../types";
import "./WordPopover.css";

interface WordPopoverProps {
  storyId: number;
  cleanText: string;
  annotations: FuriganaAnnotation[];
  /**
   * The exact span the regroup pass decided was a tap target — character
   * offsets in `cleanText`. Lookups are constrained to this span so the
   * popover stays consistent with what the user clicked, instead of doing a
   * greedy longest-prefix scan that can reach past the rendered button.
   */
  start: number | null;
  end: number | null;
  translations: StoryTranslations;
  referenceEl: HTMLElement | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTranslationUpdated: (
    rangeKey: string,
    translation: SentenceTranslation
  ) => void;
}

const MAX_SENSES_COLLAPSED = 3;
const SWIPE_THRESHOLD_PX = 50;

/**
 * One slot in the carousel — either the current tap (`current`) or a prior
 * lookup of the same headword from anywhere in the user's history (`other`).
 * Card 0 is always `current`. Other cards come from `getWordUsages` filtered
 * to exclude the current span (the just-recorded usage would otherwise duplicate).
 */
type CurrentCard = {
  kind: "current";
  storyId: number;
  storyTitle: null;
  storyCreatedAt: null;
  startOffset: number;
  endOffset: number;
  surface: string;
  base?: string;
  derivations?: string[];
  cleanText: string;
  annotations: FuriganaAnnotation[];
};

type OtherCard = {
  kind: "other";
  occurrenceId: number;
  storyId: number;
  storyTitle: string;
  storyCreatedAt: string;
  startOffset: number;
  endOffset: number;
  surface: string;
  base?: undefined;
  derivations?: undefined;
  cleanText: string;
  annotations: FuriganaAnnotation[];
};

type Card = CurrentCard | OtherCard;

function sentenceKey(start: number, end: number): string {
  return `${start}-${end}`;
}

function renderSnippet(
  text: string,
  annotations: FuriganaAnnotation[],
  surfaceStart: number,
  surfaceEnd: number
): ReactNode {
  // Walk the text emitting either ruby (for annotation spans) or plain text,
  // wrapping anything that overlaps the surface in a <mark>. Annotations and
  // the surface are character-aligned (offsets come from the same source), so
  // overlap is a simple range check. Annotations don't cross sentence
  // boundaries; this snippet is a single sentence.
  const out: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  const emit = (chunkStart: number, chunkEnd: number, content: ReactNode) => {
    const inSurface =
      chunkStart >= surfaceStart && chunkEnd <= surfaceEnd;
    if (inSurface) {
      out.push(
        <mark key={key++} className="word-popover__snippet-highlight">
          {content}
        </mark>
      );
    } else {
      out.push(<span key={key++}>{content}</span>);
    }
  };

  for (const a of annotations) {
    if (a.start > cursor) {
      // Emit plain text before this annotation, splitting at surface bounds
      // so the highlight wraps only the surface portion.
      let segStart = cursor;
      const segEnd = a.start;
      while (segStart < segEnd) {
        const nextBoundary =
          segStart < surfaceStart && surfaceStart < segEnd
            ? surfaceStart
            : segStart < surfaceEnd && surfaceEnd < segEnd
              ? surfaceEnd
              : segEnd;
        emit(segStart, nextBoundary, text.slice(segStart, nextBoundary));
        segStart = nextBoundary;
      }
    }
    emit(
      a.start,
      a.end,
      <ruby>
        {text.slice(a.start, a.end)}
        <rt>{a.reading}</rt>
      </ruby>
    );
    cursor = a.end;
  }
  if (cursor < text.length) {
    let segStart = cursor;
    const segEnd = text.length;
    while (segStart < segEnd) {
      const nextBoundary =
        segStart < surfaceStart && surfaceStart < segEnd
          ? surfaceStart
          : segStart < surfaceEnd && surfaceEnd < segEnd
            ? surfaceEnd
            : segEnd;
      emit(segStart, nextBoundary, text.slice(segStart, nextBoundary));
      segStart = nextBoundary;
    }
  }
  return out;
}

function formatStoryDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function WordPopover({
  storyId,
  cleanText,
  annotations,
  start: tapStart,
  end: tapEnd,
  translations,
  referenceEl,
  open,
  onOpenChange,
  onTranslationUpdated,
}: WordPopoverProps) {
  const { state: dictState } = useDictionary();
  const [hit, setHit] = useState<LookupHit | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [showAllSenses, setShowAllSenses] = useState(false);
  const [activeKanji, setActiveKanji] = useState<string | null>(null);
  const [activeKanjiRow, setActiveKanjiRow] = useState<KanjiRow | null>(null);
  const [loadingKanji, setLoadingKanji] = useState<string | null>(null);

  // Carousel state.
  const [usages, setUsages] = useState<WordUsage[]>([]);
  const [cardIndex, setCardIndex] = useState(0);

  // Translation cache for stories other than the current one. The current
  // story's translations are owned by the parent (props) and updates flow
  // out via onTranslationUpdated. Local cache here keeps the popover-only
  // state for any other-story sentences that get translated during this
  // popover's lifetime.
  const [otherStoryTranslations, setOtherStoryTranslations] = useState<
    Record<number, StoryTranslations>
  >({});
  const [translationPending, setTranslationPending] = useState(false);
  const [translationRegenerating, setTranslationRegenerating] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);

  const [frequency, setFrequency] = useState<FrequencyResult | null>(null);
  const [encounters, setEncounters] = useState<number | null>(null);
  // Loading flags for the three headword-dependent fetches. The popover body
  // is gated on these being false so badges/cards don't pop in one at a time
  // after the initial render. Initialized to true on open so there's no flicker
  // between the dict lookup resolving and these effects setting them true.
  const [usagesLoading, setUsagesLoading] = useState(false);
  const [encountersLoading, setEncountersLoading] = useState(false);
  const [frequencyLoading, setFrequencyLoading] = useState(false);
  const cardScrollRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  // Touch swipe tracking on the card area.
  const touchStartXRef = useRef<number | null>(null);

  const { refs, context } = useFloating({
    open,
    onOpenChange,
    elements: { reference: referenceEl },
  });

  const dismiss = useDismiss(context, { outsidePress: false });
  const role = useRole(context, { role: "dialog" });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  const headword = useMemo(() => (hit ? headwordFromHit(hit) : null), [hit]);

  // Reset transient UI state when we open against a different tap point.
  useEffect(() => {
    if (!open) return;
    setShowAllSenses(false);
    setActiveKanji(null);
    setActiveKanjiRow(null);
    setLoadingKanji(null);
    setHit(null);
    setUsages([]);
    setCardIndex(0);
    setOtherStoryTranslations({});
    setTranslationPending(false);
    setTranslationRegenerating(false);
    setTranslationError(null);
    setFrequency(null);
    setEncounters(null);
    setUsagesLoading(true);
    setEncountersLoading(true);
    setFrequencyLoading(true);
    if (cardScrollRef.current) cardScrollRef.current.scrollTop = 0;
  }, [open, tapStart, tapEnd]);

  // Run the lookup against the tap target's span whenever we open against a
  // new range. Constrained to the rendered span so the popover doesn't reach
  // past the button the user actually clicked. The kuromoji POS hint at
  // `tapStart` is plumbed through so the lookup can prefer verb deinflection
  // over an unrelated noun exact match (e.g. 「赤くなり、」 → なる, not なり).
  useEffect(() => {
    if (!open || tapStart === null || tapEnd === null) return;
    if (dictState !== "ready") return;
    let cancelled = false;
    setLookingUp(true);
    posHintAtOffset(cleanText, tapStart)
      .catch(() => undefined)
      .then((posHint) =>
        lookupExactSpan(cleanText, tapStart, tapEnd, annotations, posHint)
      )
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
  }, [open, tapStart, tapEnd, cleanText, annotations, dictState]);

  // Once the hit resolves, record the lookup and fetch the user's prior
  // usages of the same headword. Both fire in parallel; recording is
  // best-effort and never blocks the carousel from rendering.
  useEffect(() => {
    if (!open || !hit) return;
    void recordWordLookup(storyId, hit);
    if (!headword) return;
    let cancelled = false;
    void getWordUsages(headword.headword)
      .then((rows) => {
        if (cancelled) return;
        setUsages(rows);
      })
      .catch(() => {
        // Carousel just won't show prior usages; current card still renders.
      })
      .finally(() => {
        if (!cancelled) setUsagesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, hit, headword, storyId]);

  // Resolve JPDB frequency for the headword. Best-effort — if the asset
  // fails to load (offline, 404 in dev), the header just omits the badge.
  // We pass every kanji variant of the primary JMdict entry plus the tapped
  // surface, because JPDB indexes orthographies separately: 御供え isn't in
  // the index at all but お供え is, and the canonical k[0] for that entry
  // happens to be 御供え, so a single-form lookup would lose the real rank.
  useEffect(() => {
    if (!open || !hit || !headword) {
      setFrequency(null);
      return;
    }
    let cancelled = false;
    const candidates = [headword.headword];
    if (!hit.base) candidates.push(hit.surface);
    for (const k of hit.results[0]?.k ?? []) candidates.push(k.ent);
    void lookupBestFrequency(candidates, headword.reading)
      .then((res) => {
        if (!cancelled) setFrequency(res);
      })
      .catch(() => {
        if (!cancelled) setFrequency(null);
      })
      .finally(() => {
        if (!cancelled) setFrequencyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, hit, headword]);

  // Total read-count-weighted encounters for the headword across the user's
  // read stories. Same shape as kanji exposures — every read of a story
  // contributes a fresh count. Best-effort; the badge just hides on error.
  useEffect(() => {
    if (!open || !headword) {
      setEncounters(null);
      return;
    }
    let cancelled = false;
    void getWordEncounters(headword.headword)
      .then((n) => {
        if (!cancelled) setEncounters(n);
      })
      .catch(() => {
        if (!cancelled) setEncounters(null);
      })
      .finally(() => {
        if (!cancelled) setEncountersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, headword]);

  // Hold the popover body behind a unified loading state until the dict
  // lookup AND the three headword-dependent fetches (usages, encounters,
  // frequency) have all settled. Without this, header badges and the
  // carousel pop in one at a time after the senses render, which feels
  // janky. When there's no headword (no-match fallback), only the lookup
  // matters since the other fetches don't fire. If the dictionary itself
  // errored we fall through to ready so the SenseSection can render its
  // own error message instead of a stuck loader.
  const contentReady =
    dictState === "error" ||
    (dictState === "ready" &&
      !lookingUp &&
      hit !== null &&
      (!headword ||
        (!usagesLoading && !encountersLoading && !frequencyLoading)));

  const cards = useMemo<Card[]>(() => {
    if (!hit) return [];
    const current: CurrentCard = {
      kind: "current",
      storyId,
      storyTitle: null,
      storyCreatedAt: null,
      startOffset: hit.start,
      endOffset: hit.end,
      surface: hit.surface,
      base: hit.base,
      derivations: hit.derivations,
      cleanText,
      annotations,
    };
    const others: OtherCard[] = usages
      .filter(
        (u) =>
          !(
            u.storyId === storyId &&
            u.startOffset === hit.start &&
            u.endOffset === hit.end
          )
      )
      .map((u) => {
        const parsed = parseAnnotatedText(u.storyContent);
        return {
          kind: "other",
          occurrenceId: u.occurrenceId,
          storyId: u.storyId,
          storyTitle: u.storyTitle,
          storyCreatedAt: u.storyCreatedAt,
          startOffset: u.startOffset,
          endOffset: u.endOffset,
          surface: u.surface,
          cleanText: parsed.cleanText,
          annotations: parsed.annotations,
        };
      });
    return [current, ...others];
  }, [hit, usages, storyId, cleanText, annotations]);

  // Clamp cardIndex if usages shrink (e.g., refetch returns fewer rows).
  useEffect(() => {
    if (cards.length === 0) {
      if (cardIndex !== 0) setCardIndex(0);
      return;
    }
    if (cardIndex >= cards.length) setCardIndex(cards.length - 1);
  }, [cards.length, cardIndex]);

  const activeCard = cards[cardIndex] ?? null;

  // Sticky kanji chips show the kanji of the headword (identical across
  // cards). Falls back to the surface kanji when there's no JMdict match.
  const stickyKanjiChars = useMemo(() => {
    const source = headword?.headword ?? hit?.surface ?? "";
    return [...source].filter((ch) => KANJI_REGEX.test(ch));
  }, [headword, hit]);

  const goToCard = useCallback(
    (next: number) => {
      if (cards.length === 0) return;
      const clamped = Math.max(0, Math.min(cards.length - 1, next));
      setCardIndex(clamped);
    },
    [cards.length]
  );

  // Keyboard navigation: ←/→ advance the carousel when the popover is open
  // and the user isn't typing.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (cards.length <= 1) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goToCard(cardIndex - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goToCard(cardIndex + 1);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, cards.length, cardIndex, goToCard]);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartXRef.current = e.touches[0]?.clientX ?? null;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    const startX = touchStartXRef.current;
    touchStartXRef.current = null;
    if (startX === null || cards.length <= 1) return;
    const endX = e.changedTouches[0]?.clientX ?? startX;
    const delta = endX - startX;
    if (Math.abs(delta) < SWIPE_THRESHOLD_PX) return;
    if (delta < 0) goToCard(cardIndex + 1);
    else goToCard(cardIndex - 1);
  };

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
      setActiveKanjiRow(null);
      setActiveKanji(ch);
    } finally {
      setLoadingKanji(null);
    }
  };

  const snippet = useMemo(
    () =>
      activeCard
        ? extractSentenceSnippet(
            activeCard.cleanText,
            activeCard.annotations,
            activeCard.startOffset,
            activeCard.endOffset
          )
        : null,
    [activeCard]
  );

  // Resolve a cached translation for the active card's sentence: parent's
  // translations for the current story, popover-local cache for others.
  const cachedTranslation: SentenceTranslation | null = useMemo(() => {
    if (!activeCard || !snippet) return null;
    const key = sentenceKey(snippet.sentenceStart, snippet.sentenceEnd);
    if (activeCard.storyId === storyId) {
      return translations[key] ?? null;
    }
    return otherStoryTranslations[activeCard.storyId]?.[key] ?? null;
  }, [activeCard, snippet, storyId, translations, otherStoryTranslations]);

  const storeTranslation = useCallback(
    (
      cardStoryId: number,
      key: string,
      translation: SentenceTranslation
    ) => {
      if (cardStoryId === storyId) {
        onTranslationUpdated(key, translation);
      } else {
        setOtherStoryTranslations((prev) => ({
          ...prev,
          [cardStoryId]: {
            ...(prev[cardStoryId] ?? {}),
            [key]: translation,
          },
        }));
      }
    },
    [storyId, onTranslationUpdated]
  );

  // Lazy-fetch the translation when the active card's sentence isn't
  // cached. Bails on cache hit so navigating among already-translated
  // cards is instant. Cancels in-flight requests when the card changes
  // mid-fetch so a slow card-0 response doesn't overwrite card-1's state.
  useEffect(() => {
    if (!open || !activeCard || !snippet) return;
    if (cachedTranslation) return;
    let cancelled = false;
    const cardStoryId = activeCard.storyId;
    const start = snippet.sentenceStart;
    const end = snippet.sentenceEnd;
    const key = sentenceKey(start, end);
    setTranslationPending(true);
    setTranslationError(null);
    void translateSentence(cardStoryId, start, end)
      .then((t) => {
        if (cancelled) return;
        storeTranslation(cardStoryId, key, t);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setTranslationError(
          err instanceof Error ? err.message : "Translation failed"
        );
      })
      .finally(() => {
        if (!cancelled) setTranslationPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeCard, snippet, cachedTranslation, storeTranslation]);

  const handleRegenerate = useCallback(() => {
    if (!activeCard || !snippet || translationPending) return;
    const cardStoryId = activeCard.storyId;
    const start = snippet.sentenceStart;
    const end = snippet.sentenceEnd;
    const key = sentenceKey(start, end);
    setTranslationRegenerating(true);
    setTranslationPending(true);
    setTranslationError(null);
    void translateSentence(cardStoryId, start, end, true)
      .then((t) => {
        storeTranslation(cardStoryId, key, t);
      })
      .catch((err: unknown) => {
        setTranslationError(
          err instanceof Error ? err.message : "Translation failed"
        );
      })
      .finally(() => {
        setTranslationPending(false);
        setTranslationRegenerating(false);
      });
  }, [activeCard, snippet, translationPending, storeTranslation]);

  // Reset card scroll + per-card translation error when navigating.
  useEffect(() => {
    if (cardScrollRef.current) cardScrollRef.current.scrollTop = 0;
    setTranslationError(null);
  }, [cardIndex]);

  if (!open || !referenceEl) return null;

  const stickyHeadword = headword?.headword ?? hit?.surface ?? "";
  const stickyReading = headword?.reading ?? null;

  const showCarouselNav = cards.length > 1;

  return (
    <FloatingPortal>
      <FloatingOverlay className="word-popover__backdrop" lockScroll>
        <FloatingFocusManager context={context} modal={true} initialFocus={closeBtnRef}>
          <div
            ref={refs.setFloating}
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
            }}
            className="word-popover"
            {...getFloatingProps()}
          >
            <button
              ref={closeBtnRef}
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
            {!contentReady ? (
              <div className="word-popover__loading">
                Loading<AnimatedDots />
              </div>
            ) : activeKanji ? (
              <div className="word-popover__body">
                <KanjiInlineDetail
                  char={activeKanji}
                  initialRow={activeKanjiRow ?? undefined}
                  onBack={() => {
                    setActiveKanji(null);
                    setActiveKanjiRow(null);
                  }}
                />
              </div>
            ) : (
              <>
                <div className="word-popover__sticky">
                  <header className="word-popover__header">
                    {stickyReading && stickyHeadword !== stickyReading ? (
                      <ruby className="word-popover__surface">
                        {stickyHeadword}
                        <rt>{stickyReading}</rt>
                      </ruby>
                    ) : (
                      <span className="word-popover__surface">{stickyHeadword}</span>
                    )}
                    {frequency && (
                      <span
                        className={`word-popover__freq word-popover__freq--${frequency.tier}`}
                        title="JPDB frequency"
                      >
                        <span className="word-popover__freq-badge">
                          {TIER_LABEL[frequency.tier]}
                        </span>
                        {frequency.rank !== null && (
                          <span className="word-popover__freq-rank">
                            #{frequency.rank.toLocaleString()}
                          </span>
                        )}
                      </span>
                    )}
                    {encounters !== null && (
                      <span
                        className="word-popover__encounters"
                        title="Total reads across your read stories (re-reads counted)"
                      >
                        {encounters.toLocaleString()}{" "}
                        {encounters === 1 ? "encounter" : "encounters"}
                      </span>
                    )}
                  </header>
                  <section className="word-popover__senses">
                    <SenseSection
                      state={dictState}
                      hit={hit}
                      lookingUp={lookingUp}
                      showAll={showAllSenses}
                      onToggleShowAll={() => setShowAllSenses((s) => !s)}
                    />
                  </section>
                  {stickyKanjiChars.length > 0 && (
                    <section className="word-popover__kanji">
                      {stickyKanjiChars.map((ch) => (
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
                </div>

                {showCarouselNav && activeCard && (
                  <nav className="word-popover__nav" aria-label="Other usages">
                    <button
                      type="button"
                      className="word-popover__nav-arrow"
                      onClick={() => goToCard(cardIndex - 1)}
                      disabled={cardIndex === 0}
                      aria-label="Previous usage"
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M10 3L5 8l5 5" />
                      </svg>
                    </button>
                    <div className="word-popover__nav-meta">
                      {activeCard.storyId === storyId ? (
                        <span className="word-popover__nav-title">This story</span>
                      ) : (
                        <>
                          <Link
                            to={`/stories/${activeCard.storyId}`}
                            className="word-popover__nav-title word-popover__nav-title--link"
                            onClick={() => onOpenChange(false)}
                          >
                            {stripAnnotations(stripBold(activeCard.storyTitle ?? ""))}
                          </Link>
                          {activeCard.storyCreatedAt && (
                            <span className="word-popover__nav-date">
                              {formatStoryDate(activeCard.storyCreatedAt)}
                            </span>
                          )}
                        </>
                      )}
                      <span className="word-popover__nav-indicator">
                        {cardIndex + 1} / {cards.length}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="word-popover__nav-arrow"
                      onClick={() => goToCard(cardIndex + 1)}
                      disabled={cardIndex === cards.length - 1}
                      aria-label="Next usage"
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M6 3l5 5-5 5" />
                      </svg>
                    </button>
                  </nav>
                )}

                <div
                  ref={cardScrollRef}
                  className="word-popover__card"
                  onTouchStart={handleTouchStart}
                  onTouchEnd={handleTouchEnd}
                >
                  {activeCard && (
                    <>
                      {activeCard.base &&
                        activeCard.derivations &&
                        activeCard.derivations.length > 0 && (
                          <div className="word-popover__inflection">
                            {activeCard.derivations.join(" → ")}
                          </div>
                        )}
                      {snippet && (
                        <div className="word-popover__snippet">
                          {renderSnippet(
                            snippet.text,
                            snippet.annotations,
                            snippet.surfaceStart,
                            snippet.surfaceEnd
                          )}
                        </div>
                      )}
                      <section className="word-popover__translation">
                        {cachedTranslation && !translationRegenerating ? (
                          <>
                            <div className="word-popover__translation-text">
                              {cachedTranslation.text}
                            </div>
                            <button
                              type="button"
                              className="word-popover__regenerate"
                              onClick={handleRegenerate}
                              disabled={translationPending}
                            >
                              ↻ Regenerate
                            </button>
                          </>
                        ) : translationError ? (
                          <>
                            <div className="word-popover__error">
                              {translationError}
                            </div>
                            <button
                              type="button"
                              className="word-popover__regenerate"
                              onClick={handleRegenerate}
                              disabled={translationPending}
                            >
                              ↻ Retry
                            </button>
                          </>
                        ) : (
                          <div className="word-popover__translation-loading">
                            Translating<AnimatedDots />
                          </div>
                        )}
                      </section>
                    </>
                  )}
                </div>
              </>
            )}
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
    return <div className="word-popover__status">Loading dictionary<AnimatedDots /></div>;
  }
  if (state === "error") {
    return <div className="word-popover__error">Dictionary unavailable</div>;
  }
  if (lookingUp || !hit) {
    return <div className="word-popover__status">Looking up<AnimatedDots /></div>;
  }
  const primary = hit.results[0];
  if (!primary) {
    return <div className="word-popover__status">No dictionary entry.</div>;
  }
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
