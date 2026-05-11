# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A web app that generates short Japanese stories constrained to kanji the user knows, using OpenRouter LLM APIs. Designed for Japanese reading practice via comprehensible input. Each user has their own kanji known-state, story history, and per-word LLM Q&A threads.

## Keep This File Up To Date

When your change affects anything documented here, update CLAUDE.md alongside the code change. Common triggers: adding, renaming, or removing files listed under *Architecture*; changing commands, env vars, RPCs, or table columns; pinning/unpinning a model or updating a `file:line` reference; discovering a non-obvious gotcha (silent failure, RLS quirk, dev-env footgun); changing a convention.

Prefer durable descriptions over snapshots — describe roles and patterns, not commit-state. "See `supabase/migrations/` for history" beats naming the latest migration. If a section is already drifting, thin it rather than chasing every rename. If you find an entry that no longer matches reality, fix it in the same change rather than leaving it.

## Commands

```bash
# Install dependencies
npm install

# Start local Supabase (requires Docker)
npx supabase start

# Apply migrations and seed data (kanji + dev test user)
npx supabase db reset

# Generate seed SQL from data/kanji.json (only needed if kanji data changes)
npm run generate-seed

# Sync prod Supabase data into local instance
npm run sync-prod

# Generate TypeScript types from Supabase schema
npx supabase gen types typescript --local > client/src/lib/database.types.ts

# Run client dev server
npm run dev

# Build client (typecheck + Vite build)
npm run build

# Lint client
npm run lint --workspace=client

# Test client (Vitest)
npm test                              # one-shot
npm run test:watch --workspace=client # watch mode

# Serve Edge Functions locally
npx supabase functions serve --env-file .env.local

# Deploy Edge Functions
npx supabase functions deploy generate-story
npx supabase functions deploy ask-word
npx supabase functions deploy openrouter-usage
```

## Architecture

This is an npm workspaces monorepo. The root `package.json` declares `client` as the only workspace; there is no `server/` directory — the backend is entirely Supabase (Postgres + Edge Functions).

### Client (`client/`) — Vite + React + TypeScript

Talks directly to Supabase (DB via SDK, Edge Functions via `functions.invoke`). Routing in `client/src/App.tsx` lazy-loads `/generator`, `/stories`, `/stories/:id`, `/kanji`, `/settings`; everything except `/login` is wrapped in `<ProtectedRoute>` + `<AppLayout>`. Plain CSS colocated as `Component.css` next to `Component.tsx` — no Tailwind, no CSS modules. Floating UI for popover positioning; `react-router-dom` for routing.

