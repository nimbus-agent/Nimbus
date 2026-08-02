# Agents as MCP tools — design

> **Status:** design of record, 2026-08-02. Scope is exposing the built-in
> agents through the existing `nimbus mcp-server` stdio surface, plus the
> packaging change that makes that server listable in MCP directories. The
> gateway-hosted HTTP transport is explicitly the successor, not this design.

## The problem

Nimbus's differentiated capability is its agents: eleven read-only briefs
synthesised from a private cross-service index. Every one of them is reachable
from exactly one place — the local IPC socket, via the CLI.

Meanwhile `nimbus mcp-server` already ships and already speaks to editors. It
exposes six tools, all of them thin index reads: search, connector status, three
recency browses, and DORA metrics. The surface that carries none of the
product's differentiated capability is the only surface other agents can reach.

This is backwards. It is also the cheapest distribution the project has
available, and it inverts the usual arrangement in a way no hosted product can
copy: every SaaS agent asks you to upload your context, whereas this hands an
external agent your private cross-service context **while the index never
moves**.

### Why now, and why this shape

Three independent analyses converged on this item, and verification found it
cheaper than any of them estimated — the adapter, the connection cache with
reconnect-on-transport-death, the never-throw error discipline and the tool
registration loop all already exist. The work is genuinely tool registrations
plus one correctness fix.

The packaging half matters as much as the feature half. Directory listings are
currently unreachable for a purely mechanical reason: the MCP server is a
gateway subcommand rather than an artifact on a supported registry.

## Measured ground truth

Verified against the tree on 2026-08-02.

| Fact | Value | Measured from |
| --- | --- | --- |
| Existing MCP tools | 6 | `TOOL_SPECS`, `packages/cli/src/mcp/adapter.ts` |
| Built-in agents | 11 async + 1 synchronous peek | `packages/gateway/src/agents/` |
| Async agent contract | returns `sessionId`, then emits `<agent>.briefReady` with markdown **and** typed findings | `agents/_lib/emit-brief.ts` |
| Notification delivery | broadcast to every connected session | `broadcastNotification`, `ipc/server/server.ts:72` |
| `sessionId` comparison in the await adapter | destructured, never compared | `lib/agent-brief-render.ts:20` |
| Ledger `sourceType` | first-class field, committed to the BLAKE3 row hash | `egress/egress-ledger.ts:11,29` |
| Existing `sourceType` values | `task`, `prune` | `egress-record.ts:51`, `egress-prune.ts:91` |
| Free index text already crossing to the editor LLM | `semanticSnippet` | `projectRankedItem`, `adapter.ts:96` |

That last row settles a question that would otherwise dominate the design: prose
drawn from indexed bodies **already** reaches the editor's model today. A brief
is a difference of degree, not of kind.

## Decisions taken

1. **Briefs cross as raw markdown.** The brief is the product; projecting it
   through the item whitelist would discard the synthesis, which is the entire
   reason to call the tool. The typed findings ride along as a second content
   block for callers that want structure. The real control is therefore *which
   agents are exposed* and *whether the call is recorded* — not redaction.
2. **Every MCP agent invocation is recorded in the egress ledger** under a new
   `sourceType`. See "Ledger integration".
3. **Extend the existing CLI adapter; add an MIT launcher.** Rejected
   alternatives: a gateway-hosted HTTP/SSE transport (correct eventual shape,
   but a new authenticated HTTP surface, and it wants to be designed together
   with the HTTP agent route rather than ahead of it), and a standalone MIT
   server package (duplicates the adapter and creates a second consumer of the
   IPC contract, for a packaging benefit the launcher already buys).

## Surface

One tool per agent, appended to `TOOL_SPECS`. Names stay verb-shaped to match
the existing six — `explainWhy`, `getCatchup`, `findExpert`, `assessImpact`,
`findConflicts` — rather than mirroring internal agent names. Each tool's
description is lifted from that agent's CLI help, so the calling model receives
the same framing a human does. Exact names for the less self-evident agents are
pinned during implementation from each agent's own description.

Argument schemas mirror the agent's IPC params, reusing the existing zod
helpers. Result shape:

- content block 1 — the brief markdown, verbatim.
- content block 2 — the typed findings as JSON.

**Ship order: `peekWhy` first.** `runWhyPeek` is already synchronous, so the
first tool exercises registration, dispatch, error handling and the ledger
append end to end without touching the notification path at all. The async
agents follow once that is proven.

## Prerequisite — session correlation

This must land before any async agent tool, and it is not optional.

`awaitAgentBrief` resolves on the first `<agent>.briefReady` it sees. It reads
`sessionId` out of the payload and never compares it, while the gateway
broadcasts every notification to every connected session. A one-shot CLI cannot
observe this. A long-lived MCP server serving two editor windows fails
immediately, and it fails by handing one caller another caller's brief — the
worst available failure mode for a product whose pitch is data boundaries.

