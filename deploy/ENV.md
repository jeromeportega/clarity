# Environment Variables

Configure these in the Vercel project (Settings → Environment Variables) or in a
local `.env` (gitignored). **Never commit values** — this file lists names only.

| Variable | Required | Description |
|---|---|---|
| `TURSO_DATABASE_URL` | Prod: yes | libSQL connection string, format `libsql://<db>.turso.io`. Unset locally → file DB under `data/` |
| `TURSO_AUTH_TOKEN` | Prod: yes | Turso auth token for the database above |
| `ANTHROPIC_API_KEY` | For live vision / SKU resolution | Without it the upload route falls back to recorded fixtures — fine for tests, useless for real receipts |
| `RECONCILE_MUTATION_TOKEN` | Yes | Secret that gates all mutation routes (`x-reconcile-token` header). Generate with `openssl rand -hex 32`. Server-side only — must never reach the client |
| `PUBLIC_DEMO_MODE` | Public demo only | Set to `1` to pin all reads to the demo household and enable the read endpoints |
| `RECON_BACKEND` | No | `live` (DB-backed reconciliation gateway) or `stub` (hardcoded demo rows; default today). Use `live` for any real deployment |

## Notes

- `DEMO_HOUSEHOLD_ID` is a code constant (`modules/finance/core/scope.ts`), not
  an env var, so the seed and public-mode reads can't drift apart.
- Mutations are gated by `RECONCILE_MUTATION_TOKEN` regardless of `PUBLIC_DEMO_MODE`.
- After setting variables: `npm run db:migrate --workspace=@clarity/finance`,
  then optionally `npm run seed:demo`.
- No secret is ever read from the repo; deploys run from an authenticated
  Vercel session (`deploy/deploy.sh`), and `deploy/smoke.sh` verifies the
  deployment from the outside.
