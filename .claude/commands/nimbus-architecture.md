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
5. **Platform equality** — Windows 10+, macOS 13+, Ubuntu 22.04+ are equally supported in every change. (Ubuntu 22.04 is a source-build target only: the pre-built Linux binaries need glibc ≥ 2.39, i.e. Ubuntu 24.04+ — see `docs/cross-platform.md`.)
6. **No feature creep across phases** — do not implement Phase N+1 features while Phase N is active. **Phase 6 (Team)** is ✅ complete (2026-06-18 — all 9 slices: federation, team-vault/quorum, identity/SSO/SCIM, org policy, ChatOps, cross-colleague agents, data-warehouse/BI + lineage, Share & Virality, and the deferred-Phase-5 items); from Phase 7 onward the build order is the **Sequencing Spine overlay (S1 -> S5)**, not the phase numbers; **Spine S1 (Local Brain) is ✅ complete (2026-06-20 → 2026-08-20)** and the current build slot is **Spine S2 (Local Compute Fleet)**, opened 2026-08-21. Phase 5 (The Extended Surface) is ✅ complete. See [docs/CHANGELOG.md](../../docs/CHANGELOG.md) for the dated delivery log.

---

## Monorepo Layout

```
nimbus/
├── packages/
│   ├── gateway/          ← Core headless process (Bun runtime)
│   ├── cli/              ← nimbus CLI + TUI (Bun)
│   ├── ui/               ← Tauri 2.0 desktop app (React 19 + Rust bridge)
│   ├── admin-console/    ← dependency-free static admin console (Phase 6 Slice 4)
│   ├── github-actions/   ← Composite GitHub Actions (DORA data layer)
│   └── docs/             ← Astro Starlight documentation site
├── docs/                 ← Project docs (architecture.md, roadmap.md, etc.)
└── .github/workflows/    ← ci.yml, security.yml, codeql.yml, release.yml
```

