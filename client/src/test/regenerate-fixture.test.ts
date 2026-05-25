// Tracer test for `npm run test:index:regenerate` — re-runs the indexer on a
// fixture's content and writes the output into its `expected[]`, also
// bumping `meta.wordIndexVersion` to the current value.
//
// Driven by env vars set by scripts/regenerate-fixture.mjs. When the env
// vars are absent (e.g. `npm test`), the test suite skips itself.
//
// This is the right tool for a fixture exported from an *uncurated* story
// (every span `manual: false`) after the algorithm has been fixed — it
// blesses the new algorithm output as the new expected. It is NOT the right
// tool when the operator hand-curated overrides: those are `manual: true`
// spans which would need to be reapplied.

import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";

const FIXTURE_PATH = process.env.REGENERATE_FIXTURE_PATH;
const ACTIVE = FIXTURE_PATH !== undefined;

describe.skipIf(!ACTIVE)("regenerate-fixture", () => {
  beforeAll(async () => {
    const { setupHeadlessDictionary } = await import("./headlessDictionary");
    await setupHeadlessDictionary();
  }, 120_000);

  it("regenerate", async () => {
    const { extractWordOccurrences, WORD_INDEX_VERSION } = await import(
      "../lib/storyWordIndex"
    );
    const fixturePath = FIXTURE_PATH!;
    const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
      meta?: { wordIndexVersion?: number };
      content: string;
      expected: unknown[];
    };
    const previousCount = fixture.expected.length;

    const occs = await extractWordOccurrences({ content: fixture.content });
    fixture.expected = occs.map((o) => ({ ...o, manual: false }));
    fixture.meta = { ...(fixture.meta ?? {}), wordIndexVersion: WORD_INDEX_VERSION };

    writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n");

    // eslint-disable-next-line no-console
    console.log(
      `Regenerated ${fixturePath}: ${previousCount} → ${occs.length} spans, ` +
        `wordIndexVersion=${WORD_INDEX_VERSION}`
    );
    expect(true).toBe(true);
  });
});
