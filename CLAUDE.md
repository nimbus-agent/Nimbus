# Nimbus — Claude Code Context

## Project Overview

Nimbus is a **local-first AI agent framework** — a headless Bun Gateway process that maintains a private SQLite index of the user's data across cloud services (Google Drive, Gmail, Google Photos, OneDrive, Outlook, Microsoft Teams, GitHub, GitLab, Bitbucket, Slack, Linear, Jira, Notion, Confluence, Discord opt-in, Jenkins, GitHub Actions, CircleCI, GitLab CI, PagerDuty, Kubernetes, AWS, Azure, GCP, IaC CLIs, Grafana, Sentry, New Relic, Datadog, Zoom, plus the Phase 5 wave — security/quality (Snyk, SonarQube, Semgrep, Wiz), feature flags (LaunchDarkly, Flagsmith), GitOps (ArgoCD, Flux), data/BI (dbt, Metabase, Superset, Databricks, MLflow), deploy platforms (Vercel, Netlify), finance/SaaS (Stripe, Mercury), and productivity/support (Obsidian, Readwise, Raindrop, Intercom, Zendesk, Lever, Greenhouse, Pipedrive, Stack Overflow) — optional `[[filesystem.roots]]` indexing, and the local filesystem via first-party MCP connectors; the full roster is `CONNECTOR_VAULT_SECRET_KEYS` in `packages/gateway/src/connectors/connector-secrets-manifest.ts`) and executes multi-step agentic workflows on their behalf. Clients (CLI and Tauri 2.0 desktop app) communicate with the Gateway exclusively over JSON-RPC 2.0 IPC.

**Runtime:** Bun v1.2+ / TypeScript 6.x strict
**Linter:** Biome
**License:** AGPL-3.0 (gateway/cli/mcp-connectors) + MIT (sdk)
**Status:** Phase 4 ✅ Complete · Phase 5 (Extended Surface) ✅ Complete (2026-06-04) — T1–T6 ✅ · Wave A ✅ · Wave B ✅ · Tiers 1–5 ✅ (remaining connectors are documented non-gating deferrals; see [`docs/roadmap.md`](./docs/roadmap.md)). `v0.1.0` released 2026-05-09 (headless Gateway + CLI + VS Code extension; `desktop-v0.1.0` Tauri release deferred to Phase 13). Dated delivery log: [`docs/CHANGELOG.md`](./docs/CHANGELOG.md). Workstream-level status + acceptance criteria: [`docs/roadmap.md`](./docs/roadmap.md).

**Gemini CLI:** [`GEMINI.md`](./GEMINI.md) mirrors this file for the same repository — update both when changing commands, roadmap rows, or non-negotiables.

---

## Non-Negotiables

These constraints are architectural, not preferences. Do not suggest changes that violate them:

| #   | Constraint                    | Implementation                                                                                                |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | **Local-first**               | Machine is the source of truth; cloud is a connector                                                          |
| 2   | **HITL is structural**        | Consent gate is in the executor, not the prompt; cannot be bypassed or configured away                        |
| 3   | **No plaintext credentials**  | Vault only (DPAPI/Keychain/libsecret); never in logs/IPC/config                                               |
| 4   | **MCP as connector standard** | Engine never calls cloud APIs directly                                                                        |
| 5   | **Platform equality**         | Windows/macOS/Linux are equally supported; PRs gate on Ubuntu (`pr-quality`); pushes run the full 3-OS matrix |
| 6   | **AGPL-3.0 core / MIT SDK**   | Dual license is intentional; do not change license fields                                                     |
| 7   | **No `any`**                  | Use `unknown` for external data; TypeScript strict mode is non-negotiable                                     |

---

## Security Invariants

Each invariant has a production wiring site and an enforcement test in `packages/gateway/src/security-invariants.test.ts`. Full rationale, anti-patterns, and audit cross-references in [`docs/SECURITY-INVARIANTS.md`](./docs/SECURITY-INVARIANTS.md).

