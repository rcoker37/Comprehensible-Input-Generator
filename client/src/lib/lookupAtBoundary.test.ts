// Integration-y tests for lookupAtBoundary with mocked dictionary results.
// The mocks mirror the actual JMdict shapes for words involved in the
// posHint-guided deinflection path so we can verify the fix end-to-end
// without an IDB instance.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WordResult } from "@birchill/jpdict-idb";

vi.mock("./dictionary", () => ({
  lookupWord: vi.fn(),
}));

vi.mock("./frequency", () => ({
  loadFrequencyIndex: vi.fn(async () => {}),
  lookupFrequencyByEntrySync: vi.fn(() => null),
}));

import { lookupWord } from "./dictionary";
import { lookupFrequencyByEntrySync } from "./frequency";
import { lookupAtBoundary } from "./lookupAtCursor";

const mockLookup = vi.mocked(lookupWord);
const mockRank = vi.mocked(lookupFrequencyByEntrySync);

function wr(opts: {
  k?: string[];
  r: string[];
  pos: string[];
  misc?: string[];
  id?: number;
}): WordResult {
  return {
    id: opts.id ?? 0,
    k: (opts.k ?? []).map((ent) => ({ ent })),
    r: opts.r.map((ent) => ({ ent })),
    s: [{ pos: opts.pos, misc: opts.misc }],
  } as unknown as WordResult;
}

describe("lookupAtBoundary posHint='動詞' override", () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  it("prefers a verb deinflection over a particle-only exact match (なり → なる)", async () => {
    // JMdict なり is most prominently a particle/auxiliary plus a couple of
    // niche noun entries plus the archaic classical copula 也 tagged
    // aux-v/vr/cop. None of the modern senses carry a verb POS, so the
    // posHint override should fire and deinflect to なる.
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "なり") {
        return [
          // Modern particle senses.
          wr({ r: ["なり"], pos: ["prt"] }),
          // Classical copula 也 — verb POS on archaic senses, plain n+suf on
          // the modern sense. hasVerbPos should skip the arch senses.
          {
            k: [{ ent: "也" }],
            r: [{ ent: "なり" }],
            s: [
              { pos: ["aux-v", "vr", "cop"], misc: ["uk", "arch"] },
              { pos: ["aux-v", "vr"], misc: ["uk", "arch"] },
              { pos: ["n", "suf"] },
            ],
          } as unknown as WordResult,
          wr({ k: ["形"], r: ["なり"], pos: ["n"] }),
          wr({ k: ["鳴り"], r: ["なり"], pos: ["n"] }),
          wr({ k: ["生り"], r: ["なり"], pos: ["n"] }),
          wr({ k: ["成り", "為り"], r: ["なり"], pos: ["n"] }),
        ];
      }
      if (search === "なる") {
        return [
          wr({ k: ["成る"], r: ["なる"], pos: ["v5r", "vi"], misc: ["uk"] }),
          wr({ k: ["為る"], r: ["なる"], pos: ["v5r", "vi"] }),
        ];
      }
      return [];
    });

    const hit = await lookupAtBoundary(
      "赤くなり、",
      2,
      4,
      [],
      "動詞"
    );

    expect(hit).not.toBeNull();
    expect(hit!.base).toBe("なる");
    expect(hit!.derivations).toEqual(["continuative"]);
  });

  it("returns the noun/particle exact match when posHint is not 動詞 (彼なりに context)", async () => {
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "なり") {
        return [
          wr({ r: ["なり"], pos: ["prt"] }),
          wr({ k: ["形"], r: ["なり"], pos: ["n"] }),
        ];
      }
      return [];
    });

    const hit = await lookupAtBoundary(
      "彼なりに",
      1,
      3,
      [],
      "助詞"
    );

    expect(hit).not.toBeNull();
    expect(hit!.base).toBeUndefined();
    expect(hit!.results.length).toBeGreaterThan(0);
  });

  it("matches the screenshot case 「空は高くなり、雲は白かったです。」 at offset 4", async () => {
    // Same JMdict shape as the first test, just with the offsets from the
    // real story text the user reported. なり spans [4, 6].
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "なり") {
        return [
          wr({ r: ["なり"], pos: ["prt"] }),
          wr({ k: ["形"], r: ["なり"], pos: ["n"] }),
          wr({ k: ["鳴り"], r: ["なり"], pos: ["n"] }),
        ];
      }
      if (search === "なる") {
        return [
          wr({ k: ["成る"], r: ["なる"], pos: ["v5r", "vi"], misc: ["uk"] }),
        ];
      }
      return [];
    });

    const hit = await lookupAtBoundary(
      "空は高くなり、雲は白かったです。",
      4,
      6,
      [],
      "動詞"
    );

    expect(hit).not.toBeNull();
    expect(hit!.base).toBe("なる");
    expect(hit!.surface).toBe("なり");
  });

  it("also fires on mixed-script noun entries (乗り → 乗る)", async () => {
    // JMdict 乗り is a legitimate noun ("riding; ride"; tagged n / n-suf).
    // In context like 「電車に乗り、」 kuromoji tags it 動詞 — we want the
    // popover to show 乗る, not the noun gerund. The gate is purely
    // posHint='動詞' + no modern verb POS in the exact match; surface
    // script doesn't matter.
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "乗り") {
        return [
          wr({ k: ["乗り"], r: ["のり"], pos: ["n"] }),
          wr({ k: ["乗り"], r: ["のり"], pos: ["n"] }),
          wr({ k: ["乗り"], r: ["のり"], pos: ["n-suf"] }),
        ];
      }
      if (search === "乗る") {
        return [wr({ k: ["乗る"], r: ["のる"], pos: ["v5r", "vi"] })];
      }
      return [];
    });

    const hit = await lookupAtBoundary(
      "電車に乗り、",
      3,
      5,
      [],
      "動詞"
    );

    expect(hit).not.toBeNull();
    expect(hit!.base).toBe("乗る");
    expect(hit!.derivations).toEqual(["continuative"]);
  });

  it("returns the exact verb match when posHint='動詞' and exact already has v* POS", async () => {
    // Surface 行く is the dictionary form. Even with posHint=動詞, the
    // override should not run (exact already has verb POS).
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "いく") {
        return [wr({ k: ["行く"], r: ["いく"], pos: ["v5k-s", "vi"] })];
      }
      return [];
    });

    const hit = await lookupAtBoundary("いく", 0, 2, [], "動詞");
    expect(hit).not.toBeNull();
    expect(hit!.base).toBeUndefined();
  });
});

