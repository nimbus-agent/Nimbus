# Nimbus — Claude Code Context

## Project Overview

Nimbus is a **local-first AI agent framework**: a headless Bun Gateway that keeps a private SQLite index of the user's data across ~90 cloud services (full roster: `CONNECTOR_VAULT_SECRET_KEYS` in `packages/gateway/src/connectors/connector-secrets-manifest.ts`), optional `[[filesystem.roots]]` indexing, and the local filesystem via first-party MCP connectors, and runs multi-step agentic workflows on the user's behalf. Clients (CLI, Tauri 2.0 desktop) talk to the Gateway only over JSON-RPC 2.0 IPC.

**Runtime:** Bun v1.2+ / TypeScript 7.x strict (two pins stay on TypeScript 6: `packages/docs`, because `astro check` refuses 7.0, and the root `typescript-compiler-api` alias used by `scripts/cleanup/`, `scripts/structure-audit/check-connector-hosts.ts` and `audit:boundaries`) · **Linter:** Biome · **License:** AGPL-3.0 (gateway/cli) + MIT (sdk)

**Latest release:** `v11.20.0` <!-- x-release-please-version -->

The line above is rewritten by release-please (an `extra-files` entry in `.release-please-config.json`); `audit:release-please` fails if it disagrees with the manifest. Keep it on its own line.

**Gemini CLI:** [`GEMINI.md`](./GEMINI.md) mirrors this file — update both when changing commands, roadmap rows, or non-negotiables.

### Status (summary — the detail lives elsewhere)

- Phases 1–6 ✅; since 2026-11-26 the phase number is the build order (no spine slots; S5 was removed). The former slots are shipped records: **S1 Local Brain ✅, S2 Local Compute Fleet ✅, S3 Open Surface ✅** (MCP capture sink, extension runtime, role packs, the Phase 9.5 marketplace) and S4 below.
- **S4 Autonomous Agent ✅ complete (2026-11-04 → 2026-11-26).** Shipped within it: Phase 9.7 (model connector writes, all four waves; 144 write rows since connectors 0.22.0's Unleash toggle and Split kill and restore), Phase 10 standing approvals / scheduled workflows / morning briefing / incident engine IC1–IC10 / LAN forward secrecy FS1–FS3 / FinOps / IaC drift / episodic memory / personalization / federated scheduling, Phase 17 on-call work, and Phase 28 (the agent door, AD1–AD8, enforced since v11.0.0; closed 2026-11-26 when acceptance A6 verified the Claude Code and Codex kits against the real agents, the last row of S4's exit condition). Rows moved out by owner rulings keep their places (LoRA in Phase 13, cost deletion and data FinOps in Phase 7, the signed mobile approval in Phase 15).
- **Phase 7, the Cost Pack, is open** (slices 1 to 6 of 8 shipped 2026-11-26 to 2026-11-27), then 8, 9, 11 and on in number order (`docs/roadmap.md` § Build order); the team server is planned in Phase 19 (the old Phase 29), in the team band.
- **Invariants I1–I61; schema V109.**
- **Several shipped capabilities are deliberately narrower than their names** (model access to generated tools and computer-use, remote vision, fleet idle detection, brief `## Gaps`). Read the claim in code and `docs/roadmap.md` before relying on one.

Canonical sources: dated log [`docs/CHANGELOG.md`](./docs/CHANGELOG.md); status, acceptance criteria, owner rulings and stated bounds [`docs/roadmap.md`](./docs/roadmap.md); invariant detail [`docs/SECURITY-INVARIANTS.md`](./docs/SECURITY-INVARIANTS.md). **Do not grow this section into a changelog again** — record a shipped slice in those files, and here only when the summary above becomes false.

---

## Non-Negotiables

Architectural constraints, not preferences. Do not suggest changes that violate them:

1. **Local-first** — machine is the source of truth; cloud is a connector.
2. **HITL (human-in-the-loop) is structural** — consent gate lives in the executor, not the prompt; cannot be bypassed or configured away.
3. **No plaintext credentials** — Vault only (Windows DPAPI / macOS Keychain / Linux libsecret); never in logs/IPC/config.
4. **MCP as connector standard** — the engine never calls cloud APIs directly.
5. **Platform equality** — Windows/macOS/Linux equally supported. PRs gate on Ubuntu **plus** a macOS and a Windows leg (`pr-quality-cross-platform`) running the SAME whole-repo `bun test` command as the push matrix.
6. **AGPL-3.0 core / MIT SDK** — dual license is intentional; do not change license fields.
7. **No `any`** — use `unknown` for external data; TypeScript strict mode is non-negotiable.

