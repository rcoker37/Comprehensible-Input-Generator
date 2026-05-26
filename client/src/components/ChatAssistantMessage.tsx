// Renders one assistant chat message body with the same tap-target +
// furigana + new-word highlighting pipeline as StoryDisplay, plus the
// per-message "Mark as Read" toggle. Reuses the pure rendering lib
// functions (buildDisplaySegments, regroupWords, applyOccurrences) but
// doesn't try to extract anything from StoryDisplay itself — chat
// messages don't have manual overrides, title rendering, or per-message
// translation parent ownership, so a focused copy is simpler than a
// shared abstraction that has to opt-out of all that.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDictionary } from "../contexts/DictionaryContext";
import { useWordIndexBackfill } from "../contexts/WordIndexBackfillContext";
import {
  getChatMessageOccurrences,
  getChatMessageWordEncounters,
  markChatMessageRead,
  undoChatMessageRead,
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
  StoryTranslations,
} from "../types";
import "./ChatAssistantMessage.css";

interface TapArgs {
  messageId: number;
  start: number;
  end: number;
  cleanText: string;
  annotations: FuriganaAnnotation[];
  lookupHeadword: string | null;
  lookupEntryId: number | null;
  lookupIsName: boolean;
  lookupReading: string | null;
  translations: StoryTranslations;
}

