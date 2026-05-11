import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useKnownKanji } from "../contexts/KanjiContext";
import { useDictionary } from "../contexts/DictionaryContext";
import { useWordIndexBackfill } from "../contexts/WordIndexBackfillContext";
import { getStoryWordEncounters } from "../api/client";
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
import type { Story, StoryWordThreads, WordThread } from "../types";
import "./StoryDisplay.css";

interface Props {
  story: Story;
  showLink?: boolean;
}

export default function StoryDisplay({ story, showLink }: Props) {
  const { knownKanji, knownKanjiLoaded } = useKnownKanji();
  const { state: dictState } = useDictionary();
  const { remaining: backfillRemaining, processing: backfillProcessing } =
    useWordIndexBackfill();
  // The popover's carousel pulls from `story_word_occurrences`, which is only
  // populated for stories that have been indexed. If this story hasn't been
  // indexed yet, or any indexing is still in flight, the carousel would be
  // missing cards — so we suppress taps entirely until the index is settled.
  const popoverDisabled =
    story.word_index_at === null ||
    backfillProcessing ||
    backfillRemaining > 0;
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

  // Close any open popover if indexing kicks in mid-view (e.g., the user is
  // reading and a freshly-generated story enters the backfill queue).
  useEffect(() => {
    if (popoverDisabled) setActiveTap(null);
  }, [popoverDisabled]);

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
  // Stale results are filtered out by an object-identity check on `source`
  // rather than a synchronous reset.
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

  // Hold off rendering until kuromoji + JMdict have produced merged
  // word-shaped tap targets — char-level baseline buttons reflow noticeably
  // when the merged spans swap in, which is jarring. On dict load failure
  // fall back to the baseline so the story stays readable (just without
  // word-level taps).
  const paragraphs: DisplayParagraph[] | null =
    groupedState?.source === baseParagraphs
      ? groupedState.paragraphs
      : dictState === "error"
        ? baseParagraphs
        : null;

  // Per-span encounter counts so we can mark zero-encounter spans as new
  // (accent underline). Fetched after the story is indexed; absent spans
  // (not yet indexed, or hit an error) leave the word untreated. Refetched
  // when the backfill stops processing so a freshly-indexed story picks
  // up its underlines without a reload.
  const [encounters, setEncounters] = useState<Map<string, number>>(
    () => new Map()
  );
  useEffect(() => {
    if (story.word_index_at === null) {
      setEncounters(new Map());
      return;
    }
    let cancelled = false;
    getStoryWordEncounters(story.id)
      .then((m) => {
        if (!cancelled) setEncounters(m);
      })
      .catch(() => {
        if (!cancelled) setEncounters(new Map());
      });
    return () => {
      cancelled = true;
    };
    // `read_count` triggers a refetch when the user hits the read button —
    // marking a story read changes its read_count weighting and most of
    // its words flip from zero-encounter (new-underlined) to seen.
  }, [story.id, story.word_index_at, story.read_count, backfillProcessing]);

  const unknownKanji = useMemo(() => {
    if (!knownKanjiLoaded) return new Set<string>();
    return getUnknownKanji(cleanContent, knownKanji);
  }, [cleanContent, knownKanji, knownKanjiLoaded]);

  const handleWordClick = (
    e: React.MouseEvent<HTMLButtonElement>,
    start: number,
    end: number
  ) => {
    e.stopPropagation();
    if (popoverDisabled) return;
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

  // Spans whose headword has zero global encounters get the accent underline.
  // Missing entries (span not in the index yet, indexing pending, or the
  // headword lookup miss) read as undefined and are left untreated.
  const isNew = (start: number, end: number): boolean =>
    encounters.get(`${start}-${end}`) === 0;

  const tokenClass = (start: number, end: number): string =>
    `word-token${isNew(start, end) ? " word-token--new" : ""}`;

  const renderPart = (part: SegmentPart, key: number) => {
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
          className={tokenClass(part.start, part.end)}
          data-offset={part.start}
          aria-label={part.surface}
          onClick={(e) => handleWordClick(e, part.start, part.end)}
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
          className={tokenClass(part.start, part.end)}
          data-offset={part.start}
          aria-label={part.surface}
          onClick={(e) => handleWordClick(e, part.start, part.end)}
        >
          {inner}
        </button>
      );
    }
    return (
      <button
        key={key}
        type="button"
        className={tokenClass(part.offset, part.offset + 1)}
        data-offset={part.offset}
        aria-label={part.char}
        onClick={(e) => handleWordClick(e, part.offset, part.offset + 1)}
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
      <div
        className={`story-content${popoverDisabled ? " story-content--popover-disabled" : ""}`}
      >
        {paragraphs === null ? (
          <div className="story-content__loading">Preparing story…</div>
        ) : (
          <div className="story-paragraphs">
            {paragraphs.map((para, pIdx) => (
              <p key={pIdx} className="story-paragraph">
                {para.sentences.map((sent) => (
                  <span key={sent.start} className="story-sentence">
                    {sent.parts.map((part, i) => renderPart(part, i))}
                  </span>
                ))}
              </p>
            ))}
          </div>
        )}
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
