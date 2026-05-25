#!/usr/bin/env node
// CLI wrapper for `npm run test:index:suspects` — re-runs the indexer on a
// fixture and flags low-confidence stamps (suspicious-misc, single 固有名詞
// not marked isName, much-better-ranked sibling exists). Pair with
// `npm run debug:span` to drill into anything flagged.
//
// Examples:
//   npm run test:index:suspects -- 千花

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
    "Usage: npm run test:index:suspects -- <fixture-substring | path>\n"
  );
  process.exit(2);
}

let fixturePath = args[0];
if (!fixturePath.endsWith(".json") || !existsSync(fixturePath)) {
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
      `"${fixturePath}" matched ${matches.length} — narrow it:\n  ${matches.join("\n  ")}\n`
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
    "src/test/suspect-matches.test.ts",
  ],
  {
    cwd: path.join(ROOT, "client"),
    env: { ...process.env, SUSPECTS_FIXTURE_PATH: fixturePath },
    stdio: "inherit",
  }
);
process.exit(result.status ?? 1);
