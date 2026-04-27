# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A web app that generates short Japanese stories constrained to kanji the user knows, using OpenRouter LLM APIs. Designed for Japanese reading practice via comprehensible input. Each user has their own kanji known-state, story history, audio playback, and per-word LLM Q&A threads.

## Commands

```bash
# Install dependencies (postinstall copies kuromoji dict files into client/public/dict/)
npm install

# Start local Supabase (requires Docker)
npx supabase start

# Apply migrations and seed data
npx supabase db reset

# Generate seed SQL from data/kanji.json (only needed if kanji data changes)
npm run generate-seed

# Sync prod Supabase data into local instance
npm run sync-prod

# Generate TypeScript types from Supabase schema
npx supabase gen types typescript --local > client/src/lib/database.types.ts

# Run client dev server
npm run dev

# Build client
npm run build

# Lint client
npm run lint --workspace=client

# Test client (Vitest)
npm test                              # one-shot
npm run test:watch --workspace=client # watch mode

# Serve Edge Functions locally
npx supabase functions serve

# Deploy Edge Functions
npx supabase functions deploy generate-story
npx supabase functions deploy ask-word
npx supabase functions deploy generate-audio
npx supabase functions deploy openrouter-usage
```

## Architecture

This is an npm workspaces monorepo. The root `package.json` declares `client` as the only workspace; there is **no `server/` directory** — the backend is entirely Supabase (Postgres + Edge Functions). Despite mentions in `spec.md`, Express/SQLite/Ollama have been replaced by Supabase + OpenRouter.

### Client (`client/`) — Vite + React 19 + TypeScript

Talks directly to Supabase (DB via SDK, Edge Functions via `functions.invoke`). Routing in `client/src/App.tsx` lazy-loads each page; everything except `/login` is wrapped in `<ProtectedRoute>` + `<AppLayout>`.

- `main.tsx`, `App.tsx` — entry, router, providers, error boundaries
- `lib/supabase.ts` — Supabase client singleton (uses `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`)
- `lib/database.types.ts` — auto-generated from Supabase schema; regenerate after migrations
- `lib/generation.ts` — `buildPrompt()` (kanji constraint + Aozora ruby annotation rules), `computeDifficulty()`
- `lib/furigana.ts` — parses `kanji《reading》` Aozora ruby blocks emitted by the LLM
- `lib/text.ts` — sentence boundary, markdown cleanup
- `lib/tokenizer.ts` — kuromoji morphological analyzer (loads dict from `/dict/`)
- `lib/dictionary.ts` — JPDict (IndexedDB) word lookup
- `lib/lookupAtCursor.ts`, `lib/japaneseDeinflect.ts`, `lib/japaneseTransforms.ts`, `lib/languageTransformer.ts` — word-at-cursor + verb/adjective base-form recovery
- `lib/constants.ts` — `KANJI_REGEX`, `KANJI_REGEX_G`
- `api/client.ts` — all data ops: `getKanji`/`toggleKanji`/`bulkUpdateKanji` (RPC `get_user_kanji`), CRUD for stories, `generateStory`/`generateAudio`/`askWord` (invoke Edge Functions), profile + API key management
- `contexts/AuthContext.tsx` — session, user, profile, sign in/out
- `contexts/GenerationContext.tsx` — story generation state machine (streams SSE → parses ruby → saves)
- `contexts/KanjiContext.tsx` — known-kanji state, filter selections
- `contexts/DictionaryContext.tsx` — dictionary lookup cache
- `hooks/useAudioPlayer.ts` — playback + token-by-token sync against `audio.tokens`
- `hooks/useIsMobile.ts` — responsive breakpoint
- `pages/`: `Login`, `Generator`, `Stories`, `StoryDetail`, `KanjiManager`, `Settings`
- `components/`: `AppLayout`, `ProtectedRoute`, `ErrorBoundary`, `StoryDisplay` (renders `<ruby>` annotations + click-to-ask), `PlaybackFooter`, `StoryReadButton`, `WordPopover`, `KanjiInlineDetail`, `DifficultyBadge`, `AnimatedDots`
- `types/index.ts` — shared interfaces (`Kanji`, `Story`, `StoryFilters`, `StoryAudio`, `WordThread`, `Profile`)
- Tests: `*.test.ts` colocated under `lib/` and `api/` (Vitest)

### Supabase (`supabase/`)

