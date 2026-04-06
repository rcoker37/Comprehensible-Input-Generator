# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A local web app that generates short Japanese stories constrained to kanji the user knows, using a local LLM (Ollama with gemma4:27b). Designed for Japanese reading practice via comprehensible input.

## Commands

```bash
# Install dependencies (all workspaces)
npm install

# Fetch kanji seed data from kanjiapi.dev (~2140 joyo kanji, takes ~1 min)
npx tsx data/fetch-kanji.ts

# Seed the SQLite database from data/kanji.json
npm run seed

# Run both server and client in dev mode
npm run dev

# Run individually
npm run dev --workspace=server   # Express on :3001
npm run dev --workspace=client   # Vite on :5173, proxies /api to :3001

# Build client for production
npm run build --workspace=client
```

## Architecture

Monorepo with npm workspaces: `client/` (Vite + React + TS) and `server/` (Express + TS + SQLite).

**Server** (`server/src/`):
- `routes/kanji.ts` — CRUD for kanji known-status, bulk updates, filtering/search
- `routes/stories.ts` — Story generation via Ollama, validation, CRUD
- `services/ollama.ts` — Prompt construction and Ollama API calls. Formality and grammar level are mapped to Japanese-specific prompt instructions
- `services/validation.ts` — Extracts kanji from generated text via Unicode range regex, checks against allowed set
- `services/difficulty.ts` — Computes reading level estimate from kanji grade/JLPT stats
- `db/connection.ts` — SQLite via better-sqlite3, auto-creates schema on first access. DB stored at `data/kanji.db`

**Client** (`client/src/`):
- `api/client.ts` — All backend calls, uses Vite proxy in dev (`/api` -> `:3001`)
- `pages/Generator.tsx` — Home page: paragraph count, topic, formality, kanji filters -> generate story
- `pages/KanjiManager.tsx` — Grid of all kanji, click to toggle known, bulk mark by grade/JLPT
- `pages/Stories.tsx` / `StoryDetail.tsx` — Story history and detail view

**Generation flow**: Build kanji allow-list from filters -> construct prompt with kanji constraint + grammar level + formality -> call Ollama -> validate output contains only allowed kanji -> retry up to 3x on failure -> compute difficulty -> save to DB.

## Key Details

- Kanji grades use the kanjiapi.dev convention: 1-6 for elementary school, 8 for secondary (no grade 7)
- JLPT levels: 5 = easiest, 1 = hardest. ~176 kanji have no JLPT classification
- Server listens on 0.0.0.0 for local network access
- Ollama URL configurable via `OLLAMA_URL` env var (default: `http://localhost:11434`)
- Model configurable via `OLLAMA_MODEL` env var (default: `gemma4:27b`)
