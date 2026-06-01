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
import AnimatedDots from "./AnimatedDots";
import type {
  DisplayMode,
  FontMode,
  Story,
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
  /** Headwords the user has tapped in this passage to mark for lookup. */
  markedHeadwords: Set<string>;
  /** Toggle a headword in the marked set. */
  onToggleMark: (headword: string) => void;
  /** Receives the loaded occurrence list so the parent can drive LookupsButton. */
  onOccurrencesChange?: (rows: StoryOccurrence[]) => void;
}

export default function StoryDisplay({
  story,
  showLink,
  regenerating = false,
  markedHeadwords,
  onToggleMark,
  onOccurrencesChange,
}: Props) {
  const { state: dictState } = useDictionary();
  const { profile, updatePreferences } = useAuth();
  const {
    remaining: backfillRemaining,
    processing: backfillProcessing,
  } = useWordIndexBackfill();
  const [furiganaMode, setFuriganaMode] = useState<DisplayMode>("unseen");
  const [showSavedLookups, setShowSavedLookups] = useState<boolean>(true);
  const [font, setFont] = useState<FontMode>("sans");

  // Hydrate the furigana / lookups / font controls from the persisted
  // `reader` preferences section exactly once.
  const readerSyncedRef = useRef(false);
  useEffect(() => {
    if (readerSyncedRef.current || !profile) return;
    readerSyncedRef.current = true;
    const reader = profile.preferences?.reader;
    /* eslint-disable react-hooks/set-state-in-effect -- one-time sync from the
       async-resolved profile; state initializers run before the fetch lands. */
    if (reader?.furigana) setFuriganaMode(reader.furigana);
    if (typeof reader?.showSavedLookups === "boolean")
      setShowSavedLookups(reader.showSavedLookups);
    if (reader?.font === "serif" || reader?.font === "sans") setFont(reader.font);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [profile]);

  const persistReader = (next: {
    furigana: DisplayMode;
    showSavedLookups: boolean;
    font: FontMode;
  }) => {
    updatePreferences({ reader: next }).catch((err) =>
      console.warn("Failed to save reader preferences:", err)
    );
  };
  const cycleFurigana = () => {
    setFuriganaMode((prev) => {
      const next = nextMode(prev);
      persistReader({ furigana: next, showSavedLookups, font });
      return next;
    });
  };
  const toggleShowSavedLookups = () => {
    setShowSavedLookups((prev) => {
      const next = !prev;
      persistReader({ furigana: furiganaMode, showSavedLookups: next, font });
      return next;
    });
  };
  const cycleFont = () => {
    setFont((prev) => {
      const next = nextFont(prev);
      persistReader({ furigana: furiganaMode, showSavedLookups, font: next });
      return next;
    });
  };

  const indexUnsettled =
    story.word_index_at === null ||
    backfillProcessing ||
    backfillRemaining > 0;

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
      onOccurrencesChange?.([]);
      return;
    }
    let cancelled = false;
    getStoryOccurrences(story.id)
      .then((rows) => {
        if (!cancelled) {
          setOccurrences(rows);
          onOccurrencesChange?.(rows);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOccurrences(null);
          onOccurrencesChange?.([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [story.id, story.word_index_at, backfillProcessing, onOccurrencesChange]);

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

  const showLoadingOverlay =
    hasBeenIndexed &&
    (paragraphs === null || regenerating || indexUnsettled);

  // Map of "start-end" → occurrence so each rendered span can resolve its
  // headword (for tap-toggle + highlight matching). Names are excluded so
  // they're not tappable — the popover can't show anything useful for them.
  const occurrenceBySpan = useMemo(() => {
    const map = new Map<string, StoryOccurrence>();
    if (!occurrences) return map;
    for (const o of occurrences) {
      if (o.isName || !o.headword) continue;
      map.set(`${o.start}-${o.end}`, o);
    }
    return map;
  }, [occurrences]);

  // "unseen" used to gate on encounter counts; with the encounter highlight
  // gone it now behaves the same as "all" — every word gets ruby. Only "off"
  // suppresses it.
  const showRubyForMode = furiganaMode !== "off";

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
        showRubyForMode ? (
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

  const tokenClass = (start: number, end: number): string => {
    const parts = ["word-token"];
    const occ = occurrenceBySpan.get(`${start}-${end}`);
    if (
      showSavedLookups &&
      occ &&
      markedHeadwords.has(occ.headword)
    ) {
      parts.push("word-token--saved-lookup");
    }
    return parts.join(" ");
  };

  const handleTap = (start: number, end: number) => {
    const occ = occurrenceBySpan.get(`${start}-${end}`);
    if (!occ) return;
    onToggleMark(occ.headword);
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
      const inner = showRubyForMode ? (
        <ruby>
          {part.surface}
          <rt>{part.reading}</rt>
        </ruby>
      ) : (
        part.surface
      );
      const hasOccurrence = occurrenceBySpan.has(`${part.start}-${part.end}`);
      if (hasOccurrence) {
        return (
          <button
            type="button"
            key={key}
            className={tokenClass(part.start, part.end)}
            data-offset={part.start}
            onClick={() => handleTap(part.start, part.end)}
          >
            {inner}
          </button>
        );
      }
      return (
        <span
          key={key}
          className={tokenClass(part.start, part.end)}
          data-offset={part.start}
        >
          {inner}
        </span>
      );
    }
    if (part.kind === "word") {
      const inner =
        part.rubies && part.rubies.length > 0
          ? renderRubySegments(part.surface, part.start, part.rubies)
          : part.surface;
      const hasOccurrence = occurrenceBySpan.has(`${part.start}-${part.end}`);
      if (hasOccurrence) {
        return (
          <button
            type="button"
            key={key}
            className={tokenClass(part.start, part.end)}
            data-offset={part.start}
            onClick={() => handleTap(part.start, part.end)}
          >
            {inner}
          </button>
        );
      }
      return (
        <span
          key={key}
          className={tokenClass(part.start, part.end)}
          data-offset={part.start}
        >
          {inner}
        </span>
      );
    }
    // CharPart — never a dictionary word; render as inert text.
    if (isPunctuation(part.char)) {
      return <span key={key}>{part.char}</span>;
    }
    return (
      <span
        key={key}
        className={tokenClass(part.offset, part.offset + 1)}
        data-offset={part.offset}
      >
        {part.char}
      </span>
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
          showSavedLookups={showSavedLookups}
          font={font}
          onFuriganaCycle={cycleFurigana}
          onShowSavedLookupsToggle={toggleShowSavedLookups}
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
      {showLink && (
        <a href={`/stories/${story.id}`} className="story-link">
          View full story
        </a>
      )}
    </div>
  );
}
