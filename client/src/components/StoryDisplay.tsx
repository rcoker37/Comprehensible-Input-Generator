import { useState, useEffect, useMemo } from "react";
import { useKnownKanji } from "../contexts/KanjiContext";
import { getFurigana, type FuriganaSegment } from "../lib/tokenizer";
import { parseAnnotatedText, stripAnnotations } from "../lib/furigana";
import { stripBold, getUnknownKanji } from "../lib/text";
import { KANJI_REGEX } from "../lib/constants";
import type { Story, StoryAudio } from "../types";
import "./StoryDisplay.css";

interface Props {
  story: Story;
  showLink?: boolean;
  audio?: StoryAudio | null;
  activeTokenIdx?: number;
  onTokenClick?: (i: number) => void;
}

export default function StoryDisplay({
  story,
  showLink,
  audio,
  activeTokenIdx = -1,
  onTokenClick,
}: Props) {
  const { knownKanji, knownKanjiLoaded } = useKnownKanji();
  const [paragraphs, setParagraphs] = useState<FuriganaSegment[][] | null>(null);

  const { cleanContent, annotations } = useMemo(() => {
    const raw = stripBold(story.content);
    const { cleanText, annotations } = parseAnnotatedText(raw);
    return { cleanContent: cleanText, annotations };
  }, [story.content]);

  const unknownKanji = useMemo(() => {
    if (!knownKanjiLoaded) return new Set<string>();
    return getUnknownKanji(cleanContent, knownKanji);
  }, [cleanContent, knownKanji, knownKanjiLoaded]);

  useEffect(() => {
    if (audio || unknownKanji.size === 0) {
      setParagraphs(null);
      return;
    }
    let cancelled = false;
    const parts = cleanContent.split("\n\n");

    let offset = 0;
    const perParagraph = parts.map((p) => {
      const start = offset;
      const end = offset + p.length;
      offset = end + 2;
      return annotations
        .filter((a) => a.start >= start && a.end <= end)
        .map((a) => ({ ...a, start: a.start - start, end: a.end - start }));
    });

    Promise.all(
      parts.map((p, i) => getFurigana(p, unknownKanji, perParagraph[i]))
    ).then((results) => {
      if (!cancelled) setParagraphs(results);
    });
    return () => {
      cancelled = true;
    };
  }, [cleanContent, annotations, unknownKanji, audio]);

  return (
    <div className="story-display">
      <div className="story-header">
        <h2 className="story-title">{stripAnnotations(stripBold(story.title))}</h2>
      </div>
      <div className="story-meta">
        <span className="type-tag">{story.content_type ?? "story"}</span>
        <span className="formality-tag">{story.formality}</span>
        {story.topic && <span className="topic-tag">{story.topic}</span>}
      </div>
      <div className="story-content">
        {audio ? (
          <div className="story-tokens">
            {audio.tokens.map((tok, i) => {
              const hasUnknown = [...tok.s].some(
                (ch) => KANJI_REGEX.test(ch) && unknownKanji.has(ch)
              );
              const showReading = hasUnknown && tok.r;
              return (
                <span
                  key={i}
                  className={`story-token${activeTokenIdx === i ? " active" : ""}`}
                  onClick={() => onTokenClick?.(i)}
                >
                  {showReading ? (
                    <ruby>
                      {tok.s}
                      <rt>{tok.r}</rt>
                    </ruby>
                  ) : (
                    tok.s
                  )}
                </span>
              );
            })}
          </div>
        ) : paragraphs ? (
          paragraphs.map((segs, i) => (
            <p key={i}>
              {segs.map((seg, j) =>
                seg.reading ? (
                  <ruby key={j}>
                    {seg.text}
                    <rt>{seg.reading}</rt>
                  </ruby>
                ) : (
                  <span key={j}>{seg.text}</span>
                )
              )}
            </p>
          ))
        ) : (
          cleanContent.split("\n\n").map((p, i) => <p key={i}>{p}</p>)
        )}
      </div>
      {unknownKanji.size > 0 && (
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
