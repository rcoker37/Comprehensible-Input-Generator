import { useState, useEffect, useMemo } from "react";
import { useKnownKanji } from "../contexts/KanjiContext";
import { getFurigana, type FuriganaSegment } from "../lib/tokenizer";
import { stripBold, getUnknownKanji } from "../lib/text";
import type { Story } from "../types";
import "./StoryDisplay.css";

interface Props {
  story: Story;
  showLink?: boolean;
}

export default function StoryDisplay({ story, showLink }: Props) {
  const { knownKanji, knownKanjiLoaded } = useKnownKanji();
  const [paragraphs, setParagraphs] = useState<FuriganaSegment[][] | null>(null);

  const content = useMemo(() => stripBold(story.content), [story.content]);

  const unknownKanji = useMemo(() => {
    if (!knownKanjiLoaded) return new Set<string>();
    return getUnknownKanji(content, knownKanji);
  }, [content, knownKanji, knownKanjiLoaded]);

  useEffect(() => {
    if (unknownKanji.size === 0) {
      setParagraphs(null);
      return;
    }

    let cancelled = false;
    const parts = content.split("\n\n");
    Promise.all(parts.map((p) => getFurigana(p, unknownKanji))).then(
      (results) => {
        if (!cancelled) setParagraphs(results);
      }
    );
    return () => { cancelled = true; };
  }, [content, unknownKanji]);

  return (
    <div className="story-display">
      <h2 className="story-title">{stripBold(story.title)}</h2>
      <div className="story-meta">
        <span className="type-tag">{story.content_type ?? "story"}</span>
        <span className="formality-tag">{story.formality}</span>
        {story.topic && <span className="topic-tag">{story.topic}</span>}
      </div>
      <div className="story-content">
        {paragraphs
          ? paragraphs.map((segs, i) => (
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
          : content.split("\n\n").map((p, i) => <p key={i}>{p}</p>)}
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
