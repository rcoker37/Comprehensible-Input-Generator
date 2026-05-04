import { describe, it, expect } from "vitest";
import type { WordResult } from "@birchill/jpdict-idb";
import { applyAnnotatedReading, type LookupHit } from "./lookupAtCursor";
import type { FuriganaAnnotation } from "./furigana";

// `applyAnnotatedReading` only touches `wr.r[i].ent`; build minimal stand-ins
// so we don't have to populate the full WordResult shape.
function wr(...readings: string[]): WordResult {
  return { r: readings.map((ent) => ({ ent })) } as unknown as WordResult;
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
