---
name: nimbus-standing-workflows
description: >
  Phase 10 standing approvals and deterministic workflows (SA1–SA5): saved workflows with `query` and `write` steps and `when`
  guards, standing approval rules (`standing_rule`/`standing_rule_fire`, V88; `nimbus approve add|list|pause|revoke|dismiss`),
  scheduled unattended workflows (V89; `automation/workflow-scheduler.ts`, `automation/cron.ts`, `blocked_on_approval`,
  `nimbus workflow resume`, `nimbus schedule list`), approval learning (V90 suggestions), the `approvalPhase` call to
  `standingRuleStep` (`engine/standing-rule-step.ts`), and the `standing_approved` hitl status (V87, I4). Invariant `I55`,
  static `D44(a)`–`(g)`; signed workflow import/export is `I59`/`D50` (pointer only). Use when touching `standing/`,
  `automation/workflow-*.ts`, `engine/standing-rule-step.ts`, `ipc/standing-rpc.ts`, `workflow-write-step.ts`, `[standing]` config,
  `nimbus approve`/`nimbus workflow`, adding a workflow step kind or guard, widening which writes a rule may cover, or asking why a
  scheduled workflow stopped, a rule did not fire, or a write still prompted. Executor phases are shared with `nimbus-connector-writes`.
---

# Nimbus standing approvals and deterministic workflows (I55 / D44)

## Why This Skill Exists

A recurring write the owner has approved once should run without a prompt, but only inside an exact, narrow, owner-created scope,
and never on anything a model or an outside caller chose. Everything here exists to keep a rule from covering more than the owner
saw. The security core is one function, `standingRuleStep`, called from one place in the executor; the rest is what builds its inputs.

## Workflow steps (SA2) — `automation/`

