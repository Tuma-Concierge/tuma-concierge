# Cloudflare (primary staging host)

All three services now run on Cloudflare Workers. Render config (`render.yaml`) is kept
for reference/rollback but is no longer the active deploy target.

| Service | Type | URL |
|---|---|---|
| `tuma-api` | Worker (Hono) | https://tuma-api.doxalight-inc.workers.dev |
| `tuma-customer` | Worker (Next.js via OpenNext) | https://tuma-customer.doxalight-inc.workers.dev |
| `tuma-rider` | Worker (Next.js via OpenNext) | https://tuma-rider.doxalight-inc.workers.dev |
| `tuma-admin` | Worker (Next.js via OpenNext) | not yet deployed — `apps/admin`, same deploy flow as customer/rider |

**Database: Cloudflare D1** (`tuma-api`, id `26926e12-d2f4-4b40-8b1b-019f6c169e10`), bound
natively to the `tuma-api` Worker as `env.DB` — no cross-provider HTTP hop. This is a
*separate* database from the old Turso `tuma-staging` one: that DB has its own unrelated
19-table schema from earlier scaffolding (a real `users` table with different columns —
discovered the hard way, via `no such column: id` in production), so rather than touch
tables we don't understand, this app gets a dedicated D1 database with its own schema.
Turso is kept as a **local-dev-only fallback** in `apps/api/src/db/client.ts` (used when no
D1 binding is present, e.g. under plain `pnpm dev`) — see `TURSO_DATABASE_URL` below.

## Requirements

- **Node ≥ 22** for `wrangler` v4 (the OpenNext Cloudflare adapter requires it). If your
  default Node is older, point `PATH` at a Node 22 install for deploy commands only —
  the build step (`opennextjs-cloudflare build`) works fine on older Node.
- `wrangler` authenticated (`wrangler login` or an API token in `CLOUDFLARE_API_TOKEN`).

## Deploy

```bash
# API (Hono → Worker)
pnpm --filter api deploy          # wrangler deploy

# Customer / Rider / Admin (Next.js → Worker via OpenNext)
pnpm --filter customer deploy     # opennextjs-cloudflare build && wrangler deploy
pnpm --filter rider deploy
pnpm --filter admin deploy        # not yet deployed — creates the tuma-admin Worker on first run
```

`autoDeploy`-style CI isn't wired up yet — deploys are manual (`wrangler deploy`) until a
GitHub Actions workflow is added.

## Config

- `apps/api/wrangler.jsonc` — `d1_databases` binding (`DB` → `tuma-api`), `vars` for CORS
  origins and MoMo sandbox settings. Secrets (`JWT_SECRET`, MoMo credentials) are set via
  `wrangler secret put <NAME>` — never committed, never put in `vars`.
- `apps/customer/wrangler.jsonc`, `apps/rider/wrangler.jsonc`, `apps/admin/wrangler.jsonc` —
  static assets binding + `NEXT_PRIVATE_MINIMAL_MODE=1` (see gotcha below).
  `NEXT_PUBLIC_API_URL` is baked in at **build** time via `.env.production` in each app
  (safe to commit — it's a public value).

### Secrets already set

```bash
cd apps/api
wrangler secret put JWT_SECRET   # done

# Optional, only needed to test MoMo escrow funding/payout:
wrangler secret put MOMO_SUBSCRIPTION_KEY
wrangler secret put MOMO_API_USER
wrangler secret put MOMO_API_KEY
```

### Local dev (Turso fallback)

`apps/api/src/db/client.ts` uses D1 (`env.DB`) when running as a Worker, and falls back to
`TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` when no D1 binding exists (plain `pnpm dev`/`tsx`,
which can't see D1 bindings). For local dev, point that at a `turso dev` instance — **not**
the old `tuma-staging` Turso DB, which has an unrelated schema (see above). Run
`pnpm --filter api migrate` against it to apply this app's schema.

## Known gotchas (already worked around in this repo)

- **`sharp` breaks the Workers bundle.** Next.js's built-in image optimizer references
  `sharp` (native binary) even with `images.unoptimized: true`. Fixed via a pnpm override
  pointing `sharp` at a tiny no-op stub (`tools/stubs/sharp/`, wired in the root
  `package.json`'s `pnpm.overrides`) — safe because neither app calls `next/image`.
- **`Dynamic require of ".../middleware-manifest.json" is not supported`.** A known
  opennextjs-cloudflare bug under pnpm's symlinked `node_modules`
  ([opennextjs-cloudflare#1232](https://github.com/opennextjs/opennextjs-cloudflare/issues/1232)).
  Worked around with `NEXT_PRIVATE_MINIMAL_MODE=1` in each frontend's `wrangler.jsonc`
  vars — disables Next.js middleware support, which neither app uses.
  Revisit if you ever add `middleware.ts`.
- **`wrangler deploy` crashes with `Error: write EOF` on Windows** when it auto-detects an
  OpenNext project and re-delegates to `opennextjs-cloudflare deploy` internally. Worked
  around by building first (`opennextjs-cloudflare build`) then deploying with
  `OPEN_NEXT_DEPLOY=true wrangler deploy`, which skips the auto-delegation (already
  wired into each app's `deploy` npm script... except the script itself calls
  `opennextjs-cloudflare build && wrangler deploy`, which still hits this on native
  Windows — WSL or CI/Linux runners don't have this problem).
- **`workerd` postinstall fails / `wrangler dev` doesn't work** on this Windows Server
  environment specifically (missing shared libs for the local runtime binary).
  `wrangler deploy` (real deploys) is unaffected — only local preview is.
