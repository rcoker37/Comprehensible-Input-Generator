/**
 * Fetches all joyo kanji data from kanjiapi.dev and writes it to kanji.json.
 *
 * Usage:
 *   npx tsx data/fetch-kanji.ts
 *
 * The script:
 *  1. Fetches the joyo kanji character list
 *  2. Fetches grade-level lists (grades 1-8) to build a grade mapping
 *  3. Fetches JLPT-level lists (levels 1-5) to build a JLPT mapping
 *  4. Fetches individual kanji details in batches with rate limiting
 *  5. Writes the combined result to data/kanji.json
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, "kanji.json");

const BASE_URL = "https://kanjiapi.dev/v1/kanji";
const BATCH_SIZE = 50;
const DELAY_BETWEEN_BATCHES_MS = 1000;

interface KanjiApiResponse {
  kanji: string;
  grade: number | null;
  jlpt: number | null;
  meanings: string[];
  kun_readings: string[];
  on_readings: string[];
}

interface KanjiEntry {
  character: string;
  grade: number | null;
  jlpt: number | null;
  meanings: string[];
  readings_on: string[];
  readings_kun: string[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchInBatches(
  characters: string[],
  batchSize: number,
  delayMs: number,
): Promise<KanjiEntry[]> {
  const results: KanjiEntry[] = [];
  const total = characters.length;

  for (let i = 0; i < total; i += batchSize) {
    const batch = characters.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(total / batchSize);
    process.stdout.write(
      `\r  Batch ${batchNum}/${totalBatches} (${results.length}/${total} kanji fetched)`,
    );

    const batchResults = await Promise.all(
      batch.map(async (char) => {
        const data = await fetchJson<KanjiApiResponse>(
          `${BASE_URL}/${encodeURIComponent(char)}`,
        );
        return {
          character: data.kanji,
          grade: data.grade,
          jlpt: data.jlpt,
          meanings: data.meanings,
          readings_on: data.on_readings,
          readings_kun: data.kun_readings,
        } satisfies KanjiEntry;
      }),
    );

    results.push(...batchResults);

    if (i + batchSize < total) {
      await sleep(delayMs);
    }
  }

  process.stdout.write(
    `\r  Done: ${results.length}/${total} kanji fetched.          \n`,
  );
  return results;
}

async function main() {
  console.log("Fetching joyo kanji list...");
  const joyoKanji = await fetchJson<string[]>(`${BASE_URL}/joyo`);
  console.log(`  Found ${joyoKanji.length} joyo kanji.`);

  // Build grade mapping from grade endpoints (as a fallback/verification)
  console.log("Building grade mapping...");
  const gradeMap = new Map<string, number>();
  for (const grade of [1, 2, 3, 4, 5, 6, 8]) {
    const chars = await fetchJson<string[]>(`${BASE_URL}/grade-${grade}`);
    for (const c of chars) {
      gradeMap.set(c, grade);
    }
    console.log(`  Grade ${grade}: ${chars.length} kanji`);
  }

  // Build JLPT mapping from JLPT endpoints
  console.log("Building JLPT mapping...");
  const jlptMap = new Map<string, number>();
  for (let level = 1; level <= 5; level++) {
    const chars = await fetchJson<string[]>(`${BASE_URL}/jlpt-${level}`);
    for (const c of chars) {
      jlptMap.set(c, level);
    }
    console.log(`  JLPT N${level}: ${chars.length} kanji`);
  }

  // Fetch individual kanji details in batches
  console.log(
    `Fetching individual kanji details (${joyoKanji.length} kanji, batch size ${BATCH_SIZE})...`,
  );
  const entries = await fetchInBatches(
    joyoKanji,
    BATCH_SIZE,
    DELAY_BETWEEN_BATCHES_MS,
  );

  // Merge in grade/JLPT data from the list endpoints as fallback
  // (the individual endpoint should already have these, but just in case)
  for (const entry of entries) {
    if (entry.grade == null && gradeMap.has(entry.character)) {
      entry.grade = gradeMap.get(entry.character)!;
    }
    if (entry.jlpt == null && jlptMap.has(entry.character)) {
      entry.jlpt = jlptMap.get(entry.character)!;
    }
  }

  // Sort by grade (nulls last), then by character code point
  entries.sort((a, b) => {
    const gradeA = a.grade ?? 99;
    const gradeB = b.grade ?? 99;
    if (gradeA !== gradeB) return gradeA - gradeB;
    return a.character.codePointAt(0)! - b.character.codePointAt(0)!;
  });

  // Write output
  writeFileSync(OUTPUT_PATH, JSON.stringify(entries, null, 2) + "\n", "utf-8");
  console.log(`\nWrote ${entries.length} kanji to ${OUTPUT_PATH}`);

  // Summary
  const withGrade = entries.filter((e) => e.grade != null).length;
  const withJlpt = entries.filter((e) => e.jlpt != null).length;
  console.log(`  With grade data: ${withGrade}`);
  console.log(`  With JLPT data: ${withJlpt}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
