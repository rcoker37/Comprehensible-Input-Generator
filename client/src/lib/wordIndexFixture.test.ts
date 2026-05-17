import { describe, it, expect } from "vitest";
import {
  diffWordIndex,
  sameDecision,
  type ExpectedSpan,
  type IndexedSpan,
} from "./wordIndexFixture";

function span(
  start: number,
  end: number,
  headword: string,
  opts: { reading?: string; entryId?: number | null } = {}
): IndexedSpan {
  return {
    start,
    end,
    surface: headword,
    headword,
    reading: opts.reading ?? "",
    entryId: opts.entryId ?? null,
  };
}

function exp(
  start: number,
  end: number,
  headword: string,
  opts: {
    reading?: string;
    entryId?: number | null;
    manual?: boolean;
    isName?: boolean;
  } = {}
): ExpectedSpan {
  return {
    ...span(start, end, headword, opts),
    manual: opts.manual ?? false,
    isName: opts.isName ?? false,
  };
}

describe("sameDecision", () => {
  it("treats null and empty-string readings as equal", () => {
    expect(
      sameDecision(span(0, 1, "猫", { reading: "" }), {
        ...span(0, 1, "猫"),
        reading: null as unknown as string,
      })
    ).toBe(true);
  });

  it("is false when the entry id differs", () => {
    expect(
      sameDecision(
        span(0, 2, "降る", { entryId: 1 }),
        span(0, 2, "降る", { entryId: 2 })
      )
    ).toBe(false);
  });
});

describe("diffWordIndex", () => {
  it("reports a clean run when actual reproduces every expected span", () => {
    const actual = [span(0, 1, "猫"), span(1, 2, "が")];
    const expected = [exp(0, 1, "猫"), exp(1, 2, "が")];
    const d = diffWordIndex(actual, expected, actual);
    expect(d.matched).toBe(2);
    expect(d.regressions).toBe(0);
    expect(d.knownGaps).toBe(0);
    expect(d.extra).toBe(0);
    expect(d.accuracy).toBe(1);
    expect(d.behaviorChanged).toEqual([]);
  });

  it("counts a manual expected span the algorithm misses as a known gap, not a regression", () => {
    // 野菜 was hand-fixed; the algorithm still splits it 野 + さい.
    const expected = [exp(0, 2, "野菜", { manual: true })];
    const actual = [span(0, 1, "野"), span(1, 2, "さい")];
    const d = diffWordIndex(actual, expected, actual);
    expect(d.knownGaps).toBe(1);
    expect(d.regressions).toBe(0);
    expect(d.extra).toBe(2); // 野 and さい aren't in the curated index
    expect(d.accuracy).toBe(0);
    expect(d.results.find((r) => r.start === 0 && r.end === 2)?.status).toBe(
      "known-gap"
    );
  });

  it("counts a caught-up manual span as an improvement and credits accuracy", () => {
    const expected = [exp(0, 2, "野菜", { manual: true, entryId: 1 })];
    const actual = [span(0, 2, "野菜", { entryId: 1 })];
    const d = diffWordIndex(actual, expected, actual);
    expect(d.improvements).toBe(1);
    expect(d.matched).toBe(0);
    expect(d.knownGaps).toBe(0);
    expect(d.accuracy).toBe(1);
    expect(d.results[0]?.status).toBe("improvement");
  });

  it("flags a broken non-manual span as a regression", () => {
    // The algorithm once chose entry 100 (and the user accepted it); now 999.
    const expected = [exp(0, 2, "日本", { entryId: 100 })];
    const actual = [span(0, 2, "日本", { entryId: 999 })];
    const d = diffWordIndex(actual, expected, actual);
    expect(d.regressions).toBe(1);
    expect(d.matched).toBe(0);
    expect(d.accuracy).toBe(0);
    expect(d.results[0]?.status).toBe("regression");
  });

  it("flags a non-manual expected span dropped entirely as a regression", () => {
    const expected = [exp(0, 1, "猫"), exp(1, 2, "が")];
    const actual = [span(0, 1, "猫")];
    const d = diffWordIndex(actual, expected, actual);
    expect(d.regressions).toBe(1);
    expect(d.matched).toBe(1);
  });

  it("has no baseline comparison when baseline is null", () => {
    const expected = [exp(0, 1, "猫")];
    const d = diffWordIndex([span(0, 1, "猫")], expected, null);
    expect(d.hasBaseline).toBe(false);
    expect(d.behaviorChanged).toEqual([]);
  });

  it("labels a change that lands on the curated value as toward-expected", () => {
    const expected = [exp(0, 2, "行く", { entryId: 50 })];
    const baseline = [span(0, 2, "行く", { entryId: 99 })];
    const actual = [span(0, 2, "行く", { entryId: 50 })];
    const d = diffWordIndex(actual, expected, baseline);
    expect(d.behaviorChanged).toHaveLength(1);
    expect(d.behaviorChanged[0]?.toward).toBe("toward-expected");
    expect(d.matched).toBe(1);
  });

  it("labels a change that breaks the curated value as away-from-expected", () => {
    const expected = [exp(0, 2, "行く", { entryId: 50 })];
    const baseline = [span(0, 2, "行く", { entryId: 50 })];
    const actual = [span(0, 2, "行く", { entryId: 99 })];
    const d = diffWordIndex(actual, expected, baseline);
    expect(d.behaviorChanged[0]?.toward).toBe("away-from-expected");
    expect(d.regressions).toBe(1);
  });

  it("labels a change between two wrong values (a known gap) as neutral", () => {
    const expected = [exp(0, 2, "X", { manual: true, entryId: 1 })];
    const baseline = [span(0, 2, "X", { entryId: 8 })];
    const actual = [span(0, 2, "X", { entryId: 9 })];
    const d = diffWordIndex(actual, expected, baseline);
    expect(d.behaviorChanged[0]?.toward).toBe("neutral");
    expect(d.knownGaps).toBe(1);
  });

  it("detects a baseline span that vanished from actual", () => {
    const expected = [exp(0, 1, "猫")];
    const baseline = [span(0, 1, "猫"), span(1, 2, "が")];
    const actual = [span(0, 1, "猫")];
    const d = diffWordIndex(actual, expected, baseline);
    expect(d.behaviorChanged).toHaveLength(1);
    expect(d.behaviorChanged[0]).toMatchObject({ start: 1, end: 2, after: null });
  });

  it("treats an empty index as 100% accurate", () => {
    const d = diffWordIndex([], [], null);
    expect(d.total).toBe(0);
    expect(d.accuracy).toBe(1);
  });
});
