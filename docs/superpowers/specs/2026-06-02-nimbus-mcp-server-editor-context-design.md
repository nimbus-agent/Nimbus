# Design: `nimbus mcp-server` — Expose the Local Index as an MCP Stdio Server

**Date:** 2026-06-02
**Status:** Approved (design); pending implementation plan
**Roadmap item:** Phase 4 — Presence → "Editor AI Context (MCP Native)" (`docs/roadmap.md`, "Native Cursor / Claude Code / Copilot context exposure")
**Branch:** `dev/asafgolombek/mcp-server`

## Summary

Expose the Nimbus local index to MCP-compatible editor AIs (Cursor, Claude Code,
Copilot) as a **read-only MCP stdio server**. The server is a thin adapter that
translates inbound MCP tool calls into the Gateway's existing JSON-RPC **read**
IPC methods and streams the results back. This does not introduce a new protocol —
Nimbus is already MCP-native as a *client* of connectors; this inverts the
client/server relationship for the local index so an editor's LLM can query
incident history, deployment state, open PRs, DORA metrics, and connector health
without the user switching context.

## Goals

- A `nimbus mcp-server` CLI command that (a) prints an `mcp.json` config block to
  paste into an editor, and (b) with `--stdio`, runs the MCP server over stdio.
- Six read-only tools backed entirely by existing Gateway read IPC methods.
- Zero write surface, zero HITL surface, no new Gateway APIs.
- Clear, actionable behavior when the Gateway is not running.

## Non-Goals

- No write tools (no `deployment.annotate`, no connector mutation, no `engine.ask`).
- No auto-start of the Gateway from an editor-spawned process.
- No new Gateway IPC methods — the adapter consumes only methods that already exist.
- No Tauri allowlist changes (this is not a renderer-callable Gateway method).

## Constraints honored

- **Package dependency rules:** the adapter lives in `packages/cli`, which is an
  IPC-only client of the Gateway and never imports Gateway source. The roadmap's
  suggested path `packages/gateway/src/ipc/mcp-adapter.ts` is intentionally **not**
  used: the adapter is purely an IPC *client*, which is exactly what the CLI
  package already is, and placing it in the Gateway would make Gateway code act as
  an IPC client of itself.
- **Read-only / no HITL:** every tool proxies a read method; the HITL gate
  (`I2`–`I4`) is structurally untouched because no destructive action type is reachable.
- **I11 (`wrapToolOutput`) does not apply:** that envelope guards *our* engine's
  LLM against tool-result prompt injection. Here, tool output flows to the
  *editor's* LLM, outside the Nimbus trust boundary; our engine never sees it.
- **No `any`:** external/tool inputs typed as `unknown` and narrowed; tool schemas
  via zod (already a CLI dependency).

## Architecture

Two new files in `packages/cli`:

1. **`packages/cli/src/commands/mcp-server.ts`** — the CLI command handler.
   - `nimbus mcp-server` → prints the config block (see below) and exits.
   - `nimbus mcp-server --stdio` → constructs the adapter and runs it over stdio
     (blocks until the transport closes).
2. **`packages/cli/src/mcp/adapter.ts`** — builds the `McpServer`
   (`@modelcontextprotocol/sdk@1.29.0`, the version already used by the
   connectors), registers the six read-only tools, and bridges each call to the
   Gateway via the existing CLI `IPCClient` (re-exported from `@nimbus-dev/client`).
   Connects a `StdioServerTransport`.

Wiring:
- Register `mcp-server` in the `COMMAND_HANDLERS` map (`packages/cli/src/index.ts`)
  and export the handler from the `commands/index.ts` barrel.
- Add `@modelcontextprotocol/sdk: 1.29.0` to `packages/cli/package.json`
  (pinned to match the connectors; run the dependency-safety check from
  `nimbus-commands` before adding).

### Dependency injection for testability

The adapter is built by a factory that accepts an **IPC-client provider** so tests
can inject a mock client without `mock.module` (which is process-global and leaks
across the combined CLI test run — see the known-issue memory). Shape:

```ts
interface AdapterDeps {
  // Returns a connected IPC client, or throws a typed "gateway down" error.
  connect(): Promise<IpcCallable>;
}
interface IpcCallable {
  call<T>(method: string, params?: unknown): Promise<T>;
  disconnect(): Promise<void>;
}
```

Production `connect()` reads gateway state via `readGatewayState(getCliPlatformPaths())`
and `new IPCClient(state.socketPath)` — mirroring `commands/search.ts`. Tests pass a
stub.

