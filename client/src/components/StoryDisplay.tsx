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
  getStoryWordEncounters,
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
import {
  loadFrequencyIndex,
  lookupFrequencyByCanonicalSync,
  lookupFrequencyByEntrySync,
  lookupFrequencySync,
  type FrequencyTier,
} from "../lib/frequency";
import ReaderControls from "./ReaderControls";
import AnimatedDots from "./AnimatedDots";
import type {
  DisplayMode,
  FontMode,
  HighlightMode,
  Story,
} from "../types";
import "./StoryDisplay.css";

// Toggle-cycle orders for the reader controls. Tapping advances to the
// next mode and wraps around. (DisplayMode/HighlightMode/FontMode live in
// ../types so they can be persisted in `profiles.preferences.reader`.)
const DISPLAY_ORDER: DisplayMode[] = ["off", "unseen", "all"];
const HIGHLIGHT_ORDER: HighlightMode[] = [
  "off",
  "frequency",
  "encounters",
  "fiveplus",
];
const FONT_ORDER: FontMode[] = ["sans", "serif"];

const nextMode = (m: DisplayMode): DisplayMode =>
  DISPLAY_ORDER[(DISPLAY_ORDER.indexOf(m) + 1) % DISPLAY_ORDER.length]!;
const nextHighlight = (m: HighlightMode): HighlightMode =>
  HIGHLIGHT_ORDER[(HIGHLIGHT_ORDER.indexOf(m) + 1) % HIGHLIGHT_ORDER.length]!;
const nextFont = (m: FontMode): FontMode =>
  FONT_ORDER[(FONT_ORDER.indexOf(m) + 1) % FONT_ORDER.length]!;

// Map an encounter count to the same 5-tier colour ramp the frequency
// view uses. 0 reads = the dark-red "very-rare" tier; 1–9 reads spread
// across the remaining four colours; 10+ returns null, so a well-worn
// word loses its underline entirely.
const encountersToTier = (n: number): FrequencyTier | null => {
  if (n <= 0) return "very-rare";
  if (n <= 2) return "rare";
  if (n <= 4) return "uncommon";
  if (n <= 6) return "common";
  if (n <= 9) return "very-common";
  return null;
};

