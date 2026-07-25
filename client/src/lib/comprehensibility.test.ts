import { describe, it, expect } from "vitest";
import type { WordOccurrence } from "./storyWordIndex";
import {
  vocabFrontier,
  rankToLevel,
  scoreComprehensibility,
  shouldSettle,
  newWordTarget,
  DEFAULT_FRONTIER,
  FRONTIER_MIN,
  FRONTIER_MAX,
  MIN_SAMPLE,
  WELL_KNOWN_MIN,
  RESIDUAL_OK,
  MAX_REFINE_PASSES,
  COMPREHENSIBLE_THRESHOLD,
  NEW_WORD_FLOOR_MIN,
  NEW_WORD_FLOOR_MAX,
  type ComprehensibilityScore,
} from "./comprehensibility";

function occ(
  surface: string,
  headword: string,
  extra: Partial<WordOccurrence> = {}
): WordOccurrence {
  return {
    start: 0,
    end: 0,
    surface,
    headword,
    reading: headword,
    entryId: null,
    isName: false,
    ...extra,
  };
}

/** Build a getWordRank from a plain object; unknown headwords => null. */
function ranker(map: Record<string, number>) {
  return (hw: string): number | null => (hw in map ? map[hw]! : null);
}

describe("vocabFrontier", () => {
  it("falls back to DEFAULT_FRONTIER with too few well-known words", () => {
    const enc = new Map<string, number>([["猫", 8]]);
    expect(vocabFrontier(enc, ranker({ 猫: 900 }))).toBe(DEFAULT_FRONTIER);
  });

  it("ignores words below WELL_KNOWN_MIN and words with no rank", () => {
    const enc = new Map<string, number>();
    const ranks: Record<string, number> = {};
    // 40 well-known ranked words at rank 2000...
    for (let i = 0; i < 40; i++) {
      enc.set(`w${i}`, WELL_KNOWN_MIN);
      ranks[`w${i}`] = 2000;
    }
    // ...plus noise that must be excluded: under-encountered + unranked.
    enc.set("rareSeenOnce", 1); // below WELL_KNOWN_MIN
    ranks["rareSeenOnce"] = 90000;
    enc.set("unranked", 20); // well-known but no rank
    const frontier = vocabFrontier(enc, ranker(ranks));
    // p75 of forty 2000s is 2000, clamped up to FRONTIER_MIN.
    expect(frontier).toBe(FRONTIER_MIN);
  });

  it("takes the 75th percentile of known-word ranks", () => {
    const enc = new Map<string, number>();
    const ranks: Record<string, number> = {};
    // ranks 1000,2000,...,100000 (100 words), all well-known.
    for (let i = 1; i <= 100; i++) {
      enc.set(`w${i}`, 10);
      ranks[`w${i}`] = i * 1000;
    }
    expect(enc.size).toBeGreaterThanOrEqual(MIN_SAMPLE);
    // p75 index = floor(0.75 * 99) = 74 => the 75th smallest = 75000, capped.
    expect(vocabFrontier(enc, ranker(ranks))).toBe(FRONTIER_MAX);
  });

  it("clamps a mid-range percentile without hitting the rails", () => {
    const enc = new Map<string, number>();
    const ranks: Record<string, number> = {};
    for (let i = 0; i < 40; i++) {
      enc.set(`w${i}`, 10);
      ranks[`w${i}`] = 8000; // p75 = 8000, inside [MIN,MAX]
    }
    expect(vocabFrontier(enc, ranker(ranks))).toBe(8000);
  });
});

describe("rankToLevel", () => {
  it("maps low frontiers to beginner and high to advanced", () => {
    expect(rankToLevel(1500).label).toMatch(/beginner/i);
    expect(rankToLevel(6000).label).toMatch(/N4/);
    expect(rankToLevel(10000).label).toMatch(/N3/);
    expect(rankToLevel(20000).label).toMatch(/N2/);
    expect(rankToLevel(40000).label).toMatch(/advanced/i);
  });

  it("always returns a non-empty actionable blurb", () => {
    for (const r of [1000, 5000, 9000, 18000, 35000]) {
      expect(rankToLevel(r).blurb.length).toBeGreaterThan(20);
    }
  });
});

describe("newWordTarget", () => {
  it("scales the i+1 floor with length, clamped", () => {
    expect(newWordTarget(1)).toBe(NEW_WORD_FLOOR_MIN); // round(2)=2 -> clamped up
    expect(newWordTarget(3)).toBe(6);
    expect(newWordTarget(5)).toBe(10);
    expect(newWordTarget(100)).toBe(NEW_WORD_FLOOR_MAX); // clamped down
  });

  it("never returns below the minimum floor", () => {
    for (const p of [1, 2, 3, 10]) {
      expect(newWordTarget(p)).toBeGreaterThanOrEqual(NEW_WORD_FLOOR_MIN);
    }
  });
});

