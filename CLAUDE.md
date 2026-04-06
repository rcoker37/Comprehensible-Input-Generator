# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A web app that generates short Japanese stories constrained to kanji the user knows, using OpenRouter LLM APIs. Designed for Japanese reading practice via comprehensible input. Each user has their own kanji known-state and story history.

## Commands

```bash
# Install dependencies
npm install

# Start local Supabase (requires Docker)
npx supabase start

# Apply migrations and seed data
npx supabase db reset

# Generate seed SQL from kanji.json (only needed if kanji data changes)
npm run generate-seed

# Generate TypeScript types from Supabase schema
npx supabase gen types typescript --local > client/src/lib/database.types.ts

# Run client dev server
npm run dev

# Build client
npm run build

# Serve Edge Functions locally
npx supabase functions serve

# Deploy Edge Functions
npx supabase functions deploy generate-story
```

## Architecture

**Client** (`client/`): Vite + React + TypeScript. Talks directly to Supabase (no backend server).

- `lib/supabase.ts` — Supabase client singleton
- `contexts/AuthContext.tsx` — Auth state provider (session, user, profile)
- `api/client.ts` — All data operations via Supabase SDK. Kanji uses `get_user_kanji` RPC. Stories use direct table queries (RLS-scoped). Generation invokes the `generate-story` Edge Function.
- `pages/Generator.tsx` — Story generation with kanji filters, formality, topic
- `pages/KanjiManager.tsx` — Grid of 2,140 kanji, click to toggle known, bulk operations
- `pages/Stories.tsx` / `StoryDetail.tsx` — Story history and detail view
- `pages/Login.tsx` — Email/password + Google OAuth
- `pages/Settings.tsx` — OpenRouter API key and model configuration

**Supabase** (`supabase/`):
- `migrations/001_initial_schema.sql` — Tables (kanji, user_kanji, stories, profiles), RLS policies, `get_user_kanji` RPC, auto-profile trigger
- `seed.sql` — 2,140 joyo kanji reference data
- `functions/generate-story/` — Edge Function (Deno): builds kanji allow-list, calls OpenRouter, validates output, retries up to 3x, computes difficulty, saves story

## Data Model

- `kanji` — Reference data (read-only). character PK, grade (1-6, 8=secondary), jlpt (5=easiest, 1=hardest), meanings, readings
- `user_kanji` — Per-user known state. Composite PK (user_id, character). Missing row = unknown.
- `stories` — Per-user stories. JSONB columns for filters and difficulty. RLS-scoped.
- `profiles` — Auto-created on signup. Stores openrouter_api_key and preferred_model.

## Key Details

- Kanji grades use kanjiapi.dev convention: 1-6 for elementary, 8 for secondary (no grade 7)
- JLPT levels: 5 = easiest, 1 = hardest. ~176 kanji have no JLPT classification
- `get_user_kanji` RPC returns all kanji with `COALESCE(uk.known, false)` — avoids pre-populating 2,140 rows per user
- Edge Function reads OpenRouter API key from profiles table using service role (bypasses RLS)
- OpenRouter API is OpenAI-compatible (chat completions endpoint)
- Client env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
