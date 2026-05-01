# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A web app that generates short Japanese stories constrained to kanji the user knows, using OpenRouter LLM APIs. Designed for Japanese reading practice via comprehensible input. Each user has their own kanji known-state, story history, audio playback, and per-word LLM Q&A threads.

## Keep This File Up To Date

When your change affects anything documented here, update CLAUDE.md alongside the code change. Common triggers: adding, renaming, or removing files listed under *Architecture*; changing commands, env vars, RPCs, or table columns; pinning/unpinning a model or updating a `file:line` reference; discovering a non-obvious gotcha (silent failure, RLS quirk, dev-env footgun); changing a convention.

Prefer durable descriptions over snapshots — describe roles and patterns, not commit-state. "See `supabase/migrations/` for history" beats naming the latest migration. If a section is already drifting, thin it rather than chasing every rename. If you find an entry that no longer matches reality, fix it in the same change rather than leaving it.

## Commands

```bash
# Install dependencies (postinstall copies kuromoji dict files into client/public/dict/)
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

# Serve Edge Functions locally (loads .env.local for AZURE_SPEECH_*)
npx supabase functions serve --env-file .env.local

# Deploy Edge Functions
npx supabase functions deploy generate-story
npx supabase functions deploy ask-word
npx supabase functions deploy generate-audio
npx supabase functions deploy openrouter-usage
```

## Architecture

This is an npm workspaces monorepo. The root `package.json` declares `client` as the only workspace; there is no `server/` directory — the backend is entirely Supabase (Postgres + Edge Functions).

### Client (`client/`) — Vite + React + TypeScript

Talks directly to Supabase (DB via SDK, Edge Functions via `functions.invoke`). Routing in `client/src/App.tsx` lazy-loads `/generator`, `/stories`, `/stories/:id`, `/kanji`, `/settings`; everything except `/login` is wrapped in `<ProtectedRoute>` + `<AppLayout>`. Plain CSS colocated as `Component.css` next to `Component.tsx` — no Tailwind, no CSS modules. Floating UI for popover positioning; `react-router-dom` for routing.