describe("scoreComprehensibility", () => {
  const frontier = 5000;
  const enc = new Map<string, number>([
    ["食べる", 12], // seen -> never a problem
  ]);
  const rank = ranker({
    食べる: 300,
    walk: 0, // latin — excluded before rank matters
    難解: 25000, // unseen + rare -> problem
    普通: 800, // unseen but common -> not a problem
    // 稀語 intentionally absent -> null rank -> problem
  });

  it("excludes names, punctuation, and non-Japanese from content tokens", () => {
    const occs = [
      occ("トウキョウ", "東京", { isName: true }),
      occ("、", "、"),
      occ("walk", "walk"),
      occ("普通", "普通"),
    ];
    const s = scoreComprehensibility(occs, enc, rank, frontier);
    // Only 普通 counts as a content token.
    expect(s.contentTokens).toBe(1);
    expect(s.problemWords).toHaveLength(0);
    // 普通 is unseen (not in enc) so it is still new material, even though it
    // is common enough not to be a problem. Names/punctuation never count.
    expect(s.newWords).toBe(1);
  });

  it("flags unseen words that are rare or unranked, not seen or common ones", () => {
    const occs = [
      occ("食べる", "食べる"), // seen
      occ("普通", "普通"), // common
      occ("難解", "難解"), // rare -> problem
      occ("稀語", "稀語"), // unranked -> problem
    ];
    const s = scoreComprehensibility(occs, enc, rank, frontier);
    expect(s.contentTokens).toBe(4);
    expect(s.problemTokens).toBe(2);
    expect(s.problemWords.map((p) => p.headword)).toEqual(["稀語", "難解"]); // rarest (null) first
    expect(s.fraction).toBeCloseTo(0.5, 6);
    // New material = every unseen word: 普通 (common) + 難解 + 稀語. The seen
    // 食べる doesn't count. So more new words than problem words — the common
    // unseen one is the i+1 sweet spot.
    expect(s.newWords).toBe(3);
  });

  it("dedupes repeated problem words but counts every occurrence in tokens", () => {
    const occs = [occ("難解", "難解"), occ("難解", "難解"), occ("普通", "普通")];
    const s = scoreComprehensibility(occs, enc, rank, frontier);
    expect(s.problemTokens).toBe(2);
    expect(s.problemWords).toHaveLength(1);
    expect(s.contentTokens).toBe(3);
    expect(s.fraction).toBeCloseTo(1 - 2 / 3, 6);
    // Distinct new headwords: 難解 + 普通 (repeated 難解 counts once).
    expect(s.newWords).toBe(2);
  });

  it("returns fraction 1 for an empty story", () => {
    const s = scoreComprehensibility([], enc, rank, frontier);
    expect(s.fraction).toBe(1);
    expect(s.contentTokens).toBe(0);
    expect(s.newWords).toBe(0);
  });

  it("carries surface and reading onto the flagged word", () => {
    const occs = [occ("難解", "難解", { reading: "なんかい" })];
    const s = scoreComprehensibility(occs, enc, rank, frontier);
    expect(s.problemWords[0]).toMatchObject({
      surface: "難解",
      headword: "難解",
      reading: "なんかい",
      rank: 25000,
    });
  });
});

describe("shouldSettle", () => {
  const base: ComprehensibilityScore = {
    contentTokens: 100,
    problemTokens: 20,
    fraction: 0.8,
    problemWords: Array.from({ length: 10 }, (_, i) =>
      occ(`x${i}`, `x${i}`)
    ).map((o) => ({
      surface: o.surface,
      headword: o.headword,
      reading: o.reading,
      rank: null,
    })),
    newWords: 25,
  };

  it("settles when comprehensible enough", () => {
    expect(
      shouldSettle({ ...base, fraction: COMPREHENSIBLE_THRESHOLD }, 0, Infinity)
    ).toBe(true);
  });

  it("settles when only a residual few problems remain", () => {
    expect(
      shouldSettle(
        { ...base, problemWords: base.problemWords.slice(0, RESIDUAL_OK) },
        0,
        Infinity
      )
    ).toBe(true);
  });

  it("settles at the pass cap even if still hard", () => {
    expect(shouldSettle(base, MAX_REFINE_PASSES, Infinity)).toBe(true);
  });

  it("settles when a pass made no progress (anti-oscillation)", () => {
    // 10 problems now vs 10 (or fewer) before => no improvement.
    expect(shouldSettle(base, 1, 10)).toBe(true);
  });

  it("keeps going when hard, under the cap, and improving", () => {
    expect(shouldSettle(base, 1, Infinity)).toBe(false);
  });
});
