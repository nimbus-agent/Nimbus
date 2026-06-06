#!/usr/bin/env bash
# Nimbus pre-commit hook template.
#
# Install:
#   cp docs/templates/nimbus-pre-commit.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# Configurable via environment:
#   NIMBUS_HOOK_BLOCK_ON_INCIDENT=1   block when an active P1 incident is found
#                                     (default: warn-only)
#   NIMBUS_HOOK_BLOCK_ON_FAILING_CI=1 block when a failing CI run on the current
#                                     branch is found (default: warn-only)
#
# Both preflight checks below are fail-open: if `nimbus` is not on PATH or the
# Gateway is unreachable, the hook prints a one-line note to stderr and exits 0
# so commits are never blocked by missing tooling.

set -uo pipefail

# Preflight 1: nimbus binary on PATH?
if ! command -v nimbus >/dev/null 2>&1; then
  echo "[nimbus pre-commit] nimbus not on PATH; skipping checks." >&2
  exit 0
fi

# Preflight 2: Gateway reachable?
if ! nimbus diag --json >/dev/null 2>&1; then
  echo "[nimbus pre-commit] Gateway not reachable; skipping checks." >&2
  exit 0
fi

# Resolve the current branch — used by the failing-CI check.
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")

block_or_warn() {
  local label="$1" envvar="$2" count="$3"
  if [[ "$count" -le 0 ]]; then
    return 0
  fi
  if [[ "${!envvar:-0}" = "1" ]]; then
    echo "[nimbus pre-commit] BLOCK: $label ($count)." >&2
    return 1
  fi
  echo "[nimbus pre-commit] warn: $label ($count). Set $envvar=1 to block." >&2
  return 0
}

# Check 1: active P1 incidents.
incident_count=$(nimbus query --service pagerduty --type incident --since 24h --json 2>/dev/null \
                  | jq '[ .[] | select(.metadata.severity == "p1") ] | length' 2>/dev/null \
                  || echo 0)

# Check 2: failing CI runs on the current branch.
ci_failures=$(nimbus query --service github_actions --type ci_run --since 4h --json 2>/dev/null \
               | jq --arg branch "$branch" \
                  '[ .[] | select(.metadata.headBranch == $branch and .metadata.conclusion == "failure") ] | length' 2>/dev/null \
               || echo 0)

status=0
block_or_warn "active P1 incidents in last 24h" NIMBUS_HOOK_BLOCK_ON_INCIDENT  "$incident_count" || status=1
block_or_warn "failing CI runs on $branch in last 4h" NIMBUS_HOOK_BLOCK_ON_FAILING_CI "$ci_failures"     || status=1

exit "$status"
