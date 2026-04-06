import { getDb } from "./connection.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import type { KanjiSeedEntry } from "../types/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "..", "..", "data", "kanji.json");

function seed() {
  const raw = readFileSync(DATA_PATH, "utf-8");
  const entries: KanjiSeedEntry[] = JSON.parse(raw);

  const db = getDb();

  const existing = db.prepare("SELECT COUNT(*) as count FROM kanji").get() as {
    count: number;
  };
  if (existing.count > 0) {
    console.log(
      `Database already has ${existing.count} kanji. Skipping seed.`
    );
    return;
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO kanji (character, grade, jlpt, known, meanings, readings_on, readings_kun)
    VALUES (?, ?, ?, 0, ?, ?, ?)
  `);

  const insertMany = db.transaction((entries: KanjiSeedEntry[]) => {
    for (const entry of entries) {
      insert.run(
        entry.character,
        entry.grade,
        entry.jlpt,
        entry.meanings.join(", "),
        entry.readings_on.join(", "),
        entry.readings_kun.join(", ")
      );
    }
  });

  insertMany(entries);
  console.log(`Seeded ${entries.length} kanji into the database.`);
}

seed();
