// Quick CLI to look up a Japanese surface against the vendored JMdict
// snapshot. Useful for sanity-checking what `lookupWord` returns when
// designing or debugging boundary / deinflection logic — answers questions
// like "is na-adj 静か `adj-na` or `n`?" or "how many entries read なる?"
// without booting the full headless test harness through Vitest.
//
//   npm run jmdict-lookup -- 静か
//   npm run jmdict-lookup -- な
//
// Reuses `client/src/test/jpdict/` (the snapshot the word-index suite
// auto-records). If the snapshot is missing, run `npm run test:index` once
// to create it, then re-run this script.

import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import "fake-indexeddb/auto";

// jpdict-idb reaches for browser globals: `self` and requestIdleCallback.
(globalThis as { self?: unknown }).self ??= globalThis;
const g = globalThis as {
  requestIdleCallback?: (cb: () => void) => unknown;
  cancelIdleCallback?: (id: unknown) => void;
};
g.requestIdleCallback ??= (cb) => setTimeout(cb, 0);
g.cancelIdleCallback ??= (id) =>
  clearTimeout(id as ReturnType<typeof setTimeout>);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.resolve(HERE, "../client/src/test/jpdict");
const MANIFEST_PATH = path.join(SNAPSHOT_DIR, "manifest.json");

if (!existsSync(MANIFEST_PATH)) {
  console.error(
    `JMdict snapshot missing at ${SNAPSHOT_DIR}. Run \`npm run test:index\` ` +
      `once to record it, then re-run this script.`
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
  files: Record<string, string>;
};

globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const vendored = manifest.files[url];
  if (!vendored) {
    throw new Error(`jmdict-lookup: unexpected fetch ${url}`);
  }
  const text = gunzipSync(
    await readFile(path.join(SNAPSHOT_DIR, vendored))
  ).toString("utf8");
  return new Response(text, { status: 200 });
}) as typeof fetch;

const surface = process.argv[2];
if (!surface) {
  console.error("Usage: npm run jmdict-lookup -- <surface>");
  process.exit(1);
}

async function main(): Promise<void> {
  const { initDictionary, lookupWord } = await import(
    "../client/src/lib/dictionary.ts"
  );
  await initDictionary();

  const results = await lookupWord(surface!);
  if (results.length === 0) {
    console.log(`No JMdict entries for 「${surface}」.`);
    return;
  }

  console.log(`「${surface}」 — ${results.length} entry/entries:\n`);
  for (const wr of results) {
    const kanji = (wr.k ?? [])
      .map((k) => `${k.ent}${(k.i ?? []).includes("sK") ? " [sK]" : ""}`)
      .join(", ");
    const readings = (wr.r ?? []).map((r) => r.ent).join(", ");
    console.log(`#${wr.id}  k=[${kanji}]  r=[${readings}]`);
    for (const [i, sense] of (wr.s ?? []).entries()) {
      const glosses = (sense.g ?? []).map((g) => g.str).join("; ");
      const pos = (sense.pos ?? []).join(",");
      const misc = (sense.misc ?? []).join(",");
      const tags = [pos && `pos=${pos}`, misc && `misc=${misc}`]
        .filter(Boolean)
        .join("  ");
      console.log(`  ${i + 1}. ${tags ? `(${tags}) ` : ""}${glosses}`);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
