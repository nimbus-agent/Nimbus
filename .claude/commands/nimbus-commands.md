---
name: nimbus-commands
description: >
  Reference for the bun scripts, CLI subcommands, and environment-variable overrides used to develop
  on, test, build, package, and release Nimbus. Use this skill whenever the user asks "how do I run
  X?", "which coverage gate covers Y?", "what's the bun script for Z?", "what env var overrides
  the LLM model?", or before proposing a `bun add` (the dependency-safety section names the
  pre-flight check). Also trigger when wiring CI gates, drafting release commands, or deciding
  whether a subsystem is covered by an existing coverage threshold. Faster and more accurate than
  re-reading `package.json` from scratch — the skill groups scripts by concern and includes
  rationale (what each gate covers, why a script exists).
---

# Nimbus Commands Reference

Resolution order for ambiguous commands: `package.json` `scripts` is authoritative if a script name conflicts with the table below. Run `bun run` (no args) to list the live workspace scripts.

## Develop

```bash
bun install                     # install all workspace deps
bun run typecheck               # tsc --noEmit across all packages
bun run lint                    # Biome — format + lint
bun run lint:fix                # auto-fix
bun run dev-doctor              # contributor env health (Bun version, node_modules, Rust, gcloud, libsecret on Linux)
```

## Test

```bash
bun test                                  # all unit tests (workspace + scripts/)
bun run test:scripts                      # only scripts/**/*.test.ts (regen-slo, structure-audit, package-linux-installers, nimbus-verify)
bun run test:coverage                     # all packages with coverage
bun run test:integration                  # integration suite
bun run test:e2e:cli                      # E2E CLI scenarios

cd packages/ui && bunx vitest run                     # UI components (Vitest, separate runner)
cd packages/ui && bunx vitest run --coverage          # UI with coverage

bun run test:ci                           # full CI parity — same sequence as .github/workflows/_test-suite.yml
```

## Coverage gates (enforced in CI)

Run all via `bun run test:ci`. Individual gates:

```bash
# Engine + agents
bun run test:coverage:engine          # ≥85% (engine)
bun run test:coverage:agents          # ≥80% (built-in agents)

# Vault + security-adjacent
bun run test:coverage:vault           # ≥90% (vault)
bun run test:coverage:extensions      # ≥85% (extension registry + manifest + verify)
bun run test:coverage:sandbox         # ≥80% (platform/sandbox/ — T2 PR 1)

# Sync + rate limiting
bun run test:coverage:sync            # ≥80% (sync scheduler)
bun run test:coverage:rate-limiter    # ≥85% (per-provider rate limiter)

# Index + people graph + embeddings
bun run test:coverage:people          # ≥80% (people graph + cross-service linker)
bun run test:coverage:embedding       # ≥80% (embedding)

# Workflow + watcher
bun run test:coverage:workflow        # ≥80% (workflow runner + store)
bun run test:coverage:watcher         # ≥80% (watcher engine + store + anomaly stub)

# Phase 3.5 — observability + portability
bun run test:coverage:db              # ≥85% (verify, repair, snapshot, health, metrics, latency buffer)
bun run test:coverage:health          # ≥85% (connectors/health.ts)
bun run test:coverage:config          # ≥80% (config loader, profiles, env overrides)
bun run test:coverage:client          # ≥80% (@nimbus-dev/client)
bun run test:coverage:telemetry       # ≥85% (telemetry collector — payload safety gate)
bun run test:coverage:doctor          # ≥80% (nimbus doctor)
bun run test:coverage:tui             # ≥80% (packages/cli/src/tui)
bun run test:coverage:mcp             # ≥70% (mcp-connectors)
bun run test:coverage:sdk             # ≥80% (@nimbus-dev/sdk)

# Phase 4 WS4 — release infrastructure
bun run test:coverage:updater         # ≥80% (updater state machine + manifest fetcher)
bun run test:coverage:lan             # ≥80% (lan-crypto, lan-pairing, lan-rate-limit, lan-rpc, lan-server)
bun run test:coverage:perf            # ≥80% (perf bench harness)

# Phase 5 T4 — CI/CD data layer
bun run test:coverage:metrics         # ≥80% (DORA calculators + IPC)
bun run test:coverage:preflight       # ≥80% (preflight calculator + IPC + HTTP + github-sync mergeable enrichment)
bun run test:coverage:deployment      # ≥80% (post-deploy annotation calculator + HTTP write surface)

# UI Vitest gate
cd packages/ui && bunx vitest run --coverage   # ≥80% lines / ≥75% branches
```

## Build + clean