- `config.toml` — local CLI config
- `seed.sql` — 2,140 joyo kanji reference data
- `migrations/` — timestamped SQL files (`YYYYMMDDHHMMSS_*.sql`). Schema has evolved: initial schema → preferences → content type → composite indexes → security hardening → audio columns → markdown cleanup → annotations → explanations (replaces annotations) → storage policies → read tracking → **Vault helpers** (latest, `20260427100000_use_vault_helpers.sql`)
- `functions/_shared/` — `openrouter.ts`, `story.ts`, `text.ts`, `word-thread.ts` (shared by edge functions)
- `functions/generate-story/index.ts` — main story generation; auths user via JWT, fetches OpenRouter key from Vault RPC, calls OpenRouter (`anthropic/claude-opus-4.7`) with `reasoning.max_tokens: 6000` and `max_tokens: 16000`, 120s timeout, streams SSE through to client. Maps 401/402/429 to user-friendly errors.
- `functions/ask-word/index.ts` — multi-turn LLM Q&A on a selected word/range within a story; appends to `stories.explanations` JSONB keyed by `"${start}-${end}"`. Uses Sonnet-tier model with 600 token cap.
- `functions/generate-audio/index.ts` — TTS for stories; persists path + tokens + sync points into `stories.audio` JSONB
- `functions/openrouter-usage/index.ts` — surfaces OpenRouter credit/usage to the client

## Data Model

- `kanji` — reference data (read-only). `character` PK, `grade` (1-6, 8=secondary), `jlpt` (5=easiest, 1=hardest, NULL allowed), `meanings`, `readings_on`, `readings_kun`
- `user_kanji` — per-user known state. Composite PK `(user_id, character)`. Missing row = unknown.
- `stories` — per-user stories. Columns include `title`, `content`, `paragraphs`, `topic`, `formality` (`impolite`/`casual`/`polite`/`keigo`), `content_type` (`story`/`dialogue`/`essay`), `filters` JSONB, `allowed_kanji`, `difficulty` JSONB, `audio` JSONB (`{path, duration_ms, voice, version, tokens, paragraphs, sentences?}`), `explanations` JSONB (`{ "start-end": { version, messages } }`), `read_at`, `created_at`. RLS-scoped.
- `profiles` — auto-created on signup. Stores `display_name`, `preferred_model`, `preferred_formality`, `preferred_grammar_level`, `preferred_paragraphs`, `preferred_content_type`, and `openrouter_api_key_secret_id` (UUID reference into Supabase Vault — the actual key is encrypted, never stored in plaintext on `profiles`).

RLS policies: `kanji` readable by authenticated users; `user_kanji`/`stories`/`profiles` scoped to `auth.uid()`.

## Key RPCs

- `get_user_kanji()` — returns all 2,140 kanji joined with `COALESCE(user_kanji.known, false)` for the calling user. Avoids pre-populating 2,140 rows per user.
- `get_openrouter_api_key_for_user(p_user_id uuid)` — service-role RPC that decrypts the Vault secret. Called only by Edge Functions.
- `set_openrouter_api_key(key text)` / `clear_openrouter_api_key()` — user-callable; manage the Vault secret tied to the caller's profile.

## Key Details

- Kanji grades use kanjiapi.dev convention: 1-6 for elementary, 8 for secondary (no grade 7).
- JLPT levels: 5 = easiest, 1 = hardest. ~176 kanji have no JLPT classification.
- LLM output uses **Aozora ruby** notation: `kanji《reading》`. The prompt instructs character-level (not word-level) rubies, fall back to hiragana when a kanji is not in the allow-list. `lib/furigana.ts` parses this on the client.
- Story generation **streams SSE** through the Edge Function rather than retrying server-side. Validation (any kanji outside allow-list) runs client-side after streaming completes; retry is whole-request from the client.
- Edge Functions read the OpenRouter API key from **Supabase Vault** via a service-role RPC (not from a plaintext profile column).
- OpenRouter API is OpenAI-compatible (`/v1/chat/completions`). Story generation pins `anthropic/claude-opus-4.7` (`ALLOWED_MODELS` allow-list in `generate-story/index.ts:9`); ask-word uses a Sonnet-tier model.
- The `postinstall` script copies `@aiktb/kuromoji` dict files into `client/public/dict/` so the tokenizer can fetch them at runtime — do not delete `client/public/dict/` after install.
- Client env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Edge Functions read `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from the Deno env.
- `spec.md` is the original v1 spec and references an Express/SQLite/Ollama stack that no longer applies; treat it as historical context for product intent only.
- `generation-strategies.md` documents prompt-engineering tradeoffs explored during development.
- `audits/` holds dated review docs (e.g., `supabase-audit-2026-04-10.md`).

## Conventions

- Components: `PascalCase.tsx` with optional colocated `.css` of the same name.
- Utilities & hooks: `camelCase.ts`. Tests are `<name>.test.ts` colocated next to the file under test.
- DB columns: `snake_case`; TypeScript fields: `camelCase`. The auto-generated `database.types.ts` exposes the snake_case shape — convert at the API boundary in `api/client.ts`.
- Pages compose contexts + components; `lib/` stays free of React imports.
- Don't reach into Supabase tables that have RLS from the client without an authenticated session — queries will silently return empty.
- When adding a migration, regenerate `client/src/lib/database.types.ts` and update `types/index.ts` if user-facing shapes change.
