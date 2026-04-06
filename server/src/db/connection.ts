import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "..", "..", "data", "kanji.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanji (
      character TEXT PRIMARY KEY,
      grade INTEGER NOT NULL,
      jlpt INTEGER,
      known INTEGER NOT NULL DEFAULT 0,
      meanings TEXT NOT NULL,
      readings_on TEXT NOT NULL,
      readings_kun TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      paragraphs INTEGER NOT NULL,
      topic TEXT,
      formality TEXT NOT NULL,
      filters TEXT NOT NULL,
      allowed_kanji TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_kanji_grade ON kanji(grade);
    CREATE INDEX IF NOT EXISTS idx_kanji_jlpt ON kanji(jlpt);
    CREATE INDEX IF NOT EXISTS idx_kanji_known ON kanji(known);
  `);
}
