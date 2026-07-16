---
name: nimbus-architecture
description: >
  Authoritative reference for the Nimbus codebase: subsystem responsibilities, package
  layout, IPC conventions, non-negotiable design rules, and where to put new code. Use
  when writing a feature, adding a file, designing an IPC method, wiring a connector,
  working with the engine/HITL/Vault, naming/placing code, deciding package ownership, or
  planning anything that touches the Gateway. Read first when in doubt — it prevents
  putting code in the wrong place and violating load-bearing architectural constraints.
---

# Nimbus Architecture Reference

## Non-Negotiables (PRs violating these are rejected)

These are **load-bearing constraints**, not style preferences. Check every new feature against all six:

1. **Local-first** — machine is the source of truth; cloud is a connector. No user data or credentials leave the machine without explicit user action.
2. **HITL is structural** — the consent gate lives in the executor (`packages/gateway/src/engine/executor.ts`) as a compile-time constant set (`HITL_REQUIRED`). It is NOT a prompt instruction, NOT runtime-configurable, and has NO timeout. The audit log is written **before** the connector is called.
3. **No plaintext credentials** — Vault only. Never in logs, IPC responses, config files, or env vars persisted outside spawn context. The structured logger auto-redacts `*.token`, `*.secret`, `oauth.*`.
4. **MCP as connector standard** — the Engine never calls cloud APIs directly. Every integration is an MCP server. Engine ↔ connector boundary is always MCP.
5. **Platform equality** — Windows 10+, macOS 13+, Ubuntu 22.04+ are equally supported in every change.
6. **No feature creep across phases** — do not implement Phase N+1 features while Phase N is active. **Phase 6 (Team)** is ✅ complete (2026-06-18 — all 9 slices: federation, team-vault/quorum, identity/SSO/SCIM, org policy, ChatOps, cross-colleague agents, data-warehouse/BI + lineage, Share & Virality, and the deferred-Phase-5 items); **Phase 7 (Engineering Excellence)** is the next phase. Phase 5 (The Extended Surface) is ✅ complete. See [docs/CHANGELOG.md](../../docs/CHANGELOG.md) for the dated delivery log.

---

## Monorepo Layout

```
nimbus/
├── packages/
│   ├── gateway/          ← Core headless process (Bun runtime)
│   ├── cli/              ← nimbus CLI + TUI (Bun)
│   ├── ui/               ← Tauri 2.0 desktop app (React 18 + Rust bridge)
│   ├── sdk/              ← @nimbus-dev/sdk      (npm, MIT — published)
│   ├── mcp-connectors/   ← First-party MCP servers (one dir per connector)
│   └── docs/             ← Astro Starlight documentation site
├── docs/                 ← Project docs (architecture.md, roadmap.md, etc.)
└── .github/workflows/    ← ci.yml, security.yml, codeql.yml, release.yml
```

