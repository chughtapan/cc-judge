#!/usr/bin/env bash
#
# CI gate: when src/**/*.ts changes in a PR, .stryker-tmp/incremental.json
# MUST be refreshed in the same PR. The contributor runs `pnpm mutation`
# locally before pushing — Stryker enforces the break threshold there. CI
# only verifies the baseline is fresh so future runs stay fast and
# accurate.
#
# Why not run mutation in CI? It's a 25+ minute job for our suite even on
# a 4-core runner, and the incremental cache lives on the developer's
# machine. Running it again in CI either (a) re-mutates everything (slow,
# expensive) or (b) reuses a stale cache (wrong score). The local-run +
# committed-baseline pattern avoids both.
#
# Exit codes:
#   0 — clean: either no src changed, or src changed AND baseline refreshed.
#   1 — src changed but baseline not refreshed. Contributor must run
#       `pnpm mutation` locally and commit .stryker-tmp/incremental.json.
#   2 — baseline file is missing or not valid JSON.

set -euo pipefail

BASE_REF="${BASE_REF:-origin/main}"
INCR_FILE=".stryker-tmp/incremental.json"

# Sanity: baseline file exists and parses.
if [ ! -f "$INCR_FILE" ]; then
  echo "ERROR: $INCR_FILE is missing. Run \`pnpm mutation\` locally to create it." >&2
  exit 2
fi
if ! node -e "JSON.parse(require('fs').readFileSync('$INCR_FILE','utf8'))" 2>/dev/null; then
  echo "ERROR: $INCR_FILE is not valid JSON." >&2
  exit 2
fi

# Detect changed source files (excludes tests because Stryker mutates
# only src/**/*.ts; test changes don't invalidate the baseline).
# Each `grep` is wrapped with `|| true` because pipefail makes a no-match
# return abort the whole script.
CHANGED=$(git diff --name-only "$BASE_REF"...HEAD || true)
SRC_CHANGED=$(printf '%s\n' "$CHANGED" \
  | { grep -E '^src/.*\.ts$' || true; } \
  | { grep -vE '\.test\.ts$|\.spec\.ts$' || true; } \
  | grep -c . || true)
INCR_CHANGED=$(printf '%s\n' "$CHANGED" \
  | grep -cE '^\.stryker-tmp/incremental\.json$' || true)

echo "src files changed: $SRC_CHANGED"
echo "$INCR_FILE refreshed: $INCR_CHANGED"

if [ "$SRC_CHANGED" -gt 0 ] && [ "$INCR_CHANGED" -eq 0 ]; then
  cat >&2 <<EOF

ERROR: $SRC_CHANGED source file(s) changed in this PR but $INCR_FILE
was not refreshed. The mutation baseline is now stale.

Run locally:
  pnpm mutation

then commit the updated $INCR_FILE and push. Stryker enforces the break
threshold (currently $(node -p "require('./stryker.config.js').default.thresholds.break") %)
on that local run, so the score gate is preserved end-to-end.

EOF
  exit 1
fi

echo "OK — mutation baseline is consistent with the diff."
