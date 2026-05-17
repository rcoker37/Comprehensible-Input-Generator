// Boots the real word-detection stack headlessly for Node/Vitest.
//
// The detection pipeline (regroupWords → lookupAtBoundary → extractWordOccurrences)
// depends on three data sources that are all browser-shaped in the app:
//   - JMdict via @birchill/jpdict-idb (IndexedDB + a CDN download)
//   - kuromoji (dict files fetched from /dict/)
//   - the JPDB frequency JSON (fetched from /frequency/)
//
// This harness makes all three work in a plain Node process so the fixture
// tests can run the *genuine* algorithm — not a mock — fully offline:
//   - fake-indexeddb + a `self` shim let jpdict-idb run without a browser
//   - a `fetch` stub replays a vendored jpdict snapshot and serves the
//     frequency JSON straight off disk. The snapshot (client/src/test/jpdict/)
//     is a gitignored build artifact — `ensureSnapshot` auto-records it from
//     the CDN on first use (it can also be refreshed via
//     `npm run record-test-dictionary`)
//   - kuromoji is pointed at a re-gzipped copy of its dict files (see
//     `ensureKuromojiDict`) via VITE_KUROMOJI_DICT_PATH
//
// After `setupHeadlessDictionary()` resolves, `getDictionaryState()` is "ready"
// and the whole pipeline behaves exactly as it does in the browser.

import { readFile } from "node:fs/promises";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import "fake-indexeddb/auto";

// jpdict-idb reaches for browser globals via `self` (setTimeout, navigator,
// requestIdleCallback). Node has the first two on globalThis; polyfill the
// idle-callback pair and alias `self` to globalThis.
(globalThis as { self?: unknown }).self ??= globalThis;
const g = globalThis as {
  requestIdleCallback?: (
    cb: (d: { didTimeout: boolean; timeRemaining: () => number }) => void
  ) => unknown;
  cancelIdleCallback?: (id: unknown) => void;
};
if (typeof g.requestIdleCallback !== "function") {
  g.requestIdleCallback = (cb) =>
    setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0);
  g.cancelIdleCallback = (id) =>
    clearTimeout(id as ReturnType<typeof setTimeout>);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.join(HERE, "jpdict");
const FREQUENCY_DIR = path.resolve(HERE, "../../public/frequency");
const KUROMOJI_PKG = path.resolve(
  HERE,
  "../../../node_modules/@aiktb/kuromoji"
);
const RECORD_SCRIPT = path.resolve(
  HERE,
  "../../../scripts/record-test-dictionary.mjs"
);

interface Manifest {
  files: Record<string, string>;
}

/**
 * The vendored JMdict snapshot is a gitignored build artifact (like
 * client/public/dict/). Record it from the CDN on the first run that needs it;
 * every run after reuses the files on disk. Returns the parsed manifest.
 */
function ensureSnapshot(): Manifest {
  const manifestPath = path.join(SNAPSHOT_DIR, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.log(
      "[headlessDictionary] JMdict snapshot missing — recording it from the " +
        "CDN (~20s, one-time)…"
    );
    try {
      execSync(`node ${JSON.stringify(RECORD_SCRIPT)}`, { stdio: "inherit" });
    } catch {
      throw new Error(
        "Failed to record the JMdict snapshot. Check your network connection, " +
          "or run `npm run record-test-dictionary` manually."
      );
    }
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

function installFetchStub(manifest: Manifest): void {
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      // jpdict-idb dictionary data — replay the recorded snapshot.
      const vendored = manifest.files[url];
      if (vendored) {
        const text = gunzipSync(
          await readFile(path.join(SNAPSHOT_DIR, vendored))
        ).toString("utf8");
        return new Response(text, { status: 200 });
      }

      // JPDB frequency indices — serve straight off disk.
      const freq = /\/frequency\/(jpdb(?:-by-entry)?\.json)$/.exec(url);
      if (freq) {
        const text = await readFile(
          path.join(FREQUENCY_DIR, freq[1]!),
          "utf8"
        );
        return new Response(text, { status: 200 });
      }

      throw new Error(
        `headlessDictionary: unexpected fetch ${url} — the test environment ` +
          `serves only the vendored jpdict snapshot and the frequency JSON.`
      );
    }
  );
}

/**
 * @aiktb/kuromoji ships its dict files uncompressed (its browser loader reads
 * them raw), but the Node loader gunzips every file it reads. Re-gzip the .dat
 * files into a temp cache the NodeDictionaryLoader can consume, keyed on the
 * kuromoji version so a dependency bump rebuilds it. Returns the cache path.
 */
function ensureKuromojiDict(): string {
  const version = (
    JSON.parse(
      readFileSync(path.join(KUROMOJI_PKG, "package.json"), "utf8")
    ) as { version: string }
  ).version;
  const cacheDir = path.join(os.tmpdir(), `cig-kuromoji-dict-${version}`);
  const marker = path.join(cacheDir, ".ready");
  if (existsSync(marker)) return cacheDir;
  mkdirSync(cacheDir, { recursive: true });
  const src = path.join(KUROMOJI_PKG, "dict");
  for (const file of readdirSync(src)) {
    if (!file.endsWith(".dat")) continue;
    writeFileSync(
      path.join(cacheDir, file),
      gzipSync(readFileSync(path.join(src, file)))
    );
  }
  writeFileSync(marker, version);
  return cacheDir;
}

let bootPromise: Promise<void> | null = null;

/**
 * Idempotent. Installs the shims and runs the real `initDictionary()` so the
 * detection pipeline can be exercised headlessly. The first call pays the
 * jpdict-idb populate cost (~15–20s) — plus a one-time snapshot record if the
 * vendored snapshot is absent; subsequent calls resolve immediately.
 */
export function setupHeadlessDictionary(): Promise<void> {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    vi.stubEnv("VITE_KUROMOJI_DICT_PATH", ensureKuromojiDict());
    installFetchStub(ensureSnapshot());
    const { initDictionary } = await import("../lib/dictionary");
    await initDictionary();
  })();
  return bootPromise;
}