| #   | Invariant                                                                                  | Wired at                                                                                                         | Anti-pattern that regresses it                                                       |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| I1  | Child-process env scoping via `extensionProcessEnv()`                                      | `connectors/lazy-mesh/` (every spawn across `mesh.ts`, `connector-spawns.ts`, `phase3-config.ts`, `user-mcp.ts`) | `spawn(..., { env: { ...process.env } })` anywhere under `connectors/`               |
| I2  | HITL frozen-set membership; `HITL_REQUIRED_BACKING` is module-private                      | `engine/executor.ts` `ToolExecutor.gate()`                                                                       | New destructive RPC that skips `ToolExecutor` or omits the action type from the set  |
| I3  | HITL gate consults `action.type` only (NOT `payload.mcpToolId`)                            | `engine/executor.ts` `ToolExecutor.gate()`                                                                       | Gating on `mcpToolId` or `resolvedToolId` — the set holds logical types, not MCP ids |
| I4  | `hitlStatus` is set only by the consent gate                                               | `engine/executor.ts` `ToolExecutor.gate()`                                                                       | Hardcoding `hitlStatus: "approved"` in any handler                                   |
| I5  | `checkLanMethodAllowed` is intrinsic to `LanServer`                                        | `ipc/lan-server.ts` `LanServer.handleEncryptedMessage()`                                                         | Moving the check into the dispatcher or any caller                                   |
| I6  | LAN bind defaults to `127.0.0.1`                                                           | `config/nimbus-toml.ts`                                                                                          | Defaulting to `0.0.0.0` or auto-binding all interfaces from an env var               |
| I7  | Tauri `ALLOWED_METHODS` matches gateway handlers; no RCE-class methods exposed to renderer | `ui/src-tauri/src/gateway_bridge.rs`                                                                             | Adding `extension.install` / `connector.addMcp` to the renderer allowlist            |
| I8  | Tauri renderer CSP is restrictive (no `unsafe-inline`, no `unsafe-eval`)                   | `ui/src-tauri/tauri.conf.json`                                                                                   | `"csp": null` or loosening with `unsafe-*`                                           |
| I9  | All SQL uses bound parameters; identifiers go through `escapeIdentifier`                   | `db/write.ts`, `db/repair.ts`, `people/person-store.ts`                                                          | Template-literal SQL on caller-supplied data                                         |
| I10 | Constant-time compare for hashes / MACs / pairing codes / bearer tokens                   | `util/timing-safe-compare.ts` (canonical) — `sha256HexEqualConstantTime` consumed by `extensions/verify-extensions.ts` + `updater/updater.ts`; `constantTimeStringEqual` consumed by `ipc/lan-pairing.ts` + `ipc/http-auth.ts` | `===` / `!==` on hash bytes; redefining a local `timingSafeEqual` / `constantTimeStringEqual` outside `util/timing-safe-compare.ts` |
| I11 | LLM-facing tool results wrapped via `wrapToolOutput`                                       | `engine/agent.ts`, `engine/tool-output-envelope.ts`                                                              | New agent surface that feeds raw tool results to the LLM                             |
| I12 | DPAPI calls pass `pOptionalEntropy` from `<configDir>/vault/.entropy`                      | `vault/win32.ts`                                                                                                 | Dropping the entropy parameter "for compatibility"                                   |
| I13 | HTTP write routes go through `WRITE_ROUTE_ALLOWLIST` + bearer auth                         | `ipc/http-server.ts`, `ipc/http-write-routes.ts`                                                                 | New POST/PUT/DELETE handler that bypasses `dispatchWriteRoute` or opens a second writable DB outside the server context |
| I14 | All SQLite write paths route through `dbRun` / `dbExec` / `dbStmtRun`                      | `db/write.ts` (`dbRun`, `dbExec`, `dbStmtRun`); enforced statically by `D12` in `check-nimbus-invariants.ts`    | Direct `db.run(` or `db.exec(` outside `DB_RUN_EXEC_ALLOW_LIST` — swallows `SQLITE_FULL`                            |
| I15 | Sandbox runner intrinsic to every extension spawn — every lazy-mesh `ServerSpec` flows through `wrapServerSpec(...)` → `sandbox-wrapper.ts` → `runner.spawn(...)` | `connectors/lazy-mesh/{mesh.ts,connector-spawns.ts,phase3-config.ts,user-mcp.ts}` (call `wrapServerSpec`); `connectors/lazy-mesh/wrap-server-spec.ts` (defines `wrapServerSpec`); `platform/sandbox/sandbox-wrapper.ts` (calls `runner.spawn`); `platform/sandbox/sandbox-runner.ts` (defines `SandboxRunner` + dispatcher); enforced statically by `D10` in `check-nimbus-invariants.ts` | Constructing an MCPClient `ServerSpec` literal under `connectors/lazy-mesh/` without routing it through `wrapServerSpec(...)` — caught by both the runtime I15 test and the static `D10` rule |
| I16 | Every installed extension with a `publisher` field has its Ed25519 signature verified at install AND every Gateway startup before it spawns | `extensions/install-from-local.ts` `completeExtensionInstallAfterCopy` (install-time verify + audit); `extensions/verify-extensions.ts` `verifyExtensionsBestEffort` signature pass (startup verify + hard-disable via `SignatureDisabledRegistry`); primitives in `@nimbus-dev/sdk` `crypto/verify-signature.ts` (MIT, license-clean for connector authors) | New install or startup path that skips `verifyManifestSignature(...)` for a manifest carrying `publisher`; calling `verifyExtensionsBestEffort` without `{ vault }`; storing the publisher pubkey outside the `extension.publisher_key.<id>` vault namespace |
| I17 | Federated answering is intrinsic to `query-gate.ts`; it is the only federation module that imports the item-list read path (`item-list-query`), enforces grant + role + consent + namespace filter, and returns the leak-proof `FederatedItem` shape; management methods are local/Tauri-only (enforced by `FORBIDDEN_OVER_LAN`) | `federation/query-gate.ts` `answerFederatedQuery`; LAN admittance in `ipc/lan-rpc.ts` `FORBIDDEN_OVER_LAN`; enforced statically by `D13` in `check-nimbus-invariants.ts` | A federation module other than `query-gate.ts` that imports `item-list-query` or reads index items to answer a peer, bypassing the gate's declared-filter / consent / audit |
| I18 | IdP ID-token validation is intrinsic to `identity/verifier.ts` (the only validator); raw tokens (`identity.oidc.*`, `identity.scim.bearer`) live only in the Vault — never on IPC/wire/logs/config; federated answering consults `isOperatorValid()` before answering | `identity/verifier.ts` + `federation/query-gate.ts` consult; static `D14` in `check-nimbus-invariants.ts` | Validating an ID token outside `verifier.ts`; a token field on an IPC/wire shape; reading `identity.oidc.*`/`identity.scim.bearer` outside `identity/`; a federation answer path skipping the `isOperatorValid()` consult when identity is enabled |

