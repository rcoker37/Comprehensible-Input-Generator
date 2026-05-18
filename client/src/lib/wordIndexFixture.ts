// Word-index regression fixtures: the shared format + the diff that drives the
// fixture test (see client/src/test/wordIndex.fixtures.test.ts).
//
// The mechanism: curate a story's word index in the app until it's right, then
// export it as a fixture — `{ content, expected }`. The test runs the genuine
// detection pipeline on `content` and compares its output three ways:
//
//   actual    — what extractWordOccurrences produces *now*
//   expected  — the curated index, each span flagged `manual` (true = a span
//               you hand-fixed via the override editor, i.e. a known place the
//               algorithm is wrong; false = a span the algorithm produced and
//               you accepted)
//   baseline  — `actual` the last time it was reviewed/blessed (machine-managed
//               in <slug>.baseline.json)
//
// `actual` vs `baseline` answers "did behaviour change?". `actual` vs `expected`
// answers "how close is the algorithm to what I want?" — and the `manual` flag
// is what separates a real regression (a once-correct span breaking) from a
// known gap (a span you already know the algorithm gets wrong) and from an
// improvement (a known gap the algorithm has now caught up on).
//
// This module is pure — no I/O, no React. The test runner does the file I/O;
// the in-app exporter assembles a {@link WordIndexFixture} object.

/** Bumped if the fixture JSON shape changes incompatibly. */
export const FIXTURE_FORMAT_VERSION = 1;

/**
 * One word span. The detection *decision* is `(headword, reading, entryId,
 * isName)`; `start`/`end` locate it in the cleaned story text; `surface` is
 * the literal text and is informational (derivable from the content + offsets).
 * `isName` is optional for backward compatibility with baselines recorded
 * before name detection existed — absent reads as `false`.
 */
export interface IndexedSpan {
  start: number;
  end: number;
  surface: string;
  headword: string;
  reading: string;
  entryId: number | null;
  isName?: boolean;
}

/**
 * A span in a fixture's curated `expected` index — an {@link IndexedSpan} plus
 * the provenance flags carried by `story_word_occurrences`. `manual` is the
 * load-bearing one: true means the user placed this span by hand, so the
 * algorithm failing to reproduce it is a *known gap*, not a regression.
 */
export interface ExpectedSpan extends IndexedSpan {
  manual: boolean;
  isName: boolean;
}

export interface WordIndexFixtureMeta {
  /** Story title, for human-readable test output. */
  title: string;
  /** The `stories.id` it was exported from (informational). */
  sourceStoryId: number | null;
  /** ISO timestamp of the export. */
  exportedAt: string;
  /** `WORD_INDEX_VERSION` at export time. */
  wordIndexVersion: number;
  /** JMdict data version the curation was done against, e.g. "2.0.474". */
  jmdictVersion: string | null;
  fixtureFormatVersion: number;
}

/** A curated fixture: the algorithm input plus the index the user wants. */
export interface WordIndexFixture {
  meta: WordIndexFixtureMeta;
  content: string;
  expected: ExpectedSpan[];
}

/** Machine-managed regression anchor stored next to each fixture. */
export interface WordIndexBaseline {
  generatedAt: string;
  occurrences: IndexedSpan[];
}

function spanKey(o: { start: number; end: number }): string {
  return `${o.start}-${o.end}`;
}

function norm(reading: string | null | undefined): string {
  return reading ?? "";
}

/**
 * True when two spans at the same offsets resolve to the same dictionary
 * decision. `start`/`end` are assumed already equal (callers key on them).
 */
export function sameDecision(a: IndexedSpan, b: IndexedSpan): boolean {
  return (
    a.headword === b.headword &&
    norm(a.reading) === norm(b.reading) &&
    (a.entryId ?? null) === (b.entryId ?? null) &&
    (a.isName ?? false) === (b.isName ?? false)
  );
}

/**
 * Per-span verdict of `actual` against the curated `expected` index.
 *
 *   matched      — actual reproduces a non-manual expected span
 *   improvement  — actual now reproduces a *manual* expected span: the
 *                  algorithm has caught up to a hand-fix
 *   known-gap    — a manual expected span actual still gets wrong / misses
 *   regression   — a non-manual expected span (algorithm once got right) that
 *                  actual now gets wrong / misses — a real failure
 *   extra        — actual produced a span the curated index has nothing at
 */
