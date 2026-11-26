---
name: nimbus-connector-writes
description: >
  Phase 9.7 connector writes — the one write-row table (`packages/gateway/src/connectors/connector-writes/`,
  `CONNECTOR_WRITE_ROWS`, the generated `manifest.generated.ts`), waves 2–4, and every door that reaches a row:
  the owner's opt-in `nimbus connector writes enable|disable|status` (V83 enablement, V84 approved tool ids, V85
  iac grants, V86 k8s grants), the model door (invariant `I53`, static `D39`; `engine/connector-write-agent-tools.ts`,
  `model-write-source.ts`, `model-write-refusals.ts`), before-state readers and guards (`D40`, `engine/before-state.ts`),
  Wave 4 type-to-confirm (`D41`, `confirm.ts`, `requestConfirmedApproval`), bound writes with a gateway-run prepare step
  (`I54`, `D42`/`D43`: the two commits, the iac rows, the Kubernetes apply), `MODEL_NEVER_OFFERED_TOOL_IDS`, the
  reversibility table, and federation refusal (`I26`). Use when adding or changing a write row, giving a row a preview,
  before-state, confirm text, guard or bound step, making a write model-offerable, touching `connector writes` CLI or its
  IPC (`connector.writesEnable|Disable|Status`), a `*.before.read` / `*.write.prepare` action, or asking why a write is
  refused, not offered, shows no `Before:` block, or fails the manifest/row sync tests. Agent-door (MCP) reach of the same
  rows is in `nimbus-mcp-sink`.
---

# Nimbus connector writes (Phase 9.7: I53 / I54 / D39–D43)

## Why This Skill Exists

A connector write is the one place Nimbus changes a remote system. Every write is one row in ONE table, runs only behind
the local owner's HITL gate (I2, I26), is refused over federation, and reaches the model (or an outside agent) only through
the same executor with a typed preview, a before-state and, for Wave 4, a typed confirmation. The table, not code
scattered across doors, decides what is offerable. Counts drift: derive them from `CONNECTOR_WRITE_ROWS`, never copy a number.

## The row table

| Piece | Where |
|---|---|
| Row type (`ConnectorWriteRow`: `toolId`, `actionType`, `transport`, `wave` 2/3/4, `preview`, `before`, `confirm`, `bound`, `refuse`, `reversibility`) | `connectors/connector-writes/types.ts` |
| The table: one file per family, concatenated and passed through `applyReversibility` | `connector-writes/index.ts` (`messaging.ts`, `tickets.ts`, `knowledge.ts`, `mail-calendar.ts`, `files.ts`, `vcs-ci.ts`, `incident.ts`, `flags.ts`, `cloud-infra.ts`, `deploy-mobile.ts`, `warehouse-bi.ts`, `gitops-ml.ts`) |
| Builders that attach one facet each | `withPreview`, `withBefore`, `withConfirm`, `withBound`, `withRefusal` (`types.ts`) |
| Generated manifest of every write tool the installed `@nimbus-dev/connectors` registers | `manifest.generated.ts` (`bun run gen:connector-write-manifest`, script `scripts/gen-connector-write-manifest.ts`); tied to the table and to the package by `manifest.sync.test.ts` and `rows.test.ts` |
| Lookups (`isConnectorWriteToolId`, `isConnectorWriteOrPrepareToolId`, `connectorWriteByActionType`) | `connectors/connector-write-registry.ts` |
| Dispatch (credential-aware `write` transport vs `mesh`) | `connectors/connector-write-dispatch.ts`, `connector-write-transport.ts`, `connectors/registry.ts` |

Waves: 2 (messaging, comments, issues, drafts, pages, calendar/Drive creates), 3 (moves, PR/incident, flags, branch/PR/MR create and update),
4 (merges, deploys, pipelines, infra, Kubernetes, deletes; typed confirmation on every door). A tool the connector
registers as a read but that mutates carries `registeredAs: "read"`. Gate-confined ids (ChatOps D17, tribal KB D19) are
left out of the manifest.

## The owner's opt-in (the model door's switch)

