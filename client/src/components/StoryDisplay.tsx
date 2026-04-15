import { useState, useEffect, useMemo, useRef } from "react";
import { useKnownKanji } from "../contexts/KanjiContext";
import { getFurigana, type FuriganaSegment } from "../lib/tokenizer";
import { parseAnnotatedText, stripAnnotations } from "../lib/furigana";
import { stripBold, getUnknownKanji } from "../lib/text";
import { KANJI_REGEX } from "../lib/constants";
import type { Story, StoryAudio } from "../types";
import AudioPlayer, { type AudioPlayerHandle } from "./AudioPlayer";
import "./StoryDisplay.css";

interface Props {
  story: Story;
  showLink?: boolean;
}

export default function StoryDisplay({ story, showLink }: Props) {
  const { knownKanji, knownKanjiLoaded } = useKnownKanji();
  const [paragraphs, setParagraphs] = useState<FuriganaSegment[][] | null>(null);
  const [currentAudio, setCurrentAudio] = useState<StoryAudio | null>(story.audio);
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const playerRef = useRef<AudioPlayerHandle>(null);

  // LLM output contains Aozora ruby annotations like 二人《ふたり》. Parse them
  // out for both display (clean text only) and for authoritative readings
  // during TTS + furigana rendering.
  const { cleanContent, annotations } = useMemo(() => {
    const raw = stripBold(story.content);
    const { cleanText, annotations } = parseAnnotatedText(raw);
    return { cleanContent: cleanText, annotations };
  }, [story.content]);

  const unknownKanji = useMemo(() => {
    if (!knownKanjiLoaded) return new Set<string>();
    return getUnknownKanji(cleanContent, knownKanji);
  }, [cleanContent, knownKanji, knownKanjiLoaded]);

  // Keep local audio state in sync when the story prop changes (e.g. navigation).
  useEffect(() => {
    setCurrentAudio(story.audio);
    setActiveIdx(-1);
  }, [story.id, story.audio]);

  // Legacy furigana path: used only when we don't have audio tokens to render
  // from. Once audio exists, we render from audio.tokens (guaranteed aligned
  // with the playback timings) and skip this work.
  useEffect(() => {
    if (currentAudio || unknownKanji.size === 0) {
      setParagraphs(null);
      return;
    }
    let cancelled = false;
    const parts = cleanContent.split("\n\n");

    // Split annotations into per-paragraph buckets with offsets rebased to
    // each paragraph's local 0 position.
    let offset = 0;
    const perParagraph = parts.map((p) => {
      const start = offset;
      const end = offset + p.length;
      offset = end + 2; // account for the "\n\n" separator
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
  }, [cleanContent, annotations, unknownKanji, currentAudio]);

  return (
    <div className="story-display">
      <div className="story-header">
        <h2 className="story-title">{stripAnnotations(stripBold(story.title))}</h2>
        <AudioPlayer
          ref={playerRef}
          story={story}
          onAudioGenerated={setCurrentAudio}
          onActiveTokenChange={setActiveIdx}
        />
      </div>
      <div className="story-meta">
        <span className="type-tag">{story.content_type ?? "story"}</span>
        <span className="formality-tag">{story.formality}</span>
        {story.topic && <span className="topic-tag">{story.topic}</span>}
      </div>
      <div className="story-content">
        {currentAudio ? (
          <div className="story-tokens">
            {currentAudio.tokens.map((tok, i) => {
              const hasUnknown = [...tok.s].some(
                (ch) => KANJI_REGEX.test(ch) && unknownKanji.has(ch)
              );
              const showReading = hasUnknown && tok.r;
              return (
                <span
                  key={i}
                  className={`story-token${activeIdx === i ? " active" : ""}`}
                  onClick={() => playerRef.current?.seekToToken(i)}
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
