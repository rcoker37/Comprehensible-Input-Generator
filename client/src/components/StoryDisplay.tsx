import { useState, useEffect, useMemo } from "react";
import { useKnownKanji } from "../contexts/KanjiContext";
import { getFurigana, type FuriganaSegment } from "../lib/tokenizer";
import type { Story } from "../types";
import "./StoryDisplay.css";

const KANJI_REGEX = /[\u4e00-\u9faf\u3400-\u4dbf]/;

interface Props {
  story: Story;
  showLink?: boolean;
}

export default function StoryDisplay({ story, showLink }: Props) {
  const { knownKanji, knownKanjiLoaded } = useKnownKanji();
  const [paragraphs, setParagraphs] = useState<FuriganaSegment[][] | null>(null);

  // Compute the set of unknown kanji in this story
  const unknownKanji = useMemo(() => {
    if (!knownKanjiLoaded) return new Set<string>();
    const unknown = new Set<string>();
    for (const ch of story.content) {
      if (KANJI_REGEX.test(ch) && !knownKanji.has(ch)) {
        unknown.add(ch);
      }
    }
    return unknown;
  }, [story.content, knownKanji, knownKanjiLoaded]);

  useEffect(() => {
    if (unknownKanji.size === 0) {
      setParagraphs(null);
      return;
    }

    let cancelled = false;
    const parts = story.content.split("\n\n");
    Promise.all(parts.map((p) => getFurigana(p, unknownKanji))).then(
      (results) => {
        if (!cancelled) setParagraphs(results);
      }
    );
    return () => { cancelled = true; };
  }, [story.content, unknownKanji]);

  return (
    <div className="story-display">
      <h2 className="story-title">{story.title}</h2>
      <div className="story-meta">
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
          : story.content.split("\n\n").map((p, i) => <p key={i}>{p}</p>)}
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
