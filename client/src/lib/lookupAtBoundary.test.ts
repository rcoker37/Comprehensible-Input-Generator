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

  it("hoists the best-ranked verb to results[0] when a non-verb homophone sorts ahead (くる → 来る, not 佝僂)", async () => {
    // jpdict-idb's sort floats 佝僂 to position 0 for the surface くる
    // (intrinsic JMdict priority + headword-type heuristics — see
    // word-result-sorting.ts in @birchill/jpdict-idb). Without the verb hoist
    // the indexer stamps the rare medical term on every 「入ってくる」, even
    // though kuromoji tagged the span 動詞 and 来る sits in the result list.
    // The hoist must skip past 繰る (also a verb but a much rarer godan one,
    // rank ~8000) and land on 来る (rank 25).
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "くる") {
        return [
          wr({ k: ["佝僂"], r: ["くる"], pos: ["n"], id: 1585500 }),
          wr({ k: ["繰る"], r: ["くる"], pos: ["v5r", "vt"], id: 1226720 }),
          wr({ k: ["来る"], r: ["くる"], pos: ["vk", "vi"], id: 1547720 }),
        ];
      }
      return [];
    });
    mockRank.mockImplementation((id) => {
      if (id === 1547720) {
        return { rank: 25, tier: "very-common", headword: "来る", reading: "くる" };
      }
      if (id === 1226720) {
        return { rank: 8000, tier: "rare", headword: "繰る", reading: "くる" };
      }
      return null;
    });

    const hit = await lookupAtBoundary("入ってくる", 3, 5, [], "動詞");

    expect(hit).not.toBeNull();
    expect(hit!.base).toBeUndefined();
    expect(hit!.results[0]?.k?.[0]?.ent).toBe("来る");
  });

  it("leaves order untouched when results[0] is already a verb (のせる → 乗せる stays first)", async () => {
    // Guard for the narrowness of the hoist: when jpdict-idb's sort already
    // landed a verb at position 0, don't second-guess it (rank-resorting
    // within the verb group breaks curator-blessed picks like 達 vs 質 in the
    // noun-equivalent case — see commit message for the regression set we
    // ruled out).
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "のせる") {
        return [
          wr({ k: ["乗せる"], r: ["のせる"], pos: ["v1", "vt"], id: 100 }),
          wr({ k: ["載せる"], r: ["のせる"], pos: ["v1", "vt"], id: 101 }),
        ];
      }
      return [];
    });
    mockRank.mockImplementation((id) => {
      if (id === 100) {
        return { rank: 4200, tier: "common", headword: "乗せる", reading: "のせる" };
      }
      if (id === 101) {
        return { rank: 100, tier: "very-common", headword: "載せる", reading: "のせる" };
      }
      return null;
    });

    const hit = await lookupAtBoundary("のせる", 0, 3, [], "動詞");
    expect(hit).not.toBeNull();
    expect(hit!.results[0]?.k?.[0]?.ent).toBe("乗せる");
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

  // Bare でした should deinflect to the copula です (1628500) instead of
  // splitting into でし (弟子, "disciple") + た. The existing strip-to-empty
  // rule still handles 静かでした → 静か.
  it("deinflects bare でした to です", async () => {
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "です") {
        return [wr({ r: ["です"], pos: ["cop"], misc: ["uk"], id: 1628500 })];
      }
      return [];
    });
    const hit = await lookupAtBoundary("でした", 0, 3);
    expect(hit).not.toBeNull();
    expect(hit!.base).toBe("です");
    expect(hit!.results[0]?.id).toBe(1628500);
  });

  // 静かな is the na-adj 静か + the copula's prenominal な. JMdict has no
  // entry for this な (it lives inside だ), and bare な exact-matches the
  // prohibitive particle, so the merge has to come from a surface-shape
  // rule that recognises the adj-na stem.
  it("resolves 静かな to the 静か adj-na entry", async () => {
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "静かな") return [];
      if (search === "静か") {
        return [
          wr({
            k: ["静か", "閑か"],
            r: ["しずか"],
            pos: ["adj-na", "n"],
            id: 1381820,
          }),
        ];
      }
      return [];
    });
    const hit = await lookupAtBoundary("静かな夜", 0, 3);
    expect(hit).not.toBeNull();
    expect(hit!.base).toBe("静か");
    expect(hit!.derivations).toEqual(["na-adjective"]);
    expect(hit!.results[0]?.id).toBe(1381820);
    expect(hit!.surface).toBe("静かな");
  });

  // The branch must only fire when the stem is itself an adj-na entry —
  // otherwise a surface like 雨な would wrongly resolve to the noun 雨.
  it("does not fire when the stem is not adj-na", async () => {
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "雨な") return [];
      if (search === "雨") {
        return [wr({ k: ["雨"], r: ["あめ"], pos: ["n"], id: 1171900 })];
      }
      return [];
    });
    const hit = await lookupAtBoundary("雨な", 0, 2);
    expect(hit).toBeNull();
  });

  // Bare な has no stem to check, so the branch is bypassed and the
  // prohibitive-particle exact match (the only な entry JMdict carries that
  // makes any sense as a standalone tap) is what's returned. This is the
  // correct behaviour for prohibitive な after a verb (行く + な).
  it("leaves bare な alone (no stem to check)", async () => {
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "な") {
        return [wr({ r: ["な"], pos: ["prt"], id: 2029110 })];
      }
      return [];
    });
    const hit = await lookupAtBoundary("な", 0, 1);
    expect(hit).not.toBeNull();
    expect(hit!.base).toBeUndefined();
    expect(hit!.results[0]?.id).toBe(2029110);
  });

  // 分かって's て-form is identical for 分かる (5-dan ら) and 分かつ (5-dan た).
  // The LLM ruby 分《わ》 covers only the kanji, so the annotation fits both
  // bases — baseHint must break the tie among the fitters.
  it("uses baseHint to tiebreak when furigana fit multiple candidates", async () => {
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "分かる") {
        return [wr({ k: ["分かる"], r: ["わかる"], pos: ["v5r", "vi"], id: 10 })];
      }
      if (search === "分かつ") {
        return [wr({ k: ["分かつ"], r: ["わかつ"], pos: ["v5t", "vt"], id: 11 })];
      }
      return [];
    });
    mockRank.mockImplementation((id) => {
      // Make 分かつ rank-better than 分かる so a pure rank tiebreaker would
      // pick the wrong one — the test verifies baseHint overrules rank.
      if (id === 10) return { rank: 700, tier: "common", headword: "分かる", reading: "わかる" };
      if (id === 11) return { rank: 100, tier: "very-common", headword: "分かつ", reading: "わかつ" };
      return null;
    });
    const annotations = [{ start: 0, end: 1, surface: "分", reading: "わ" }];
    const hit = await lookupAtBoundary(
      "分かって",
      0,
      4,
      annotations,
      "動詞",
      "分かる"
    );
    expect(hit).not.toBeNull();
    expect(hit!.base).toBe("分かる");
    expect(hit!.results[0]?.k?.[0]?.ent).toBe("分かる");
  });
});