export type SpanStatus =
  | "matched"
  | "improvement"
  | "known-gap"
  | "regression"
  | "extra";

export interface SpanResult {
  status: SpanStatus;
  start: number;
  end: number;
  expected: ExpectedSpan | null;
  actual: IndexedSpan | null;
}

/**
 * A span whose detection changed since the baseline. `toward` says whether the
 * change moved the span onto (or off) the curated `expected` value, so the
 * test can label a change an improvement vs. a worry at a glance.
 */
export interface SpanChange {
  start: number;
  end: number;
  before: IndexedSpan | null;
  after: IndexedSpan | null;
  toward: "toward-expected" | "away-from-expected" | "neutral";
}

export interface FixtureDiff {
  /** One entry per expected span, plus one per `extra` actual span. */
  results: SpanResult[];
  /** Non-manual expected spans actual reproduces. */
  matched: number;
  /** Manual expected spans actual has caught up on. */
  improvements: number;
  /** Manual expected spans actual still gets wrong. */
  knownGaps: number;
  /** Non-manual expected spans actual broke — hard failures. */
  regressions: number;
  /** Actual spans absent from the curated index. */
  extra: number;
  /** Total curated (expected) spans. */
  total: number;
  /** (matched + improvements) / total — 1 when there are no expected spans. */
  accuracy: number;
  /** Spans that differ from the baseline. Empty when there is no baseline. */
  behaviorChanged: SpanChange[];
  hasBaseline: boolean;
}

/**
 * Compare a detection run against a fixture's curated index and (optionally)
 * its baseline. Pure — the test runner decides pass/fail from the result:
 * `regressions > 0` is always a failure; a non-empty `behaviorChanged` is a
 * failure unless the run is in `--accept` mode.
 */
export function diffWordIndex(
  actual: IndexedSpan[],
  expected: ExpectedSpan[],
  baseline: IndexedSpan[] | null
): FixtureDiff {
  const actualByKey = new Map(actual.map((o) => [spanKey(o), o]));
  const expectedByKey = new Map(expected.map((o) => [spanKey(o), o]));
  const baselineByKey = baseline
    ? new Map(baseline.map((o) => [spanKey(o), o]))
    : null;

  const results: SpanResult[] = [];
  let matched = 0;
  let improvements = 0;
  let knownGaps = 0;
  let regressions = 0;

  for (const e of expected) {
    const a = actualByKey.get(spanKey(e)) ?? null;
    const isMatch = a !== null && sameDecision(a, e);
    let status: SpanStatus;
    if (isMatch) {
      status = e.manual ? "improvement" : "matched";
      if (e.manual) improvements++;
      else matched++;
    } else {
      status = e.manual ? "known-gap" : "regression";
      if (e.manual) knownGaps++;
      else regressions++;
    }
    results.push({ status, start: e.start, end: e.end, expected: e, actual: a });
  }

  let extra = 0;
  for (const a of actual) {
    if (expectedByKey.has(spanKey(a))) continue;
    extra++;
    results.push({
      status: "extra",
      start: a.start,
      end: a.end,
      expected: null,
      actual: a,
    });
  }

  const behaviorChanged: SpanChange[] = [];
  if (baselineByKey) {
    const keys = new Set([...actualByKey.keys(), ...baselineByKey.keys()]);
    for (const k of keys) {
      const after = actualByKey.get(k) ?? null;
      const before = baselineByKey.get(k) ?? null;
      const changed =
        !after || !before || !sameDecision(after, before);
      if (!changed) continue;
      const exp = expectedByKey.get(k) ?? null;
      let toward: SpanChange["toward"] = "neutral";
      if (exp) {
        const afterMatches = after !== null && sameDecision(after, exp);
        const beforeMatches = before !== null && sameDecision(before, exp);
        if (afterMatches && !beforeMatches) toward = "toward-expected";
        else if (beforeMatches && !afterMatches) toward = "away-from-expected";
      }
      const [s, e] = k.split("-");
      behaviorChanged.push({
        start: Number(s),
        end: Number(e),
        before,
        after,
        toward,
      });
    }
    behaviorChanged.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  const total = expected.length;
  return {
    results,
    matched,
    improvements,
    knownGaps,
    regressions,
    extra,
    total,
    accuracy: total === 0 ? 1 : (matched + improvements) / total,
    behaviorChanged,
    hasBaseline: baselineByKey !== null,
  };
}
