---
name: nimbus-commands
description: >
  The bun scripts, CLI subcommands, and env-var overrides for developing, testing, building,
  packaging, and releasing Nimbus. Use when asking how to run a script, which coverage gate
  covers a subsystem, what env var overrides the LLM model, before a `bun add` (the
  dependency-safety pre-flight), or when wiring CI gates / drafting release commands. Faster
  than re-reading `package.json` — grouped by concern with rationale per gate.
---

# Nimbus Commands Reference

Resolution order for ambiguous commands: `package.json` `scripts` is authoritative if a script name conflicts with the table below. Run `bun run` (no args) to list the live workspace scripts.

## Develop

```bash
bun install                     # install all workspace deps
bun run typecheck               # tsc --noEmit across all packages
bun run typecheck:tests         # packages/{gateway,ui}/test/** — NOT in any tsconfig include, so `typecheck` is blind to them (#1038); ratchets against docs/structure-audit/typecheck-tests-baseline.json
bun run typecheck:tests:update-baseline   # rewrite that baseline — needed both when adding debt AND when paying it down (the ratchet fails on an unbanked improvement)
bun run lint                    # Biome — format + lint
bun run lint:fix                # auto-fix
bun run dev-doctor              # contributor env health (Bun version, node_modules, Rust, gcloud, libsecret on Linux)
```

## Verify against CI, not just locally

```bash
bun run verify:docker           # manifest fast-tier gates inside oven/bun:1.3 at /src — kills the "green locally because of a path exclusion / OS difference" class
bun run verify:docker --full    # + build, test:ci, coverage floor   (--rebuild refreshes the cached image)
bun run verify:docker --changed # ONLY the tests your branch touched, in the CI Linux image — the fast way to reproduce a Linux-only test failure (NOT a substitute for --full)
bun run verify:pr               # reads the PR's real check state via gh; a conflicted or still-pending PR is never reported green
bun run audit:platform-test-gaps # advisory (in preflight:fast): names tests in your diff that CANNOT run on your OS — skipIf(platform) is invisible locally
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

bun run test:ci                           # the TEST SUITE only — same sequence as .github/workflows/_test-suite.yml

bun run test:sandbox                      # per-connector sandbox contract suite — OPT-IN, real network
```

**`test:sandbox` is the only way those 79 tests run.** Each connector's
`test/sandbox.test.ts` is gated on `describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])`,
and nothing in the repo set that variable until this script existed — so a plain `bun test`
reports them as skipped and always did. They are **not** part of any CI gate and should not
be: `runSandboxContractTests` forks a probe that opens a **real** connection to the
connector's first declared `permissions.network` host (plus, off Windows, one to an unlisted
host that must be refused). A host that does not resolve on your network fails as an exit
code, which is an environment result and not a manifest defect — check the host resolves
before filing anything.

## Pre-flight (what to actually run before pushing)

**`test:ci` is not the full gate set — `preflight` is.** `test:ci` is `bun scripts/run-tests.ts`: the test suite and nothing else. `preflight` is `bun scripts/preflight.ts`, which drives the gate manifest in `scripts/lib/preflight-gates.ts` (28 gates today: 24 `tier: "fast"` + 4 `tier: "full"`, plus `CI_ONLY_GATES` that preflight intentionally skips). Running only `test:ci` is the historical #1 cause of PRs that fail on gates the author never ran locally.

```bash
bun run preflight                         # full CI parity — every gate in PREFLIGHT_GATES
bun run preflight:fast                    # the 24 fast static gates (~2-3 min); catches most PR failures
```

Derive gate commands from `PREFLIGHT_GATES` rather than retyping them — several gates are no-ops without their exact flags (`audit:any` without `--check` always exits 0). Depth: the `nimbus-preflight` skill.

## Coverage gates (enforced in CI)

**What actually enforces these floors is `bun run audit:coverage-scopes`** — it reads the merged
`coverage/lcov.info` and asserts each scope's aggregate line coverage over its *non-exempt* files
(same exemption registry as `audit:coverage-floor`). It runs on Linux in `_test-suite.yml`
immediately after the floor gate, and costs no extra test run.

