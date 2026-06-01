// Renders one assistant chat message body as inert text: furigana
// annotations and new-word / frequency-tier underlines, but no
// tap-to-lookup. The user-facing WordPopover only opens via the post-read
// modal (ChatReadButton) or the Stats Browse → kanji-detail flow.
// Reuses the pure rendering lib functions (buildDisplaySegments,
// regroupWords, applyOccurrences); chat messages don't have manual
// overrides or per-message translation ownership.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDictionary } from "../contexts/DictionaryContext";
import { useWordIndexBackfill } from "../contexts/WordIndexBackfillContext";
import { useChats } from "../contexts/ChatsContext";
import {
  getChatMessage,
  getChatMessageOccurrences,
  getChatMessageWordEncounters,
} from "../api/client";
import {
  parseAnnotatedText,
  type FuriganaAnnotation,
} from "../lib/furigana";
import { stripBold, isPunctuation } from "../lib/text";
import {
  buildDisplaySegments,
  type DisplayParagraph,
  type SegmentPart,
} from "../lib/storySegments";
import { regroupWords } from "../lib/regroupWords";
import { applyOccurrences } from "../lib/applyOccurrences";
import {
  loadFrequencyIndex,
  lookupFrequencyByCanonicalSync,
  lookupFrequencyByEntrySync,
  lookupFrequencySync,
  type FrequencyTier,
} from "../lib/frequency";
import AnimatedDots from "./AnimatedDots";
import type {
  ChatMessage,
  DisplayMode,
  FontMode,
  HighlightMode,
} from "../types";
import "./ChatAssistantMessage.css";

interface Props {
  message: ChatMessage;
  furiganaMode: DisplayMode;
  highlightMode: HighlightMode;
  font: FontMode;
}

const encountersToTier = (n: number): FrequencyTier | null => {
  if (n <= 0) return "very-rare";
  if (n <= 2) return "rare";
  if (n <= 4) return "uncommon";
  if (n <= 6) return "common";
  if (n <= 9) return "very-common";
  return null;
};

