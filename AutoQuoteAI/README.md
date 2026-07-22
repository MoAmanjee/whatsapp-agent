# AutoQuoteAI

Commercial multi-tenant SaaS: **AI WhatsApp sales agents** for product businesses.
First industry plugin: automotive parts. Platform core is generic (hardware, plumbing, electrical, tyre, furniture, appliance).

This is **not** a chatbot. It is a quote-first sales operating system on WhatsApp.

## Run on your HOME PC (not work)

Copy this entire folder home, then follow **[RUN_AT_HOME.md](./RUN_AT_HOME.md)**.

```powershell
cd AutoQuoteAI
.\scripts\bootstrap-home.ps1
pnpm dev
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md).

## Monorepo

```
apps/web          Merchant dashboard (Next.js)
apps/api          REST + WhatsApp/Stripe webhooks (Fastify)
apps/worker       AI workflows, quote send (BullMQ)
packages/*        Domain modules + industry plugins
scripts/          Home PC bootstrap
```

## License

Proprietary — personal commercial project.
