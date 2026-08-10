# `nimbus pre-mortem` PR B — Design Delta

> **Reads as an amendment to [`2026-08-09-pre-mortem-design.md`](./2026-08-09-pre-mortem-design.md)**, not a
> replacement. That document remains canonical for the four lanes, the cohort algorithm, the five
> structural risks, the watcher rules, the honesty rules, the failure-mode table, and everything
> declared out of scope. This delta records only what changed after PR A shipped (#1134, squash
> `cd1d9c2e`, released as **v1.27.0**) and after its assumptions were checked against the tree.

**Date:** 2026-08-10 · **Slot:** Spine S1 (Local Brain) · **Status:** approved, plan pending

---

## Why a delta exists

PR A shipped the substrate only: schema **V53** (`premortem_theme`, `premortem_theme_evidence`,
`premortem_pass_state`, `premortem_watcher_proposal`), the debounced extraction pass under
`packages/gateway/src/premortem/`, the `[premortem]` config block, and the `premortem.refresh` IPC
method. There is no agent and no command, so today the pass mines closed epics into rows **nothing
can read**. PR B is what makes V53 reachable.

Three facts checked against the tree changed the plan. Each was previously asserted from the design
document rather than read from the code — the failure mode that produced fifteen plan-authored
defects in PR A.

### 1. No watcher condition pre-mortem needs can fire

`automation/watcher-engine.ts:86` returns `null` for every `condition_type` other than
`alert_fired`, and that condition queries `item WHERE type = 'alert'`
(`watcher-engine.ts:106-108`). **Nothing in the repository indexes an item of type `alert`.**
PagerDuty indexes `type: "incident"` (`connectors/pagerduty-sync.ts:89`); deployments index
`type: "deployment"`.

So the 2026-08-09 design's premise — *"only risks with a genuine watchable condition produce a
watcher — incident coupling and deploy failure"* — is false as written. A watcher pre-mortem
created would never fire **even after the user armed it**, and the brief's arming command would be
advice to do something inert. That is the same shipped-but-unreachable shape PR B exists to fix.

**Resolution: PR B is split in two, and the conditions land first.**

### 2. `insertWatcher` is a bare `INSERT`, not insert-if-absent

`automation/watcher-store.ts:38` executes a plain `INSERT INTO watcher`. Watcher rule 2 in the
2026-08-09 design ("insert-if-absent; never update `enabled`") therefore cannot be satisfied by
calling it — with a content-derived id, the second `pre-mortem PROJ-120` run raises a primary-key
constraint error instead of quietly doing nothing.

### 3. Deployment status has three shapes, only one of which is a deploy outcome

