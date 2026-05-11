import { describe, it, expect } from "vitest";
import type { WordResult } from "@birchill/jpdict-idb";
import {
  applyAnnotatedReading,
  hasVerbPos,
  isKanjiCanonicalKanaMatch,
  type LookupHit,
} from "./lookupAtCursor";
import type { FuriganaAnnotation } from "./furigana";

// `applyAnnotatedReading` only touches `wr.r[i].ent`; build minimal stand-ins
// so we don't have to populate the full WordResult shape.
function wr(...readings: string[]): WordResult {
  return { r: readings.map((ent) => ({ ent })) } as unknown as WordResult;
}

function wrFull(opts: {
  k?: string[];
  r: string[];
  misc?: string[];
}): WordResult {
  return {
    k: (opts.k ?? []).map((ent) => ({ ent })),
    r: opts.r.map((ent) => ({ ent })),
    s: [{ misc: opts.misc }],
  } as unknown as WordResult;
}

function wrWithPos(pos: string[]): WordResult {
  return {
    k: [],
    r: [{ ent: "x" }],
    s: [{ pos }],
  } as unknown as WordResult;
}

function wrWithSenses(
  senses: Array<{ pos?: string[]; misc?: string[] }>
): WordResult {
  return {
    k: [],
    r: [{ ent: "x" }],
    s: senses,
  } as unknown as WordResult;
}

function hit(over: Partial<LookupHit>): LookupHit {
  return {
    start: 0,
    end: 2,
    surface: "日本",
    results: [],
    ...over,
  };
}

describe("applyAnnotatedReading", () => {
  it("returns the hit unchanged when no annotations are supplied", () => {
    const h = hit({ results: [wr("にっぽん"), wr("にほん")] });
    const out = applyAnnotatedReading(h, []);
    expect(out).toEqual(h);
    expect(out.preferredReading).toBeUndefined();
  });

  it("hoists the WordResult whose reading matches the annotation", () => {
    // JMdict orders 日本 with にっぽん first; the LLM said にほん in the ruby.
    // We expect the にほん entry to come first and be reflected in preferredReading.
    const wrNippon = wr("にっぽん");
    const wrNihon = wr("にほん");
    const h = hit({ results: [wrNippon, wrNihon] });
    const ann: FuriganaAnnotation[] = [{ start: 0, end: 2, reading: "にほん" }];

    const out = applyAnnotatedReading(h, ann);
    expect(out.preferredReading).toBe("にほん");
    expect(out.results[0]).toBe(wrNihon);
    expect(out.results[1]).toBe(wrNippon);
  });

  it("matches a reading at any index inside a single WordResult's r[]", () => {
    // Single entry that lists にっぽん first and にほん second; the LLM's にほん
    // still wins, but no reorder is needed because the entry is already first.
    const single = wr("にっぽん", "にほん");
    const h = hit({ results: [single] });
    const ann: FuriganaAnnotation[] = [{ start: 0, end: 2, reading: "にほん" }];

    const out = applyAnnotatedReading(h, ann);
    expect(out.preferredReading).toBe("にほん");
    expect(out.results).toEqual([single]);
  });

  it("falls back (no preferred reading) when the annotation matches no entry", () => {
    // LLM hallucinated a reading no JMdict entry has — keep results as-is so
    // the popover renders the dictionary's first reading.
    const h = hit({ results: [wr("にっぽん"), wr("ひのもと")] });
    const ann: FuriganaAnnotation[] = [{ start: 0, end: 2, reading: "じゃぱん" }];

    const out = applyAnnotatedReading(h, ann);
    expect(out.preferredReading).toBeUndefined();
    expect(out.results).toEqual(h.results);
  });

  it("is a no-op for deinflected hits (annotation reading describes the inflected surface)", () => {
    // 食べられました surface, deinflected to 食べる. Annotation reading "たべられました"
    // can't reasonably match the lemma's "たべる", so we leave it alone.
    const h = hit({
      surface: "食べられました",
      end: 7,
      base: "食べる",
      derivations: ["passive", "polite", "past"],
      results: [wr("たべる"), wr("くべる")],
    });
    const ann: FuriganaAnnotation[] = [{ start: 0, end: 1, reading: "た" }];

    const out = applyAnnotatedReading(h, ann);
    expect(out.preferredReading).toBeUndefined();
    expect(out.results).toEqual(h.results);
  });

  it("is a no-op when results are empty", () => {
    const h = hit({ surface: "?", results: [] });
    const ann: FuriganaAnnotation[] = [{ start: 0, end: 2, reading: "にほん" }];
    const out = applyAnnotatedReading(h, ann);
    expect(out).toEqual(h);
  });

  it("is a no-op when no annotation overlaps the matched span", () => {
    // Annotation belongs to a kanji elsewhere in the story — the cursor lookup
    // still calls us but tokenReadingFromAnnotations returns undefined, so we
    // shouldn't fabricate a preferred reading.
    const h = hit({ start: 10, end: 12, surface: "公園", results: [wr("こうえん")] });
    const ann: FuriganaAnnotation[] = [{ start: 0, end: 2, reading: "にほん" }];
    const out = applyAnnotatedReading(h, ann);
    expect(out.preferredReading).toBeUndefined();
    expect(out.results).toEqual(h.results);
  });

  it("combines annotation + okurigana when the matched span includes trailing kana", () => {
    // Surface 食べる at offset 0; annotation only covers 食 → た. The composed
    // span reading is たべる, which should match the lemma entry.
    const h = hit({
      surface: "食べる",
      end: 3,
      results: [wr("くべる"), wr("たべる")],
    });
    const ann: FuriganaAnnotation[] = [{ start: 0, end: 1, reading: "た" }];

    const out = applyAnnotatedReading(h, ann);
    expect(out.preferredReading).toBe("たべる");
    expect(out.results[0]?.r[0]?.ent).toBe("たべる");
  });
});

