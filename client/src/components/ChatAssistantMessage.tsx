// Renders one assistant chat message body. Words are tappable: each tap
// opens a WordPopover anchored at the span, the same way StoryDisplay does.
// Reuses the pure rendering lib functions (buildDisplaySegments,
// regroupWords, applyOccurrences); chat messages don't have manual overrides.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDictionary } from "../contexts/DictionaryContext";
import { useWordIndexBackfill } from "../contexts/WordIndexBackfillContext";
import { useChats } from "../contexts/ChatsContext";
import { useVocab } from "../contexts/VocabContext";
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
import WordPopover from "./WordPopover";
import {
  FURIGANA_UNSEEN_THRESHOLD,
  type ChatMessage,
  type DisplayMode,
  type FontMode,
  type SentenceTranslation,
  type StoryTranslations,
} from "../types";
import "./ChatAssistantMessage.css";

interface Props {
  message: ChatMessage;
  furiganaMode: DisplayMode;
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
  font,
}: Props) {
  const { state: dictState } = useDictionary();
  const { vocabEncounters } = useVocab();
  const {
    remaining: backfillRemaining,
    processing: backfillProcessing,
    currentChatMessageId,
  } = useWordIndexBackfill();
  const { applyMessageUpdate } = useChats();

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

  const popoverDisabled =
    message.word_index_at === null ||
    backfillProcessing ||
    backfillRemaining > 0;
  const showLoadingOverlay =
    hasBeenIndexed &&
    (paragraphs === null ||
      popoverDisabled ||
      currentChatMessageId === message.id);

  // Local translations cache mirrored from `message.translations`. Edits
  // round-trip through `applyMessageUpdate` so the chat-list cache stays
  // consistent.
  const [translations, setTranslations] = useState<StoryTranslations>(
    message.translations ?? {}
  );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTranslations(message.translations ?? {});
  }, [message.translations]);
  const handleTranslationUpdated = (
    rangeKey: string,
    translation: SentenceTranslation
  ) => {
    const next = { ...translations, [rangeKey]: translation };
    setTranslations(next);
    applyMessageUpdate(message.id, { translations: next });
  };

  // Map of "start-end" → occurrence — drives tap-to-popover with the
  // indexer's chosen lemma + entry id + reading.
  const occurrenceBySpan = useMemo(() => {
    const map = new Map<string, ChatOccurrence>();
    if (!occurrences) return map;
    for (const o of occurrences) {
      if (!o.headword) continue;
      map.set(`${o.start}-${o.end}`, o);
    }
    return map;
  }, [occurrences]);

  // In "unseen" mode, ruby is gated per-word on the user's read-source
  // encounter count for the occurrence's headword. Off / all are global.
  const showRubyForOccurrence = (start: number, end: number): boolean => {
    if (furiganaMode === "off") return false;
    if (furiganaMode === "all") return true;
    const occ = occurrenceBySpan.get(`${start}-${end}`);
    if (!occ) return true;
    return (vocabEncounters.get(occ.headword) ?? 0) < FURIGANA_UNSEEN_THRESHOLD;
  };

  const [activeTap, setActiveTap] = useState<{
    start: number;
    end: number;
    lookupHeadword: string | null;
    lookupEntryId: number | null;
    lookupIsName: boolean;
    lookupReading: string | null;
  } | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (popoverDisabled) setActiveTap(null);
  }, [popoverDisabled]);

  const handleWordClick = (start: number, end: number) => {
    if (popoverDisabled) return;
    const occ = occurrenceBySpan.get(`${start}-${end}`);
    setActiveTap({
      start,
      end,
      lookupHeadword: occ?.headword ?? null,
      lookupEntryId: occ?.entryId ?? null,
      lookupIsName: occ?.isName ?? false,
      lookupReading: occ?.reading ?? null,
    });
  };

  const renderRubySegments = (
    surface: string,
    surfaceStart: number,
    rubies: FuriganaAnnotation[],
    showRuby: boolean
  ): ReactNode[] => {
    const out: ReactNode[] = [];
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
      const showRuby = showRubyForOccurrence(part.start, part.end);
      const inner = showRuby ? (
        <ruby>
          {part.surface}
          <rt>{part.reading}</rt>
        </ruby>
      ) : (
        part.surface
      );
      return (
        <button
          type="button"
          key={key}
          className="word-token"
          data-offset={part.start}
          onClick={() => handleWordClick(part.start, part.end)}
        >
          {inner}
        </button>
      );
    }
    if (part.kind === "word") {
      const showRuby = showRubyForOccurrence(part.start, part.end);
      const inner =
        part.rubies && part.rubies.length > 0
          ? renderRubySegments(part.surface, part.start, part.rubies, showRuby)
          : part.surface;
      return (
        <button
          type="button"
          key={key}
          className="word-token"
          data-offset={part.start}
          onClick={() => handleWordClick(part.start, part.end)}
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
        type="button"
        key={key}
        className="word-token"
        data-offset={part.offset}
        onClick={() => handleWordClick(part.offset, part.offset + 1)}
      >
        {part.char}
      </button>
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
      <WordPopover
        mode={{
          kind: "tap",
          source: { kind: "chat", chatMessageId: message.id },
          cleanText: cleanContent,
          annotations: rubyAnnotations,
          start: activeTap?.start ?? 0,
          end: activeTap?.end ?? 0,
          lookupHeadword: activeTap?.lookupHeadword ?? null,
          lookupEntryId: activeTap?.lookupEntryId ?? null,
          lookupIsName: activeTap?.lookupIsName ?? false,
          lookupReading: activeTap?.lookupReading ?? null,
          translations,
          onTranslationUpdated: handleTranslationUpdated,
        }}
        open={activeTap !== null}
        onOpenChange={(open) => {
          if (!open) setActiveTap(null);
        }}
      />
    </div>
  );
}
