import { useMemo } from "react";
import { useKnownKanji } from "../contexts/KanjiContext";
import { useVocab } from "../contexts/VocabContext";
import { formatScore, totalScore } from "../lib/rarity";
import { totalVocabScore } from "../lib/vocabScore";
import AnimatedDots from "../components/AnimatedDots";
import "./Stats.css";

export default function Stats() {
  const { kanjiExposures, kanjiExposuresLoaded } = useKnownKanji();
  const { vocabEncounters, vocabEncountersLoaded } = useVocab();

  const kanjiTotal = useMemo(() => totalScore(kanjiExposures), [kanjiExposures]);
  const vocabTotal = useMemo(
    () => totalVocabScore(vocabEncounters),
    [vocabEncounters]
  );

  const kanjiKnown = kanjiExposures.size;
  const kanjiSeenAtLeastOnce = useMemo(() => {
    let n = 0;
    for (const c of kanjiExposures.values()) if (c > 0) n += 1;
    return n;
  }, [kanjiExposures]);

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
            <div className="coverage-value">{kanjiKnown.toLocaleString()}</div>
            <div className="coverage-label">Kanji marked known</div>
          </div>
          <div className="coverage-cell">
            <div className="coverage-value">{kanjiSeenAtLeastOnce.toLocaleString()}</div>
            <div className="coverage-label">Unique kanji read</div>
          </div>
          <div className="coverage-cell">
            <div className="coverage-value">{vocabEncounters.size.toLocaleString()}</div>
            <div className="coverage-label">Unique words read</div>
          </div>
        </div>
      </section>
    </div>
  );
}
