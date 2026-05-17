import { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import { getAllKanji } from "../api/client";
import { useSeenKanji } from "../contexts/KanjiContext";
import { useVocab } from "../contexts/VocabContext";
import {
  getVocabBrowseEntriesSync,
  type VocabBrowseEntry,
} from "../lib/frequency";
import type { Kanji } from "../types";
import AnimatedDots from "./AnimatedDots";
import KanjiInlineDetail, { type KanjiRow } from "./KanjiInlineDetail";
import WordPopover from "./WordPopover";
import "./BrowseSection.css";

type Mode = "kanji" | "vocab";

// "default" keeps the natural order (kanji: grade then character; vocab: by
// JPDB rank window). The two read-based sorts each cycle asc⇄desc on re-click
// via a single chip.
type SortKey = "default" | "last-read" | "most-read";
type SortDir = "asc" | "desc";

type SeenFilter =
  | "all"
  | "seen"
  | "unseen"
  | "1-3"
  | "4-6"
  | "7-9"
  | "10+";

function matchesCountFilter(count: number, filter: SeenFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "seen":
      return count > 0;
    case "unseen":
      return count === 0;
    case "1-3":
      return count >= 1 && count <= 3;
    case "4-6":
      return count >= 4 && count <= 6;
    case "7-9":
      return count >= 7 && count <= 9;
    case "10+":
      return count >= 10;
  }
}

// A vocab entry's read count / last-read time sums (resp. maxes) over its
// candidate canonicals. JMdict can split one JPDB surface across several
// entries; only the canonical the indexer actually stamped carries
// encounters, the rest contribute 0 — so summing is exact, not double-count.
function entryCount(e: VocabBrowseEntry, counts: Map<string, number>): number {
  return e.canonicals.reduce((sum, c) => sum + (counts.get(c) ?? 0), 0);
}
function entryLastRead(e: VocabBrowseEntry, times: Map<string, number>): number {
  return e.canonicals.reduce((max, c) => Math.max(max, times.get(c) ?? 0), 0);
}

const JLPT_LEVELS = [5, 4, 3, 2, 1] as const;
const JLPT_UNCLASSIFIED = "unclassified";
type JlptFilter = (typeof JLPT_LEVELS)[number] | typeof JLPT_UNCLASSIFIED;

const GRADES = [1, 2, 3, 4, 5, 6, 8] as const;
type GradeFilter = (typeof GRADES)[number];

const VOCAB_WINDOW_SIZE = 100;
const VOCAB_MAX_RANK = 50000;
const VOCAB_WINDOW_COUNT = VOCAB_MAX_RANK / VOCAB_WINDOW_SIZE;

