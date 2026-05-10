import { useEffect, useMemo, useRef, useState } from "react";
import { useKnownKanji } from "../contexts/KanjiContext";
import { parseAnnotatedText, stripAnnotations } from "../lib/furigana";
import { stripBold, getUnknownKanji } from "../lib/text";
import { KANJI_REGEX } from "../lib/constants";
import {
  buildDisplaySegments,
  type DisplayParagraph,
  type SegmentPart,
} from "../lib/storySegments";
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
  const [wordThreads, setWordThreads] = useState<StoryWordThreads>(
    story.explanations ?? {}
  );
  const [activeTap, setActiveTap] = useState<{
    offset: number;
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

  const paragraphs: DisplayParagraph[] = useMemo(
    () => buildDisplaySegments(cleanContent, rubyAnnotations),
    [cleanContent, rubyAnnotations]
  );

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
    offset: number
  ) => {
    e.stopPropagation();
    cancelPendingSeek();
    setActiveTap({ offset, el: e.currentTarget });
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

  const renderPart = (
    part: SegmentPart,
    sentenceAudioIdx: number,
    key: number
  ) => {
    if (part.kind === "annotated") {
      const hasUnknown = [...part.surface].some(
        (ch) => KANJI_REGEX.test(ch) && unknownKanji.has(ch)
      );
      let showRuby = false;
      switch (furiganaState) {
        case "all":
          showRuby = true;
          break;
        case "unknown":
          showRuby = hasUnknown;
          break;
        case "none":
          showRuby = false;
          break;
      }
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
          key={key}
          type="button"
          className="word-token"
          data-offset={part.start}
          aria-label={part.surface}
          onClick={(e) => handleWordClick(e, sentenceAudioIdx)}
          onDoubleClick={(e) => handleWordDoubleClick(e, part.start)}
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
        onDoubleClick={(e) => handleWordDoubleClick(e, part.offset)}
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
        offset={activeTap?.offset ?? null}
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
