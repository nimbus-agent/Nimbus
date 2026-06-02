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
incident history, deployment state, recent pull requests, DORA metrics, and connector
health without the user switching context.

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
  // Returns a connected IPC client, reusing a cached connection when healthy.
  // Throws a typed "gateway down" error if it cannot connect.
  getClient(): Promise<IpcCallable>;
}
interface IpcCallable {
  call<T>(method: string, params?: unknown): Promise<T>;
  disconnect(): Promise<void>;
}
```

Production `getClient()` reads gateway state via `readGatewayState(getCliPlatformPaths())`,
`new IPCClient(state.socketPath)`, and `connect()` — mirroring `commands/search.ts`. Tests
pass a stub.

**Connection lifecycle (revised — persistent with lazy reconnect).** The
`nimbus mcp-server --stdio` process is **long-lived**, unlike one-shot CLI commands,
so a single IPC connection is opened on the first tool call and **reused** for the
process lifetime. The original per-call connect→call→disconnect approach was rejected
on review: not for latency (a local domain-socket / named-pipe `connect()` is a bare
socket open with no handshake — sub-millisecond), but because a persistent connection
is the cleaner lifecycle for a daemon-style process and avoids churning the socket on
every call. `getClient()` caches the connected client; if a call fails because the
connection dropped (Gateway restarted, socket closed — the transport surfaces this via
its `close`/`error` handlers and `connected` flips false), the cached client is
discarded and the next call re-reads the Gateway state file and reconnects. Re-reading
the state file on reconnect is what transparently picks up a **restarted Gateway whose
socket path changed** — the property the per-call design got for free and that this
revision preserves.

## Tool surface (6 read-only tools)

Each tool is a thin proxy. `searchIndex` is the primitive; the `getRecent*` tools
are convenience wrappers that pin `itemType` so the editor's LLM gets discoverable,
well-named entry points.

| MCP tool | Args (zod) | Backing IPC method | Mapping notes |
|---|---|---|---|
| `searchIndex` | `query: string`, `service?: string`, `itemType?: string`, `limit?: number (1–50)`, `semantic?: boolean` | `index.searchRanked` | `query` → `name`; `contextChunks: 0` (see Payload shaping) |
| `getConnectorStatus` | *(none)* | `connector.listStatus` | Returns connector health + sync state |
| `getRecentIncidents` | `limit?: number`, `service?: string` | `index.searchRanked` | `itemType: "incident"`, empty `name` |
| `getRecentPullRequests` | `limit?: number`, `service?: string` | `index.searchRanked` | `itemType: "pr"`; see PR-state note below |
| `getRecentDeployments` | `limit?: number`, `service?: string` | `index.searchRanked` | `itemType: "deployment"` |
| `getDoraMetrics` | `service: string`, `since?: string` | `metrics.dora` | `since` passes through to the existing parser |

### Payload shaping (review fix — bound the response for editor LLMs)

Returning up to 500 raw ranked items — each carrying a full `rawMeta` metadata blob,
a `body_preview`, and (in the async path) `contextChunks` of surrounding text — would
overrun an editor LLM's context window. The MCP tools therefore bound and slim the
payload, independent of the Gateway's own 1–500 ceiling:

- **`limit`:** default **20**, hard-capped at **50** at the tool layer (the Gateway
  still clamps to 1–500, but the MCP tool never asks for more than 50).
- **`contextChunks: 0`** for every tool — the adapter does not pull surrounding chunk
  text. The editor LLM can issue a follow-up `searchIndex` if it wants more on a
  specific hit; we do not pre-bloat every result.
- **Compact projection:** each ranked item is projected to a stable, small shape.
  The heavy field on a `RankedIndexItem` is `rawMeta` (the full parsed metadata
  blob); the item has **no** `body_preview` field, and a keyword `searchIndex` adds
  only a short `semanticSnippet`. The projection keeps `name`, `service`, `type`
  (from `indexedType`, the *real* type — note `itemType` collapses unknown types to
  `"file"`), `url` (`url ?? canonicalUrl`), `score`, `modifiedAt`, and
  `semanticSnippet` when present; it replaces `rawMeta` with a **whitelisted** slice
  (`state`, `number`, `author`, `status`, `severity`) and drops the raw blob plus
  rank-debug fields (`bm25Rank`, `vectorRank`, `indexPrimaryKey`). This keeps
  payloads small and avoids leaking arbitrary connector metadata to the editor LLM.

Results are returned as a single MCP `text` content item containing the
JSON-stringified projected array.

### PR-state note (review fix — `getOpenPRs` → `getRecentPullRequests`)

The roadmap names this tool `getOpenPRs`, but the index **cannot honestly filter on
PR state**: there is no `state` column on the item row, and `index.searchRanked`
filters only on `service` / `itemType` / FTS title. PR open/closed/merged lives only
inside `rawMeta` *if* the connector stored it. The two reviewer-suggested remedies are
both rejected: over-fetching then post-filtering (e.g. fetch 20, return the 2 that are
open) is a silent, misleading truncation; and extending `searchRanked` with a generic
`state` attribute filter is a new Gateway API, which this design explicitly excludes.

Resolution: the tool is renamed **`getRecentPullRequests`** and returns recent PRs
ranked by recency, surfacing each PR's `state` (from the whitelisted `rawMeta` slice)
so the **editor LLM** can see and filter on it directly. This is honest about the
capability — the name no longer promises a filter the index can't guarantee — and
needs no Gateway change.

## Data flow

```
editor LLM
  → (stdio / MCP)        adapter.ts
  → (JSON-RPC IPC,       IPCClient.call(method, params)
     persistent, lazy
     reconnect)
  → Gateway read handler (index.searchRanked | connector.listStatus | metrics.dora)
  → back up the same path as MCP text content
