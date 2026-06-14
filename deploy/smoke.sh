#!/usr/bin/env bash
# deploy/smoke.sh — Post-deploy smoke test for Clarity (epic-004)
#
# Verifies two contracts without a token:
#   1. GET /api/queue  → HTTP 200 and demo-household data present (PUBLIC_DEMO_MODE=1 must be set on server)
#   2. POST /api/queue/<id>/confirm  → HTTP 401 (mutation gate enforced, ADR-006)
#
# Usage:
#   DEPLOY_URL=https://your-app.vercel.app ./deploy/smoke.sh
#
# Or pass the URL as the first argument:
#   ./deploy/smoke.sh https://your-app.vercel.app
#
# The script exits non-zero on any assertion failure.

set -euo pipefail

DEPLOY_URL="${1:-${DEPLOY_URL:-}}"

if [[ -z "$DEPLOY_URL" ]]; then
  echo "ERROR: DEPLOY_URL is required." >&2
  echo "  Usage: DEPLOY_URL=https://your-app.vercel.app $0" >&2
  exit 1
fi

# Strip trailing slash
DEPLOY_URL="${DEPLOY_URL%/}"

PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "[PASS] $label (got $actual)"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] $label — expected $expected, got $actual" >&2
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "[PASS] $label"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] $label — expected to find '$needle' in response" >&2
    echo "       Response body: ${haystack:0:200}" >&2
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Clarity smoke test against: $DEPLOY_URL ==="
echo ""

# ── Check 1: GET /api/queue → 200 + demo-household data present ───────────────
echo "--- Check 1: GET /api/queue (read path) ---"
QUEUE_RESPONSE=$(curl -sS --max-time 15 -w "\n%{http_code}" "$DEPLOY_URL/api/queue")
QUEUE_STATUS=$(echo "$QUEUE_RESPONSE" | tail -1)
QUEUE_BODY=$(echo "$QUEUE_RESPONSE" | head -n -1)

assert_eq "GET /api/queue HTTP status" "200" "$QUEUE_STATUS"
assert_contains "GET /api/queue response is JSON array" "[" "$QUEUE_BODY"
assert_contains "demo-household data present (non-empty queue)" "\"id\"" "$QUEUE_BODY"

echo ""

# ── Check 2: POST mutation route without token → 401 ─────────────────────────
echo "--- Check 2: POST /api/queue/<id>/confirm without token (mutation gate) ---"
CONFIRM_STATUS=$(curl -sS --max-time 15 -o /dev/null -w "%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"note":"smoke-test"}' \
  "$DEPLOY_URL/api/queue/smoke-probe/confirm")

assert_eq "POST /api/queue/<id>/confirm without token → 401" "401" "$CONFIRM_STATUS"

echo ""

# ── Summary ────────────────────────────────────────────────────────────────────
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  echo ""
  echo "Smoke test FAILED. Check the deploy configuration and ensure:" >&2
  echo "  - PUBLIC_DEMO_MODE=1 is set in the Vercel project dashboard" >&2
  echo "  - Demo data is seeded: pnpm seed:demo" >&2
  echo "  - RECONCILE_MUTATION_TOKEN is set (mutation gate active)" >&2
  exit 1
fi

echo "Smoke test PASSED."
