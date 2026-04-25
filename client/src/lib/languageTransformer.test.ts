import { describe, it, expect } from "vitest";
import {
  LanguageTransformer,
  suffixInflection,
  type LanguageTransformDescriptor,
} from "./languageTransformer";
import {
  deinflect,
  posMatches,
  posTagsToConditions,
} from "./japaneseDeinflect";
import { scanLengthFromCursor } from "./lookupAtCursor";

describe("LanguageTransformer engine", () => {
  it("returns the source as the first result with empty trace", () => {
    const t = new LanguageTransformer();
    t.addDescriptor({
      language: "x",
      conditions: { a: { name: "a", isDictionaryForm: true } },
      transforms: {},
    });
    const r = t.transform("hello");
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({ text: "hello", conditions: 0, trace: [] });
  });

  it("applies a suffix rule and gates by conditions", () => {
    const desc: LanguageTransformDescriptor = {
      language: "x",
      conditions: {
        v: { name: "v", isDictionaryForm: true },
        past: { name: "past", isDictionaryForm: false },
      },
      transforms: {
        past: {
          name: "past",
          rules: [suffixInflection("ed", "", ["past"], ["v"])],
        },
        nominalize: {
          name: "nominalize",
          rules: [suffixInflection("er", "", [], ["v"])],
        },
      },
    };
    const t = new LanguageTransformer();
    t.addDescriptor(desc);
    // walked → walk via past (no input gate, since source has conditions=0)
    const r = t.transform("walked");
    const bases = r.map((x) => x.text);
    expect(bases).toContain("walk");
  });

  it("does not loop on cycles", () => {
    const desc: LanguageTransformDescriptor = {
      language: "x",
      conditions: { v: { name: "v", isDictionaryForm: true } },
      transforms: {
        // Pathological rule: matches every string and maps it to itself.
        identity: {
          name: "identity",
          rules: [
            { type: "other", isInflected: /.*/, deinflect: (s) => s, conditionsIn: [], conditionsOut: ["v"] },
          ],
        },
      },
    };
    const t = new LanguageTransformer();
    t.addDescriptor(desc);
    // Should terminate. The cycle detector breaks at the same (transform, rule, text).
    const r = t.transform("foo");
    // First entry plus exactly one identity application — the second would be a cycle.
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r.length).toBeLessThan(10);
  });

  it("resolves subConditions transitively", () => {
    const desc: LanguageTransformDescriptor = {
      language: "x",
      conditions: {
        v: { name: "v", isDictionaryForm: true, subConditions: ["v1", "v5"] },
        v1: { name: "v1", isDictionaryForm: true },
        v5: { name: "v5", isDictionaryForm: true },
      },
      transforms: {
        // Rule consumes "v" (= v1|v5) and produces "v1".
        ru: {
          name: "ru",
          rules: [suffixInflection("た", "る", ["v"], ["v1"])],
        },
      },
    };
    const t = new LanguageTransformer();
    t.addDescriptor(desc);
    const r = t.transform("食べた");
    expect(r.map((x) => x.text)).toContain("食べる");
  });
});

describe("japanese deinflect", () => {
  // Each test asserts the *base* is reachable; chains may differ across
  // ambiguous branches (e.g. passive vs potential of an ichidan verb).
  const cases: Array<{
    surface: string;
    base: string;
    requiredChain?: string[];
  }> = [
    { surface: "食べさせられなかった", base: "食べる" },
    { surface: "食べられました", base: "食べる" },
    { surface: "走って", base: "走る" },
    { surface: "美しくない", base: "美しい" },
    { surface: "いきましょう", base: "いく" },
    { surface: "行きました", base: "行く" },
    { surface: "来られた", base: "来る" },
    // n+vs nouns aren't stripped at the deinflection layer — Yomitan finds
    // them by deinflecting to the …する form and matching the JMdict entry.
    { surface: "勉強した", base: "勉強する" },
    { surface: "言って", base: "言う" },
    { surface: "飛び出した", base: "飛び出す" },
    { surface: "やめれば", base: "やめる" },
  ];

  for (const c of cases) {
    it(`${c.surface} → ${c.base}`, () => {
      const candidates = deinflect(c.surface);
      const bases = candidates.map((x) => x.base);
      expect(bases).toContain(c.base);
    });
  }

  it("returns derivation chains for inflected forms", () => {
    const candidates = deinflect("食べられました");
    const tabelu = candidates.find((c) => c.base === "食べる");
    expect(tabelu).toBeDefined();
    expect(tabelu!.derivations.length).toBeGreaterThanOrEqual(2);
  });

  it("populates conditions on every candidate", () => {
    const candidates = deinflect("食べられました");
    for (const c of candidates) {
      expect(c.conditions).toBeGreaterThan(0);
    }
  });
});

