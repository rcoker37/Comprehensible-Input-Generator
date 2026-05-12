import { useMemo } from "react";
import { useSeenKanji } from "../contexts/KanjiContext";
import { useVocab } from "../contexts/VocabContext";
import { formatScore, totalScore } from "../lib/rarity";
import { totalVocabScore } from "../lib/vocabScore";
import AnimatedDots from "../components/AnimatedDots";
import "./Stats.css";

export default function Stats() {
  const { kanjiExposures, kanjiExposuresLoaded } = useSeenKanji();
  const { vocabEncounters, vocabEncountersLoaded, getWordRank } = useVocab();

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
    for (const c of vocabEncounters.values()) if (c >= 10) n += 1;
    return n;
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
          <div className="coverage-cell">
            <div className="coverage-value">{vocabAtCap.toLocaleString()}</div>
            <div className="coverage-label">Words read 10+ times</div>
          </div>
        </div>
      </section>
    </div>
  );
}