describe("lookupAtBoundary frequency-gated kana-canonical match", () => {
  beforeEach(() => {
    mockLookup.mockReset();
    mockRank.mockReset();
  });

  it("keeps the common exact match over a rare deinflection (のせる → 乗せる, not 伸す)", async () => {
    // 「のせる」 in kana. The exact match is the common ichidan verb 乗せる /
    // 載せる; the potential-form rule せる→す reduces it to the rare godan
    // verb 伸す. isKanjiCanonicalKanaMatch flags the pure-kana match, so JPDB
    // rank is what must keep the exact match here.
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "のせる") {
        return [
          wr({ k: ["乗せる"], r: ["のせる"], pos: ["v1", "vt"], id: 100 }),
          wr({ k: ["載せる"], r: ["のせる"], pos: ["v1", "vt"], id: 101 }),
        ];
      }
      if (search === "のす") {
        return [wr({ k: ["伸す"], r: ["のす"], pos: ["v5s", "vt"], id: 200 })];
      }
      return [];
    });
    mockRank.mockImplementation((id) => {
      if (id === 100) {
        return { rank: 4200, tier: "common", headword: "乗せる", reading: "のせる" };
      }
      if (id === 200) {
        return { rank: 38000, tier: "very-rare", headword: "伸す", reading: "のす" };
      }
      return null;
    });

    const hit = await lookupAtBoundary("のせる", 0, 3, [], "動詞");

    expect(hit).not.toBeNull();
    expect(hit!.base).toBeUndefined();
    expect(hit!.surface).toBe("のせる");
    expect(hit!.results[0]?.k?.[0]?.ent).toBe("乗せる");
  });

  it("yields to the deinflection when the kana-canonical exact match is the rarer reading", async () => {
    // Same shapes, ranks inverted: the exact match is now the rare reading
    // and the deinflection lemma is common — the deinflection wins, mirroring
    // the いきたい → 行く case through the same potential-form chain.
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "のせる") {
        return [wr({ k: ["乗せる"], r: ["のせる"], pos: ["v1", "vt"], id: 100 })];
      }
      if (search === "のす") {
        return [wr({ k: ["伸す"], r: ["のす"], pos: ["v5s", "vt"], id: 200 })];
      }
      return [];
    });
    mockRank.mockImplementation((id) => {
      if (id === 200) {
        return { rank: 90, tier: "very-common", headword: "伸す", reading: "のす" };
      }
      return null; // 乗せる absent from JPDB
    });

    const hit = await lookupAtBoundary("のせる", 0, 3, [], "動詞");

    expect(hit).not.toBeNull();
    expect(hit!.base).toBe("のす");
  });

  it("falls back to the deinflection when no by-entry rank resolves either side", async () => {
    // Neither id is in the by-entry index (rank > 100k or unranked) — bestRank
    // returns null for both, exactRankWins keeps the pre-frequency behaviour
    // (deinflection preferred for a kanji-canonical kana match). No throw.
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "のせる") {
        return [wr({ k: ["乗せる"], r: ["のせる"], pos: ["v1", "vt"], id: 100 })];
      }
      if (search === "のす") {
        return [wr({ k: ["伸す"], r: ["のす"], pos: ["v5s", "vt"], id: 200 })];
      }
      return [];
    });
    // mockRank left unimplemented after reset → returns undefined for every id.

    const hit = await lookupAtBoundary("のせる", 0, 3, [], "動詞");

    expect(hit).not.toBeNull();
    expect(hit!.base).toBe("のす");
  });
});