The `test:coverage:*` scripts below run each scope's tests and **do not enforce a threshold**,
despite their `--coverage-threshold-lines=N` argument. Two independent reasons, both verified on
Bun 1.3.14:

1. `--coverage-threshold-lines` is not a Bun flag (`bun test --help` lists only `--coverage`,
   `--coverage-reporter`, `--coverage-dir`) and Bun ignores unknown flags silently.
2. `bunfig.toml` sets `[test] coverage = false`, which suppresses collection outright — even an
   explicit `--coverage --coverage-reporter=lcov --coverage-dir=X` writes no lcov under it.

The percentages in the list below are therefore the floors `audit:coverage-scopes` enforces, not
something the adjacent command checks. The commands remain useful for running a scope's tests, and
their CI jobs still do real work the main suite does not (the Sandbox job builds the sandbox helper
and runs `cppcheck --error-exitcode=1` on its C source; the Vault job installs libsecret + D-Bus).

```bash
# Engine + agents
bun run test:coverage:engine          # ≥85% (engine)
bun run test:coverage:agents          # ≥80% (built-in agents)

# Vault + security-adjacent
bun run test:coverage:vault           # ≥90% (vault)
bun run test:coverage:extensions      # ≥85% (extension registry + manifest + verify + T2 PR 3 auto-update)
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
bun run test:coverage:telemetry       # ≥85% (telemetry collector — payload safety gate)
bun run test:coverage:doctor          # ≥80% (nimbus doctor)
bun run test:coverage:tui             # ≥80% (packages/cli/src/tui)

# Phase 4 WS4 — release infrastructure
bun run test:coverage:updater         # ≥80% (updater state machine + manifest fetcher)
bun run test:coverage:lan             # ≥80% (lan-crypto, lan-pairing, lan-rate-limit, lan-rpc, lan-server)
bun run test:coverage:perf            # ≥80% (perf bench harness)

# Phase 5 T4 — CI/CD data layer
bun run test:coverage:metrics         # ≥80% (DORA calculators + IPC)
bun run test:coverage:preflight       # ≥80% (preflight calculator + IPC + HTTP + github-sync mergeable enrichment)
bun run test:coverage:deployment      # ≥80% (post-deploy annotation calculator + HTTP write surface)
bun run test:coverage:security        # ≥80% (security/ + security-rpc + e2e)

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
bun run audit:coverage-floor                 # per-file floor: ≥85% line / ≥80% branch (with ratcheting baseline)
bun run audit:coverage-floor:build-lcov      # per-package bun test + lcov merge (reproduces CI input for the floor gate)
bun run audit:coverage-floor:update-baseline # raise must-raise watermarks + drop must-remove entries
bun run audit:dead-code                 # knip unused exports / orphan files (D7)
bun run audit:duplication               # jscpd token duplication (D6)
bun run audit:exclusion-parity               # sonar.coverage.exclusions <-> local registry drift check
bun run audit:any                       # D8 any-count print
bun run audit:invariants                # static invariant complement D10–D23 (spawn rule, vault-key allow-list, SQL writes, federation/identity/team-vault gates, policy, chatops, preflight, tribal, connector writes, share, egress dispatch chokepoint, exec runConfined) — see CLAUDE.md § Security Invariants
bun run audit:openapi-drift             # OpenAPI ↔ HTTP_ROUTES drift (Phase 5 T4 PR 1)

bun scripts/structure-audit/count-any-usage.ts --check     # D8 CI gate (fails on regression OR reduction without --update)
bun scripts/structure-audit/count-any-usage.ts --update    # rewrite docs/structure-audit/any-baseline.json

bun run audit:doc-refs                  # doc-ref drift (broken markdown links + backtick paths) across
                                        # CLAUDE/GEMINI, all of docs/ and .claude/{commands,agents}/*.md.
                                        # Excluded, each with a reason in the script: docs/CHANGELOG.md,
                                        # docs/roadmap.md, docs/superpowers/, docs/ci-secrets.md,
                                        # docs/structure-audit/baseline.md
bun run audit:workflow-run-triggers      # workflow_run upstreams must be write-access-only (pwn-request premise)
bun run audit:workflow-lint              # workflow YAML validity + column-0 heredoc escapes + `bash -n` on every
                                         # bash body + every job with `steps:` declares `timeout-minutes`
bun run audit:readme-cli                 # every `nimbus <cmd>` in docs/README.md AND docs/cli-reference.md is
                                         # a registered command (docs/roadmap.md is deliberately not gated)
bun run audit:status-drift               # doc status surfaces vs canonical I<N>/V<N>, plus three derived claims:
                                         # the I13 write-route surface (incl. the two skills), I7 allowlist size,
                                         # the I17 LAN-admitted set
```