```bash
bun run build                   # all packages
bun run build:debug             # debug build w/ sourcemaps (also: scripts/{linux,windows}/build-debug.{sh,ps1})
bun run build:release           # production build       (also: scripts/{linux,windows}/build-release.{sh,ps1})
bun run clean                   # remove all build outputs
bun run clean-deep              # workspace-aware deep clean (root + per-package node_modules + bun.lock)
```

## Security audits

```bash
bun audit --audit-level high
bun run audit:high              # same; root script alias
```

## Structure audit (Phase 4 B3)

```bash
bun run audit:structure                 # full pack via orchestrator → run-<ts>.json
bun run audit:boundaries                # dep-cruiser: D1 cross-pkg / D2 cycles / D3 PAL leakage
bun run audit:coverage-floor                 # per-file 80% line-coverage floor (with ratcheting baseline)
bun run audit:coverage-floor:build-lcov      # per-package bun test + lcov merge (reproduces CI input for the floor gate)
bun run audit:coverage-floor:update-baseline # raise must-raise watermarks + drop must-remove entries
bun run audit:dead-code                 # knip unused exports / orphan files (D7)
bun run audit:duplication               # jscpd token duplication (D6)
bun run audit:exclusion-parity               # sonar.coverage.exclusions <-> local registry drift check
bun run audit:any                       # D8 any-count print
bun run audit:invariants                # D10 spawn rule + D11 vault-key allow-list (binary, --binary-only)
bun run audit:openapi-drift             # OpenAPI ↔ READ_ONLY_HTTP_ROUTES drift (Phase 5 T4 PR 1)

bun scripts/structure-audit/count-any-usage.ts --check     # D8 CI gate (fails on regression OR reduction without --update)
bun scripts/structure-audit/count-any-usage.ts --update    # rewrite docs/structure-audit/any-baseline.json

bun scripts/structure-audit/check-doc-references.ts --check  # doc-ref drift (broken markdown links + backtick paths)
```

Baselines: `docs/structure-audit/{any-baseline.json,baseline.md,churn-90d.json,coverage-baseline.json,db-run-census.json}`.
CI gate (reusable workflow): `.github/workflows/_structure.yml`.

## Headless packaging + Linux installers

After compiling gateway + CLI to `dist/`:

```bash
bun run package:headless                            # bundle headless gateway + CLI
bun run package:installers:linux -- --version 0.1.0 # Linux .deb + tarball
```

Optional: set `NIMBUS_EMBEDDING_MODEL_DIR` (or pass `--embedding-model-dir`) to embed pre-downloaded MiniLM weights in the bundle.

## CLI subcommands (reference)

These are runtime CLI commands, not bun scripts.

### Phase 3.5 — query, config, profile, diag, doctor, db, telemetry

```bash
nimbus query --service github --type pr --since 7d --json
nimbus query --sql "SELECT title FROM items WHERE pinned = 1" --pretty
nimbus config get <key> / set <key> <value> / list / validate / edit
nimbus profile create <name> / list / switch <name> / delete <name>
nimbus diag [--json]
nimbus diag slow-queries [--limit N] [--since <duration>]
nimbus doctor
nimbus db verify
nimbus db repair [--yes]
nimbus db snapshot
nimbus db restore <snapshot>
nimbus db snapshots list / backups list
nimbus db prune [--yes]
nimbus telemetry show
nimbus telemetry disable
nimbus serve [--port 7474]
nimbus docs [topic]
nimbus connector history <name>
nimbus connector reindex <name> [--depth <metadata_only|summary|full>]
```

### Phase 4 WS3 — Data Sovereignty

```bash
nimbus data export --output <path.tar.gz> --passphrase <pw> [--no-index]
nimbus data import <path.tar.gz> [--passphrase <pw> | --recovery-seed <mnemonic>]
nimbus data delete --service <name> [--dry-run] [--yes]
nimbus audit verify [--full] [--since <id>]
nimbus audit export --output <path.json>
```

### Phase 4 B2 — Perf bench

```bash
nimbus bench --surface S2-a --runs 5 --corpus small --gha
nimbus bench --all --reference        # interactive protocol confirmation required
```

### Phase 4 WS4 — Release infrastructure

```bash
# Auto-update
nimbus update --check                  # exit 1 if newer available
nimbus update [--yes]                  # download, verify Ed25519, install

# LAN remote access
nimbus lan enable [--allow-pairing]    # start LAN server; open 5-min pairing window
nimbus lan disable
nimbus lan pair <host-ip> <code>       # exchange X25519 keys with a host using pairing code
nimbus lan status
nimbus lan list-peers                  # id, direction, write-allowed
nimbus lan grant-write <peer-id>       # allow peer to call write/HITL methods
nimbus lan revoke-write <peer-id>
nimbus lan remove-peer <peer-id>
```

### Phase 5 T3 — Team Intelligence built-in agents

