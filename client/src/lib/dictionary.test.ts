// Unit tests for preferExactScriptMatch — the script-exact reordering that
// keeps a hiragana lookup (でも) from resolving to a katakana homophone (デモ).
// The JMdict IDB folds hiragana and katakana to one lookup key, so a でも
// query returns both entries; results[0] is what the word indexer stamps.

import { describe, it, expect } from "vitest";
import type { WordResult } from "@birchill/jpdict-idb";
import { preferExactScriptMatch } from "./dictionary";

function wr(id: number, opts: { k?: string[]; r?: string[] }): WordResult {
  return {
    id,
    k: (opts.k ?? []).map((ent) => ({ ent })),
    r: (opts.r ?? []).map((ent) => ({ ent })),
    s: [],
  } as unknown as WordResult;
}

const ids = (results: WordResult[]) => results.map((r) => r.id);

describe("preferExactScriptMatch", () => {
  it("promotes the literal hiragana entry over a kana-folded katakana one", () => {
    const demo = wr(1084000, { r: ["デモ"] });
    const demoConj = wr(1008460, { r: ["でも"] });
    expect(ids(preferExactScriptMatch([demo, demoConj], "でも"))).toEqual([
      1008460, 1084000,
    ]);
  });

  it("is symmetric — a katakana lookup promotes the katakana entry", () => {
    const demo = wr(1084000, { r: ["デモ"] });
    const demoConj = wr(1008460, { r: ["でも"] });
    expect(ids(preferExactScriptMatch([demoConj, demo], "デモ"))).toEqual([
      1084000, 1008460,
    ]);
  });

  it("matches a literal kanji form too", () => {
    const kanji = wr(1, { k: ["事"], r: ["こと"] });
    const other = wr(2, { r: ["こと"] });
    expect(ids(preferExactScriptMatch([other, kanji], "事"))).toEqual([1, 2]);
  });

  it("preserves order when every result is a literal match", () => {
    expect(
      ids(
        preferExactScriptMatch(
          [wr(1, { r: ["でも"] }), wr(2, { r: ["でも"] })],
          "でも"
        )
      )
    ).toEqual([1, 2]);
  });

  it("preserves order when no result is a literal match", () => {
    expect(
      ids(
        preferExactScriptMatch(
          [wr(1, { r: ["デモ"] }), wr(2, { r: ["デモ"] })],
          "でも"
        )
      )
    ).toEqual([1, 2]);
  });
});
