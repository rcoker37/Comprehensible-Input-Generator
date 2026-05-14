import { useMemo, useState } from "react";
import { useSeenKanji } from "../contexts/KanjiContext";
import { useVocab } from "../contexts/VocabContext";
import { formatScore, totalScore } from "../lib/rarity";
import { totalVocabScore } from "../lib/vocabScore";
import AnimatedDots from "../components/AnimatedDots";
import WordPopover from "../components/WordPopover";
import "./Stats.css";

const VOCAB_CAP_THRESHOLD = 10;

export default function Stats() {
  const { kanjiExposures, kanjiExposuresLoaded } = useSeenKanji();
  const { vocabEncounters, vocabEncountersLoaded, getWordRank } = useVocab();
  const [showVocabAtCap, setShowVocabAtCap] = useState(false);
  const [activeHeadword, setActiveHeadword] = useState<{
    headword: string;
    el: HTMLElement;
  } | null>(null);

  const kanjiTotal = useMemo(() => totalScore(kanjiExposures), [kanjiExposures]);
  const vocabTotal = useMemo(
    () => totalVocabScore(vocabEncounters, getWordRank),
    [vocabEncounters, getWordRank]
  );

  const kanjiSeenAtLeastOnce = useMemo(() => {
    let n = 0;
    for (const c of kanjiExposures.values()) if (c > 0) n += 1;
    return n;
  }, [kanjiExposures]);
  const kanjiAtCap = useMemo(() => {
    let n = 0;
    for (const c of kanjiExposures.values()) if (c >= 10) n += 1;
    return n;
  }, [kanjiExposures]);
  const vocabAtCap = useMemo(() => {
    let n = 0;
    for (const c of vocabEncounters.values()) if (c >= VOCAB_CAP_THRESHOLD) n += 1;
    return n;
  }, [vocabEncounters]);

  const topVocabAtCap = useMemo(() => {
    const rows: Array<[string, number]> = [];
    for (const [headword, count] of vocabEncounters) {
      if (count >= VOCAB_CAP_THRESHOLD) rows.push([headword, count]);
    }
    rows.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return rows;
  }, [vocabEncounters]);

  if (!kanjiExposuresLoaded || !vocabEncountersLoaded) {
    return (
      <div className="loading">
        Loading stats
        <AnimatedDots />
      </div>
    );
  }

  return (
    <div className="stats-page">
      <h1>Stats</h1>

      <section className="stats-section">
        <h2>Score</h2>
        <div className="score-grid">
          <div className="score-cell score-cell--total">
            <div className="score-value">{formatScore(kanjiTotal + vocabTotal)}</div>
            <div className="score-label">Total ★</div>
          </div>
          <div className="score-cell">
            <div className="score-value">{formatScore(kanjiTotal)}</div>
            <div className="score-label">Kanji</div>
          </div>
          <div className="score-cell">
            <div className="score-value">{formatScore(vocabTotal)}</div>
            <div className="score-label">Vocab</div>
          </div>
        </div>
      </section>

      <section className="stats-section">
        <h2>Coverage</h2>
        <div className="coverage-grid">
          <div className="coverage-cell">
            <div className="coverage-value">{kanjiSeenAtLeastOnce.toLocaleString()}</div>
            <div className="coverage-label">Unique kanji read</div>
          </div>
          <div className="coverage-cell">
            <div className="coverage-value">{vocabEncounters.size.toLocaleString()}</div>
            <div className="coverage-label">Unique words read</div>
          </div>
          <div className="coverage-cell">
            <div className="coverage-value">{kanjiAtCap.toLocaleString()}</div>
            <div className="coverage-label">Kanji read 10+ times</div>
          </div>
          <button
            type="button"
            className={`coverage-cell coverage-cell--button${
              showVocabAtCap ? " is-active" : ""
            }`}
            onClick={() => setShowVocabAtCap((s) => !s)}
            aria-expanded={showVocabAtCap}
            aria-controls="vocab-at-cap-list"
          >
            <div className="coverage-value">{vocabAtCap.toLocaleString()}</div>
            <div className="coverage-label">Words read 10+ times</div>
          </button>
        </div>
      </section>

      {showVocabAtCap && (
        <section className="stats-section" id="vocab-at-cap-list">
          <h2>Words read 10+ times</h2>
          {topVocabAtCap.length === 0 ? (
            <div className="vocab-list-empty">
              No words have been read 10 or more times yet.
            </div>
          ) : (
            <ol className="vocab-list">
              {topVocabAtCap.map(([headword, count]) => (
                <li key={headword}>
                  <button
                    type="button"
                    className="vocab-row"
                    onClick={(e) =>
                      setActiveHeadword({
                        headword,
                        el: e.currentTarget,
                      })
                    }
                  >
                    <span className="vocab-word">{headword}</span>
                    <span className="vocab-count">
                      {count.toLocaleString()} reads
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
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
    </div>
  );
}