describe("hasVerbPos", () => {
  it("detects v5 / v1 conjugation classes", () => {
    expect(hasVerbPos([wrWithPos(["v5r"])])).toBe(true);
    expect(hasVerbPos([wrWithPos(["v1"])])).toBe(true);
    expect(hasVerbPos([wrWithPos(["vs-i"])])).toBe(true);
    expect(hasVerbPos([wrWithPos(["vk"])])).toBe(true);
  });

  it("ignores valence markers vi / vt (which aren't conjugation classes)", () => {
    // A pure intransitive/transitive tag without a v* conjugation class would
    // be malformed JMdict data, but we still don't want the marker alone to
    // count as "verb".
    expect(hasVerbPos([wrWithPos(["vi"])])).toBe(false);
    expect(hasVerbPos([wrWithPos(["vt"])])).toBe(false);
  });

  it("returns false for noun / particle / interjection entries", () => {
    expect(hasVerbPos([wrWithPos(["n"])])).toBe(false);
    expect(hasVerbPos([wrWithPos(["prt"])])).toBe(false);
    expect(hasVerbPos([wrWithPos(["int"])])).toBe(false);
    expect(hasVerbPos([wrWithPos(["aux-v"])])).toBe(false);
  });

  it("returns true when ANY sense across ANY result has a verb POS", () => {
    // なり in JMdict: 形 (n), 鳴り (n), なり (aux-v). All non-verb → false.
    // Adding any v* entry would flip it.
    const noun = wrWithPos(["n"]);
    const aux = wrWithPos(["aux-v"]);
    expect(hasVerbPos([noun, aux])).toBe(false);
    const verb = wrWithPos(["v5r"]);
    expect(hasVerbPos([noun, aux, verb])).toBe(true);
  });

  it("handles empty results / missing senses defensively", () => {
    expect(hasVerbPos([])).toBe(false);
    expect(hasVerbPos([{ s: [] } as unknown as WordResult])).toBe(false);
  });

  it("skips senses tagged arch / obs so classical verb entries don't block deinflection", () => {
    // JMdict 也 (なり) — classical copula tagged aux-v/vr/cop with misc=['uk','arch'].
    // Non-arch sense is just n+suf. The entry shouldn't satisfy hasVerbPos
    // because the verb POS only appears on archaic senses.
    const classical = wrWithSenses([
      { pos: ["aux-v", "vr", "cop"], misc: ["uk", "arch"] },
      { pos: ["aux-v", "vr"], misc: ["uk", "arch"] },
      { pos: ["n", "suf"] },
    ]);
    expect(hasVerbPos([classical])).toBe(false);

    // But if a MODERN sense (no arch misc) carries the verb POS, we still
    // consider it satisfied.
    const modern = wrWithSenses([
      { pos: ["v5r"], misc: undefined },
      { pos: ["aux-v"], misc: ["arch"] },
    ]);
    expect(hasVerbPos([modern])).toBe(true);
  });
});

describe("isKanjiCanonicalKanaMatch", () => {
  it("flags kanji-only entry matched on its kana reading (e.g. いきたい→生き体)", () => {
    // Surface いきたい matches the reading of the rare noun 生き体. With no
    // 'uk' tag and a kanji headword, the match is "kanji-canonical" — the
    // user almost certainly meant 行きたい instead.
    const r = wrFull({ k: ["生き体"], r: ["いきたい"] });
    expect(isKanjiCanonicalKanaMatch([r], "いきたい")).toBe(true);
  });

  it("does not flag entries explicitly tagged uk (usually written in kana)", () => {
    // ありがとう has kanji 有り難う but is usually written in kana — uk wins.
    const r = wrFull({
      k: ["有り難う"],
      r: ["ありがとう"],
      misc: ["uk"],
    });
    expect(isKanjiCanonicalKanaMatch([r], "ありがとう")).toBe(false);
  });

  it("does not flag entries with no kanji forms (kana-native)", () => {
    const r = wrFull({ r: ["こんにちは"] });
    expect(isKanjiCanonicalKanaMatch([r], "こんにちは")).toBe(false);
  });

  it("does not flag mixed-script surfaces", () => {
    // Surface contains kanji — we never override exact match in that case.
    const r = wrFull({ k: ["生き体"], r: ["いきたい"] });
    expect(isKanjiCanonicalKanaMatch([r], "生きたい")).toBe(false);
  });

  it("requires every result to be kanji-canonical", () => {
    // If any result is uk-tagged or kana-native, exact match is fine.
    const kanjiOnly = wrFull({ k: ["生き体"], r: ["いきたい"] });
    const ukEntry = wrFull({ k: ["行く"], r: ["いきたい"], misc: ["uk"] });
    expect(isKanjiCanonicalKanaMatch([kanjiOnly, ukEntry], "いきたい")).toBe(false);
  });
});
