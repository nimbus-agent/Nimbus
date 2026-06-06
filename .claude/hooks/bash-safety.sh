#!/usr/bin/env bash
# .claude/hooks/bash-safety.sh
#
# PreToolUse hook for Bash — blocks well-known unsafe patterns before they run.
# Exits 2 (blocking) only on confirmed match; fails open (exit 0) on any error
# parsing the input so a malformed payload never bricks the agent's Bash access.
#
# Reads the Claude Code tool-call payload as JSON on stdin. The payload shape is:
#   { "tool_name": "Bash", "tool_input": { "command": "...", ... } }
#
# Patterns enforced (from CLAUDE.md non-negotiables and "Git Safety Protocol"):
#  - --no-verify on git commit/push/rebase/pull
#  - force push to main/master
#  - git config writes (read-side --get / --list / --show-* / -l are allowed)
#
# To bypass intentionally for a one-off, the user can disable the hook in
# .claude/settings.local.json. Do not weaken the patterns here without a PR.

set -u

# Read stdin into a variable; if empty/unparseable, fail open.
input=$(cat 2>/dev/null || echo '')
if [[ -z "$input" ]]; then
  exit 0
fi

# Extract the command. Prefer jq when available; fall back to a sed scrape that
# handles the common shape without pulling in extra deps. Either way, fail open
# on extraction error.
cmd=""
if command -v jq >/dev/null 2>&1; then
  cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || echo '')
else
  # Coarse fallback: pull the value of the first "command" key. Misses edge
  # cases but never produces a false positive that blocks a safe command,
  # because we still grep the result for explicit dangerous tokens.
  cmd=$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -1)
fi

if [[ -z "$cmd" ]]; then
  exit 0
fi

# Fatal handler: prints the reason and terminates the hook with the blocking
# exit code (2). It never returns to the caller by design.
block() { # NOSONAR shelldre:S7682 — always terminates via `exit 2`; an explicit return would be unreachable, and a return+exit rewrite would risk the hook's blocking guarantee.
  local message="$1"
  echo "BLOCKED by .claude/hooks/bash-safety.sh: $message" >&2
  echo "If this is intentional, edit .claude/settings.local.json to disable the hook for this session." >&2
  exit 2
}

# 1. --no-verify on git commit/push/rebase/pull
if printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+(commit|push|rebase|pull)\b[^|;&]*--no-verify\b'; then
  block "--no-verify on git commit/push/rebase/pull is forbidden (CLAUDE.md non-negotiables)."
fi

# 2. Force push to main/master (any of: --force, -f, --force-with-lease against main/master)
if printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+push\b[^|;&]*(--force\b|--force-with-lease\b|[[:space:]]-f\b)[^|;&]*\b(main|master)\b'; then
  block "force push to main/master is forbidden."
fi
if printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+push\b[^|;&]*\b(main|master)\b[^|;&]*(--force\b|--force-with-lease\b|[[:space:]]-f\b)'; then
  block "force push to main/master is forbidden."
fi

# 3. git config writes — allow read-side flags only
if printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+config\b' \
  && ! printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+config[[:space:]]+(--get\b|--list\b|-l\b|--show-origin\b|--show-scope\b|--get-all\b|--get-regexp\b)'; then
  block "git config writes are forbidden (read-only flags --get / --list / --show-* are allowed)."
fi

exit 0
