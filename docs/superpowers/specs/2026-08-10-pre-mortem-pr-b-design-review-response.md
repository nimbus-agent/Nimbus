# `nimbus pre-mortem` PR B — Response to Design Review

Responds to [`2026-08-10-pre-mortem-pr-b-design-review.md`](./2026-08-10-pre-mortem-pr-b-design-review.md).
Six items: **three accepted** (spec amended), **three answered from the code with no change**, one of
those partially accepted for its documentation demand while rejecting its proposed mechanism.

Every answer below was checked against the tree rather than reasoned from the design document.

---

## Q1 — Warn when a service's deployments are Vercel/Prefect · **ACCEPTED (scoped)**

Correct, and cheap. A user whose deploys come from Vercel would otherwise see pre-mortem propose no
`deploy_failed` watcher and have no way to learn why.

**Amendment.** When the deploy-failure risk fires for a service, the brief distinguishes three states
rather than two:

| Service's deployment items | Brief says |
|---|---|
| carry `metadata.conclusion` | proposes the watcher normally |
| exist, but none carry `conclusion` | *"deploy-failure watching covers CI-annotated deployments (`POST /v1/deployments`); this service's deployments are indexed from a source that records no outcome, so no watcher was proposed"* |
| none at all | the ordinary "no deployment history" gap |

Keyed on the presence of the `conclusion` key in the indexed rows — **derived, not a hardcoded list of
producer names.** A hardcoded list would be a fourth place to drift when a producer changes shape, and
this repository has hit exactly that failure three times with the connector body-depth table.

## Q2 — Method naming, and Tauri access to refresh · **NO CHANGE (both answered from the code)**

**Naming: `agents.premortem` is correct.** `ipc/agents-rpc.ts:633-638` registers `agents.ownership`,
`agents.glossary`, `agents.decisions` — lowercase single token — and reserves camelCase for genuinely
two-word names (`agents.whyPeek`). "premortem" is one token here, matching the `premortem/` directory
and the existing `premortem.refresh` shipped in PR A. `agents.preMortem` would be the anomaly.

**Refresh stays unexposed, and this is pinned by tests.** `gateway_bridge.rs:544` asserts
`!is_method_allowed("ownership.refresh")` and `:530` asserts the same for `decisions.refresh`, each
with a comment explaining that a method which re-derives an entire graph is not renderer-safe (I7).
pre-mortem following that precedent is the consistent choice, not an oversight.

To the reviewer's follow-up — *how would a Tauri user force a refresh?* They would not, exactly as
they cannot for ownership, decisions or glossary today. The passes are debounced and post-sync, so
the desktop UI gets fresh data without asking. If that turns out to be wrong it is a **cross-agent
decision about all four refresh methods**, taken with the I7 rationale in view — not a change to make
for pre-mortem alone while its three siblings stay shut.

## Q3 — JSON-RPC error-code helper · **NO CHANGE (convention recorded)**

There is no repo-wide error enum. Each IPC namespace defines its own error class taking a raw integer
— `AutomationRpcError(-32602, …)` in `ipc/automation-rpc.ts`, `AgentsRpcError(-32602, …)` in
`ipc/agents-rpc.ts:409`. B1 follows the local convention in the file it edits. Recorded in the spec so
the implementer does not invent an enum mid-PR.

## S1 — Have `watcher.validateCondition` use the condition-kind table · **PARTIALLY ACCEPTED**

**Accepted: the table is the single source.** Both the engine's evaluator and `watcher.create`'s new
membership check read the same table. That is the DRY point, and it is in the spec.

**Rejected: validating target parameters through it.** Two reasons, both from the code.

`watcher.validateCondition` (`automation-rpc.ts:74-87`) takes `graphPredicateJson` and `sinceMs` and
returns a `matchCount`. It never receives a `conditionType`, so there is nothing there to route
through the table without redefining the method's contract — which is a change to an existing IPC
surface that pre-mortem does not need.

More importantly, the suggested check — *does the filtered service exist / is it valid for that item
type* — would be **wrong**, not merely extra. A watcher is a forward-looking subscription. A service
with no incidents yet is the normal case for a watcher worth arming, and rejecting it would refuse
exactly the watchers a user most wants. Validation stays a membership check on the condition kind:
whether the engine can ever evaluate this condition, which is knowable statically, rather than whether
it will match today, which is not a validity question at all.

## S2 — The agent's write access, I2, and returning proposals instead · **PARTIALLY ACCEPTED**

**Accepted — the documentation demand.** The write exception is spelled out explicitly in the Agent
Shape Invariant amendment: which tables pre-mortem writes (`watcher` rows with `enabled = 0`, and
`premortem_watcher_proposal`), that it writes nothing else, and why.

**Rejected — the I2 framing.** I2 is HITL-gate membership over `HITL_REQUIRED_BACKING` action types in
`engine/executor.ts`, and it governs **actions that leave the machine**. A local SQLite insert is not
an executor action and never enters the gate: `glossary`, `decisions` and `ownership` all write local
rows today with no HITL, as does the egress ledger itself. Applying I2 to a local row would not add
safety; it would dilute the invariant into "any write", which is precisely the drift
`docs/SECURITY-INVARIANTS.md` warns against. There is also no structural test asserting agents are
read-only — it is a documented invariant in `.claude/commands/nimbus-agent-patterns.md`, which is why
amending that document is the correct and sufficient mechanism.

**Rejected — the "typically cleaner and safer" alternative, on evidence.** The proposal is that the
agent return a payload and the client create the watcher via `watcher.create`. `watcher.create`
hardcodes **`enabled: 1`** (`ipc/automation-rpc.ts:121`). Routing through it would produce **armed**
watchers — and an armed watcher fires a `notify` callback whose ChatOps variant posts to a team
channel. That is the exact outcome the paused design exists to prevent, so as stated the alternative
is strictly *less* safe than writing a paused row directly.

Making it work would mean adding a paused-creation IPC method, exposing it to clients, and moving the
`premortem_watcher_proposal` tombstone write to the client too — otherwise "proposed" and "deleted"
stop being distinguishable and rule 3 collapses. That is more surface, more trust in the client, and
no safety gained over a row that is inert by construction.

The safety property here is **`enabled = 0`**, not who performed the insert. `listEnabledWatchers`
filters on `enabled === 1`, so a paused row cannot fire regardless of its author.

## S3 — Name the tracker in the empty-result diagnostic · **ACCEPTED**

The design's failure-mode table already returns a named gap rather than silence, but it says *"cannot
determine services"* without saying which tracker limitation produced it. Amended so the message names
the cause:

- a Linear reference → *"pre-mortem covers Jira epics only; no Linear project items are indexed"*
- a Jira epic with no `parent_key` children → *"this looks like a company-managed Jira project, where
  epic membership is not indexed; pass `--service`, or re-run once child PRs land"*
- otherwise → the existing generic gap

Each names what is missing and what to do about it. Consistent with the honesty rules already in the
2026-08-09 design.

---

## Net effect on the plan

B1 is unchanged in scope. B2 gains one derived check (the deployment-outcome state above), two
sharpened diagnostic messages, and a more explicit Agent Shape Invariant amendment. No new PR, no
migration, no new IPC method.
