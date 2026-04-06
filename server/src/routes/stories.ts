import { Router, type Request, type Response } from "express";
import { getDb } from "../db/connection.js";
import { generateStory, retryWithFeedback } from "../services/ollama.js";
import { validate } from "../services/validation.js";
import { computeDifficulty } from "../services/difficulty.js";
import type { GenerateRequest, StoryFilters } from "../types/index.js";

const router = Router();

router.post("/generate", async (req: Request, res: Response) => {
  try {
    const { paragraphs, topic, formality, filters } =
      req.body as GenerateRequest;
    const db = getDb();

    // Build kanji allow-list
    const allowedKanji = buildKanjiList(db, filters);

    if (allowedKanji.length === 0) {
      res
        .status(400)
        .json({ error: "No kanji match the current filters. Adjust your filters and try again." });
      return;
    }

    // Determine grammar level from JLPT filter
    const grammarLevel =
      filters.jlptLevels.length > 0 ? Math.min(...filters.jlptLevels) : 2;

    const options = {
      paragraphs,
      topic,
      formality,
      allowedKanji,
      grammarLevel,
    };

    const allowedSet = new Set(allowedKanji);
    let story: string | null = null;
    let bestAttempt = { text: "", violationCount: Infinity };
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const text =
        attempt === 1
          ? await generateStory(options)
          : await retryWithFeedback(
              options,
              validate(bestAttempt.text, allowedSet).violations
            );

      const result = validate(text, allowedSet);

      if (result.valid) {
        story = text;
        break;
      }

      if (result.violations.length < bestAttempt.violationCount) {
        bestAttempt = {
          text,
          violationCount: result.violations.length,
        };
      }

      console.log(
        `Attempt ${attempt}/${MAX_RETRIES}: ${result.violations.length} violations [${result.violations.join(", ")}]`
      );
    }

    // Use best attempt if all retries failed
    const finalText = story || bestAttempt.text;
    const finalValidation = validate(finalText, allowedSet);

    // Extract title (first line) and content (rest)
    const lines = finalText.split("\n").filter((l) => l.trim());
    const title = lines[0] || "無題";
    const content = lines.slice(1).join("\n\n");

    const difficulty = computeDifficulty(finalText);

    const result = db
      .prepare(
        `INSERT INTO stories (title, content, paragraphs, topic, formality, filters, allowed_kanji, difficulty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        title,
        content,
        paragraphs,
        topic || null,
        formality,
        JSON.stringify(filters),
        allowedKanji.join(""),
        JSON.stringify(difficulty)
      );

    res.json({
      id: result.lastInsertRowid,
      title,
      content,
      paragraphs,
      topic: topic || null,
      formality,
      filters,
      difficulty,
      created_at: new Date().toISOString(),
      violations: finalValidation.valid ? [] : finalValidation.violations,
    });
  } catch (err) {
    console.error("Generation error:", err);
    const message = err instanceof Error ? err.message : "Generation failed";
    res.status(500).json({ error: message });
  }
});

router.get("/", (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, title, paragraphs, topic, formality, filters, difficulty, created_at FROM stories ORDER BY created_at DESC"
    )
    .all();

  const stories = (rows as Record<string, unknown>[]).map((row) => ({
    ...row,
    filters: JSON.parse(row.filters as string),
    difficulty: JSON.parse(row.difficulty as string),
  }));

  res.json(stories);
});

router.get("/:id", (req: Request, res: Response) => {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM stories WHERE id = ?")
    .get(req.params.id) as Record<string, unknown> | undefined;

  if (!row) {
    res.status(404).json({ error: "Story not found" });
    return;
  }

  res.json({
    ...row,
    filters: JSON.parse(row.filters as string),
    difficulty: JSON.parse(row.difficulty as string),
  });
});

router.delete("/:id", (req: Request, res: Response) => {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM stories WHERE id = ?")
    .run(req.params.id);

  if (result.changes === 0) {
    res.status(404).json({ error: "Story not found" });
    return;
  }

  res.json({ ok: true });
});

function buildKanjiList(
  db: ReturnType<typeof getDb>,
  filters: StoryFilters
): string[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.knownOnly) {
    conditions.push("known = 1");
  }

  if (filters.jlptLevels.length > 0) {
    conditions.push(
      `jlpt IN (${filters.jlptLevels.map(() => "?").join(",")})`
    );
    params.push(...filters.jlptLevels);
  }

  if (filters.grades.length > 0) {
    conditions.push(
      `grade IN (${filters.grades.map(() => "?").join(",")})`
    );
    params.push(...filters.grades);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT character FROM kanji ${where}`)
    .all(...params) as { character: string }[];

  return rows.map((r) => r.character);
}

export default router;