`nimbus connector writes enable <service> [--wave 2|3|4]` (default 3; Wave 4 needs `--wave 4`), `disable <service>`,
`status [--json]`; backed by CLI-only, LAN-forbidden `connector.writesEnable|writesDisable|writesStatus`, not on the Tauri
allowlist. OFF for every connector. Enabling asks the owner at the terminal (human answer only) and stores, per service, a wave
and the tool ids the prompt listed as offerable (V84 `approved_tool_ids`): the model is offered only those, so an older
opt-in offers nothing new until re-run. Store: `connector-writes/enablement-store.ts` (V83 `connector_write_enablement`; the
handler `ipc/connector-rpc-handlers/model-writes-grants.ts`; prompt text `enable-prompt.ts`). `enable iac` also takes
`--workdir/--cloud/--region/--net` (V85 `iac-grants.ts`); `enable kubernetes --grant <ns>@<context>` (V86 `k8s-grants.ts`);
`enable <service> --door agent [--approve ...]` is the agent door's list (V97, see `nimbus-mcp-sink`). `enable` is itself a
HITL type (`connector.writes.enable`, never delegable, I20); a signed org policy `connector_write_model_access = false`
refuses it (`ERR_CONNECTOR_WRITES_POLICY`). The Obsidian append's approval is also the sandbox write grant (I15).

## The model door (I53, D39)

A write reaches the model only on the local owner's non-demo `cli`/`ui` turn (`CONNECTOR_WRITE_OFFER_BY_KIND`), for a service
enabled up to the row's wave, a tool approved by name, policy allowing it, and `isModelOfferableRow(row)`
(`connector-writes/model-offerable.ts`): never a row in `MODEL_NEVER_OFFERED_REASONS`/`MODEL_NEVER_OFFERED_TOOL_IDS` (the seven
mail sends, the Bitbucket merge, owner-only iac rows, the four `az`/`gcloud`-read cloud rows, the pod delete; add a row there
WITH a reason); otherwise a typed `preview`, and for wave 4 also (`before` or `bound`) and a `confirm` target.

- Builder: ONLY `engine/connector-write-agent-tools.ts` builds model tools from the write table (D39); source:
  `connector-writes/model-write-source.ts` (`enabledAndOfferable`, `createModelWriteToolSource`); wired in `engine/run-ask.ts`.
- Every call is an `origin: "model"` action through an executor built WITHOUT delegation: `buildModelWriteExecutor` and
  `buildAgentWriteExecutor` are one private maker, `newDoorExecutor` (`engine/run-ask.ts`), so the model door and the MCP act door cannot drift.
  Re-checked per call; a decline returns a fixed result (`DECLINED_RESULT_TEXT`); a connector write tool runs only under its own action type (I3).
- Destination refusals (`connector-writes/model-write-refusals.ts`, `modelWriteRefusal`, run before any prompt on BOTH the
  model and the agent door): a ChatOps channel/DM, broadcast mentions, GitLab quick actions and scoped labels, remote content in
  draft/page/note/markup bodies (`remote-content.ts`), calendar zone and iCloud control characters, `null` optionals,
  the tribal KB (`knowledge.ts`), the commit path/credential rules (`commit-paths.ts`), deploy rules (`deploy-refusals.ts`), Kubernetes RBAC/privileged kinds. A refusal returns `{ refused }`; nothing is prompted.
- `[personalization]` `hide_tools`/`tool_order` apply after the offer and can only remove or reorder (`engine/personalization.ts`).

## Before-state readers and guards (D40)

A row's `before` reader (`BeforeStateReader`, `before-reader.ts`, `before-select.ts`) reads the target's current state for the
prompt's `Before:` block. Runner: `engine/before-state.ts` `createBeforeStateRunner`, as one or two `<service>.before.read` actions
through the same gate (audited, I29-ledgered, refused rather than prompted if approval would be needed), resolved by the
dispatcher only to a READ of the same connector, 5 s together (`BEFORE_STATE_TIMEOUT_MS`), shown to the owner only, never to the model.
A reader may carry a `guard` that refuses the write inside the gate before any prompt, fail closed. A Wave 4 model write whose
state cannot be read is refused (`WAVE4_BEFORE_REFUSAL`). Readers are grouped by family (`gitops-readers.ts`, `cloud-readers.ts`, `deploy-readers.ts`, `delete-readers.ts`, `vcs-ci-readers.ts`).
D40: the `.before.read` literal only in `engine/before-state.ts` and `connectors/registry.ts`; `createBeforeStateRunner` only in `run-ask.ts`'s door, workflow and remediation makers.
`captures` on a reader supply the values a reversible row's inverse needs (see Reversibility).

## Wave 4 type-to-confirm (D41, I20)