- **`lib/`** — pure utilities, no React imports. Notable: `generation.ts` (`buildPrompt()` only — difficulty is computed server-side now), `furigana.ts` (parses Aozora `kanji《reading》` ruby blocks), `storySegments.ts` (walks `(cleanText, annotations)` into paragraph→sentence→part structure with character-level offsets), `sentenceSnippet.ts` (`extractSentenceSnippet` finds the sentence containing a span and rebases its annotations + highlight offsets — used by the WordPopover carousel to render each prior usage in context), `tokenizer.ts` (thin lazy-init wrapper around `@aiktb/kuromoji` exposing `tokenizeText` for boundary alignment; dict files live in `client/public/dict/` and are copied there by the root `postinstall`), `regroupWords.ts` (async hybrid: kuromoji supplies token boundaries, JMdict (`lookupAtBoundary`) checks each candidate span — only matches that align with a kuromoji boundary or the run end are accepted, which rejects greedy false positives like 「があ」 while still letting deinflection merge across kuromoji tokens for spans like 「あります」; `StoryDisplay` falls back to char-level until both dict + tokenizer resolve), `dictionary.ts` (JPDict IndexedDB lookup), `askChips.ts` (chip definitions; each chip's `prompt` is the hidden first turn of its thread), `headword.ts` (`headwordFromHit` derives the canonical JMdict lemma from a `LookupHit` — uses `hit.base` for deinflected hits, falls back to primary `k[0]`/`r[0]`; returns null for 1-char no-match fallbacks so they're skipped from lookup history), `rarity.ts` (kanji-exposure scoring: saturating exponential up to count 10 then a log tail, scaled by `SCORE_MULTIPLIER`; `totalScore` powers the header total, `readingScoreDelta` powers the "Rare kanji" sort and per-card "+X" tag on Compositions, `formatScore` is the display formatter — sub-1 values render as `<1`, otherwise rounded integers), and the word-at-cursor stack (`lookupAtCursor`, `japaneseDeinflect`, `japaneseTransforms`, `languageTransformer`). `database.types.ts` is auto-generated — regenerate after migrations.
- **`api/client.ts`** — single boundary for all data ops: kanji (RPC `get_user_kanji`), story CRUD, Edge Function invocations (`startStoryGeneration`/`askWord`), profile + Vault-backed API key management, lookup history (`recordWordLookup` upserts a `word_lookups` row on every popover open with a meaningful match — best-effort, errors are swallowed; `getWordUsages(headword)` returns every prior usage of the same headword joined with story content + explanation threads). `getStories`/`getReadStoryContents` filter to `status='complete'` so in-flight rows never reach the Stories list. `getInFlightGeneration` returns the user's most recent non-complete row (used by `GenerationContext` to hydrate); `markStoryFailed` flips a stale row when the Edge Function dies silently. Snake↔camel conversion happens here.
- **`contexts/`** — `AuthContext` (session/profile), `GenerationContext` (background-generation state machine — calls `startStoryGeneration`, then polls `getStory(id)` every 3s until `status` flips to `complete`/`failed`; on mount, hydrates from any `generating` row so reloading mid-generation resumes the loading state. Failed rows are best-effort deleted before the next `generate()` retry so they don't accumulate. The completed story is intentionally **not** surfaced through this context — the Generator page is fire-and-forget, and finished stories are only viewable on the Compositions / Story Detail pages), `KanjiContext` (known-state + per-kanji exposure counts; `refreshKnownKanji` also refreshes the exposure map so toggling a kanji known/unknown updates the header total live, and `refreshKanjiExposures` is called by `StoryReadButton` so marking a story read does the same), `DictionaryContext` (lookup cache).
- **`components/`** — notable behaviors: `StoryDisplay` renders `<ruby>` annotations + click-to-ask; `WordPopover` is chip-only (no free-form input; helpers in `wordPopoverHelpers.ts`). The popover is structured as a sticky header (headword + senses + headword's kanji chips — identical across all cards, so visual repetition is avoided) over a horizontal carousel of "usage" cards. Card 0 is the current tap; cards 1..N are prior lookups of the same headword from anywhere in the user's history (fetched via `getWordUsages`). Each card carries its own `(storyId, start, end)`; chip clicks call `askWord` for that card's story, persist locally so swiping back keeps the answer, and bubble through `onThreadUpdated` only when `card.storyId` matches the parent story (the parent only tracks threads for the current story). Navigation: arrow buttons + ←/→ keys + horizontal touch swipe + position indicator. Hidden when there's only a current card. The current span is filtered out of `usages` to avoid duplicating it as both card 0 and card N.
- **`types/index.ts`** — shared interfaces (`Kanji`, `Story`, `StoryFilters`, `WordThread`, `WordUsage`, `Profile`).
- **Tests** — Vitest, colocated `*.test.ts`. Pure-lib only — no React rendering tests. `src/test/setup.ts` stubs Vite env vars so `lib/supabase.ts` is importable transitively.

### Supabase (`supabase/`)

- `config.toml` — local CLI config; `db.seed.sql_paths` runs both `seed.sql` and `seed_dev.sql` on `db reset`.
- `seed.sql` — joyo kanji reference data (regenerated from `data/kanji.json` via `npm run generate-seed`).
- `seed_dev.sql` — dev test user (`dev@local.test` / `devpassword`), grade 1–3 kanji marked known, sample stories. Idempotent on re-runs.
- `migrations/` — timestamped SQL files (`YYYYMMDDHHMMSS_*.sql`). Run `ls supabase/migrations/` for current state.
- `functions/_shared/` — utilities shared by Edge Functions (`openrouter.ts`, `story.ts`, `text.ts`, `word-thread.ts`).
- `functions/generate-story/` — runs as a **background task**. Auths user, rejects (409) if a `status='generating'` row already exists for the user, inserts a placeholder `stories` row with `status='generating'`, returns 202 + `{ story_id }` immediately, then uses `EdgeRuntime.waitUntil` to call OpenRouter, parse the title/content, compute difficulty (loads kanji metadata server-side), and `UPDATE` the row to `status='complete'` (or `status='failed'` + `error_message` on any error). The client never streams from this function — it polls `stories.id` until status flips. Pins to a single model via `ALLOWED_MODELS` allow-list (see `generate-story/index.ts:24`). Maps 401/402/429 to user-friendly errors.
- `functions/ask-word/` — single-turn LLM Q&A keyed by chip id on a selected word/range. Appends to `stories.explanations` JSONB at `["${start}-${end}"]["${thread_id}"]` where `thread_id` is a chip id from `client/src/lib/askChips.ts`. The first user turn of each thread is the chip prompt (seed); the UI hides `messages[0]` and shows just the model's reply. The popover has no free-form input — chip click is the only way to ask.
- `functions/openrouter-usage/` — surfaces OpenRouter credit/usage to the client.

## Data Model

- `kanji` — reference data (read-only). `character` PK, `grade` (1-6, 8=secondary), `jlpt` (5=easiest, 1=hardest, NULL allowed), `meanings`, `readings_on`, `readings_kun`
- `user_kanji` — per-user known state. Composite PK `(user_id, character)`, `known BOOLEAN NOT NULL DEFAULT true`. The client deletes the row to mark unknown.
- `stories` — per-user stories. Columns include `title`, `content`, `paragraphs`, `topic`, `formality` (`impolite`/`casual`/`polite`/`keigo`), `content_type` (`story`/`dialogue`/`essay`), `filters` JSONB, `allowed_kanji` (TEXT — concatenated kanji string, not JSON), `difficulty` JSONB, `explanations` JSONB nullable (`{ "start-end": { "<chip_id>": { version, messages } } }` where `messages[0]` is the hidden chip prompt seed), `read_count` (INT NOT NULL, defaults 0; weights kanji-exposure aggregation so re-reads count), `first_read_at` / `last_read_at`, `status` (`generating`/`complete`/`failed`, NOT NULL DEFAULT `complete`), `error_message` TEXT nullable (set when `status='failed'`), `created_at`. RLS-scoped. Stories list and `getReadStoryContents` filter to `status='complete'`; `user_underused_kanji` is naturally limited to completed rows because it filters `read_count > 0` and only completed stories are markable as read. In-flight / failed rows are invisible everywhere except the Generator page's loading state.
- `profiles` — auto-created on signup by the `handle_new_user()` trigger. Stores `display_name`, `openrouter_api_key_secret_id` (UUID reference into Supabase Vault — the actual key is encrypted, never stored in plaintext on `profiles`), and `preferred_*` columns (model, formality, paragraphs, content_type, unknown_kanji_target, prioritize_rare_kanji) used as Generator defaults — every Generator field except topic/style persists on Generate.
- `word_lookups` — per-user lookup history for the WordPopover carousel. Columns: `id`, `user_id`, `story_id`, `start_offset`, `end_offset`, `surface` (text as it appeared), `headword` (deinflected JMdict lemma, or surface fallback), `reading` (top JMdict reading, nullable), `looked_up_at`, `lookup_count`. UNIQUE on `(user_id, story_id, start_offset, end_offset)` — re-tapping the same span upserts (refreshes `looked_up_at`, increments `lookup_count`). Indexed on `(user_id, headword, looked_up_at DESC)` for the carousel query. RLS-scoped. Both FKs cascade on delete, so deleting a story clears its lookup rows.

RLS policies: `kanji` readable by authenticated users; `user_kanji`/`stories`/`profiles`/`word_lookups` scoped to `auth.uid()`.

## Key RPCs

- `get_user_kanji()` — returns every kanji joined with `COALESCE(user_kanji.known, false)` for the calling user. Avoids pre-populating one row per kanji per user.
- `user_underused_kanji(p_limit INT DEFAULT 20)` — returns the caller's known kanji ordered by exposure ASC, grade DESC, character (deterministic, no random tiebreaker). Each story's character counts are multiplied by `read_count`, so re-reading a story increases exposure. Used by the Generator to suggest under-exposed kanji to inject into the prompt.
- `mark_story_read(p_story_id BIGINT)` / `undo_story_read(p_story_id BIGINT)` — user-callable. `mark_…` increments `read_count` and refreshes `last_read_at` (setting `first_read_at` on the 0→1 transition). `undo_…` decrements with a floor of 0; the StoryReadButton additionally tracks per-session increments so the undo affordance only undoes same-session marks — past-session reads can't be cleared from the UI.
- `record_word_lookup(p_story_id, p_start, p_end, p_surface, p_headword, p_reading)` — user-callable upsert into `word_lookups`. Increments `lookup_count` + refreshes `looked_up_at` on conflict; refreshes `headword`/`reading`/`surface` so a future deinflection-rule change re-canonicalises the row.
- `get_word_usages(p_headword TEXT)` — returns every `word_lookups` row for the caller with the given headword, joined with the story (title, content, created_at) and the `explanations -> '<start>-<end>'` JSONB at that span. Filters to `stories.status = 'complete'`. Ordered by `looked_up_at DESC`, no limit (relies on the user not looking up the same word a huge number of times).
- `set_openrouter_api_key(key text)` / `clear_openrouter_api_key()` — user-callable; manage the Vault secret tied to the caller's profile. `set_…` self-heals if a stored secret-id no longer resolves in `vault.decrypted_secrets` (e.g., after `npm run sync-prod`).
- `get_openrouter_api_key_for_user(p_user_id uuid)` — service-role RPC that decrypts the Vault secret. Called only by Edge Functions.
- `strip_ruby(t text)` / `clean_generated_text(t text)` — text helpers used internally by `user_underused_kanji` and migrations.

## Key Details

- Kanji grades use kanjiapi.dev convention: 1-6 for elementary, 8 for secondary (no grade 7).
- JLPT levels: 5 = easiest, 1 = hardest. Some kanji are unclassified (NULL).
- LLM output uses **Aozora ruby** notation: `kanji《reading》`. The prompt instructs character-level (not word-level) rubies, fall back to hiragana when a kanji is not in the allow-list. `lib/furigana.ts` parses this on the client.
- Story generation runs as a **background task** in the Edge Function (via `EdgeRuntime.waitUntil`). The client `POST`s once, gets back `{ story_id }`, and polls `getStory(id)` every 3s until `status` flips. After 3 minutes without flipping, the client calls `markStoryFailed` to recover from a silently-killed worker. There is no streaming, no thinking-content display, and no validation — whatever text the model returns is saved.
- Edge Functions read the OpenRouter API key from **Supabase Vault** via a service-role RPC (not from a plaintext profile column).
- OpenRouter API is OpenAI-compatible (`/v1/chat/completions`). Story generation enforces an `ALLOWED_MODELS` allow-list (see `generate-story/index.ts:9` for the current pin); ask-word pins its own model with a per-request token cap (see `ask-word/index.ts`).
- All local-dev env vars live in a single project-root `.env.local` (gitignored — see `.env.local.example`). Vite reads it via `envDir` set in `client/vite.config.ts`; `supabase functions serve --env-file .env.local` loads it for Edge Functions. Only `VITE_*` vars are exposed to the browser bundle. Vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (client → Supabase). Edge Functions also see `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from the Deno env automatically.
- Local dev user: `supabase start` and `db reset` apply both `supabase/seed.sql` (kanji reference data) and `supabase/seed_dev.sql` (test account `dev@local.test` / `devpassword`, grade 1–3 kanji marked known, sample stories). The OpenRouter key is not seeded — log in and paste it in Settings (it goes through the existing `set_openrouter_api_key()` RPC into Vault).

## Conventions

- Components: `PascalCase.tsx` with optional colocated `.css` of the same name.
- Utilities & hooks: `camelCase.ts`. Tests are `<name>.test.ts` colocated next to the file under test.
- DB columns: `snake_case`; TypeScript fields: `camelCase`. The auto-generated `database.types.ts` exposes the snake_case shape — convert at the API boundary in `api/client.ts`.
- Pages compose contexts + components; `lib/` stays free of React imports.
- Don't reach into Supabase tables that have RLS from the client without an authenticated session — queries will silently return empty.
- When adding a migration, regenerate `client/src/lib/database.types.ts` and update `types/index.ts` if user-facing shapes change.
