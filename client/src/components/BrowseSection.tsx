import { useEffect, useMemo, useState } from "react";
import {
  FloatingPortal,
  FloatingOverlay,
  FloatingFocusManager,
  useFloating,
  useDismiss,
  useRole,
  useInteractions,
} from "@floating-ui/react";
import { getAllKanji } from "../api/client";
import { useSeenKanji } from "../contexts/KanjiContext";
import { useVocab } from "../contexts/VocabContext";
import {
  getFrequencyEntriesSync,
  type FrequencyEntry,
} from "../lib/frequency";
import type { Kanji } from "../types";
import AnimatedDots from "./AnimatedDots";
import KanjiInlineDetail, { type KanjiRow } from "./KanjiInlineDetail";
import WordPopover from "./WordPopover";
import "./BrowseSection.css";

type Mode = "kanji" | "vocab";
type SeenFilter = "all" | "seen" | "unseen";

const JLPT_LEVELS = [5, 4, 3, 2, 1] as const;
const JLPT_UNCLASSIFIED = "unclassified";
type JlptFilter = (typeof JLPT_LEVELS)[number] | typeof JLPT_UNCLASSIFIED;

const GRADES = [1, 2, 3, 4, 5, 6, 8] as const;
type GradeFilter = (typeof GRADES)[number];

const VOCAB_WINDOW_SIZE = 100;
const VOCAB_MAX_RANK = 50000;
const VOCAB_WINDOW_COUNT = VOCAB_MAX_RANK / VOCAB_WINDOW_SIZE;

