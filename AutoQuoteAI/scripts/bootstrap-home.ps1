# AutoQuoteAI home bootstrap (Windows)
# Run from the AutoQuoteAI folder. Does not touch anything outside this directory.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

Write-Host "==> AutoQuoteAI home bootstrap" -ForegroundColor Cyan

function Require-Cmd($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Host "MISSING: $name" -ForegroundColor Red
    Write-Host "Install it, then re-run this script. See RUN_AT_HOME.md"
    exit 1
  }
}

Require-Cmd node
Require-Cmd npm
Require-Cmd pnpm
Require-Cmd docker

$nodeMajor = [int]((node -v).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 22) {
  Write-Host "Node $($nodeMajor) detected. Please install Node.js 22 LTS." -ForegroundColor Red
  exit 1
}

if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Write-Host "Created .env from .env.example — edit AUTH_SECRET before production." -ForegroundColor Yellow
}

Write-Host "==> pnpm install"
pnpm install

Write-Host "==> docker compose up -d"
docker compose up -d

Write-Host "==> waiting for Postgres"
Start-Sleep -Seconds 5

Write-Host "==> prisma generate + migrate"
pnpm db:generate
pnpm --filter @autoquoteai/db exec prisma migrate dev --name init --skip-seed

Write-Host ""
Write-Host "Bootstrap complete." -ForegroundColor Green
Write-Host "Start everything with:  pnpm dev"
Write-Host "Then open:             http://localhost:3000"
Write-Host "Follow:                RUN_AT_HOME.md"
