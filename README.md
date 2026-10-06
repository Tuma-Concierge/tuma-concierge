# Tuma Concierge

Uganda boda shopping concierge — customers post shopping lists; verified riders buy and deliver.

## Stack (staging, free-tier)

- **Monorepo** `xristo7/tuma-concierge`
- **Apps:** `apps/customer`, `apps/rider`, `apps/admin` (Next.js App Router → **Cloudflare Workers** via OpenNext)
- **API:** `apps/api` (Hono → **Cloudflare Worker**); `workers/api` is an unrelated legacy scaffold — leave alone
- **DB:** Cloudflare D1 (`tuma-api`), bound natively to the API Worker. Turso backs local dev only.
- **Shared:** `packages/shared` (`@tuma/shared`)

See **[infra/CLOUDFLARE.md](./infra/CLOUDFLARE.md)** for deploy commands, required secrets, and
known gotchas. Render (`render.yaml`) is kept for reference/rollback but is no longer the active
deploy target — see **[FRONTEND.md](./FRONTEND.md)**.

## Layout

```
apps/customer/   # customer web PWA
apps/rider/      # rider web PWA
apps/admin/      # admin dashboard (riders, customers, orders, integrations)
apps/api/        # real backend (Hono, on Cloudflare Workers)
workers/api/     # legacy CF worker scaffold — leave alone
packages/shared/ # OrderStage, PaymentRail, API client for the real backend
tools/stubs/     # sharp no-op stub (see infra/CLOUDFLARE.md gotchas)
infra/           # env matrix, deploy notes
```

## Environments

| Env | Services | DB |
|-----|----------|-----|
| staging | `tuma-api`, `tuma-customer`, `tuma-rider`, `tuma-admin` (Cloudflare Workers) | D1 `tuma-api` |
| production | *blocked until Sharon OK* | *blocked* |

## Secrets

Never commit `.env` or secrets. Cloudflare secrets are set via `wrangler secret put` (see
`infra/CLOUDFLARE.md`). See `infra/ENV.md` for the full env name matrix.