`@nimbus-dev/client` — the typed IPC wrapper `packages/cli` and the VS Code extension consume — lives in its own repo, [nimbus-agent/nimbus-client](https://github.com/nimbus-agent/nimbus-client) (npm, MIT), not under `packages/`.

---

## Package Deep-Dives

### `packages/gateway/src/` — The Core

| Directory | Owns |
|---|---|
| `platform/` | Platform Abstraction Layer — `PlatformServices` interface + `win32`, `darwin`, `linux` impls |
| `engine/` | Mastra agent, router, planner, HITL executor, coordinator, sub-agents |
| `vault/` | `NimbusVault` interface + DPAPI / Keychain / libsecret impls |
| `db/` | SQLite schema, migrations, verify/repair/snapshot, health, latency ring buffer |
| `connectors/` | Connector registry, lazy mesh, health model, health history |
| `sync/` | Delta sync scheduler, connectivity probe, rate limiter |
| `extensions/` | Extension Registry, manifest validator, sandbox |
| `telemetry/` | Opt-in aggregate telemetry collector |
| `config/` | TOML config loader, profiles, env-var overrides |
| `ipc/` | JSON-RPC 2.0 server, HTTP API, Prometheus endpoint, LAN server |
| `llm/` | Ollama provider, llama.cpp provider, LLM router, GPU arbiter *(Phase 4)* |
| `voice/` | STT (Whisper.cpp), TTS, wake-word *(Phase 4)* |

**Key files to know:**
- `engine/executor.ts` — HITL gate lives here. Touch carefully.
- `ipc/<namespace>-rpc.ts` — one file per IPC namespace (e.g. `federation-rpc.ts`, `connector-rpc.ts`, `llm-rpc.ts`); each exports a `dispatch<Namespace>Rpc` wired into `ipc/server/dispatchers.ts`
- `db/schema.ts` (or migrations/) — all SQLite schema changes go through migrations, never manual ALTER

### `packages/cli/src/`

- `commands/` — one file per CLI subcommand (54 top-level commands registered in `COMMAND_HANDLERS`, `packages/cli/src/index.ts` — verify the live map rather than this count): `start`, `stop`, `status`, `db`, `diag`, `query`, `telemetry`, `tui`, `update`, `doctor`, `config`, `profile`, `serve`, `test`, `ask`, `catchup`, `expert`, `impact`, `index`, `vault`, `audit`, `connector`, `data`, `deploy`, `extension`, `people`, `search`, `security`, `session`, `workflow`, `watch`, `repl`, `run`, `scaffold`, `lan`, `llm`, `metrics`, `team`, `identity`, `scim`, `policy`, `chatops`, `admin`, `mcp-server`, `ghost`, `conflicts`, `huddle`, `janitor`, `preflight`, `tribal`, `share`, `verify-share`, `prove`, `egress`. (`bench` is dispatched in a separate branch; there is no `docs` command.)
- `tui/` — Ink-based TUI components (Phase 4): `App.tsx`, `QueryInput.tsx`, `ConnectorHealth.tsx`, `WatcherPane.tsx`, `SubTaskPane.tsx`

### `packages/ui/src/` (Tauri desktop — Phase 4)

- `pages/` — `Dashboard.tsx`, `Search.tsx`, `Marketplace.tsx`, `Settings.tsx`, `Watchers.tsx`, `Workflows.tsx`
- `components/` — `ConsentDialog.tsx` (HITL UI), `ExtensionMarketplace.tsx`, etc.
- `ipc/client.ts` — frontend JSON-RPC client (never opens the socket directly — goes through Rust bridge)
- `src-tauri/src/gateway_bridge.rs` — thin Rust bridge; enforces `ALLOWED_METHODS` allowlist

---

## IPC Conventions (JSON-RPC 2.0)

**Method naming:** `namespace.methodName` — camelCase method, dot-separated namespace.

| Namespace | Owns |
|---|---|
| `engine.*` | `ask`, `askStream`, `getSubTaskPlan` |
| `agent.*` | `subTaskProgress` (notification), `hitlBatch` (notification), `gasLimitReached` (notification) |
| `connector.*` | `list`, `history`, `healthChanged` (notification) |
| `llm.*` | `listModels`, `pullModel`, `loadModel`, `unloadModel`, `setDefault`, `getRouterStatus`, `listLocalModels` |
| `watcher.*` | `list`, `create`, `update`, `delete`, `history` |
| `workflow.*` | `list`, `create`, `update`, `delete`, `run`, `history`, `rerun` |
| `index.*` | queries — read-only, available to LAN peers |
| `status.*` | health, diagnostics — read-only |
| `vault.*` | sensitive — NOT in the Tauri UI allowlist |
| `db.*` | internal — NOT in the Tauri UI allowlist |
| `federation.*` | federated query/invoke/quorum/approval — LAN-answerable, HITL-gated (`I17`/`I19`) |
| `identity.*` | OIDC SSO login/status/bindings (`I18`) |
| `scim.*` | SCIM v2 provisioning (on the `I13` HTTP write surface) |
| `teamvault.*` | team-vault put/grant/delegate (`I19`) |
| `policy.*` | org-policy distribution/enforcement (`I22`) |
| `chatops.*` | ChatOps bot operational replies (`I23`) |
| `agents.*` | `expert`, `impact`, cross-colleague briefs (`briefReady` notifications) |
| `share.*` | outbound share create/list/prune/verify (`I27`) — NOT in the Tauri UI allowlist for emit methods |

**Notifications vs responses:** Streaming/async events are **notifications** (no `id`, no response expected). Methods that return immediately with a handle and then stream progress (e.g. `engine.askStream` → `engine.streamToken` / `engine.streamDone`) follow this pattern:
```
→ engine.askStream({ prompt }) : { streamId }
← engine.streamToken { streamId, token }   (notification, N times)
← engine.streamDone  { streamId, result }  (notification, once)
← engine.streamError { streamId, error }   (notification, on failure)
```

**Adding a new IPC method:**
1. Add handler in `packages/gateway/src/ipc/<namespace>-rpc.ts` (create the file if it doesn't exist), exporting a `dispatch<Namespace>Rpc` function (built via the `dispatchByMethod` helper) that returns an `RpcMissOrHit` discriminated union — `{ kind: "hit", value }` on a match, `{ kind: "miss" }` otherwise
2. Wire it into the dispatcher chain in `packages/gateway/src/ipc/server/dispatchers.ts`
3. If it should be callable from the Tauri UI, add it to `ALLOWED_METHODS` in `gateway_bridge.rs`
4. Write a unit test in `packages/gateway/test/unit/ipc/`

---

## HITL Rules

When writing any feature that performs a write, outgoing, or irreversible action:

- The tool **must** be in the `HITL_REQUIRED` frozen set in `executor.ts`
- This is not optional and cannot be bypassed via config
- The audit log entry is written **before** the action executes
- For multi-agent flows: HITL actions are consolidated into `agent.hitlBatch` — sub-agents do not get individual consent; the coordinator surfaces one consolidated request
- Partial approval is supported: rejected actions mark dependent sub-tasks as `skipped`, not `failed`

---

## Vault Usage

```ts
// ✅ Correct — always use NimbusVault
await vault.set('github.pat', token);
const pat = await vault.get('github.pat');

// ❌ Wrong — never write credentials anywhere else
fs.writeFileSync('config.json', JSON.stringify({ token }));
process.env.GITHUB_TOKEN = token;
```

The Vault implementation is platform-specific (`win32.ts` / `darwin.ts` / `linux.ts`). Never add a fourth branch — extend the `NimbusVault` interface instead.

---

## Connector / MCP Pattern

Every connector lives in `packages/mcp-connectors/<service>/`. It:
- Is a standalone MCP server process
- Receives credentials via scoped environment injection at spawn time (not from IPC or config files)
- Declares `hitlRequired: true` in its manifest for any write tool (which auto-adds those tools to the HITL gate)
- Has its manifest SHA-256 hash verified on every Gateway startup

The Engine calls connectors through the MCP tool interface only. No connector imports are allowed inside `packages/gateway/src/engine/`.

**Connector quickstart:**
```bash
nimbus scaffold <service-name>
# → generates packages/mcp-connectors/<service-name>/ with typed scaffolding
```
Full walkthrough: `docs/contributors/extension-author-walkthrough.md`

---

## Where to Put New Code

| What you're building | Where it goes |
|---|---|
| New CLI subcommand | `packages/cli/src/commands/<name>.ts` |
| New IPC method | `packages/gateway/src/ipc/<namespace>-rpc.ts` |
| New connector | `packages/mcp-connectors/<service>/` |
| New DB table / migration | `packages/gateway/src/db/migrations/` |
| New engine capability | `packages/gateway/src/engine/` |
| New Vault backend | `packages/gateway/src/vault/<platform>.ts` |
| New Tauri UI page | `packages/ui/src/pages/<Name>.tsx` |
| New TUI pane | `packages/cli/src/tui/<Name>.tsx` |
| New LLM provider | `packages/gateway/src/llm/<name>-provider.ts` |
| SDK export for extension authors | _(standalone repo)_ [nimbus-agent/nimbus-sdk](https://github.com/nimbus-agent/nimbus-sdk) — published as `@nimbus-dev/sdk` |

---

## Test Layer Quick Reference

| Layer | Tool | Location pattern |
|---|---|---|
| Unit | `bun test` | `packages/*/test/unit/**/*.test.ts` |
| Integration | `bun test` | `packages/*/test/integration/**/*.test.ts` |
| E2E CLI | `bun test` + Gateway subprocess | `packages/*/test/e2e/**/*.e2e.test.ts` |
| UI components | Vitest + Testing Library | `packages/ui/test/**/*.test.tsx` |
| E2E Desktop | Playwright + Tauri WebDriver | runs on push to `main` and release tags |

Coverage gates: Engine ≥ 85%, Vault ≥ 90%. New subsystems should target ≥ 85%.

Each test gets a fresh temp dir + fresh DB — never share state between tests.

---

## Platform Socket / Paths

| Platform | IPC Socket | Config Dir | Data Dir |
|---|---|---|---|
| Windows 10+ | `\\.\pipe\nimbus-gateway` | `%APPDATA%\Nimbus` | `%LOCALAPPDATA%\Nimbus\data` |
| macOS 13+ | `~/Library/Application Support/Nimbus/gateway.sock` | `~/Library/Application Support/Nimbus` | `~/Library/Application Support/Nimbus/data` |
| Ubuntu 22.04+ | `~/.local/share/nimbus/gateway.sock` | `~/.config/nimbus` | `~/.local/share/nimbus` |

Use `PlatformServices` from `packages/gateway/src/platform/` to resolve these — never hardcode paths.