- **`lib/`** — pure utilities, no React imports. Notable: `generation.ts` (`buildPrompt()` + `computeDifficulty()`), `furigana.ts` (parses Aozora `kanji《reading》` ruby blocks), `tokenizer.ts` (kuromoji; loads dict from `/dict/`), `dictionary.ts` (JPDict IndexedDB lookup), `askChips.ts` (chip definitions; each chip's `prompt` is the hidden first turn of its thread), and the word-at-cursor stack (`lookupAtCursor`, `japaneseDeinflect`, `japaneseTransforms`, `languageTransformer`). `database.types.ts` is auto-generated — regenerate after migrations.
- **`api/client.ts`** — single boundary for all data ops: kanji (RPC `get_user_kanji`), story CRUD, Edge Function invocations (`generateStory`/`generateAudio`/`askWord`), profile + Vault-backed API key management. Snake↔camel conversion happens here.
- **`contexts/`** — `AuthContext` (session/profile), `GenerationContext` (story-generation state machine, SSE → ruby parse → save), `KanjiContext` (known-state + filters), `DictionaryContext` (lookup cache).
- **`components/`** — notable behaviors: `StoryDisplay` renders `<ruby>` annotations + click-to-ask; `WordPopover` is chip-only (no free-form input; helpers in `wordPopoverHelpers.ts`).
- **`hooks/useAudioPlayer`** — playback + token-by-token sync against `audio.tokens`.
- **`types/index.ts`** — shared interfaces (`Kanji`, `Story`, `StoryFilters`, `StoryAudio`, `WordThread`, `Profile`).
- **Tests** — Vitest, colocated `*.test.ts`. Pure-lib only — no React rendering tests. `src/test/setup.ts` stubs Vite env vars so `lib/supabase.ts` is importable transitively.

### Supabase (`supabase/`)

- `config.toml` — local CLI config; `db.seed.sql_paths` runs both `seed.sql` and `seed_dev.sql` on `db reset`.
- `seed.sql` — joyo kanji reference data (regenerated from `data/kanji.json` via `npm run generate-seed`).
- `seed_dev.sql` — dev test user (`dev@local.test` / `devpassword`), grade 1–3 kanji marked known, sample stories. Idempotent on re-runs.
- `migrations/` — timestamped SQL files (`YYYYMMDDHHMMSS_*.sql`). Run `ls supabase/migrations/` for current state.
- `functions/_shared/` — utilities shared by Edge Functions (`openrouter.ts`, `story.ts`, `text.ts`, `word-thread.ts`).
- `functions/generate-story/` — main story generation. Auths user via JWT, fetches OpenRouter key from Vault RPC, streams SSE through to client. Pins to a single model via `ALLOWED_MODELS` allow-list (see `generate-story/index.ts:9`). Maps 401/402/429 to user-friendly errors.
- `functions/ask-word/` — single-turn LLM Q&A keyed by chip id on a selected word/range. Appends to `stories.explanations` JSONB at `["${start}-${end}"]["${thread_id}"]` where `thread_id` is a chip id from `client/src/lib/askChips.ts`. The first user turn of each thread is the chip prompt (seed); the UI hides `messages[0]` and shows just the model's reply. The popover has no free-form input — chip click is the only way to ask.
- `functions/generate-audio/` — Azure Neural TTS; persists path + tokens + sync points into `stories.audio` JSONB and uploads MP3 to the `story-audio` Storage bucket. Returns 500 *"Azure TTS is not configured"* if `AZURE_SPEECH_KEY` or `AZURE_SPEECH_REGION` is unset.
- `functions/openrouter-usage/` — surfaces OpenRouter credit/usage to the client.

## Data Model

- `kanji` — reference data (read-only). `character` PK, `grade` (1-6, 8=secondary), `jlpt` (5=easiest, 1=hardest, NULL allowed), `meanings`, `readings_on`, `readings_kun`
- `user_kanji` — per-user known state. Composite PK `(user_id, character)`, `known BOOLEAN NOT NULL DEFAULT true`. The client deletes the row to mark unknown.
- `stories` — per-user stories. Columns include `title`, `content`, `paragraphs`, `topic`, `formality` (`impolite`/`casual`/`polite`/`keigo`), `content_type` (`story`/`dialogue`/`essay`), `filters` JSONB, `allowed_kanji` (TEXT — concatenated kanji string, not JSON), `difficulty` JSONB, `audio` JSONB nullable (`{path, duration_ms, voice, version, tokens, paragraphs, sentences?}`), `explanations` JSONB nullable (`{ "start-end": { "<chip_id>": { version, messages } } }` where `messages[0]` is the hidden chip prompt seed), `read_at`, `created_at`. RLS-scoped.
- `profiles` — auto-created on signup by the `handle_new_user()` trigger. Stores `display_name`, `openrouter_api_key_secret_id` (UUID reference into Supabase Vault — the actual key is encrypted, never stored in plaintext on `profiles`), and `preferred_*` columns (model, formality, paragraphs, content_type) used as Generator defaults.

RLS policies: `kanji` readable by authenticated users; `user_kanji`/`stories`/`profiles` scoped to `auth.uid()`.

## Key RPCs

- `get_user_kanji()` — returns every kanji joined with `COALESCE(user_kanji.known, false)` for the calling user. Avoids pre-populating one row per kanji per user.
- `user_underused_kanji(p_limit INT DEFAULT 20)` — returns the caller's known kanji ordered by exposure ASC, grade DESC, character (deterministic, no random tiebreaker). Used by the Generator to suggest under-exposed kanji to inject into the prompt.
- `set_openrouter_api_key(key text)` / `clear_openrouter_api_key()` — user-callable; manage the Vault secret tied to the caller's profile. `set_…` self-heals if a stored secret-id no longer resolves in `vault.decrypted_secrets` (e.g., after `npm run sync-prod`).
- `get_openrouter_api_key_for_user(p_user_id uuid)` — service-role RPC that decrypts the Vault secret. Called only by Edge Functions.
- `strip_ruby(t text)` / `clean_generated_text(t text)` — text helpers used internally by `user_underused_kanji` and migrations.

## Key Details

- Kanji grades use kanjiapi.dev convention: 1-6 for elementary, 8 for secondary (no grade 7).
- JLPT levels: 5 = easiest, 1 = hardest. Some kanji are unclassified (NULL).
- LLM output uses **Aozora ruby** notation: `kanji《reading》`. The prompt instructs character-level (not word-level) rubies, fall back to hiragana when a kanji is not in the allow-list. `lib/furigana.ts` parses this on the client.
- Story generation **streams SSE** through the Edge Function rather than retrying server-side. Validation (any kanji outside allow-list) runs client-side after streaming completes; retry is whole-request from the client.
- Edge Functions read the OpenRouter API key from **Supabase Vault** via a service-role RPC (not from a plaintext profile column).
- OpenRouter API is OpenAI-compatible (`/v1/chat/completions`). Story generation enforces an `ALLOWED_MODELS` allow-list (see `generate-story/index.ts:9` for the current pin); ask-word pins its own model with a per-request token cap (see `ask-word/index.ts`).
- The `postinstall` script copies `@aiktb/kuromoji` dict files into `client/public/dict/` so the tokenizer can fetch them at runtime — do not delete `client/public/dict/` after install.
- All local-dev env vars live in a single project-root `.env.local` (gitignored — see `.env.local.example`). Vite reads it via `envDir` set in `client/vite.config.ts`; `supabase functions serve --env-file .env.local` loads it for Edge Functions. Only `VITE_*` vars are exposed to the browser bundle. Vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (client → Supabase), `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` (optional, enables local audio). Edge Functions also see `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from the Deno env automatically.
- Local dev user: `supabase start` and `db reset` apply both `supabase/seed.sql` (kanji reference data) and `supabase/seed_dev.sql` (test account `dev@local.test` / `devpassword`, grade 1–3 kanji marked known, sample stories). The OpenRouter key is not seeded — log in and paste it in Settings (it goes through the existing `set_openrouter_api_key()` RPC into Vault). Audio works locally too: set the Azure env vars and serve functions with `--env-file .env.local`; seeded stories have `audio = NULL` and regenerate on first play exactly like fresh ones.

## Conventions

- Components: `PascalCase.tsx` with optional colocated `.css` of the same name.
- Utilities & hooks: `camelCase.ts`. Tests are `<name>.test.ts` colocated next to the file under test.
- DB columns: `snake_case`; TypeScript fields: `camelCase`. The auto-generated `database.types.ts` exposes the snake_case shape — convert at the API boundary in `api/client.ts`.
- Pages compose contexts + components; `lib/` stays free of React imports.
- Don't reach into Supabase tables that have RLS from the client without an authenticated session — queries will silently return empty.
- When adding a migration, regenerate `client/src/lib/database.types.ts` and update `types/index.ts` if user-facing shapes change.
