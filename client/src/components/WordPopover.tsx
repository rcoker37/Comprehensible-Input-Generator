import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import Modal from "./Modal";
import { useAuth } from "../contexts/AuthContext";
import { useDictionary } from "../contexts/DictionaryContext";
import { useSentenceCards } from "../contexts/SentenceCardsContext";
import { useGeneration } from "../contexts/GenerationContext";
import { useSeenKanji } from "../contexts/KanjiContext";
import {
  getWordEncounters,
  getWordUsages,
  recordWordLookup,
  translateSentence,
  addSentenceCard,
  generateCardAudio,
  generateSourceSentenceAudio,
} from "../api/client";
import {
  awaitGeneration,
  isTtsUnavailable,
  sentenceAudioKey,
  trackGeneration,
} from "../lib/sentenceAudio";
import { SentenceAudioButton } from "./SentenceAudioButton";
import { KANJI_REGEX } from "../lib/constants";
import {
  parseAnnotatedText,
  stripAnnotations,
  type FuriganaAnnotation,
} from "../lib/furigana";
import { stripBold } from "../lib/text";
import {
  DEFAULT_PARAGRAPH_COUNT,
  GENERATION_MODEL,
} from "../lib/generation";
import { headwordFromHit } from "../lib/headword";
import {
  lookupBestFrequency,
  lookupFrequencyByEntry,
  TIER_LABEL,
  type BestFrequencyResult,
} from "../lib/frequency";
import { lookupExactSpan, type LookupHit } from "../lib/lookupAtCursor";
import { lookupWord } from "../lib/dictionary";
import { baseHintAtOffset, posHintAtOffset } from "../lib/tokenizer";
import { extractSentenceSnippet } from "../lib/sentenceSnippet";
import { renderSnippet } from "../lib/renderSnippet";
import { renderSurfaceRuby } from "../lib/renderSurfaceRuby";
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
 * A frame in the popover's in-flight navigation stack. Tapping a kanji chip
 * pushes a "kanji" frame; clicking a word row in the kanji detail pushes a
 * "headword" frame. The close button pops the top frame so the user walks
 * back through history one step at a time; the popover only fully closes
 * when the stack is empty (the original mode the popover was opened in is
 * the implicit bottom of the stack).
 */
type PopoverFrame =
  | { kind: "kanji"; char: string; kanjiRow: KanjiRow | null }
  | {
      kind: "headword";
      headword: string;
      entryId: number | null;
      reading: string | null;
    };

/**
 * Where a tap originated. Tap mode opens against either a story or a chat
 * message; the popover stays generic by routing source-specific writes
 * (recordWordLookup, translateSentence) through this discriminator.
 */
export type WordPopoverSource =
  | { kind: "story"; storyId: number }
  | { kind: "chat"; chatMessageId: number };

/**
 * The popover can be opened either from a tap inside a story or chat
 * message (carousel starts with the tapped span as card 0) or from outside
 * any source — e.g. the Stats page — where there is no current tap and
 * every card in the carousel is just a usage from the user's history.
 */
export type WordPopoverMode =
  | {
      kind: "tap";
      source: WordPopoverSource;
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
       * Optional — when true, the tapped occurrence is flagged as a proper
       * noun (either auto-detected by the indexer for a 固有名詞 span or set
       * via a "match as name" manual override). The popover skips the JMdict
       * lookup entirely (no senses, no frequency) and renders a Name header
       * with `lookupReading` as the furigana. Other usages of the same surface
       * still load via the carousel — encounter counts and the usages list
       * both key off `lookupHeadword` (which equals the surface for names).
       */
      lookupIsName?: boolean;
      /**
       * Optional — the reading saved with a name row (auto-detected from the
       * LLM ruby, or user-supplied for a manual override). Drives the ruby on
       * the sticky header when `lookupIsName` is true.
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
      /**
       * JPDB-paired reading for the headword. When supplied, the popover
       * header furigana uses this directly instead of re-deriving it from
       * JMdict — JPDB's by-entry index ties a reading to the exact entry,
       * while a JMdict re-lookup can land on the wrong homophone (eg
       * と言われる resolving to 言う's `r[0]` of いう). Optional because
       * non-Browse callers (StoryDisplay title taps) don't carry one.
       */
      reading?: string | null;
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
 * Source ref for a single card. The current card knows its own source kind
 * (story or chat); other cards inherit theirs from `getWordUsages`. The
 * chat variant additionally carries `chatId` so the carousel's "go to
 * source" link can route to `/chats/:chatId`.
 */
type CardSource =
  | { kind: "story"; storyId: number }
  | { kind: "chat"; chatId: number; chatMessageId: number };

/**
 * One slot in the carousel — either the current tap (`current`) or a prior
 * lookup of the same headword from anywhere in the user's history (`other`).
 * Card 0 is always `current`. Other cards come from `getWordUsages` filtered
 * to exclude the current span (the just-recorded usage would otherwise duplicate).
 */
type CurrentCard = {
  kind: "current";
  source: CardSource;
  sourceTitle: null;
  sourceCreatedAt: null;
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
  source: CardSource;
  sourceTitle: string;
  sourceCreatedAt: string;
  startOffset: number;
  endOffset: number;
  surface: string;
  base?: undefined;
  derivations?: undefined;
  cleanText: string;
  annotations: FuriganaAnnotation[];
};

type Card = CurrentCard | OtherCard;

function sourceKey(source: CardSource): string {
  return source.kind === "story"
    ? `story-${source.storyId}`
    : `chat-${source.chatMessageId}`;
}

function sourceLink(source: CardSource): string {
  return source.kind === "story"
    ? `/stories/${source.storyId}`
    : `/chats/${source.chatId}`;
}

function sourcesEqual(a: CardSource, b: CardSource): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "story") {
    return (b as { kind: "story"; storyId: number }).storyId === a.storyId;
  }
  return (
    (b as { kind: "chat"; chatMessageId: number }).chatMessageId === a.chatMessageId
  );
}

