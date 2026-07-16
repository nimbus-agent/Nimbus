# Using `nimbus query` in CI

> **Self-hosted runners only.** The Gateway HTTP API binds to `127.0.0.1`, so a hosted GitHub-runner / GitLab-shared-runner cannot reach it. Run a self-hosted runner with Nimbus installed and the Gateway started (`nimbus serve` or via systemd / launchd), then use the patterns below.

This page shows three ways to gate a CI step on already-indexed Nimbus data — without writing any TypeScript or running an MCP connector. Each example uses `nimbus query --json` and pipes through `jq` for the boolean check.

## Example 1 — GitHub Actions: block deploy on active P1 incident

```yaml
# .github/workflows/deploy.yml — runs on a self-hosted runner
jobs:
  deploy:
    runs-on: [self-hosted, linux, nimbus]   # tag your runner accordingly
    steps:
      - name: Block on active P1 incident
        env:
          SERVICE: payment-service
        run: |
          set -euo pipefail
          count=$(nimbus query --service pagerduty --type incident \
                              --since 24h --json \
                  | jq --arg svc "$SERVICE" \
                      '[ .[] | select(.metadata.severity == "p1" and .metadata.service == $svc) ] | length')
          if [ "$count" -gt 0 ]; then
            echo "::error::Active P1 incident on $SERVICE — blocking deploy."
            exit 1
          fi
          echo "No active P1 — proceeding."

      - name: Deploy
        run: ./deploy.sh
```

## Example 2 — GitLab CI: warn on failing CI runs for the target branch

```yaml
# .gitlab-ci.yml — runner tagged `nimbus`
deploy:
  tags: [nimbus]
  script:
    - |
      failures=$(nimbus query --service github_actions --type ci_run \
                              --since 4h --json \
                  | jq --arg branch "$CI_COMMIT_REF_NAME" \
                      '[ .[] | select(.metadata.headBranch == $branch and .metadata.conclusion == "failure") ] | length')
      if [ "$failures" -gt 0 ]; then
        echo "WARNING: $failures recent CI failures on $CI_COMMIT_REF_NAME"
      fi
    - ./deploy.sh
```

## Example 3 — Jenkins (Pipeline / `Jenkinsfile`)

```groovy
pipeline {
  agent { label 'nimbus' }
  stages {
    stage('Block on conflicted PRs') {
      steps {
        sh '''
          conflicted=$(nimbus query --service github --type pr \
                                    --json \
                       | jq '[ .[] | select(.metadata.mergeable == false) ] | length')
          if [ "$conflicted" -gt 0 ]; then
            echo "ERROR: $conflicted PRs in merge-conflict state — resolve before deploy."
            exit 1
          fi
        '''
      }
    }
    stage('Deploy') {
      steps { sh './deploy.sh' }
    }
  }
}
```

## Notes

- `nimbus query --json` emits an array of indexed-item rows; `jq` filters cleanly without extra dependencies.
- The `metadata.*` field names follow the connector's chosen shape — check [`docs/schema-reference.md`](../schema-reference.md) or the connector source for the exact set.
- For typed access from a Node/Bun CI script, prefer `@nimbus-dev/client` (published to npm) over raw `nimbus query`.
- The runner needs the `nimbus` binary on `PATH`. On a fresh runner, install once via `bun run package:headless` output and `cp` the binary into `/usr/local/bin/`.

## Worked Examples

The patterns above are minimal demos. The examples below are full-fidelity, copy-paste-ready CI snippets that cover the most common real-world uses: gating deploys, surfacing incident context on a PR, and generating release notes from indexed PRs.

> **Flag reminder.** `nimbus query` accepts `--service`, `--type`, `--since` (e.g. `1h`, `24h`, `7d`, `2w`), `--limit` (default 50, capped at 1000), `--json`, `--pretty`, and the read-only-guarded `--sql`. No other flags exist — filter further with `jq`. See [`packages/cli/src/commands/query.ts`](../../packages/cli/src/commands/query.ts) for the canonical surface.

### Worked Example A — GitHub Actions: gate a deploy on an active P1 incident

