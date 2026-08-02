# Agents as MCP tools — review response

> **Status:** response of record, 2026-08-02. Answers
> [the review](./2026-08-02-agents-as-mcp-tools-design-review.md) of
> [the design](./2026-08-02-agents-as-mcp-tools-design.md). Three points accepted
> (two with material refinement), one accepted in substance with its framing
> rejected, one rejected on its premise. The design has been revised; this
> document records why.

## Summary

| # | Review point | Verdict |
| --- | --- | --- |
| 1 | Binary discovery in the launcher | **Accepted, refined** — added an env override, and a licence constraint the review missed |
| 2 | Leak-free deregistration | **Accepted, extended** — the real gap is transport death, not the timeout path |
| 3 | Static confinement update | **Substance accepted, framing rejected** — the proposed fix would retire the invariant |
| 4 | UI-specific agent parameters | **Rejected** — the premise does not hold against the IPC contract |
| 5 | Complete tool-name map | **Accepted, delivered** — with one correction to the review's example |

One defect the review did not raise turned out to matter more than four of the
five points; it is recorded at the end.

## 1. Binary discovery — accepted, refined

The concern is correct and the design was thin here. A bare `exec("nimbus …")`
does fail in exactly the situations named: the Windows installer is per-user, and
package-manager and user-space installs land in directories an editor-spawned
subprocess does not inherit.

Two refinements to the proposed sequence:

**An explicit override comes first.** The review's step 1 is a `PATH` lookup;
the design now starts with `NIMBUS_BIN`. A hardcoded location list drifts against
five packaging channels, whereas an env var an editor's MCP config can set
directly resolves every exotic layout without the launcher having to predict it.
The location list stays, demoted to a fallback.

**The obvious implementation is licence-blocked, which the review missed.** The
natural instinct is to reuse `getCliPlatformPaths`. That helper lives in the AGPL
CLI, and the launcher is MIT — importing it would relicense the launcher. Step 3
therefore duplicates path knowledge by necessity, which is a drift risk the
review's version would have absorbed silently. The design now requires a test
asserting the launcher's location list against the installers' real output
directories.

Also split: the design collapsed two failure states into one message. There are
three — not installed, installed but stopped, and found but too old to serve the
agent tools. The third otherwise surfaces as an unknown-method error from the IPC
layer, which names nothing actionable.

## 2. Leak-free deregistration — accepted, extended

Accepted, and the review found the right area — but the specific failure it
describes is not the one that bites, and two of its claims need correcting.

**Correction one: the listeners are client-side.** The review states stale
listeners "could accumulate on the main gateway session emitter." They do not.
The registrations are `client.onNotification` — in the calling process. Nothing
accumulates on the gateway. This matters for where the fix goes, and it is
precisely why a long-lived server is the only place the leak becomes visible.

**Correction two: the promise is bounded.** The review says it "might remain
pending indefinitely." The 30-second timeout bounds it. The real cost is a caller
waiting out a full timeout to learn something knowable immediately, and then
being told it timed out when it actually disconnected.

**The extension, which is the substantive part:** the adapter owns
`isDisconnectError` and a reconnecting client, but `awaitAgentBrief` does not
watch the transport at all. So a mid-flight connection drop means the awaited
notification can never arrive and nothing notices. The design now carries four
changes rather than three, with immediate rejection on transport death added.

The proposed `AbortController` is a reasonable implementation of this and is left
to implementation rather than mandated in the design; the binding requirement is
that cleanup runs on every settle path, expressed once rather than duplicated
into each branch.

## 3. Static confinement — substance accepted, framing rejected

The request for concreteness about where the append lives is fair, and the design
was vague. It now names the wiring site: with the agent-invoke dispatch in
`packages/gateway/src/ipc/`, adjacent to `dispatchAgentInvoke`, so no
MCP-reachable agent route can bypass it.

**The proposed remedy is rejected, and this is the most consequential point in
the review.** It reads:

> Update `check-nimbus-invariants.ts` to allow this specific file/function as a
> valid writer/ledger-appender, ensuring the static audit does not fail during CI
> preflight gates.

That is an exemption wearing an extension's clothes, and "so the audit does not
fail" is the wrong objective function. `D22`'s value is not that a known set of
files is permitted to append. It is that **every path which can cause egress must
pass through an append first**. Adding a file to an allowlist satisfies the
checker while dissolving the property the checker exists to hold — the design
already warned that an appender outside the static check silently retires the
invariant, and this is that failure mode arriving as a suggestion.