---

## Security Invariants

Each live invariant (I1–I61) has a production wiring site + an enforcement test in `packages/gateway/src/security-invariants/`. **Full rationale, exact scope, stated bounds and anti-patterns:** [`docs/SECURITY-INVARIANTS.md`](./docs/SECURITY-INVARIANTS.md) + the `nimbus-security-invariants` skill — read before adding/auditing any defense. Triple rule: wiring + docs + test land in the same commit; to retire one, delete the row, never leave drift.

| # | Rule (one line — the doc is authoritative) | Main site |
| --- | --- | --- |
| I1 | child-process env scoped via `extensionProcessEnv()` | `connectors/lazy-mesh/*` |
| I2 | HITL frozen-set membership (`HITL_REQUIRED_BACKING` module-private); exceptions: gateway's own change-set discard (D43), I55 standing rules | `engine/executor.ts` `gate()` |
| I3 | gate consults `action.type` only, never `payload.mcpToolId` | same |
| I4 | `hitlStatus` set only by the gate; each decision records its `answerSource` | same |
| I5 | `checkLanMethodAllowed` intrinsic to `LanServer` | `ipc/lan-server.ts` |
| I6 | LAN bind defaults to `127.0.0.1` | `config/nimbus-toml/lan.ts` |
| I7 | Tauri `ALLOWED_METHODS` excludes RCE-class methods | `ui/src-tauri/src/gateway_bridge.rs` |
| I8 | restrictive renderer CSP | `ui/src-tauri/tauri.conf.json` |
| I9 | bound-param SQL; identifiers via `escapeIdentifier` | `db/write.ts` |
| I10 | constant-time compare for hashes/MACs/tokens | `util/timing-safe-compare.ts` |
| I11 | LLM-facing results via `wrapToolOutput`; user-MCP descriptions closer-escaped, schemas rebuilt | `engine/tool-output-envelope.ts` |
| I12 | DPAPI passes `pOptionalEntropy` | `vault/win32.ts` |
| I13 | HTTP writes via `WRITE_ROUTE_ALLOWLIST` + bearer auth | `ipc/http-server.ts` |
| I14 | SQLite writes via `dbRun`/`dbExec`/`dbStmtRun` (D12) | `db/write.ts` |
| I15 | every lazy-mesh `ServerSpec` via `wrapServerSpec()` → sandbox (D10); write exceptions: Obsidian daily note, user-MCP `--write` dirs, iac/kube per-run profiles | `connectors/lazy-mesh/*` |
| I16 | Ed25519 verify at install + every startup for publisher extensions | `extensions/verify-extensions.ts` |
| I17 | federated answers only in `query-gate.ts`; (b) free/busy only in `free-busy-gate.ts` | `federation/` |
| I18 | IdP token validation only in `identity/verifier.ts` | `identity/verifier.ts` |
| I19 | team-vault secrets only via `invoke-gate.ts` | `federation/invoke-gate.ts` |
| I20 | delegated approval only from a live, in-scope delegate; never for model/agent origin, bound writes, installs, standing rules | `engine/delegated-approval.ts` |
| I21 | quorum counts distinct authenticated peers | `engine/quorum/quorum-coordinator.ts` |
| I22 | signature-verified, tighten-only org policy (D16) | `policy/policy-gate.ts` |
| I23 | ChatOps operational posts only to a server-derived target (D17) | `chatops/reply-dispatcher.ts` |
| I24 | federated preflight runs only behind the LOCAL owner's gate (D18) | `federation/preflight-gate.ts` |
| I25 | tribal KB capture only to the pinned destination (D19) | `tribal/tribal-write-gate.ts` |
| I26 | connector writes only behind the local owner; federation refuses write + prepare ids (D20) | `federation/invoke-gate.ts` |
| I27 | outbound share only through `createShare()`/`forwardShare()` (D21) | `share/*` |
| I28 | MCP-client content enters only via `submitCapture()`; actions leave only via `acceptAction()` + the executor prompt (D32) | `mcp-sink/*`, `ipc/{capture,approvals}-rpc.ts` |
| I29 | egress ledger: one BLAKE3-chained row BEFORE every outbound request; failed append aborts (D22) | `engine/executor.ts`, `egress/*` |
| I30 | web-clipper tokens mint only in an owner-opened pairing window | `clips/pairing-window.ts` |
| I31 | a synthesized brief never says less than the deterministic render | `agents/_lib/synthesize.ts` |
| I32 | clip `source` rebuilt from five whitelisted fields | `clips/clip-ingest.ts` |
| I33 | user code runs only through `runExecution()` (D23) | `exec/exec-gate.ts` |
| I34 | `LlmProvider.isLocal` from exactly one source | `llm/base-url-locality.ts` |
| I35 | computer-use actuation only via `cu-gate.ts` in an owner-approved session (D26) | `computer-use/*` |
| I36 | a forge-coordinate file question never reaches federation | `ipc/agents-rpc/file-param.ts` |
| I37 | media to a non-local model only via `media-gate.ts` with a per-artifact grant (D27) | `multimodal/*` |
| I38 | unattended fleet run uses a remote model only within `[fleet] allow_remote` + budget (D28) | `fleet/*` |
| I39 | generated tools reach the network only via the toolgen broker (D29) | `toolgen/toolgen-broker.ts` |
| I40 | saved generated tool runs only under a live signature | `toolgen/toolgen-saved-store.ts` |
| I41 | a demo-rooted process never reaches the real install; demo gateway is inert | `platform/demo-root.ts` |
| I42 | every `mcp_*`/`ext_*` action needs HITL, never delegable; agent reach by named approval (D49(g),(h)) | `engine/executor.ts` |
| I43 | extension code runs only through `prepareSpawn` (D33(a)) | `extensions/extension-runtime.ts` |
| I44 | registry code installed only through the verified chain | `extensions/registry/registry-fetch.ts` |
| I45 | every gateway `Bun.serve` 403s a non-loopback `Host` | `locality/loopback-host-guard.ts` |
| I46 | only `migration.accept` can create a run grant from the renderer | `ipc/migration-rpc.ts` |
| I47 | role-pack layer written only by `pack-install.ts` after `pack.install` (D36) | `packs/pack-install.ts` |
| I48 | revoked / taken-down extension code never installed or spawned without acknowledgment (D37) | `extensions/trust/trust-blocks.ts` |
| I49 | eval runs only in the no-network, no-credential eval runtime (D38) | `extensions/eval/*` |
| I50 | Linux sandboxed network only through the local forwarder | `platform/sandbox/linux-forwarder.ts` |
| I51 | registry liveness/provenance evidence changes only a displayed line, never a decision | `extensions/registry/*` |
| I52 | audit evidence only narrows a run grant | `extensions/extension-run-grants.ts` |
| I53 | model connector writes: owner's `cli`/`ui` turn, enabled wave, named approval, door refusals, Wave 4 typed confirm (D39–D41) | `engine/connector-write-agent-tools.ts` |
| I54 | bound writes dispatch only gateway-injected prepare values (D42) | `engine/prepare-step.ts` |
| I55 | standing-rule approval only inside `approvalPhase` for eligible workflow writes (D44) | `engine/standing-rule-step.ts` |
| I56 | LAN records encrypted only under Noise session keys; no v1 path (D47) | `ipc/lan-session.ts` |
| I57 | (a) incident assembly read-only; (b) engine proposes, never runs; (c) runbooks one owner step at a time (D46) | `incident/*` |
| I58 | outside agent proposals: named approval + definition hash, agent origin through the door executor (D49) | `connectors/connector-writes/agent-door.ts` |
| I59 | imported workflows only via `importWorkflowBundle()` after owner approval (D50) | `automation/workflow-import.ts` |
| I60 | saved generated tool reaches the model only by exact-id listing + per-call approval (D51) | `toolgen/toolgen-model-door.ts` |
| I61 | episodic memory: owner turns only, local model + embedder, untrusted recall (D52) | `memory/episodic-*.ts` |