Baselines: `docs/structure-audit/{any-baseline.json,baseline.md,churn-90d.json,coverage-baseline.json,db-run-census.json}`.
CI gate (reusable workflow): `.github/workflows/_structure.yml`.

## Mutation testing (dev-only, advisory — True Coverage Sub-project C)

StrykerJS over `packages/gateway/src/` (non-test `.ts` only). Advisory, not a blocking CI gate; run it to find weak assertions in well-covered code.

```bash
bun run mutation          # stryker run — full configured scope (stryker.conf.*)
bun run mutation:diff     # scripts/mutation/run-mutation.ts --diff — only files changed vs origin/main…HEAD
```

`mutation:diff` is the per-PR mode: it diffs gateway-src files against the `origin/main` (fallback `main`) merge-base and mutates only those, so a focused change doesn't trigger a whole-package mutation run. Security-core has a tracked baseline; the 100%-pinned `executor.ts` / `tool-output-envelope.ts` are the ideal first substrate.

## Headless packaging + installers

After compiling gateway + CLI to `dist/`:

```bash
bun run package:headless                            # bundle headless gateway + CLI
bun run package:installers:linux -- --version 0.1.0 # Linux .deb + .rpm + tarball (nfpm)
```

Optional: set `NIMBUS_EMBEDDING_MODEL_DIR` (or pass `--embedding-model-dir`) to embed pre-downloaded MiniLM weights in the bundle.

**Native installers + package-manager channels** (driven by CI on release tags, not local bun scripts):