describe("lookupAtBoundary baseHint deinflection disambiguation", () => {
  beforeEach(() => {
    mockLookup.mockReset();
    mockRank.mockReset();
  });

  // 「いった」 is the plain past of three godan verbs at once — 行く / 言う / 要る.
  // The mock makes 言う the most frequent, so the rank tiebreaker alone would
  // pick it; kuromoji's in-context lemma is what must override that.
  const mockItta = (): void => {
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "いく") {
        return [wr({ k: ["行く"], r: ["いく"], pos: ["v5k-s", "vi"], id: 1 })];
      }
      if (search === "いう") {
        return [wr({ k: ["言う"], r: ["いう"], pos: ["v5u", "vt"], id: 2 })];
      }
      if (search === "いる") {
        return [wr({ k: ["要る"], r: ["いる"], pos: ["v5r", "vi"], id: 3 })];
      }
      return [];
    });
    mockRank.mockImplementation((id) => {
      if (id === 1) return { rank: 44, tier: "very-common", headword: "行く", reading: "いく" };
      if (id === 2) return { rank: 27, tier: "very-common", headword: "言う", reading: "いう" };
      if (id === 3) return { rank: 3812, tier: "uncommon", headword: "要る", reading: "いる" };
      return null;
    });
  };

  it("picks the candidate matching kuromoji's lemma over the most frequent one", async () => {
    mockItta();
    const hit = await lookupAtBoundary("いった", 0, 3, [], "動詞", "いく");
    expect(hit).not.toBeNull();
    expect(hit!.base).toBe("いく");
    expect(hit!.results[0]?.k?.[0]?.ent).toBe("行く");
  });

  it("falls back to JPDB rank when no baseHint is given", async () => {
    mockItta();
    const hit = await lookupAtBoundary("いった", 0, 3, [], "動詞");
    expect(hit).not.toBeNull();
    expect(hit!.base).toBe("いう");
  });

  it("ignores a baseHint that matches no candidate", async () => {
    mockItta();
    const hit = await lookupAtBoundary("いった", 0, 3, [], "動詞", "およぐ");
    expect(hit).not.toBeNull();
    expect(hit!.base).toBe("いう");
  });
});