Paths are relative to `packages/gateway/src/` unless they start with `ui/`.

**Static complement:** `scripts/structure-audit/check-nimbus-invariants.ts` (rules in `scripts/structure-audit/invariants/`) runs before the test suite and enforces static rules D10–D52, including rules tied to no invariant (D24 SyncContext boundary, D25 hidden spawns, D30, D31, D33(b)/(c), D34, D35, D45, D46(b)).

---

## Subsystems

**This repository is the Gateway, not the whole of Nimbus.** In this repo:

- `packages/gateway` — Engine, MCP mesh, Vault, local index, IPC
- `packages/cli` — Terminal client (CLI + Ink TUI) and the MCP server (`packages/cli/src/commands/mcp-server.ts`, `packages/cli/src/mcp/`)
- `packages/ui` — Tauri 2.0 + React (desktop)
- `packages/docs` — Astro Starlight documentation site
- `packages/admin-console` — static admin console served at `/admin/*`
- `packages/registry-format` — pure, Bun-free extension-registry rules shared by gateway, CLI and registry CI; imports nothing from gateway/cli/ui
- `packages/github-actions/*` — first-party GitHub Actions; tracked but NOT workspace members

Elsewhere (a change there is a PR in that repo):

- `@nimbus-dev/sdk` — [nimbus-agent/nimbus-sdk](https://github.com/nimbus-agent/nimbus-sdk) (MIT)
- `@nimbus-dev/connectors` — [nimbus-agent/nimbus-mcp-servers](https://github.com/nimbus-agent/nimbus-mcp-servers) (AGPL); the package exports 100 connectors, and 99 of them are bundled into the gateway binary via `BUNDLED_CONNECTORS` (Readwise ships as a signed extension). Per-connector **sync/indexing** logic stays here, so a new connector touches both repos. A publish there never blocks the gateway: the pin moves only in a gateway PR, which the lockfile, `audit:connector-registry-drift`, the write-row manifest sync and the compiled binary's connector boot gate (`bun run report:connector-version-skew` says what is published but unpinned; it never fails).
- `@nimbus-dev/client` — [nimbus-agent/nimbus-client](https://github.com/nimbus-agent/nimbus-client) (MIT)
- `@nimbus-dev/mcp` launcher — [nimbus-agent/nimbus-mcp](https://github.com/nimbus-agent/nimbus-mcp) (MIT; MCP Registry `io.github.nimbus-agent/nimbus`)
- VS Code extension — [nimbus-agent/nimbus-vscode](https://github.com/nimbus-agent/nimbus-vscode)
- Browser client — [nimbus-agent/nimbus-web-clipper](https://github.com/nimbus-agent/nimbus-web-clipper); the gateway side (`packages/gateway/src/clips/`, I30) stays here. Direction: [`docs/roadmap.md` § Track 2 → Client surfaces](./docs/roadmap.md#client-surfaces).

**PAL:** OS-specific logic lives under `packages/gateway/src/platform/`, accessed via `PlatformServices` — never import `win32`/`darwin`/`linux` from business logic.

**Dependency rules:** `gateway` imports nothing from cli/ui. `cli` and `ui` reach the gateway IPC-only. `sdk` imports nothing from gateway/cli/ui. The gateway's ONLY static import from the connectors package is `setConnectorMode` (in `run-bundled-connector.ts`); the generated `connectors/bundled-connector-registry.ts` `import()`s each connector entrypoint. Circular dependencies are forbidden.

**Prerequisites:** Bun v1.2+; Rust for the Tauri UI. Local `nimbus ask` can run through Ollama (`[llm].prefer_local = true` + `[llm].local_model`).

---

## Testing Philosophy

- **HITL tests** prove the gate fires for every whitelisted action type before the connector is called.
- **Vault tests** prove no secret value escapes through any interface.
- **Integration tests** use real SQLite + real Bun subprocesses + fresh temp dirs — no mocks at the DB layer.
- **E2E CLI tests** use a real Gateway subprocess + mock MCP servers — no real cloud calls.
- **Coverage gates:** 23 scopes with their own floors (Engine ≥85%, Vault ≥90%, Embedding ≥80%, …) enforced by `audit:coverage-scopes` over the merged lcov (`scripts/coverage-floor/check-scopes.ts`), plus the per-file `audit:coverage-floor`. The `test:coverage:*` scripts' threshold flag is ignored by Bun.
- Prefer **dependency injection over `mock.module`** (it is process-global and leaks across files in non-isolated runs).
- Focus on the current phase; do not add Phase N+1 features in Phase N code.

### CI gating

- **Ten required status checks** (ruleset _General_, 14784377): `PR quality — required gates` (an aggregator over every job in the PR-quality workflow), `Dependency audit`, `Trivy vulnerability scan`, `Gitleaks secret scan`, `Gateway audit JSON + connector.remove vault restore`, `Cargo audit (Tauri)`, `Cargo deny (licenses + advisories + bans)`, `Analyze (javascript-typescript)`, `Analyze (rust)`, `cla`. Every review thread must also be resolved. When a red check "shouldn't matter", re-derive the list: `gh api repos/nimbus-agent/Nimbus/rulesets/14784377`.
- **No merge queue; branches need not be up to date.** Two green PRs can still break `main` together. Dependabot update PRs are retired; dependencies move in manual bulk updates per [`docs/CONTRIBUTING.md` § Updating Dependencies](./docs/CONTRIBUTING.md#updating-dependencies).
- **A failing step hides every later step in the same job** (e.g. `Dependency audit`: `bun audit` → `audit:advisories` → `audit:js-licenses`; `Unit + Coverage`: coverage floor → scopes → Sonar). Read the whole step list before pushing a fix: `gh api repos/nimbus-agent/Nimbus/actions/jobs/<id> --jq '.steps[] | "\(.conclusion) \(.name)"'`.
- **The PR cross-platform legs run the same test PATHS as the push matrix:** `bun test packages/gateway packages/cli scripts --parallel` (Windows as `--shard=1/2` and `--shard=2/2`), through `scripts/ci/test-with-retry.ts`. `scripts/ci/cross-platform-parity.test.ts` holds the commands equal — **change one, change the other, `--parallel` included.** The Linux `Unit + Coverage` leg runs `--parallel --no-isolate`, so cross-file mock leakage is still possible there.
- PR legs do not cover coverage or packaging (Ubuntu-only). Docs-only PRs and pure release-please version bumps (`scripts/ci/release-only-diff.ts`) skip the test jobs.
- **Local green does not predict CI:** the runner is ~13–18× slower at temp-dir SQLite work.

---

## Development Workflow

- **Worktrees:** `.claude/worktrees/<branch-name>` (git-ignored). A fresh worktree needs `bun install`.
- **Branch hygiene:** never commit on `main`/`develop`; `git switch -c dev/<you>/<topic>` and check `git rev-parse --abbrev-ref HEAD` first. `bun run hooks:install` adds a pre-commit guard + pre-push `preflight:fast`.
- **Verify before finishing any work (CRITICAL):** run `bun run preflight:fast` after any change; run the touched test suites (or full `bun run preflight`, which is CI parity — `test:ci` is only the tests); fix failures before presenting. Gate manifest: `scripts/lib/preflight-gates.ts`. Companions: `bun run verify:docker [--changed|--full]` (Linux CI image; reproduces Linux-only failures), `bun run verify:pr`, `bun run typecheck:tests` (covers `packages/{gateway,ui}/test/**`), `bun run audit:platform-test-gaps`. See the `nimbus-preflight` skill.
- **CI-Linux-only failures — reproduce, don't guess:** Docker `oven/bun:1.4` (never `:latest`) or WSL on a Linux-native copy. `audit:coverage-floor` is CI-Linux-authoritative.
- **Never merge with checks still running.** An admin can bypass the ruleset silently. Use `gh pr merge --squash --auto`. When triaging red `main`, compare the merge time with the required check's `started_at` (`gh api repos/nimbus-agent/Nimbus/commits/<sha>/check-runs`).
- **The PR title and description ARE the commit** (squash only). Conventional type in the title (release-please parses it); reasoning and trailers in the description. A bare `Release-As:` line in a description forces a release.
- **A `!` means a USER must act.** Ask: what does an existing user have to change to keep working? If nothing (removing an inert key, a change inside a `private: true` package, an internal workspace deletion, a stricter internal invariant), it is not breaking. Majors are permanent.
- **Release tags are immutable** (no bypass actors). A failed release is abandoned, never retagged: fix on `main`, mark the dead version in `CHANGELOG.md`, cut the next with a `Release-As: X.Y.Z` trailer as the LAST line of the PR description.
- **File size:** a new file under `packages/` or `scripts/` must be under 500 lines, and a file in `docs/structure-audit/file-size-baseline.json` never grows (`bun run audit:file-size`; `--update` only lowers). Split by phase or subsystem.
- **A split folder's modules are private to its facade** (`bun run audit:split-privacy`): repoint imports to `X.ts`, not `X/…`.
- **Cross-platform:** `path.join()` / `os.tmpdir()`, never hardcoded separators (`bun run audit:cross-platform`, escape hatch `// cross-platform-ok`).
- **Docs are gated:** `audit:doc-refs` resolves every path cited in `docs/` and `.claude/commands/`; `audit:status-drift` checks invariant/schema ceilings, the I13 route list, `ALLOWED_METHODS` and the LAN-admitted set against code. When a count changes, re-derive the _list_, not just the number. Every workflow job needs `timeout-minutes` (`audit:workflow-lint`).
- **Complexity on a security gate measures the security surface.** Sonar `S3776` hits gates (e.g. I35's `cu-gate.ts`) because each ordered check is a branch. Refactor by PHASE into named steps called in sequence so the order stays readable at the call site; never hide one check in a helper; keep one mutable state record for a `finally` that must write exactly once; keep one function for a check both arms need. Fix Sonar findings rather than suppress them (`docs/structure-audit/sonarqube-rule-tuning.md` records the exceptions).

Full command catalogue: `nimbus-commands` skill. File locations: `nimbus-file-map` skill.

---

## See Also

- [`docs/architecture.md`](./docs/architecture.md) — subsystem design, IPC catalogue, schema reference, and the design record ([§ Spine S2 Subsystems](./docs/architecture.md#spine-s2-subsystems)). Read before modifying a subsystem.
- [`docs/roadmap.md`](./docs/roadmap.md) — phases, acceptance criteria, owner rulings, stated bounds.
- [`docs/CHANGELOG.md`](./docs/CHANGELOG.md) — the dated log of every shipped slice.
- [`docs/SECURITY-INVARIANTS.md`](./docs/SECURITY-INVARIANTS.md) — I1–I61 rationale + anti-patterns.
- [`docs/cli-reference.md`](./docs/cli-reference.md) — full CLI subcommand reference.

---

## Skill References

Domain skills live in `.claude/commands/nimbus-*.md`, loaded on demand via the Skill tool.

| Skill | Use when… |
| --- | --- |
| `nimbus-architecture` | Placing/naming new code, package ownership, IPC design — read first for any Gateway-touching task |
| `nimbus-file-map` | "Where does X live?" |
| `nimbus-commands` | bun scripts, CLI subcommands, coverage gates, env overrides, `bun add` safety |
| `nimbus-ipc` | Adding/designing an IPC method, notification, or streaming contract |
| `nimbus-testing` | Choosing a test layer, location, coverage gate, or mocking the Gateway |
| `nimbus-preflight` | What to run before pushing; CI gates |
| `nimbus-security-invariants` | Adding/auditing a structural defense (the triple rule) |
| `nimbus-tauri-allowlist` | Exposing a method to the renderer (I7) |
| `nimbus-http-write-surface` | Adding an HTTP write route (I13) |
| `nimbus-tool-output-envelope` | Feeding tool results to the LLM (I11) |
| `nimbus-connector-authoring` | Building/modifying a first-party MCP connector |
| `nimbus-db-migrations` | Authoring a SQLite migration or new table |
| `nimbus-embedding-routing` | Embedding-table routing; `nimbus index reembed` |
| `nimbus-index-body-depth` | Item bodies and connector index depth; `nimbus index rebody` |
| `nimbus-cicd-data-layer` | DORA metrics, preflight checks, deployment annotation |
| `nimbus-data-warehouse-lineage` | Warehouse/BI connectors and the lineage graph |
| `nimbus-federation-identity` | Team federation (I17) + identity/SSO/SCIM (I18) |
| `nimbus-share-virality` | Outbound shares (I27/D21) |
| `nimbus-egress` | The egress ledger and `nimbus prove` (I29/D22) |
| `nimbus-agent-patterns` | Authoring a built-in read-only agent |
| `nimbus-implicit-knowledge-extraction` | Glossary + decisions pipelines |
| `nimbus-sandbox-and-extensions` | Sandbox (I15/D10), user MCP servers (I42), extension runtime (I43/I44) |
| `nimbus-mcp-sink` | The MCP server's write doors and the agent door (I28/I58, D32/D49), agent kits |
| `nimbus-connector-writes` | Connector write rows and every door to them: opt-in, the model door (I53), before-state, Wave 4 typed confirm, bound writes (I54) |
| `nimbus-incident-engine` | The incident engine IC1–IC10: item history, assembly, proposals, findings, runbooks (I57, D46) |
| `nimbus-standing-workflows` | Workflow steps and `when` guards, standing approval rules (I55, D44), scheduled workflows, approval learning |
