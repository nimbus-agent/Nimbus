# Nimbus — Gemini CLI Context

## Project Overview

Nimbus is a **local-first AI agent framework**: a headless Bun Gateway that maintains a private SQLite index of the user's data across ~80 cloud services (Google / Microsoft / GitHub / GitLab / Slack / Jira / Notion + observability, CI-CD, security-quality, feature-flags, GitOps, data-BI, deploy, finance, and support tools — full roster: `CONNECTOR_VAULT_SECRET_KEYS` in `packages/gateway/src/connectors/connector-secrets-manifest.ts`), optional `[[filesystem.roots]]` indexing, and the local filesystem via first-party MCP (Model Context Protocol) connectors, and executes multi-step agentic workflows on the user's behalf. Clients (CLI, Tauri 2.0 desktop) talk to the Gateway only over JSON-RPC 2.0 IPC.

**Runtime:** Bun v1.2+ / TypeScript 6.x strict · **Linter:** Biome · **License:** AGPL-3.0 (GNU Affero GPL; gateway/cli/mcp-connectors) + MIT (sdk)
**Status:** Phase 5 ✅ (2026-06-04) · Phase 6 (Team) 🚧 in progress — Slices 1–5 shipped (1 & 3: 2026-06-05; 2 & 4: 2026-06-07; 5: 2026-06-09); Slice 6a shipped 2026-06-11; Slice 6b shipped 2026-06-12; Slice 6c (tribal-knowledge extraction) shipped 2026-06-12; Slice 7 (Wave 7a — data-warehouse/BI connectors + cross-warehouse lineage) shipped 2026-06-13; invariants through I25; schema V40. Latest release `v0.6.1` (2026-06-13); `v0.1.0` was the first headless GA (2026-05-09; Gateway + CLI + VS Code extension; Tauri desktop deferred to Phase 13). Dated log: [`docs/CHANGELOG.md`](./docs/CHANGELOG.md). Status + acceptance criteria: [`docs/roadmap.md`](./docs/roadmap.md).

Companion file: [`CLAUDE.md`](./CLAUDE.md) is the canonical source; both must stay aligned when changing commands, roadmap rows, or non-negotiables.

---

## Non-Negotiables

Architectural constraints, not preferences. Do not suggest changes that violate them:

1. **Local-first** — machine is the source of truth; cloud is a connector.
2. **HITL (human-in-the-loop) is structural** — consent gate lives in the executor, not the prompt; cannot be bypassed or configured away.
3. **No plaintext credentials** — Vault only (Windows DPAPI / macOS Keychain / Linux libsecret); never in logs/IPC/config.
4. **MCP as connector standard** — the engine never calls cloud APIs directly.
5. **Platform equality** — Windows/macOS/Linux equally supported; PRs gate on Ubuntu (`pr-quality`), pushes run the full 3-OS matrix.
6. **AGPL-3.0 core / MIT SDK** — dual license is intentional; do not change license fields.
7. **No `any`** — use `unknown` for external data; TypeScript strict mode is non-negotiable.

---

## Security Invariants

Each invariant has a production wiring site + an enforcement test in `packages/gateway/src/security-invariants.test.ts`. **Full rationale, anti-patterns, and the triple rule (wiring + docs + test land in the same commit; retire = delete the row, never leave drift):** [`docs/SECURITY-INVARIANTS.md`](./docs/SECURITY-INVARIANTS.md) + the `nimbus-security-invariants` skill — read before adding/auditing any defense.

