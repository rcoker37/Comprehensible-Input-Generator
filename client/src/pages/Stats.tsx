import { useMemo } from "react";
import { useKnownKanji } from "../contexts/KanjiContext";
import { useVocab } from "../contexts/VocabContext";
import { formatScore, totalScore } from "../lib/rarity";
import {
  TIER_MULTIPLIER,
  totalVocabScore,
  wordScore,
} from "../lib/vocabScore";
import { TIER_LABEL, type FrequencyTier } from "../lib/frequency";
import AnimatedDots from "../components/AnimatedDots";
import "./Stats.css";

const TIER_ORDER: FrequencyTier[] = [
  "very-common",
  "common",
  "uncommon",
  "rare",
  "very-rare",
];

const TOP_HEADWORDS = 25;

export default function Stats() {
  const { kanjiExposures, kanjiExposuresLoaded } = useKnownKanji();
  const { vocabEncounters, vocabEncountersLoaded } = useVocab();

  const kanjiTotal = useMemo(() => totalScore(kanjiExposures), [kanjiExposures]);
  const vocabTotal = useMemo(
    () => totalVocabScore(vocabEncounters),
    [vocabEncounters]
  );

  const tierBuckets = useMemo(() => {
    const buckets = new Map<
      FrequencyTier,
      { words: number; encounters: number; points: number }
    >();
    for (const tier of TIER_ORDER) {
      buckets.set(tier, { words: 0, encounters: 0, points: 0 });
    }
    for (const { encounters, tier } of vocabEncounters.values()) {
      const b = buckets.get(tier)!;
      b.words += 1;
      b.encounters += encounters;
      b.points += wordScore(encounters, tier);
    }
    return buckets;
  }, [vocabEncounters]);

  const topHeadwords = useMemo(() => {
    const arr = Array.from(vocabEncounters, ([headword, e]) => ({
      headword,
      encounters: e.encounters,
      tier: e.tier,
      points: wordScore(e.encounters, e.tier),
    }));
    arr.sort((a, b) => b.points - a.points);
    return arr.slice(0, TOP_HEADWORDS);
  }, [vocabEncounters]);

  const kanjiKnown = kanjiExposures.size;
  const kanjiSeenAtLeastOnce = useMemo(() => {
    let n = 0;
    for (const c of kanjiExposures.values()) if (c > 0) n += 1;
    return n;
  }, [kanjiExposures]);
  const totalKanjiExposures = useMemo(() => {
    let n = 0;
    for (const c of kanjiExposures.values()) n += c;
    return n;
  }, [kanjiExposures]);
  const totalVocabEncounters = useMemo(() => {
    let n = 0;
    for (const { encounters } of vocabEncounters.values()) n += encounters;
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
            <div className="coverage-value">{kanjiKnown.toLocaleString()}</div>
            <div className="coverage-label">Kanji marked known</div>
          </div>
          <div className="coverage-cell">
            <div className="coverage-value">{kanjiSeenAtLeastOnce.toLocaleString()}</div>
            <div className="coverage-label">Kanji actually read</div>
          </div>
          <div className="coverage-cell">
            <div className="coverage-value">{totalKanjiExposures.toLocaleString()}</div>
            <div className="coverage-label">Kanji exposures</div>
          </div>
          <div className="coverage-cell">
            <div className="coverage-value">{vocabEncounters.size.toLocaleString()}</div>
            <div className="coverage-label">Unique words seen</div>
          </div>
          <div className="coverage-cell">
            <div className="coverage-value">{totalVocabEncounters.toLocaleString()}</div>
            <div className="coverage-label">Word encounters</div>
          </div>
        </div>
      </section>

      <section className="stats-section">
        <h2>Vocab by frequency tier</h2>
        <table className="tier-table">
          <thead>
            <tr>
              <th>Tier</th>
              <th>Multiplier</th>
              <th className="num">Unique words</th>
              <th className="num">Encounters</th>
              <th className="num">Points</th>
            </tr>
          </thead>
          <tbody>
            {TIER_ORDER.map((tier) => {
              const b = tierBuckets.get(tier)!;
              return (
                <tr key={tier}>
                  <td>{TIER_LABEL[tier]}</td>
                  <td>×{TIER_MULTIPLIER[tier]}</td>
                  <td className="num">{b.words.toLocaleString()}</td>
                  <td className="num">{b.encounters.toLocaleString()}</td>
                  <td className="num">{formatScore(b.points)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="stats-section">
        <h2>Top {Math.min(TOP_HEADWORDS, topHeadwords.length)} words by points</h2>
        {topHeadwords.length === 0 ? (
          <p className="empty">
            No vocab encounters yet. Mark some compositions as read to start
            building this list.
          </p>
        ) : (
          <table className="tier-table top-words-table">
            <thead>
              <tr>
                <th>Word</th>
                <th>Tier</th>
                <th className="num">Encounters</th>
                <th className="num">Points</th>
              </tr>
            </thead>
            <tbody>
              {topHeadwords.map((w) => (
                <tr key={w.headword}>
                  <td className="headword">{w.headword}</td>
                  <td>{TIER_LABEL[w.tier]}</td>
                  <td className="num">{w.encounters.toLocaleString()}</td>
                  <td className="num">{formatScore(w.points)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