function sentenceKey(start: number, end: number): string {
  return `${start}-${end}`;
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
  const { user, profile } = useAuth();
  const { loading: generationInFlight, generate } = useGeneration();
  const { seenKanji } = useSeenKanji();
  const { hasCard, markAdded } = useSentenceCards();
  // Narrow once so downstream code can read mode-specific fields without
  // re-narrowing. Tap-only fields default to null in headword mode.
  const isTap = mode.kind === "tap";
  // Derive the tap source as PRIMITIVES first, then memoize the object so its
  // identity is stable across renders. `mode` is a fresh object literal every
  // render (the parent rebuilds it), so constructing tapSource inline handed
  // every downstream hook — the usages/lookup effect, the `cards` memo,
  // `storeTranslation`, the translation fetch — a new identity each render,
  // making them re-run on unrelated re-renders (e.g. GenerationContext's 3s
  // poll), which re-fired network calls and re-recorded lookups needlessly.
  const tapSourceKind: CardSource["kind"] | null =
    mode.kind === "tap" ? mode.source.kind : null;
  const tapSourceStoryId =
    mode.kind === "tap" && mode.source.kind === "story"
      ? mode.source.storyId
      : null;
  const tapSourceChatMessageId =
    mode.kind === "tap" && mode.source.kind === "chat"
      ? mode.source.chatMessageId
      : null;
  const tapSource: CardSource | null = useMemo(() => {
    if (tapSourceKind === null) return null;
    // We don't know chatId here — the popover only needs `chatMessageId` for
    // writes (recordWordLookup, indexed-message translate). chatId is only
    // used for the "go to source" link, which the current card doesn't render
    // (you're already there). Default to 0 — it's never read for the current
    // card.
    return tapSourceKind === "story"
      ? { kind: "story", storyId: tapSourceStoryId! }
      : { kind: "chat", chatId: 0, chatMessageId: tapSourceChatMessageId! };
  }, [tapSourceKind, tapSourceStoryId, tapSourceChatMessageId]);
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
  const headwordReading =
    mode.kind === "headword" ? mode.reading ?? null : null;
  const [hit, setHit] = useState<LookupHit | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [showAllSenses, setShowAllSenses] = useState(false);
  const [loadingKanji, setLoadingKanji] = useState<string | null>(null);

  // Carousel state.
  const [usages, setUsages] = useState<WordUsage[]>([]);
  const [cardIndex, setCardIndex] = useState(0);

  // Translation cache for sources other than the current one. The current
  // tap's translations are owned by the parent (props) and updates flow
  // out via onTranslationUpdated. Local cache here keeps the popover-only
  // state for any other-source sentences that get translated during this
  // popover's lifetime. Keyed by `sourceKey(source)` so stories and chats
  // don't collide.
  const [otherSourceTranslations, setOtherSourceTranslations] = useState<
    Record<string, StoryTranslations>
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

  // "Add to Reviews" mines the active card's sentence into the Review SRS.
  // Whether the sentence is ALREADY mined lives in SentenceCardsContext, not
  // here — a local "added" flag would only know about clicks made in this
  // popover's lifetime, and would show a live button for a sentence mined
  // last session or via a different word in the same sentence.
  const [addingCard, setAddingCard] = useState(false);
  const [addCardError, setAddCardError] = useState<string | null>(null);

  // "Explain Word" kicks off a fire-and-forget learn_word generation for the
  // active headword (the lesson lands on the Compositions page). Tracks
  // whether this word view already started one so the button can't double-fire.
  const [explainStarted, setExplainStarted] = useState(false);

  // In-popover navigation stack. Tapping a kanji chip pushes a "kanji" frame
  // (showing KanjiInlineDetail); clicking a word row inside that detail pushes
  // a "headword" frame (showing the word view for that word). Hitting close
  // pops the top frame, walking back through navigation history; the modal
  // only actually closes when the stack is empty. The "original" mode the
  // popover was opened in is the implicit bottom of the stack.
  const [frames, setFrames] = useState<PopoverFrame[]>([]);
  const topFrame = frames[frames.length - 1] ?? null;
  const kanjiFrame = topFrame?.kind === "kanji" ? topFrame : null;
  const headwordFrame = topFrame?.kind === "headword" ? topFrame : null;

  // When a headword frame is on top, treat the popover as headword-mode for
  // that frame's word — kanji frames on top are just a UI swap and leave the
  // underlying word view's state alone.
  const effectiveHeadwordParam = headwordFrame?.headword ?? headwordParam;
  const effectiveHeadwordEntryId =
    headwordFrame !== null ? headwordFrame.entryId : headwordEntryId;
  const effectiveHeadwordReading =
    headwordFrame !== null ? headwordFrame.reading : headwordReading;
  const effectiveIsTap = isTap && headwordFrame === null;

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

  const resetWordState = useCallback(() => {
    setShowAllSenses(false);
    setLoadingKanji(null);
    setHit(null);
    setUsages([]);
    setCardIndex(0);
    setOtherSourceTranslations({});
    setTranslationPending(false);
    setTranslationRegenerating(false);
    setTranslationError(null);
    setTranslationRequested(false);
    setFrequency(null);
    setEncounters(null);
    setExplainStarted(false);
    setAddingCard(false);
    setAddCardError(null);
    setUsagesLoading(true);
    setEncountersLoading(true);
    setFrequencyLoading(true);
  }, []);

  // Reset transient UI state when we open against a different tap point or
  // headword. Re-keys on whichever identity is active for the current mode,
  // and clears any in-popover navigation stack so the new tap starts fresh.
  useEffect(() => {
    if (!open) return;
    resetWordState();
    setFrames([]);
    if (cardScrollRef.current) cardScrollRef.current.scrollTop = 0;
  }, [open, tapStart, tapEnd, headwordParam, resetWordState]);

  // Reset word state when the user pushes a headword frame (navigates to a
  // new word inside the popover). Kanji frames don't reset — the underlying
  // word view keeps its data so popping back is instant.
  useEffect(() => {
    if (!open || headwordFrame === null) return;
    resetWordState();
  }, [open, headwordFrame, resetWordState]);

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
    if (!open || !effectiveIsTap) return;
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
      Promise.all([
        posHintAtOffset(tapCleanText, tapStart).catch(() => undefined),
        baseHintAtOffset(tapCleanText, tapStart).catch(() => undefined),
      ])
        .then(([posHint, baseHint]) =>
          lookupExactSpan(
            tapCleanText,
            tapStart,
            tapEnd,
            tapAnnotations,
            posHint,
            baseHint
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
    effectiveIsTap,
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
    if (!open || effectiveIsTap || !effectiveHeadwordParam) return;
    if (dictState !== "ready") return;
    let cancelled = false;
    setLookingUp(true);
    void lookupWord(effectiveHeadwordParam)
      .then((results) => {
        if (cancelled) return;
        let ordered = results;
        if (effectiveHeadwordEntryId !== null && results.length > 1) {
          const idx = results.findIndex((r) => r.id === effectiveHeadwordEntryId);
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
          end: effectiveHeadwordParam.length,
          surface: effectiveHeadwordParam,
          results: ordered,
        });
      })
      .finally(() => {
        if (!cancelled) setLookingUp(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, effectiveIsTap, effectiveHeadwordParam, effectiveHeadwordEntryId, headwordFrame, dictState]);

  // Once the hit resolves, record the lookup (tap mode only — opening the
  // popover from Stats isn't a "tap" event we want to log) and fetch the
  // user's prior usages of the same headword. Both fire in parallel;
  // recording is best-effort and never blocks the carousel from rendering.
  useEffect(() => {
    if (!open || !hit) return;
    if (effectiveIsTap && tapSource !== null) {
      const lookupSource =
        tapSource.kind === "story"
          ? { storyId: tapSource.storyId }
          : { chatMessageId: tapSource.chatMessageId };
      void recordWordLookup(lookupSource, hit);
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
  }, [open, hit, headword, effectiveIsTap, tapSource]);

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
    const currentMatchesUsage = (u: WordUsage): boolean => {
      if (!effectiveIsTap || tapSource === null) return false;
      if (u.startOffset !== hit.start || u.endOffset !== hit.end) return false;
      if (tapSource.kind === "story") {
        return u.sourceType === "story" && u.storyId === tapSource.storyId;
      }
      return (
        u.sourceType === "chat" && u.chatMessageId === tapSource.chatMessageId
      );
    };
    const others: OtherCard[] = usages
      .filter((u) => !currentMatchesUsage(u))
      .map((u) => {
        const parsed = parseAnnotatedText(u.sourceContent);
        const source: CardSource =
          u.sourceType === "story"
            ? { kind: "story", storyId: u.storyId! }
            : {
                kind: "chat",
                chatId: u.chatId!,
                chatMessageId: u.chatMessageId!,
              };
        return {
          kind: "other",
          occurrenceId: u.occurrenceId,
          source,
          sourceTitle: u.sourceTitle,
          sourceCreatedAt: u.sourceCreatedAt,
          startOffset: u.startOffset,
          endOffset: u.endOffset,
          surface: u.surface,
          cleanText: parsed.cleanText,
          annotations: parsed.annotations,
        };
      });
    if (!effectiveIsTap || tapSource === null) return others;
    const current: CurrentCard = {
      kind: "current",
      source: tapSource,
      sourceTitle: null,
      sourceCreatedAt: null,
      startOffset: hit.start,
      endOffset: hit.end,
      surface: hit.surface,
      base: hit.base,
      derivations: hit.derivations,
      cleanText: tapCleanText,
      annotations: tapAnnotations,
    };
    return [current, ...others];
  }, [hit, usages, effectiveIsTap, tapSource, tapCleanText, tapAnnotations]);

  // Clamp cardIndex if usages shrink (e.g., refetch returns fewer rows).
  useEffect(() => {
    if (cards.length === 0) {
      if (cardIndex !== 0) setCardIndex(0);
      return;
    }
    if (cardIndex >= cards.length) setCardIndex(cards.length - 1);
  }, [cards.length, cardIndex]);

  const activeCard = cards[cardIndex] ?? null;

  // Kanji chips show the union of kanji across the active headword + every
  // carousel surface — a "usually kana" word like うち still shows no chips
  // when the headword and every encounter is kana, while 中 / 内 / 家
  // accumulate as those forms get seen. Including the active headword (not
  // just `cards`) is what lets headword-mode popovers — the kanji popover's
  // word-list clicks — show kanji chips on words the user has never
  // encountered, since those have no cards at all.
  const stickyKanjiChars = useMemo(() => {
    const set = new Set<string>();
    for (const card of cards) {
      for (const ch of card.surface) {
        if (KANJI_REGEX.test(ch)) set.add(ch);
      }
    }
    if (effectiveHeadwordParam) {
      for (const ch of effectiveHeadwordParam) {
        if (KANJI_REGEX.test(ch)) set.add(ch);
      }
    }
    return [...set];
  }, [cards, effectiveHeadwordParam]);

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

  const handleKanjiWordSelect = useCallback(
    (headword: string, entryId: number | null, reading: string | null) => {
      setFrames((f) => [
        ...f,
        { kind: "headword", headword, entryId, reading },
      ]);
    },
    []
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
      setFrames((f) => [
        ...f,
        { kind: "kanji", char: ch, kanjiRow: data as KanjiRow },
      ]);
    } catch {
      setFrames((f) => [...f, { kind: "kanji", char: ch, kanjiRow: null }]);
    } finally {
      setLoadingKanji(null);
    }
  };

  // Close button (and Esc, and backdrop): pop one frame, walking back through
  // the kanji ⇄ headword stack. Only when the stack is empty does the modal
  // actually close.
  const handleClose = useCallback(() => {
    setFrames((f) => {
      if (f.length === 0) {
        onOpenChange(false);
        return f;
      }
      return f.slice(0, -1);
    });
  }, [onOpenChange]);

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
  // translations for the current tap (tap mode only), popover-local cache
  // for everything else. In headword mode tapSource is null so the equality
  // check always falls through to otherSourceTranslations.
  const cachedTranslation: SentenceTranslation | null = useMemo(() => {
    if (!activeCard || !snippet) return null;
    const key = sentenceKey(snippet.sentenceStart, snippet.sentenceEnd);
    if (isTap && tapSource && sourcesEqual(activeCard.source, tapSource)) {
      return tapTranslations[key] ?? null;
    }
    return otherSourceTranslations[sourceKey(activeCard.source)]?.[key] ?? null;
  }, [activeCard, snippet, isTap, tapSource, tapTranslations, otherSourceTranslations]);

  const storeTranslation = useCallback(
    (
      cardSource: CardSource,
      key: string,
      translation: SentenceTranslation
    ) => {
      if (isTap && tapSource && sourcesEqual(cardSource, tapSource) && onTranslationUpdated) {
        onTranslationUpdated(key, translation);
      } else {
        const sk = sourceKey(cardSource);
        setOtherSourceTranslations((prev) => ({
          ...prev,
          [sk]: {
            ...(prev[sk] ?? {}),
            [key]: translation,
          },
        }));
      }
    },
    [isTap, tapSource, onTranslationUpdated]
  );

  // The translation fetch must key off STABLE values, not the identities of
  // activeCard / snippet / storeTranslation. `tapSource` is rebuilt as a
  // fresh object every render and the parent's `onTranslationUpdated` is a
  // fresh function every render, so all three churn identity on any
  // incidental re-render — e.g. GenerationContext's 3s poll while a story or
  // "Explain Word" lesson generates, or the word-index backfill draining.
  // When the effect depended on those identities, each such re-render
  // cancelled the in-flight request and started a new one; a translation that
  // took longer than the poll interval was cancelled before it could resolve,
  // so `translationPending` never cleared and the spinner spun forever. Read
  // the live objects through refs and depend only on stable primitives.
  const activeCardRef = useRef(activeCard);
  activeCardRef.current = activeCard;
  const storeTranslationRef = useRef(storeTranslation);
  storeTranslationRef.current = storeTranslation;
  const snippetRef = useRef(snippet);
  snippetRef.current = snippet;
  const activeSourceKey = activeCard ? sourceKey(activeCard.source) : null;
  const activeSentenceStart = snippet?.sentenceStart ?? null;
  const activeSentenceEnd = snippet?.sentenceEnd ?? null;
  const hasCachedTranslation = cachedTranslation !== null;

  // Lazy-fetch the translation only after the user explicitly requests it
  // via the "AI Translation" button. Bails on cache hit so navigating among
  // already-translated cards is instant. Cancels the in-flight request only
  // when the active sentence itself changes (card navigation) — never on an
  // unrelated re-render — so a slow response isn't perpetually restarted.
  useEffect(() => {
    if (!open || !translationRequested) return;
    if (
      activeSourceKey === null ||
      activeSentenceStart === null ||
      activeSentenceEnd === null
    )
      return;
    if (hasCachedTranslation) return;
    const card = activeCardRef.current;
    if (!card) return;
    let cancelled = false;
    const cardSource = card.source;
    const translateSource =
      cardSource.kind === "story"
        ? { storyId: cardSource.storyId }
        : { chatMessageId: cardSource.chatMessageId };
    const key = sentenceKey(activeSentenceStart, activeSentenceEnd);
    setTranslationPending(true);
    setTranslationError(null);
    void translateSentence(translateSource, activeSentenceStart, activeSentenceEnd)
      .then((t) => {
        if (cancelled) return;
        storeTranslationRef.current(cardSource, key, t);
        // Audio rides translation: a freshly-translated sentence gets its
        // TTS generated in the background, deduped through the module
        // in-flight map so a play-button click or Add to Reviews on the
        // same sentence coalesces into this one request. Cache-hit opens
        // bail above, so cached pre-feature translations don't auto-fire —
        // the play button generates on demand instead.
        const snip = snippetRef.current;
        if (snip && !isTtsUnavailable()) {
          const audioKey = sentenceAudioKey(
            cardSource,
            activeSentenceStart,
            activeSentenceEnd
          );
          trackGeneration(audioKey, () =>
            generateSourceSentenceAudio(
              translateSource,
              activeSentenceStart,
              activeSentenceEnd,
              snip.annotations
            )
          ).catch(() => {});
        }
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
    translationRequested,
    activeSourceKey,
    activeSentenceStart,
    activeSentenceEnd,
    hasCachedTranslation,
  ]);

  const handleTranslate = useCallback(() => {
    setTranslationError(null);
    setTranslationRequested(true);
  }, []);

  const handleRegenerate = useCallback(() => {
    if (!activeCard || !snippet || translationPending) return;
    const cardSource = activeCard.source;
    const translateSource =
      cardSource.kind === "story"
        ? { storyId: cardSource.storyId }
        : { chatMessageId: cardSource.chatMessageId };
    const start = snippet.sentenceStart;
    const end = snippet.sentenceEnd;
    const key = sentenceKey(start, end);
    setTranslationRegenerating(true);
    setTranslationPending(true);
    setTranslationError(null);
    void translateSentence(translateSource, start, end, true)
      .then((t) => {
        storeTranslation(cardSource, key, t);
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

  // Mine the active card's sentence into the Review SRS. Translating first
  // when needed is the point: a card's back shows the translation, and the
  // card SNAPSHOTS it rather than pointing at stories.translations, which
  // revise-story / update_story_content wipe.
  const handleAddToReviews = useCallback(() => {
    if (!activeCard || !snippet || addingCard || translationPending) return;
    const cardSource = activeCard.source;
    const start = snippet.sentenceStart;
    const end = snippet.sentenceEnd;
    if (hasCard(cardSource, start, end)) return;

    const translateSource =
      cardSource.kind === "story"
        ? { storyId: cardSource.storyId }
        : { chatMessageId: cardSource.chatMessageId };
    const key = sentenceKey(start, end);

    setAddingCard(true);
    setAddCardError(null);

    const ensureTranslation = async (): Promise<string> => {
      if (cachedTranslation) return cachedTranslation.text;
      const t = await translateSentence(translateSource, start, end);
      // Feed it back through the normal cache path so the sentence is also
      // translated for the popover and the parent's stories.translations.
      storeTranslation(cardSource, key, t);
      return t.text;
    };

    void ensureTranslation()
      .then((translation) =>
        addSentenceCard({
          source: cardSource,
          sentenceStart: start,
          sentenceEnd: end,
          sentenceText: snippet.text,
          annotations: snippet.annotations,
          translation,
        })
      )
      .then((cardId) => {
        markAdded(cardSource, start, end);
        // Couple Add to Reviews with audio: snapshot the card's audio in
        // the background (never gating the button). Await any in-flight
        // source generation for this sentence first so the server's cheap
        // copy path hits instead of a second synthesis; when card mode does
        // synthesize, it dual-writes to the source path, so the sentence is
        // covered for future popover plays either way.
        if (!isTtsUnavailable()) {
          void awaitGeneration(sentenceAudioKey(cardSource, start, end))
            .then(() => generateCardAudio(cardId))
            .catch(() => {});
        }
      })
      .catch((err: unknown) => {
        setAddCardError(
          err instanceof Error ? err.message : "Couldn't add to reviews"
        );
      })
      .finally(() => {
        setAddingCard(false);
      });
  }, [
    activeCard,
    snippet,
    addingCard,
    translationPending,
    hasCard,
    cachedTranslation,
    storeTranslation,
    markAdded,
  ]);

  // Kick off a "Learn Word" generation for the active headword. Generation
  // is fire-and-forget (the finished lesson shows up on the Compositions
  // page); formality comes from the user's saved generator preferences, but
  // the paragraph count is fixed at DEFAULT_PARAGRAPH_COUNT — a word lesson
  // wants a consistent short length, not whatever the user last picked for a
  // full story.
  const handleExplainWord = useCallback(() => {
    if (!user || !headword || generationInFlight || explainStarted) return;
    const gen = profile?.preferences?.generator;
    generate(user.id, {
      contentType: "learn_word",
      targetWord: headword.headword,
      targetWordReading: headword.reading,
      formality: gen?.formality ?? "polite",
      paragraphs: DEFAULT_PARAGRAPH_COUNT,
      model: GENERATION_MODEL,
      seenKanji,
    });
    setExplainStarted(true);
  }, [
    user,
    profile,
    headword,
    generationInFlight,
    explainStarted,
    generate,
    seenKanji,
  ]);

  // Reset card scroll + per-card translation state when navigating. Each
  // card requires its own opt-in click before a translation is fetched, and
  // each card is a different sentence, so the add-to-reviews state is
  // per-card too.
  useEffect(() => {
    if (cardScrollRef.current) cardScrollRef.current.scrollTop = 0;
    setTranslationError(null);
    setTranslationPending(false);
    setTranslationRequested(false);
    setAddingCard(false);
    setAddCardError(null);
  }, [cardIndex]);

  if (!open) return null;

  // Is the active card's sentence already a review card? Read from
  // SentenceCardsContext (loaded once for the whole account) rather than from
  // click state, so the button is honest on a sentence mined last session or
  // reached via a different word in the same sentence.
  const sentenceMined =
    activeCard && snippet
      ? hasCard(activeCard.source, snippet.sentenceStart, snippet.sentenceEnd)
      : false;
  // Mining may need a translation, which needs a key. An already-mined
  // sentence still shows its "✓ In Reviews" state without one.
  const canMineSentence =
    !!activeCard && !!snippet && (profile?.has_openrouter_api_key ?? false);

  // Per-card display surface — keeps the literal surface when it's already
  // one of the entry's k/r forms (うち stays うち, 中 stays 中), but rewrites
  // a conjugated surface to the entry's lemma (大切にして → 大切にする,
  // 食べた → 食べる) so the header shows a dictionary form instead of a tense
  // the user has to mentally undo. Falls back to JPDB's display variant, then
  // the JMdict canonical, then the raw tap surface when no card is active.
  const entry = hit?.results?.[0];
  const entryForms = (() => {
    const set = new Set<string>();
    if (entry?.k) for (const k of entry.k) set.add(k.ent);
    if (entry?.r) for (const r of entry.r) set.add(r.ent);
    return set;
  })();
  const surfaceText = activeCard?.surface ?? "";
  const surfaceHasKanji = [...surfaceText].some((ch) => KANJI_REGEX.test(ch));
  // When the surface is a conjugation, prefer a lemma that matches the
  // surface's script: a kana-only conjugated form (もっていって) takes the
  // reading lemma (もっていく), while a kanji-bearing conjugation (大切にして)
  // takes the kanji lemma (大切にする).
  const lemmaForm = surfaceHasKanji
    ? frequency?.headword ?? headword?.headword ?? headword?.reading ?? ""
    : headword?.reading ?? frequency?.headword ?? headword?.headword ?? "";
  // No active card (headword mode with no prior usages): prefer the headword
  // the caller passed in — JMdict's exact-match lookup can land on the wrong
  // homophone for phrase entries (と言われる exact-matching only 言う since
  // jpdict-idb's data doesn't always carry every JMdict phrase), and
  // `headword.headword` would then surface 言う instead. Falling back through
  // JPDB display variant → JMdict canonical → hit surface for callers that
  // don't pass a headword (e.g. tap mode shouldn't ever hit this branch, but
  // be conservative).
  const cardSurface = !surfaceText
    ? effectiveHeadwordParam ??
      frequency?.headword ??
      headword?.headword ??
      hit?.surface ??
      ""
    : entryForms.has(surfaceText)
      ? surfaceText
      : lemmaForm || surfaceText;
  // Prefer the JPDB-paired reading from the mode/frame over JMdict's `r[0]` —
  // same homophone-mismatch concern as cardSurface above.
  const cardReading =
    effectiveHeadwordReading ?? headword?.reading ?? null;
  // Other non-sK kanji forms this entry has, with JPDB's display variant
  // hoisted first when known. Powers the "Also written" subtitle so the
  // reader still sees that うち's entry can also be written 中 · 内 even
  // when the active card's surface is kana.
  const otherDictForms = (() => {
    if (!entry?.k) return [] as string[];
    const all = entry.k.filter((k) => !k.i?.includes("sK")).map((k) => k.ent);
    const preferred = frequency?.headword;
    const ordered =
      preferred && all.includes(preferred)
        ? [preferred, ...all.filter((k) => k !== preferred)]
        : all;
    return ordered.filter((k) => k !== cardSurface);
  })();

  const showCarouselNav = cards.length > 1;

  return (
    <Modal
      open={true}
      onClose={handleClose}
      className="word-popover"
      hideClose={kanjiFrame !== null}
    >
      <div className="word-popover__inner">
        {!contentReady && !kanjiFrame ? (
          <div className="word-popover__loading">
            Loading<AnimatedDots />
          </div>
        ) : kanjiFrame ? (
          <div className="word-popover__kanji-view">
            <KanjiInlineDetail
              char={kanjiFrame.char}
              initialRow={kanjiFrame.kanjiRow ?? undefined}
              onBack={handleClose}
              onWordSelect={handleKanjiWordSelect}
            />
          </div>
        ) : (
          <>
            <div className="word-popover__sticky">
              <header className="word-popover__header">
                <span className="word-popover__surface">
                  {renderSurfaceRuby(cardSurface, cardReading)}
                </span>
                {lookupIsName ? (
                  <span
                    className="word-popover__name-badge"
                    title="Proper noun"
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
                {encounters !== null && (() => {
                  const rounded = Math.round(encounters);
                  return (
                    <span
                      className="word-popover__encounters"
                      title="Total reads across your read stories (re-reads counted)"
                    >
                      {rounded.toLocaleString()}{" "}
                      {rounded === 1 ? "encounter" : "encounters"}
                    </span>
                  );
                })()}
              </header>
              {!lookupIsName && otherDictForms.length > 0 && (
                <div className="word-popover__alt-forms">
                  Also written: {otherDictForms.join(" · ")}
                </div>
              )}
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
              {!lookupIsName &&
                headword &&
                (profile?.has_openrouter_api_key ?? false) && (
                  <div className="word-popover__explain-row">
                    <button
                      type="button"
                      className="word-popover__translate-btn"
                      onClick={handleExplainWord}
                      disabled={generationInFlight || explainStarted}
                      title={
                        explainStarted
                          ? "The lesson will appear in Compositions when ready"
                          : generationInFlight
                            ? "A generation is already in progress"
                            : "Generate a short Japanese lesson explaining this word"
                      }
                    >
                      {explainStarted ? "✓ Lesson on the way" : "Explain Word"}
                    </button>
                  </div>
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
                  {tapSource && sourcesEqual(activeCard.source, tapSource) ? (
                    <span className="word-popover__nav-title">
                      {tapSource.kind === "story" ? "This story" : "This chat"}
                    </span>
                  ) : (
                    <>
                      <Link
                        to={sourceLink(activeCard.source)}
                        className="word-popover__nav-title word-popover__nav-title--link"
                        onClick={() => onOpenChange(false)}
                      >
                        {stripAnnotations(stripBold(activeCard.sourceTitle ?? ""))}
                      </Link>
                      {activeCard.sourceCreatedAt && (
                        <span className="word-popover__nav-date">
                          {formatStoryDate(activeCard.sourceCreatedAt)}
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
                        snippet.surfaceEnd,
                        "word-popover__snippet-highlight"
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
                      <div className="word-popover__translation-text">
                        {cachedTranslation.text}
                      </div>
                    ) : translationError ? (
                      <div className="word-popover__error">
                        {translationError}
                      </div>
                    ) : translationPending ? (
                      <div className="word-popover__translation-loading">
                        Translating<AnimatedDots />
                      </div>
                    ) : null}
                    {/* The translate control and Add to Reviews sit on one
                        row: mining a sentence is the natural next step after
                        reading its translation. */}
                    <div className="word-popover__translation-actions">
                      {activeCard &&
                        snippet &&
                        cachedTranslation &&
                        !translationRegenerating && (
                          <SentenceAudioButton
                            key={`${sourceKey(activeCard.source)}:${snippet.sentenceStart}-${snippet.sentenceEnd}`}
                            kind="source"
                            source={activeCard.source}
                            sentenceStart={snippet.sentenceStart}
                            sentenceEnd={snippet.sentenceEnd}
                            annotations={snippet.annotations}
                          />
                        )}
                      {cachedTranslation && !translationRegenerating ? (
                        <button
                          type="button"
                          className="word-popover__regenerate"
                          onClick={handleRegenerate}
                          disabled={translationPending}
                        >
                          ↻ Regenerate
                        </button>
                      ) : translationError ? (
                        <button
                          type="button"
                          className="word-popover__regenerate"
                          onClick={handleRegenerate}
                          disabled={translationPending}
                        >
                          ↻ Retry
                        </button>
                      ) : translationPending ? null : (
                        <button
                          type="button"
                          className="word-popover__translate-btn"
                          onClick={handleTranslate}
                        >
                          AI Translation
                        </button>
                      )}
                      {(sentenceMined || canMineSentence) && (
                        <button
                          type="button"
                          className="word-popover__translate-btn"
                          onClick={handleAddToReviews}
                          disabled={
                            sentenceMined || addingCard || translationPending
                          }
                          title={
                            sentenceMined
                              ? "This sentence is already a review card"
                              : "Save this sentence to Reviews, translating it first if needed"
                          }
                        >
                          {sentenceMined
                            ? "✓ In Reviews"
                            : addingCard
                              ? "Adding"
                              : "Add to Reviews"}
                          {addingCard && <AnimatedDots />}
                        </button>
                      )}
                    </div>
                    {addCardError && (
                      <div className="word-popover__error">{addCardError}</div>
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
