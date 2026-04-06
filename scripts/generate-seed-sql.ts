import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INPUT = resolve(__dirname, "..", "data", "kanji.json");
const OUTPUT = resolve(__dirname, "..", "supabase", "seed.sql");

interface KanjiEntry {
  character: string;
  grade: number | null;
  jlpt: number | null;
  meanings: string[];
  readings_on: string[];
  readings_kun: string[];
}

function escapeSQL(str: string): string {
  return str.replace(/'/g, "''");
}

const entries: KanjiEntry[] = JSON.parse(readFileSync(INPUT, "utf-8"));

const lines: string[] = [
  "-- Auto-generated kanji seed data",
  "-- Source: data/kanji.json (kanjiapi.dev)",
  "",
  "BEGIN;",
  "",
];

for (const e of entries) {
  const grade = e.grade ?? "NULL";
  const jlpt = e.jlpt ?? "NULL";
  const meanings = escapeSQL(e.meanings.join(", "));
  const on = escapeSQL(e.readings_on.join(", "));
  const kun = escapeSQL(e.readings_kun.join(", "));

  lines.push(
    `INSERT INTO kanji (character, grade, jlpt, meanings, readings_on, readings_kun) VALUES ('${e.character}', ${grade}, ${jlpt}, '${meanings}', '${on}', '${kun}') ON CONFLICT DO NOTHING;`
  );
}

lines.push("", "COMMIT;", "");

writeFileSync(OUTPUT, lines.join("\n"), "utf-8");
console.log(`Wrote ${entries.length} kanji to ${OUTPUT}`);