// Migrate any legacy `reader.highlight` preference saved before the
// mode split (off/unseen/all → off/encounters/frequency).
const coerceHighlightMode = (raw: unknown): HighlightMode | null => {
  if (
    raw === "off" ||
    raw === "frequency" ||
    raw === "encounters" ||
    raw === "fiveplus"
  )
    return raw;
  if (raw === "all") return "frequency";
  if (raw === "unseen") return "encounters";
  return null;
};

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
  const {
    remaining: backfillRemaining,
    processing: backfillProcessing,
  } = useWordIndexBackfill();
  const [furiganaMode, setFuriganaMode] = useState<DisplayMode>("unseen");
  const [highlightMode, setHighlightMode] =
    useState<HighlightMode>("encounters");
  const [font, setFont] = useState<FontMode>("sans");

  // Hydrate the furigana / highlight / font controls from the persisted
  // `reader` preferences section exactly once, the way GenerationModal
  // hydrates the generator form from `preferences.generator`.
  const readerSyncedRef = useRef(false);
  useEffect(() => {
    if (readerSyncedRef.current || !profile) return;
    readerSyncedRef.current = true;
    const reader = profile.preferences?.reader;
    /* eslint-disable react-hooks/set-state-in-effect -- one-time sync from the
       async-resolved profile; state initializers run before the fetch lands. */
    if (reader?.furigana) setFuriganaMode(reader.furigana);
    const migrated = coerceHighlightMode(reader?.highlight);
    if (migrated) setHighlightMode(migrated);
    if (reader?.font === "serif" || reader?.font === "sans") setFont(reader.font);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [profile]);

  // Advance a control and persist the full `reader` section.
  // `update_preferences` does a shallow merge, so the section must be sent
  // in full.
  const persistReader = (next: {
    furigana: DisplayMode;
    highlight: HighlightMode;
    font: FontMode;
  }) => {
    updatePreferences({ reader: next }).catch((err) =>
      console.warn("Failed to save reader preferences:", err)
    );
  };
  const cycleFurigana = () => {
    setFuriganaMode((prev) => {
      const next = nextMode(prev);
      persistReader({ furigana: next, highlight: highlightMode, font });
      return next;
    });
  };
  const cycleHighlight = () => {
    setHighlightMode((prev) => {
      const next = nextHighlight(prev);
      persistReader({ furigana: furiganaMode, highlight: next, font });
      return next;
    });
  };
  const cycleFont = () => {
    setFont((prev) => {
      const next = nextFont(prev);
      persistReader({ furigana: furiganaMode, highlight: highlightMode, font: next });
      return next;
    });
  };

  // True while the word index for this story isn't fully settled — either
  // the story hasn't been indexed yet, or any backfill pass is still in
  // flight. Used to gate the loading overlay so visible reflow from the
  // regroup pass is hidden until spans stop moving.
  const indexUnsettled =
    story.word_index_at === null ||
    backfillProcessing ||
    backfillRemaining > 0;

  // Track whether this story has EVER been seen with word_index_at !== null.
  // Distinguishes "first-time indexing" (hide the body, show a preparing
  // placeholder so the freshly-generated text doesn't flash in before its
  // regrouped spans are ready) from "re-indexing an already-shown story"
  // (the user edited / hit reset — keep showing the body under the glassy
  // overlay so the text doesn't disappear).
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

  // Async regroup pass for the title (same pipeline as content). Falls back
  // to char-level taps if the dictionary errors out.
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

  // Indexed occurrences. When loaded for a fully indexed story, we prefer
  // these over the local regroup pass because they carry manual override
  // rows produced via `set_story_word_overrides` that the local regrouper
  // doesn't know about. Re-fetched when the backfill finishes processing
  // (a re-index just happened).
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
  }, [story.id, story.word_index_at, backfillProcessing]);

  // Merged word-shaped spans when ready; null while the kuromoji + JMdict
  // regroup pass is still running. The loading overlay covers any visual
  // reflow if we render the char-level baseline as a fallback.
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

  // Always have something to render so the glassy loading overlay has a
  // backdrop. Falls back to the char-level baseline before the regroup pass
  // completes; the overlay hides the reflow when merged spans swap in.
  const displayParagraphs = paragraphs ?? baseParagraphs;

  // Show the loading overlay only for "re-indexing an existing story" — the
  // regroup pass hasn't produced word-shaped spans, the parent signalled a
  // re-index is in flight, or the story hasn't been indexed / the backfill
  // queue isn't drained. First-time indexing hides the body entirely (see
  // firstIndexPending below), so the glassy overlay only appears on top of
  // text the user has already seen.
  const showLoadingOverlay =
    hasBeenIndexed &&
    (paragraphs === null || regenerating || indexUnsettled);

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
      // eslint-disable-next-line react-hooks/set-state-in-effect
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

  // JPDB frequency index — loaded once so new-word underlines can be tinted
  // by rarity tier to match the WordPopover frequency badge. Until it
  // resolves, `tierBySpan` stays empty and underlines fall back to the
  // accent colour.
  const [freqLoaded, setFreqLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadFrequencyIndex()
      .then(() => {
        if (!cancelled) setFreqLoaded(true);
      })
      .catch(() => {
        // Leave new-word underlines at the accent fallback.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Per-span rarity tier, resolved the same way the WordPopover badge is:
  // by JMdict entry id first (the indexer's chosen homophone), then the
  // canonical stamp surface, then a plain surface lookup. Names are skipped
  // — the popover shows a "Name" badge with no frequency, so their
  // underline stays the neutral accent colour.
  const tierBySpan = useMemo(() => {
    const map = new Map<string, FrequencyTier>();
    if (!freqLoaded || !occurrences) return map;
    for (const o of occurrences) {
      if (!o.headword || o.isName) continue;
      const byEntry =
        o.entryId !== null ? lookupFrequencyByEntrySync(o.entryId) : null;
      const tier =
        byEntry?.tier ??
        lookupFrequencyByCanonicalSync(o.headword)?.tier ??
        lookupFrequencySync(o.headword, null).tier;
      map.set(`${o.start}-${o.end}`, tier);
    }
    return map;
  }, [freqLoaded, occurrences]);

  // Resolve a display mode to a per-word (tap-target span) decision:
  //   all    — every word
  //   off    — nothing
  //   unseen — words whose headword has zero encounters across the user's
  //            read stories (new to the reader)
  // The "unseen" lookup falls back to false when the span isn't in the map
  // (unindexed story, indexing pending, or the headword lookup missed).
  const showForMode = (
    mode: DisplayMode,
    start: number,
    end: number
  ): boolean => {
    switch (mode) {
      case "all":
        return true;
      case "unseen":
        return encounters.get(`${start}-${end}`) === 0;
      case "off":
      default:
        return false;
    }
  };

  const decideShowRuby = (start: number, end: number): boolean =>
    showForMode(furiganaMode, start, end);

  // Split a merged WordPart's surface around its sub-annotations and render
  // ruby on the annotated sub-spans only. Used when the regroup pass merged
  // an AnnotatedPart with neighbouring chars (e.g. 「高《たか》」 + 「く」 →
  // one tap target rendering as `<ruby>高<rt>たか</rt></ruby>く`). Ruby
  // visibility is decided once for the whole word (the tap-target span),
  // not per sub-span.
  const renderRubySegments = (
    surface: string,
    surfaceStart: number,
    surfaceEnd: number,
    rubies: FuriganaAnnotation[]
  ): ReactNode[] => {
    const out: ReactNode[] = [];
    const showRuby = decideShowRuby(surfaceStart, surfaceEnd);
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

  // Resolve a span's underline tier for the active highlight mode.
  // Returns undefined when the span shouldn't be underlined at all.
  //   off        — nobody gets an underline.
  //   frequency  — every span underlined; tier = its JPDB rarity tier.
  //   encounters — tier derived from read-count of its headword (0 = dark
  //                red, 9 = green, 10+ unhighlighted). Skipped until the
  //                encounter map is available; we don't fall back to an
  //                accent underline because that'd visibly flash before
  //                the real colour lands.
  const highlightTier = (start: number, end: number): FrequencyTier | null => {
    if (highlightMode === "off") return null;
    if (highlightMode === "frequency") {
      return tierBySpan.get(`${start}-${end}`) ?? null;
    }
    const count = encounters.get(`${start}-${end}`);
    if (count === undefined) return null;
    return encountersToTier(count);
  };

  const tokenClass = (start: number, end: number): string => {
    const parts = ["word-token"];
    if (highlightMode === "fiveplus") {
      const count = encounters.get(`${start}-${end}`);
      if (count !== undefined && count >= 5) {
        parts.push("word-token--new");
        parts.push("word-token--fiveplus");
      }
    } else {
      const tier = highlightTier(start, end);
      if (tier) {
        parts.push("word-token--new");
        parts.push(`word-token--freq-${tier}`);
      }
    }
    return parts.join(" ");
  };

  // Title is inert text — no tap-to-lookup. Ruby renders when available.
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
      const inner = decideShowRuby(part.start, part.end) ? (
        <ruby>
          {part.surface}
          <rt>{part.reading}</rt>
        </ruby>
      ) : (
        part.surface
      );
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
          ? renderRubySegments(part.surface, part.start, part.end, part.rubies)
          : part.surface;
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
    // CharPart. Punctuation (commas, stops, brackets, middle dots, …) is
    // never a dictionary word — render it as inert text with no new-word
    // underline.
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
          highlight={highlightMode}
          font={font}
          onFuriganaCycle={cycleFurigana}
          onHighlightCycle={cycleHighlight}
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
