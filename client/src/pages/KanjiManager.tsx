import { useState, useEffect, useCallback } from "react";
import {
  getKanji,
  getKanjiStats,
  toggleKanji,
  bulkUpdateKanji,
} from "../api/client";
import type { Kanji, KanjiStats } from "../types";
import "./KanjiManager.css";

const JLPT_LEVELS = [5, 4, 3, 2, 1];
const GRADES = [1, 2, 3, 4, 5, 6, 8];
const GRADE_LABELS: Record<number, string> = {
  1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 8: "S",
};

export default function KanjiManager() {
  const [kanji, setKanji] = useState<Kanji[]>([]);
  const [stats, setStats] = useState<KanjiStats>({ total: 0, known: 0 });
  const [search, setSearch] = useState("");
  const [jlptFilter, setJlptFilter] = useState<number[]>([]);
  const [gradeFilter, setGradeFilter] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchKanji = useCallback(async () => {
    const params: Record<string, string> = {};
    if (search) params.search = search;
    if (jlptFilter.length > 0) params.jlpt = jlptFilter.join(",");
    if (gradeFilter.length > 0) params.grade = gradeFilter.join(",");
    const data = await getKanji(params);
    setKanji(data);
  }, [search, jlptFilter, gradeFilter]);

  const fetchStats = useCallback(async () => {
    const s = await getKanjiStats();
    setStats(s);
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchKanji(), fetchStats()]).finally(() => setLoading(false));
  }, [fetchKanji, fetchStats]);

  const handleToggle = async (character: string) => {
    const updated = await toggleKanji(character);
    setKanji((prev) =>
      prev.map((k) => (k.character === character ? updated : k))
    );
    setStats((prev) => {
      const wasKnown = kanji.find((k) => k.character === character)?.known;
      return {
        ...prev,
        known: wasKnown ? prev.known - 1 : prev.known + 1,
      };
    });
  };

  const handleBulk = async (action: "markKnown" | "markUnknown") => {
    const filter: { grades?: number[]; jlptLevels?: number[] } = {};
    if (gradeFilter.length > 0) filter.grades = gradeFilter;
    if (jlptFilter.length > 0) filter.jlptLevels = jlptFilter;
    await bulkUpdateKanji(action, filter);
    await Promise.all([fetchKanji(), fetchStats()]);
  };

  const toggleChip = (value: number, list: number[], setter: (v: number[]) => void) => {
    setter(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  };

  return (
    <div className="kanji-manager">
      <h1>Kanji Manager</h1>
      <div className="kanji-stats">
        You know <strong>{stats.known}</strong> / {stats.total} kanji
      </div>

      <div className="kanji-controls">
        <input
          type="text"
          className="search-input"
          placeholder="Search by character, meaning, or reading..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="filter-row">
          <label>JLPT</label>
          <div className="chip-group">
            {JLPT_LEVELS.map((n) => (
              <button
                key={n}
                className={`chip ${jlptFilter.includes(n) ? "active" : ""}`}
                onClick={() => toggleChip(n, jlptFilter, setJlptFilter)}
              >
                N{n}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-row">
          <label>Grade</label>
          <div className="chip-group">
            {GRADES.map((g) => (
              <button
                key={g}
                className={`chip ${gradeFilter.includes(g) ? "active" : ""}`}
                onClick={() => toggleChip(g, gradeFilter, setGradeFilter)}
              >
                {GRADE_LABELS[g]}
              </button>
            ))}
          </div>
        </div>

        <div className="bulk-actions">
          <button onClick={() => handleBulk("markKnown")}>
            Mark filtered as known
          </button>
          <button onClick={() => handleBulk("markUnknown")}>
            Mark filtered as unknown
          </button>
        </div>
      </div>

      {loading ? (
        <div className="loading">Loading kanji...</div>
      ) : (
        <div className="kanji-grid">
          {kanji.map((k) => (
            <button
              key={k.character}
              className={`kanji-cell ${k.known ? "known" : ""}`}
              onClick={() => handleToggle(k.character)}
              title={`${k.meanings}\nGrade ${k.grade}${k.jlpt ? ` | N${k.jlpt}` : ""}`}
            >
              <span className="kanji-char">{k.character}</span>
              <span className="kanji-meaning">
                {k.meanings.split(",")[0]}
              </span>
              <span className="kanji-badges">
                <span className="badge grade">G{GRADE_LABELS[k.grade] || k.grade}</span>
                {k.jlpt && <span className="badge jlpt">N{k.jlpt}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
