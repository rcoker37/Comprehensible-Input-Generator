import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import Modal from "./Modal";
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
  lookupFrequencyByEntry,
  TIER_LABEL,
  type BestFrequencyResult,
} from "../lib/frequency";
import { lookupExactSpan, type LookupHit } from "../lib/lookupAtCursor";
import { lookupWord } from "../lib/dictionary";
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

/**
 * The popover can be opened either from a tap inside a story (carousel
 * starts with the tapped span as card 0) or from outside any story — e.g.
 * the Stats page — where there is no current tap and every card in the
 * carousel is just a usage from the user's history.
 */
export type WordPopoverMode =
  | {
      kind: "tap";
      storyId: number;
      cleanText: string;
      annotations: FuriganaAnnotation[];
      /**
       * The exact span the regroup pass decided was a tap target — character
       * offsets in `cleanText`. Lookups are constrained to this span so the
       * popover stays consistent with what the user clicked, instead of doing
       * a greedy longest-prefix scan that can reach past the rendered button.
       */
      start: number;
      end: number;
      /**
       * Optional — when set, the popover does its JMdict lookup against this
       * string instead of `cleanText.slice(start, end)`. Used when the parent
       * already knows the canonical headword for the span (from
       * `story_word_occurrences`), so manual override rows surface their
       * stored headword instead of whatever the raw surface happens to be
       * (which can be a deinflected form, or a typo like 野さい that has
       * no entry of its own).
       */
      lookupHeadword?: string | null;
      /**
       * Optional — JMdict entry id the indexer chose for this span. The
       * `lookupHeadword` redo-lookup has no POS context, so JMdict's natural
       * ordering can put the wrong homophone first (ふる → フル instead of
       * 降る, いく → 幾 instead of 行く). When this id is supplied, the
       * popover hoists the matching `WordResult` to `results[0]` so
       * `headwordFromHit` picks the entry the indexer actually pointed at.
       */
      lookupEntryId?: number | null;
      /**
       * Optional — when true, the tapped occurrence is a manual "match as
       * name" row. The popover skips the JMdict lookup entirely (no senses,
       * no frequency) and renders a Name header with `lookupReading` as the
       * furigana. Other usages of the same surface still load via the
       * carousel — encounter counts and the usages list both key off
       * `lookupHeadword` (which equals the surface for name rows).
       */
      lookupIsName?: boolean;
      /**
       * Optional — the user-supplied reading saved with a name row. Drives
       * the ruby on the sticky header when `lookupIsName` is true.
       */
      lookupReading?: string | null;
      translations: StoryTranslations;
      onTranslationUpdated: (
        rangeKey: string,
        translation: SentenceTranslation
      ) => void;
      /**
       * Optional — when supplied, the popover renders an "Override" action
       * that closes the popover and asks the parent to enter manual-override
       * mode on the resolved hit span (which may differ from `start`/`end`
       * if deinflection extended it).
       */
      onRequestOverride?: (start: number, end: number) => void;
    }
  | {
      kind: "headword";
      headword: string;
      /**
       * JMdict entry id for the headword. When supplied, the headword-mode
       * lookup hoists this exact entry to position 0 so `headwordFromHit`
       * names the word the browse card pointed at — without it, an exact
       * kana headword can deinflect to an unrelated homophone (くれる → 刳る,
       * できる → する).
       */
      entryId?: number | null;
    };

interface WordPopoverProps {
  mode: WordPopoverMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MAX_SENSES_COLLAPSED = 3;
const SWIPE_THRESHOLD_PX = 50;

// Stable references so the headword-mode defaults don't churn effects on
// every render.
const EMPTY_ANNOTATIONS: FuriganaAnnotation[] = [];
const EMPTY_TRANSLATIONS: StoryTranslations = {};

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
  // wrapping the portion that falls inside the surface in a <mark>. Annotations
  // and the surface are character-aligned (offsets come from the same source).
  // Annotations don't cross sentence boundaries; this snippet is a single
  // sentence.
  const out: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  // Split [segStart, segEnd) at the surface bounds, returning one node per
  // piece — the portion inside [surfaceStart, surfaceEnd) wrapped in <mark>,
  // the rest in <span>. Used both for plain text and for a ruby's base text,
  // so tapping a sub-span of a multi-kanji ruby block (山手 within
  // 山手線《やまのてせん》) highlights just that portion rather than the whole
  // block — or, as before the fix, nothing at all.
  const splitBySurface = (segStart: number, segEnd: number): ReactNode[] => {
    const pieces: ReactNode[] = [];
    let s = segStart;
    while (s < segEnd) {
      const next =
        s < surfaceStart && surfaceStart < segEnd
          ? surfaceStart
          : s < surfaceEnd && surfaceEnd < segEnd
            ? surfaceEnd
            : segEnd;
      const content = text.slice(s, next);
      const inSurface = s >= surfaceStart && next <= surfaceEnd;
      pieces.push(
        inSurface ? (
          <mark key={key++} className="word-popover__snippet-highlight">
            {content}
          </mark>
        ) : (
          <span key={key++}>{content}</span>
        )
      );
      s = next;
    }
    return pieces;
  };

