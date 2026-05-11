import { describe, expect, it } from "vitest";
import type { WordResult } from "@birchill/jpdict-idb";
import { headwordFromHit } from "./headword";
import type { LookupHit } from "./lookupAtCursor";

function wr(k: string[] | null, r: string[]): WordResult {
  return {
    id: 1,
    k: k ? k.map((ent) => ({ ent })) : undefined,
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
});