- **I1** — child-process env scoping via `extensionProcessEnv()` · `connectors/lazy-mesh/*` spawns
- **I2** — HITL frozen-set membership (`HITL_REQUIRED_BACKING` module-private) · `engine/executor.ts` `gate()`
- **I3** — HITL gate consults `action.type` only, never `payload.mcpToolId` · same
- **I4** — `hitlStatus` set only by the consent gate · same
- **I5** — `checkLanMethodAllowed` intrinsic to `LanServer` · `ipc/lan-server.ts`
- **I6** — LAN (local-network) bind defaults to `127.0.0.1` · `config/nimbus-toml.ts`
- **I7** — Tauri `ALLOWED_METHODS` excludes RCE-class (remote-code-execution) methods · `ui/src-tauri/src/gateway_bridge.rs`
- **I8** — restrictive renderer CSP (no `unsafe-inline`/`unsafe-eval`) · `ui/src-tauri/tauri.conf.json`
- **I9** — bound-param SQL; identifiers via `escapeIdentifier` · `db/write.ts`, `db/repair.ts`, `people/person-store.ts`
- **I10** — constant-time compare for hashes/MACs/pairing-codes/tokens · `util/timing-safe-compare.ts` (canonical)
- **I11** — LLM-facing results via `wrapToolOutput` · `engine/agent.ts`, `engine/tool-output-envelope.ts`
- **I12** — DPAPI passes `pOptionalEntropy` from `<configDir>/vault/.entropy` · `vault/win32.ts`
- **I13** — HTTP writes via `WRITE_ROUTE_ALLOWLIST` + bearer auth · `ipc/http-server.ts`, `ipc/http-write-routes.ts`
- **I14** — SQLite writes via `dbRun`/`dbExec`/`dbStmtRun` (static D12) · `db/write.ts`
- **I15** — every lazy-mesh `ServerSpec` via `wrapServerSpec()` → sandbox (static D10) · `connectors/lazy-mesh/*`
- **I16** — Ed25519 signature verify at install + every startup for `publisher` extensions · `extensions/{install-from-local,verify-extensions}.ts`
- **I17** — federated answering only in `query-gate.ts` (grant+role+consent+namespace filter, leak-proof shape; static D13) · `federation/query-gate.ts`
- **I18** — IdP token validation only in `identity/verifier.ts`; raw tokens Vault-only; federation consults `isOperatorValid()` (static D14) · `identity/verifier.ts`
- **I19** — team-vault secrets consumed only via `invoke-gate.ts` (`answerFederatedInvoke`) → ephemeral team-credentialed connector; leak-proof result, fail-closed on missing secret (static D15) · `federation/invoke-gate.ts`, `teamvault/team-tool-invoke.ts`
- **I20** — a delegated HITL approval is honored only from a live, in-scope, identity-valid delegate; else fall back to the local owner · `engine/delegated-approval.ts`
- **I21** — quorum counts only DISTINCT authenticated peers (deny aborts, fail-closed) · `engine/quorum/quorum-coordinator.ts`
- **I22** — signature-verified org policy + monotonic-stricter resolution (tighten-only; fail-closed to last-valid/baseline); enforcement reads `EnforcedPolicy`, never raw policy TOML (static D16) · `policy/policy-gate.ts`
- **I23** — ChatOps operational (non-HITL) posts go only through `chatops/reply-dispatcher.ts` to a server-derived `ReplyTarget` (originating channel or a policy `notify` channel); destination is never caller-supplied. Arbitrary-destination posting remains only via the HITL-gated `*.message.post` action types (static D17) · `chatops/reply-dispatcher.ts`
- **I24** — a federated preflight (action) request executes only behind the LOCAL owner's HITL gate, never on the caller's say-so; the command is resolved from local config only (fail-closed if missing) and runs sandboxed with validated params as env (static D18) · `federation/preflight-gate.ts`
- **I25** — a tribal-knowledge KB capture writes only to the config-pinned destination (`[tribal.notion]`/`[tribal.confluence]`), behind the LOCAL owner's HITL gate; the caller supplies at most a `--target` selector, never the destination; the `notion_kb_append`/`confluence_kb_append` tool ids are confined to the write-gate + connector sites (static D19) · `tribal/tribal-write-gate.ts`

