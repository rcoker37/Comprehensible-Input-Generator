// Renders one assistant chat message body. Words are tappable: each tap
// toggles the headword's "saved lookup" mark, which highlights every
// instance of that headword in this message and adds a row to the message's
// Lookups list. Marks are React state — they don't persist across remounts.
// Reuses the pure rendering lib functions (buildDisplaySegments,
// regroupWords, applyOccurrences); chat messages don't have manual
// overrides or per-message translation ownership.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDictionary } from "../contexts/DictionaryContext";
import { useWordIndexBackfill } from "../contexts/WordIndexBackfillContext";
import { useChats } from "../contexts/ChatsContext";
import {
  getChatMessage,
  getChatMessageOccurrences,
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
import AnimatedDots from "./AnimatedDots";
import LookupsButton from "./LookupsButton";
import type {
  ChatMessage,
  DisplayMode,
  FontMode,
} from "../types";
import "./ChatAssistantMessage.css";

interface Props {
  message: ChatMessage;
  furiganaMode: DisplayMode;
  showSavedLookups: boolean;
  font: FontMode;
}

type ChatOccurrence = {
  start: number;
  end: number;
  surface: string;
  headword: string;
  reading: string | null;
  entryId: number | null;
  isName: boolean;
};

export default function ChatAssistantMessage({
  message,
  furiganaMode,
  showSavedLookups,
  font,
}: Props) {
  const { state: dictState } = useDictionary();
  const {
    remaining: backfillRemaining,
    processing: backfillProcessing,
    currentChatMessageId,
  } = useWordIndexBackfill();
  const { applyMessageUpdate } = useChats();

  const [markedHeadwords, setMarkedHeadwords] = useState<Set<string>>(
    () => new Set()
  );
  const toggleMark = useCallback((headword: string) => {
    setMarkedHeadwords((prev) => {
      const next = new Set(prev);
      if (next.has(headword)) next.delete(headword);
      else next.add(headword);
      return next;
    });
  }, []);

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

  const paragraphs: DisplayParagraph[] | null = useMemo(() => {
    const base =
      groupedState?.source === baseParagraphs
        ? groupedState.paragraphs
        : dictState === "error"
          ? baseParagraphs
          : null;
    if (!base) return null;
    if (occurrences && occurrences.length > 0) {
      return applyOccurrences(
        base,
        occurrences.map((o) => ({ ...o, manual: false })),
        cleanContent,
        rubyAnnotations
      );
    }
    return base;
  }, [groupedState, baseParagraphs, dictState, occurrences, cleanContent, rubyAnnotations]);

  const displayParagraphs = paragraphs ?? baseParagraphs;

  const indexUnsettled =
    message.word_index_at === null ||
    backfillProcessing ||
    backfillRemaining > 0;
  const showLoadingOverlay =
    hasBeenIndexed &&
    (paragraphs === null ||
      indexUnsettled ||
      currentChatMessageId === message.id);

  // Map of "start-end" → occurrence — drives tap-toggle + the saved-lookup
  // highlight. Names are excluded so they're not tappable.
  const occurrenceBySpan = useMemo(() => {
    const map = new Map<string, ChatOccurrence>();
    if (!occurrences) return map;
    for (const o of occurrences) {
      if (o.isName || !o.headword) continue;
      map.set(`${o.start}-${o.end}`, o);
    }
    return map;
  }, [occurrences]);

  // "unseen" used to gate on encounter counts; with the encounter highlight
  // gone it now behaves the same as "all" — every word gets ruby. Only "off"
  // suppresses it.
  const showRubyForMode = furiganaMode !== "off";

  const tokenClass = (start: number, end: number): string => {
    const parts = ["word-token"];
    const occ = occurrenceBySpan.get(`${start}-${end}`);
    if (showSavedLookups && occ && markedHeadwords.has(occ.headword)) {
      parts.push("word-token--saved-lookup");
    }
    return parts.join(" ");
  };

  const handleTap = (start: number, end: number) => {
    const occ = occurrenceBySpan.get(`${start}-${end}`);
    if (!occ) return;
    toggleMark(occ.headword);
  };

  const renderRubySegments = (
    surface: string,
    surfaceStart: number,
    rubies: FuriganaAnnotation[]
  ): ReactNode[] => {
    const out: ReactNode[] = [];
    let cursor = 0;
    for (const r of rubies) {
      const relStart = r.start - surfaceStart;
      const relEnd = r.end - surfaceStart;
      if (relStart > cursor) out.push(surface.slice(cursor, relStart));
      const sub = surface.slice(relStart, relEnd);
      out.push(
        showRubyForMode ? (
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
      const inner = showRubyForMode ? (
        <ruby>
          {part.surface}
          <rt>{part.reading}</rt>
        </ruby>
      ) : (
        part.surface
      );
      const hasOccurrence = occurrenceBySpan.has(`${part.start}-${part.end}`);
      if (hasOccurrence) {
        return (
          <button
            type="button"
            key={key}
            className={tokenClass(part.start, part.end)}
            data-offset={part.start}
            onClick={() => handleTap(part.start, part.end)}
          >
            {inner}
          </button>
        );
      }
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
          ? renderRubySegments(part.surface, part.start, part.rubies)
          : part.surface;
      const hasOccurrence = occurrenceBySpan.has(`${part.start}-${part.end}`);
      if (hasOccurrence) {
        return (
          <button
            type="button"
            key={key}
            className={tokenClass(part.start, part.end)}
            data-offset={part.start}
            onClick={() => handleTap(part.start, part.end)}
          >
            {inner}
          </button>
        );
      }
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
      <div className="chat-msg-actions">
        <LookupsButton
          content={message.content}
          occurrences={occurrences ?? []}
          markedHeadwords={markedHeadwords}
          hidden={message.word_index_at === null}
        />
      </div>
    </div>
  );
}
