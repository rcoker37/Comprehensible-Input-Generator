import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useKnownKanji } from "../contexts/KanjiContext";
import { useDictionary } from "../contexts/DictionaryContext";
import {
  parseAnnotatedText,
  stripAnnotations,
  type FuriganaAnnotation,
} from "../lib/furigana";
import { stripBold, getUnknownKanji } from "../lib/text";
import { KANJI_REGEX } from "../lib/constants";
import {
  buildDisplaySegments,
  type DisplayParagraph,
  type SegmentPart,
} from "../lib/storySegments";
import { regroupWords } from "../lib/regroupWords";
import WordPopover from "./WordPopover";
import type {
  Story,
  StoryAudio,
  StoryWordThreads,
  WordThread,
} from "../types";
import "./StoryDisplay.css";

interface Props {
  story: Story;
  showLink?: boolean;
  audio?: StoryAudio | null;
  activeSegmentIdx?: number;
  onSentenceClick?: (i: number) => void;
}

export default function StoryDisplay({
  story,
  showLink,
  activeSegmentIdx = -1,
  onSentenceClick,
}: Props) {
  const { knownKanji, knownKanjiLoaded } = useKnownKanji();
  const { state: dictState } = useDictionary();
  const [wordThreads, setWordThreads] = useState<StoryWordThreads>(
    story.explanations ?? {}
  );
  const [activeTap, setActiveTap] = useState<{
    start: number;
    end: number;
    el: HTMLElement;
  } | null>(null);
  const [furiganaState, setFuriganaState] = useState("unknown");
  useEffect(() => {
    setWordThreads(story.explanations ?? {});
  }, [story.explanations]);

  const { cleanContent, rubyAnnotations } = useMemo(() => {
    const raw = stripBold(story.content);
    const { cleanText, annotations } = parseAnnotatedText(raw);
    return { cleanContent: cleanText, rubyAnnotations: annotations };
  }, [story.content]);

  // Char-level baseline — every char is its own tap target. Renders immediately.
  const baseParagraphs: DisplayParagraph[] = useMemo(
    () => buildDisplaySegments(cleanContent, rubyAnnotations),
    [cleanContent, rubyAnnotations]
  );

  // Async regroup pass: once the dict is ready, kuromoji tokenises the text
  // and we merge consecutive chars into word-shaped tap targets where JMdict
  // (with deinflection) confirms a span aligned to a kuromoji boundary.
  // While loading or unavailable, fall through to the char-level baseline so
  // the story is always interactive. Stale results are filtered out by an
  // object-identity check on `source` rather than a synchronous reset.
  const [groupedState, setGroupedState] = useState<{
    source: DisplayParagraph[];
    paragraphs: DisplayParagraph[];
  } | null>(null);
  useEffect(() => {
    if (dictState !== "ready") return;
    let cancelled = false;
    regroupWords(baseParagraphs, cleanContent, rubyAnnotations).then(
      (res) => {
        if (!cancelled) {
          setGroupedState({ source: baseParagraphs, paragraphs: res });
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [baseParagraphs, cleanContent, rubyAnnotations, dictState]);

  const paragraphs: DisplayParagraph[] =
    groupedState?.source === baseParagraphs
      ? groupedState.paragraphs
      : baseParagraphs;

  const unknownKanji = useMemo(() => {
    if (!knownKanjiLoaded) return new Set<string>();
    return getUnknownKanji(cleanContent, knownKanji);
  }, [cleanContent, knownKanji, knownKanjiLoaded]);

  // Single-click on a word seeks the enclosing sentence; double-click opens
  // the word popover. We delay the single-click seek so a fast double-click
  // can cancel it. Clicks on whitespace inside the sentence skip this path
  // entirely and seek immediately via the sentence span's onClick.
  const clickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
      }
    };
  }, []);

  const cancelPendingSeek = () => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  };

  const handleWordClick = (
    e: React.MouseEvent<HTMLButtonElement>,
    sentenceAudioIdx: number
  ) => {
    e.stopPropagation();
    cancelPendingSeek();
    if (e.detail >= 2) return; // second click of a double — let dblclick handle it
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      onSentenceClick?.(sentenceAudioIdx);
    }, 280);
  };

  const handleWordDoubleClick = (
    e: React.MouseEvent<HTMLButtonElement>,
    start: number,
    end: number
  ) => {
    e.stopPropagation();
    cancelPendingSeek();
    setActiveTap({ start, end, el: e.currentTarget });
  };

  const handleThreadUpdated = (
    rangeKey: string,
    threadId: string,
    thread: WordThread
  ) => {
    setWordThreads((prev) => ({
      ...prev,
      [rangeKey]: { ...(prev[rangeKey] ?? {}), [threadId]: thread },
    }));
  };

  const decideShowRuby = (subSurface: string): boolean => {
    switch (furiganaState) {
      case "all":
        return true;
      case "none":
        return false;
      case "unknown":
        return [...subSurface].some(
          (ch) => KANJI_REGEX.test(ch) && unknownKanji.has(ch)
        );
      default:
        return false;
    }
  };

  // Split a merged WordPart's surface around its sub-annotations and render
  // ruby on the annotated sub-spans only. Used when the regroup pass merged
  // an AnnotatedPart with neighbouring chars (e.g. 「高《たか》」 + 「く」 →
  // one tap target rendering as `<ruby>高<rt>たか</rt></ruby>く`).
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
        decideShowRuby(sub) ? (
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

  const renderPart = (
    part: SegmentPart,
    sentenceAudioIdx: number,
    key: number
  ) => {
    if (part.kind === "annotated") {
      const inner = decideShowRuby(part.surface) ? (
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
          className="word-token"
          data-offset={part.start}
          aria-label={part.surface}
          onClick={(e) => handleWordClick(e, sentenceAudioIdx)}
          onDoubleClick={(e) => handleWordDoubleClick(e, part.start, part.end)}
        >
          {inner}
        </button>
      );
    }
    if (part.kind === "word") {
      const inner =
        part.rubies && part.rubies.length > 0
          ? renderRubySegments(part.surface, part.start, part.rubies)
          : part.surface;
      return (
        <button
          key={key}
          type="button"
          className="word-token"
          data-offset={part.start}
          aria-label={part.surface}
          onClick={(e) => handleWordClick(e, sentenceAudioIdx)}
          onDoubleClick={(e) => handleWordDoubleClick(e, part.start, part.end)}
        >
          {inner}
        </button>
      );
    }
    return (
      <button
        key={key}
        type="button"
        className="word-token"
        data-offset={part.offset}
        aria-label={part.char}
        onClick={(e) => handleWordClick(e, sentenceAudioIdx)}
        onDoubleClick={(e) =>
          handleWordDoubleClick(e, part.offset, part.offset + 1)
        }
      >
        {part.char}
      </button>
    );
  };

  return (
    <div className="story-display">
      <div className="story-header">
        <h2 className="story-title">{stripAnnotations(stripBold(story.title))}</h2>
      </div>
      <div className="story-meta">
        <span className="type-tag">{story.content_type ?? "fiction"}</span>
        <span className="formality-tag">{story.formality}</span>
        {story.topic && <span className="topic-tag">{story.topic}</span>}
        <div className="furigana-control">
          <span className="furigana-label">furigana: </span>
          <button
            type="button"
            className="furigana-toggle"
            onClick={() =>
              setFuriganaState((s) =>
                s === "unknown" ? "all" : s === "all" ? "none" : "unknown"
              )
            }
          >
            {furiganaState === "all"
              ? "all"
              : furiganaState === "unknown"
                ? "unknown"
                : "off"}
          </button>
        </div>
      </div>
      <div className="story-content">
        <div className="story-paragraphs">
          {paragraphs.map((para, pIdx) => (
            <p key={pIdx} className="story-paragraph">
              {para.sentences.map((sent) => (
                <span
                  key={sent.audioIdx}
                  role="button"
                  tabIndex={0}
                  className={`story-sentence${
                    activeSegmentIdx === sent.audioIdx ? " active" : ""
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSentenceClick?.(sent.audioIdx);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      onSentenceClick?.(sent.audioIdx);
                    }
                  }}
                >
                  {sent.parts.map((part, i) =>
                    renderPart(part, sent.audioIdx, i)
                  )}
                </span>
              ))}
            </p>
          ))}
        </div>
      </div>
      <WordPopover
        storyId={story.id}
        cleanText={cleanContent}
        annotations={rubyAnnotations}
        start={activeTap?.start ?? null}
        end={activeTap?.end ?? null}
        wordThreads={wordThreads}
        referenceEl={activeTap?.el ?? null}
        open={activeTap !== null}
        onOpenChange={(open) => {
          if (!open) setActiveTap(null);
        }}
        onThreadUpdated={handleThreadUpdated}
      />
      {furiganaState === "unknown" && unknownKanji.size > 0 && (
        <div className="violations">
          {unknownKanji.size} unknown kanji marked with readings:{" "}
          {[...unknownKanji].join(", ")}
        </div>
      )}
      {showLink && (
        <a href={`/stories/${story.id}`} className="story-link">
          View full story
        </a>
      )}
    </div>
  );
}
