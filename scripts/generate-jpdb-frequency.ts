// Converts a JPDB Yomitan frequency dictionary zip into a compact JSON
// shipped at client/public/frequency/jpdb.json.
//
// Source: https://github.com/Kuuuube/yomitan-dictionaries
// Run: npm run generate-frequency -- path/to/JPDB_v2.2_Frequency_*.zip
//
// Yomitan term_meta_bank entries take two shapes:
//   ["の", "freq", { value: 1, displayValue: "1" }]
//   ["何", "freq", { reading: "なん", frequency: { value: 101, displayValue: "101" } }]
//
// Output: { headword: [[reading|null, rank], ...] } sorted by rank ascending
// within each headword. Entries with null reading are deduped to keep only the
// lowest rank (homographs without reading disambiguation are unresolvable
// downstream anyway). Capped at MAX_RANK to keep the asset small — the JPDB
// docs say rank ≤ 100,000 covers 98.6% of the corpus, and anything rarer falls
// back to a generic "very rare" tier client-side without a precise rank.
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

const arg = process.argv[2];
if (!arg) {
  console.error("usage: tsx scripts/generate-jpdb-frequency.ts <path-to-jpdb-zip>");
  process.exit(1);
}

const ZIP_PATH = resolve(arg);
const OUT_DIR = resolve(__dirname, "..", "client", "public", "frequency");
const OUT_PATH = resolve(OUT_DIR, "jpdb.json");
const MAX_RANK = 100_000;

const workDir = `${tmpdir()}/jpdb-${Date.now()}`;
mkdirSync(workDir, { recursive: true });
execSync(`unzip -o "${ZIP_PATH}" -d "${workDir}"`, { stdio: "ignore" });

type RawValue =
  | { value: number; displayValue?: string }
  | { reading: string; frequency: { value: number; displayValue?: string } };

const raw: Array<[string, "freq", RawValue]> = JSON.parse(
  readFileSync(`${workDir}/term_meta_bank_1.json`, "utf-8")
);

const byTerm = new Map<string, Map<string | null, number>>();

for (const [term, , value] of raw) {
  let reading: string | null;
  let rank: number;
  if ("reading" in value) {
    reading = value.reading;
    rank = value.frequency.value;
  } else {
    reading = null;
    rank = value.value;
  }
  if (rank > MAX_RANK) continue;

  let bucket = byTerm.get(term);
  if (!bucket) {
    bucket = new Map();
    byTerm.set(term, bucket);
  }
  const existing = bucket.get(reading);
  if (existing === undefined || rank < existing) {
    bucket.set(reading, rank);
  }
}

// Emit as `{ headword: [[reading_or_null, rank], ...] }` sorted by rank.
const out: Record<string, Array<[string | null, number]>> = {};
for (const [term, readings] of byTerm) {
  const entries = [...readings.entries()].sort((a, b) => a[1] - b[1]);
  out[term] = entries.map(([r, n]) => [r, n]);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(out), "utf-8");

const sizeMb = (JSON.stringify(out).length / 1024 / 1024).toFixed(2);
console.log(
  `Wrote ${byTerm.size.toLocaleString()} headwords (rank ≤ ${MAX_RANK.toLocaleString()}, ${sizeMb} MB) to ${OUT_PATH}`
);
