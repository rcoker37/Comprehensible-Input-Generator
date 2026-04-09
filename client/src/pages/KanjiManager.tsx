import { useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useKnownKanji } from "../contexts/KanjiContext";
import {
  getKanji,
  filterKanji,
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
  const { user } = useAuth();
  const [allKanji, setAllKanji] = useState<Kanji[]>([]);
  const [stats, setStats] = useState<KanjiStats>({ total: 0, known: 0 });
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [jlptFilter, setJlptFilter] = useState<number[]>([]);
  const [gradeFilter, setGradeFilter] = useState<number[]>([]);
  const [knownFilter, setKnownFilter] = useState<"all" | "known" | "unknown">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<Set<string>>(new Set());

  const userId = user!.id;
  const { refreshKnownKanji } = useKnownKanji();

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 150);
    return () => clearTimeout(id);
  }, [search]);

  const fetchAll = useCallback(async () => {
    const [data, s] = await Promise.all([getKanji(userId), getKanjiStats(userId)]);
    setAllKanji(data);
    setStats(s);
  }, [userId]);

  useEffect(() => {
    setLoading(true);
    fetchAll()
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load kanji"))
      .finally(() => setLoading(false));
  }, [fetchAll]);

  const kanji = useMemo(() => {
    const filtered = filterKanji(allKanji, {
      search: debouncedSearch || undefined,
      jlpt: jlptFilter.length > 0 ? jlptFilter : undefined,
      grade: gradeFilter.length > 0 ? gradeFilter : undefined,
    });
    if (knownFilter === "known") return filtered.filter((k) => k.known);
    if (knownFilter === "unknown") return filtered.filter((k) => !k.known);
    return filtered;
  }, [allKanji, debouncedSearch, jlptFilter, gradeFilter, knownFilter]);

  const handleToggle = async (character: string) => {
    const current = allKanji.find((k) => k.character === character);
    if (!current || toggling.has(character)) return;

    const newKnown = !current.known;

    // Optimistic update
    setAllKanji((prev) =>
      prev.map((k) => (k.character === character ? { ...k, known: newKnown } : k))
    );
    setStats((prev) => ({
      ...prev,
      known: newKnown ? prev.known + 1 : prev.known - 1,
    }));

    setToggling((prev) => new Set(prev).add(character));
    try {
      await toggleKanji(userId, character, current.known);
      refreshKnownKanji();
    } catch (err) {
      // Revert on failure
      setAllKanji((prev) =>
        prev.map((k) => (k.character === character ? { ...k, known: current.known } : k))
      );
      setStats((prev) => ({
        ...prev,
        known: current.known ? prev.known + 1 : prev.known - 1,
      }));
      setError(err instanceof Error ? err.message : "Failed to toggle kanji");
    } finally {
      setToggling((prev) => {
        const next = new Set(prev);
        next.delete(character);
        return next;
      });
    }
  };

  const handleBulk = async (action: "markKnown" | "markUnknown") => {
    try {
      const filter: { grades?: number[]; jlptLevels?: number[] } = {};
      if (gradeFilter.length > 0) filter.grades = gradeFilter;
      if (jlptFilter.length > 0) filter.jlptLevels = jlptFilter;
      await bulkUpdateKanji(userId, action, filter);
      await Promise.all([fetchAll(), refreshKnownKanji()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update kanji");
    }
  };

  const toggleChip = (value: number, list: number[], setter: (v: number[]) => void) => {
    setter(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  };

  return (
    <div className="kanji-manager">
      <h1>Kanji Manager</h1>
      {error && <div className="error">{error}</div>}
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
          <label>Status</label>
          <div className="chip-group" role="radiogroup" aria-label="Known status filter">
            {(["all", "known", "unknown"] as const).map((v) => (
              <button
                key={v}
                className={`chip ${knownFilter === v ? "active" : ""}`}
                onClick={() => setKnownFilter(v)}
                aria-pressed={knownFilter === v}
              >
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-row">
          <label>Grade</label>
          <div className="chip-group" role="group" aria-label="Grade filter">
            {GRADES.map((g) => (
              <button
                key={g}
                className={`chip ${gradeFilter.includes(g) ? "active" : ""}`}
                onClick={() => toggleChip(g, gradeFilter, setGradeFilter)}
                aria-pressed={gradeFilter.includes(g)}
              >
                {GRADE_LABELS[g]}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-row">
          <label>JLPT</label>
          <div className="chip-group" role="group" aria-label="JLPT filter">
            {JLPT_LEVELS.map((n) => (
              <button
                key={n}
                className={`chip ${jlptFilter.includes(n) ? "active" : ""}`}
                onClick={() => toggleChip(n, jlptFilter, setJlptFilter)}
                aria-pressed={jlptFilter.includes(n)}
              >
                N{n}
              </button>
            ))}
          </div>
        </div>

        <div className="bulk-actions">
          <button onClick={() => handleBulk("markKnown")}>
            Mark filtered as known
          </button>
          <button onClick={() => {
            if (window.confirm("Are you sure you want to mark all filtered kanji as unknown?")) {
              handleBulk("markUnknown");
            }
          }}>
            Mark filtered as unknown
          </button>
        </div>
      </div>

      {loading ? (
        <div className="loading">Loading kanji...</div>
      ) : kanji.length === 0 ? (
        <div className="empty">No kanji match your filters.</div>
      ) : (
        <div className="kanji-grid">
          {kanji.map((k) => (
            <button
              key={k.character}
              className={`kanji-cell ${k.known ? "known" : ""}${toggling.has(k.character) ? " toggling" : ""}`}
              onClick={() => handleToggle(k.character)}
              aria-label={`${k.character}: ${k.meanings}`}
              aria-pressed={k.known}
              title={`${k.meanings}\nGrade ${k.grade}${k.jlpt ? ` | N${k.jlpt}` : ""}`}
            >
              <span className="kanji-char">{k.character}</span>
              <span className="kanji-reading">
                {k.readings_on ? k.readings_on.split(",")[0].trim() : ""}
                {k.readings_on && k.readings_kun ? " " : ""}
                {k.readings_kun ? k.readings_kun.split(",")[0].trim() : ""}
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