describe("lookupAtBoundary ranked fixed-phrase exact-match preempts deinflection", () => {
  beforeEach(() => {
    mockLookup.mockReset();
    mockRank.mockReset();
  });

  it("keeps 然うすれば (conj, rank 2316) over the lemma そうする (rank 815) — within the 10× ratio", async () => {
    // 「そうすれば」 is pure-kana. JMdict exact-matches 然うすれば — tagged
    // `conj` (conjunction) only, no `exp`. The -ば rule deinflects to そうする
    // (`exp`,`vs-i`). `exactRankWins(2316, 815)` returns false (lemma is
    // strictly more common), but the new fixed-phrase branch keeps the
    // conjunction because 2316 / 815 ≈ 2.8 < 10. The `conj` POS is the
    // load-bearing part: a previous exp-only attempt missed this case
    // because 然うすれば carries no `exp` tag.
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "そうすれば") {
        return [
          wr({
            k: ["然うすれば"],
            r: ["そうすれば"],
            pos: ["conj"],
            misc: ["uk"],
            id: 2084030,
          }),
        ];
      }
      if (search === "そうする") {
        return [
          wr({
            k: ["然うする"],
            r: ["そうする"],
            pos: ["exp", "vs-i"],
            misc: ["uk"],
            id: 2084700,
          }),
        ];
      }
      return [];
    });
    mockRank.mockImplementation((id) => {
      if (id === 2084030) {
        return {
          rank: 2316,
          tier: "common",
          headword: "そうすれば",
          reading: "そうすれば",
        };
      }
      if (id === 2084700) {
        return {
          rank: 815,
          tier: "common",
          headword: "そうする",
          reading: "そうする",
        };
      }
      return null;
    });

    // Leading kuromoji token for そう is 副詞 (adverb).
    const hit = await lookupAtBoundary("そうすれば", 0, 5, [], "副詞");

    expect(hit).not.toBeNull();
    expect(hit!.base).toBeUndefined();
    expect(hit!.results[0]?.k?.[0]?.ent).toBe("然うすれば");
  });

  it("yields to the deinflection when the exp is dramatically rarer (に因り 22986 vs に依る 200, ~115×)", async () => {
    // 「により」 in 「これにより」: JMdict exact-matches the exp に因り (rank
    // 22986, "due to") and the -り conditional rule deinflects to the verb
    // lemma に依る (rank 200). The lemma is ~115× more common — well past the
    // exp-vs-deinflection rule's 10× ceiling — so deinflection wins.
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "により") {
        return [
          wr({
            k: ["に因り"],
            r: ["により"],
            pos: ["exp"],
            misc: ["uk"],
            id: 2076730,
          }),
        ];
      }
      if (search === "による") {
        return [
          wr({
            k: ["に依る", "に因る", "に拠る"],
            r: ["による"],
            pos: ["exp", "v5r"],
            misc: ["uk"],
            id: 1009660,
          }),
        ];
      }
      return [];
    });
    mockRank.mockImplementation((id) => {
      if (id === 2076730) {
        return { rank: 22986, tier: "rare", headword: "により", reading: "により" };
      }
      if (id === 1009660) {
        return {
          rank: 200,
          tier: "very-common",
          headword: "による",
          reading: "による",
        };
      }
      return null;
    });

    const hit = await lookupAtBoundary("により", 0, 3, [], "助詞");

    expect(hit).not.toBeNull();
    expect(hit!.base).toBe("による");
  });

  it("prefers a ranked exp when the deinflection is unranked", async () => {
    // どうしたら (exp, rank 5560) deinflects to どうする (unranked). With the
    // lemma unranked the exp wins regardless of its own rank.
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "どうしたら") {
        return [
          wr({
            r: ["どうしたら"],
            pos: ["exp"],
            id: 8000,
          }),
        ];
      }
      if (search === "どうする") {
        return [
          wr({ r: ["どうする"], pos: ["exp", "vs-i"], id: 8001 }),
        ];
      }
      return [];
    });
    mockRank.mockImplementation((id) => {
      if (id === 8000) {
        return { rank: 5560, tier: "uncommon", headword: "どうしたら", reading: "どうしたら" };
      }
      return null; // どうする unranked
    });

    const hit = await lookupAtBoundary("どうしたら", 0, 5, [], "副詞");

    expect(hit).not.toBeNull();
    expect(hit!.base).toBeUndefined();
    expect(hit!.results[0]?.id).toBe(8000);
  });

  it("does not fire for an unranked `exp` exact match (still defers to deinflection)", async () => {
    // Symmetry with `exactIsUnrankedExpression`. 「見られる」 exact-matches an
    // unranked honorific phrase entry; it should still deinflect to 見る. The
    // exp-vs-deinflection branch only fires when JPDB ranks the expression —
    // no rank, no preemption.
    mockLookup.mockImplementation(async (search: string) => {
      if (search === "みられる") {
        return [
          wr({
            r: ["みられる"],
            pos: ["exp", "v1"],
            id: 9000,
          }),
        ];
      }
      if (search === "みる") {
        return [
          wr({ k: ["見る"], r: ["みる"], pos: ["v1", "vt"], id: 9001 }),
        ];
      }
      return [];
    });
    mockRank.mockImplementation((id) => {
      if (id === 9001) {
        return { rank: 50, tier: "very-common", headword: "見る", reading: "みる" };
      }
      return null;
    });

    const hit = await lookupAtBoundary("みられる", 0, 4, [], "動詞");

    expect(hit).not.toBeNull();
    expect(hit!.base).toBe("みる");
  });
});