export default function BrowseSection() {
  const { kanjiExposures, kanjiLastRead } = useSeenKanji();
  const { vocabEncounters, vocabLastRead, vocabEncountersLoaded } = useVocab();

  const [mode, setMode] = useState<Mode>("kanji");
  const [seenFilter, setSeenFilter] = useState<SeenFilter>("all");
  const [jlptFilters, setJlptFilters] = useState<Set<JlptFilter>>(new Set());
  const [gradeFilters, setGradeFilters] = useState<Set<GradeFilter>>(new Set());
  const [vocabWindow, setVocabWindow] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("default");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

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
        if (!matchesCountFilter(c, seenFilter)) return false;
      }
      return true;
    });
    const byGrade = (a: Kanji, b: Kanji) =>
      a.grade - b.grade || a.character.localeCompare(b.character);
    if (sortKey === "default") {
      rows.sort(byGrade);
    } else {
      const mul = sortDir === "asc" ? 1 : -1;
      const metric = (k: Kanji) =>
        sortKey === "most-read"
          ? kanjiExposures.get(k.character) ?? 0
          : kanjiLastRead.get(k.character) ?? 0;
      // Grade/character stays the tiebreaker so unseen kanji (metric 0)
      // keep a stable, predictable order within the tie.
      rows.sort((a, b) => (metric(a) - metric(b)) * mul || byGrade(a, b));
    }
    return rows;
  }, [
    allKanji,
    jlptFilters,
    gradeFilters,
    seenFilter,
    kanjiExposures,
    kanjiLastRead,
    sortKey,
    sortDir,
  ]);

  const allVocabEntries = useMemo<VocabBrowseEntry[] | null>(() => {
    if (!vocabEncountersLoaded) return null;
    return getVocabBrowseEntriesSync().slice(0, VOCAB_MAX_RANK);
  }, [vocabEncountersLoaded]);

  // canonical → its browse entry across the WHOLE by-entry index (not just
  // the VOCAB_MAX_RANK rank-window cap), so the read-sorted mode (which
  // iterates vocabEncounters' canonical keys) can resolve any encountered
  // word back to its card. A canonical can ride several entries' `canonicals`
  // lists; the lowest-rank entry wins so the word shows at its most common
  // surface.
  const entryByCanonical = useMemo<Map<string, VocabBrowseEntry> | null>(() => {
    if (!vocabEncountersLoaded) return null;
    const m = new Map<string, VocabBrowseEntry>();
    for (const e of getVocabBrowseEntriesSync()) {
      for (const c of e.canonicals) {
        const prev = m.get(c);
        if (!prev || e.rank < prev.rank) m.set(c, e);
      }
    }
    return m;
  }, [vocabEncountersLoaded]);

  const visibleVocab = useMemo(() => {
    // Default sort: paginate the frequency index by the 100-rank window.
    if (sortKey === "default") {
      if (!allVocabEntries) return [];
      const startRank = vocabWindow * VOCAB_WINDOW_SIZE + 1;
      const endRank = startRank + VOCAB_WINDOW_SIZE - 1;
      const slice = allVocabEntries.filter(
        (e) => e.rank >= startRank && e.rank <= endRank
      );
      if (seenFilter === "all") return slice;
      return slice.filter((e) =>
        matchesCountFilter(entryCount(e, vocabEncounters), seenFilter)
      );
    }
    // Read-based sort: flat list of every word the user has encountered,
    // ordered by the metric. The rank window doesn't apply — the list is
    // bounded by read history, not by the 50k-card frequency slice. Several
    // canonicals can map to the same entry, so dedupe through a Set.
    if (!entryByCanonical) return [];
    const hits = new Set<VocabBrowseEntry>();
    for (const [canonical, count] of vocabEncounters) {
      if (count <= 0) continue;
      const e = entryByCanonical.get(canonical);
      if (e) hits.add(e);
    }
    let entries = [...hits];
    if (seenFilter !== "all") {
      entries = entries.filter((e) =>
        matchesCountFilter(entryCount(e, vocabEncounters), seenFilter)
      );
    }
    const mul = sortDir === "asc" ? 1 : -1;
    const metric = (e: VocabBrowseEntry) =>
      sortKey === "most-read"
        ? entryCount(e, vocabEncounters)
        : entryLastRead(e, vocabLastRead);
    entries.sort((a, b) => (metric(a) - metric(b)) * mul || a.rank - b.rank);
    return entries;
  }, [
    allVocabEntries,
    entryByCanonical,
    vocabWindow,
    seenFilter,
    vocabEncounters,
    vocabLastRead,
    sortKey,
    sortDir,
  ]);

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
  // A read-based chip activates at "desc" on first click, then flips
  // asc⇄desc on every re-click. "Default" just resets.
  const handleSort = (key: SortKey) => {
    if (key === "default") {
      setSortKey("default");
      setSortDir("desc");
    } else if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
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
              ["1-3", "1–3 reads"],
              ["4-6", "4–6 reads"],
              ["7-9", "7–9 reads"],
              ["10+", "10+ reads"],
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
      <div className="filter-row">
        <label>Sort</label>
        <div className="chip-group" aria-label="Sort">
          {(
            [
              ["default", "Default"],
              ["last-read", "Last read"],
              ["most-read", "Most read"],
            ] as const
          ).map(([key, label]) => {
            const active = sortKey === key;
            const directional = active && key !== "default";
            return (
              <button
                key={key}
                type="button"
                className={`chip ${active ? "active" : ""}`}
                onClick={() => handleSort(key)}
                aria-pressed={active}
                aria-label={
                  directional
                    ? `${label}, ${
                        sortDir === "desc" ? "descending" : "ascending"
                      }`
                    : label
                }
              >
                {label}
                {directional && (
                  <span className="browse-sort-arrow" aria-hidden="true">
                    {sortDir === "desc" ? "▼" : "▲"}
                  </span>
                )}
              </button>
            );
          })}
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
      ) : sortKey === "default" ? (
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
      ) : null}

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
            const count = entryCount(v, vocabEncounters);
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
        open={activeHeadword !== null}
        onOpenChange={(open) => {
          if (!open) setActiveHeadword(null);
        }}
      />
    </section>
  );
}

function KanjiModal({ kanji, onClose }: { kanji: Kanji; onClose: () => void }) {
  const initialRow: KanjiRow = {
    character: kanji.character,
    grade: kanji.grade,
    jlpt: kanji.jlpt,
    meanings: kanji.meanings,
    readings_on: kanji.readings_on,
    readings_kun: kanji.readings_kun,
  };

  return (
    <Modal open={true} onClose={onClose} className="browse-modal">
      <div className="browse-modal-body">
        <KanjiInlineDetail
          char={kanji.character}
          initialRow={initialRow}
          onBack={onClose}
        />
      </div>
    </Modal>
  );
}