Every Wave 4 write, on EVERY door, is approved only by the owner TYPING its confirm text, `<service>/<rendered template>`
(`connector-writes/confirm.ts` `renderConfirmText`, `confirm-template.ts`). ONE place compares it: `engine/executor.ts`
(`requestConfirmedApproval`, never `requestApproval`); channels carry the text and never judge it. `--yes` and scripted consent deny it; a channel that
cannot collect text denies it (ChatOps uses a Slack modal / Teams card input, D0c, resource owner only). Phase order in
`resolveHitlApproval`: `captureBeforePhase` → `preflightPhase` → `preparePhase` → `renderConfirmPhase` → `approvalPhase`.
A delegate's Wave 4 approval counts only with typed text equal to the confirm text. Confirm templates constrain a field only by
the literal text that follows it; secrets are never a placeholder. `engine/executor-confirm.test.ts` pins the behaviour.

## Bound writes and prepare steps (I54, D42, D43)

A row declaring `bound` is dispatched only with values its own gate-run prepare step produced and the gateway injected:
`preparePhase` runs the row's `<service>.write.prepare` read (a member of `PREPARE_TOOL_IDS`, `prepare-tools.ts`) through the
executor's own gate (`engine/prepare-step.ts`: `runPrepareStep`, `injectBoundFields`, `boundInputRefusal`), after the
before-state and before the confirm text. A caller-supplied bound field is refused before any read; the audit row carries SHA-256s, never file text.
Rows: the two commits (`commit-bound.ts`, `commit-limits.ts`, `diff.ts`: the gateway renders the unified diff itself, in full or refuses),
Terraform apply/destroy/refresh-only and CloudFormation deploy (`iac-bound.ts`, `iac-plan-preview.ts`, `iac-grants.ts`; five per-run sandbox
profiles built only in `connectors/lazy-mesh/iac-runner.ts`, D43), Kubernetes apply (`k8s-bound.ts`, `k8s-manifest.ts`; settled by `engine/k8s-settle.ts`, D42(h)).
Pulumi apply carries `refuse`. `ChatOps` cannot approve a bound commit. Terraform drift check is the one other prepare caller (`checkTerraformDrift`, D42(i)).

## Reversibility

Declared in ONE table, `connector-writes/reversibility.ts` (`applyReversibility`, `checkReversibilityTable`): `reversible` needs a
`before` reader whose `captures` supply the inverse's inputs and a per-row test; `irreversible` carries a reason; absent = `unknown`.
Used by the incident engine's remediation (see `nimbus-incident-engine`).

## Checklist: adding or changing a write row

1. Bump/verify the `@nimbus-dev/connectors` pin; run `bun run gen:connector-write-manifest`; the tool id must be the bare id the connector registers.
2. Add the row in the family file with `wave`, `actionType` (a HITL type; new types join the frozen set in `engine/executor.ts`, I2).
3. Typed `preview` (`withPreview`; `preview.ts`); mark secret-ish fields so `isSensitiveFieldName` hides them.
4. Wave 4: a `before` reader or `bound` step AND `withConfirm`; otherwise `isModelOfferableRow` is false.
5. Destinations/free text: put a new refusal in a sibling helper module (`model-write-refusals.ts` is locked at its baseline by `audit:file-size`; do not grow it), and extend the `*.sync.test.ts` scans instead of a door-specific check.
6. Reversibility entry if it can be undone; otherwise declare irreversible with a reason.
7. Never offered? add to `MODEL_NEVER_OFFERED_REASONS`. Federation never sees it (`isConnectorWriteOrPrepareToolId`, `federation/invoke-gate.ts`).
8. Tests: `rows.test.ts`, `manifest.sync.test.ts`, the family template test, `confirm-rows.test.ts`, `packages/gateway/src/security-invariants/i53-model-write-door.test.ts` (+ `i54-bound-write.test.ts` for bound).
9. Docs in the same PR: `docs/cli-reference.md` (§ connector writes), `docs/SECURITY-INVARIANTS.md` counts, `docs/roadmap.md`, `CLAUDE.md`/`GEMINI.md`; agent-door effect: `nimbus-mcp-sink`.

## Pitfalls

- Counts in prose go stale; derive from the table. A new row can silently change the agent door's accepted set (it follows the table plus the owner's list).
- Offerable is not enabled: a row is offered only after the owner's approval by name.
- A before-read must be a READ of the same connector; `_latest` readers are not read verbs and need `EXTRA_READ_TOOL_IDS`.
- Do not extract a gate check into a helper to appease Sonar (I35 lesson): split by phase, keep order readable.
- Static rules scan text: dynamically composed identifiers evade them; behaviour tests are authoritative.
