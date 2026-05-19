// Joins jmdict-simplified entries with the existing surface-keyed JPDB index
// (client/public/frequency/jpdb.json) to produce a per-JMdict-entry rank file
// at client/public/frequency/jpdb-by-entry.json.
//
// Why: JPDB's Yomitan export keys ranks by (surface, reading) pairs with no
// awareness of which JMdict entry a pair belongs to. For homophones like the
// kana surface くらい — shared between 暗い (i-adjective) and 位 (suffix
// "approximately") — the (くらい, くらい) rank in JPDB refers to *one* of
// those entries, not both. Without joining by JMdict EID we'd happily pull
// the 位 rank into 暗い's variant list (the original bug).
//
// Source: https://github.com/scriptin/jmdict-simplified — download the
// jmdict-eng-X.Y.Z+yyyymmdd.json.tgz from the latest release and pass its path.
// Run: npm run generate-frequency-by-entry -- path/to/jmdict-eng-*.json[.tgz]

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

const arg = process.argv[2];
if (!arg) {
  console.error(
    "usage: tsx scripts/generate-jpdb-frequency-by-entry.ts <path-to-jmdict-simplified-json-or-tgz>"
  );
  process.exit(1);
}

const SRC_PATH = resolve(arg);
const FREQ_DIR = resolve(__dirname, "..", "client", "public", "frequency");
const JPDB_PATH = resolve(FREQ_DIR, "jpdb.json");
const OUT_PATH = resolve(FREQ_DIR, "jpdb-by-entry.json");

if (!existsSync(JPDB_PATH)) {
  console.error(
    `Missing ${JPDB_PATH}. Run \`npm run generate-frequency\` first to produce the surface-keyed JPDB index that this script joins against.`
  );
  process.exit(1);
}

// The jmdict-simplified release artefact is `jmdict-eng-X.Y.Z+yyyymmdd.json.tgz`
// containing a single JSON. Accept either the archive or the extracted JSON.
let jsonPath = SRC_PATH;
if (SRC_PATH.endsWith(".tgz") || SRC_PATH.endsWith(".tar.gz")) {
  const workDir = `${tmpdir()}/jmdict-${Date.now()}`;
  mkdirSync(workDir, { recursive: true });
  execSync(`tar -xzf "${SRC_PATH}" -C "${workDir}"`, { stdio: "ignore" });
  const jsonFiles = readdirSync(workDir).filter((f) => f.endsWith(".json"));
  if (jsonFiles.length !== 1) {
    console.error(`Expected 1 JSON inside archive, found ${jsonFiles.length}`);
    process.exit(1);
  }
  jsonPath = `${workDir}/${jsonFiles[0]}`;
}

interface JmdictKanji {
  common: boolean;
  text: string;
  tags: string[];
}
interface JmdictKana {
  common: boolean;
  text: string;
  tags: string[];
  // ["*"] means "applies to all kanji forms"; otherwise a subset of kanji texts.
  appliesToKanji: string[];
}
interface JmdictSense {
  misc?: string[];
  // ...other fields not relevant here.
}
interface JmdictEntry {
  id: string;
  kanji?: JmdictKanji[];
  kana: JmdictKana[];
  sense: JmdictSense[];
}
interface JmdictDoc {
  words: JmdictEntry[];
}

console.log(`Reading JMdict: ${jsonPath}`);
const jmdict: JmdictDoc = JSON.parse(readFileSync(jsonPath, "utf-8"));
console.log(`  ${jmdict.words.length.toLocaleString()} entries`);

console.log(`Reading JPDB index: ${JPDB_PATH}`);
type JpdbIndex = Record<string, Array<[string | null, number]>>;
const jpdb: JpdbIndex = JSON.parse(readFileSync(JPDB_PATH, "utf-8"));
console.log(`  ${Object.keys(jpdb).length.toLocaleString()} surface forms`);

// Mirrors lib/frequency.ts: prefer an exact (surface, reading) match, fall
// back to the lowest rank for any reading of `surface`.
function rankFor(surface: string, reading: string | null): number | null {
  const entries = jpdb[surface];
  if (!entries || entries.length === 0) return null;
  if (reading) {
    const match = entries.find(([r]) => r === reading);
    if (match) return match[1];
  }
  return entries[0]![1];
}

interface OutEntry {
  rank: number;
  // The (kanji or kana) surface that produced the winning rank — i.e. the
  // "most common spelling" the popover should display in its sticky header.
  headword: string;
  reading: string | null;
  // The JMdict canonical surface — k[0] when the entry has kanji forms,
  // otherwise r[0]. This is what `headwordFromHit` stamps on word_lookups
  // and story_word_occurrences rows, so VocabContext can map an encounter
  // stamp back to its JMdict entry without an IDB round-trip.
  canonical: string;
}

type Variant = { rank: number; headword: string; reading: string | null };

// Phase 1, per entry: the best rank over its *unambiguous* forms (kanji forms
// joined by (surface, reading), or — for a kana-only entry — its kana surface),
// plus the bare-kana ranks it *would* claim if it owns them.
interface Pending {
  id: string;
  canonical: string;
  // Best variant from forms whose JPDB rank is unambiguous: a (kanji, reading)
  // join, or a kana-only entry's own kana surface. Null when none are ranked.
  unambiguousBest: Variant | null;
  // Bare-kana surface → its JPDB rank, for each `uk` kana reading of an entry
  // that *also* has kanji. Contended: a kana surface like いる is one JPDB
  // vocab item (居る) yet several `uk` homophones (要る, 癒る) read it. Resolved
  // in phase 2 — only the dominant homophone keeps it.
  kanaClaims: Map<string, number>;
}