When changing a wiring site, update both the test and `SECURITY-INVARIANTS.md` in the same commit. When retiring an invariant, delete the row — never leave it as documentation drift.

**Static-time complement:** `scripts/structure-audit/check-nimbus-invariants.ts` enforces I1 (`spawn` under `connectors/` must use `extensionProcessEnv()`), the vault-key allow-list, I14 (`DB_RUN_EXEC_ALLOW_LIST` — direct `db.run`/`db.exec` outside `db/write.ts` exits 1), I15 (`D10` — every `ServerSpec` under `connectors/lazy-mesh/` must pass through `wrapServerSpec(...)`), I17 (`D13` — only `federation/query-gate.ts` imports the item-list read path under `federation/`), and I18 (`D14` — the identity-token Vault-key literals appear only under `identity/`) at static time. Runtime tests remain authoritative; the static checks fail before the test suite runs.

---

## Subsystems (monorepo)

- `packages/gateway` — Engine, MCP mesh, Vault, local index, IPC
- `packages/cli` — Terminal client (CLI + Ink TUI)
- `packages/ui` — Tauri 2.0 + React (desktop)
- `packages/sdk` — `@nimbus-dev/sdk` for extensions (MIT)
- `packages/client` — `@nimbus-dev/client` (typed IPC wrapper, MIT)
- `packages/mcp-connectors/*` — First-party MCP servers (AGPL)
- `packages/vscode-extension` — `nimbus-vscode` (Marketplace + Open VSX)
- `packages/docs` — Astro Starlight documentation site

**PAL:** All OS-specific logic lives under `packages/gateway/src/platform/` and is accessed via `PlatformServices` — never import `win32` / `darwin` / `linux` from business logic.

**Prerequisites:** Bun v1.2+; Rust for building the Tauri UI (`packages/ui/src-tauri`). Local `nimbus ask` can run through Ollama on `http://127.0.0.1:11434` with `[llm].prefer_local = true` and `[llm].local_model` set to any pulled model name.

---

## Package Dependency Rules

```text
gateway    ← no imports from cli or ui
cli        ← IPC-only communication with gateway (no source imports)
ui         ← IPC-only communication with gateway (no source imports)
sdk        ← no imports from gateway, cli, or ui
mcp-connectors/*  ← depend on @nimbus-dev/sdk only
```

Circular dependencies are forbidden. The CLI and UI never import Gateway TypeScript.

---

## Testing Philosophy

- **HITL tests** prove the gate fires for every action type in the whitelist, before the connector is called.
- **Vault tests** prove no secret value is exposed through any interface.
- **Integration tests** use real SQLite, real Bun subprocesses, fresh temp dirs per test — no mocks at the DB layer.
- **E2E CLI tests** use a real Gateway subprocess + mock MCP servers — no real cloud calls.
- **Coverage gates** are enforced in CI (Engine ≥85%, Vault ≥90%, Embedding ≥80%, plus scheduler/rate-limiter/people thresholds — see `.github/workflows/_test-suite.yml` and the `nimbus-commands` skill).