export default function BrowseSection() {
  const { kanjiExposures } = useSeenKanji();
  const { vocabEncounters, vocabEncountersLoaded } = useVocab();

  const [mode, setMode] = useState<Mode>("kanji");
  const [seenFilter, setSeenFilter] = useState<SeenFilter>("all");
  const [jlptFilters, setJlptFilters] = useState<Set<JlptFilter>>(new Set());
  const [gradeFilters, setGradeFilters] = useState<Set<GradeFilter>>(new Set());
  const [vocabWindow, setVocabWindow] = useState(0);

  const [allKanji, setAllKanji] = useState<Kanji[] | null>(null);
  const [kanjiError, setKanjiError] = useState<string | null>(null);

  const [activeKanji, setActiveKanji] = useState<Kanji | null>(null);
  const [activeHeadword, setActiveHeadword] = useState<{
    headword: string;
    el: HTMLElement;
  } | null>(null);

  useEffect(() => {
    if (mode !== "kanji" || allKanji !== null) return;
    let cancelled = false;
    getAllKanji()
      .then((rows) => {
        if (!cancelled) setAllKanji(rows);
      })
      .catch((err) => {
        if (!cancelled) setKanjiError(err.message ?? "Failed to load kanji");
      });
    return () => {
      cancelled = true;
    };
  }, [mode, allKanji]);

  const filteredKanji = useMemo(() => {
    if (!allKanji) return [];
    const jlptActive = jlptFilters.size > 0;
    const gradeActive = gradeFilters.size > 0;
    const rows = allKanji.filter((k) => {
      if (jlptActive) {
        const key = (k.jlpt ?? JLPT_UNCLASSIFIED) as JlptFilter;
        if (!jlptFilters.has(key)) return false;
      }
      if (gradeActive && !gradeFilters.has(k.grade as GradeFilter)) return false;
      if (seenFilter !== "all") {
        const c = kanjiExposures.get(k.character) ?? 0;
        if (seenFilter === "seen" && c <= 0) return false;
        if (seenFilter === "unseen" && c > 0) return false;
      }
      return true;
    });
    // Sort by grade ASC, then character.
    rows.sort((a, b) => a.grade - b.grade || a.character.localeCompare(b.character));
    return rows;
  }, [allKanji, jlptFilters, gradeFilters, seenFilter, kanjiExposures]);

  const allFrequencyEntries = useMemo<FrequencyEntry[] | null>(() => {
    if (!vocabEncountersLoaded) return null;
    return getFrequencyEntriesSync().slice(0, VOCAB_MAX_RANK);
  }, [vocabEncountersLoaded]);

  const visibleVocab = useMemo(() => {
    if (!allFrequencyEntries) return [];
    const startRank = vocabWindow * VOCAB_WINDOW_SIZE + 1;
    const endRank = startRank + VOCAB_WINDOW_SIZE - 1;
    const slice = allFrequencyEntries.filter(
      (e) => e.rank >= startRank && e.rank <= endRank
    );
    if (seenFilter === "seen") {
      return slice.filter((e) => (vocabEncounters.get(e.headword) ?? 0) > 0);
    }
    if (seenFilter === "unseen") {
      return slice.filter((e) => (vocabEncounters.get(e.headword) ?? 0) === 0);
    }
    return slice;
  }, [allFrequencyEntries, vocabWindow, seenFilter, vocabEncounters]);

  const windowStartRank = vocabWindow * VOCAB_WINDOW_SIZE + 1;
  const windowEndRank = windowStartRank + VOCAB_WINDOW_SIZE - 1;

  const toggleJlpt = (v: JlptFilter) => {
    setJlptFilters((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  };
  const toggleGrade = (v: GradeFilter) => {
    setGradeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  };

  return (
    <section className="stats-section browse-section">
      <h2>Browse</h2>
      <div className="filter-row">
        <label>Mode</label>
        <div className="chip-group" role="radiogroup" aria-label="Browse mode">
          {(["kanji", "vocab"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`chip ${mode === m ? "active" : ""}`}
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
            >
              {m === "kanji" ? "Kanji" : "Vocab"}
            </button>
          ))}
        </div>
      </div>
      <div className="filter-row">
        <label>Show</label>
        <div className="chip-group" role="radiogroup" aria-label="Seen filter">
          {(
            [
              ["all", "All"],
              ["seen", "Seen only"],
              ["unseen", "Unseen only"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              className={`chip ${seenFilter === v ? "active" : ""}`}
              onClick={() => setSeenFilter(v)}
              aria-pressed={seenFilter === v}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {mode === "kanji" ? (
        <>
          <div className="filter-row">
            <label>JLPT</label>
            <div className="chip-group" aria-label="JLPT filter">
              {JLPT_LEVELS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`chip ${jlptFilters.has(n) ? "active" : ""}`}
                  onClick={() => toggleJlpt(n)}
                  aria-pressed={jlptFilters.has(n)}
                >
                  N{n}
                </button>
              ))}
              <button
                type="button"
                className={`chip ${
                  jlptFilters.has(JLPT_UNCLASSIFIED) ? "active" : ""
                }`}
                onClick={() => toggleJlpt(JLPT_UNCLASSIFIED)}
                aria-pressed={jlptFilters.has(JLPT_UNCLASSIFIED)}
              >
                Unclassified
              </button>
            </div>
          </div>
          <div className="filter-row">
            <label>Grade</label>
            <div className="chip-group" aria-label="Grade filter">
              {GRADES.map((g) => (
                <button
                  key={g}
                  type="button"
                  className={`chip ${gradeFilters.has(g) ? "active" : ""}`}
                  onClick={() => toggleGrade(g)}
                  aria-pressed={gradeFilters.has(g)}
                >
                  {g === 8 ? "Secondary" : g}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="filter-row browse-slider-row">
          <label htmlFor="vocab-window-slider">Range</label>
          <button
            type="button"
            className="browse-slider-step"
            onClick={() => setVocabWindow((w) => Math.max(0, w - 1))}
            disabled={vocabWindow === 0}
            aria-label="Previous 100"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10 3L5 8l5 5" />
            </svg>
          </button>
          <input
            id="vocab-window-slider"
            type="range"
            min={0}
            max={VOCAB_WINDOW_COUNT - 1}
            step={1}
            value={vocabWindow}
            onChange={(e) => setVocabWindow(Number(e.currentTarget.value))}
            className="browse-slider"
            aria-label="Vocab rank window"
          />
          <button
            type="button"
            className="browse-slider-step"
            onClick={() =>
              setVocabWindow((w) => Math.min(VOCAB_WINDOW_COUNT - 1, w + 1))
            }
            disabled={vocabWindow === VOCAB_WINDOW_COUNT - 1}
            aria-label="Next 100"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 3l5 5-5 5" />
            </svg>
          </button>
          <span className="browse-slider-value">
            #{windowStartRank.toLocaleString()}–
            {windowEndRank.toLocaleString()} /{" "}
            {VOCAB_MAX_RANK.toLocaleString()}
          </span>
        </div>
      )}

      {mode === "kanji" ? (
        kanjiError ? (
          <div className="browse-empty">{kanjiError}</div>
        ) : !allKanji ? (
          <div className="browse-empty">
            Loading kanji
            <AnimatedDots />
          </div>
        ) : filteredKanji.length === 0 ? (
          <div className="browse-empty">No kanji match these filters.</div>
        ) : (
          <ul className="browse-grid browse-grid--kanji">
            {filteredKanji.map((k) => {
              const count = kanjiExposures.get(k.character) ?? 0;
              const seen = count > 0;
              return (
                <li key={k.character}>
                  <button
                    type="button"
                    className={`browse-card browse-card--kanji${
                      seen ? " is-seen" : ""
                    }`}
                    onClick={() => setActiveKanji(k)}
                    title={k.meanings}
                  >
                    <span className="browse-kanji-char">{k.character}</span>
                    <span className="browse-kanji-meta">
                      {k.grade === 8 ? "Sec" : `G${k.grade}`}
                      {k.jlpt != null ? ` · N${k.jlpt}` : ""}
                    </span>
                    <span className="browse-kanji-count">
                      {count.toLocaleString()}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : !vocabEncountersLoaded ? (
        <div className="browse-empty">
          Loading vocab
          <AnimatedDots />
        </div>
      ) : visibleVocab.length === 0 ? (
        <div className="browse-empty">No vocab matches these filters.</div>
      ) : (
        <ol className="browse-grid browse-grid--vocab">
          {visibleVocab.map((v) => {
            const count = vocabEncounters.get(v.headword) ?? 0;
            const seen = count > 0;
            return (
              <li key={v.headword}>
                <button
                  type="button"
                  className={`browse-card browse-card--vocab${
                    seen ? " is-seen" : ""
                  }`}
                  onClick={(e) =>
                    setActiveHeadword({
                      headword: v.headword,
                      el: e.currentTarget,
                    })
                  }
                >
                  <span className="browse-vocab-rank">
                    #{v.rank.toLocaleString()}
                  </span>
                  <span className="browse-vocab-word">
                    <ruby>
                      {v.headword}
                      <rt>
                        {v.reading && v.reading !== v.headword
                          ? v.reading
                          : " "}
                      </rt>
                    </ruby>
                  </span>
                  <span className="browse-vocab-count">
                    {count.toLocaleString()} {count === 1 ? "read" : "reads"}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {activeKanji && (
        <KanjiModal
          kanji={activeKanji}
          onClose={() => setActiveKanji(null)}
        />
      )}

      <WordPopover
        mode={{
          kind: "headword",
          headword: activeHeadword?.headword ?? "",
        }}
        referenceEl={activeHeadword?.el ?? null}
        open={activeHeadword !== null}
        onOpenChange={(open) => {
          if (!open) setActiveHeadword(null);
        }}
      />
    </section>
  );
}

function KanjiModal({ kanji, onClose }: { kanji: Kanji; onClose: () => void }) {
  const handleOpenChange = (open: boolean) => {
    if (!open) onClose();
  };
  const { refs, context } = useFloating({
    open: true,
    onOpenChange: handleOpenChange,
  });
  const dismiss = useDismiss(context, { outsidePress: true });
  const role = useRole(context, { role: "dialog" });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  const initialRow: KanjiRow = {
    character: kanji.character,
    grade: kanji.grade,
    jlpt: kanji.jlpt,
    meanings: kanji.meanings,
    readings_on: kanji.readings_on,
    readings_kun: kanji.readings_kun,
  };

  return (
    <FloatingPortal>
      <FloatingOverlay className="browse-modal-backdrop" lockScroll>
        <FloatingFocusManager context={context} modal initialFocus={-1}>
          <div
            // refs.setFloating is a floating-ui ref-callback, not a React
            // useRef. The lint heuristic treats `refs.*` as a ref read but
            // it's safe here — same pattern WordPopover uses.
            // eslint-disable-next-line react-hooks/refs
            ref={refs.setFloating}
            className="browse-modal"
            {...getFloatingProps()}
          >
            <button
              type="button"
              className="browse-modal-close"
              onClick={onClose}
              aria-label="Close"
              title="Close"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M3 3l10 10" />
                <path d="M13 3L3 13" />
              </svg>
            </button>
            <div className="browse-modal-body">
              <KanjiInlineDetail
                char={kanji.character}
                initialRow={initialRow}
                onBack={onClose}
              />
            </div>
          </div>
        </FloatingFocusManager>
      </FloatingOverlay>
    </FloatingPortal>
  );
}