**Static complement:** `scripts/structure-audit/check-nimbus-invariants.ts` runs before the test suite (fails first; runtime tests stay authoritative). It enforces I1, the vault-key allow-list, I14 (D12), I15 (D10), I17 (D13), I18 (D14), I19 (D15), I22 (D16), I23 (D17), I24 (D18), I25 (D19) at static time.

---

## Subsystems (monorepo)

- `packages/gateway` — Engine, MCP mesh, Vault, local index, IPC
- `packages/cli` — Terminal client (CLI + Ink TUI)
- `packages/ui` — Tauri 2.0 + React (desktop)
- `packages/sdk` — `@nimbus-dev/sdk` for extensions (MIT)
- `packages/client` — `@nimbus-dev/client` typed IPC wrapper (MIT)
- `packages/mcp-connectors/*` — first-party MCP servers (AGPL)
- `packages/vscode-extension` — `nimbus-vscode` (Marketplace + Open VSX)
- `packages/docs` — Astro Starlight documentation site

**PAL:** OS-specific logic lives under `packages/gateway/src/platform/`, accessed via `PlatformServices` — never import `win32`/`darwin`/`linux` from business logic.

**Dependency rules:** `gateway` imports nothing from cli/ui. `cli` and `ui` reach the gateway IPC-only (no source imports). `sdk` imports nothing from gateway/cli/ui. `mcp-connectors/*` depend on `@nimbus-dev/sdk` only. Circular dependencies are forbidden.

**Prerequisites:** Bun v1.2+; Rust for the Tauri UI. Local `nimbus ask` can run through Ollama on `http://127.0.0.1:11434` with `[llm].prefer_local = true` + `[llm].local_model`.

---

## Testing Philosophy

- **HITL tests** prove the gate fires for every whitelisted action type before the connector is called.
- **Vault tests** prove no secret value escapes through any interface.
- **Integration tests** use real SQLite + real Bun subprocesses + fresh temp dirs — no mocks at the DB layer.
- **E2E CLI tests** use a real Gateway subprocess + mock MCP servers — no real cloud calls.
- **Coverage gates** in CI: Engine ≥85%, Vault ≥90%, Embedding ≥80%, plus scheduler/rate-limiter/people (see `_test-suite.yml` + `nimbus-commands` skill).
- Focus on the current phase; do not add Phase N+1 features in Phase N code.

PRs gate on Ubuntu (`pr-quality`); pushes run the full Windows/macOS/Linux matrix.

---

## Development Workflow

- **Worktrees:** `.claude/worktrees/<branch-name>` (project-local, git-ignored).
- **Pre-flight before a PR:** `bun run preflight` (full CI parity) or `bun run preflight:fast` (~2-3 min, cheap static gates). **`test:ci` is only the test suite, NOT the full gate set — `preflight` is.** Gate manifest: `scripts/lib/preflight-gates.ts` (drift test fails if a CI gate is missing). See the `nimbus-preflight` skill.
- **Branch hygiene:** never commit on `main`/`develop` — `git switch -c dev/<you>/<topic>` and verify `git rev-parse --abbrev-ref HEAD` first. `bun run hooks:install` adds a pre-commit guard + pre-push `preflight:fast`.
- **Cross-platform:** build paths with `path.join()` / `os.tmpdir()`, never hardcoded separators; `bun run audit:cross-platform` flags Windows-separator path assertions (escape hatch: `// cross-platform-ok`).
- **CI-Linux-only failures — reproduce, don't guess:** CI is Ubuntu + `bun-version: latest`. Some failures never reproduce on Windows/macOS and aren't version-related — chiefly `mock.module` contamination in the combined `bun test packages/cli/src` run (prefer **dependency injection (DI) over `mock.module`** for dispatcher-driven code) and `@types/*` hoisting conflicts. Reproduce on Linux (Docker `oven/bun:latest`, or WSL on a Linux-native copy — not `/mnt/c`) **before** pushing a fix. `audit:coverage-floor` is **CI-Linux-authoritative**. Details: `nimbus-preflight` skill.