A second defect sits in the same function: notification handlers are registered
per call and never removed. Again harmless in a process that exits; in a
long-lived server it leaks a handler per invocation and every stale handler
fires on every subsequent brief.

Three changes:

1. Compare the notification's `sessionId` against the one returned by the
   `agents.<name>` call; ignore non-matching notifications rather than
   resolving on them.
2. Deregister both handlers when the promise settles, by any path including
   timeout.
3. Make the 30-second timeout injectable — appropriate for a CLI, wrong to
   hardcode for callers with their own deadlines.

The CLI inherits the correctness fix.

## Ledger integration

An MCP call causes the gateway to synthesise a brief from the private index and
hand it to whichever model the calling editor uses. Under today's wiring that
leaves no trace: `I29` appends at the executor's `connectors.dispatch`
chokepoint, and an MCP read never dispatches a connector action. `nimbus prove`
would report a clean window while private context left the machine.

Closing that is what makes this feature defensible rather than merely
convenient.

**Row shape.** `sourceType: "mcp"`; `destination: "mcp"`; `method` the invoked
IPC method (`agents.why`); `source_id` the MCP session; `payload_summary` the
subject argument scrubbed through `redactAuditPayload` at the existing 256-byte
cap. No migration is required — `source_type` already exists and is already
committed to the row hash, so existing receipts remain valid.

**Two properties that must not be traded away:**

- **Gateway-side, not adapter-side.** The gateway is the authority. An append
  performed by the CLI adapter would be a claim by the caller about itself.
- **Append before the brief returns, fail-closed.** If the append fails the tool
  returns an error and no brief crosses the boundary, mirroring `gate()`'s
  existing discipline. A ledger that can be outrun by the thing it records is
  decorative.

**Invariant cost, stated plainly.** This is a *second* append path. It must
extend `D22`'s static confinement rather than be exempted from it — an appender
outside the static check silently retires the invariant it appears to serve.
Per the triple rule, one commit carries: the wiring, the `I29` section update in
[`SECURITY-INVARIANTS.md`](../../SECURITY-INVARIANTS.md), the enforcement test,
and a new case in the static audit. This is the largest single cost in the
design.

## Packaging

A separate MIT package whose `bin` shells to `nimbus mcp-server --stdio`.
Separate because the CLI is AGPL; MIT because a launcher people are asked to run
via `npx` should impose no obligations.

The install-time failure mode needs deliberate handling, because the package
installs cleanly and then does nothing useful on its own:

- gateway installed but stopped — already covered by `GATEWAY_DOWN_MESSAGE`.
- gateway not installed at all — needs its own message pointing at the install
  documentation.

## Error handling

All tools route through the existing `runTool`, which never throws and always
returns an `isError` result. Three cases are new:

- **Agent timeout** — surfaced as an error result, not a hang.
- **`briefError`** — the agent's own failure message, passed through.
- **Empty index** — the CLI path calls `process.exit(1)` on an `empty_index`
  gap, which an MCP server must never do. Returns a message directing the caller
  to sync instead.

## Testing

| Layer | What it proves |
| --- | --- |
| Adapter unit tests | tool registration, argument validation, projection, error results — injected `IpcCallable`, existing pattern |
| **Concurrency test** | two simultaneous calls to one agent each receive their own brief. Must fail against today's code, or the session fix is unproven |
| Handler-leak test | handler count returns to baseline after a settled call, including on timeout |
| Ledger tests | exactly one `source_type='mcp'` row per invocation; a failed append suppresses the brief entirely |
| Static audit | the extended `D22` confinement accepts the new append site and still rejects an unconfined one |
| E2E stdio | extends `mcp-server-stdio.test.ts` |

The concurrency test is the load-bearing one. It should be written first and
observed failing.

## Out of scope

- **Gateway-hosted HTTP/SSE transport.** The recorded successor. Once the HTTP
  agent-invocation route exists, the stdio adapter becomes a thin client of it
  rather than a parallel implementation.
- **Write-capable tools.** Everything here is read-only. Exposing a
  HITL-gated action through MCP is a separate design with a separate threat
  model.
- **Third-party agent authoring.** Requires opening the closed brief union;
  tracked in [`ecosystem-roadmap.md`](../../ecosystem-roadmap.md) Track B.

## Open questions

- Whether the typed findings block should be omitted for agents whose findings
  are large enough to dominate the response. Resolve by measurement during
  implementation, not up front.
- Whether `destination` should distinguish calling clients. The gateway cannot
  reliably identify the editor behind a stdio pipe, so this design records the
  transport rather than inventing an unverifiable client identity.