A saved workflow (`workflow-store.ts`, V9) holds `run` (model prompt), `query` and `write` steps (`workflow-steps.ts`, types
`RunWorkflowStep | QueryWorkflowStep | WriteWorkflowStep`). A `query` is a closed declared form (`declared-query.ts`: service, type, bound
predicates, plain select column, required limit <= `QUERY_LIMIT_MAX` 500) run as one bound SELECT over the local index. A `write` names ONE
wave 2 or 3 connector write and takes each input as a constant or an id an earlier query selected, never a `run` step's output. Validated at
`workflow.save` and again at every run. A workflow with no `run` step needs no model. Every write goes through
`buildWorkflowWriteExecutor` (`engine/run-ask.ts`, consent bound to the run's client, no delegation, before-state runner), so the
owner is asked on every one unless a rule applies. The action carries a gateway-set `provenance` (`kind: "owner_workflow"`: workflow id,
SHA-256 of the steps, step index, run id, trigger) built only in `automation/workflow-write-step.ts` (D44(a)); a `trigger` or `provenance` param is refused
(-32602), and the IPC dispatcher derives the trigger from the connection's declared client kind (`cli` -> `owner_cli`, `ui` -> `owner_ui`).
`when` guards (`workflow-guard.ts`, `GuardOp`, up to `MAX_GUARD_COMPARISONS` 4 = AND): a false guard records `not_taken`, asks nobody, dispatches nothing; D44(g) keeps the guard module out of the approval check.

## Standing rules (SA3)

`nimbus approve add --workflow <name> --step <label|n> [--days N] [--max N] [--window "Mon-Fri 06:00-10:00 Europe/Berlin"]` (CLI: `commands/approve.ts`).
The gateway derives the scope from the STORED workflow step (`standing/standing-rule-derive.ts`); the caller names only workflow and step.
Rule = ONE write step of ONE workflow at one content hash, expiry 1–90 days (30), ceiling 1–500 actions (100), optional weekday/time window
(windows cannot cross midnight). Create and resume (`standing.create|resume`, HITL types `standing.rule.create|resume`, never delegable)
are the LOCAL owner's approval on a `cli` connection through an executor with no delegation, honoured only for `answerSource: "human"`
(`--yes`, scripts and old clients are refused). Pause, revoke and dismiss narrow and need no approval. Store: `standing/standing-rule-store.ts`
(V88; the only file naming the tables, D44(b)); RPC `ipc/standing-rpc.ts` (whole `standing` namespace off the LAN; renderer allowlist names
`standing.list|show|fires|pause|revoke|suggestions|dismissSuggestion` only). `[standing]` config: `config/standing-toml.ts` (`standing_approvals` lockoff; absent = off).

`standingRuleStep` runs once in `approvalPhase`, after the confirm phase and BEFORE a delegate or the owner is asked, in nine named steps
(policy; `owner_workflow` provenance with no `origin`; every row of the type wave 2 or 3 and not bound/typed-confirm/refused/never-offered;
payload exactly the row's tool and input; every field a constant or declared-query id; a live rule for that workflow id, hash, step, tool, in window;
scope and constants equal; the shared door refusals `modelWriteRefusal` on the actual input; `claimFire`: one conditional UPDATE plus the fire insert in
ONE transaction). A hit is recorded `standing_approved` in the audit row and the egress row (both carry rule and fire ids, appended BEFORE dispatch);
`nimbus audit standing [<rule>]` lists fires. The executor's 8th constructor parameter `ToolExecutorExtras = { beforeState?, standingRules? }`;
only the two workflow write executors supply `standingRules` (D44(e)). A failed append after a claim dispatches nothing and the claim stays consumed.
A rule may cover a guarded write only when every comparison is false at count zero (`guardRequiresPresence`: rule creation, resume, learning).

## Scheduled workflows (SA4)

`nimbus workflow save <name> --file <path> --schedule "<cron>" [--tz <zone>]`; accepted only from a connection that declared `cli` or `ui`
(`ERR_SCHEDULE_LOCAL_ONLY`), refused for a workflow with a `run` step (OR-10-8). `automation/cron.ts` (five fields, lists/ranges/steps, four `@` macros; nothing
that can fire twice within five minutes). `automation/workflow-scheduler.ts` ticks every 60 s on an injected clock, runs due workflows oldest first,
one run per workflow (`workflow-run-lock.ts`), catches up ONCE for a miss of at most an hour, otherwise records a `skipped` run. It is the only
producer of trigger `schedule` and is handed a FACTORY for `buildUnattendedWorkflowWriteExecutor`, so it holds no client id or consent
coordinator (D44(d)); both builders call the private `newWorkflowWriteExecutor`. `approvalPhase` reads `this.unattended` after `standingRuleStep` and before a delegate: no
rule -> `UNATTENDED_NO_RULE_REASON`, nothing dispatched, the run becomes `blocked_on_approval` (never pruned), ONE OS notification, later fires skipped until
the owner acts. `nimbus workflow resume <runId> [--discard]` (`workflow.resume`, `cli`/`ui` only, off the LAN, `ERR_WORKFLOW_CHANGED` if the hash moved) continues on
the owner's attended executor; `nimbus schedule list` (`workflow.scheduleList`). A demo gateway builds no scheduler (I41).

## Approval learning (SA5)

`standing/approval-learning.ts` `learnFromStepRun`, called only from `automation/workflow-runner.ts` after an owner-started, non-dry write step, reads that
run's audit rows. A run COUNTS when at least one action was asked and every asked action was approved with `answerSource: "human"`; a human rejection resets
the streak; everything else changes nothing. At `[standing] suggest_after` (default 5, 3–50, 0 = off) a suggestion (V90 `standing_streak`, `standing_suggestion`, store only
`standing/standing-suggestion-store.ts`, D44(f)) is recorded unless a live rule covers the step, one is open, or the owner dismissed one for this workflow hash. A suggestion
never creates, widens or approves anything; `nimbus approve add --from-suggestion <id>` / `standing.create { fromSuggestion }` runs the same human approval.

## Signed import/export (pointer)

`nimbus workflow export|import` (I59, D50): `automation/workflow-import.ts`, `workflow-bundle.ts`, V101; import creates and inherits no rule and no schedule unless asked in the same approval.

## Where the tests are

`packages/gateway/src/security-invariants/i55-standing-rule.test.ts` (authoritative; D44 order pins are textual), `engine/standing-rule-step.test.ts`,
`test/integration/automation/standing-schedule.acceptance.test.ts` (the Phase 10 acceptance criterion), `i59-workflow-import.test.ts`.

## Checklist for changing this area

1. A new step kind or field source: validate at save AND at every run; keep it out of `standingRuleStep`'s input unless it is a constant or declared-query id.
2. Widening which writes a rule may cover (e.g. Wave 4, bound, typed-confirm) is a security change: it needs an owner ruling, an I55 text change and a D44 update; today those are never eligible.
3. Any new executor that approves by rule must be built only in `newWorkflowWriteExecutor` (D44(e)); never pass `standingRules:` elsewhere.
4. A new `answerSource` or client kind consumer must treat the value as client-reported on the local socket.
5. New table or column: `nimbus-db-migrations`; writer confined with a D44 clause and a red fixture; `standing` stays LAN-forbidden.
6. Update `docs/SECURITY-INVARIANTS.md` I55, `docs/cli-reference.md`, `docs/schema-reference.md`, `docs/roadmap.md`, `CLAUDE.md`/`GEMINI.md` in the same PR.

## Pitfalls

- A rule fires only on an owner-started or scheduled run with provenance; an MCP, model, ChatOps or federated action never matches (`origin` present).
- Declared-query selection residual and index staleness: a failed sync reads as zero, hence the guard rule above.
- A step whose audit payloads exceed the 4 KiB audit cap earns no suggestion (it cannot earn a wrong one).
- A scheduled workflow with a mostly-false guard still records a `done` run per fire.
- `workflow run` / `nimbus run` declare kind `cli`; a run that declares nothing carries no provenance (every write still prompts).
- A rule window cannot cross midnight; no schedule under five minutes; one catch-up fire.
