import { Router, type Request, type Response } from "express";
import { getDb } from "../db/connection.js";

const router = Router();

router.get("/", (req: Request, res: Response) => {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (req.query.known === "true") {
    conditions.push("known = 1");
  } else if (req.query.known === "false") {
    conditions.push("known = 0");
  }

  if (req.query.jlpt) {
    const levels = String(req.query.jlpt).split(",").map(Number);
    conditions.push(`jlpt IN (${levels.map(() => "?").join(",")})`);
    params.push(...levels);
  }

  if (req.query.grade) {
    const grades = String(req.query.grade).split(",").map(Number);
    conditions.push(`grade IN (${grades.map(() => "?").join(",")})`);
    params.push(...grades);
  }

  if (req.query.search) {
    const search = `%${String(req.query.search)}%`;
    conditions.push(
      "(character LIKE ? OR meanings LIKE ? OR readings_on LIKE ? OR readings_kun LIKE ?)"
    );
    params.push(search, search, search, search);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM kanji ${where} ORDER BY grade, character`).all(...params);

  res.json(rows);
});

router.get("/stats", (_req: Request, res: Response) => {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) as count FROM kanji").get() as { count: number };
  const known = db.prepare("SELECT COUNT(*) as count FROM kanji WHERE known = 1").get() as { count: number };
  res.json({ total: total.count, known: known.count });
});

router.get("/count", (req: Request, res: Response) => {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (req.query.knownOnly === "true") {
    conditions.push("known = 1");
  }

  if (req.query.jlpt) {
    const levels = String(req.query.jlpt).split(",").map(Number);
    conditions.push(`jlpt IN (${levels.map(() => "?").join(",")})`);
    params.push(...levels);
  }

  if (req.query.grade) {
    const grades = String(req.query.grade).split(",").map(Number);
    conditions.push(`grade IN (${grades.map(() => "?").join(",")})`);
    params.push(...grades);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const row = db.prepare(`SELECT COUNT(*) as count FROM kanji ${where}`).get(...params) as { count: number };
  res.json({ count: row.count });
});

router.patch("/:character", (req: Request, res: Response) => {
  const db = getDb();
  const { character } = req.params;
  const { known } = req.body;

  if (typeof known === "boolean") {
    db.prepare("UPDATE kanji SET known = ? WHERE character = ?").run(
      known ? 1 : 0,
      character
    );
  } else {
    // Toggle
    db.prepare("UPDATE kanji SET known = NOT known WHERE character = ?").run(
      character
    );
  }

  const updated = db
    .prepare("SELECT * FROM kanji WHERE character = ?")
    .get(character);
  res.json(updated);
});

router.patch("/bulk/update", (req: Request, res: Response) => {
  const db = getDb();
  const { action, filter } = req.body as {
    action: "markKnown" | "markUnknown";
    filter: { grades?: number[]; jlptLevels?: number[] };
  };

  const known = action === "markKnown" ? 1 : 0;
  const conditions: string[] = [];
  const params: unknown[] = [known];

  if (filter.grades && filter.grades.length > 0) {
    conditions.push(
      `grade IN (${filter.grades.map(() => "?").join(",")})`
    );
    params.push(...filter.grades);
  }

  if (filter.jlptLevels && filter.jlptLevels.length > 0) {
    conditions.push(
      `jlpt IN (${filter.jlptLevels.map(() => "?").join(",")})`
    );
    params.push(...filter.jlptLevels);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = db
    .prepare(`UPDATE kanji SET known = ? ${where}`)
    .run(...params);

  res.json({ updated: result.changes });
});

export default router;
