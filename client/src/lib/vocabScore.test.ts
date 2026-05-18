import { describe, it, expect } from "vitest";
import {
  VOCAB_SCALE,
  frequencyWeight,
  wordScore,
  totalVocabScore,
  vocabScoreDelta,
} from "./vocabScore";
import { rawScore } from "./rarity";

describe("frequencyWeight", () => {
  it("sits just under the peak for rank 1", () => {
    // The logistic asymptotes at PEAK_WEIGHT — rank 1 is very close but
    // not exactly equal to it.
    expect(frequencyWeight(1)).toBeGreaterThan(3.98);
    expect(frequencyWeight(1)).toBeLessThan(4.0);
  });

  it("stays well above the floor far past MID_RANK", () => {
    // The whole point of the log-rank curve: the tail no longer collapses.
    // Even at rank 1,000,000 the weight is comfortably off the floor.
    expect(frequencyWeight(1_000_000)).toBeGreaterThan(0.5);
    expect(frequencyWeight(1_000_000)).toBeLessThan(0.7);
  });

  it("returns exactly the floor for null (unranked)", () => {
    expect(frequencyWeight(null)).toBeCloseTo(0.5, 6);
  });

  it("clamps rank<1 to the same value as rank 1", () => {
    expect(frequencyWeight(0)).toBeCloseTo(frequencyWeight(1), 6);
  });

  it("decreases monotonically across the ranked range", () => {
    let prev = frequencyWeight(1);
    for (const r of [10, 100, 1000, 5000, 10000, 30000, 100000]) {
      const w = frequencyWeight(r);
      expect(w).toBeLessThan(prev);
      prev = w;
    }
  });

  it("hits the half-weight point at MID_RANK", () => {
    // At rank = MID_RANK the logistic sits exactly at (peak + floor) / 2.
    expect(frequencyWeight(10_000)).toBeCloseTo((4.0 + 0.5) / 2, 6);
  });

  it("matches the expected curve at sample ranks", () => {
    expect(frequencyWeight(1_000)).toBeCloseTo(3.42, 1);
    expect(frequencyWeight(5_000)).toBeCloseTo(2.67, 1);
    expect(frequencyWeight(20_000)).toBeCloseTo(1.83, 1);
    expect(frequencyWeight(50_000)).toBeCloseTo(1.36, 1);
  });

  it("keeps the long tail meaningfully above the floor", () => {
    // Rare vocabulary should still pay a non-trivial amount — the log-rank
    // curve's reason for being. Rank 50k is worth far more than the floor.
    expect(frequencyWeight(50_000)).toBeGreaterThan(2 * frequencyWeight(null));
  });
});

describe("wordScore", () => {
  it("returns 0 at c=0 regardless of rank", () => {
    expect(wordScore(0, 1)).toBe(0);
    expect(wordScore(0, 100_000)).toBe(0);
    expect(wordScore(0, null)).toBe(0);
  });

  it("equals rawScore × frequencyWeight × VOCAB_SCALE", () => {
    for (const c of [1, 3, 5, 10, 50]) {
      for (const rank of [1, 100, 5000, 100_000, null]) {
        expect(wordScore(c, rank)).toBeCloseTo(
          rawScore(c) * frequencyWeight(rank) * VOCAB_SCALE,
          6
        );
      }
    }
  });

  it("VOCAB_SCALE is 1/4 (vocab dialed back to balance against kanji)", () => {
    expect(VOCAB_SCALE).toBeCloseTo(1 / 4, 6);
  });

  it("weights common words more than rare ones at the same count", () => {
    expect(wordScore(5, 1)).toBeGreaterThan(wordScore(5, 100_000));
    expect(wordScore(5, 100)).toBeGreaterThan(wordScore(5, 30_000));
  });

  it("has diminishing marginal returns up to the cap", () => {
    let prev = wordScore(0, 1000);
    let prevDelta = Infinity;
    for (let c = 1; c <= 9; c++) {
      const s = wordScore(c, 1000);
      const delta = s - prev;
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThan(prevDelta);
      prev = s;
      prevDelta = delta;
    }
  });

  it("caps at c=10 — further encounters contribute nothing", () => {
    const cap = wordScore(10, 1000);
    for (const c of [11, 50, 1000]) {
      expect(wordScore(c, 1000)).toBe(cap);
    }
  });
});

describe("totalVocabScore", () => {
  it("sums wordScore across the encounter map using the rank lookup", () => {
    const m = new Map<string, number>([
      ["猫", 5],
      ["珈琲", 2],
    ]);
    const ranks = new Map<string, number | null>([
      ["猫", 200],
      ["珈琲", 8000],
    ]);
    const getRank = (h: string) => ranks.get(h) ?? null;
    expect(totalVocabScore(m, getRank)).toBeCloseTo(
      wordScore(5, 200) + wordScore(2, 8000),
      6
    );
  });

  it("treats missing ranks as null (floor weight)", () => {
    const m = new Map<string, number>([["猫", 4]]);
    expect(totalVocabScore(m, () => null)).toBeCloseTo(wordScore(4, null), 6);
  });

  it("returns 0 for an empty map", () => {
    expect(totalVocabScore(new Map(), () => null)).toBe(0);
  });
});

describe("vocabScoreDelta", () => {
  const getRank = () => 1000;

  it("returns 0 when the story has no occurrences", () => {
    expect(vocabScoreDelta(new Map(), new Map(), getRank)).toBe(0);
  });

  it("treats absent headwords as count=0", () => {
    const story = new Map([["猫", 2]]);
    expect(vocabScoreDelta(story, new Map(), getRank)).toBeCloseTo(
      wordScore(2, 1000) - wordScore(0, 1000),
      6
    );
  });

  it("increments each headword's count by its story occurrence count", () => {
    const encounters = new Map<string, number>([
      ["猫", 3],
      ["珈琲", 0],
    ]);
    const story = new Map([
      ["猫", 4],
      ["珈琲", 2],
    ]);
    const ranks: Record<string, number | null> = { 猫: 200, 珈琲: 8000 };
    const lookup = (h: string) => ranks[h] ?? null;
    const expected =
      wordScore(7, 200) -
      wordScore(3, 200) +
      wordScore(2, 8000) -
      wordScore(0, 8000);
    expect(vocabScoreDelta(story, encounters, lookup)).toBeCloseTo(expected, 6);
  });

  it("predicted delta matches actual addition for an unseen headword", () => {
    const before = new Map<string, number>();
    const story = new Map([["猫", 2]]);
    const ranks = new Map<string, number | null>([["猫", 200]]);
    const lookup = (h: string) => ranks.get(h) ?? null;
    const predicted = vocabScoreDelta(story, before, lookup);
    const after = new Map<string, number>([["猫", 2]]);
    expect(predicted).toBeCloseTo(totalVocabScore(after, lookup), 6);
  });

  it("predicts no gain when the headword is already at the cap", () => {
    const encounters = new Map<string, number>([["猫", 10]]);
    const story = new Map([["猫", 5]]);
    expect(vocabScoreDelta(story, encounters, getRank)).toBe(0);
  });

  it("a common-word delta exceeds the same count of a rare word", () => {
    const story = new Map([["X", 3]]);
    const common = vocabScoreDelta(story, new Map(), () => 100);
    const rare = vocabScoreDelta(story, new Map(), () => 50_000);
    expect(common).toBeGreaterThan(rare);
  });
});
