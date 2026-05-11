// Integration-y tests for lookupAtBoundary with mocked dictionary results.
// The mocks mirror the actual JMdict shapes for words involved in the
// posHint-guided deinflection path so we can verify the fix end-to-end
// without an IDB instance.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WordResult } from "@birchill/jpdict-idb";

vi.mock("./dictionary", () => ({
  lookupWord: vi.fn(),
}));

import { lookupWord } from "./dictionary";
import { lookupAtBoundary } from "./lookupAtCursor";

const mockLookup = vi.mocked(lookupWord);

function wr(opts: {
  k?: string[];
  r: string[];
  pos: string[];
  misc?: string[];
}): WordResult {
  return {
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