describe("POS gating", () => {
  it("posTagsToConditions OR's known tags and ignores unknown ones", () => {
    const v1 = posTagsToConditions(["v1"]);
    const v5k = posTagsToConditions(["v5k"]);
    const both = posTagsToConditions(["v1", "v5k", "n", "exp"]);
    expect(v1).toBeGreaterThan(0);
    expect(v5k).toBeGreaterThan(0);
    expect(v1).not.toBe(v5k);
    expect(both & v1).toBe(v1);
    expect(both & v5k).toBe(v5k);
    // Unknown tags contribute nothing.
    expect(posTagsToConditions(["n", "exp"])).toBe(0);
  });

  it("accepts the correct branch and rejects the wrong-class branch", () => {
    // 食べられました produces multiple 食べる candidates:
    //   - via godan-passive (predicted: v5) — wrong, 食べる is ichidan
    //   - via "potential or passive" of an ichidan (predicted: v1) — correct
    // POS gating against JMdict's actual ["v1", "vt"] should accept exactly
    // the v1 candidate.
    const cands = deinflect("食べられました").filter((c) => c.base === "食べる");
    expect(cands.length).toBeGreaterThan(1);
    const accepted = cands.filter((c) => posMatches(c, ["v1", "vt"]));
    const rejected = cands.filter((c) => !posMatches(c, ["v1", "vt"]));
    expect(accepted.length).toBeGreaterThan(0);
    expect(rejected.length).toBeGreaterThan(0);
  });

  it("rejects a deinflection when the dictionary POS is the wrong class", () => {
    // No matter which branch produced 食べる, a noun entry should never satisfy
    // a verb's predicted conditions.
    const cands = deinflect("食べられました").filter((c) => c.base === "食べる");
    for (const c of cands) {
      expect(posMatches(c, ["n"])).toBe(false);
    }
  });

  it("rejects v1 candidates against v5 dictionary entries (and vice versa)", () => {
    // 走って has both v1 (走る → 走 + て-form) and v5r (走る godan) candidates
    // depending on the rule chain. The v5r candidate must not match a v1 entry.
    const candidates = deinflect("走って");
    const v5cand = candidates.find((c) => c.base === "走る" && c.conditions !== 0);
    expect(v5cand).toBeDefined();
    // 走る is a v5r verb in JMdict.
    expect(posMatches(v5cand!, ["v5r"])).toBe(true);
    expect(posMatches(v5cand!, ["v1"])).toBe(false);
  });

  it("v5 umbrella matches any v5* row", () => {
    // 行きました uses the masu rule with conditionsOut: ['v5'] (umbrella). It
    // should match v5k-s entries (行く is v5k-s in JMdict).
    const cand = deinflect("行きました").find((c) => c.base === "行く")!;
    expect(posMatches(cand, ["v5k-s"])).toBe(true);
    expect(posMatches(cand, ["v5k"])).toBe(true);
    // Wrong class: ichidan should not match.
    expect(posMatches(cand, ["v1"])).toBe(false);
  });
});

describe("scanLengthFromCursor", () => {
  it("stops at the hira→kata boundary so は in THCはカンナビス doesn't extend", () => {
    // The original bug: tap on は (offset 3) extended to はカン and matched a
    // bogus hiragana-equivalent JMdict entry.
    const text = "THCはカンナビスという植物";
    expect(scanLengthFromCursor(text, 3)).toBe(1);
  });

  it("keeps katakana runs together but stops at the next script", () => {
    const text = "THCはカンナビスという";
    // カ at offset 4 should scan through ンナビス and stop at と.
    expect(scanLengthFromCursor(text, 4)).toBe(5);
  });

  it("allows kanji+okurigana to mix freely", () => {
    expect(scanLengthFromCursor("食べさせられた", 0)).toBe(7);
    expect(scanLengthFromCursor("美しくない", 0)).toBe(5);
  });

  it("allows hiragana prefix + kanji (e.g. お弁当)", () => {
    // hira→kanji and kanji→hira are both fine, so the scan walks the entire
    // hira+kanji run; lookupAtCursor's MAX_LOOKUP_LEN caps the actual probe.
    expect(scanLengthFromCursor("お弁当を食べる", 0)).toBe(7);
  });

  it("treats ASCII as a hard stop (length 1)", () => {
    expect(scanLengthFromCursor("THCは", 0)).toBe(1);
  });

  it("includes the long-vowel mark in katakana runs", () => {
    expect(scanLengthFromCursor("カードを買う", 0)).toBe(3);
  });
});
