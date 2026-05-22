# Nimbus pre-commit hook

A drop-in `git` pre-commit hook that queries the local Nimbus index for active P1 incidents and recent failing CI runs on the current branch, then either warns or blocks the commit depending on environment-variable toggles.

The hook is **fail-open**: if `nimbus` is not on `PATH` or the Gateway is unreachable, it logs a one-line note to stderr and exits `0` so commits are never blocked by missing tooling.

Source: [`docs/templates/nimbus-pre-commit.sh`](../templates/nimbus-pre-commit.sh).

## Install

From the repo root:

```bash
cp docs/templates/nimbus-pre-commit.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

On Windows, use Git Bash to run `chmod`; PowerShell `Set-ItemProperty` is not needed because `git` ignores POSIX file modes there.

Verify by running it directly once:

```bash
.git/hooks/pre-commit && echo "ok"
```

A clean run prints nothing and exits `0`. A warn-only run prints `[nimbus pre-commit] warn: …` to stderr and still exits `0`.

## What it checks

| # | Check | Source query | Window |
|---|---|---|---|
| 1 | Active P1 incidents | `nimbus query --service pagerduty --type incident --since 24h --json` filtered by `metadata.severity == "p1"` | 24 h |
| 2 | Failing CI runs on the current branch | `nimbus query --service github_actions --type ci_run --since 4h --json` filtered by `metadata.headBranch == <branch>` and `metadata.conclusion == "failure"` | 4 h |

Both checks rely on data already in the local index — they never contact PagerDuty or GitHub directly. Run `nimbus query --service pagerduty --type incident --since 24h` (or the equivalent for `github_actions`) interactively to confirm your index is populated before installing the hook.

## Block vs warn

Each check is independently controlled by an environment variable. Without either set, both checks are **warn-only** (commit proceeds, message printed to stderr). Set the variable to `1` to flip the corresponding check to **block** mode (exit `1`).

| Variable | Effect when `1` |
|---|---|
| `NIMBUS_HOOK_BLOCK_ON_INCIDENT` | Commit fails if any active P1 incident found |
| `NIMBUS_HOOK_BLOCK_ON_FAILING_CI` | Commit fails if any failing CI run on the current branch is found |

For permanent toggles, set them in your shell rc file:

```bash
# ~/.bashrc or ~/.zshrc
export NIMBUS_HOOK_BLOCK_ON_INCIDENT=1
```

For a one-off bypass (after intentionally committing a fix during an incident), unset the variable for the single commit:

```bash
NIMBUS_HOOK_BLOCK_ON_INCIDENT=0 git commit -m "hotfix: …"
```

Or use the universal `git commit --no-verify` to skip the hook entirely.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All checks passed, or all triggered checks are in warn mode |
| `1` | At least one block-mode check found a finding |

The hook never emits exit code `2`; tool-availability problems exit `0` with a stderr note (fail-open).

## Extending the hook

The hook is a small bash file (~60 lines). Adapt it by adding new `nimbus query` blocks and threading them through `block_or_warn`. The pattern for a new check:

```bash
new_count=$(nimbus query --service <name> --type <type> --since <window> --json 2>/dev/null \
             | jq '[ .[] | select(.<filter>) ] | length' 2>/dev/null \
             || echo 0)
block_or_warn "<label>" NIMBUS_HOOK_BLOCK_ON_<NAME> "$new_count" || status=1
```

Keep the `2>/dev/null` redirects and the `|| echo 0` fallback so a missing connector or empty index continues the fail-open contract.

## Related

- [`docs/cli/use-in-ci.md`](./use-in-ci.md) — equivalent patterns for CI pipelines (GitHub Actions, GitLab CI, Jenkins) using the same `nimbus query --json | jq` shape.
- [`docs/templates/nimbus-pre-commit.sh`](../templates/nimbus-pre-commit.sh) — the hook itself; install with the `cp` + `chmod` recipe above.
