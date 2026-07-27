#!/usr/bin/env bash
# AutoQuoteAI home bootstrap (macOS / Linux)
# Run from the AutoQuoteAI folder. Does not touch anything outside this directory.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> AutoQuoteAI home bootstrap"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "MISSING: $1"
    echo "Install it, then re-run this script. See RUN_AT_HOME.md"
    exit 1
  fi
}

need node
need npm
need pnpm

NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node $NODE_MAJOR detected. Please install Node.js 22 LTS."
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  # Generate secrets for local use
  if command -v openssl >/dev/null 2>&1; then
    AUTH=$(openssl rand -hex 32)
    TOKEN=$(openssl rand -hex 32)
    if [[ "$OSTYPE" == darwin* ]]; then
      sed -i '' "s/change-me-to-a-long-random-string/$AUTH/" .env
      sed -i '' "s/change-me-to-a-long-random-token-encryption-key/$TOKEN/" .env
    else
      sed -i "s/change-me-to-a-long-random-string/$AUTH/" .env
      sed -i "s/change-me-to-a-long-random-token-encryption-key/$TOKEN/" .env
    fi
  fi
  echo "Created .env from .env.example"
fi

echo "==> pnpm install"
pnpm install

if command -v docker >/dev/null 2>&1; then
  echo "==> docker compose up -d"
  docker compose up -d
  echo "==> waiting for Postgres"
  sleep 5
else
  echo "WARNING: docker not found."
  echo "Install Docker Desktop (https://www.docker.com/products/docker-desktop/)"
  echo "or Colima, then re-run. Alternatively start Postgres + Redis yourself"
  echo "and set DATABASE_URL / REDIS_URL in .env"
  if ! nc -z localhost 5432 2>/dev/null; then
    echo "Postgres does not appear to be listening on :5432 — aborting."
    exit 1
  fi
  if ! nc -z localhost 6379 2>/dev/null; then
    echo "Redis does not appear to be listening on :6379 — aborting."
    exit 1
  fi
fi

echo "==> prisma generate + migrate"
pnpm db:generate
pnpm --filter @autoquoteai/db exec prisma migrate deploy

echo "==> build packages"
pnpm --filter @autoquoteai/shared build
pnpm --filter @autoquoteai/db build
pnpm --filter @autoquoteai/industry-sdk build
pnpm --filter @autoquoteai/industry-automotive build
pnpm --filter @autoquoteai/industry-generic build
pnpm --filter @autoquoteai/whatsapp build
pnpm --filter @autoquoteai/ai build
pnpm --filter @autoquoteai/billing build
pnpm --filter @autoquoteai/quotes build
pnpm --filter @autoquoteai/core build

echo ""
echo "Bootstrap complete."
echo "Start everything with:  pnpm dev"
echo "Then open:             http://localhost:3000"
echo "Follow:                RUN_AT_HOME.md"
