# Comprehensible Input Generator — v1 Spec

## Purpose

A local web app that generates short Japanese stories constrained to kanji the user actually knows. Solves the core problem of Japanese reading practice: graded readers are generic, expensive, and don't match individual knowledge. This app produces personalized comprehensible input on demand using a local LLM.

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Frontend | React + TypeScript (Vite) |
| Backend | Node.js + Express + TypeScript |
| Database | SQLite via better-sqlite3 |
| LLM | Ollama (gemma4:26b) |
| Network | Local network access only |

---

## Data Model

### `kanji` table
| Column | Type | Notes |
|--------|------|-------|
| character | TEXT PK | Single kanji character |
| grade | INTEGER | School grade (1-6 for kyoiku, 7+ for remaining joyo) |
| jlpt | INTEGER NULL | JLPT level (5=easiest, 1=hardest). Some kanji lack JLPT classification |
| known | BOOLEAN | Default false. User-toggled |
| meanings | TEXT | Comma-separated English meanings |
| readings_on | TEXT | On'yomi readings |
| readings_kun | TEXT | Kun'yomi readings |

Seed data: All ~2,136 joyo kanji with grade, JLPT level, meanings, and readings. Source from KANJIDIC2 (open license, XML) for kanji data, and a community-maintained JLPT kanji list for JLPT mappings.

### `stories` table
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| title | TEXT | LLM-generated title |
| content | TEXT | The story body |
| paragraphs | INTEGER | Number of paragraphs requested |
| topic | TEXT NULL | Optional user-provided topic (e.g., "cooking", "travel", "school life") |
| formality | TEXT | One of: "impolite", "casual", "polite", "keigo" |
| filters | TEXT (JSON) | The filters used: `{ knownOnly: bool, jlptLevels: int[], grades: int[] }` |
| allowed_kanji | TEXT | The actual kanji list sent to the LLM |
| difficulty | TEXT (JSON) | `{ uniqueKanji: int, grade: { max, avg }, jlpt: { min, avg } }` |
| created_at | TEXT | ISO timestamp |

---

## API Endpoints

### Kanji
- `GET /api/kanji` — List all kanji. Supports query params: `?known=true`, `?jlpt=5,4`, `?grade=1,2`, `?search=食`
- `PATCH /api/kanji/:character` — Toggle or set `known` status
- `PATCH /api/kanji/bulk` — Bulk update: `{ action: "markKnown" | "markUnknown", filter: { grades?: int[], jlptLevels?: int[] } }`

### Stories
- `POST /api/stories/generate` — Generate a story (see generation flow below)
- `GET /api/stories` — List saved stories (summary: id, title, difficulty, created_at, filters)
- `GET /api/stories/:id` — Full story detail
- `DELETE /api/stories/:id` — Delete a story

---

## Story Generation Flow

### 1. Build kanji allow-list
From the user's filter selection, query the DB:
```sql
SELECT character FROM kanji
WHERE (known = 1 OR :knownOnly = 0)
  AND (jlpt IN (:jlptLevels) OR :jlptLevels IS NULL)
  AND (grade IN (:grades) OR :grades IS NULL)
```

### 2. Construct LLM prompt
Key elements of the prompt:
- **Role**: "You are a Japanese language teacher writing a short story for a student."
- **Kanji constraint**: "You MUST only use the following kanji characters: [list]. You may freely use hiragana and katakana. Do NOT use any kanji not in this list."
- **Grammar constraint**: Map the JLPT filter to grammar guidance:
  - N5: te-form, masu-form, basic particles, desu/da
  - N4: conditional (tara/ba), passive basics, tearu/teiru
  - N3: causative, passive, compound sentences, you ni suru
  - N2+: no grammar restriction
  - If multiple JLPT levels selected, use the most advanced one
- **Topic** (if provided): "The story should be about: {topic}"
- **Formality**: Map to speech style instruction:
  - impolite: "Use casual/rough speech (tameguchi, zo/ze sentence endings, masculine rough style)"
  - casual: "Use plain form (da/dearu, dictionary form verbs)"
  - polite: "Use polite form (desu/masu)"
  - keigo: "Use honorific/humble Japanese (keigo) — include sonkeigo and kenjougo where natural"
- **Length**: "{n} paragraphs"
- **Format**: "Output ONLY the story. Start with a short title on the first line."

