import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useSeenKanji } from "../contexts/KanjiContext";
import { useVocab } from "../contexts/VocabContext";
import { getKanjiWords } from "../api/client";
import { lookupWord } from "../lib/dictionary";
import {
  lookupFrequencyByEntrySync,
  lookupFrequencyByCanonicalSync,
} from "../lib/frequency";
import { KANJI_REGEX } from "../lib/constants";
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

interface WordRow {
  headword: string;
  reading: string | null;
  meaning: string;
  rank: number | null;
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
  onWordSelect?: (headword: string, entryId: number | null) => void;
}) {
  const [row, setRow] = useState<KanjiRow | null>(
    initialRow && initialRow.character === char ? initialRow : null
  );
  const [loading, setLoading] = useState(
    !(initialRow && initialRow.character === char)
  );
  const [error, setError] = useState<string | null>(null);
  const [words, setWords] = useState<WordRow[]>([]);
  const [wordsLoading, setWordsLoading] = useState(true);

  const { kanjiExposures } = useSeenKanji();
  const { vocabEncounters } = useVocab();
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

  // Fetch words containing this kanji from the user's read stories. Encounter
  // counts are NOT stored here — they're read from vocabEncounters at render
  // time so this effect only re-runs when `char` changes, not on every vocab
  // context update.
  useEffect(() => {
    let cancelled = false;
    setWordsLoading(true);
    setWords([]);
    getKanjiWords(char)
      .then(async (kanjiWords) => {
        const resolved = await Promise.all(
          kanjiWords.map(async (w) => {
            let reading = w.reading;
            let meaning = "";
            try {
              const results = await lookupWord(w.headword);
              const primary = results[0];
              if (primary) {
                reading = primary.r[0]?.ent ?? reading;
                meaning =
                  primary.s[0]?.g
                    .map((g: { str: string }) => g.str)
                    .join("; ") ?? "";
              }
            } catch {
              // fall back to stored reading, no meaning
            }
            let rank: number | null = null;
            try {
              const freq =
                w.entryId !== null
                  ? lookupFrequencyByEntrySync(w.entryId)
                  : lookupFrequencyByCanonicalSync(w.headword);
              rank = freq?.rank ?? null;
            } catch {
              // frequency index not yet loaded
            }
            return { headword: w.headword, reading, meaning, rank };
          })
        );
        if (cancelled) return;
        resolved.sort((a, b) => {
          if (a.rank === null && b.rank === null) return 0;
          if (a.rank === null) return 1;
          if (b.rank === null) return -1;
          return a.rank - b.rank;
        });
        setWords(resolved);
        setWordsLoading(false);
      })
      .catch(() => {
        if (!cancelled) setWordsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [char]);

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
                  {kanjiEncounters.toLocaleString()} encounters
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
        <div className="kanji-inline__words-heading">WORDS USING {char}</div>
        {wordsLoading ? (
          <div className="kanji-inline__status kanji-inline__status--words">
            Loading
            <AnimatedDots />
          </div>
        ) : words.length === 0 ? (
          <div className="kanji-inline__status kanji-inline__status--words">
            No words found.
          </div>
        ) : (
          <ul className="kanji-inline__word-list">
            {words.map((w) => {
              const hasKanji = [...w.headword].some((ch) =>
                KANJI_REGEX.test(ch)
              );
              const encounters = vocabEncounters.get(w.headword) ?? 0;
              return (
                <li
                  key={w.headword}
                  className={`kanji-inline__word-row${onWordSelect ? " kanji-inline__word-row--clickable" : ""}`}
                  onClick={() => onWordSelect?.(w.headword, null)}
                  role={onWordSelect ? "button" : undefined}
                  tabIndex={onWordSelect ? 0 : undefined}
                  onKeyDown={onWordSelect ? (e) => { if (e.key === "Enter" || e.key === " ") onWordSelect(w.headword, null); } : undefined}
                >
                  <div className="kanji-inline__word-left">
                    {hasKanji && w.reading ? (
                      <ruby className="kanji-inline__word-headword">
                        {w.headword}
                        <rt>{w.reading}</rt>
                      </ruby>
                    ) : (
                      <span className="kanji-inline__word-headword">
                        {w.headword}
                      </span>
                    )}
                    {w.meaning && (
                      <span className="kanji-inline__word-meaning">
                        {w.meaning}
                      </span>
                    )}
                  </div>
                  <div className="kanji-inline__word-right">
                    <div className="kanji-inline__word-stats">
                      {w.rank !== null && (
                        <span className="kanji-inline__word-rank">
                          #{w.rank.toLocaleString()}
                        </span>
                      )}
                      <span className="kanji-inline__word-enc">
                        {encounters}×
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
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
