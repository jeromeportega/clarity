# Environment Variables

Configure these in the Vercel project dashboard (Settings → Environment Variables)
before deploying. **Never commit values** — list names only.

| Variable | Required | Description |
|---|---|---|
| `TURSO_DATABASE_URL` | Yes | libSQL connection string — format `libsql://<db>.turso.io` |
| `TURSO_AUTH_TOKEN` | Yes | Turso auth token for the database above |
| `RECONCILE_MUTATION_TOKEN` | Yes | Secret that gates all mutation routes (`x-reconcile-token` header). Generate with `openssl rand -hex 32` |
| `PUBLIC_DEMO_MODE` | Yes | Set to `1` to pin all reads to the demo household. Required for the public demo deployment |
| `RECON_BACKEND` | No | `stub` (default) or `live`. Use `stub` unless live reconciliation calls are needed |

## Notes

- `DEMO_HOUSEHOLD_ID` is a **code constant** (`modules/finance/core/scope.ts`), not an env var.
  Seed data and public-mode reads are always in sync; no env var to drift.
- Mutations remain gated by `RECONCILE_MUTATION_TOKEN` regardless of `PUBLIC_DEMO_MODE`.
- After setting all variables, run the demo seed from an authenticated session:
  `pnpm seed:demo`

## References

- ADR-006: no secret may enter a worktree; deploy is an operator step.
- NFR-5: env values are never committed; names only are documented here.
