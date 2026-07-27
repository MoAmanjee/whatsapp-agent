# WhatsApp Agent — AutoQuoteAI

Commercial multi-tenant SaaS: **AI WhatsApp sales agents** for product businesses.
First industry plugin: automotive parts.

Repo layout:

```
AutoQuoteAI/     ← the product (monorepo)
```

## Quick start (macOS / Linux)

```bash
cd AutoQuoteAI
chmod +x scripts/bootstrap-home.sh
./scripts/bootstrap-home.sh
pnpm dev
```

Open http://localhost:3000 — signup → Settings (seed demo) → WhatsApp (demo message) → Inbox / Quotes.

## Docs

| Doc | Purpose |
|-----|---------|
| [AutoQuoteAI/RUN_AT_HOME.md](./AutoQuoteAI/RUN_AT_HOME.md) | Local demo walkthrough |
| [AutoQuoteAI/SETUP.md](./AutoQuoteAI/SETUP.md) | Tooling prerequisites |
| [AutoQuoteAI/GOLIVE.md](./AutoQuoteAI/GOLIVE.md) | Real Meta WhatsApp go-live |
| [AutoQuoteAI/ARCHITECTURE.md](./AutoQuoteAI/ARCHITECTURE.md) | System design |

## Requirements

- Node.js 22+
- pnpm 9
- Docker (Postgres + Redis + MinIO) — or your own Postgres/Redis
