import { describe, it, expect } from "vitest";
import {
  regroupWords,
  type LookupAtBoundaryFn,
  type TokenizeFn,
} from "./regroupWords";
import { buildDisplaySegments } from "./storySegments";
import type { KuromojiTokenInfo } from "./tokenizer";

// Build a tokenize stub from a list of token surfaces. Surfaces are
// concatenated; we record start/end offsets along the way. This keeps the
// test fixtures readable: `tokens(["日本", "に", "は"])`. Pass
// `{surface, pos}` objects when a test needs to exercise the POS-aware
// regroup heuristics (e.g. 動詞|助動詞 split rejection).
type TokenSpec = string | { surface: string; pos: string };
function tokens(specs: TokenSpec[]): TokenizeFn {
  return async (text) => {
    const out: KuromojiTokenInfo[] = [];
    let cursor = 0;
    for (const spec of specs) {
      const surface = typeof spec === "string" ? spec : spec.surface;
      const pos = typeof spec === "string" ? "" : spec.pos;
      out.push({ surface, start: cursor, end: cursor + surface.length, pos });
      cursor += surface.length;
    }
    if (cursor !== text.length) {
      throw new Error(
        `tokens() mismatch: surfaces total ${cursor}, text length ${text.length}`
      );
    }
    return out;
  };
}

// Mock lookupAtBoundary — returns a hit when the substring `text.slice(start, end)`
// is in the dict set, else null. Mirrors what the real lookup does for an
// exact-length probe (without iterating shorter lengths).
function mockLookup(words: Set<string>): LookupAtBoundaryFn {
  return async (text, start, end) => {
    if (start < 0 || end <= start || end > text.length) return null;
    const sub = text.slice(start, end);
    if (words.has(sub)) {
      return {
        start,
        end,
        surface: sub,
        results: [{} as never],
      };
    }
    return null;
  };
}

