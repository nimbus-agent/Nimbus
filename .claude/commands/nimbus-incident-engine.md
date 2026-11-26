---
name: nimbus-incident-engine
description: >
  Phase 10 incident engine (IC1–IC10) — `packages/gateway/src/incident/`: per-item state history (`item_history`, V94,
  `--at` point-in-time queries), automatic assembly of one versioned `incident_record` per trigger (V100; PagerDuty, Jira
  Service Management, Sentry, Monte Carlo, Bigeye), the timeline and cascade ranking, remediation PROPOSALS (V102) and the
  owner's `nimbus incident remediate|undo`, the radar and anomaly findings (V103), owner-authored runbooks (V104), post-mortem
  and update drafts, `--live` investigation. Invariant `I57` (a) read-only assembly, (b) the engine proposes and never runs,
  (c) runbooks; static `D46(a)`–`(h)`; `ipc/incident-rpc.ts`, `nimbus incident *`. Use when touching `incident/`,
  `runbook/`, `investigation/`, `agents/_lib/incident*.ts`, `ipc/incident-rpc*.ts`, `item_history`, `[incident]` or
  `[[incident.expect]]` config, the pushed on-call brief's record lane, or asking why a record has no version, a proposal
  was not offered, an action ran or was refused, or a D46 rule failed. Pairs with `nimbus-connector-writes`.
---

# Nimbus incident engine (I57 / D46)

## Why This Skill Exists

The engine turns the local index into an incident record with no model and no network, then PROPOSES what to do; a person runs
anything that changes the world. The three halves of I57 are the discipline: assembly is inert (a), proposals never execute
themselves (b), runbooks run one owner-asked step at a time (c). Most mistakes are an "inert" directory acquiring a capability.

## Slices and where they live

| Slice | What | Code |
|---|---|---|
| IC1 | `item_history` (V94): changes to an allowlist of state keys plus `__created`/`__deleted`, written inside `upsertIndexedItem`'s savepoint; `--at <time>` on `ask`/`query`/`search`; `[index] history_retention_days` | `index/item-history.ts`, `item-history-keys.ts`, `item-history-at.ts`, `item-history-retention.ts`, `item-history-v94-sql.ts`; static D46(b) `item-history-confined` |
| IC2 | alert sources (`jira:alert`), `resolved_at_ms`, `[ci.service.<id>]` bindings (`jsm_alert_tags`, `sentry_projects`, `data_models`, `depends_on`), V96 | sync code + `metrics/` resolver |
| IC3 | assembly: `incident_record` + `incident_record_version` (V100) after each trigger-service sync; lanes (binding, change, chat, prior, concurrent, data, oncall, history) | `incident/incident-engine.ts` (deps type IS the confinement: no dispatcher, executor, egress, vault, model), `assemble.ts`, `lanes/`, `incident-store.ts`, `trigger-sources.ts`, `incident-retention.ts`, `incident-erasure.ts` |
| IC4 | timeline, cascade ranking, the incident LINK on actions, `nimbus audit replay` | `incident/timeline.ts`, `cascade.ts`, `incident-link-mint.ts`, `engine/incident-link.ts`; D46(e) |
| IC5a/b | remediation proposals (V102 `incident_proposal`), `remediate`/`undo`/`advisory`, approve-from-push CLI | `incident/proposals.ts` (pure, index-only), `proposal-store.ts`, `remediation.ts` (the ONE action builder, D46(c)), `ipc/incident-undo.ts`, `connector-writes/reversibility.ts` |
| IC6 | owner runbooks (V104 `incident_runbook_step`) | `runbook/` (`runbook-loader.ts`, `runbook-run.ts`, `runbook-interpolate.ts`), `engine/runbook-read.ts`, `incident/runbook-step-store.ts`; D46(g) |
| IC7 | post-mortem draft/push, update drafts and the scribe, technical debt | `incident/postmortem-brief.ts`, `agents/_lib/incident-postmortem-render.ts`, `ipc/incident-update-rpc.ts`, `debt/` (the only child process: `git`, outside `incident/`) |
| IC8 | expectation radar, anomaly baseline (V103 `incident_finding`, `anomaly_baseline`) | `incident/radar.ts`, `anomaly-baseline.ts`, `predict-pass.ts`, `finding-store.ts`; D46(f) |
| IC9 | handoff records, `incident investigate` (index-only), `--live` Sentry read, `--synthesize` | `incident/investigate.ts`, `handoff-records.ts`, `investigation/investigation-live.ts`, `engine/investigate-read.ts`; D46(h) |
| IC10 | desktop Incidents page (read-only) | `packages/ui/` page; renderer reaches exactly `incident.list|get|timeline|proposals|findings` |

## What is read-only, what only proposes, what the owner runs

- **Read-only (I57 a):** assembly, lanes, store, retention, erasure, `agents/_lib/incident*.ts` render. D46(a) rule ids
  `incident-forbidden-import` and `incident-no-network`: no import of `chatops/`, `egress/`, `federation/`, `share/`, no
  `connectors/` value import, no network primitive. The one carve-out is `incident/remediation.ts`, governed by D46(c).
  A non-PagerDuty record is pushed only with the three-part proof inside `oncall-push/push-record-selector.ts`
  (`selectRecordPushCandidates`); erasing a service or pruning a record deletes the pushed briefs in the same transaction.