- macOS `.pkg` — `scripts/package-macos-installer.sh`; Windows `.msi` — `scripts/package-windows-installer.ps1`.
- Package-manager manifests are generated from `scripts/release/`: `package-manager-manifests.ts` (Homebrew formula + Scoop manifest), `winget-manifest.ts` (`NimbusAgent.Nimbus`), `linux-repo-config.ts` + `nfpm-config.ts` (hosted GPG-signed apt/yum repo at `nimbus-agent.github.io/linux-repo`).
- Signing helpers: `scripts/sign/sign-{macos.sh,windows.ps1}`, `scripts/sign-linux-gpg.sh`, `scripts/sign-ed25519.ts` (updater manifest).
- End-user install matrix (brew/scoop/winget/apt/yum + native installers + verification) is documented in **[`docs/install.md`](../../docs/install.md)** — the canonical source; keep it in sync when a channel changes.

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
nimbus lan [status]                    # default; enabled / pairing-open / listen addr
nimbus lan open [--allow-pairing]      # start LAN server; open 5-min pairing window
nimbus lan close                       # close the pairing window
nimbus lan peers                       # list connected peers
nimbus lan grant <peerId>              # allow peer to call write/HITL methods
nimbus lan revoke <peerId>
nimbus lan remove <peerId>
```

### First run

```bash
nimbus init [--no-sync]                   # index the git repo in the CWD — no credentials, no API key, no LLM
```

Appends a `[[filesystem.roots]]` block to `nimbus.toml` (never rewrites; backs up to `nimbus.toml.bak`), starts the Gateway, syncs the `filesystem` connector, then prints a real `file:line` from your own repo to try with `nimbus why`. Idempotent.

### Phase 5 T3 — Team Intelligence built-in agents

```bash
nimbus expert <topic-or-file>             # IPC: agents.expert;  emits expert.briefReady
nimbus impact <file-or-PR-url>            # IPC: agents.impact;  emits impact.briefReady
nimbus catchup [--since <duration>]       # IPC: agents.catchup; emits catchup.briefReady
```

The notification prefix is the **agent** name, not `agents.` — `expert.briefReady`, not `agents.expert.briefReady`.

### Spine S1 — implicit-knowledge triad

```bash
nimbus why <ref> [--line <n>] [--peek] [--json]                                    # IPC: agents.why / agents.whyPeek
nimbus glossary [<term>] [--limit <n>] [--json] [--refresh | --rebuild [--yes]]    # IPC: agents.glossary; passes via glossary.refresh/rebuild
nimbus decisions [--since <dur>] [--service <name>] [--min-confidence <0..1>] [--explain] [--json] [--refresh | --rebuild [--yes]]
```

The `USAGE` constant in each command file (`packages/cli/src/commands/{glossary,decisions}.ts`) is canonical — copy it, do not reassemble it from the flag parser. `nimbus glossary` **hard-rejects** an unrecognised flag rather than ignoring it. `--refresh`/`--rebuild` drive a long-running, write-class pass (`glossary.*` / `decisions.*`), are mutually exclusive, and `--rebuild` needs `--yes`; both namespaces are LAN-forbidden and not Tauri-exposed.

### Spine S1 — ownership graph

```bash
nimbus owners [<path>] [--service <name>] [--json] [--refresh]    # IPC: agents.ownership; pass via ownership.refresh
```

The `USAGE` constant in `packages/cli/src/commands/owners.ts` is canonical. `nimbus owners` also **hard-rejects** an unrecognised flag, and `<path>`/`--service` are mutually exclusive. See the note below on why the hard-reject matters for this family. `--refresh` drives a long-running, write-class derivation pass (`ownership.refresh`) — unlike glossary/decisions there is **no** `--rebuild` counterpart (the pass already clears and re-emits every edge wholesale each run, so a rebuild would be a synonym for refresh) and the RPC takes **no parameters at all**. The `ownership` namespace is LAN-forbidden and not Tauri-exposed; the read-only `agents.ownership` is exposed on both, like every other agent.

### Spine S1 — risk and contribution briefs

```bash
nimbus pre-mortem <epic-ref> [--service <name>]... [--json] [--refresh] [--repropose]   # IPC: agents.premortem
nimbus negotiate [--since <duration>] [--person <id>] [--json]                          # IPC: agents.negotiate
```

`USAGE` in `packages/cli/src/commands/{pre-mortem,negotiate}.ts` is canonical. Both **hard-reject** an unrecognised flag, for the same reason `owners`/`glossary` do and it matters more here: a dropped `--persn` returns *your own* contribution brief in answer to a question about someone else, and a dropped `--srevice` silently re-derives the affected-service set — wrong answers that look like right ones. `<epic-ref>` is **Jira-only** (`PROJ-120` or `jira:PROJ-120`); `--since` on `negotiate` defaults to `90d` and caps at `365d`.

### Spine S1 — bucketed time series

```bash
nimbus stats <metric> --service <id> [--window 90d] [--bucket 1w] [--json]   # IPC: metrics.stats
```

Metrics: `deployment-frequency`, `lead-time`, `change-failure-rate`, `mttr`, `pr-merges`, `incidents-opened`. This is the **disjoint-bucket** counterpart to `nimbus metrics dora`, which returns one scalar over one window — not a rolling window. Durations accept `w d h m s ms` and are parsed **CLI-side**: `metrics.stats` receives resolved integers, deliberately, because both gateway-side parsers are narrower than this command's own `1w` default (`ipc/metrics-rpc.ts` takes `d|h` only; `index/item-list-query.ts` has no `w`). Do not "simplify" by forwarding the raw string.

### Spine S1 — negation predicates and devil's advocate

```bash
nimbus query --service github --type pr         --not-touching '<glob>' [--explain]
nimbus query --service github --type deployment --no-downstream-incident  [--explain]
nimbus people list --not-reviewed --since 7d                              [--explain]
nimbus ask "<question>" --devil        # argue against the answer before giving it
```

Each predicate **refuses** — exit `1` with a structured `missing_substrate` document — rather than answering from an unpopulated substrate, because for a negation a *missing* row produces a result instead of costing one. The same three predicates exist on the gateway engine (reached by `nimbus ask`, and by the desktop/VS Code surfaces sharing its engine) and on the MCP server, but **the guarantee is unequal on purpose**: refusals are structural on both, exclusion counts are appended only on the engine surface. Two bounds worth knowing before you rely on them: an external MCP client's model can report rows and silently drop "12 excluded", and with `[llm].prefer_local = true` the local router has **no tool-calling support at all**, so the predicates are unreachable on that path — a local-only user gets them through the CLI or an MCP client, never through `nimbus ask`.

### Index maintenance

```bash
nimbus index add <path>
nimbus index reembed --model <id> [--service <s>] [--item-type <t>] [--dry-run | --yes] [--json]   # local recompute
nimbus index rebody --dry-run                                 # per-service pending body_complete = 0 counts; no network call
nimbus index rebody --service <name> --yes [--limit N] [--json]
nimbus index regraph [--json]                                 # re-run the graph populator over existing rows; idempotent
```

**`rebody` is not a local recompute.** It clears a connector's sync watermark and lets the sync run from scratch — real outbound API traffic against the owner's credentials and rate-limit quota. Neither `--dry-run` nor `--yes` ⇒ it makes no IPC call at all and just prints the plan. Depth: the `nimbus-index-body-depth` skill.

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

### Phase 5 — security audit follow-ups

```bash
nimbus security scan [--json]   # local credential-hygiene scan over already-indexed content.
# IPC: security.scan — CLI-only; NOT in Tauri ALLOWED_METHODS (I7); FORBIDDEN_OVER_LAN (I5).
# Read-only; never fetches new content; emits no full secrets in output/logs/audit.
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