const pendings: Pending[] = [];

for (const entry of jmdict.words) {
  // Whether this entry's senses tolerate kana-only spelling — when true, the
  // bare kana surface in JPDB *may* refer to this entry. The reverse case
  // (entry has kanji but no `uk`) is the 暗い vs 位/くらい collision: 暗い is not
  // `uk`, so JPDB's (くらい, null) rank belongs to 位.
  const isUk = entry.sense.some((s) => s.misc?.includes("uk"));
  // Drop search-only kanji forms (`sK`). JMdict says these never display; if
  // JPDB has a rank for the surface it almost certainly belongs to a different
  // lexeme (e.g. の's entry 1469800 has 乃 and 之 both `sK`, and the (乃, の)
  // rank 13652 has nothing to do with the particle). When the surviving kanji
  // list is empty the entry is treated as kana-only.
  const displayableKanji = (entry.kanji ?? []).filter(
    (k) => !k.tags.includes("sK")
  );
  // The canonical surface is the stamp the indexer writes on every occurrence
  // of this entry — it must agree with `headwordFromHit` so VocabContext can
  // round-trip a stamp back to its entry. Use the first *displayable* kanji,
  // not k[0] outright, otherwise の's canonical would be 乃 and stamps would
  // never match the runtime headword.
  const canonical =
    displayableKanji.length > 0
      ? displayableKanji[0]!.text
      : entry.kana[0]?.text;
  if (!canonical) continue;

  let unambiguousBest: Variant | null = null;
  const consider = (v: Variant): void => {
    if (!unambiguousBest || v.rank < unambiguousBest.rank) unambiguousBest = v;
  };
  const kanaClaims = new Map<string, number>();

  if (displayableKanji.length > 0) {
    for (const kana of entry.kana) {
      const allowedKanji =
        kana.appliesToKanji[0] === "*"
          ? displayableKanji.map((k) => k.text)
          : kana.appliesToKanji.filter((t) =>
              displayableKanji.some((k) => k.text === t)
            );
      // (kanji, reading) joins are unambiguous — JPDB keys them by the kanji
      // surface, so the rank can't be stolen by a homophone.
      for (const k of allowedKanji) {
        const rank = rankFor(k, kana.text);
        if (rank !== null) consider({ rank, headword: k, reading: kana.text });
      }
      // The bare-kana rank is contended — only record the claim. Phase 2 hands
      // each kana surface to exactly one entry so 要る / 癒る don't all inherit
      // 居る's rank-18 just for sharing the reading いる.
      if (isUk) {
        const rank = rankFor(kana.text, null);
        if (rank !== null) {
          const prev = kanaClaims.get(kana.text);
          if (prev === undefined || rank < prev) kanaClaims.set(kana.text, rank);
        }
      }
    }
  } else {
    // No displayable kanji (kana-only entry, or every kanji form is `sK`).
    // The kana surface is the entry's only display form — treat it as
    // unambiguous (a kana-only entry genuinely *is* the word at that surface).
    for (const kana of entry.kana) {
      const rank = rankFor(kana.text, null);
      if (rank !== null) consider({ rank, headword: kana.text, reading: null });
    }
  }

  pendings.push({ id: entry.id, canonical, unambiguousBest, kanaClaims });
}

// Phase 2: hand each contended bare-kana surface to a single owner — the
// homophone JPDB actually means by it. JPDB writes its *most common* homophone
// in kana, so the owner is the claimant with the best unambiguous (kanji-form)
// rank; entries with no ranked kanji form sort last, ties broken by entry id.
const claimsByKana = new Map<string, Pending[]>();
for (const p of pendings) {
  for (const kanaText of p.kanaClaims.keys()) {
    let list = claimsByKana.get(kanaText);
    if (!list) claimsByKana.set(kanaText, (list = []));
    list.push(p);
  }
}
const kanaOwner = new Map<string, string>();
for (const [kanaText, claimants] of claimsByKana) {
  claimants.sort((a, b) => {
    const ra = a.unambiguousBest?.rank ?? Infinity;
    const rb = b.unambiguousBest?.rank ?? Infinity;
    if (ra !== rb) return ra - rb;
    return Number(a.id) - Number(b.id);
  });
  kanaOwner.set(kanaText, claimants[0]!.id);
}

// Phase 3: each entry's final rank is its unambiguous best, improved by a
// bare-kana claim only when it owns that surface.
const out: Record<string, OutEntry> = {};
let resolved = 0;
for (const p of pendings) {
  let best: Variant | null = p.unambiguousBest;
  for (const [kanaText, rank] of p.kanaClaims) {
    if (kanaOwner.get(kanaText) !== p.id) continue;
    if (!best || rank < best.rank) {
      best = { rank, headword: kanaText, reading: null };
    }
  }
  if (best) {
    out[p.id] = { ...best, canonical: p.canonical };
    resolved++;
  }
}

mkdirSync(FREQ_DIR, { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(out), "utf-8");
const sizeMb = (JSON.stringify(out).length / 1024 / 1024).toFixed(2);
console.log(
  `Wrote ${resolved.toLocaleString()} entry ranks (${sizeMb} MB) to ${OUT_PATH}`
);
