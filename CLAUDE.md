# Clarity — working notes for agents

Clarity is a household-finance product: bank exports + Amazon order history +
big-box receipts → Claude vision → SKU disambiguation → reconciliation (every
dollar counted once) → item-level classification → a human review queue.
Read `README.md` first, then `docs/ARCHITECTURE.md` (module map, data model,
and the honest list of what is not yet wired) and `docs/ROADMAP.md`.

## Layout

- `apps/web` — Next.js App Router. Pages, API routes, UI. Reaches into the
  domain module via relative imports (`../../../../modules/finance/...` from
  shallow files; deeper routes need more `../`). `@/` resolves to `apps/web/`.
- `modules/finance/core` — pure domain logic behind DI seams (adapters, vision
  provider, SKU resolver/dictionary, reconcile engine, classifier, queue,
  corrections, rollups, evidence). **Never builds a model provider, reads a credential, constructs a DB
  client, or imports a framework** — models arrive by injection as AI SDK
  `LanguageModel`s (AI Gateway ids in practice; core holds the default ids in
  `receipts/model-ids.ts` but constructs nothing). `core/__tests__/core-boundary.test.ts`
  and `receipts/framework-isolation.test.ts` enforce the import side: no next/react,
  no `@ai-sdk/gateway`, `@anthropic-ai/sdk`, `@clerk/*`, `@vercel/blob` in core.
- `modules/finance/db` — Drizzle schema + migrations + `createDb()`
  (Turso when `TURSO_*` is set, otherwise a local file under `data/`).
- `tests/` — cross-cutting: real route handlers against fresh libSQL, toolchain
  pins, deploy-artifact hygiene.

## Commands

```bash
npm ci
npm test                 # Vitest, offline + deterministic — the CI gate
npm run typecheck        # tsc --noEmit (CI runs this too; Vitest alone won't catch JSX/import-path errors in apps/web)
npm run build --workspace=@clarity/web   # run before deploying; catches apps/web import errors tests miss
npm run vision:eval      # key-gated live vision accuracy harness — NEVER in npm test
npm run e2e              # Playwright golden path — NEVER in npm test
```

## Conventions that matter

- **Integer cents everywhere.** No floats for money.
- **Real financial data never enters git.** Fixtures are synthetic/sanitized.
  `data/`, `uploads/`, `*.db`, `.env*` are gitignored. Local real data lives
  outside the repo or under `data/`.
- **Vision output is untrusted data.** The extraction prompt's injection guard
  and the `readable: false` path are load-bearing — don't weaken them.
- **Low confidence → review queue, never a silent guess.** Preserve confidence
  fields and `needs_review` flags through any refactor.
- **Every dollar counted once.** `reconcile/dedup.ts` (`mergeCounted`) is the
  invariant; its tests are bank-anchored and must stay green.
- **Tests first from acceptance criteria**, kept fast and offline. Anything
  that needs a network or an API key goes behind its own script, never `npm test`.
- **One taxonomy**: `modules/finance/db/taxonomy.ts` (slug ids, display names).
  `categories.id`, `receipt_items.category_id`, `sku_dictionary.category` and
  corrections all carry the slug id; the classifier emits the display name and
  the sink maps it with `categoryIdFor`. Never introduce a second list.

## Workflow

- Work on a feature branch; open a PR to `main`. Treat `main` as protected:
  PRs only — no direct pushes, no force flags, no history rewrites. CI runs
  typecheck + the offline Vitest suite on every PR. Every PR gets a review
  pass from a fresh reviewer persona before merge.
- Deploys are an operator step from an authenticated Vercel session
  (`deploy/deploy.sh` prints the command; `deploy/smoke.sh` verifies). Secrets
  live only in Vercel env / local `.env` — see `deploy/ENV.md` (names only).

## Loom

This repo also carries a `loom` policy (`.loom/policy.yaml`) for optional
autonomous epic execution (`loom epic` → plan → `loom approve` → `loom run`).
When the loom PreToolUse hook is installed it checks every Bash command against
that policy (protected paths, forbidden git flags, command chaining). Work with
the guardrails; never try to bypass them.
