import { useState, useEffect, useMemo } from "react";
import { useKnownKanji } from "../contexts/KanjiContext";
import { getFurigana, type FuriganaSegment } from "../lib/tokenizer";
import { parseAnnotatedText, stripAnnotations } from "../lib/furigana";
import { stripBold, getUnknownKanji } from "../lib/text";
import { KANJI_REGEX } from "../lib/constants";
import WordPopover from "./WordPopover";
import type { AnnotationToken, Story, StoryAnnotations, StoryAudio } from "../types";
import "./StoryDisplay.css";

interface Props {
  story: Story;
  showLink?: boolean;
  audio?: StoryAudio | null;
  activeParagraphIdx?: number;
  onParagraphClick?: (i: number) => void;
}

function groupTokensByParagraph(tokens: AnnotationToken[]): AnnotationToken[][] {
  const paragraphs: AnnotationToken[][] = [[]];
  for (const tok of tokens) {
    if (/^\s+$/.test(tok.s) && (tok.s.match(/\n/g)?.length ?? 0) >= 2) {
      paragraphs.push([]);
      continue;
    }
    paragraphs[paragraphs.length - 1].push(tok);
  }
  return paragraphs.filter((p) => p.length > 0);
}

export default function StoryDisplay({
  story,
  showLink,
  audio,
  activeParagraphIdx = -1,
  onParagraphClick,
}: Props) {
  const { knownKanji, knownKanjiLoaded } = useKnownKanji();
  const [paragraphs, setParagraphs] = useState<FuriganaSegment[][] | null>(null);
  const [liveAnnotations, setLiveAnnotations] = useState<StoryAnnotations | null>(
    story.annotations
  );
  const [activeToken, setActiveToken] = useState<{
    token: AnnotationToken;
    el: HTMLElement;
  } | null>(null);

  useEffect(() => {
    setLiveAnnotations(story.annotations);
  }, [story.annotations]);

  const useAnnotations = liveAnnotations !== null;

  const { cleanContent, rubyAnnotations } = useMemo(() => {
    const raw = stripBold(story.content);
    const { cleanText, annotations } = parseAnnotatedText(raw);
    return { cleanContent: cleanText, rubyAnnotations: annotations };
  }, [story.content]);

  const unknownKanji = useMemo(() => {
    if (!knownKanjiLoaded) return new Set<string>();
    return getUnknownKanji(cleanContent, knownKanji);
  }, [cleanContent, knownKanji, knownKanjiLoaded]);

  const annotationParagraphs = useMemo(
    () => (liveAnnotations ? groupTokensByParagraph(liveAnnotations.tokens) : null),
    [liveAnnotations]
  );

  useEffect(() => {
    if (useAnnotations || audio?.paragraphs || unknownKanji.size === 0) {
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
      return rubyAnnotations
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
  }, [useAnnotations, cleanContent, rubyAnnotations, unknownKanji, audio]);

  const handleTokenClick = (
    e: React.MouseEvent<HTMLButtonElement>,
    token: AnnotationToken
  ) => {
    e.stopPropagation();
    setActiveToken({ token, el: e.currentTarget });
  };

  const handleExplanationCached = (tokenIdx: number, text: string) => {
    setLiveAnnotations((prev) =>
      prev
        ? {
            ...prev,
            explanations: {
              ...prev.explanations,
              [String(tokenIdx)]: { text, generated_at: new Date().toISOString() },
            },
          }
        : prev
    );
  };

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
        {useAnnotations && annotationParagraphs && liveAnnotations ? (
          <div className="story-paragraphs">
            {annotationParagraphs.map((paraTokens, pIdx) => (
              <p
                key={pIdx}
                className={`story-paragraph${activeParagraphIdx === pIdx ? " active" : ""}`}
                onClick={() => onParagraphClick?.(pIdx)}
              >
                {paraTokens.map((tok) => {
                  const hasUnknown = [...tok.s].some(
                    (ch) => KANJI_REGEX.test(ch) && unknownKanji.has(ch)
                  );
                  const showRuby = hasUnknown && tok.r;
                  const inner = showRuby ? (
                    <ruby>
                      {tok.s}
                      <rt>{tok.r}</rt>
                    </ruby>
                  ) : (
                    tok.s
                  );
                  if (tok.isContent) {
                    return (
                      <button
                        key={tok.idx}
                        type="button"
                        className="word-token"
                        onClick={(e) => handleTokenClick(e, tok)}
                      >
                        {inner}
                      </button>
                    );
                  }
                  return <span key={tok.idx}>{inner}</span>;
                })}
              </p>
            ))}
          </div>
        ) : audio?.paragraphs ? (
          <div className="story-paragraphs">
            {audio.paragraphs.map((para, pIdx) => {
              const nextStart = audio.paragraphs[pIdx + 1]?.start ?? audio.tokens.length;
              const paraTokens = audio.tokens.slice(para.start, nextStart);
              return (
                <p
                  key={pIdx}
                  className={`story-paragraph${activeParagraphIdx === pIdx ? " active" : ""}`}
                  onClick={() => onParagraphClick?.(pIdx)}
                >
                  {paraTokens.map((tok, i) => {
                    const hasUnknown = [...tok.s].some(
                      (ch) => KANJI_REGEX.test(ch) && unknownKanji.has(ch)
                    );
                    return hasUnknown && tok.r ? (
                      <ruby key={i}>
                        {tok.s}
                        <rt>{tok.r}</rt>
                      </ruby>
                    ) : (
                      <span key={i}>{tok.s}</span>
                    );
                  })}
                </p>
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
      {activeToken && liveAnnotations && (
        <WordPopover
          token={activeToken.token}
          storyId={story.id}
          annotations={liveAnnotations}
          referenceEl={activeToken.el}
          open={true}
          onOpenChange={(open) => {
            if (!open) setActiveToken(null);
          }}
          onExplanationCached={handleExplanationCached}
        />
      )}
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
