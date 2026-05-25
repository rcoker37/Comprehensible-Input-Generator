#!/usr/bin/env node
// CLI wrapper for `npm run debug:span` — dumps the indexer pipeline for one
// span without forcing the operator to write a one-off vitest trace test.
//
// Examples:
//   npm run debug:span -- "藤原千花さんは" 2 4
//   npm run debug:span -- "@千花" 95 97
//
// First arg is either raw text (with optional Aozora ruby — the test strips
// it and works in cleanText offsets) or `@<fixture-slug-substring>` to load
// the matching fixture's content. The slug match is a substring against the
// .json filenames in client/src/test/fixtures/word-index/, so a unique short
// prefix is enough.
//
// The test always passes (this is a debug tool, not a regression check) and
// prints a structured JSON trace covering kuromoji tokens, JMdict exact
// hits, deinflection candidates, and the final `lookupAtBoundary` result —
// enough to diagnose "why did the indexer pick that entry?" without booting
// the full app.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIXTURE_DIR = path.join(
  ROOT,
  "client/src/test/fixtures/word-index"
);

const args = process.argv.slice(2);

const usage = () => {
  process.stderr.write(
    [
      "Usage:",
      "  npm run debug:span -- <text | @fixture-slug> <start> [<end>]",
      "",
      "Examples:",
      "  npm run debug:span -- \"藤原千花さんは\" 2 4",
      "  npm run debug:span -- \"@千花\" 95 97",
      "",
      "Notes:",
      "  - start/end are char offsets into the cleaned content (ruby stripped).",
      "  - end defaults to start+1 if omitted.",
      "  - @<slug> loads a fixture by substring-matching its filename.",
      "",
    ].join("\n")
  );
  process.exit(2);
};

if (args.length < 2 || args.length > 3) usage();

let text = args[0];
const start = Number(args[1]);
const end = args[2] !== undefined ? Number(args[2]) : start + 1;
if (!Number.isFinite(start) || !Number.isFinite(end)) usage();

if (text.startsWith("@")) {
  const slug = text.slice(1);
  const files = existsSync(FIXTURE_DIR)
    ? readdirSync(FIXTURE_DIR).filter(
        (f) => f.endsWith(".json") && !f.endsWith(".baseline.json")
      )
    : [];
  const matches = files.filter((f) => f.includes(slug));
  if (matches.length === 0) {
    process.stderr.write(
      `No fixture matched "@${slug}". Available:\n  ${files.join("\n  ")}\n`
    );
    process.exit(2);
  }
  if (matches.length > 1) {
    process.stderr.write(
      `Slug "@${slug}" matched ${matches.length} fixtures — narrow it:\n  ${matches.join("\n  ")}\n`
    );
    process.exit(2);
  }
  const fixture = JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, matches[0]), "utf8")
  );
  text = fixture.content;
  process.stderr.write(`(loaded fixture: ${matches[0]})\n`);
}

const result = spawnSync(
  "npx",
  [
    "vitest",
    "run",
    "--project=tools",
    "--disable-console-intercept",
    "src/test/debug-span.test.ts",
  ],
  {
    cwd: path.join(ROOT, "client"),
    env: {
      ...process.env,
      DEBUG_SPAN_TEXT: text,
      DEBUG_SPAN_START: String(start),
      DEBUG_SPAN_END: String(end),
    },
    stdio: "inherit",
  }
);
process.exit(result.status ?? 1);