### Phase 5 T2 PR 3 — Extension auto-update

```bash
nimbus extension update [<id>] [--check] [--to <version>] [--json]
# --check: force registry poll + list. <id>: apply cached bump via HITL.
# --to <v>: override target (forward or backward; backward fires extension.downgrade).
# Exit 0 on success, 1 on apply failure (stderr hint when reason has one).
# IPC: extension.checkForUpdates / extension.update — CLI + Tauri allowed (ALLOWED_METHODS),
# FORBIDDEN_OVER_LAN (I5).

nimbus extension downgrade <id> --to <version> [--json]
# Thin wrapper around extension.update; the <version> must already exist
# under <extRoot>/<id>/_prev/<version>/ (a prior swap saved it). Fires the
# extension.downgrade HITL action type.

# nimbus.toml knob:
#   [extensions].update_check_interval_hours = 24    # integer in [1, 168]; default 24
```

### Phase 6 Slices 1+2+5 — Team federation

```bash
nimbus team discover                                  # mDNS-discover peers on the LAN
nimbus team pair <host> <code>                        # out-of-band pair with a peer using its code
nimbus team namespace publish <name> --type T --service S [--tag T]   # publish a shared scoped namespace
nimbus team namespace grant <ns> <peerId> <role> [--standing]         # grant a peer RBAC on a namespace
nimbus team namespace revoke <ns> <peerId>
nimbus team query <ns> <peerId> "<purpose>"           # federated query against a peer's namespace
nimbus team who-knows <peerId> "<query>"              # content-free expertise routing
nimbus team consent <requestId> approve|deny          # answer an inbound federated-query consent request
nimbus team listen                                    # stream + answer inbound consent requests

# Team Vault + delegated/quorum HITL (Slice 2)
nimbus team vault put <entry> <service> --secret key=value   # store a team-shared secret
nimbus team vault grant <entry> <peerId> <toolId>            # let a peer invoke a tool with the secret
nimbus team vault revoke <entry> <peerId> <toolId>
nimbus team vault list
nimbus team invoke <peerId> <entry> <toolId> --purpose "<why>" [--args <json>]   # team-credentialed invoke
nimbus team delegate <peerId> --scope kind:value --expires <seconds>             # delegate HITL approval
nimbus team delegations                               # list active delegations
nimbus team approve <requestId> [--as <peerId>]       # answer a (possibly delegated) HITL request
nimbus team deny <requestId> [--as <peerId>]
nimbus team audit <namespace> [--purpose "<why>"] [--since <unixMs>]   # merged cross-gateway audit timeline
nimbus team purge --user <externalId> [--yes]         # GDPR-purge a user across the team index (Slice 4)
```

### Phase 6 Slice 3 — Identity (SSO / OIDC) + SCIM