The extension must assert the new chokepoint the way `D22` asserts the
executor's: the MCP agent path has exactly one append site, and every
MCP-originated invocation is statically shown to route through it. A test proving
only that the file *may* append is not an enforcement test.

**The question also surfaced a genuine hole.** Appending on every `agents.*` call
would be wrong — a CLI-invoked brief never leaves the machine, so recording it
would make the ledger claim traffic that did not occur, the mirror image of the
gap this design exists to close. So the gateway must distinguish MCP-originated
calls, and the design did not say how.

It can. The IPC server already mints a per-connection `clientId`
(`ipc/server/server.ts:95`) and threads it into `dispatchAgentInvoke`. What was
missing is not identity but *kind*, so the design adds a connect-time client-kind
declaration, held per connection and immutable for its lifetime — server-held
after the handshake rather than caller-supplied per call, the same property `I23`
relies on for reply targets. A new attribution test asserts a CLI-originated call
appends no row.

## 4. UI-specific agent parameters — rejected

The premise does not survive contact with the IPC contract.

The review anticipates agent options that "make sense only in interactive TUI/CLI
contexts (e.g., interactive paging, terminal width, verbose output modes, or
confirm-prompts)" and proposes a translation filter to strip them. No such
parameter crosses the IPC boundary. Rendering lives CLI-side in
`renderAgentBrief`; `--json` is a CLI flag consumed before any IPC call is made.
The observed agent params are domain-shaped throughout: `topicOrFile`,
`fileOrPrUrl`, `depth`, `term`, `limit`, `resourceRef`.

The reasoning appears to start from the CLI's flag surface rather than the
`agents.*` method signatures. Building a filter for a category of parameter that
does not exist would add a component whose tests could only assert that it does
nothing.

Converted to a stated rule at zero cost, since the concern is worth foreclosing
even though the mechanism is not: tool schemas mirror **IPC params only, never
CLI flags**. If a presentation parameter ever reaches the IPC surface, that is
the bug to fix, at that boundary — not something to paper over downstream.

## 5. Tool-name map — accepted, delivered

Fair, and cheap to close. The design deferred names to implementation; the full
map is now in the design, derived from each agent's entry in
[`cli-reference.md`](../../cli-reference.md) rather than guessed.

One correction: the review's example lists a `status` agent. There is none. The
eleven are `catchup`, `conflicts`, `decisions`, `expert`, `ghost`, `glossary`,
`huddle`, `impact`, `janitor`, `preflight`, `why`, plus the synchronous
`why-peek`.

Naming judgement worth recording: three internal names (`ghost`, `janitor`,
`huddle`) are meaningless to a calling model and become `getPeerContext`,
`checkResourceUsage` and `getTeamHuddle`. `glossary` becomes `getGlossary` rather
than `lookupTerm`, because `term` is optional and the tool lists the whole
glossary when it is omitted — a name that describes only the dominant mode would
mislead the caller about the other one.

## Not raised by the review: `preflight` is not a read

Checking the agent roster to build the naming map surfaced a defect neither the
design nor the review caught.

The design asserted "everything here is read-only" and proposed exposing all
eleven agents. `preflight` is not a read. It asks each paired downstream owner in
a namespace to *run* their own preflight — the `I24` federated action-request
path, which executes a sandboxed command behind the local owner's HITL gate.

Exposing it would let a calling model trigger execution on peer machines and
queue consent prompts on the owner's. An external model that can originate a
consent prompt can also spam it, which is a plausible route to approval fatigue
against the mechanism the entire safety argument rests on.

`preflight` is now excluded, and the out-of-scope entry records that exposing any
HITL-gated action through MCP should begin from whether an external model should
be able to originate a consent prompt at all — not from how to plumb it.

Related, and now recorded rather than flattened: `ghost` and `huddle` remain
reads but reach across the federation, so they cause outbound peer traffic. Their
ledger rows must stay distinguishable from purely local briefs.

## What changed in the design

- Surface: full agent-to-tool map; `preflight` excluded with rationale;
  federation-touching agents flagged; the IPC-params-only rule stated.
- Prerequisite: four changes rather than three, adding transport-death rejection;
  the client-side nature of the leak made explicit.
- Ledger: a new caller-attribution section; the invariant-cost section rewritten
  to reject allowlisting and name the wiring site.
- Packaging: the discovery sequence, the AGPL/MIT constraint on path helpers, and
  three distinct failure states.
- Testing: attribution, transport-death and launcher-discovery rows added; the
  static-audit row sharpened to exclude a permission-only assertion.
- Ground truth: rows for per-connection `clientId` and for the one non-read
  agent.