export default function ChatAssistantMessage({
  message,
  furiganaMode,
  highlightMode,
  font,
}: Props) {
  const { state: dictState } = useDictionary();
  const {
    remaining: backfillRemaining,
    processing: backfillProcessing,
    currentChatMessageId,
  } = useWordIndexBackfill();
  const { applyMessageUpdate } = useChats();

  // After the backfill finishes processing this message, refetch it so the
  // cached `word_index_at` updates locally. Without this the popover stays
  // disabled and the glassy overlay never clears until a page reload — the
  // server stamps word_index_at, but nothing in the client knows to refetch.
  // Mirrors StoryDetail's refetchStory effect.
  const prevCurrentRef = useRef<number | null>(currentChatMessageId);
  useEffect(() => {
    const prev = prevCurrentRef.current;
    prevCurrentRef.current = currentChatMessageId;
    if (prev === message.id && currentChatMessageId !== message.id) {
      getChatMessage(message.id)
        .then((fresh) =>
          applyMessageUpdate(message.id, {
            word_index_at: fresh.word_index_at,
          })
        )
        .catch((err) =>
          console.warn("Refetch after backfill failed:", err)
        );
    }
  }, [currentChatMessageId, message.id, applyMessageUpdate]);

  // Track whether this message has EVER been seen with word_index_at !== null.
  // Distinguishes "first-time indexing" (hide the body, show typing dots
  // until the indexer catches up) from "re-indexing an already-shown message"
  // (e.g., the user hit Reset — keep showing the body under the glassy
  // overlay so the text doesn't disappear). Uses the React-blessed
  // "store a snapshot of prior props" pattern: setState in render flips
  // the latch when the prop transitions; React discards this render and
  // immediately retries with the new state, no effect needed.
  const [hasBeenIndexed, setHasBeenIndexed] = useState(
    message.word_index_at !== null
  );
  if (message.word_index_at !== null && !hasBeenIndexed) {
    setHasBeenIndexed(true);
  }
  const firstIndexPending =
    message.status === "complete" &&
    message.word_index_at === null &&
    !hasBeenIndexed;

  const { cleanContent, rubyAnnotations } = useMemo(() => {
    const raw = stripBold(message.content);
    const { cleanText, annotations } = parseAnnotatedText(raw);
    return { cleanContent: cleanText, rubyAnnotations: annotations };
  }, [message.content]);

  const baseParagraphs: DisplayParagraph[] = useMemo(
    () => buildDisplaySegments(cleanContent, rubyAnnotations),
    [cleanContent, rubyAnnotations]
  );

  // Async regroup pass: kuromoji-tokenised, JMdict-anchored word-shaped tap
  // targets. Stale runs are filtered by a `source` identity check.
  const [groupedState, setGroupedState] = useState<{
    source: DisplayParagraph[];
    paragraphs: DisplayParagraph[];
  } | null>(null);
  useEffect(() => {
    if (dictState !== "ready") return;
    let cancelled = false;
    regroupWords(baseParagraphs, cleanContent, rubyAnnotations).then((res) => {
      if (!cancelled) {
        setGroupedState({ source: baseParagraphs, paragraphs: res });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [baseParagraphs, cleanContent, rubyAnnotations, dictState]);

  // Indexed occurrences (algorithm rows only — no manual overrides for chats).
  // Refetched after the backfill finishes processing this message. The
  // "no index yet" case is derived from the prop in render so the effect
  // never needs a synchronous null-reset.
  type ChatOccurrence = {
    start: number;
    end: number;
    surface: string;
    headword: string;
    reading: string | null;
    entryId: number | null;
    isName: boolean;
  };
  const [fetchedOccurrences, setFetchedOccurrences] = useState<
    ChatOccurrence[] | null
  >(null);
  const occurrences =
    message.word_index_at === null ? null : fetchedOccurrences;
  useEffect(() => {
    if (message.word_index_at === null) return;
    let cancelled = false;
    getChatMessageOccurrences(message.id)
      .then((rows) => {
        if (!cancelled) setFetchedOccurrences(rows);
      })
      .catch(() => {
        if (!cancelled) setFetchedOccurrences(null);
      });
    return () => {
      cancelled = true;
    };
  }, [message.id, message.word_index_at, backfillProcessing]);

  // Merged tap targets when ready; falls back to char-level baseline before
  // the regroup completes. The user sees the body either way; tap targets
  // sharpen as the pipeline catches up.
  const paragraphs: DisplayParagraph[] | null = useMemo(() => {
    const base =
      groupedState?.source === baseParagraphs
        ? groupedState.paragraphs
        : dictState === "error"
          ? baseParagraphs
          : null;
    if (!base) return null;
    if (occurrences && occurrences.length > 0) {
      // applyOccurrences accepts the StoryOccurrence-shaped rows — same shape
      // works here since the fields used (start/end/surface) overlap.
      return applyOccurrences(
        base,
        // applyOccurrences expects the StoryOccurrence shape; our rows match
        // it minus the manual flag. Synthesise manual=false explicitly.
        occurrences.map((o) => ({ ...o, manual: false })),
        cleanContent,
        rubyAnnotations
      );
    }
    return base;
  }, [groupedState, baseParagraphs, dictState, occurrences, cleanContent, rubyAnnotations]);

  const displayParagraphs = paragraphs ?? baseParagraphs;

  // Per-span encounter counts (from this user's read stories + read chats).
  // Refetched when read state flips or the backfill finishes processing.
  // The "no index yet" case is derived from the prop so the effect
  // doesn't need a synchronous reset.
  const [fetchedEncounters, setFetchedEncounters] = useState<Map<string, number>>(
    () => new Map()
  );
  const encounters: Map<string, number> =
    message.word_index_at === null ? new Map() : fetchedEncounters;
  useEffect(() => {
    if (message.word_index_at === null) return;
    let cancelled = false;
    getChatMessageWordEncounters(message.id)
      .then((m) => {
        if (!cancelled) setFetchedEncounters(m);
      })
      .catch(() => {
        if (!cancelled) setFetchedEncounters(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [message.id, message.word_index_at, message.read_count, backfillProcessing]);

  // JPDB frequency index — load once for the rarity-tinted underlines.
  const [freqLoaded, setFreqLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadFrequencyIndex()
      .then(() => {
        if (!cancelled) setFreqLoaded(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const tierBySpan = useMemo(() => {
    const map = new Map<string, FrequencyTier>();
    if (!freqLoaded || !occurrences) return map;
    for (const o of occurrences) {
      if (!o.headword || o.isName) continue;
      const byEntry =
        o.entryId !== null ? lookupFrequencyByEntrySync(o.entryId) : null;
      const tier =
        byEntry?.tier ??
        lookupFrequencyByCanonicalSync(o.headword)?.tier ??
        lookupFrequencySync(o.headword, null).tier;
      map.set(`${o.start}-${o.end}`, tier);
    }
    return map;
  }, [freqLoaded, occurrences]);

  // True while the word index for this message isn't settled — used to
  // gate the loading overlay so visible reflow from the regroup pass is
  // hidden until spans stop moving.
  const indexUnsettled =
    message.word_index_at === null ||
    backfillProcessing ||
    backfillRemaining > 0;
  // Glassy overlay is for "re-indexing an existing message" only — when the
  // message was previously indexed but the index is currently rebuilding.
  // First-time indexing hides the body entirely (firstIndexPending branch
  // below), so no overlay is needed there.
  const showLoadingOverlay =
    hasBeenIndexed &&
    (paragraphs === null ||
      indexUnsettled ||
      currentChatMessageId === message.id);

  const showForMode = (mode: DisplayMode, start: number, end: number) => {
    switch (mode) {
      case "all":
        return true;
      case "unseen":
        return encounters.get(`${start}-${end}`) === 0;
      case "off":
      default:
        return false;
    }
  };

  const decideShowRuby = (start: number, end: number): boolean =>
    showForMode(furiganaMode, start, end);

  const highlightTier = (start: number, end: number): FrequencyTier | null => {
    if (highlightMode === "off") return null;
    if (highlightMode === "frequency") {
      return tierBySpan.get(`${start}-${end}`) ?? null;
    }
    const count = encounters.get(`${start}-${end}`);
    if (count === undefined) return null;
    return encountersToTier(count);
  };

  const tokenClass = (start: number, end: number): string => {
    const parts = ["word-token"];
    if (highlightMode === "fiveplus") {
      const count = encounters.get(`${start}-${end}`);
      if (count !== undefined && count >= 5) {
        parts.push("word-token--new");
        parts.push("word-token--fiveplus");
      }
    } else {
      const tier = highlightTier(start, end);
      if (tier) {
        parts.push("word-token--new");
        parts.push(`word-token--freq-${tier}`);
      }
    }
    return parts.join(" ");
  };

  const renderRubySegments = (
    surface: string,
    surfaceStart: number,
    surfaceEnd: number,
    rubies: FuriganaAnnotation[]
  ): ReactNode[] => {
    const out: ReactNode[] = [];
    const showRuby = decideShowRuby(surfaceStart, surfaceEnd);
    let cursor = 0;
    for (const r of rubies) {
      const relStart = r.start - surfaceStart;
      const relEnd = r.end - surfaceStart;
      if (relStart > cursor) out.push(surface.slice(cursor, relStart));
      const sub = surface.slice(relStart, relEnd);
      out.push(
        showRuby ? (
          <ruby key={relStart}>
            {sub}
            <rt>{r.reading}</rt>
          </ruby>
        ) : (
          sub
        )
      );
      cursor = relEnd;
    }
    if (cursor < surface.length) out.push(surface.slice(cursor));
    return out;
  };

  const renderPart = (part: SegmentPart, key: number) => {
    if (part.kind === "annotated") {
      const inner = decideShowRuby(part.start, part.end) ? (
        <ruby>
          {part.surface}
          <rt>{part.reading}</rt>
        </ruby>
      ) : (
        part.surface
      );
      return (
        <span
          key={key}
          className={tokenClass(part.start, part.end)}
          data-offset={part.start}
        >
          {inner}
        </span>
      );
    }
    if (part.kind === "word") {
      const inner =
        part.rubies && part.rubies.length > 0
          ? renderRubySegments(part.surface, part.start, part.end, part.rubies)
          : part.surface;
      return (
        <span
          key={key}
          className={tokenClass(part.start, part.end)}
          data-offset={part.start}
        >
          {inner}
        </span>
      );
    }
    if (isPunctuation(part.char)) {
      return <span key={key}>{part.char}</span>;
    }
    return (
      <span
        key={key}
        className={tokenClass(part.offset, part.offset + 1)}
        data-offset={part.offset}
      >
        {part.char}
      </span>
    );
  };

  const fontClass = font === "sans" ? "chat-msg-body--sans" : "chat-msg-body--serif";

  // Status-conditional rendering. All hooks above run regardless so the
  // hook order stays stable across status transitions.
  // `firstIndexPending` lumps "LLM generation done but indexing hasn't run
  // yet" into the same typing-dots placeholder so newly-generated text
  // never flashes in before its tap targets are ready.
  if (message.status === "pending" || firstIndexPending) {
    return (
      <div className="chat-msg chat-msg--assistant chat-msg--pending">
        <div className="chat-msg-bubble">
          <div className="chat-typing">
            <AnimatedDots />
          </div>
        </div>
      </div>
    );
  }
  if (message.status === "failed") {
    return (
      <div className="chat-msg chat-msg--assistant chat-msg--failed">
        <div className="chat-msg-bubble">
          <div className="chat-msg-error">
            {message.error_message || "Reply failed"}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-msg chat-msg--assistant">
      <div className="chat-msg-bubble">
        <div className={`chat-msg-body ${fontClass}`}>
          {displayParagraphs.map((para, pIdx) => (
            <p key={pIdx} className="chat-msg-paragraph">
              {para.sentences.map((sent) => (
                <span key={sent.start} className="chat-msg-sentence">
                  {sent.parts.map((part, i) => renderPart(part, i))}
                </span>
              ))}
            </p>
          ))}
          {showLoadingOverlay && (
            <div className="chat-msg-body__overlay" aria-hidden="true" />
          )}
        </div>
      </div>
    </div>
  );
}
