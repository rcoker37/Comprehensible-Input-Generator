import { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import { getAllKanji } from "../api/client";
import { useSeenKanji } from "../contexts/KanjiContext";
import type { Kanji } from "../types";
import AnimatedDots from "./AnimatedDots";
import KanjiInlineDetail, { type KanjiRow } from "./KanjiInlineDetail";
import WordPopover from "./WordPopover";
import "./BrowseSection.css";

// "default" keeps the natural grade-then-character order. The two read-based
// sorts each cycle asc⇄desc on re-click via a single chip.
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

const JLPT_LEVELS = [5, 4, 3, 2, 1] as const;
const JLPT_UNCLASSIFIED = "unclassified";
type JlptFilter = (typeof JLPT_LEVELS)[number] | typeof JLPT_UNCLASSIFIED;

const GRADES = [1, 2, 3, 4, 5, 6, 8] as const;
type GradeFilter = (typeof GRADES)[number];

export default function BrowseSection() {
  const { kanjiExposures, kanjiLastRead } = useSeenKanji();

  const [seenFilter, setSeenFilter] = useState<SeenFilter>("all");
  const [jlptFilters, setJlptFilters] = useState<Set<JlptFilter>>(new Set());
  const [gradeFilters, setGradeFilters] = useState<Set<GradeFilter>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("default");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const [allKanji, setAllKanji] = useState<Kanji[] | null>(null);
  const [kanjiError, setKanjiError] = useState<string | null>(null);

  const [activeKanji, setActiveKanji] = useState<Kanji | null>(null);
  const [activeHeadword, setActiveHeadword] = useState<{
    headword: string;
    entryId: number | null;
    reading: string | null;
  } | null>(null);

  useEffect(() => {
    if (allKanji !== null) return;
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
  }, [allKanji]);

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

      {kanjiError ? (
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
      )}

      {activeKanji && (
        <KanjiModal
          kanji={activeKanji}
          onClose={() => setActiveKanji(null)}
          onWordSelect={(headword, entryId, reading) => {
            setActiveKanji(null);
            setActiveHeadword({ headword, entryId, reading });
          }}
        />
      )}

      <WordPopover
        mode={{
          kind: "headword",
          headword: activeHeadword?.headword ?? "",
          entryId: activeHeadword?.entryId ?? null,
          reading: activeHeadword?.reading ?? null,
        }}
        open={activeHeadword !== null}
        onOpenChange={(open) => {
          if (!open) setActiveHeadword(null);
        }}
      />
    </section>
  );
}

function KanjiModal({
  kanji,
  onClose,
  onWordSelect,
}: {
  kanji: Kanji;
  onClose: () => void;
  onWordSelect: (
    headword: string,
    entryId: number | null,
    reading: string | null
  ) => void;
}) {
  const initialRow: KanjiRow = {
    character: kanji.character,
    grade: kanji.grade,
    jlpt: kanji.jlpt,
    meanings: kanji.meanings,
    readings_on: kanji.readings_on,
    readings_kun: kanji.readings_kun,
  };

  return (
    <Modal open={true} onClose={onClose} className="browse-modal" hideClose={true}>
      <div className="browse-modal-body">
        <KanjiInlineDetail
          char={kanji.character}
          initialRow={initialRow}
          onBack={onClose}
          onWordSelect={onWordSelect}
        />
      </div>
    </Modal>
  );
}
