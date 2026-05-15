#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()    { echo -e "${GREEN}[setup]${NC} $*"; }
warn()    { echo -e "${YELLOW}[setup]${NC} $*"; }
err()     { echo -e "${RED}[setup] ERROR:${NC} $*" >&2; }
die()     { err "$*"; exit 1; }

# ── Prerequisites ────────────────────────────────────────────────────────────

check_command() {
  command -v "$1" &>/dev/null || die "'$1' is not installed or not on PATH. $2"
}

info "Checking prerequisites..."
check_command node  "Install Node.js >=20.19.0 from https://nodejs.org"
check_command npm   "Install Node.js >=20.19.0 from https://nodejs.org"
check_command docker "Install Docker Desktop from https://www.docker.com/products/docker-desktop"

NODE_VERSION="$(node --version | sed 's/v//')"
NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"
NODE_MINOR="$(echo "$NODE_VERSION" | cut -d. -f2)"
NODE_PATCH="$(echo "$NODE_VERSION" | cut -d. -f3)"
if [[ "$NODE_MAJOR" -lt 20 ]] || [[ "$NODE_MAJOR" -eq 20 && "$NODE_MINOR" -lt 19 ]] || [[ "$NODE_MAJOR" -eq 20 && "$NODE_MINOR" -eq 19 && "$NODE_PATCH" -lt 0 ]]; then
  die "Node.js >=20.19.0 is required (found v${NODE_VERSION}). Update at https://nodejs.org"
fi

docker info &>/dev/null || die "Docker daemon is not running. Start Docker Desktop and try again."

# ── .env.local ───────────────────────────────────────────────────────────────

if [[ ! -f .env.local ]]; then
  info "Creating .env.local from .env.local.example..."
  cp .env.local.example .env.local
  warn ".env.local created with local Supabase defaults."
  warn "After setup, log in to the app and paste your OpenRouter API key in Settings."
else
  info ".env.local already exists — skipping."
fi

# ── npm install ───────────────────────────────────────────────────────────────

info "Installing npm dependencies (this also copies kuromoji dict files)..."
npm install

# ── Supabase ─────────────────────────────────────────────────────────────────

info "Starting local Supabase (this may take a minute on first run)..."
npx supabase start

info "Applying migrations and seeding data..."
npx supabase db reset

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
info "Local dev environment is ready."
echo ""
echo "  Start the dev server:     npm run dev"
echo "  Serve Edge Functions:     npx supabase functions serve --env-file .env.local"
echo "  Run tests:                npm test"
echo "  Dev login:                dev@local.test / devpassword"
echo ""
warn "Your OpenRouter API key is NOT seeded. Log in and add it via the Settings page."
