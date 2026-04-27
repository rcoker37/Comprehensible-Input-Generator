#!/usr/bin/env bash
#
# Sync the linked Supabase project's data into the local Supabase DB.
#
# Prereqs:
#   - Docker Desktop running
#   - `npx supabase link --project-ref <ref>` already configured
#
# What it does:
#   1. Dumps prod auth + public schemas (data only) to a temp dir.
#   2. Resets the local DB (drops everything, replays migrations + seed).
#   3. Restores auth, then public — using psql inside the Supabase DB
#      container so no host psql install is required.
#
# What it does NOT do:
#   - Sync storage objects (e.g. story-audio MP3s — different transport).
#   - Decrypt vault secrets (e.g. profiles.openrouter_api_key) — encryption
#     keys differ per project. Re-add your API key in local Settings after.

set -euo pipefail

WORKDIR="$(mktemp -d -t supabase-sync.XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "→ Ensuring local Supabase is up"
if ! npx supabase status >/dev/null 2>&1; then
  echo "  starting local stack..."
  npx supabase start
fi

DB_CONTAINER="$(docker ps --filter name=supabase_db --format '{{.Names}}' | head -n1)"
if [ -z "$DB_CONTAINER" ]; then
  echo "✗ Could not find a running supabase_db_* container." >&2
  exit 1
fi

run_sql() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"
}

echo "→ Dumping prod data → $WORKDIR"
npx supabase db dump --linked --data-only --schema auth   -f "$WORKDIR/auth.sql"
npx supabase db dump --linked --data-only --schema public -f "$WORKDIR/public.sql"

echo "→ Resetting local DB (drops everything, replays migrations + seed)"
npx supabase db reset

echo "→ Restoring auth then public (via $DB_CONTAINER)"
run_sql < "$WORKDIR/auth.sql"
# seed.sql populated kanji during reset; clear it so prod's identical rows
# don't trip the primary-key constraint. CASCADE clears the (already empty)
# user_kanji FK dependents too.
run_sql -c "TRUNCATE kanji RESTART IDENTITY CASCADE;"
run_sql < "$WORKDIR/public.sql"

echo "✓ Local DB now mirrors prod data."
echo "  Note: storage objects and vault secrets are NOT synced."
echo "  Re-add your OpenRouter API key in local Settings if you need to generate."
