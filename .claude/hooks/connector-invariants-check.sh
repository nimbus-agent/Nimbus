#!/usr/bin/env bash
# .claude/hooks/connector-invariants-check.sh
#
# PostToolUse hook for Edit / Write — when the touched file is under
# packages/gateway/src/connectors/, run `bun run audit:invariants` and surface
# any failures back to the agent so it can self-correct before continuing.
#
# This is a static-time complement to the runtime tests in
# packages/gateway/src/security-invariants.test.ts. The static check enforces:
#   - Invariant I1: every spawn() under connectors/ uses extensionProcessEnv()
#   - Vault-key allow-list: connector code touches only manifest-declared keys
#
# Fails open (exit 0) on any error parsing the input or running the script,
# so a transient toolchain hiccup never blocks the agent. Surfaces a non-zero
# exit + stderr only when audit:invariants itself reports a violation.

set -u

input=$(cat 2>/dev/null || echo '')
if [[ -z "$input" ]]; then
  exit 0
fi

# Extract the file path that was edited. Fail open on any parse trouble.
path=""
if command -v jq >/dev/null 2>&1; then
  path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null || echo '')
else
  path=$(printf '%s' "$input" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -1)
fi

# Only run for edits under packages/gateway/src/connectors/.
case "$path" in
  *packages/gateway/src/connectors/*) ;;
  *) exit 0 ;;
esac

# Only run for TypeScript sources; markdown / json / test fixtures don't move
# the invariants needle.
case "$path" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# Locate repo root by walking up to a directory that has package.json with the
# nimbus workspace marker. Hooks run with cwd at the repo root in practice, but
# this is the same fail-open posture used in bash-safety.sh.
if ! command -v bun >/dev/null 2>&1; then
  exit 0
fi

if ! [[ -f package.json ]]; then
  exit 0
fi

# Run the audit. The script is intentionally fast and binary (--binary-only).
output=$(bun run audit:invariants 2>&1)
status=$?

if [[ "$status" -eq 0 ]]; then
  exit 0
fi

echo "audit:invariants reported a finding after editing $path" >&2
echo "" >&2
printf '%s\n' "$output" >&2
echo "" >&2
echo "Re-read .claude/commands/nimbus-security-invariants.md and the relevant" >&2
echo "invariant entry in docs/SECURITY-INVARIANTS.md before continuing." >&2
exit 2
