import { getDb } from "../db/connection.js";
import { extractKanji } from "./validation.js";
import type { DifficultyEstimate } from "../types/index.js";

export function computeDifficulty(story: string): DifficultyEstimate {
  const db = getDb();
  const usedKanji = extractKanji(story);

  if (usedKanji.length === 0) {
    return {
      uniqueKanji: 0,
      grade: { max: 0, avg: 0 },
      jlpt: { min: 0, avg: 0 },
    };
  }

  const placeholders = usedKanji.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT grade, jlpt FROM kanji WHERE character IN (${placeholders})`
    )
    .all(...usedKanji) as { grade: number; jlpt: number | null }[];

  const grades = rows.map((r) => r.grade);
  const jlpts = rows.filter((r) => r.jlpt != null).map((r) => r.jlpt!);

  return {
    uniqueKanji: usedKanji.length,
    grade: {
      max: grades.length > 0 ? Math.max(...grades) : 0,
      avg:
        grades.length > 0
          ? Math.round((grades.reduce((a, b) => a + b, 0) / grades.length) * 10) / 10
          : 0,
    },
    jlpt: {
      min: jlpts.length > 0 ? Math.min(...jlpts) : 0,
      avg:
        jlpts.length > 0
          ? Math.round((jlpts.reduce((a, b) => a + b, 0) / jlpts.length) * 10) / 10
          : 0,
    },
  };
}