```bash
nimbus expert <topic-or-file>     # IPC: agents.expert; emits agents.expert.briefReady
nimbus impact <file-or-PR-url>    # IPC: agents.impact; emits agents.impact.briefReady
```

### Phase 5 T4 — CI/CD data layer

```bash
nimbus metrics dora --service <id> [--since 30d] [--json]   # four DORA metrics from the local index
nimbus deploy preflight --service <id> --target-ref <ref> [--mode warn|block|off] [--json]   # pre-deploy index check
nimbus deploy annotate --service <id> --sha <sha> --target-ref <ref> --env <env> --status <success|failure|cancelled|in_progress> --started-at <ms> [--finished-at <ms>] [--provider <github-actions|gitlab|jenkins|circleci|bitbucket|other>] [--workflow-url <url>] [--run-id <id>] [--job-id <id>] [--json]   # POST a deployment event to the local HTTP write surface
```

**Vault keys for the HTTP write surface:**

```
http_api.deployment_token   # Bearer token required for POST /v1/deployments; set via `nimbus vault set http_api.deployment_token <token>` (CLI-only). Without it, the HTTP write surface refuses all POSTs with 503 (write_surface_disabled).
```

### Phase 5 T6 — Forensic + hybrid embedding

```bash
nimbus index reembed --model <id> [--item-type <key>] [--service <name>] [--limit N] [--batch-size N] [--dry-run] [--yes] [--json]
# Selective re-embedding to a target model. v1 models:
#   openai:text-embedding-3-small  (1536-dim; needs vault key openai.api_key)
#   Xenova/all-MiniLM-L6-v2        (384-dim; local, no key required)
# Exit codes: 0 = run completed (any skips; rerun is idempotent), 1 = fatal abort.
# IPC: index.reembed / index.reembedCancel — CLI-only (not in Tauri allowlist; FORBIDDEN_OVER_LAN).
```

## Environment-variable overrides

### Multi-agent loop guards (Phase 4)

```
NIMBUS_MAX_AGENT_DEPTH=3              # sub-agent recursion limit (1–10; default 3)
NIMBUS_MAX_TOOL_CALLS_PER_SESSION=20  # hard cap on tool calls per session (1–200; default 20)
```

Exceeding either fires `agent.gasLimitReached` and halts new decomposition.

### Release infrastructure (Phase 4 WS4)

```
NIMBUS_UPDATER_URL=<url>               # override update manifest URL (default: official endpoint)
NIMBUS_UPDATER_DISABLE=true            # disable auto-update entirely
NIMBUS_LAN_PORT=<port>                 # override LAN TCP listen port (default 7475)
NIMBUS_DEV_UPDATER_PUBLIC_KEY=<base64> # override embedded Ed25519 public key (tests only)
```

### LLM model selection

Resolution priority: env > `[llm]` TOML > hardcoded default.
Bare model ids work; the engine auto-prefixes for Mastra (`claude-*` → `anthropic/...`, `gpt-*` / `o1-*` / `o3-*` / `o4-*` → `openai/...`).

```
NIMBUS_AGENT_MODEL=claude-sonnet-4-6                # overrides [llm].remote_model       (Mastra agent)
NIMBUS_CLASSIFIER_MODEL=claude-haiku-4-5-20251001   # overrides [llm].classifier_model   (Anthropic intent classifier)
NIMBUS_OPENAI_CLASSIFIER_MODEL=gpt-4o-mini          # OpenAI classifier when ANTHROPIC_API_KEY is unset
```

## Docs site

```bash
bun run docs:build                              # from repo root (workspace filter)
cd packages/docs && bunx astro build            # static build
cd packages/docs && bunx astro dev              # local dev server
```

## Release tags (publish triggers)

```bash
# @nimbus-dev/client → npm
git tag client-v0.1.0 && git push origin client-v0.1.0

# Nimbus VS Code extension → Marketplace + Open VSX + GitHub Release
# Requires repo secrets VSCE_PAT (Marketplace) + OVSX_PAT (Open VSX)
git tag vscode-v0.1.0 && git push origin vscode-v0.1.0
```

Extension author CI template: `docs/templates/nimbus-extension-ci.yml`.

## Dependency safety

Before suggesting any `bun add` (or `bun add -d`), run:

```bash
bun run check-package <name>
```

The script fetches metadata from `registry.npmjs.org` and prints author, maintainers, created date, version count.

**Do not propose `bun add`** if any of:

- Script exits with code `1` (package does not exist on npm)
- Script emits the `< 7 days old` warning (typo/slopsquatting risk)
- Author/maintainer is unfamiliar for a name resembling a well-known package (`expresss`, `lodahs`, `react-domm`)

When all three checks pass, include the package's published age and maintainer in your suggestion.