Triggers on `push` to `main`; queries the local Nimbus index for the last hour of PagerDuty incidents; blocks the deploy if any P1 on the bound service is still open (status not `resolved`). The Gateway runs on the self-hosted runner under systemd, so no LAN pairing and no HTTP token are needed.

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  preflight-incident-gate:
    runs-on: [self-hosted, linux, nimbus]
    outputs:
      verdict: ${{ steps.gate.outputs.verdict }}
    steps:
      - id: gate
        name: Block on active PagerDuty P1 incident
        env:
          PD_SERVICE_ID: PSVC123   # PagerDuty service id (the one you bind in nimbus.toml)
        run: |
          set -euo pipefail
          # Window matches the on-call rotation horizon; widen for slower-paced services.
          active=$(nimbus query \
            --service pagerduty \
            --type incident \
            --since 1h \
            --limit 200 \
            --json \
            | jq --arg pd "$PD_SERVICE_ID" '
                [ .[]
                  | select(.metadata.pagerduty_service_id == $pd)
                  | select(.metadata.status != "resolved")
                  | select((.metadata.severity // "" | ascii_downcase) == "p1")
                ] | length')

          if [ "$active" -gt 0 ]; then
            echo "::error::Active P1 on $PD_SERVICE_ID ($active open) — deploy blocked."
            echo "verdict=block" >> "$GITHUB_OUTPUT"
            exit 1
          fi
          echo "verdict=ok" >> "$GITHUB_OUTPUT"

  deploy:
    needs: preflight-incident-gate
    if: needs.preflight-incident-gate.outputs.verdict == 'ok'
    runs-on: [self-hosted, linux, nimbus]
    steps:
      - uses: actions/checkout@v4
      - name: Deploy
        run: ./scripts/deploy.sh
```

Why this is safe to ship:

- `set -euo pipefail` fails closed on `jq` parse errors or a crashed `nimbus` binary — no silent "no incidents found" from a segfault.
- The PagerDuty service id is compared with `==`, never substring-matched, so a comma in `pagerduty_service_id` cannot pivot the filter.
- Severity is lowercased before comparison; works whether or not `[pagerduty].severity_p1_aliases` is configured.
- Exit code 1 surfaces in the GitHub Actions UI as a failed job, and `needs:` blocks the dependent `deploy` job.

### Worked Example B — GitLab CI: deploy preflight + stale-PR warning

GitLab variant of the same gate, plus a non-blocking sibling job that warns when more than five PRs targeting the protected branch have been open for more than 14 days. Both jobs run on a runner tagged `nimbus` with the Gateway already up.

```yaml
# .gitlab-ci.yml
stages: [preflight, deploy]

variables:
  PD_SERVICE_ID: PSVC123
  PROTECTED_BRANCH: main

incident-gate:
  stage: preflight
  tags: [nimbus]
  script:
    - |
      set -euo pipefail
      active=$(nimbus query \
        --service pagerduty \
        --type incident \
        --since 1h \
        --limit 200 \
        --json \
        | jq --arg pd "$PD_SERVICE_ID" '
            [ .[]
              | select(.metadata.pagerduty_service_id == $pd)
              | select(.metadata.status != "resolved")
              | select((.metadata.severity // "" | ascii_downcase) == "p1")
            ] | length')
      if [ "$active" -gt 0 ]; then
        echo "Active P1 on $PD_SERVICE_ID — deploy blocked."
        exit 1
      fi

stale-pr-warning:
  stage: preflight
  tags: [nimbus]
  allow_failure: true        # warning only — never blocks the pipeline
  script:
    - |
      set -euo pipefail
      cutoff=$(( $(date +%s%3N) - 14*86400000 ))   # unix-ms, 14 days ago
      stale=$(nimbus query \
        --service github \
        --type pr \
        --since 30d \
        --limit 500 \
        --json \
        | jq --argjson cutoff "$cutoff" '
            [ .[]
              | select(.metadata.state == "open")
              | select(.metadata.draft == false)
              | select(.modified_at < $cutoff)
            ] | length')
      if [ "$stale" -gt 5 ]; then
        echo "WARNING: $stale PRs are >14d stale — review the backlog before shipping."
      fi

deploy:
  stage: deploy
  tags: [nimbus]
  needs: [incident-gate]
  script:
    - ./scripts/deploy.sh
```

The arithmetic `$(date +%s%3N) - 14*86400000` yields a unix-ms cutoff so `select(.modified_at < $cutoff)` matches the millisecond-precision timestamps that `nimbus query` returns on indexed rows.

### Worked Example C — Jenkins: declarative + scripted pipeline variants

Both styles produce the same outcome: fail the build if any PagerDuty P1 is open on the bound service. Pick the variant that matches your shop's house style.

#### Declarative (`Jenkinsfile`)

```groovy
pipeline {
  agent { label 'nimbus' }   // self-hosted agent with Gateway running

  options { timestamps() }

  environment {
    PD_SERVICE_ID = 'PSVC123'
  }

  stages {
    stage('Preflight: PagerDuty P1 gate') {
      steps {
        sh '''
          set -euo pipefail
          active=$(nimbus query \
            --service pagerduty \
            --type incident \
            --since 1h \
            --limit 200 \
            --json \
            | jq --arg pd "$PD_SERVICE_ID" '
                [ .[]
                  | select(.metadata.pagerduty_service_id == $pd)
                  | select(.metadata.status != "resolved")
                  | select((.metadata.severity // "" | ascii_downcase) == "p1")
                ] | length')
          if [ "$active" -gt 0 ]; then
            echo "BLOCKED: $active active P1 on $PD_SERVICE_ID"
            exit 1
          fi
        '''
      }
    }
    stage('Deploy') {
      steps {
        sh './scripts/deploy.sh'
      }
    }
  }
}
```

#### Scripted (`Jenkinsfile`)

```groovy
node('nimbus') {
  def pdServiceId = 'PSVC123'

  stage('Preflight: PagerDuty P1 gate') {
    def active = sh(
      returnStdout: true,
      script: """
        set -euo pipefail
        nimbus query \\
          --service pagerduty \\
          --type incident \\
          --since 1h \\
          --limit 200 \\
          --json \\
        | jq --arg pd "${pdServiceId}" '
            [ .[]
              | select(.metadata.pagerduty_service_id == \$pd)
              | select(.metadata.status != "resolved")
              | select((.metadata.severity // "" | ascii_downcase) == "p1")
            ] | length'
      """
    ).trim().toInteger()

    if (active > 0) {
      error("BLOCKED: ${active} active P1 on ${pdServiceId}")
    }
  }

  stage('Deploy') {
    sh './scripts/deploy.sh'
  }
}
```

In the scripted variant the `$pd` inside the jq program is escaped as `\$pd` so Groovy's `"""` interpolation leaves it alone and the shell expands it at runtime. An unescaped `$pd` would resolve to an empty Groovy variable before `jq` ever sees it.

### Worked Example D — PR comments: surface incident context when a commit lands during an active incident

Triggers on `pull_request` events (opened / synchronize / reopened). If a PagerDuty P1 is open on the bound service, the workflow posts (or updates) a single sticky comment naming the open incidents and their URLs. If no incident is active, any prior comment is left in place — the workflow does not edit its own history.

```yaml
# .github/workflows/pr-incident-context.yml
name: PR incident context

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  pull-requests: write     # required for `gh pr comment` / `gh api PATCH`

jobs:
  comment-if-incident:
    runs-on: [self-hosted, linux, nimbus]
    env:
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      PD_SERVICE_ID: PSVC123
      PR_NUMBER: ${{ github.event.pull_request.number }}
    steps:
      - uses: actions/checkout@v4
      - name: Build incident context (if any) and comment
        run: |
          set -euo pipefail

          incidents_json=$(nimbus query \
            --service pagerduty \
            --type incident \
            --since 6h \
            --limit 200 \
            --json \
            | jq --arg pd "$PD_SERVICE_ID" '
                [ .[]
                  | select(.metadata.pagerduty_service_id == $pd)
                  | select(.metadata.status != "resolved")
                  | select((.metadata.severity // "" | ascii_downcase) == "p1")
                  | { title, url, status: .metadata.status, opened_at_ms: .metadata.opened_at_ms }
                ]')
          count=$(echo "$incidents_json" | jq 'length')

          if [ "$count" -eq 0 ]; then
            echo "No active P1 — skipping comment."
            exit 0
          fi

          body=$(echo "$incidents_json" | jq -r '
              "> :warning: **\(length) active P1 incident\(if length > 1 then "s" else "" end) on this service.**\n\n"
            + (map("- [\(.title)](\(.url // "#")) — `\(.status)`") | join("\n"))
            + "\n\nMerging will land on top of an active incident — coordinate with the on-call before clicking *Merge*."
          ')

          # One sticky comment per PR — find any prior bot comment carrying the marker and update it.
          marker="<!-- nimbus:pr-incident-context -->"
          existing_id=$(gh api "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" \
            --jq ".[] | select(.body | startswith(\"$marker\")) | .id" | head -n1 || true)

          full_body=$(printf '%s\n%s\n' "$marker" "$body")
          if [ -n "$existing_id" ]; then
            gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${existing_id}" \
              -f body="$full_body" >/dev/null
            echo "Updated existing comment $existing_id"
          else
            gh pr comment "$PR_NUMBER" --body "$full_body"
            echo "Posted new sticky comment"
          fi
```

Behaviour:

- **No incident → no comment.** The workflow exits cleanly without editing the PR.
- **One incident → one comment.** The sticky marker (`<!-- nimbus:pr-incident-context -->`) lets re-runs update in place instead of stacking duplicates.
- **Index freshness.** If the PagerDuty connector last synced more than its `defaultIntervalMs` ago, the data here is stale by that amount. Widen `--since 6h` only if your on-call rotations exceed that — over-widening dilutes the signal.

### Worked Example E — Release notes from indexed PRs (last 7 days, merged only)

`nimbus query` does not have a `--merged` flag — filter on `.metadata.merged == true` in `jq` instead (the field is set by `extractPrMetadataForIndex` in [`packages/gateway/src/connectors/github-sync.ts`](../../packages/gateway/src/connectors/github-sync.ts)). The script below writes a date-sorted `RELEASE_NOTES.md` grouped by repository.

```bash
#!/usr/bin/env bash
# scripts/generate-release-notes.sh — run on any host that can reach the local Gateway.
set -euo pipefail

OUTPUT="${1:-RELEASE_NOTES.md}"
SINCE="${SINCE:-7d}"          # any duration nimbus query accepts: 7d / 24h / 30m / 2w

{
  printf '# Release notes — %s\n\n' "$(date -u +%Y-%m-%d)"
  printf 'Merged PRs in the last %s:\n\n' "$SINCE"

  nimbus query \
    --service github \
    --type pr \
    --since "$SINCE" \
    --limit 500 \
    --json \
  | jq -r '
      [ .[] | select(.metadata.merged == true) ]
      | sort_by(-(.metadata.merged_at // .modified_at // 0))
      | group_by(.metadata.repo // "unknown")[]
      | "## " + (.[0].metadata.repo // "unknown") + "\n\n"
        + (map(
            "- " + (.title // "(untitled)")
            + " ([#" + ((.metadata.number // 0)|tostring) + "](" + (.url // "#") + "))"
            + " — @" + (.metadata.user // "unknown")
          ) | join("\n"))
        + "\n"
  '
} > "$OUTPUT"

echo "Wrote $OUTPUT"
```

Use it from a release workflow (any CI system). Example GitHub Actions step:

```yaml
- name: Generate release notes
  env:
    SINCE: 14d                # override the default 7d window
  run: |
    ./scripts/generate-release-notes.sh RELEASE_NOTES.md
    cat RELEASE_NOTES.md

- name: Attach to GitHub Release
  uses: softprops/action-gh-release@v2
  with:
    body_path: RELEASE_NOTES.md
```

Notes:

- `--limit 500` caps the JSON payload; the underlying IPC enforces a hard cap of 1000. Bump `--since` rather than `--limit` if your repo merges more than 500 PRs per window.
- `group_by(.metadata.repo)` keeps multi-repo workspaces readable — drop the grouping for a single-repo flow.
- `metadata.merged_at` is unix-ms when present; the `// .modified_at // 0` fallback orders rows that lack a `merged_at` for any reason.
- No `GH_TOKEN` is needed inside the script — only the Gateway talks to GitHub, and the PAT lives in the local Vault.
