---
name: nimbus-architecture
description: >
  Authoritative reference for the Nimbus codebase: subsystem responsibilities, package layout,
  IPC conventions, non-negotiable design rules, and where to put new code. Use this skill
  whenever the user is writing a new feature, adding a new file, designing a new IPC method,
  wiring a new connector, working with the engine/HITL/Vault, or planning anything that touches
  the Gateway. Also trigger for questions like "where does X live?", "how should I name this?",
  "which package owns this?", or any task involving the Nimbus monorepo structure. When in doubt,
  read this skill first — it prevents putting code in the wrong place and violating load-bearing
  architectural constraints.
---

# Nimbus Architecture Reference

## Non-Negotiables (PRs violating these are rejected)

These are **load-bearing constraints**, not style preferences. Check every new feature against all six:

1. **Local-first** — machine is the source of truth; cloud is a connector. No user data or credentials leave the machine without explicit user action.
2. **HITL is structural** — the consent gate lives in the executor (`packages/gateway/src/engine/executor.ts`) as a compile-time constant set (`HITL_REQUIRED`). It is NOT a prompt instruction, NOT runtime-configurable, and has NO timeout. The audit log is written **before** the connector is called.
3. **No plaintext credentials** — Vault only. Never in logs, IPC responses, config files, or env vars persisted outside spawn context. The structured logger auto-redacts `*.token`, `*.secret`, `oauth.*`.
4. **MCP as connector standard** — the Engine never calls cloud APIs directly. Every integration is an MCP server. Engine ↔ connector boundary is always MCP.
5. **Platform equality** — Windows 10+, macOS 13+, Ubuntu 22.04+ are equally supported in every change.
6. **No feature creep across phases** — do not implement Phase N+1 features while Phase N is active. Current active phase: **Phase 5 (The Extended Surface)**. Phase 4 (Presence) is ✅ complete.

---

## Monorepo Layout

```
nimbus/
├── packages/
│   ├── gateway/          ← Core headless process (Bun runtime)
│   ├── cli/              ← nimbus CLI + TUI (Bun)
│   ├── ui/               ← Tauri 2.0 desktop app (React 18 + Rust bridge)
│   ├── client/           ← @nimbus-dev/client  (npm, MIT — published)
│   ├── sdk/              ← @nimbus-dev/sdk      (npm, MIT — published)
│   ├── mcp-connectors/   ← First-party MCP servers (one dir per connector)
│   └── docs/             ← Astro Starlight documentation site
├── docs/                 ← Project docs (architecture.md, roadmap.md, etc.)
└── .github/workflows/    ← ci.yml, security.yml, codeql.yml, release.yml
```

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
- `ipc/handlers/` — one file per IPC namespace (e.g. `engine.ts`, `connector.ts`, `llm.ts`)
- `db/schema.ts` (or migrations/) — all SQLite schema changes go through migrations, never manual ALTER

### `packages/cli/src/`

- `commands/` — one file per CLI subcommand (`ask`, `search`, `query`, `config`, `profile`, `diag`, `doctor`, `db`, `telemetry`, `connector`, `extension`, `workflow`, `status`, `audit`)
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

**Notifications vs responses:** Streaming/async events are **notifications** (no `id`, no response expected). Methods that return immediately with a handle and then stream progress (e.g. `engine.askStream` → `engine.streamToken` / `engine.streamDone`) follow this pattern:
```
→ engine.askStream({ prompt }) : { streamId }
← engine.streamToken { streamId, token }   (notification, N times)
← engine.streamDone  { streamId, result }  (notification, once)
← engine.streamError { streamId, error }   (notification, on failure)
```

**Adding a new IPC method:**
1. Add handler in `packages/gateway/src/ipc/handlers/<namespace>.ts`
2. Register it in the IPC server
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
| New IPC method | `packages/gateway/src/ipc/handlers/<namespace>.ts` |
| New connector | `packages/mcp-connectors/<service>/` |
| New DB table / migration | `packages/gateway/src/db/migrations/` |
| New engine capability | `packages/gateway/src/engine/` |
| New Vault backend | `packages/gateway/src/vault/<platform>.ts` |
| New Tauri UI page | `packages/ui/src/pages/<Name>.tsx` |
| New TUI pane | `packages/cli/src/tui/<Name>.tsx` |
| New LLM provider | `packages/gateway/src/llm/<name>-provider.ts` |
| SDK export for extension authors | `packages/sdk/src/` |

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
