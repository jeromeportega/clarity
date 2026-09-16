# Environment Variables

Configure these in the Vercel project (Settings → Environment Variables) or in a
local `.env` (gitignored). **Never commit values** — this file lists names only.

| Variable | Required | Description |
|---|---|---|
| `TURSO_DATABASE_URL` | Prod: yes | libSQL connection string, format `libsql://<db>.turso.io`. Unset locally → file DB under `data/` |
| `TURSO_AUTH_TOKEN` | Prod: yes | Turso auth token for the database above |
| `ANTHROPIC_API_KEY` | For live vision / SKU resolution | Without it the upload route falls back to recorded fixtures — fine for tests, useless for real receipts |
| `RECONCILE_MUTATION_TOKEN` | Yes | Secret that gates all mutation routes (`x-reconcile-token` header). Generate with `openssl rand -hex 32`. Read only by `apps/web/app/lib/auth/token.ts` (the boolean gate) and `apps/web/instrumentation.ts` (a startup existence check that never logs the value); a test fails if any other file under `apps/web` mentions it |
| `PUBLIC_DEMO_MODE` | Public demo only | Set to `1` to pin all reads to the demo household, read-only, for everyone — no sign-in needed, and Clerk keys, if present, are ignored (a startup error says so). Leave unset on a private deployment |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Private deployment | Clerk sign-in. Both set (and `PUBLIC_DEMO_MODE` not `1`) → sign-in exists: a signed-in, allowlisted person reads and writes their own household, the queue actions and uploads work in the browser. Either unset → no sessions anywhere: reads need `PUBLIC_DEMO_MODE`, writes the token. Provisioned by the Vercel Marketplace Clerk integration. The publishable key is inlined at **build** time: adding or changing it needs a redeploy, not just an env edit. Restrict sign-up in the Clerk dashboard too (invitation-only or allowlisted domains) — the app admits nobody it does not allowlist, but keeping strangers out of Clerk itself is cheaper still |
| `CLARITY_OPERATOR_EMAILS` | Private deployment | Comma-separated emails that may be given a household of their own on first sign-in (the operator's). Unset → nobody is provisioned; every sign-in lands on `/no-access` |
| `CLERK_AUTHORIZED_PARTIES` | No | Extra origins (comma-separated, e.g. a custom domain) Clerk session tokens are accepted for; the production domain and the deployment URL are always included |
| `BLOB_READ_WRITE_TOKEN` | Prod: yes | Vercel Blob (private store `clarity-receipts`, connected to the project by `vercel blob create-store`). Receipt images live there, served only through `/api/receipts/image/[receiptId]` after the household check. Unset → images go to `<CLARITY_DATA_DIR>/receipt-images` on the local disk (a Vercel deployment without it logs an error at startup: that disk is not durable) |
| `RECON_BACKEND` | No | Leave unset for the DB-backed reconciliation gateway (the default). `stub` opts out to the hardcoded demo rows — tests and throwaway demos only |
| `CLARITY_DATA_DIR` | No | Directory for the local file database when `TURSO_*` is unset (default `./data`) |
| `RECEIPT_EVAL_DIR`, `RECEIPT_EVAL_RATIO` | No | `npm run vision:eval` overrides: receipt directory and Dice-similarity ratio |
| `E2E_BASE_URL` | No | Playwright target for `npm run e2e` (defaults to the deployed URL in `playwright.config.ts`) |

## Notes

- `DEMO_HOUSEHOLD_ID` is a code constant (`modules/finance/core/scope.ts`), not
  an env var, so the seed and public-mode reads can't drift apart.
- Mutations are gated by `RECONCILE_MUTATION_TOKEN` regardless of `PUBLIC_DEMO_MODE`.
- After setting variables: `npm run db:migrate --workspace=@clarity/finance`,
  then optionally `npm run seed:demo`.
- **Before a deploy that changes the read backend or the schema:** (1) apply
  the new migrations to the production database from a checkout that contains
  them (migration 0006 adds `matches.receipt_id` / `order_id`); (2) confirm the
  production database is seeded or imported — with the DB-backed gateway the
  queue and True Spend show what is in Turso, and `deploy/smoke.sh` expects a
  non-empty queue; (3) check the Vercel value of `RECON_BACKEND` in the
  dashboard — the CLI cannot read it — and remove it (or set `live`) unless
  the stub demo rows are wanted; a stale `stub` silently keeps the old rows.
- No secret is ever read from the repo; deploys run from an authenticated
  Vercel session (`deploy/deploy.sh`), and `deploy/smoke.sh` verifies the
  deployment from the outside.
