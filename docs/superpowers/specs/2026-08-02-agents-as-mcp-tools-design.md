# Agents as MCP tools — design

> **Status:** design of record, 2026-08-02. Scope is exposing the built-in
> agents through the existing `nimbus mcp-server` stdio surface, plus the
> packaging change that makes that server listable in MCP directories. The
> gateway-hosted HTTP transport is explicitly the successor, not this design.
>
> **Revised 2026-08-02** following review — see
> [the review response](./2026-08-02-agents-as-mcp-tools-design-review-response.md).

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
| Per-connection caller identity | `clientId`, `randomUUID()` per connection, threaded into `dispatchAgentInvoke` | `ipc/server/server.ts:95,172` |
| Agents that are not pure reads | 1 — `preflight` (the `I24` federated action path) | `docs/cli-reference.md`, `federation/preflight-gate.ts` |

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

One tool per exposed agent, appended to `TOOL_SPECS`. Names stay verb-shaped to
match the existing six rather than mirroring internal agent names, several of
which (`ghost`, `janitor`, `huddle`) mean nothing to a calling model. Each
tool's description is lifted from that agent's entry in
[`cli-reference.md`](../../cli-reference.md), so the calling model receives the
same framing a human does.

| Agent | Tool | Purpose |
| --- | --- | --- |
| `why-peek` | `peekWhy` | synchronous why-lens probe; ships first |
| `why` | `explainWhy` | why is this line/file the way it is — six parallel lanes over the relationship graph |
| `catchup` | `getCatchup` | retrospective digest of what happened while you were away |
| `expert` | `findExpert` | who on the team has the most context on this |
| `impact` | `assessImpact` | if I change this, what breaks — reverse-dependency blast radius |
| `conflicts` | `findConflicts` | work-in-progress collisions before editing a file |
| `decisions` | `findDecisions` | recovers decision records never written down |
| `glossary` | `getGlossary` | team terminology as a queryable glossary; lists when `term` is omitted |
| `janitor` | `checkResourceUsage` | is this cloud resource still in use, and what breaks if I delete it |
| `ghost` | `getPeerContext` | ambient teammate context for a file, via paired peers |
| `huddle` | `getTeamHuddle` | team-scoped briefing across paired peers |

**`preflight` is deliberately excluded.** It is the only agent in the set that is
not purely a read: it asks each paired downstream owner in a namespace to *run*
their own preflight, which is the `I24` federated action-request path — sandboxed
execution behind the local owner's HITL gate. Exposing it would let a calling
model queue consent prompts on the owner's machine and trigger execution on
peers. Read-only is the boundary of this design; see "Out of scope".

**`getPeerContext` and `getTeamHuddle` reach across the federation.** They remain
reads and stay behind the `I17` query gate, but unlike the other nine they cause
outbound peer traffic. That distinction must survive into the ledger row rather
than being flattened into a generic MCP entry.

Argument schemas mirror the agent's IPC params — **IPC params only, never CLI
flags**. The IPC surface is already free of presentation concerns because
rendering lives CLI-side in `renderAgentBrief`; observed params are domain-shaped
throughout (`topicOrFile`, `fileOrPrUrl`, `depth`, `term`, `limit`,
`resourceRef`). No filter for UI-specific options is required, because no such
option crosses the IPC boundary. Reusing the existing zod helpers. Result shape:

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

A third gap sits alongside them. If the gateway connection drops mid-flight, the
awaited notification can never arrive, and nothing observes that: the adapter
owns `isDisconnectError` and a reconnecting client, but `awaitAgentBrief` does
not watch the transport. The call is not stranded forever — the 30-second
timeout bounds it — but a caller waits out that full timeout to learn something
knowable immediately, and reports it as a timeout rather than a disconnect.

Four changes:

1. Compare the notification's `sessionId` against the one returned by the
   `agents.<name>` call; ignore non-matching notifications rather than
   resolving on them.
2. Deregister both handlers when the promise settles, by any path — resolve,
   reject, timeout, or transport death. A `finally` on the settle path, not
   cleanup duplicated into each branch.
3. Reject immediately on transport death, with a disconnect error rather than a
   timeout error.
4. Make the 30-second timeout injectable — appropriate for a CLI, wrong to
   hardcode for callers with their own deadlines.

The handlers in question are client-side (`client.onNotification`); nothing
accumulates on the gateway. The leak is bounded to the calling process, which is
precisely why a long-lived server is where it becomes visible.

The CLI inherits all four fixes.

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

### Caller attribution

Appending on every `agents.*` call would be wrong: a CLI-invoked brief never
leaves the machine, so recording it as egress would make the ledger claim
traffic that did not occur — the mirror image of the honesty gap this section
exists to close. The append must fire only for MCP-originated calls, so the
gateway has to distinguish them.

It already can. The IPC server mints a per-connection `clientId` (`randomUUID()`,
`ipc/server/server.ts:95`) and threads it through `dispatchMethod` into
`dispatchAgentInvoke`. The missing piece is not identity but *kind*.

The design adds a connect-time client-kind declaration, recorded once per
connection and immutable for its lifetime. This matters more than it looks:
a per-call payload field would be caller-supplied on every invocation, whereas a
connection-scoped kind is server-held after the handshake — the same
server-derived-not-caller-supplied property `I23` relies on for reply targets.