### 3. Validate output
```
function validate(story: string, allowedKanji: Set<string>): ValidationResult {
  // Extract all kanji from story (regex: /[\u4e00-\u9faf]/g)
  // Check each against allowedKanji set
  // Return { valid: boolean, violations: string[] }
}
```

### 4. Retry on failure
- If validation fails, re-prompt with the violations explicitly called out: "Your previous story contained these disallowed kanji: [violations]. Rewrite without them."
- Max 3 retries. After 3 failures, return the best attempt (fewest violations) with violations flagged to the user.
- Stream progress to the frontend: "Generating... (attempt 2/3, previous had 3 violations)"

### 5. Compute difficulty estimate
After validation passes:
- Count unique kanji used
- Find max grade and average grade of kanji used
- Find min (hardest) JLPT and average JLPT of kanji used
- Store as JSON in the `difficulty` column

### 6. Save and return
Save to `stories` table with all metadata. Return full story to frontend.

---

## Frontend Pages

### 1. Story Generator (home page `/`)
- **Paragraph count**: Number input, default 5, range 1-10
- **Topic**: Optional text input, placeholder "e.g., cooking, school life, travel..."
- **Formality**: Single-select radio/chips: Impolite | Casual | Polite (default) | Keigo
- **Filter panel** (collapsible, multi-layer):
  - Toggle: "Only known kanji" (default on)
  - JLPT level: Multi-select chips (N5, N4, N3, N2, N1)
  - Grade: Multi-select chips (1-6, Secondary)
  - Show count: "423 kanji match this filter"
- **Generate button**: Triggers generation. Shows streaming status ("Generating...", "Validating...", retry status)
- **Story display**: Title + paragraphs rendered cleanly. Below: difficulty badge, kanji stats, "Save" is automatic but "Delete" available

### 2. Story History (`/stories`)
- List of saved stories: title, date, difficulty badge, formality tag, filter summary
- Click to view full story
- Delete button per story

### 3. Kanji Manager (`/kanji`)
- **Search bar**: Search by character, meaning, or reading
- **Filter bar**: JLPT level chips, Grade chips (same multi-select style as generator)
- **Bulk actions bar**: "Mark all filtered as known" / "Mark all filtered as unknown"
- **Kanji grid**: Shows kanji in a grid/table
  - Each cell: character (large), meaning (small), grade/JLPT badges
  - Click to toggle known/unknown (visual: known = highlighted/filled, unknown = dimmed)
  - Responsive: works on phone for couch study
- **Stats**: "You know 342 / 2,136 kanji"

---

## Project Structure

```
comprehensible-input-generator/
├── package.json          (workspace root)
├── client/               (Vite + React + TS)
│   ├── src/
│   │   ├── pages/        (Generator, Stories, KanjiManager)
│   │   ├── components/   (FilterPanel, KanjiGrid, StoryCard, etc.)
│   │   ├── api/          (fetch wrappers for backend endpoints)
│   │   └── types/        (shared TypeScript types)
│   └── vite.config.ts
├── server/               (Express + TS)
│   ├── src/
│   │   ├── index.ts      (Express app, listen on 0.0.0.0)
│   │   ├── routes/       (kanji.ts, stories.ts)
│   │   ├── services/     (ollama.ts, validation.ts, difficulty.ts)
│   │   ├── db/           (schema.sql, seed.ts, connection.ts)
│   │   └── types/        (shared TypeScript types)
│   └── tsconfig.json
└── data/
    └── kanji.json        (seed data: joyo kanji with grade/JLPT/meanings/readings)
```

---

## Seed Data

Source joyo kanji data from KANJIDIC2 (open license, XML). Write a one-time seed script that:
1. Parses the kanji dataset
2. Maps each kanji to grade, JLPT level, meanings, readings
3. Inserts into SQLite

JLPT mappings aren't in KANJIDIC2 — source from a community-maintained JLPT kanji list (several exist as JSON/CSV).

---

## Verification Plan

1. **Seed data**: Run seed script, verify kanji count (~2,136), spot-check grade/JLPT assignments
2. **Kanji API**: Toggle a few kanji known/unknown, verify persistence. Test bulk operations.
3. **Generation**: Generate with a small filter (N5 only known), verify story contains only allowed kanji
4. **Retry logic**: Temporarily use a very restrictive filter (e.g., 5 kanji) to force violations and verify retry behavior
5. **Story history**: Generate 2-3 stories, verify they appear in history with correct metadata
6. **Frontend**: Test on phone-sized viewport for kanji manager usability
7. **Network**: Access from another device on local network via `http://<host-ip>:port`
