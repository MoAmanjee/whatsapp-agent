# Setup — required tools (not present on this machine when scaffolded)

AutoQuoteAI is portable. Install these on **your** computer, then run everything inside this folder only.

## 1. Node.js 22 LTS

Download: https://nodejs.org/

After install, open a **new** PowerShell:

```powershell
node -v   # should show v22.x
npm -v
```

## 2. pnpm

```powershell
npm install -g pnpm@9
pnpm -v
```

## 3. Docker Desktop

Download: https://www.docker.com/products/docker-desktop/

Start Docker Desktop, then:

```powershell
docker -v
docker compose version
```

## 4. Bootstrap this project

```powershell
cd C:\Users\mohammed.amanjee\AutoQuoteAI
Copy-Item .env.example .env
# Edit .env — set AUTH_SECRET to a long random string
pnpm install
docker compose up -d
pnpm db:generate
pnpm db:migrate
pnpm dev
```

Optional RLS hardening (after migrate, if `psql` is available):

```powershell
psql $env:DATABASE_URL -f packages/db/prisma/migrations/rls_policies.sql
```

## 5. Verify

- Web: http://localhost:3000  
- API health: http://localhost:4000/health  
- Ready: http://localhost:4000/ready  

## Notes

- Without Stripe keys, billing uses an offline stub.
- Without WhatsApp tokens, outbound messages are logged by the stub provider.
- Do not copy credentials from any work/company environment into this project.