  for (const a of annotations) {
    if (a.start > cursor) {
      out.push(...splitBySurface(cursor, a.start));
    }
    out.push(
      <ruby key={key++}>
        {splitBySurface(a.start, a.end)}
        <rt>{a.reading}</rt>
      </ruby>
    );
    cursor = a.end;
  }
  if (cursor < text.length) {
    out.push(...splitBySurface(cursor, text.length));
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
  mode,
  open,
  onOpenChange,
}: WordPopoverProps) {
  const { state: dictState } = useDictionary();
  // Narrow once so downstream code can read mode-specific fields without
  // re-narrowing. Tap-only fields default to null in headword mode.
  const isTap = mode.kind === "tap";
  const tapStoryId = mode.kind === "tap" ? mode.storyId : null;
  const tapStart = mode.kind === "tap" ? mode.start : null;
  const tapEnd = mode.kind === "tap" ? mode.end : null;
  const tapCleanText = mode.kind === "tap" ? mode.cleanText : "";
  const tapAnnotations = mode.kind === "tap" ? mode.annotations : EMPTY_ANNOTATIONS;
  const tapTranslations = mode.kind === "tap" ? mode.translations : EMPTY_TRANSLATIONS;
  const onTranslationUpdated = mode.kind === "tap" ? mode.onTranslationUpdated : null;
  const onRequestOverride = mode.kind === "tap" ? mode.onRequestOverride : null;
  const lookupHeadword =
    mode.kind === "tap" ? mode.lookupHeadword ?? null : null;
  const lookupEntryId =
    mode.kind === "tap" ? mode.lookupEntryId ?? null : null;
  const lookupIsName =
    mode.kind === "tap" ? mode.lookupIsName ?? false : false;
  const lookupReading =
    mode.kind === "tap" ? mode.lookupReading ?? null : null;
  const headwordParam = mode.kind === "headword" ? mode.headword : null;
  const headwordEntryId =
    mode.kind === "headword" ? mode.entryId ?? null : null;
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
  // Translation is opt-in per card: the user clicks "AI Translation" to
  // trigger the fetch. Reset when the popover opens against a new tap and
  // when the active card changes, so each card starts in the unrequested
  // state regardless of prior siblings.
  const [translationRequested, setTranslationRequested] = useState(false);

  const [frequency, setFrequency] = useState<BestFrequencyResult | null>(null);
  const [encounters, setEncounters] = useState<number | null>(null);
  // Loading flags for the three headword-dependent fetches. The popover body
  // is gated on these being false so badges/cards don't pop in one at a time
  // after the initial render. Initialized to true on open so there's no flicker
  // between the dict lookup resolving and these effects setting them true.
  const [usagesLoading, setUsagesLoading] = useState(false);
  const [encountersLoading, setEncountersLoading] = useState(false);
  const [frequencyLoading, setFrequencyLoading] = useState(false);
  const cardScrollRef = useRef<HTMLDivElement | null>(null);
  // Touch swipe tracking on the card area.
  const touchStartXRef = useRef<number | null>(null);

  // In name mode, the displayed headword + reading come straight from the
  // override row — we never look up JMdict for names, so there's no `hit` to
  // derive from. Downstream effects (encounters, usages) key off this same
  // shape so they don't have to special-case name mode.
  const headword = useMemo(() => {
    if (lookupIsName && lookupHeadword) {
      return { headword: lookupHeadword, reading: lookupReading };
    }
    const fromHit = hit ? headwordFromHit(hit) : null;
    if (fromHit) {
      // The indexer stamped the contextual reading on the occurrence (年 → ねん
      // inside 一九二五年, not the entry's default とし). The popover's redo-
      // lookup has no annotations to disambiguate homophone readings, so
      // prefer the stored reading over the JMdict primary one.
      return lookupReading
        ? { headword: fromHit.headword, reading: lookupReading }
        : fromHit;
    }
    // No JMdict entry resolved. A merged number span (一九二五年) has no
    // whole-span entry, so fall back to the headword + ruby reading the
    // indexer stamped on the occurrence — the popover still names the word.
    if (lookupHeadword) {
      return { headword: lookupHeadword, reading: lookupReading };
    }
    return null;
  }, [lookupIsName, lookupHeadword, lookupReading, hit]);

  // Reset transient UI state when we open against a different tap point or
  // headword. Re-keys on whichever identity is active for the current mode.
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
    setTranslationRequested(false);
    setFrequency(null);
    setEncounters(null);
    setUsagesLoading(true);
    setEncountersLoading(true);
    setFrequencyLoading(true);
    if (cardScrollRef.current) cardScrollRef.current.scrollTop = 0;
  }, [open, tapStart, tapEnd, headwordParam]);

  // Tap-mode lookup: span-bounded against the story's clean text. Constrained
  // to the rendered span so the popover doesn't reach past the button the
  // user actually clicked. The kuromoji POS hint at `tapStart` is plumbed
  // through so the lookup can prefer verb deinflection over an unrelated noun
  // exact match (e.g. 「赤くなり、」 → なる, not なり).
  //
  // When `lookupHeadword` is supplied (e.g. a manual override row's stored
  // lemma), we bypass the surface lookup entirely and dictionary-lookup the
  // headword string directly. The resulting hit is re-anchored to the story
  // span so the sentence snippet, record-lookup call, and carousel queries
  // still use the offsets the user actually tapped.
  useEffect(() => {
    if (!open || !isTap) return;
    if (tapStart === null || tapEnd === null) return;
    if (dictState !== "ready") return;
    let cancelled = false;
    setLookingUp(true);
    const surface = tapCleanText.slice(tapStart, tapEnd);
    // Name mode skips the JMdict lookup entirely — JMdict has nothing useful
    // to say about proper nouns. We still need a `hit` for the carousel
    // (cards key off hit.surface / hit.start / hit.end), so we synthesise an
    // empty-results LookupHit anchored at the tap span.
    if (lookupIsName) {
      setHit({
        start: tapStart,
        end: tapEnd,
        surface,
        results: [],
      });
      setLookingUp(false);
      return;
    }
    const finishWithReanchor = (
      result: Awaited<ReturnType<typeof lookupExactSpan>>
    ) => {
      if (cancelled || !result) return;
      // When the indexer stamped an entry id, hoist that JMdict result to
      // position 0 so `headwordFromHit(hit)` picks the entry the indexer
      // actually chose. Without this, `lookupExactSpan(headword)` runs with
      // no POS hint and JMdict's natural ordering can surface the wrong
      // homophone (ふる → フル, いく → 幾).
      let results = result.results;
      if (lookupEntryId !== null && results.length > 1) {
        const idx = results.findIndex((r) => r.id === lookupEntryId);
        if (idx > 0) {
          const match = results[idx]!;
          results = [match, ...results.slice(0, idx), ...results.slice(idx + 1)];
        }
      }
      setHit({
        ...result,
        results,
        start: tapStart,
        end: tapEnd,
        surface,
      });
    };
    if (lookupHeadword) {
      void lookupExactSpan(
        lookupHeadword,
        0,
        lookupHeadword.length,
        [],
        undefined
      )
        .then((result) => {
          if (cancelled) return;
          // A merged number span's headword (一九二五年) has no JMdict entry.
          // Synthesise an empty-results hit anchored at the tap span so the
          // carousel + `contentReady` gate still resolve — the sticky header
          // falls back to the stamped headword/reading.
          if (result) finishWithReanchor(result);
          else setHit({ start: tapStart, end: tapEnd, surface, results: [] });
        })
        .finally(() => {
          if (!cancelled) setLookingUp(false);
        });
    } else {
      posHintAtOffset(tapCleanText, tapStart)
        .catch(() => undefined)
        .then((posHint) =>
          lookupExactSpan(
            tapCleanText,
            tapStart,
            tapEnd,
            tapAnnotations,
            posHint
          )
        )
        .then((result) => {
          if (cancelled) return;
          setHit(result);
        })
        .finally(() => {
          if (!cancelled) setLookingUp(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [
    open,
    isTap,
    tapStart,
    tapEnd,
    tapCleanText,
    tapAnnotations,
    lookupHeadword,
    lookupEntryId,
    lookupIsName,
    dictState,
  ]);

  // Headword-mode lookup: the headword string is its own "text" and span, so
  // we hit the dictionary directly for senses without needing a story.
  //
  // The headword is already a canonical JMdict lemma, so we do an *exact*
  // dictionary lookup rather than going through `lookupExactSpan` — its
  // deinflection arbitration has no POS hint or annotations here and would
  // wander a kana headword to an unrelated homophone (くれる → 刳る's
  // potential form, できる → する's suppletive potential). When the browse
  // entry carried an `entryId`, the matching JMdict result is hoisted to
  // position 0 so `headwordFromHit` names the entry the card pointed at.
  useEffect(() => {
    if (!open || isTap || !headwordParam) return;
    if (dictState !== "ready") return;
    let cancelled = false;
    setLookingUp(true);
    void lookupWord(headwordParam)
      .then((results) => {
        if (cancelled) return;
        let ordered = results;
        if (headwordEntryId !== null && results.length > 1) {
          const idx = results.findIndex((r) => r.id === headwordEntryId);
          if (idx > 0) {
            const match = results[idx]!;
            ordered = [
              match,
              ...results.slice(0, idx),
              ...results.slice(idx + 1),
            ];
          }
        }
        setHit({
          start: 0,
          end: headwordParam.length,
          surface: headwordParam,
          results: ordered,
        });
      })
      .finally(() => {
        if (!cancelled) setLookingUp(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, isTap, headwordParam, headwordEntryId, dictState]);

  // Once the hit resolves, record the lookup (tap mode only — opening the
  // popover from Stats isn't a "tap" event we want to log) and fetch the
  // user's prior usages of the same headword. Both fire in parallel;
  // recording is best-effort and never blocks the carousel from rendering.
  useEffect(() => {
    if (!open || !hit) return;
    if (isTap && tapStoryId !== null) {
      void recordWordLookup(tapStoryId, hit);
    }
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
  }, [open, hit, headword, isTap, tapStoryId]);

  // Resolve JPDB frequency by JMdict entry id. The by-entry index handles
  // the homophone-disambiguation problem at build time (it honours JMdict's
  // `uk` tag and only pulls a kana rank into an entry that wants kana
  // spelling), so the popover doesn't have to merge candidate orthographies
  // itself. We fall back to a candidate-list lookup against the surface-keyed
  // index only when the hit has no JMdict result (1-char no-match fallback) —
  // there's no entry id to look up in that case.
  useEffect(() => {
    if (!open || !hit || !headword) {
      setFrequency(null);
      return;
    }
    // Names have no JMdict entry id and no meaningful JPDB rank — skip the
    // lookup and let the sticky header render a Name badge instead.
    if (lookupIsName) {
      setFrequency(null);
      setFrequencyLoading(false);
      return;
    }
    let cancelled = false;
    const entryId = hit.results[0]?.id ?? null;
    const finish = (res: BestFrequencyResult) => {
      if (cancelled) return;
      setFrequency(res);
      setFrequencyLoading(false);
    };
    const fail = () => {
      if (cancelled) return;
      setFrequency(null);
      setFrequencyLoading(false);
    };
    if (entryId !== null) {
      void lookupFrequencyByEntry(entryId)
        .then((res) => {
          if (res) {
            finish({ rank: res.rank, tier: res.tier, headword: res.headword });
          } else {
            finish({ rank: null, tier: "very-rare", headword: null });
          }
        })
        .catch(fail);
    } else {
      const candidates = [headword.headword];
      if (!hit.base) candidates.push(hit.surface);
      void lookupBestFrequency(candidates, headword.reading)
        .then(finish)
        .catch(fail);
    }
    return () => {
      cancelled = true;
    };
  }, [open, hit, headword, lookupIsName]);

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
    const others: OtherCard[] = usages
      .filter(
        (u) =>
          !(
            isTap &&
            tapStoryId !== null &&
            u.storyId === tapStoryId &&
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
    if (!isTap || tapStoryId === null) return others;
    const current: CurrentCard = {
      kind: "current",
      storyId: tapStoryId,
      storyTitle: null,
      storyCreatedAt: null,
      startOffset: hit.start,
      endOffset: hit.end,
      surface: hit.surface,
      base: hit.base,
      derivations: hit.derivations,
      cleanText: tapCleanText,
      annotations: tapAnnotations,
    };
    return [current, ...others];
  }, [hit, usages, isTap, tapStoryId, tapCleanText, tapAnnotations]);

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
  // translations for the current story (tap mode only), popover-local cache
  // for everything else. In headword mode tapStoryId is null so the equality
  // check always falls through to otherStoryTranslations.
  const cachedTranslation: SentenceTranslation | null = useMemo(() => {
    if (!activeCard || !snippet) return null;
    const key = sentenceKey(snippet.sentenceStart, snippet.sentenceEnd);
    if (isTap && activeCard.storyId === tapStoryId) {
      return tapTranslations[key] ?? null;
    }
    return otherStoryTranslations[activeCard.storyId]?.[key] ?? null;
  }, [activeCard, snippet, isTap, tapStoryId, tapTranslations, otherStoryTranslations]);

  const storeTranslation = useCallback(
    (
      cardStoryId: number,
      key: string,
      translation: SentenceTranslation
    ) => {
      if (isTap && cardStoryId === tapStoryId && onTranslationUpdated) {
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
    [isTap, tapStoryId, onTranslationUpdated]
  );

  // Lazy-fetch the translation only after the user explicitly requests it
  // via the "AI Translation" button. Bails on cache hit so navigating among
  // already-translated cards is instant. Cancels in-flight requests when
  // the card changes mid-fetch so a slow card-0 response doesn't overwrite
  // card-1's state.
  useEffect(() => {
    if (!open || !activeCard || !snippet) return;
    if (cachedTranslation) return;
    if (!translationRequested) return;
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
  }, [
    open,
    activeCard,
    snippet,
    cachedTranslation,
    storeTranslation,
    translationRequested,
  ]);

  const handleTranslate = useCallback(() => {
    setTranslationError(null);
    setTranslationRequested(true);
  }, []);

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

  // Reset card scroll + per-card translation state when navigating. Each
  // card requires its own opt-in click before a translation is fetched.
  useEffect(() => {
    if (cardScrollRef.current) cardScrollRef.current.scrollTop = 0;
    setTranslationError(null);
    setTranslationRequested(false);
  }, [cardIndex]);

  if (!open) return null;

  // Prefer the most-frequent orthography variant from JPDB (e.g. お供え rather
  // than the canonical k[0] 御供え) so the displayed form matches what the
  // user is most likely to encounter in the wild — and what we score the
  // headword against. Falls back to the JMdict-canonical headword while the
  // frequency lookup is still in flight or no candidate resolved.
  const stickyHeadword =
    frequency?.headword ?? headword?.headword ?? hit?.surface ?? "";
  const stickyReading = headword?.reading ?? null;

  const showCarouselNav = cards.length > 1;

  return (
    <Modal open={true} onClose={() => onOpenChange(false)} className="word-popover">
      <div className="word-popover__inner">
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
                {lookupIsName ? (
                  <span
                    className="word-popover__name-badge"
                    title="Manually marked as a name (proper noun)"
                  >
                    Name
                  </span>
                ) : (
                  frequency && (
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
                  )
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
                {lookupIsName ? (
                  <div className="word-popover__name-note">
                    Proper noun — no dictionary entry.
                  </div>
                ) : (
                  <SenseSection
                    state={dictState}
                    hit={hit}
                    lookingUp={lookingUp}
                    showAll={showAllSenses}
                    onToggleShowAll={() => setShowAllSenses((s) => !s)}
                  />
                )}
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
                  {activeCard.storyId === tapStoryId ? (
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
                  {onRequestOverride && hit && activeCard.kind === "current" && (
                    <div className="word-popover__override-row">
                      <button
                        type="button"
                        className="word-popover__override-btn"
                        onClick={() => {
                          onRequestOverride(hit.start, hit.end);
                          onOpenChange(false);
                        }}
                        title="Override this match — pick different word boundaries or a different dictionary entry"
                      >
                        Override match
                      </button>
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
                    ) : translationPending ? (
                      <div className="word-popover__translation-loading">
                        Translating<AnimatedDots />
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="word-popover__translate-btn"
                        onClick={handleTranslate}
                      >
                        AI Translation
                      </button>
                    )}
                  </section>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
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