```

The IPC connection is opened on the **first** tool call and reused for the process
lifetime; a dropped connection triggers a transparent reconnect on the next call (see
*Connection lifecycle*). The MCP server itself starts and advertises its tool list
regardless of Gateway state, so the editor can always list tools even when the Gateway
is down — the first call then surfaces the "Gateway is not running" guidance.

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
  the correct IPC method name and params are sent (e.g. `getRecentPullRequests` →
  `index.searchRanked` with `itemType: "pr"`, `limit ≤ 50`, `contextChunks: 0`), that
  results are projected to the compact whitelisted shape (no raw `rawMeta` blob), and
  that the JSON result round-trips into MCP `text` content. Assert a reconnect: a call
  that fails on a dropped connection discards the cached client and the next call
  re-connects. Assert a `getClient()` rejection yields the "Gateway is not running"
  MCP error result, not a thrown error.
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
- [ ] Item projection emits only the **whitelisted** `rawMeta` keys, never the raw
      metadata blob — bounds payload size and avoids leaking arbitrary connector
      metadata to the editor LLM (see *Payload shaping*).

## Review resolutions (2026-06-02)

Three points from `…-design-review.md` were evaluated against the code and folded in:

1. **Lazy IPC connection → persistent with lazy reconnect.** Adopted, but the
   reviewer's *latency* motivation was found weak (`connect()` is a bare local-socket
   open, no handshake, sub-ms). The real benefit is a cleaner lifecycle for the
   long-lived `--stdio` process; reconnect re-reads Gateway state so a restarted
   Gateway is picked up. See *Connection lifecycle*.
2. **Large JSON payloads.** Adopted in full — see *Payload shaping*: MCP `limit`
   capped at 50, `contextChunks: 0`, and a compact whitelisted projection.
3. **`getOpenPRs` post-filter incompleteness.** Both suggested remedies rejected
   (over-fetch = silent misleading truncation; generic `state` filter = a new Gateway
   API this design excludes). Resolved instead by renaming to `getRecentPullRequests`
   and surfacing each PR's `state` for the editor LLM to filter. See *PR-state note*.