`@nimbus-dev/sdk` (the extension-authoring contract the connectors consume) and `@nimbus-dev/client` (the typed IPC wrapper `packages/cli` and the VS Code extension consume) each live in their own repos — [nimbus-agent/nimbus-sdk](https://github.com/nimbus-agent/nimbus-sdk) and [nimbus-agent/nimbus-client](https://github.com/nimbus-agent/nimbus-client) (both npm, MIT) — not under `packages/`.

---

## Package Deep-Dives

### `packages/gateway/src/` — The Core

| Directory | Owns |
|---|---|
| `platform/` | Platform Abstraction Layer — `PlatformServices` interface + `win32`, `darwin`, `linux` impls |
| `engine/` | Mastra agent, router, planner, HITL executor, coordinator, sub-agents |
| `vault/` | `NimbusVault` interface + DPAPI / Keychain / libsecret impls |
| `db/` | SQLite write chokepoint (`write.ts`, I14), audit chain, verify/repair/snapshot, health, latency ring buffer — the schema and its migrations live in `index/` |
| `connectors/` | Connector registry, lazy mesh, health model, health history |
| `sync/` | Delta sync scheduler, connectivity probe, rate limiter |
| `extensions/` | Extension Registry, manifest validator, sandbox |
| `telemetry/` | Opt-in aggregate telemetry collector |
| `config/` | TOML config loader, profiles, env-var overrides |
| `ipc/` | JSON-RPC 2.0 server, HTTP API, Prometheus endpoint, LAN server |
| `llm/` | Ollama provider, llama.cpp provider, LLM router, GPU arbiter *(Phase 4)*; the four cloud adapters — Anthropic, OpenAI, Gemini, xAI — behind per-vendor `[llm.remote.<vendor>]` opt-ins *(S2, 2026-08-28)* |
| `voice/` | STT (Whisper.cpp), TTS, wake-word *(Phase 4)* — **not wired**: nothing constructs `VoiceService` |

**Key files to know:**
- `engine/executor.ts` — HITL gate lives here. Touch carefully.
- `ipc/<namespace>-rpc.ts` — one file per IPC namespace (e.g. `federation-rpc.ts`, `connector-rpc.ts`, `llm-rpc.ts`); each exports a `dispatch<Namespace>Rpc` wired into `ipc/server/dispatchers.ts`
- `index/migrations/runner.ts` (`INDEXED_SCHEMA_STEPS`) — all SQLite schema changes go through migrations, never manual ALTER

### `packages/cli/src/`

- `commands/` — one file per CLI subcommand (74 top-level commands registered in `COMMAND_HANDLERS`, `packages/cli/src/index.ts`, when last counted on 2026-10-03 — verify the live map rather than this count): `start`, `stop`, `status`, `db`, `diag`, `tail`, `query`, `telemetry`, `tui`, `update`, `doctor`, `config`, `profile`, `serve`, `test`, `ask`, `explain`, `catchup`, `changelog`, `conflicts`, `decisions`, `demo`, `expert`, `ghost`, `glossary`, `huddle`, `impact`, `janitor`, `index`, `init`, `vault`, `audit`, `connector`, `data`, `deploy`, `extension`, `people`, `preflight`, `search`, `security`, `session`, `workflow`, `watch`, `why`, `repl`, `run`, `scaffold`, `lan`, `llm`, `media`, `metrics`, `standup`, `oncall`, `stats`, `negotiate`, `owners`, `pre-mortem`, `team`, `identity`, `scim`, `policy`, `chatops`, `tribal`, `admin`, `share`, `verify-share`, `mcp-server`, `prove`, `egress`, `exec`, `clip`, `computer`, `tool`, `wow`. (`bench` and `fleet` are dispatched in separate branches, because both return an exit code the generic handler path would discard; there is no `docs` command.)
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
| `engine.*` | `askStream`, `cancelStream`, `getSessionTranscript`; `streamToken` / `streamDone` / `streamError` (notifications) |
| `agent.*` | `invoke` (the shared `runAsk` pipeline); `chunk` (notification, `{ streamId?, text }`, sent when `agent.invoke` or `workflow.run` is called with `stream: true`). `gasLimitReached` (notification, UNICAST to the `agent.invoke` caller, `{ limit: "steps", cap, used, streamId? }`) when the `NIMBUS_ASK_MAX_STEPS` step budget cut the turn short — the reply also carries a deterministic disclosure line. `subTaskProgress` and `hitlBatch` are named in older text but nothing emits them; a coordinator depth/tool-call limit throws a typed `AgentLimitError` (`ERR_AGENT_LIMIT_REACHED:`) instead |
| `connector.*` | `listStatus`, `status`, `healthHistory`, `sync`, `pause`, `resume`, `remove`, `reindex`, `setConfig`, `setInterval`, `auth`, `addMcp`, `detectLocalAuth`, `adoptLocalAuth`; `healthChanged`, `configChanged` (notifications) |
| `llm.*` | `listModels`, `pullModel`, `cancelPull`, `loadModel`, `unloadModel`, `setDefault`, `use`, `status`, `getStatus`, `getRouterStatus` |
| `watcher.*` | `list`, `create`, `delete`, `pause`, `resume`, `listHistory`, `listCandidateRelations`, `validateCondition` (a firing rides `gateway.event` as `watcher.fired`) |
| `workflow.*` | `list`, `save`, `delete`, `run`, `cancel`, `listRuns` |
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
- For multi-agent flows the design is one consolidated request rather than per-sub-agent consent. The `agent.hitlBatch` notification that older text names for it is **not emitted** by the gateway today (only the TUI still subscribes to it); consent reaches the acting client as a unicast `consent.request`, answered with `consent.respond`
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

Every connector lives in [nimbus-agent/nimbus-mcp-servers](https://github.com/nimbus-agent/nimbus-mcp-servers) at `connectors/<service>/`. It:
- Is a standalone MCP server process
- Receives credentials via scoped environment injection at spawn time (not from IPC or config files)
- Declares `hitlRequired: true` in its manifest for any write tool (which auto-adds those tools to the HITL gate)
- Has its manifest SHA-256 hash verified on every Gateway startup

The Engine calls connectors through the MCP tool interface only. No connector imports are allowed inside `packages/gateway/src/engine/`.

**Connector quickstart:** write it by hand from nimbus-mcp-servers' [guide to adding a connector](https://github.com/nimbus-agent/nimbus-mcp-servers/blob/main/docs/adding-a-connector.md): `connectors/<id>/` with `src/server.ts` kept a bootstrap and the tool surface in `src/tools.ts`, the manifest, a TypeScript config extending `../../tsconfig.base.json`, and an `exports` entry in that repository's root manifest. **`create-nimbus-connector` cannot generate one there yet.** Its default target is still the pre-move `packages/mcp-connectors/<name>/` layout, with `../../shared/*` imports and `extends: "../../../tsconfig.base.json"`. Neither resolves in nimbus-mcp-servers, even with `--out-dir connectors/<id>`, and the generator emits no `src/tools.ts`. Only its `--standalone` output is independent of that layout, and it is for a connector outside that repository.
`nimbus scaffold mcp <name>` (alias `scaffold extension`) is **not** the tool for a first-party connector either: it emits a standalone user MCP server with no connector manifest, which every connector gate keys off. See `docs/CONTRIBUTING.md` § Adding a New MCP Connector. Extension (not connector) walkthrough: `docs/contributors/extension-author-walkthrough.md`

---

## Where to Put New Code

| What you're building | Where it goes |
|---|---|
| New CLI subcommand | `packages/cli/src/commands/<name>.ts` |
| New IPC method | `packages/gateway/src/ipc/<namespace>-rpc.ts` |
| New connector | `connectors/<service>/` in [nimbus-agent/nimbus-mcp-servers](https://github.com/nimbus-agent/nimbus-mcp-servers) — plus its sync handler HERE |
| New DB table / migration | `packages/gateway/src/index/migrations/` |
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
| E2E Desktop | Playwright + Tauri WebDriver | runs on push to `main` only (not on release tags); on a PR only with the `ci:e2e-desktop` label and a `packages/ui/` change |

Coverage gates: Engine ≥ 85%, Vault ≥ 90%. New subsystems should target ≥ 85%.

Each test gets a fresh temp dir + fresh DB — never share state between tests.

---

## Platform Socket / Paths

| Platform | IPC Socket | Config Dir | Data Dir |
|---|---|---|---|
| Windows 10+ | `\\.\pipe\nimbus-gateway` | `%APPDATA%\Nimbus` | `%LOCALAPPDATA%\Nimbus\data` |
| macOS 13+ | `$TMPDIR/nimbus-gateway.sock` (`/tmp` when `TMPDIR` is unset) | `~/Library/Application Support/Nimbus` | the same directory as the config dir |
| Ubuntu 22.04+ | `$XDG_RUNTIME_DIR/nimbus-gateway.sock` (the OS temp dir when unset) | `$XDG_CONFIG_HOME/nimbus` (default `~/.config/nimbus`) | `$XDG_DATA_HOME/nimbus` (default `~/.local/share/nimbus`) |

Use `PlatformServices` from `packages/gateway/src/platform/` to resolve these — never hardcode paths. The resolution lives in `platform/paths.ts`: `NIMBUS_GATEWAY_SOCKET` moves only the socket and `NIMBUS_CONFIG_DIR` only the config dir, and a demo-rooted process (`NIMBUS_DEMO=1`, invariant I41) derives every path, and the endpoint name, from its own demo root.