interface Props {
  message: ChatMessage;
  furiganaMode: DisplayMode;
  highlightMode: HighlightMode;
  font: FontMode;
  /** ChatDetail-owned translations map; this message's slot keys off `${start}-${end}`. */
  translations: StoryTranslations;
  onTranslationUpdated: (
    messageId: number,
    rangeKey: string,
    translation: StoryTranslations[string]
  ) => void;
  onWordTap: (args: TapArgs) => void;
  onReadChange: (messageId: number, isRead: boolean) => void;
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
  onWordTap,
  onReadChange,
}: Props) {
  const { state: dictState } = useDictionary();
  const {
    remaining: backfillRemaining,
    processing: backfillProcessing,
    currentChatMessageId,
  } = useWordIndexBackfill();
  const [readPending, setReadPending] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

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
  // Refetched after the backfill finishes processing this message.
  const [occurrences, setOccurrences] = useState<
    | {
        start: number;
        end: number;
        surface: string;
        headword: string;
        reading: string | null;
        entryId: number | null;
        isName: boolean;
      }[]
    | null
  >(null);
  useEffect(() => {
    if (message.word_index_at === null) {
      setOccurrences(null);
      return;
    }
    let cancelled = false;
    getChatMessageOccurrences(message.id)
      .then((rows) => {
        if (!cancelled) {
          // Synthesise the shape applyOccurrences expects (it ignores manual /
          // user_id, just reads start/end/surface/headword/reading/entryId/isName).
          setOccurrences(rows);
        }
      })
      .catch(() => {
        if (!cancelled) setOccurrences(null);
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
  const [encounters, setEncounters] = useState<Map<string, number>>(
    () => new Map()
  );
  useEffect(() => {
    if (message.word_index_at === null) {
      setEncounters(new Map());
      return;
    }
    let cancelled = false;
    getChatMessageWordEncounters(message.id)
      .then((m) => {
        if (!cancelled) setEncounters(m);
      })
      .catch(() => {
        if (!cancelled) setEncounters(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [message.id, message.word_index_at, message.is_read, backfillProcessing]);

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

  const lookupBySpan = useMemo(() => {
    const map = new Map<
      string,
      {
        headword: string;
        entryId: number | null;
        isName: boolean;
        reading: string | null;
      }
    >();
    if (occurrences) {
      for (const o of occurrences) {
        if (!o.headword) continue;
        map.set(`${o.start}-${o.end}`, {
          headword: o.headword,
          entryId: o.entryId,
          isName: o.isName,
          reading: o.reading,
        });
      }
    }
    return map;
  }, [occurrences]);

  // Block tap targets while indexing is pending (mirrors StoryDisplay).
  const popoverDisabled =
    message.word_index_at === null ||
    backfillProcessing ||
    backfillRemaining > 0;
  const showLoadingOverlay =
    paragraphs === null ||
    popoverDisabled ||
    currentChatMessageId === message.id;

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
    const tier = highlightTier(start, end);
    if (tier) {
      parts.push("word-token--new");
      parts.push(`word-token--freq-${tier}`);
    }
    return parts.join(" ");
  };

  const handleWordClick = (
    e: React.MouseEvent<HTMLButtonElement>,
    start: number,
    end: number
  ) => {
    e.stopPropagation();
    if (popoverDisabled) return;
    const entry = lookupBySpan.get(`${start}-${end}`);
    onWordTap({
      messageId: message.id,
      start,
      end,
      cleanText: cleanContent,
      annotations: rubyAnnotations,
      lookupHeadword: entry?.headword ?? null,
      lookupEntryId: entry?.entryId ?? null,
      lookupIsName: entry?.isName ?? false,
      lookupReading: entry?.reading ?? null,
      translations: message.translations ?? {},
    });
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
        <button
          key={key}
          type="button"
          className={tokenClass(part.start, part.end)}
          data-offset={part.start}
          aria-label={part.surface}
          onClick={(e) => handleWordClick(e, part.start, part.end)}
        >
          {inner}
        </button>
      );
    }
    if (part.kind === "word") {
      const inner =
        part.rubies && part.rubies.length > 0
          ? renderRubySegments(part.surface, part.start, part.end, part.rubies)
          : part.surface;
      return (
        <button
          key={key}
          type="button"
          className={tokenClass(part.start, part.end)}
          data-offset={part.start}
          aria-label={part.surface}
          onClick={(e) => handleWordClick(e, part.start, part.end)}
        >
          {inner}
        </button>
      );
    }
    if (isPunctuation(part.char)) {
      return <span key={key}>{part.char}</span>;
    }
    return (
      <button
        key={key}
        type="button"
        className={tokenClass(part.offset, part.offset + 1)}
        data-offset={part.offset}
        aria-label={part.char}
        onClick={(e) => handleWordClick(e, part.offset, part.offset + 1)}
      >
        {part.char}
      </button>
    );
  };

  // Track latest message read state in a ref so the click handler reads it
  // without rebuilding on every parent re-render.
  const isReadRef = useRef(message.is_read);
  useEffect(() => {
    isReadRef.current = message.is_read;
  }, [message.is_read]);

  const handleReadToggle = async () => {
    if (readPending) return;
    setReadPending(true);
    setReadError(null);
    try {
      const flipped = !isReadRef.current;
      if (flipped) {
        await markChatMessageRead(message.id);
      } else {
        await undoChatMessageRead(message.id);
      }
      onReadChange(message.id, flipped);
    } catch (err) {
      setReadError(err instanceof Error ? err.message : "Read toggle failed");
    } finally {
      setReadPending(false);
    }
  };

  const fontClass = font === "sans" ? "chat-msg-body--sans" : "chat-msg-body--serif";

  // Status-conditional rendering. All hooks above run regardless so the
  // hook order stays stable across status transitions.
  if (message.status === "pending") {
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
        <div className="chat-msg-actions">
          {message.is_read ? (
            <button
              type="button"
              className="chat-msg-read chat-msg-read--done"
              onClick={handleReadToggle}
              disabled={readPending}
              title="Undo mark as read"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 8.5L6.5 12 13 4.5" />
              </svg>
              Read
            </button>
          ) : (
            <button
              type="button"
              className="chat-msg-read"
              onClick={handleReadToggle}
              disabled={readPending}
            >
              {readPending ? (
                <>
                  Marking
                  <AnimatedDots />
                </>
              ) : (
                "Mark as Read"
              )}
            </button>
          )}
          {readError && <span className="chat-msg-read-error">{readError}</span>}
        </div>
      </div>
    </div>
  );
}
