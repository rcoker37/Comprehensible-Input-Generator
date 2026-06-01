import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { useSeenKanji } from "../contexts/KanjiContext";
import { useVocab } from "../contexts/VocabContext";
import { lookupWord } from "../lib/dictionary";
import {
  getVocabBrowseEntriesSync,
  type VocabBrowseEntry,
} from "../lib/frequency";
import AnimatedDots from "./AnimatedDots";
import "./KanjiInlineDetail.css";

export interface KanjiRow {
  character: string;
  grade: number;
  jlpt: number | null;
  meanings: string;
  readings_on: string;
  readings_kun: string;
}

type Filter = "all" | "seen";

interface WordExtras {
  meaning: string;
  reading: string | null;
}

// Cap the "All" universe to the top-50k JPDB ranks so opening a high-frequency
// kanji doesn't fan out into the unranked long tail.
const VOCAB_MAX_RANK = 50000;
const PAGE_SIZE = 50;

function entryCount(
  e: VocabBrowseEntry,
  counts: Map<string, number>
): number {
  return e.canonicals.reduce((sum, c) => sum + (counts.get(c) ?? 0), 0);
}

export default function KanjiInlineDetail({
  char,
  initialRow,
  onBack,
  onWordSelect,
}: {
  char: string;
  initialRow?: KanjiRow;
  onBack: () => void;
  onWordSelect?: (
    headword: string,
    entryId: number | null,
    reading: string | null
  ) => void;
}) {
  const [row, setRow] = useState<KanjiRow | null>(
    initialRow && initialRow.character === char ? initialRow : null
  );
  const [loading, setLoading] = useState(
    !(initialRow && initialRow.character === char)
  );
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [pageCount, setPageCount] = useState(1);
  const [extras, setExtras] = useState<Map<string, WordExtras>>(
    () => new Map()
  );

  const { kanjiExposures } = useSeenKanji();
  const { vocabEncounters, vocabEncountersLoaded } = useVocab();
  const kanjiEncounters = kanjiExposures.get(char) ?? 0;

  useEffect(() => {
    if (initialRow && initialRow.character === char) {
      /* eslint-disable react-hooks/set-state-in-effect -- resync on char/initialRow change */
      setRow(initialRow);
      setLoading(false);
      setError(null);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    supabase
      .from("kanji")
      .select("character, grade, jlpt, meanings, readings_on, readings_kun")
      .eq("character", char)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setError(error.message);
        else setRow(data as KanjiRow);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [char, initialRow]);

  // Reset extras + pager on kanji change; just the pager on filter change.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- reset on char change */
    setExtras(new Map());
    setPageCount(1);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [char]);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- reset on filter change */
    setPageCount(1);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [filter]);

  const matchingEntries = useMemo<VocabBrowseEntry[] | null>(() => {
    if (!vocabEncountersLoaded) return null;
    return getVocabBrowseEntriesSync().filter(
      (e) => e.rank <= VOCAB_MAX_RANK && e.headword.includes(char)
    );
  }, [char, vocabEncountersLoaded]);

  const filteredEntries = useMemo<VocabBrowseEntry[] | null>(() => {
    if (!matchingEntries) return null;
    if (filter === "all") return matchingEntries;
    return matchingEntries.filter(
      (e) => entryCount(e, vocabEncounters) > 0
    );
  }, [matchingEntries, filter, vocabEncounters]);

  const visibleCount = pageCount * PAGE_SIZE;
  const visibleEntries = useMemo<VocabBrowseEntry[]>(() => {
    if (!filteredEntries) return [];
    return filteredEntries.slice(0, visibleCount);
  }, [filteredEntries, visibleCount]);
  const hasMore =
    filteredEntries !== null && filteredEntries.length > visibleEntries.length;

  // Lazy meaning lookup: fetch only for entries currently in the rendered
  // slice that don't yet have extras. Re-runs when the slice grows or the
  // extras map changes; the early-return on no-missing keeps it cheap.
  useEffect(() => {
    if (visibleEntries.length === 0) return;
    const missing = visibleEntries.filter((e) => !extras.has(e.headword));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map(async (e) => {
        try {
          const results = await lookupWord(e.headword);
          const primary = results[0];
          if (!primary) {
            return [
              e.headword,
              { meaning: "", reading: e.reading },
            ] as const;
          }
          const reading = primary.r[0]?.ent ?? e.reading;
          const meaning =
            primary.s[0]?.g
              .map((g: { str: string }) => g.str)
              .join("; ") ?? "";
          return [e.headword, { meaning, reading }] as const;
        } catch {
          return [
            e.headword,
            { meaning: "", reading: e.reading },
          ] as const;
        }
      })
    ).then((results) => {
      if (cancelled) return;
      setExtras((prev) => {
        const next = new Map(prev);
        for (const [hw, data] of results) next.set(hw, data);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [visibleEntries, extras]);

  const meaningsDisplay = row?.meanings
    .split(/[,、]\s*/)
    .map((m) => m.trim())
    .filter(Boolean)
    .join(" · ");

  const readingsDisplay = [
    ...(row?.readings_on
      ? row.readings_on
          .split(/[,、]\s*/)
          .map((r) => r.trim())
          .filter(Boolean)
      : []),
    ...(row?.readings_kun
      ? row.readings_kun
          .split(/[,、]\s*/)
          .map((r) => r.trim())
          .filter(Boolean)
      : []),
  ].join(" · ");

  const gradeLabel = row ? (row.grade === 8 ? "GS" : `G${row.grade}`) : null;

  return (
    <div className="kanji-inline">
      <div className="kanji-inline__card">
        <div className="kanji-inline__tile">{char}</div>
        <div className="kanji-inline__info">
          {loading ? (
            <div className="kanji-inline__status">
              Loading
              <AnimatedDots />
            </div>
          ) : error ? (
            <div className="kanji-inline__error">{error}</div>
          ) : row ? (
            <>
              <div className="kanji-inline__meta-row">
                {gradeLabel && (
                  <span className="kanji-inline__grade-badge">{gradeLabel}</span>
                )}
                {row.jlpt != null && (
                  <span className="kanji-inline__jlpt-badge">N{row.jlpt}</span>
                )}
                <span className="kanji-inline__encounters">
                  {Math.round(kanjiEncounters).toLocaleString()} encounters
                </span>
              </div>
              {meaningsDisplay && (
                <div className="kanji-inline__meanings">{meaningsDisplay}</div>
              )}
              {readingsDisplay && (
                <div className="kanji-inline__readings">{readingsDisplay}</div>
              )}
            </>
          ) : null}
        </div>
        <button
          type="button"
          className="kanji-inline__close"
          onClick={onBack}
          aria-label="Back to word"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <line x1="1" y1="1" x2="11" y2="11" />
            <line x1="11" y1="1" x2="1" y2="11" />
          </svg>
        </button>
      </div>

      <div className="kanji-inline__words-section">
        <div className="kanji-inline__words-header">
          <div className="kanji-inline__words-heading">WORDS USING {char}</div>
          <div
            className="chip-group kanji-inline__words-chips"
            role="radiogroup"
            aria-label="Word filter"
          >
            {(
              [
                ["all", "All"],
                ["seen", "Seen"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={`chip ${filter === v ? "active" : ""}`}
                onClick={() => setFilter(v)}
                aria-pressed={filter === v}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {filteredEntries === null ? (
          <div className="kanji-inline__status kanji-inline__status--words">
            Loading
            <AnimatedDots />
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="kanji-inline__status kanji-inline__status--words">
            No words found.
          </div>
        ) : (
          <>
            <ul className="kanji-inline__word-list">
              {visibleEntries.map((e) => {
                const extra = extras.get(e.headword);
                const reading = extra?.reading ?? e.reading;
                const meaning = extra?.meaning ?? "";
                const encounters = entryCount(e, vocabEncounters);
                const unseen = encounters === 0;
                return (
                  <li
                    key={e.headword}
                    className={`kanji-inline__word-row${
                      unseen ? " is-unseen" : ""
                    }`}
                  >
                    <button
                      type="button"
                      className="kanji-inline__word-btn"
                      onClick={() =>
                        onWordSelect?.(e.headword, e.entryId, e.reading)
                      }
                      disabled={!onWordSelect}
                    >
                      <div className="kanji-inline__word-left">
                        {reading ? (
                          <ruby className="kanji-inline__word-headword">
                            {e.headword}
                            <rt>{reading}</rt>
                          </ruby>
                        ) : (
                          <span className="kanji-inline__word-headword">
                            {e.headword}
                          </span>
                        )}
                        {meaning && (
                          <span className="kanji-inline__word-meaning">
                            {meaning}
                          </span>
                        )}
                      </div>
                      <div className="kanji-inline__word-right">
                        <div className="kanji-inline__word-stats">
                          <span className="kanji-inline__word-rank">
                            #{e.rank.toLocaleString()}
                          </span>
                          <span className="kanji-inline__word-enc">
                            {Math.round(encounters)}×
                          </span>
                        </div>
                        <svg
                          className="kanji-inline__word-chevron"
                          width="8"
                          height="12"
                          viewBox="0 0 8 12"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M2 2l4 4-4 4" />
                        </svg>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
            {hasMore && (
              <button
                type="button"
                className="kanji-inline__show-more"
                onClick={() => setPageCount((p) => p + 1)}
              >
                Show more
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
