import { useState, useEffect, useMemo } from "react";
import { useKnownKanji } from "../contexts/KanjiContext";
import { tokenizeForAudio, type AudioToken } from "../lib/tokenizer";
import { parseAnnotatedText, stripAnnotations } from "../lib/furigana";
import { stripBold, getUnknownKanji } from "../lib/text";
import { KANJI_REGEX } from "../lib/constants";
import WordPopover from "./WordPopover";
import type {
  AnnotationExplanation,
  Story,
  StoryAudio,
  StoryExplanations,
} from "../types";
import "./StoryDisplay.css";

interface Props {
  story: Story;
  showLink?: boolean;
  audio?: StoryAudio | null;
  activeParagraphIdx?: number;
  onParagraphClick?: (i: number) => void;
}

interface DisplayToken extends AudioToken {
  offset: number;
}

interface DisplayParagraph {
  tokens: DisplayToken[];
}

/**
 * Walk the token stream, stamping char offsets and splitting into paragraphs
 * at any pure-whitespace token containing ≥2 newlines. The offsets line up
 * with the cleanText we tokenized, which is exactly what lookupAtCursor
 * expects when the user taps a span.
 *
 * When `dropTitleParagraph` is set, the first paragraph is dropped (it's the
 * title, which renders separately as an <h2>) and subsequent offsets are
 * rebased so they still match the content-only cleanText passed to
 * lookupAtCursor. This is the shape audio.tokens comes in — the TTS side
 * needs the title prefix to narrate it, but the display does not.
 */
function groupTokens(
  tokens: AudioToken[],
  dropTitleParagraph: boolean
): DisplayParagraph[] {
  const paragraphs: DisplayParagraph[] = [];
  let current: DisplayToken[] = [];
  let offset = 0;
  let base = 0;
  let dropped = !dropTitleParagraph;
  for (const tok of tokens) {
    const isSep =
      /^\s+$/.test(tok.s) && (tok.s.match(/\n/g)?.length ?? 0) >= 2;
    if (isSep) {
      if (!dropped) {
        current = [];
        offset += tok.s.length;
        base = offset;
        dropped = true;
        continue;
      }
      if (current.length > 0) paragraphs.push({ tokens: current });
      current = [];
      offset += tok.s.length;
      continue;
    }
    current.push({ ...tok, offset: offset - base });
    offset += tok.s.length;
  }
  if (current.length > 0) paragraphs.push({ tokens: current });
  return paragraphs;
}

export default function StoryDisplay({
  story,
  showLink,
  audio,
  activeParagraphIdx = -1,
  onParagraphClick,
}: Props) {
  const { knownKanji, knownKanjiLoaded } = useKnownKanji();
  const [paragraphs, setParagraphs] = useState<DisplayParagraph[] | null>(null);
  const [explanations, setExplanations] = useState<StoryExplanations>(
    story.explanations ?? {}
  );
  const [activeTap, setActiveTap] = useState<{
    offset: number;
    el: HTMLElement;
  } | null>(null);

  useEffect(() => {
    setExplanations(story.explanations ?? {});
  }, [story.explanations]);

  const { cleanContent, rubyAnnotations } = useMemo(() => {
    const raw = stripBold(story.content);
    const { cleanText, annotations } = parseAnnotatedText(raw);
    return { cleanContent: cleanText, rubyAnnotations: annotations };
  }, [story.content]);

  const unknownKanji = useMemo(() => {
    if (!knownKanjiLoaded) return new Set<string>();
    return getUnknownKanji(cleanContent, knownKanji);
  }, [cleanContent, knownKanji, knownKanjiLoaded]);

  // Prefer server-tokenized audio tokens when we have them — they're
  // guaranteed to align with the audio timing. Otherwise tokenize locally
  // from the clean text + ruby annotations.
  useEffect(() => {
    let cancelled = false;
    if (audio?.tokens && audio.tokens.length > 0) {
      setParagraphs(groupTokens(audio.tokens, true));
      return;
    }
    tokenizeForAudio(cleanContent, rubyAnnotations).then((tokens) => {
      if (!cancelled) setParagraphs(groupTokens(tokens, false));
    });
    return () => {
      cancelled = true;
    };
  }, [audio, cleanContent, rubyAnnotations]);

  const handleTokenClick = (
    e: React.MouseEvent<HTMLButtonElement>,
    offset: number
  ) => {
    e.stopPropagation();
    setActiveTap({ offset, el: e.currentTarget });
  };

  const handleExplanationCached = (
    key: string,
    explanation: AnnotationExplanation
  ) => {
    setExplanations((prev) => ({ ...prev, [key]: explanation }));
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
        {paragraphs ? (
          <div className="story-paragraphs">
            {paragraphs.map((para, pIdx) => {
              // When we render from audio tokens we drop the title paragraph,
              // so paragraph N in the display is paragraph N+1 in audio.paragraphs.
              const audioIdx =
                audio?.tokens && audio.tokens.length > 0 ? pIdx + 1 : pIdx;
              return (
              <p
                key={pIdx}
                className={`story-paragraph${
                  activeParagraphIdx === audioIdx ? " active" : ""
                }`}
                onClick={() => onParagraphClick?.(audioIdx)}
              >
                {para.tokens.map((tok) => {
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
                  return (
                    <button
                      key={tok.offset}
                      type="button"
                      className="word-token"
                      data-offset={tok.offset}
                      onClick={(e) => handleTokenClick(e, tok.offset)}
                    >
                      {inner}
                    </button>
                  );
                })}
              </p>
              );
            })}
          </div>
        ) : (
          cleanContent.split("\n\n").map((p, i) => <p key={i}>{p}</p>)
        )}
      </div>
      <WordPopover
        storyId={story.id}
        cleanText={cleanContent}
        offset={activeTap?.offset ?? null}
        explanations={explanations}
        referenceEl={activeTap?.el ?? null}
        open={activeTap !== null}
        onOpenChange={(open) => {
          if (!open) setActiveTap(null);
        }}
        onExplanationCached={handleExplanationCached}
      />
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
