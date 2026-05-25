#!/usr/bin/env node
// CLI wrapper for `npm run test:index:regenerate` — re-runs the indexer on
// a fixture's content and writes the output as the new `expected[]`. Use
// this to bless algorithm changes into an uncurated fixture after you've
// reviewed the diff (`npm run test:index` first).
//
// Examples:
//   npm run test:index:regenerate -- 千花
//   npm run test:index:regenerate -- 千花ちかのボウリング教室きょうしつ
//   npm run test:index:regenerate -- client/src/test/fixtures/word-index/foo.json
//
// First arg is either a fixture filename / path, or a substring of one. The
// matcher requires a unique match.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIXTURE_DIR = path.join(
  ROOT,
  "client/src/test/fixtures/word-index"
);

const args = process.argv.slice(2);
if (args.length !== 1) {
  process.stderr.write(
    [
      "Usage: npm run test:index:regenerate -- <fixture-substring | path>",
      "",
      "Re-runs extractWordOccurrences on the fixture's content and writes",
      "the result as the new `expected[]`. Caveat: only use this on a fixture",
      "with no manual:true overrides — those would be silently wiped.",
      "",
    ].join("\n")
  );
  process.exit(2);
}

let fixturePath = args[0];
if (!fixturePath.endsWith(".json") || !existsSync(fixturePath)) {
  // Substring match against fixture filenames.
  const files = existsSync(FIXTURE_DIR)
    ? readdirSync(FIXTURE_DIR).filter(
        (f) => f.endsWith(".json") && !f.endsWith(".baseline.json")
      )
    : [];
  const matches = files.filter((f) => f.includes(fixturePath));
  if (matches.length === 0) {
    process.stderr.write(
      `No fixture matched "${fixturePath}". Available:\n  ${files.join("\n  ")}\n`
    );
    process.exit(2);
  }
  if (matches.length > 1) {
    process.stderr.write(
      `"${fixturePath}" matched ${matches.length} fixtures — narrow it:\n  ${matches.join("\n  ")}\n`
    );
    process.exit(2);
  }
  fixturePath = path.join(FIXTURE_DIR, matches[0]);
}

const result = spawnSync(
  "npx",
  [
    "vitest",
    "run",
    "--project=tools",
    "--disable-console-intercept",
    "src/test/regenerate-fixture.test.ts",
  ],
  {
    cwd: path.join(ROOT, "client"),
    env: { ...process.env, REGENERATE_FIXTURE_PATH: fixturePath },
    stdio: "inherit",
  }
);
process.exit(result.status ?? 1);