```bash
nimbus identity login                                 # OIDC device-code SSO sign-in
nimbus identity status
nimbus identity logout
nimbus identity bind <email> <peerId>                 # bind an IdP identity to a peer
nimbus identity unbind <peerId>
nimbus identity list-bindings <email>

nimbus scim status
nimbus scim set-token <token>                         # set the SCIM provisioning bearer (CLI-only)
nimbus scim list-users
nimbus scim deprovision <email>
```

### Phase 6 Slice 4 — Org policy + admin console

```bash
nimbus policy show                                    # current enforced (resolved) org policy
nimbus policy verify                                  # verify the pinned policy signature
nimbus policy sign <file.toml>                        # sign + apply a policy TOML (alias: push)
nimbus policy trust <pubkeyBase64>                    # pin the org-policy anchor pubkey
nimbus policy refetch                                 # re-fetch the org policy from its source

nimbus admin status                                   # admin-panel status
nimbus admin console                                  # print the admin console URL (bearer in URL fragment)
nimbus admin token                                    # print the bearer-resolver command (nimbus vault get)
```

### Phase 6 Slice 5 — ChatOps

```bash
nimbus chatops status                                 # bot connection + per-platform channel counts
nimbus chatops start
nimbus chatops stop
nimbus chatops test "<message>"                       # post a test message through the reply dispatcher (I23)
```

### Phase 6 Slice 8 + S1 — Share, recipes, and the egress ledger

```bash
nimbus share <session-id> [--as-recipe]               # redacted, owner-HITL-gated, signed outbound share (I27)
nimbus share list | prune                             # list / prune share records
nimbus share inbox [--all]                            # inbound forwarded shares (8d)
nimbus share forward <contentHash> --to-peer <id>     # forward a received share to a peer (8d)
nimbus verify-share <file|url> [--replay]             # verify signature/hash; --replay re-runs read-only tool calls (8c)
nimbus prove "<query>"                                # run a query + prove its outbound egress count is 0 (I29)
nimbus egress [verify] [--since <dur>] [--json] [--sign]            # egress report / offline BLAKE3-chain verify
nimbus egress prune (--before <ISO|epoch> | --older-than <dur>)    # HITL-gated retention; the sole egress_ledger mutation
```

### Phase 6 Slice 9 — Web clipper (owner-side control plane)

```bash
nimbus clip pair [--label <name>]                     # open the I30 pairing window; prints a 6-digit code (+ the gateway URL only when the HTTP sidecar is configured)
nimbus clip status                                    # minted clip tokens by label (never the token bytes)
nimbus clip revoke <label|--all>                      # revoke a paired browser
nimbus clip list [--tag <tag>] [--limit <n>] [--json]  # list indexed nimbus:web_clip items
nimbus clip delete <id|url> | --all [--yes]           # delete clips
```

The browser extension lives in the satellite repo `nimbus-agent/nimbus-web-clipper` and reaches the gateway over HTTP only (`POST /v1/clips`, `/v1/clips/pair/confirm`, `/v1/clips/related`).

### MCP server mode

```bash
nimbus mcp-server                                     # run Nimbus as an MCP server over stdio (no subcommands)
```

## Environment-variable overrides

### Auto-update daemon (Phase 5 T2 PR 3)

```
NIMBUS_EXTENSIONS_REGISTRY_URL=<url>     # registry base URL; daemon construction is gated on this
NIMBUS_EXTENSIONS_DISABLE_AUTO_UPDATE=1  # hard-disable the polling daemon at Gateway init
```

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

Local model ids are passed to the local router. With Ollama running on `http://127.0.0.1:11434`, set `[llm].local_model` to any pulled model name and `[llm].prefer_local = true`; `nimbus ask` can then answer open-ended questions from indexed context even when no remote classifier key is configured.
```
```

## Docs site

```bash
bun run docs:build                              # from repo root (workspace filter)
cd packages/docs && bunx astro build            # static build
cd packages/docs && bunx astro dev              # local dev server
```

## Release tags (publish triggers)

```bash
# @nimbus-dev/client (nimbus-agent/nimbus-client), the VS Code extension
# (nimbus-agent/nimbus-vscode), and the browser web clipper
# (nimbus-agent/nimbus-web-clipper) all release from their OWN standalone repos
# via release-please + OIDC trusted publishing, each with its own CI —
# NOT from a monorepo tag.
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
