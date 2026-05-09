import { describe, it, expect } from "vitest";
import {
  formatScore,
  kanjiScore,
  totalScore,
  readingScoreDelta,
  SCORE_MULTIPLIER,
} from "./rarity";

describe("kanjiScore", () => {
  it("returns 0 at c=0", () => {
    expect(kanjiScore(0)).toBe(0);
  });

  it("is strictly increasing", () => {
    let prev = -Infinity;
    for (const c of [0, 1, 2, 5, 9, 10, 11, 20, 100, 1000]) {
      const s = kanjiScore(c);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });

  it("has strictly diminishing marginal returns through and past the kink", () => {
    let prevDelta = Infinity;
    let prev = kanjiScore(0);
    for (let c = 1; c <= 30; c++) {
      const s = kanjiScore(c);
      const delta = s - prev;
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThan(prevDelta);
      prevDelta = delta;
      prev = s;
    }
  });

  it("scales by SCORE_MULTIPLIER", () => {
    // f(1) ≈ 2.485 raw; ×1 ≈ 2.485
    expect(kanjiScore(1)).toBeCloseTo(2.485, 2);
    expect(SCORE_MULTIPLIER).toBe(1);
  });
});

describe("formatScore", () => {
  it("returns '<1' for values below 1", () => {
    expect(formatScore(0)).toBe("<1");
    expect(formatScore(0.001)).toBe("<1");
    expect(formatScore(0.999)).toBe("<1");
  });

  it("returns a rounded integer string for values >= 1", () => {
    expect(formatScore(1)).toBe("1");
    expect(formatScore(1.4)).toBe("1");
    expect(formatScore(1.5)).toBe("2");
    expect(formatScore(248.7)).toBe("249");
  });

  it("uses locale grouping for large values", () => {
    expect(formatScore(12345)).toBe("12,345");
  });
});

describe("totalScore", () => {
  it("sums kanjiScore across all entries in the exposures map", () => {
    const exposures = new Map([["猫", 0], ["魚", 1], ["山", 5]]);
    expect(totalScore(exposures)).toBeCloseTo(
      kanjiScore(0) + kanjiScore(1) + kanjiScore(5),
      6,
    );
  });

  it("returns 0 for an empty map", () => {
    expect(totalScore(new Map())).toBe(0);
  });
});

describe("readingScoreDelta", () => {
  it("returns 0 when no known kanji appear", () => {
    expect(readingScoreDelta("猫が魚を食べる", new Map())).toBe(0);
  });

  it("treats kanji not in the map as unknown (no contribution)", () => {
    const exposures = new Map([["猫", 0]]);
    // 魚 missing → 0 contribution; 猫 contributes one increment 0→1
    expect(readingScoreDelta("猫魚", exposures)).toBeCloseTo(
      kanjiScore(1) - kanjiScore(0),
      6,
    );
  });

  it("accounts for repetition in a single read by jumping the count by N", () => {
    const exposures = new Map([["猫", 0]]);
    // Three occurrences in one story: 0→3 (single jump, not three single steps)
    expect(readingScoreDelta("猫猫猫", exposures)).toBeCloseTo(
      kanjiScore(3) - kanjiScore(0),
      6,
    );
  });

  it("strips ruby blocks before counting", () => {
    const exposures = new Map([["猫", 0]]);
    expect(readingScoreDelta("猫《ねこ》", exposures)).toBeCloseTo(
      kanjiScore(1) - kanjiScore(0),
      6,
    );
  });
});

