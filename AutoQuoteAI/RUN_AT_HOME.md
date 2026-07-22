# Run AutoQuoteAI on your HOME PC

This folder is a **portable personal project**. Copy the entire `AutoQuoteAI` folder to a USB drive / cloud / git remote, then run it on your home computer. Do **not** run it on a work PC.

## What you need at home

1. **Node.js 22 LTS** — https://nodejs.org/
2. **pnpm** — `npm install -g pnpm@9`
3. **Docker Desktop** — https://www.docker.com/products/docker-desktop/
4. **Git** (optional but recommended)

## One-command bootstrap (Windows PowerShell)

```powershell
cd path\to\AutoQuoteAI
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\bootstrap-home.ps1
```

That script will:

- copy `.env.example` → `.env` if missing
- `pnpm install`
- start Postgres / Redis / MinIO via Docker
- generate Prisma client + run migrations
- print how to start the apps

## Start the product

```powershell
pnpm dev
```

Open:

| App | URL |
|-----|-----|
| Merchant dashboard | http://localhost:3000 |
| API health | http://localhost:4000/health |

## First 5 minutes demo (no Meta / Stripe needed)

1. Sign up at http://localhost:3000/signup  
2. **Settings** → Seed automotive demo catalog  
3. **WhatsApp** → Send demo message (pre-filled oil filter request)  
4. **Inbox** → see AI reply  
5. **Quotes** → approve / send / view HTML quote document  

Outbound WhatsApp uses a **stub** that logs to the worker console until you paste real Meta credentials.

## Copy checklist

Bring the whole folder including:

- `apps/`, `packages/`, `scripts/`
- `package.json`, `pnpm-workspace.yaml`, `turbo.json`
- `docker-compose.yml`, `.env.example`
- `ARCHITECTURE.md`, `README.md`, this file

Do **not** need: `node_modules`, `.env` with secrets from elsewhere, Docker volumes from work.

## Optional later (real integrations)

Edit `.env` at home:

- `STRIPE_SECRET_KEY` + price IDs → live billing  
- `WHATSAPP_*` + connect WABA in dashboard → real WhatsApp  
- `OPENAI_API_KEY` → future LLM slot-filling upgrade (core workflow already works without it)

## Architecture

See `ARCHITECTURE.md` for the full SaaS design.
