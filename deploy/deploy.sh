#!/usr/bin/env bash
# deploy/deploy.sh — Operator deploy checklist for Clarity (epic-004)
#
# OPERATOR STEP — run this script from an authenticated Vercel session.
# This script NEVER executes "vercel" automatically; it performs pre-flight
# checks and then prints the exact command you must run manually.
#
# Prerequisites (ADR-006 — no secret enters the worktree):
#   1. Vercel CLI installed:  npm install -g vercel
#   2. Authenticated:          vercel login
#   3. All env vars configured in the Vercel project dashboard — see deploy/ENV.md
#   4. Demo data seeded:       pnpm seed:demo (from an authenticated DB session)
#
# Usage:
#   ./deploy/deploy.sh [--preview]
#
# Flags:
#   --preview   Print the preview deploy command instead of the production one.
#               Default: production deploy.

set -euo pipefail

PREVIEW=0
for arg in "$@"; do
  case "$arg" in
    --preview) PREVIEW=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

echo "=== Clarity deploy pre-flight ==="
echo ""

# ── Pre-flight 1: Vercel CLI present ──────────────────────────────────────────
if ! command -v vercel &>/dev/null; then
  echo "ERROR: Vercel CLI not found." >&2
  echo "  Install with:  npm install -g vercel" >&2
  exit 1
fi
echo "[OK] Vercel CLI found: $(vercel --version 2>/dev/null || echo 'version unknown')"

# ── Pre-flight 2: Authenticated ───────────────────────────────────────────────
if ! vercel whoami &>/dev/null; then
  echo "ERROR: Not authenticated. Run: vercel login" >&2
  exit 1
fi
echo "[OK] Authenticated as: $(vercel whoami 2>/dev/null)"

# ── Pre-flight 3: No .env files with values ───────────────────────────────────
for f in "$REPO_ROOT"/.env "$REPO_ROOT"/.env.local "$REPO_ROOT"/.env.production; do
  if [[ -f "$f" ]]; then
    echo "WARNING: $f exists in the worktree — verify it is gitignored and" >&2
    echo "         contains no secrets before deploying." >&2
  fi
done
echo "[OK] .env check complete"

# ── Pre-flight 4: No uncommitted changes ──────────────────────────────────────
if ! git -C "$REPO_ROOT" diff --quiet HEAD; then
  echo "WARNING: Uncommitted changes detected. Deploy from a clean tree." >&2
fi
echo "[OK] Git status checked"

echo ""
echo "=== Pre-flight complete ==="
echo ""

# ── Print the command — DO NOT execute automatically (ADR-006) ────────────────
if [[ "$PREVIEW" -eq 1 ]]; then
  echo "Run the following command to create a PREVIEW deployment:"
  echo ""
  echo "  cd \"$REPO_ROOT\" && vercel"
else
  echo "Run the following command to deploy to PRODUCTION:"
  echo ""
  echo "  cd \"$REPO_ROOT\" && vercel --prod"
fi

echo ""
echo "After deploying, run the smoke test:"
echo "  DEPLOY_URL=<your-url> ./deploy/smoke.sh"
echo ""
