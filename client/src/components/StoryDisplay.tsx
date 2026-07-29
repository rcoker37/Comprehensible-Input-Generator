import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDictionary } from "../contexts/DictionaryContext";
import { useWordIndexBackfill } from "../contexts/WordIndexBackfillContext";
import { useAuth } from "../contexts/AuthContext";
import { useVocab } from "../contexts/VocabContext";
import {
  getStoryOccurrences,
  type StoryOccurrence,
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
import ReaderControls from "./ReaderControls";
import WordPopover from "./WordPopover";
import AnimatedDots from "./AnimatedDots";
import {
  FURIGANA_UNSEEN_THRESHOLD,
  type DisplayMode,
  type FontMode,
  type SentenceTranslation,
  type Story,
  type StoryTranslations,
} from "../types";
import "./StoryDisplay.css";

const DISPLAY_ORDER: DisplayMode[] = ["off", "unseen", "all"];
const FONT_ORDER: FontMode[] = ["sans", "serif"];

const nextMode = (m: DisplayMode): DisplayMode =>
  DISPLAY_ORDER[(DISPLAY_ORDER.indexOf(m) + 1) % DISPLAY_ORDER.length]!;
const nextFont = (m: FontMode): FontMode =>
  FONT_ORDER[(FONT_ORDER.indexOf(m) + 1) % FONT_ORDER.length]!;

interface Props {
  story: Story;
  showLink?: boolean;
  // True when an external action (reset overrides, content edit) has
  // nulled the word index and the backfill is re-stamping it. Adds the
  // glassy loading overlay on top of the story text so the reader sees a
  // clear "not ready" signal while spans regroup.
  regenerating?: boolean;
}

export default function StoryDisplay({
  story,
  showLink,
  regenerating = false,
}: Props) {
  const { state: dictState } = useDictionary();
  const { profile, updatePreferences } = useAuth();
  const { vocabEncounters } = useVocab();
  const { currentStoryId: backfillCurrentStoryId } = useWordIndexBackfill();
  const [furiganaMode, setFuriganaMode] = useState<DisplayMode>("unseen");
  const [font, setFont] = useState<FontMode>("sans");

  // Hydrate the furigana / font controls from the persisted `reader`
  // preferences section exactly once.
  const readerSyncedRef = useRef(false);
  useEffect(() => {
    if (readerSyncedRef.current || !profile) return;
    readerSyncedRef.current = true;
    const reader = profile.preferences?.reader;
    /* eslint-disable react-hooks/set-state-in-effect -- one-time sync from the
       async-resolved profile; state initializers run before the fetch lands. */
    if (reader?.furigana) setFuriganaMode(reader.furigana);
    if (reader?.font === "serif" || reader?.font === "sans") setFont(reader.font);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [profile]);

  const persistReader = (next: {
    furigana: DisplayMode;
    font: FontMode;
  }) => {
    updatePreferences({ reader: next }).catch((err) =>
      console.warn("Failed to save reader preferences:", err)
    );
  };
  const cycleFurigana = () => {
    setFuriganaMode((prev) => {
      const next = nextMode(prev);
      persistReader({ furigana: next, font });
      return next;
    });
  };
  const cycleFont = () => {
    setFont((prev) => {
      const next = nextFont(prev);
      persistReader({ furigana: furiganaMode, font: next });
      return next;
    });
  };

  const [hasBeenIndexed, setHasBeenIndexed] = useState(
    story.word_index_at !== null
  );
  useEffect(() => {
    if (story.word_index_at !== null && !hasBeenIndexed) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- monotonic flip on first non-null word_index_at; subsequent renders short-circuit on `!hasBeenIndexed`.
      setHasBeenIndexed(true);
    }
  }, [story.word_index_at, hasBeenIndexed]);
  const firstIndexPending =
    story.word_index_at === null && !hasBeenIndexed;

  const { cleanContent, rubyAnnotations } = useMemo(() => {
    const raw = stripBold(story.content);
    const { cleanText, annotations } = parseAnnotatedText(raw);
    return { cleanContent: cleanText, rubyAnnotations: annotations };
  }, [story.content]);

  const { titleClean, titleAnnotations } = useMemo(() => {
    const raw = stripBold(story.title);
    const { cleanText, annotations } = parseAnnotatedText(raw);
    return { titleClean: cleanText, titleAnnotations: annotations };
  }, [story.title]);

  const titleBaseParagraphs: DisplayParagraph[] = useMemo(
    () => buildDisplaySegments(titleClean, titleAnnotations),
    [titleClean, titleAnnotations]
  );

  const [titleGroupedState, setTitleGroupedState] = useState<{
    source: DisplayParagraph[];
    paragraphs: DisplayParagraph[];
  } | null>(null);
  useEffect(() => {
    if (dictState !== "ready") return;
    let cancelled = false;
    regroupWords(titleBaseParagraphs, titleClean, titleAnnotations).then(
      (res) => {
        if (!cancelled) {
          setTitleGroupedState({
            source: titleBaseParagraphs,
            paragraphs: res,
          });
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [titleBaseParagraphs, titleClean, titleAnnotations, dictState]);

  const titleParagraphs: DisplayParagraph[] | null = useMemo(() => {
    if (titleGroupedState?.source === titleBaseParagraphs) {
      return titleGroupedState.paragraphs;
    }
    if (dictState === "error") return titleBaseParagraphs;
    return null;
  }, [titleGroupedState, titleBaseParagraphs, dictState]);

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

  const [occurrences, setOccurrences] = useState<StoryOccurrence[] | null>(
    null
  );
  useEffect(() => {
    if (story.word_index_at === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOccurrences(null);
      return;
    }
    let cancelled = false;
    getStoryOccurrences(story.id)
      .then((rows) => {
        if (!cancelled) setOccurrences(rows);
      })
      .catch(() => {
        if (!cancelled) setOccurrences(null);
      });
    return () => {
      cancelled = true;
    };
  }, [story.id, story.word_index_at, backfillCurrentStoryId]);

  const paragraphs: DisplayParagraph[] | null = useMemo(() => {
    const base =
      groupedState?.source === baseParagraphs
        ? groupedState.paragraphs
        : dictState === "error"
          ? baseParagraphs
          : null;
    if (!base) return null;
    if (occurrences && occurrences.length > 0) {
      return applyOccurrences(base, occurrences, cleanContent, rubyAnnotations);
    }
    return base;
  }, [
    groupedState,
    baseParagraphs,
    dictState,
    occurrences,
    cleanContent,
    rubyAnnotations,
  ]);

  const displayParagraphs = paragraphs ?? baseParagraphs;

  // Tap → WordPopover. The carousel pulls from `story_word_occurrences`, so
  // taps are blocked while *this* story is (re-)indexing — either it hasn't been
  // indexed yet (word_index_at null) or the backfill is actively processing it.
  // A different story being indexed elsewhere in the queue must NOT block reading
  // here: this story's spans aren't going to reflow, so the carousel is complete.
  const popoverDisabled =
    story.word_index_at === null ||
    backfillCurrentStoryId === story.id;

  const showLoadingOverlay =
    hasBeenIndexed &&
    (paragraphs === null || regenerating || popoverDisabled);

  // Translation cache mirrored from server `stories.translations`. Local edits
  // bubble up via `onTranslationUpdated` and are written back to the DB by
  // WordPopover. Reset whenever the story prop changes (e.g. content edit).
  const [translations, setTranslations] = useState<StoryTranslations>(
    story.translations ?? {}
  );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTranslations(story.translations ?? {});
  }, [story.translations]);
  const handleTranslationUpdated = (
    rangeKey: string,
    translation: SentenceTranslation
  ) => {
    setTranslations((prev) => ({ ...prev, [rangeKey]: translation }));
  };

  // Map of "start-end" → occurrence so each tap can pass the indexer's
  // chosen headword / entry id / name flag / reading to the popover.
  const occurrenceBySpan = useMemo(() => {
    const map = new Map<string, StoryOccurrence>();
    if (!occurrences) return map;
    for (const o of occurrences) {
      if (!o.headword) continue;
      map.set(`${o.start}-${o.end}`, o);
    }
    return map;
  }, [occurrences]);

  // In "unseen" mode, ruby is gated per-word on the user's read-source
  // encounter count for the occurrence's headword. Off / all are global.
  // Spans with no headword (ungrouped char parts) default to showing ruby
  // when the mode is on — those aren't tracked in vocabEncounters.
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
  // Close the popover if taps become disabled mid-view.
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

  const renderTitlePart = (part: SegmentPart, key: number) => {
    if (part.kind === "annotated") {
      return (
        <ruby key={key}>
          {part.surface}
          <rt>{part.reading}</rt>
        </ruby>
      );
    }
    if (part.kind === "word") {
      if (part.rubies && part.rubies.length > 0) {
        const out: ReactNode[] = [];
        let cursor = 0;
        for (const r of part.rubies) {
          const relStart = r.start - part.start;
          const relEnd = r.end - part.start;
          if (relStart > cursor)
            out.push(part.surface.slice(cursor, relStart));
          out.push(
            <ruby key={relStart}>
              {part.surface.slice(relStart, relEnd)}
              <rt>{r.reading}</rt>
            </ruby>
          );
          cursor = relEnd;
        }
        if (cursor < part.surface.length)
          out.push(part.surface.slice(cursor));
        return <span key={key}>{out}</span>;
      }
      return <span key={key}>{part.surface}</span>;
    }
    return <span key={key}>{part.char}</span>;
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
    // CharPart — punctuation stays inert; other singletons are tappable so
    // standalone kanji / kana with no merge can still open a popover.
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

  return (
    <div className="story-display">
      <div className="story-header">
        <h2 className="story-title">
          {titleParagraphs === null
            ? titleClean
            : titleParagraphs.map((para, pIdx) => (
                <span key={pIdx} className="story-title-paragraph">
                  {para.sentences.map((sent) => (
                    <span key={sent.start} className="story-title-sentence">
                      {sent.parts.map((part, i) => renderTitlePart(part, i))}
                    </span>
                  ))}
                </span>
              ))}
        </h2>
      </div>
      <div className="story-meta">
        <ReaderControls
          furigana={furiganaMode}
          font={font}
          onFuriganaCycle={cycleFurigana}
          onFontCycle={cycleFont}
        />
      </div>
      <div className={`story-content story-content--font-${font}`}>
        {firstIndexPending ? (
          <div className="story-content__preparing">
            Preparing<AnimatedDots />
          </div>
        ) : (
          <>
            <div className="story-paragraphs">
              {displayParagraphs.map((para, pIdx) => (
                <p key={pIdx} className="story-paragraph">
                  {para.sentences.map((sent) => (
                    <span key={sent.start} className="story-sentence">
                      {sent.parts.map((part, i) => renderPart(part, i))}
                    </span>
                  ))}
                </p>
              ))}
            </div>
            {showLoadingOverlay && (
              <div
                className="story-content__loading-overlay"
                aria-hidden="true"
              />
            )}
          </>
        )}
      </div>
      <WordPopover
        mode={{
          kind: "tap",
          source: { kind: "story", storyId: story.id },
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
      {showLink && (
        <a href={`/stories/${story.id}`} className="story-link">
          View full story
        </a>
      )}
    </div>
  );
}
