import { describe, it, expect } from "vitest";
import { wordScore, totalVocabScore, vocabScoreDelta } from "./vocabScore";
import { rawScore } from "./rarity";

describe("wordScore", () => {
  it("returns 0 at c=0", () => {
    expect(wordScore(0)).toBe(0);
  });

  it("equals rawScore (no tier multiplier)", () => {
    for (const c of [1, 3, 5, 10, 50]) {
      expect(wordScore(c)).toBeCloseTo(rawScore(c), 6);
    }
  });

  it("has diminishing marginal returns up to the cap", () => {
    let prev = wordScore(0);
    let prevDelta = Infinity;
    for (let c = 1; c <= 9; c++) {
      const s = wordScore(c);
      const delta = s - prev;
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThan(prevDelta);
      prev = s;
      prevDelta = delta;
    }
  });

  it("caps at c=10 — further encounters contribute nothing", () => {
    const cap = wordScore(10);
    for (const c of [11, 50, 1000]) {
      expect(wordScore(c)).toBe(cap);
    }
  });
});

describe("totalVocabScore", () => {
  it("sums wordScore across the encounter map", () => {
    const m = new Map<string, number>([
      ["猫", 5],
      ["珈琲", 2],
    ]);
    expect(totalVocabScore(m)).toBeCloseTo(wordScore(5) + wordScore(2), 6);
  });

  it("returns 0 for an empty map", () => {
    expect(totalVocabScore(new Map())).toBe(0);
  });
});

describe("vocabScoreDelta", () => {
  it("returns 0 when the story has no occurrences", () => {
    expect(vocabScoreDelta(new Map(), new Map())).toBe(0);
  });

  it("treats absent headwords as count=0", () => {
    const story = new Map([["猫", 2]]);
    expect(vocabScoreDelta(story, new Map())).toBeCloseTo(
      wordScore(2) - wordScore(0),
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
    const expected =
      wordScore(7) - wordScore(3) + wordScore(2) - wordScore(0);
    expect(vocabScoreDelta(story, encounters)).toBeCloseTo(expected, 6);
  });

  it("predicted delta matches actual addition for an unseen headword", () => {
    const before = new Map<string, number>();
    const story = new Map([["猫", 2]]);
    const predicted = vocabScoreDelta(story, before);
    const after = new Map<string, number>([["猫", 2]]);
    expect(predicted).toBeCloseTo(totalVocabScore(after), 6);
  });

  it("predicts no gain when the headword is already at the cap", () => {
    const encounters = new Map<string, number>([["猫", 10]]);
    const story = new Map([["猫", 5]]);
    expect(vocabScoreDelta(story, encounters)).toBe(0);
  });
});