- **Proposes (I57 b):** `proposals.ts` derives proposals (roll back the correlated deploy, repeat the last same-service action,
  acknowledge/close the alert) with evidence, blast radius, fixed-weight confidence, the fixed "no dry run available" line and
  the reversibility label FIRST. Never delegated (I20), never standing-approved (I55), never offered to the model (I53), refused in
  advisory mode (`nimbus incident advisory on`) before any claim, read or prompt.
- **Owner runs:** `nimbus incident remediate <id> [--pick n] [--dry-run]` and `undo [<act_id>]` on a `cli`/`ui`
  connection: the stored proposal is claimed by ONE conditional UPDATE, then ONE `execute()` through
  `buildRemediationExecutor` (`engine/run-ask.ts`: no delegation, no standing rule, human-only consent, before-state, typed
  confirmation for Wave 4) as an incident-linked action with a gateway-set `engineProposal`. Runbook steps (I57 c): `incident runbook
  <id> [--runbook] [--step N | --done N]`, one step per call on the same executor; parameters interpolate only typed record fields matching
  `^[A-Za-z0-9._:/@+-]{1,256}$`; an action step is refused in advisory mode; a read step resolves only to a read of its service.
  `--live` investigation (`incident.investigateLive`, `cli` only) is the one backend read, gated and ledgered, outside `incident/**`.
- **Drafts:** `postmortem` (deterministic; `--synthesize` and `--push confluence|notion` are explicit; push uses `buildOwnerPushExecutor`),
  `update` (`--send slack:|teams:`; `[incident.scribe] enabled` only queues METADATA drafts, never posts).

## IPC and CLI

`ipc/incident-rpc.ts` (params in `incident-rpc-params.ts`) serves `incident.list|get|assemble|timeline|investigate|proposals|remediate|dryRun|undo|advisory|advisorySet|debt|findings|runbooks|runbookRun|runbookDone`;
`incident-update-rpc.ts` `incident.update|updateSend|updateQueue`, `investigation-rpc.ts` `incident.investigateLive`. Every handler serves only a connection that DECLARED `cli` or `ui`; the `incident`
namespace is off the LAN (`FORBIDDEN_OVER_LAN`) and mostly off the Tauri allowlist (renderer: the five reads only, I7). CLI:
`packages/cli/src/commands/incident*.ts` (`incident.ts`, `incident-remediate.ts`, `incident-runbook.ts`, `incident-update.ts`, `incident-postmortem.ts`, `incident-debt.ts`), `oncall-pushed.ts`.
Config: `[incident]` (`enabled`, `severities`, `bigeye_sla_statuses`, `retention_days`, `anomaly_z`, scribe) in `config/incident-toml.ts`; docs `docs/cli-reference.md` § `nimbus incident`.

## Static D46

(a) inert assembly; (b) `item_history` written only by its module; (c) engine-proposed actions built only in `incident/remediation.ts`;
(d) record tables and pushed briefs written only by their owner; (e) the incident link minted only in the listed owners (list now includes
`runbook/runbook-run.ts` and the owner push/update callers); (f) `incident_finding`/`anomaly_baseline` written only in `incident/finding-store.ts`;
(g) runbook step key, `incident_runbook_step` writes, `runbookReadActionType`, the runbook folder read; (h) the live investigation read confined to
`investigation/investigation-live.ts` and its wiring. Rules live in `scripts/structure-audit/invariants/` (`briefing-incident-workflow-toolgen.ts`,
`share-sync-index-incident.ts`, `incident-runbook-client-kinds.ts`, `investigate-live.ts`); each is a text scan, so composed identifiers evade it.
Behaviour pins: `packages/gateway/src/security-invariants/i57-incident-engine.test.ts`, `i57-incident-live-investigate.test.ts`.

## Checklist for changing this area

1. New lane/input: read the index only; no import the D46(a) list forbids. Need a connector read? It goes outside `incident/` (see `investigation/`) and gets its own rule.
2. New proposal kind: derive in `proposals.ts` (pure); the action is built only in `remediation.ts`; the row needs a `reversibility` entry (`nimbus-connector-writes`).
3. A new table: migration (`nimbus-db-migrations`), single writer module, a D46 write-verb rule with a red fixture, erasure (`incident-erasure.ts`) and retention.
4. A new IPC method: owner kinds only, off the LAN, allowlist decision (`nimbus-tauri-allowlist`); a renderer-callable method must not be able to approve or run.
5. Record changes: an unchanged factual core makes NO new version; keep the 64 KiB record cap and one-hour failure backoff in mind.
6. Docs in the same PR: `docs/SECURITY-INVARIANTS.md` I57, `docs/cli-reference.md`, `docs/schema-reference.md`, `docs/roadmap.md`, `CLAUDE.md`/`GEMINI.md`.

## Pitfalls

- `[incident] enabled = false` stops only automatic assembly; `show`, the push's own assembly (a page is never dropped), retention and erasure keep working.
- A confidence is a printed fixed-weight number, not a probability; "reversible" means the declared inverse can be run, not that the world is as before.
- `--at` reconstructs existence and tracked state keys only; titles and bodies are as of now; history starts at the V94 upgrade, so early T shows gaps.
- ChatOps has no Remediate action by owner ruling (the ChatOps approve flow is the I20 delegation path, which I57 (b) forbids for an engine proposal).
- Notion post-mortem push can take two approvals and is refused over 100 blocks; Bigeye has no closed state, so no Bigeye post-mortem.
- `debt/git-history.ts` spawns `git` (constant argv, `extensionProcessEnv`); never move that into `incident/`.