PRs gate on Ubuntu (`pr-quality`); pushes run the full Windows / macOS / Linux matrix.

When implementing, focus on the current phase. Do not add Phase N+1 features in Phase N code.

---

## Development Workflow

**Worktree directory:** `.worktrees/` (project-local, git-ignored). When setting up isolated workspaces for feature branches, use `.worktrees/<branch-name>`.

**Pre-flight before pushing a PR:** `bun run preflight` (full local CI parity — every gate CI runs) or `bun run preflight:fast` (~2-3 min, all the cheap static gates). **`bun run test:ci` is only the test suite — it is NOT the full gate set; `preflight` is.** The gate manifest lives in `scripts/lib/preflight-gates.ts`; a drift test (`scripts/preflight.test.ts`) fails if a CI gate is missing from it. See the [`nimbus-preflight`](./.claude/commands/nimbus-preflight.md) skill.

**Branch hygiene:** never commit on `main` / `develop` — branch first (`git switch -c dev/<you>/<topic>`) and verify `git rev-parse --abbrev-ref HEAD` before committing. `bun run hooks:install` installs a pre-commit guard that enforces this and a pre-push `preflight:fast`.

**Cross-platform:** build paths with `path.join()` / `os.tmpdir()`, never hardcoded separators — `bun run audit:cross-platform` flags hardcoded Windows-separator path assertions (backslash / drive-letter / UNC) in tests, the Windows-dev → Ubuntu-CI footgun (escape hatch: `// cross-platform-ok`).

**Reproducing CI-Linux-only failures (don't guess — reproduce):** CI runs on Ubuntu with `bun-version: latest`. Some failures never reproduce on local Windows/macOS and are *not* version-related — e.g. `mock.module` contamination in the combined per-package `bun test packages/cli/src` run (a sibling's `mock.restore()` clears another file's process-global mock; prefer **dependency injection over `mock.module`** for anything driven through a dispatcher), and `@types/*` hoisting differences (e.g. a package with no `compilerOptions.types` auto-includes the root `@types/bun`, which conflicts with `@types/node`). When a gate is red on CI but green on Windows, reproduce on Linux **before** pushing a speculative fix:

```bash
# Match CI's bun first:  bun upgrade   (CI uses latest)
docker run --rm -v "$PWD":/src:ro oven/bun:latest bash -lc \
  'mkdir -p /app && (cd /src && tar --exclude=node_modules --exclude=.git -cf - .) | (cd /app && tar -xf -) \
   && cd /app && bun install && cd packages/cli && bun test src/'
```

WSL Ubuntu works too (`curl -fsSL https://bun.sh/install | bash`, then run from a Linux-native copy — not `/mnt/c`, whose `node_modules` are Windows binaries). The coverage floor (`audit:coverage-floor`) is **CI-Linux-authoritative**: a file can read ≥80% on Windows yet `<80%` on Linux if its tests flake in the combined run.

Full command catalogue + coverage thresholds + env-var overrides live in the [`nimbus-commands`](./.claude/commands/nimbus-commands.md) skill. File-location pointers live in [`nimbus-file-map`](./.claude/commands/nimbus-file-map.md).

---

## See Also

- [`docs/architecture.md`](./docs/architecture.md) — full subsystem design, IPC method catalogue, schema reference. Read before modifying any subsystem.
- [`docs/roadmap.md`](./docs/roadmap.md) — phases, acceptance criteria, delivered summaries.
- [`docs/SECURITY-INVARIANTS.md`](./docs/SECURITY-INVARIANTS.md) — I1–I18 rationale + anti-patterns.
- [`docs/cli-reference.md`](./docs/cli-reference.md) — full CLI subcommand reference.

---

## Skill References

Domain skills live in `.claude/commands/nimbus-*.md`. They are **loaded on demand** — invoke via the Skill tool (or `/<name>`) when working on the relevant subsystem, rather than force-loaded into every session. Each carries a `description` that drives when it triggers.

| Skill | Use when… |
| --- | --- |
| `nimbus-architecture` | Placing new code, naming, package ownership, IPC design — read first for any Gateway-touching task |
| `nimbus-file-map` | "Where does X live?" — pointer index to high-traffic files |
| `nimbus-commands` | bun scripts, CLI subcommands, coverage-gate names, env-var overrides, `bun add` safety |
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
| `nimbus-agent-patterns` | Authoring a built-in read-only agent |
