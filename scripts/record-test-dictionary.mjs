// Records a pinned, offline snapshot of the @birchill/jpdict-idb dictionary
// data into client/src/test/jpdict/ so the word-index fixture tests can run
// the *real* JMdict lookup headlessly — no network, fully reproducible.
//
// jpdict-idb downloads its data from a hardcoded CDN (data.10ten.life). This
// script wraps `fetch`, runs a real `update()` against that CDN once, and
// tees every response body to disk (gzipped). The fixture test replays those
// files through a `fetch` stub, so the test exercises the genuine library
// against the exact same data the recording captured.
//
// Re-run this (`npm run record-test-dictionary`) only to bump the pinned
// JMdict version — it is otherwise a one-time vendoring step. Commit the
// regenerated client/src/test/jpdict/ directory.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "fake-indexeddb/auto";

// jpdict-idb reaches for browser globals via `self`.
globalThis.self = globalThis;
if (typeof globalThis.requestIdleCallback !== "function") {
  globalThis.requestIdleCallback = (cb) =>
    setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0);
  globalThis.cancelIdleCallback = (id) => clearTimeout(id);
}

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const OUT = path.join(ROOT, "client/src/test/jpdict");

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// Tee every dictionary-CDN response to disk. The body read via `.clone()`
// is already decompressed by undici (it honours Content-Encoding); we store
// it re-gzipped so the vendored snapshot stays small.
const realFetch = globalThis.fetch;
const manifest = {};
let count = 0;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  const res = await realFetch(input, init);
  if (url.includes("data.10ten.life")) {
    const body = await res.clone().text();
    const file =
      url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9._-]/g, "_") + ".gz";
    await writeFile(path.join(OUT, file), gzipSync(body));
    manifest[url] = file;
    count++;
    process.stdout.write(`\rrecorded ${count} files…`);
  }
  return res;
};

const { JpdictIdb } = await import("@birchill/jpdict-idb");
const db = new JpdictIdb();
await db.ready;

const t0 = Date.now();
await db.update({ series: "words", lang: "en" });
await db.update({ series: "kanji", lang: "en" });

await writeFile(
  path.join(OUT, "manifest.json"),
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      words: db.words.version,
      kanji: db.kanji.version,
      files: manifest,
    },
    null,
    2
  ) + "\n"
);

process.stdout.write("\n");
console.log(
  `done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${count} files; ` +
    `words=${db.words.state} kanji=${db.kanji.state}`
);
console.log(`snapshot written to ${path.relative(ROOT, OUT)}`);
