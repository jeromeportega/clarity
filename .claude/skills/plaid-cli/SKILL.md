---
name: plaid-cli
description: Operate the Plaid CLI (`plaid` binary, Homebrew) against the Plaid sandbox for this repo's bank-connection work — check readiness, switch environments, create sandbox Items, inspect accounts, run cursor-based transaction syncs, and capture fixtures. Use when the task mentions Plaid, bank connections, sandbox Items, `plaid transactions sync`, Link, or access tokens. Never creates production Items.
---

# Plaid CLI for Clarity

The CLI is built for agents: every command takes `--json` and has `--help`.
Its output is **one JSON document per line** — diagnostics
(`{"diagnostic": …}`) come first, the payload last — so parse the last
line that has no `diagnostic` key. Access tokens appear in `item list` /
`sandbox link` output: never print them, never commit them.

## Guard rails

- `plaid config` shows `Selected Environment`. **Work in `sandbox`.** The
  team's production keys are also stored; do not run `plaid link` or
  `plaid item link` in production, and do not remove production Items.
  Switch with `plaid config set --env sandbox` (secrets are already stored
  after `plaid keys fetch`; if prompted, stop and ask the user).
- The trial plan has 10 Item adds. `plaid sandbox link` consumes none; real
  `plaid link` does.
- The CLI stores Items and tokens in
  `~/Library/Application Support/plaid-cli/config.json`. The app does NOT read
  that file; the app gets its own tokens through its own exchange.

## Readiness

```bash
plaid doctor --json          # status/checks; ".env not present" is fine here
plaid config                 # env, linked items, trial adds left
plaid keys fetch --json      # store the team's API keys in the CLI config
plaid config set --env sandbox
```

## Sandbox Items

```bash
plaid sandbox link --products transactions --json            # ins_56 (Plaid test bank)
plaid sandbox link --products transactions --institution-id ins_109508 --json
plaid item list --json
plaid item get --json                                        # accounts + balances (one item)
plaid item get --item <item_id|alias> --json
plaid item rename <item_id> checking-test
plaid item remove <item_id>                                  # destructive; sandbox only
```

A fresh sandbox Item's transactions take a while to be ready: the first
`sync` pages return `added: []` with a cursor. Retry with a 20 s pause.

## Transactions

```bash
plaid transactions sync --all --json                         # cursor-based, all items
plaid transactions sync --item <id> --page-size 500 --json
plaid transactions list --start-date 2026-01-01 --end-date 2026-01-31 --json
```

The sync payload: `{"items":[{"item":{item_id,institution_id},"added":[…],
"modified":[…],"removed":[…],"cursor":"…"}]}`. Amounts are dollars,
positive = money out (debit). The CLI keeps the cursor per Item; the app
keeps its own in `plaid_items.cursor`.

## Capturing fixtures for tests

Sandbox data is synthetic and safe to commit, but redact `access_token`,
`request_id` and anything named `*token*`/`*secret*`. Fixtures live in
`modules/finance/core/adapters/plaid/__tests__/fixtures/`. The unit tests
never call Plaid: the core takes a `PlaidClient` port and tests inject a
fake that replays these fixtures.

## In the app

The app talks to Plaid through the `plaid` Node SDK in `apps/web` only
(core never imports it — the boundary test forbids it) using
`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` from the environment. Sandbox
Items for the app are created server-side with
`sandboxPublicTokenCreate` → `itemPublicTokenExchange` (no Link UI needed);
production Items come from Link.
