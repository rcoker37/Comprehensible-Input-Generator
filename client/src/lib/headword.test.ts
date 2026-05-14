import { describe, expect, it } from "vitest";
import type { WordResult } from "@birchill/jpdict-idb";
import { headwordFromHit } from "./headword";
import type { LookupHit } from "./lookupAtCursor";

function wr(
  k: Array<string | [string, string[]]> | null,
  r: string[]
): WordResult {
  return {
    id: 1,
    k: k
      ? k.map((entry) =>
          typeof entry === "string"
            ? { ent: entry }
            : { ent: entry[0], i: entry[1] }
        )
      : undefined,
    r: r.map((ent) => ({ ent })),
    s: [],
    romaji: [],
  } as unknown as WordResult;
}

describe("headwordFromHit", () => {
  it("uses hit.base for deinflected hits", () => {
    const hit: LookupHit = {
      start: 0,
      end: 7,
      surface: "食べられました",
      base: "食べる",
      derivations: ["passive", "polite", "past"],
      results: [wr(["食べる"], ["たべる"])],
    };
    expect(headwordFromHit(hit)).toEqual({
      headword: "食べる",
      reading: "たべる",
    });
  });

  it("prefers primary k[0].ent for exact-match hits with kanji", () => {
    const hit: LookupHit = {
      start: 0,
      end: 2,
      surface: "日本",
      results: [wr(["日本"], ["にほん", "にっぽん"])],
    };
    expect(headwordFromHit(hit)).toEqual({
      headword: "日本",
      reading: "にほん",
    });
  });

  it("falls back to r[0].ent for kana-only entries", () => {
    const hit: LookupHit = {
      start: 0,
      end: 5,
      surface: "ありがとう",
      results: [wr(null, ["ありがとう"])],
    };
    expect(headwordFromHit(hit)).toEqual({
      headword: "ありがとう",
      reading: "ありがとう",
    });
  });

  it("uses preferredReading over r[0].ent when available", () => {
    const hit: LookupHit = {
      start: 0,
      end: 2,
      surface: "日本",
      preferredReading: "にっぽん",
      results: [wr(["日本"], ["にほん", "にっぽん"])],
    };
    expect(headwordFromHit(hit)).toEqual({
      headword: "日本",
      reading: "にっぽん",
    });
  });

  it("returns null when hit has no base and no results", () => {
    const hit: LookupHit = {
      start: 0,
      end: 1,
      surface: "が",
      results: [],
    };
    expect(headwordFromHit(hit)).toBeNull();
  });

  it("uses primary k[0] even when later results have different forms", () => {
    const hit: LookupHit = {
      start: 0,
      end: 1,
      surface: "言",
      results: [wr(["言う"], ["いう"]), wr(["事"], ["こと"])],
    };
    expect(headwordFromHit(hit)?.headword).toBe("言う");
  });

  it("skips sK kanji forms and falls back to the kana reading", () => {
    // JMdict entry 1469800 (の particle): k=[乃 sK, 之 sK], r=[の]. Without
    // the sK filter we'd stamp 乃 as the canonical headword on every tap of
    // a kana の — the canonical-keyed frequency lookup then misses, and the
    // popover header renders 乃 instead of の.
    const hit: LookupHit = {
      start: 0,
      end: 1,
      surface: "の",
      results: [wr([["乃", ["sK"]], ["之", ["sK"]]], ["の"])],
    };
    expect(headwordFromHit(hit)).toEqual({
      headword: "の",
      reading: "の",
    });
  });

  it("picks the first non-sK kanji when some forms are sK", () => {
    const hit: LookupHit = {
      start: 0,
      end: 2,
      surface: "貴方",
      results: [
        wr([["貴方", []], ["貴男", ["sK"]]], ["あなた"]),
      ],
    };
    expect(headwordFromHit(hit)?.headword).toBe("貴方");
  });
});