## Tool surface (6 read-only tools)

Each tool is a thin proxy. `searchIndex` is the primitive; the `getRecent*` /
`getOpen*` tools are convenience wrappers that pin `itemType` so the editor's LLM
gets discoverable, well-named entry points.

| MCP tool | Args (zod) | Backing IPC method | Mapping notes |
|---|---|---|---|
| `searchIndex` | `query: string`, `service?: string`, `itemType?: string`, `limit?: number (1–500)`, `semantic?: boolean` | `index.searchRanked` | `query` → `name`; `contextChunks: 2` default |
| `getConnectorStatus` | *(none)* | `connector.listStatus` | Returns connector health + sync state |
| `getRecentIncidents` | `limit?: number`, `service?: string` | `index.searchRanked` | `itemType: "incident"`, empty `name` |
| `getOpenPRs` | `limit?: number`, `service?: string` | `index.searchRanked` | `itemType: "pr"`; results filtered to open where the item exposes a state field, else recent PRs (documented in the tool description) |
| `getRecentDeployments` | `limit?: number`, `service?: string` | `index.searchRanked` | `itemType: "deployment"` |
| `getDoraMetrics` | `service: string`, `since?: string` | `metrics.dora` | `since` passes through to the existing parser |

`limit` default 20, clamped to the Gateway's own 1–500 ceiling. Results are
returned as a single MCP `text` content item containing the JSON-stringified
Gateway response.

## Data flow

```
editor LLM
  → (stdio / MCP)        adapter.ts
  → (JSON-RPC IPC,       IPCClient.call(method, params)
     lazy per call)
  → Gateway read handler (index.searchRanked | connector.listStatus | metrics.dora)
  → back up the same path as MCP text content
```

The IPC connection is established **lazily per tool call** (connect → call →
disconnect in a `finally`), mirroring the existing CLI commands. This keeps the
server stateless and means it starts and advertises its tool list even when the
Gateway is down.

## Error handling — Gateway not running

The MCP server starts regardless of Gateway state, so the editor can always list
tools. When a tool call cannot reach the Gateway (no gateway state file, or
`connect()`/`call()` throws), the tool returns an MCP **error result**
(`isError: true`) with the message:

> `Nimbus Gateway is not running. Start it with: nimbus start`

No auto-start. Other IPC errors are surfaced as MCP error results carrying the
underlying message, never a thrown exception that would kill the transport.

## Config-block output

`nimbus mcp-server` (no `--stdio`) prints a ready-to-paste block plus a one-line
note that `nimbus` must be on `PATH`:

```json
{
  "mcpServers": {
    "nimbus": {
      "command": "nimbus",
      "args": ["mcp-server", "--stdio"]
    }
  }
}
```

## Testing

Per `nimbus-testing`; all CLI-layer, honoring the CLI coverage floor.

- **Adapter unit tests** (`packages/cli/src/mcp/adapter.test.ts`): inject a mock
  `IpcCallable` via the `AdapterDeps` seam (no `mock.module`). Assert, per tool:
  the correct IPC method name and params are sent (e.g. `getOpenPRs` →
  `index.searchRanked` with `itemType: "pr"`), and that the JSON result round-trips
  into MCP `text` content. Assert a `connect()` rejection yields the
  "Gateway is not running" MCP error result, not a thrown error.
- **Command test** (`packages/cli/src/commands/mcp-server.test.ts`): the no-flag
  branch prints a config block that parses as JSON and contains
  `mcpServers.nimbus.args == ["mcp-server", "--stdio"]`; the `--stdio` branch
  invokes the adapter runner (DI the runner to avoid binding a real stdio transport).
- **Docs:** add a CHANGELOG entry (per the connector-docs convention) and a CLI
  reference entry; tick the roadmap checkbox.

## Security review checklist

- [ ] No write IPC method is reachable from any tool.
- [ ] No HITL-gated action type is reachable; the executor gate is untouched.
- [ ] No credentials cross the boundary — tools return only indexed item data and
      connector status, never vault contents.
- [ ] No new Gateway IPC method; no Tauri allowlist change.

## Open detail (decided)

`getOpenPRs`: `index.searchRanked` filters by `itemType` only, not PR state. The
tool post-filters results to "open" when the indexed item exposes a recognizable
state field, and otherwise returns recent PRs. The tool description documents this
so the editor LLM does not over-trust the "open" qualifier.