| Producer | Status field | Usable for `deploy_failed`? |
|---|---|---|
| `deployment/annotate.ts:174` (CI, `POST /v1/deployments`) | `metadata.conclusion` ∈ success / failure / cancelled / … | **yes** |
| `connectors/vercel-deployment-mapping.ts:72` | `metadata.state` (Vercel's own vocabulary) | no — different key, different vocabulary |
| `connectors/prefect-deployment-mapping.ts` | none | no — it indexes deployment *definitions*, not runs; there is no outcome to key on |

`deploy_failed` therefore covers **CI-annotated deployments only**. This is stated in the condition's
description and in every brief that proposes such a watcher — not silently absorbed.

---

## PR B1 — two real watcher conditions

**Scope:** `packages/gateway/src/automation/watcher-engine.ts` plus its validation seam. Small,
self-contained, and worth landing on its own merits: the automation subsystem advertising one
condition type that matches an item type nothing produces is a gap independent of pre-mortem.

**Shape.** Replace the hardcoded `condition_type !== "alert_fired"` guard with a **condition-kind
table** mapping each condition type to its item type and optional extra predicate. Everything
downstream is reused unchanged: the `service` filter, the `since = last_checked_at ?? created_at`
window, the `LIMIT 5`, the optional graph predicate, and the summary/snapshot shape.

| Condition | Matches | Coverage |
|---|---|---|
| `alert_fired` | `item.type = 'alert'` | unchanged. Nothing indexes `alert` today; this is the status quo being preserved, not a regression being introduced |
| `incident_opened` | `item.type = 'incident'` | PagerDuty. Real — fires today |
| `deploy_failed` | `item.type = 'deployment'` AND `json_extract(metadata, '$.conclusion') = 'failure'` | CI-annotated deploys only (see table above) |

A table rather than an if-chain because it makes the set of firable conditions a single readable
SSoT: "which conditions can actually fire" was unanswerable here without grepping three files, and a
future condition should be a row, not a branch.

**Validation — closing a pre-existing hole while we are here.** `watcher.create`
(`ipc/automation-rpc.ts:122`) passes `conditionType` straight through as an unvalidated string, so a
watcher with a nonsense condition type is accepted today and then silently never fires. Neither
`watcher.validateCondition` (`automation-rpc.ts:74-87`, which validates the **graph predicate** only)
nor `watcher.listCandidateRelations` (graph relations only) looks at it. B1 validates `conditionType`
against the condition-kind table and rejects an unknown kind with `-32602`.

This is deliberate scope, not creep: the table's whole purpose is to be the single answer to "which
conditions can fire", and a creation path that bypasses it would leave that answer wrong the moment
it shipped. Bounded to a membership check — no other change to `watcher.create` semantics.

**Testing.**

- One evaluator test per condition, seeding **real `item` rows**, asserting fire and no-fire.
- An unknown `condition_type` still returns `null`.
- The `service` filter and the graph predicate still apply to the new kinds.
- A Vercel-shaped deployment row (status in `metadata.state`, no `conclusion`) does **not** match
  `deploy_failed` — the stated coverage limit enforced by a test, not by a comment.
- `watcher.create` rejects an unknown `conditionType` with `-32602`, and accepts all three known
  kinds.

**Not in B1:** no migration, no new security invariant, no HTTP route, no Tauri change, no change to
the `watcher.*` IPC method set.

---

## PR B2 — the agent

Everything in the 2026-08-09 design's *Request path*, *Watchers*, *Honesty rules*, *Failure modes*
and *Testing* sections holds. The amendments:

**Watcher insertion gets a store helper.** Add `insertWatcherIfAbsent` to
`automation/watcher-store.ts`: select by id, insert only when absent, never write `enabled` on an
existing row. Rules 1 (content-derived id = hash(epic item id, risk kind, service)) and 3
(`premortem_watcher_proposal` as the deliberate-deletion tombstone) are unchanged.

**The risk → condition mapping is concrete.** Incident coupling proposes an `incident_opened`
watcher filtered to the service; deploy failure proposes a `deploy_failed` watcher filtered to the
service, and the brief states the CI-annotated-only limit alongside it. Cycle time, size overrun and
review drag still propose nothing, rather than a contrived condition.

**Jira-only, and narrower than "Jira".** Every brief states it. Discovery keys on
`metadata.issue_type = 'Epic'`, written only by `connectors/jira-sync.ts`; `linear-sync.ts` never
writes it and **no `linear:project` items are indexed at all**, so there is no Linear epic-shaped row
to find. Within Jira, `metadata.parent_key` is populated only for team-managed projects, so a closed
company-managed epic resolves to zero affected services and yields no theme — silently, by design,
not as an error.

**Surface.**

- `packages/gateway/src/agents/premortem.ts` — the thirteenth built-in agent (the agents directory
  currently holds twelve standalone agents plus the `why-peek` companion).
- `packages/cli/src/commands/pre-mortem.ts` — `nimbus pre-mortem <epic-ref> [--service <name>]…
  [--json] [--refresh]`, unknown flags hard-rejected, matching `glossary` / `decisions` / `owners`.
- `packages/ui/src-tauri/src/gateway_bridge.rs` — `agents.premortem` added to `ALLOWED_METHODS`,
  **104 → 105**, with the `gateway_bridge.rs:549` count assertion updated (I7). `premortem.refresh`
  stays unexposed.
- No migration, no new security invariant, no HTTP write route.

**Documentation, landing in the same commits as the wiring.**

- `.claude/commands/nimbus-agent-patterns.md` — its Agent Shape Invariant states that every built-in
  agent is read-only with no write tools in scope. pre-mortem writes paused watcher rows. Amend it
  deliberately rather than leave drift for the next author.
- `docs/roadmap.md` — the S1 row and the Phase 7 Wave 5 entry, which currently describe pre-mortem as
  both read-only *and* scheduling watchers.
- `docs/cli-reference.md`, `docs/CHANGELOG.md`, `docs/architecture.md` (V53 tables + both IPC
  methods).

**Testing.** Pure-function unit tests per structural calculator; cohort selection and IDF ranking;
theme matching; the two watcher rules (id determinism across re-runs, and an armed watcher surviving
a re-run **un-paused**) plus the suppression rule; and
`packages/gateway/test/e2e/scenarios/premortem.e2e.test.ts` asserting the brief's sections, the
`premortem.briefReady` notification, and zero HITL fires. Graph fixtures are seeded through the real
`upsertGraphEntity` — never a hand-rolled `INSERT INTO graph_entity`, which hid three separate
defects in PR A.

---

## Sequencing

**B1 then B2.** B2's brief tells the user to arm a watcher; that instruction is only true once B1 has
landed. Building in the other order would ship, for one release cycle, exactly the claim this delta
exists to remove.

## Unchanged from the 2026-08-09 design

Out of scope remains out of scope: semantic cohort selection, a project-based fallback cohort,
indexing Jira components/labels, indexing ticket comments, armed watchers and ChatOps routing,
federated cross-team cohorts, a shared harness for the four extraction passes, and a deterministic
no-LLM theme-discovery fallback.
