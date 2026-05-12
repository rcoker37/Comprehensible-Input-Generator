import { describe, it, expect } from "vitest";
import {
  TIER_MULTIPLIER,
  wordScore,
  totalVocabScore,
  vocabScoreDelta,
  type VocabEncounter,
} from "./vocabScore";
import { rawScore } from "./rarity";

describe("wordScore", () => {
  it("returns 0 at c=0 regardless of tier", () => {
    expect(wordScore(0, "very-common")).toBe(0);
    expect(wordScore(0, "very-rare")).toBe(0);
  });

  it("scales the shared curve by the tier multiplier", () => {
    const c = 5;
    expect(wordScore(c, "very-common")).toBeCloseTo(rawScore(c) * 0.1, 6);
    expect(wordScore(c, "common")).toBeCloseTo(rawScore(c) * 0.3, 6);
    expect(wordScore(c, "uncommon")).toBeCloseTo(rawScore(c) * 0.7, 6);
    expect(wordScore(c, "rare")).toBeCloseTo(rawScore(c) * 1.5, 6);
    expect(wordScore(c, "very-rare")).toBeCloseTo(rawScore(c) * 3, 6);
  });

  it("orders tiers by per-encounter value at any positive count", () => {
    for (const c of [1, 3, 10, 50]) {
      const vc = wordScore(c, "very-common");
      const co = wordScore(c, "common");
      const un = wordScore(c, "uncommon");
      const ra = wordScore(c, "rare");
      const vr = wordScore(c, "very-rare");
      expect(vc).toBeLessThan(co);
      expect(co).toBeLessThan(un);
      expect(un).toBeLessThan(ra);
      expect(ra).toBeLessThan(vr);
    }
  });

  it("inherits diminishing marginal returns from the shared curve", () => {
    let prev = wordScore(0, "common");
    let prevDelta = Infinity;
    for (let c = 1; c <= 30; c++) {
      const s = wordScore(c, "common");
      const delta = s - prev;
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThan(prevDelta);
      prev = s;
      prevDelta = delta;
    }
  });
});

describe("totalVocabScore", () => {
  it("sums wordScore across the encounter map", () => {
    const m = new Map<string, VocabEncounter>([
      ["猫", { encounters: 5, tier: "very-common" }],
      ["珈琲", { encounters: 2, tier: "rare" }],
    ]);
    expect(totalVocabScore(m)).toBeCloseTo(
      wordScore(5, "very-common") + wordScore(2, "rare"),
      6
    );
  });

  it("returns 0 for an empty map", () => {
    expect(totalVocabScore(new Map())).toBe(0);
  });
});

describe("vocabScoreDelta", () => {
  const allVeryRare = () => "very-rare" as const;

  it("returns 0 when the story has no occurrences", () => {
    expect(vocabScoreDelta(new Map(), new Map(), allVeryRare)).toBe(0);
  });

  it("uses resolveTier for absent headwords", () => {
    const story = new Map([["は", 5]]);
    const resolve = () => "very-common" as const;
    expect(vocabScoreDelta(story, new Map(), resolve)).toBeCloseTo(
      wordScore(5, "very-common") - wordScore(0, "very-common"),
      6
    );
  });

  it("does not call resolveTier for headwords already in encounters", () => {
    const encounters = new Map<string, VocabEncounter>([
      ["猫", { encounters: 3, tier: "common" }],
    ]);
    const story = new Map([["猫", 2]]);
    const resolve = () => {
      throw new Error("resolveTier should not be called");
    };
    expect(vocabScoreDelta(story, encounters, resolve)).toBeCloseTo(
      wordScore(5, "common") - wordScore(3, "common"),
      6
    );
  });

  it("uses each headword's stored tier and increments by occurrence count", () => {
    const encounters = new Map<string, VocabEncounter>([
      ["猫", { encounters: 3, tier: "common" }],
      ["珈琲", { encounters: 0, tier: "rare" }],
    ]);
    const story = new Map([
      ["猫", 4],
      ["珈琲", 2],
    ]);
    const expected =
      wordScore(7, "common") -
      wordScore(3, "common") +
      wordScore(2, "rare") -
      wordScore(0, "rare");
    expect(vocabScoreDelta(story, encounters, allVeryRare)).toBeCloseTo(
      expected,
      6
    );
  });

  it("predicted delta matches actual addition for an unseen headword", () => {
    // Repro for the +400 tag vs +257 actual bug: when the word's real tier
    // is common (×0.3) but the old code defaulted it to very-rare (×3),
    // the prediction was 10× the actual gain. With resolveTier wired up,
    // the prediction must now match.
    const before = new Map<string, VocabEncounter>();
    const story = new Map([["猫", 2]]);
    const resolve = () => "common" as const;
    const predicted = vocabScoreDelta(story, before, resolve);
    // Actual gain after refresh: encounters now has {猫: {2, common}}
    const after = new Map<string, VocabEncounter>([
      ["猫", { encounters: 2, tier: "common" }],
    ]);
    const beforeTotal = 0;
    const afterTotal = wordScore(2, "common");
    expect(predicted).toBeCloseTo(afterTotal - beforeTotal, 6);
    // Sanity: the new map's totalVocabScore minus the old equals predicted.
    expect(predicted).toBeCloseTo(
      Array.from(after.values()).reduce(
        (s, e) => s + wordScore(e.encounters, e.tier),
        0
      ),
      6
    );
  });
});

describe("TIER_MULTIPLIER", () => {
  it("uses the brainstorm-spec values", () => {
    expect(TIER_MULTIPLIER["very-common"]).toBe(0.1);
    expect(TIER_MULTIPLIER["common"]).toBe(0.3);
    expect(TIER_MULTIPLIER["uncommon"]).toBe(0.7);
    expect(TIER_MULTIPLIER["rare"]).toBe(1.5);
    expect(TIER_MULTIPLIER["very-rare"]).toBe(3);
  });
});