The honest reading of a resulting row is "the gateway served this brief to a
connection that identified as MCP." That is adequate here, because every client
on this socket is a local process the owner started; anyone able to open it can
already call anything. The threat model is honesty of record, not defence
against a hostile local caller.

Federation-touching agents (`getPeerContext`, `getTeamHuddle`) additionally cause
outbound peer traffic. Their rows must remain distinguishable from purely local
briefs rather than collapsing into one undifferentiated MCP entry.

### Invariant cost, stated plainly

This is a *second* append path, and the framing of how it lands is load-bearing.

The wrong move — and the tempting one, because it turns CI green in a line — is
to add the new file to the static checker as a permitted appender. That is an
exemption wearing an extension's clothes. `D22`'s value is not that a known set
of files may append; it is that every path which can cause egress *must* pass
through an append first. An allowlist entry satisfies the checker while
dissolving the property.

The extension must therefore assert the new chokepoint the way `D22` asserts the
executor's: the MCP agent path has exactly one append site, and every
MCP-originated agent invocation is statically shown to route through it. A test
that only proves "this file is allowed to append" is not an enforcement test.

Per the triple rule, one commit carries the wiring, the `I29` section update in
[`SECURITY-INVARIANTS.md`](../../SECURITY-INVARIANTS.md), the enforcement test,
and the extended static case. Wiring site: the append belongs with the
agent-invoke dispatch in `packages/gateway/src/ipc/`, adjacent to
`dispatchAgentInvoke`, so that no MCP-reachable agent route can bypass it. This
is the largest single cost in the design.

## Packaging

A separate MIT package whose `bin` shells to `nimbus mcp-server --stdio`.
Separate because the CLI is AGPL; MIT because a launcher people are asked to run
via `npx` should impose no obligations.

**Binary discovery.** A bare `exec("nimbus …")` is not sufficient. `nimbus` is
frequently absent from a global `PATH` — the Windows installer is per-user, and
package-manager and user-space installs land in directories that editors
spawning a subprocess do not inherit. The resolution order is:

1. `NIMBUS_BIN`, if set. An explicit escape hatch that works for every packaging
   scheme and is the one thing an editor's MCP config can set directly.
2. `PATH` lookup.
3. A small documented set of per-OS install locations.
4. Otherwise, a platform-specific error naming the install documentation — not a
   raw command-not-found exit code.

One constraint the obvious implementation violates: the launcher **cannot import
the CLI's path helpers**. `getCliPlatformPaths` lives in the AGPL CLI, and this
package is MIT. Step 3 therefore duplicates a small amount of path knowledge by
necessity. That duplication is a drift risk and should be covered by a test that
asserts the launcher's location list against the installers' actual output
directories, rather than left to rot.

**Three distinct failure states**, which must not be collapsed into one message:

- Gateway not installed — the discovery failure above.
- Gateway installed but stopped — already covered by `GATEWAY_DOWN_MESSAGE`.
- Gateway found but too old to attribute the connection — detected by the
  adapter at connect time, when the client-kind declaration is rejected as an
  unknown method. Such a gateway will still serve briefs, but nothing will be
  recorded in the ledger, so this must be reported rather than swallowed:
  silently serving unrecorded briefs makes `nimbus prove` quietly wrong, which
  is the exact failure this design exists to close. Reported on stderr, which is
  safe because the MCP protocol channel is stdout. The launcher cannot detect
  this itself — it sees the CLI binary, not the gateway's method surface.

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
| Transport-death test | a mid-flight disconnect rejects immediately with a disconnect error, not after the full timeout |
| Ledger tests | exactly one `source_type='mcp'` row per invocation; a failed append suppresses the brief entirely |
| **Attribution test** | a CLI-originated `agents.*` call appends **no** row. The false-positive guard — a ledger that over-reports is as dishonest as one that under-reports |
| Static audit | the extended `D22` confinement proves every MCP-originated agent route passes through the append site, and still rejects an unconfined one. Asserting the file is *permitted* to append does not count |
| Launcher discovery | the per-OS location list matches the installers' actual output directories, so the duplicated path knowledge cannot rot silently |
| E2E stdio | extends `mcp-server-stdio.test.ts` |

The concurrency test is the load-bearing one. It should be written first and
observed failing.

## Out of scope

- **Gateway-hosted HTTP/SSE transport.** The recorded successor. Once the HTTP
  agent-invocation route exists, the stdio adapter becomes a thin client of it
  rather than a parallel implementation.
- **Write-capable tools, and `preflight`.** Everything exposed here is a read.
  `agents.preflight` is excluded despite being an "agent" because it is the
  `I24` federated action-request path: it triggers sandboxed execution on peers
  behind the local owner's HITL gate. A calling model that can invoke it can
  queue consent prompts on the owner's machine. Exposing any HITL-gated action
  through MCP is a separate design with a separate threat model, and it should
  start from the question of whether an external model should be able to
  *originate* a consent prompt at all.
- **Third-party agent authoring.** Requires opening the closed brief union;
  tracked in [`ecosystem-roadmap.md`](../../ecosystem-roadmap.md) Track B.

## Open questions

- Whether the typed findings block should be omitted for agents whose findings
  are large enough to dominate the response. Resolve by measurement during
  implementation, not up front.
- Whether `destination` should distinguish calling clients. The gateway cannot
  reliably identify the editor behind a stdio pipe, so this design records the
  transport rather than inventing an unverifiable client identity.