Full command catalogue + coverage thresholds + env overrides: `nimbus-commands` skill. File-location pointers: `nimbus-file-map` skill.

---

## See Also

- [`docs/architecture.md`](./docs/architecture.md) — subsystem design, IPC method catalogue, schema reference. Read before modifying any subsystem.
- [`docs/roadmap.md`](./docs/roadmap.md) — phases, acceptance criteria, delivered summaries.
- [`docs/SECURITY-INVARIANTS.md`](./docs/SECURITY-INVARIANTS.md) — I1–I25 rationale + anti-patterns.
- [`docs/cli-reference.md`](./docs/cli-reference.md) — full CLI subcommand reference.
- `.claude/commands/nimbus-*.md` — domain skills, loaded on demand via `view_file` (full trigger descriptions in the Skill References table below): `nimbus-architecture`, `nimbus-file-map`, `nimbus-commands`, `nimbus-ipc`, `nimbus-testing`, `nimbus-preflight`, `nimbus-security-invariants`, `nimbus-tauri-allowlist`, `nimbus-http-write-surface`, `nimbus-tool-output-envelope`, `nimbus-connector-authoring`, `nimbus-db-migrations`, `nimbus-embedding-routing`, `nimbus-cicd-data-layer`, `nimbus-data-warehouse-lineage`, `nimbus-federation-identity`, `nimbus-agent-patterns`.

---

## Skill References

Domain skills live in `.claude/commands/nimbus-*.md`, **loaded on demand** via the Skill tool (or `/<name>`) — each carries a `description` that drives when it triggers.

| Skill | Use when… |
| --- | --- |
| `nimbus-architecture` | Placing/naming new code, package ownership, IPC design — read first for any Gateway-touching task |
| `nimbus-file-map` | "Where does X live?" — pointer index to high-traffic files |
| `nimbus-commands` | bun scripts, CLI subcommands, coverage-gate names, env overrides, `bun add` safety |
| `nimbus-ipc` | Adding/designing an IPC method, notification, or streaming contract; Tauri-exposure check |
| `nimbus-testing` | Choosing a test layer, file location, coverage gate, or mocking the Gateway |
| `nimbus-preflight` | What to run before pushing; why `test:ci` ≠ full gate set; cross-platform/CI gates |
| `nimbus-security-invariants` | Adding/auditing a structural defense (the wiring + docs + test triple rule) |
| `nimbus-tauri-allowlist` | Exposing a method to the renderer (`ALLOWED_METHODS`, I7) |
| `nimbus-http-write-surface` | Adding an HTTP `POST`/`PUT`/`DELETE` route (`WRITE_ROUTE_ALLOWLIST`, I13) |
| `nimbus-tool-output-envelope` | Feeding tool results to the LLM (`wrapToolOutput`, I11) |
| `nimbus-connector-authoring` | Building/modifying a first-party MCP connector |
| `nimbus-db-migrations` | Authoring a SQLite migration or new table |
| `nimbus-embedding-routing` | Embedding-table routing for a new item type; `nimbus index reembed` |
| `nimbus-cicd-data-layer` | DORA metrics, preflight checks, deployment annotation (Phase 5 T4) |
| `nimbus-data-warehouse-lineage` | Authoring/extending a data-warehouse or BI connector + the cross-warehouse lineage graph (Phase 6 Slice 7); no-row-data contract, V40 lineage edges, `normalizeDataModelKey` |
| `nimbus-federation-identity` | Phase 6 Team federation (I17 query gate, namespaces/RBAC, pairing/discovery) + identity/SSO/SCIM (I18, OIDC device-code, SCIM-on-I13); touching `gateway/src/{federation,identity}/` |
| `nimbus-agent-patterns` | Authoring a built-in read-only agent |
