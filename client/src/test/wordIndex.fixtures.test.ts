// Word-index regression suite.
//
// For every fixture in fixtures/word-index/, runs the *genuine* detection
// pipeline (extractWordOccurrences, against the vendored JMdict snapshot +
// real kuromoji — see headlessDictionary.ts) and compares its output to:
//
//   - the fixture's curated `expected` index  → accuracy + regression check
//   - the machine-managed `<slug>.baseline.json` → behaviour-change check
//
// A fixture fails when the algorithm breaks a span the curated index says it
// once got right (`regression`), or when *any* span changed since the baseline
// (run with INDEX_ACCEPT=1 — `npm run test:index:accept` — to bless changes
// you've reviewed). Known gaps (spans you hand-fixed that the algorithm hasn't
// caught up on yet) are reported but never fail the build.
//
// Add a fixture: curate a story's index in the app, click "Export test
// fixture" on its detail page, drop the file in fixtures/word-index/. The
// baseline is created automatically on the first run.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupHeadlessDictionary } from "./headlessDictionary";
import { extractWordOccurrences } from "../lib/storyWordIndex";
import {
  diffWordIndex,
  type FixtureDiff,
  type IndexedSpan,
  type SpanChange,
  type WordIndexBaseline,
  type WordIndexFixture,
} from "../lib/wordIndexFixture";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "fixtures/word-index");
const ACCEPT = process.env.INDEX_ACCEPT === "1";

const fixtureFiles = existsSync(FIXTURE_DIR)
  ? readdirSync(FIXTURE_DIR)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".baseline.json"))
      .sort()
  : [];

function decision(o: IndexedSpan | null): string {
  if (!o) return "—";
  return `${o.headword}${o.reading ? `《${o.reading}》` : ""} #${o.entryId ?? "—"}`;
}

function changeLine(content: string, c: SpanChange): string {
  const arrow =
    c.toward === "toward-expected"
      ? "  ✓ toward your curated index"
      : c.toward === "away-from-expected"
        ? "  ✗ AWAY from your curated index"
        : "";
  const text = content.slice(c.start, c.end);
  return `    [${c.start},${c.end}] 「${text}」 ${decision(c.before)} → ${decision(c.after)}${arrow}`;
}

function regressionLines(content: string, diff: FixtureDiff): string {
  return diff.results
    .filter((r) => r.status === "regression")
    .map(
      (r) =>
        `    [${r.start},${r.end}] 「${content.slice(r.start, r.end)}」 ` +
        `want ${decision(r.expected)} · got ${decision(r.actual)}`
    )
    .join("\n");
}

function summaryLine(name: string, diff: FixtureDiff): string {
  const pct = Math.round(diff.accuracy * 100);
  const bits = [`${diff.matched + diff.improvements}/${diff.total} spans (${pct}%)`];
  if (diff.improvements) bits.push(`${diff.improvements} improvement(s)`);
  if (diff.knownGaps) bits.push(`${diff.knownGaps} known gap(s)`);
  if (diff.regressions) bits.push(`${diff.regressions} regression(s)`);
  if (diff.extra) bits.push(`${diff.extra} extra`);
  return `${name} — ${bits.join(" · ")}`;
}

const corpus: Array<{ name: string; diff: FixtureDiff }> = [];

beforeAll(async () => {
  if (fixtureFiles.length > 0) await setupHeadlessDictionary();
}, 120_000);

afterAll(() => {
  if (corpus.length === 0) return;
  const total = corpus.reduce((n, c) => n + c.diff.total, 0);
  const correct = corpus.reduce(
    (n, c) => n + c.diff.matched + c.diff.improvements,
    0
  );
  const gaps = corpus.reduce((n, c) => n + c.diff.knownGaps, 0);
  const pct = total === 0 ? 100 : Math.round((correct / total) * 100);
  console.log(
    `\n─ word-index corpus ─ ${corpus.length} fixture(s)\n` +
      `  ${correct}/${total} spans correct (${pct}%) · ${gaps} known gap(s)`
  );
});

describe("word-index fixtures", () => {
  if (fixtureFiles.length === 0) {
    it("has no fixtures yet — export one from a story to add a regression case", () => {
      expect(fixtureFiles).toEqual([]);
    });
    return;
  }

  for (const file of fixtureFiles) {
    const slug = file.replace(/\.json$/, "");

    it(
      slug,
      async () => {
        const fixture = JSON.parse(
          readFileSync(path.join(FIXTURE_DIR, file), "utf8")
        ) as WordIndexFixture;

        const actual = await extractWordOccurrences({
          content: fixture.content,
        });

        const baselinePath = path.join(FIXTURE_DIR, `${slug}.baseline.json`);
        const baseline: IndexedSpan[] | null = existsSync(baselinePath)
          ? (JSON.parse(readFileSync(baselinePath, "utf8")) as WordIndexBaseline)
              .occurrences
          : null;

        const diff = diffWordIndex(actual, fixture.expected, baseline);
        corpus.push({ name: fixture.meta.title || slug, diff });

        const writeBaseline = (): void => {
          const data: WordIndexBaseline = {
            generatedAt: new Date().toISOString(),
            occurrences: actual,
          };
          writeFileSync(baselinePath, JSON.stringify(data, null, 2) + "\n");
        };

        const log: string[] = [summaryLine(slug, diff)];

        if (!diff.hasBaseline) {
          writeBaseline();
          log.push(`  · baseline created (${actual.length} spans)`);
        } else if (diff.behaviorChanged.length > 0) {
          log.push(
            `  behaviour changed on ${diff.behaviorChanged.length} span(s):`
          );
          for (const c of diff.behaviorChanged) {
            log.push(changeLine(fixture.content, c));
          }
          if (ACCEPT) {
            writeBaseline();
            log.push(`  · baseline updated — accepted the change(s) above`);
          } else {
            log.push(
              `  → review, then \`npm run test:index:accept\` to bless, ` +
                `or fix the algorithm`
            );
          }
        }
        if (diff.regressions > 0) {
          log.push(`  ${diff.regressions} regression(s):`);
          log.push(regressionLines(fixture.content, diff));
        }
        console.log(log.join("\n"));

        // A broken once-correct span is always a hard failure — `--accept`
        // updates the baseline but cannot mask a divergence from the curated
        // truth (re-export the fixture if the new behaviour is genuinely
        // correct).
        expect(
          diff.regressions,
          `${slug}: algorithm broke ${diff.regressions} curated span(s):\n` +
            regressionLines(fixture.content, diff)
        ).toBe(0);

        // Any change since the baseline fails the run unless explicitly
        // accepted — this is the "flag if behaviour ever changes" guarantee.
        if (diff.hasBaseline && !ACCEPT) {
          expect(
            diff.behaviorChanged.length,
            `${slug}: detection changed on ${diff.behaviorChanged.length} ` +
              `span(s) since the baseline:\n` +
              diff.behaviorChanged
                .map((c) => changeLine(fixture.content, c))
                .join("\n") +
              `\nRun \`npm run test:index:accept\` to bless these.`
          ).toBe(0);
        }
      },
      30_000
    );
  }
});