describe("regroupWords", () => {
  it("groups 千九百年代 as [千][九百][年代] when kuromoji + dict line up", async () => {
    // Motivating bug from the original report. With kuromoji as boundary
    // oracle and JMdict supplying entries for 九百 and 年代, every char tap
    // resolves to the right entry.
    const text = "千九百年代";
    const base = buildDisplaySegments(text, []);
    const out = await regroupWords(
      base,
      text,
      [],
      mockLookup(new Set(["千", "九百", "年代"])),
      tokens(["千", "九百", "年代"])
    );
    const parts = out[0]!.sentences[0]!.parts;
    expect(parts).toEqual([
      { kind: "char", offset: 0, char: "千" },
      { kind: "word", start: 1, end: 3, surface: "九百" },
      { kind: "word", start: 3, end: 5, surface: "年代" },
    ]);
  });

  it("falls back to kanji-containing match when kuromoji misses the inner boundary (四つ inside 四|つの)", async () => {
    // The bug from the user's repro: kuromoji segments 「四つの」 as 「四|つの」
    // so the only aligned end inside the run is 3 (which would match 「四つの」
    // — usually not in JMdict). The aligned pass finds nothing; without the
    // kanji-containing fallback, the next cursor lands on 「つ」 and merges
    // 「つの」 (= "horn", a real JMdict noun), giving the wrong [四][つの].
    // The fallback re-tries non-aligned lengths whose span contains kanji,
    // so 「四つ」 at length 2 is accepted even though kuromoji didn't put a
    // boundary at offset 2.
    const text = "四つの";
    const base = buildDisplaySegments(text, []);
    const out = await regroupWords(
      base,
      text,
      [],
      mockLookup(new Set(["四つ", "つの"])),
      tokens(["四", "つの"])
    );
    const parts = out[0]!.sentences[0]!.parts;
    expect(parts).toEqual([
      { kind: "word", start: 0, end: 2, surface: "四つ" },
      { kind: "char", offset: 2, char: "の" },
    ]);
  });

  it("rejects があ (mid-token JMdict match) and accepts あります across kuromoji boundaries", async () => {
    // The bug case from the user's repro: 「が」「あり」「ます」 are kuromoji's
    // tokens; the boundaries are at 1, 3, 5. JMdict knows both `があ` (interj.
    // ending mid-token at 2) and `あります` (deinflects to ある, ending at the
    // run end at 5). The boundary alignment rule rejects `があ` (2 isn't a
    // kuromoji boundary) and accepts `あります` (ends at boundary 5).
    const text = "があります";
    const base = buildDisplaySegments(text, []);
    const out = await regroupWords(
      base,
      text,
      [],
      mockLookup(new Set(["が", "があ", "あります"])),
      tokens(["が", "あり", "ます"])
    );
    const parts = out[0]!.sentences[0]!.parts;
    expect(parts).toEqual([
      { kind: "char", offset: 0, char: "が" },
      { kind: "word", start: 1, end: 5, surface: "あります" },
    ]);
  });

  it("rejects merging a verb stem with the preceding particle (にし inside にします)", async () => {
    // The user's repro: in 「豊かにします」 kuromoji segments 「に|し|ます」
    // with し tagged as 動詞 and ます as 助動詞. JMdict has 「にし」 (西=west)
    // as a real entry, and end=2 *is* a kuromoji boundary, so the alignment
    // rule alone would accept the wrong [にし][ます] split. The verb-aux
    // heuristic rejects boundaries that orphan an aux from its stem, so the
    // にし merge is skipped and the next cursor matches 「します」 (deinflects
    // to する via the polite-form rule).
    const text = "にします";
    const base = buildDisplaySegments(text, []);
    const out = await regroupWords(
      base,
      text,
      [],
      mockLookup(new Set(["にし", "します"])),
      tokens([
        { surface: "に", pos: "助詞" },
        { surface: "し", pos: "動詞" },
        { surface: "ます", pos: "助動詞" },
      ])
    );
    const parts = out[0]!.sentences[0]!.parts;
    expect(parts).toEqual([
      { kind: "char", offset: 0, char: "に" },
      { kind: "word", start: 1, end: 4, surface: "します" },
    ]);
  });

  it("merges an inflected verb across multiple kuromoji tokens via deinflection", async () => {
    // Kuromoji typically splits 食べました as [食べ, まし, た] (or similar);
    // the lookup picks up the full span 食べました via deinflection to 食べる.
    const text = "食べました";
    const base = buildDisplaySegments(text, []);
    const out = await regroupWords(
      base,
      text,
      [],
      mockLookup(new Set(["食べました"])),
      tokens(["食べ", "まし", "た"])
    );
    const parts = out[0]!.sentences[0]!.parts;
    expect(parts).toEqual([
      { kind: "word", start: 0, end: 5, surface: "食べました" },
    ]);
  });

  it("merges an annotated kanji with following okurigana (高《たか》く)", async () => {
    // The user's regression: 「空も高くなります」 has 「高」 annotated with
    // ruby たか, leaving 「く」 (i-adj ku-form) as a separate Char. After
    // parsing, parts are [Annotated(高, たか), Char(く)] — two tap targets.
    // The regroup pass should detect that the combined span 「高く」 is a
    // valid JMdict span (deinflects to 高い in the real lookup) and merge
    // them into one WordPart, carrying the ruby as a sub-annotation so the
    // renderer can put it back over 高.
    const text = "高く";
    const anns = [{ start: 0, end: 1, reading: "たか" }];
    const base = buildDisplaySegments(text, anns);
    const out = await regroupWords(
      base,
      text,
      anns,
      mockLookup(new Set(["高く"])),
      tokens(["高く"])
    );
    const parts = out[0]!.sentences[0]!.parts;
    expect(parts).toEqual([
      {
        kind: "word",
        start: 0,
        end: 2,
        surface: "高く",
        rubies: [{ start: 0, end: 1, reading: "たか" }],
      },
    ]);
  });

  it("keeps annotation atomic when only the shorter span is in JMdict", async () => {
    // Counterpart of the merge case: when no dict entry spans the
    // annotation boundary, the merge stops at the boundary and the
    // annotated kanji keeps its own ruby. The annotation start/end are
    // treated as aligned so 「あい」 (no kanji, hira-only) can still merge
    // even though kuromoji didn't put a boundary at offset 2.
    const text = "あい後";
    const anns = [{ start: 2, end: 3, reading: "あと" }];
    const base = buildDisplaySegments(text, anns);
    const out = await regroupWords(
      base,
      text,
      anns,
      mockLookup(new Set(["あい"])),
      tokens(["あい後"]) // kuromoji groups all 3 — boundary at 3
    );
    const parts = out[0]!.sentences[0]!.parts;
    expect(parts).toEqual([
      { kind: "word", start: 0, end: 2, surface: "あい" },
      { kind: "annotated", start: 2, end: 3, surface: "後", reading: "あと" },
    ]);
  });

  it("falls back to single chars when no kuromoji-aligned dict match exists", async () => {
    const text = "あいう";
    const base = buildDisplaySegments(text, []);
    const out = await regroupWords(
      base,
      text,
      [],
      mockLookup(new Set()),
      tokens(["あ", "い", "う"])
    );
    const parts = out[0]!.sentences[0]!.parts;
    expect(parts).toEqual([
      { kind: "char", offset: 0, char: "あ" },
      { kind: "char", offset: 1, char: "い" },
      { kind: "char", offset: 2, char: "う" },
    ]);
  });

  it("merges compound particles like には as one tap target", async () => {
    const text = "日本には";
    const base = buildDisplaySegments(text, []);
    const out = await regroupWords(
      base,
      text,
      [],
      mockLookup(new Set(["日本", "には"])),
      tokens(["日本", "に", "は"])
    );
    const parts = out[0]!.sentences[0]!.parts;
    expect(parts).toEqual([
      { kind: "word", start: 0, end: 2, surface: "日本" },
      { kind: "word", start: 2, end: 4, surface: "には" },
    ]);
  });

  it("preserves sentence start offsets across paragraphs", async () => {
    const text = "今日は晴れ。\n\n明日は雨。";
    const base = buildDisplaySegments(text, []);
    const out = await regroupWords(
      base,
      text,
      [],
      mockLookup(new Set(["今日", "晴れ", "明日"])),
      // Tokens cover the full text including the newline run; kuromoji
      // emits 。 and \n as their own tokens. We only need a plausible
      // boundary list — the regroup pass walks per-sentence.
      tokens([
        "今日",
        "は",
        "晴れ",
        "。",
        "\n\n",
        "明日",
        "は",
        "雨",
        "。",
      ])
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.sentences[0]!.start).toBe(0);
    expect(out[1]!.sentences[0]!.start).toBe(8); // after "今日は晴れ。\n\n"
  });
});
