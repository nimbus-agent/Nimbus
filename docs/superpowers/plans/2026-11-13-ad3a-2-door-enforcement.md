# Plan — Agent door AD3a-2: the list counts (`agentOffered` at the gate, suspension on the act path, the deprecation window, Wave 4 and bound rows, I58 and the rest of D49)

Status: DRAFT for review (2026-11-13). **Recommendation: two stacked PRs, both merged before the release PR that ships AD3a.** AD3a-2a (this plan, in full): eligibility at submit, at approval and before dispatch; suspension; the `legacy` flag and its four warnings; routing for Wave 4 and bound rows; the stored code on a `rejected` action; A2 on a real Wave 4 type; invariant I58 and D49(a), (c)-(f); deletion of `AGENT_DOOR_NOT_ENFORCED_NOTICE`; the six review follow-ups. AD3a-2b (in outline at the end): the `capture.describe` gateway method and the `describe_actions` MCP tool.
Spec: `docs/superpowers/specs/2026-11-13-agent-door.md` (approved, round 2): § 2 (OR-AD-2, -3, -5, -7, -9), § 4 (D-AD-5, -6, -7, -9, -10, -14, -15), § 6 (the AD3a row), § 7.2, § 7.3, § 9, § 10 (AD3a bullet), § 11, § 12. Also the AD3a plan `docs/superpowers/plans/2026-11-13-ad3a-door-eligibility.md`: its corrections 7, 8, 9, 12, 16, 18, its "AD3a-2 in outline", and the settled rulings OR-AD-10 to OR-AD-13.
Roadmap rows: Phase 28 *Write parity with the model door* and the open half of *The same prompt* (`docs/roadmap.md:3077-3078`).
Base: AD3a-2 sits on AD3a-1 (PR #1999, branch `dev/asaf/p28-ad3a-1`, head `964bb3060`, 14 commits above `origin/main` `76e145e44`). **Every `file:line` below was read in the worktree `C:\gitrep\Nimbus\.claude\worktrees\p28-ad3a-1`.** Paths are relative to `packages/gateway/src/` unless they start with `packages/`, `scripts/`, `docs/` or `.claude/`.
Numbers re-derived there: `CURRENT_SCHEMA_VERSION` = 97 (`index/local-index.ts:309`; `origin/main` has 96). **No migration is needed**: V97 already has `capture.legacy`, the relaxed error-code CHECK (`length(error_code) <= 64`, `index/agent-door-v97-sql.ts:70`) and no CHECK on `payload_bytes` (`:51`). `docs/SECURITY-INVARIANTS.md:3` says invariants I1–I56 and static rules D10–D49. So AD3a-2 adds **no schema step, invariant I58, and clauses (a), (c), (d), (e), (f) of D49**. I57 is reserved by the incident-engine stream according to the agent-door spec § 6; that reservation is written nowhere in this tree (grep for `I57` in `docs/SECURITY-INVARIANTS.md`, `CLAUDE.md`, `docs/roadmap.md` finds nothing), so it stays UNVERIFIED and Task 0 re-checks it.
Row facts, derived by running the tables read-only (`bun -e` over `connectors/connector-writes/index.ts`, `model-offerable.ts`, `agent-door.ts`, `connectors/proposable-actions.ts`, `engine/executor.ts`): 125 write rows, 124 action types, 109 model-offerable (wave 2: 39, wave 3: 29, wave 4: 41), 16 never offered, 6 bound rows of which 5 are offerable and all 5 are Wave 4, 39 services with an offerable row; 185 HITL types, 185 classified, 47 proposable, 138 denied, 9 `not_yet_offered`. **108 rows are reachable by an agent** (the 109 minus `slack_message_post_dm`, OR-AD-10). Of the 47 proposable types, 40 route to an agent-reachable row and 7 are the mail sends; the 47 are wave 2 (36) and wave 3 (11), none Wave 4. **68 action types become newly reachable** after an enable and an approval by name: 2 at wave 2, 25 at wave 3, 41 at wave 4 (their old classes: `not_yet_offered` 9, `pipeline` 10, `deployment` 9, `data_platform` 8, `vcs` 7, `incident` 7, `file` 5, `cloud` 4, `k8s` 3, `calendar_delete` 2, `iac` 2, `mobile_release` 2). `agentDoorRow` agrees with `PROPOSABLE_WRITE_TOOLS` for all 47 types. `github.pr.merge` is a real Wave 4 row with a `confirm` target and the reader `github_pr_get`, not bound.

After AD3a-2a: what an outside agent can propose is decided per door. A type the owner approved for agents by name, on a service enabled to the row's wave, with an unchanged definition, is accepted, including Wave 4 and bound rows, and is approved with the model door's prompt. A tool whose definition changed is refused with `ERR_AGENT_TOOL_SUSPENDED` at submit, at approval and after the owner's answer, and stays so until re-approved by name. Everything the old door accepted is still accepted, flagged `legacy`, counted, and warned about on four surfaces.

## Size and split

The outline has nine items; with the six review follow-ups and `describe_actions` it is about seventeen tasks. The split line is where the triple rule allows one. AD3a-2a makes the enforcement claim and therefore lands I58 and the rest of D49. AD3a-2b adds one read method and one MCP tool, makes no enforcement claim, and adds no invariant. After AD3a-2a alone the door is fully enforced: an agent sees the accept-now type list in `capture.status` (as today) and no schemas (as today). So no release could carry a half-enforced door at any commit of either part. OD-1 of the AD3a plan still holds: the release PR stays held until AD3a-2a has merged; AD3a-2b should also be in that release because AD6b and AD7 assume `describe_actions`. If the owner prefers one PR, the AD3a-2b tasks follow Task 12 unchanged.

Inside AD3a-2a the order is chosen so that every commit keeps `audit:invariants` and `security-invariants.test.ts` green: Tasks 1-8 add code behind injected seams while production still injects `classifyActionType` (a verdict with no `basis`, which the gate treats exactly as today), so the AD3a-1 pins "reach is unchanged" (`security-invariants.test.ts:4414-4423`) and the notice pins (`:4425-4436`) stay true. Task 9 is the flip: ONE commit that rewires `platform/assemble.ts`, deletes the notice, inverts those pins, and lands I58, D49(a), (c)-(f) and the I28/I53/I54/I20 text.

## The behavioural delta, in both directions

**What must NOT stop working for a user who changes nothing** (each proved by a test, Task 10 "the window"):

| Old behaviour | During the window | Proof |
| --- | --- | --- |
| Any of the 47 proposable types is accepted with no agent approval | accepted, `legacy = 1`, warned | the 47-type table with an empty door table |
| The seven mail sends are accepted | accepted, `legacy = 1`, the mail-send warning | same table, the seven rows |
| The refusals are `actDoorRefusal`'s | a legacy proposal runs `actDoorRefusal`, unchanged | the existing act-door refusal fixtures run on a legacy basis, byte-equal reasons |
| Submit makes no connector read | a legacy submit calls no listing | a spy on `listServerTools` |
| A 64 KiB payload cap | raised for `kind: action` only, never lowered | the old boundary case still passes |
| `captures.accept` on an action from an undeclared connection (D-AD-16) | still works for a legacy basis | `approvals-flow.test.ts:543` kept |
| `capture.submit` reply `{ id, state, expiresAt }` | the same keys, plus `legacy` and `deprecation` only on a legacy proposal | reply-shape test |
| The model door | `offeredUnder` (`connectors/connector-writes/model-write-source.ts:90-92`) untouched; two helpers are extracted from the door file with snapshot tests | Task 2, Task 6 |

**Where the spec says otherwise (one case).** Spec § 10 says "a policy lockoff of either capability empties the door (legacy included)". The old door never read `connector_write_model_access` (only `mcp_action`, `mcp-sink/capture-capability.ts:57-58`). Under the spec's text an existing user whose org policy disables `connector_write_model_access` loses the act door in a release titled `feat`. That contradicts OR-AD-9. It is Owner decision OD-1; this plan is written for option (b) (the legacy cases keep today's policy rule until AD3b).

**What changes only for a user who opts in** (approves a type by name): that type moves to the `approved` basis, so it gets `modelWriteRefusal` instead of `actDoorRefusal` (a Linear `assigneeId` and a Notion or Confluence page update under a configured KB are then decided by the reader's guard, D-AD-6; the commit, IAM, RBAC and deploy refusals bind); its definition hash is checked three times; it needs both policy capabilities; and (reviewer decision R-6) it can be approved only through `approvals.approve`, not through the raw `captures.accept` RPC.

**What newly works:** the 68 types above, each after `enable <svc> --door agent [--wave N]` and the owner's approval by name, with the typed confirmation for Wave 4, the before-state, and the bound diff or plan. A `rejected` action now carries a fixed code in `capture.state`.

**What the release notes must say** (Task 12): lead with the deprecation; name the seven mail sends; give the exact command; say that `nimbus connector writes status` counts the proposals that will be refused; say AD3b enforces in a later release (no date known); state the upgrade-suspension bound (OR-AD-13), the Slack DM exception (OR-AD-10), the Obsidian rule (OR-AD-12), and that an approved tool's change of definition suspends it at once.

## Spec contradictions and corrections (checked against the code)

Corrections 7, 8, 9, 12, 16, 18 of the AD3a plan bind this slice; where the code now shows more, the item says so.

1. **Correction 8 (the seam "immediately before dispatch") needs a different seam than the one it names.** It asks for a dispatcher wrapper. In `engine/executor.ts` the audit row (`:1723-1729`) and the egress row (`:1731-1749`) are written before `gateWithin` returns `proceed`, and `execute()` sets `dispatched = true` (`:1769`) before `this.connectors.dispatch` (`:1770`). A wrapper that refuses there leaves an `approved` audit row and an `authorized` ledger row for a write that was never sent, reports `failed` instead of `rejected`, and makes `finishScope(action, scope, true)` (`:1775`, `:1796`) skip the D43 discard, so a CloudFormation change set this run created is orphaned. Resolution: the re-check runs after the owner's answer and before the executor records it, as a consent wrapper in `ipc/consent.ts` beside `humanOnlyConsent` (`:52-76`). Between the consent's return and `connectors.dispatch` the executor runs no `await` (`approvalPhase` `:1504-1513`, `confirmedOwnerPrompt` `:1531-1541`, then the two synchronous appends and `dispatchBoundPhase` `:1435-1442`), so the check is as late as the dispatcher's and the decline path audits `rejected`, ledgers `blocked` and discards the change set. Static D41(a) requires the typed-answer method to be named only in `ipc/consent.ts` and the executor, so the wrapper must live there. Reviewer decision R-1; the wrapper variant is kept as the alternative.
2. **Correction 9, completed.** (a) duplicates D39(e) (checker `:2416-2419`): D49(a) is redefined below. (c) `origin: "agent"` and `proposer:` are written in `ipc/capture-rpc.ts:186-187`, not in `approvals-rpc.ts`. (d) says "the executor and `connectors/registry.ts` both call `isOutsideOrigin(`": `registry.ts` does not (the callers are `engine/executor.ts:1190`, `engine/before-state.ts:146`, `:445`); the only existing pin is a test (`security-invariants.test.ts:14578`). (e) `approvals.approve` calls `acceptCapture` (`ipc/approvals-rpc.ts:154`), and `mcp-sink/` may import nothing under `connectors/` (D32(f), checker `:4180`), so the predicate is injected. (f) the word `legacy` cannot be scanned; the TypeScript field is named `agentDoorLegacy`.
3. **`platform/assemble.ts` builds the capture gate before the mesh exists.** `captureGate` is built at `:3935-3961`; `createSchedulerWithMesh` runs at `:4097`. The listing the hash needs (`connectorMesh.listFirstPartyServerTools`) is not in scope. Resolution: a late-bound holder (the `identityBootRefHolder` pattern at `:3901-3903`), fail closed until bound: no listing means no `approved` proposal is accepted. The pin `security-invariants.test.ts:4215-4229` (KB config loaded before the gate; `actionDestinationRefusal: createActionDestinationRefusal(`) is rewritten.
4. **D-AD-15's two legacy reasons are not exhaustive.** The spec defines a legacy proposal as one refused "ONLY because" of a missing approval or wave, or a mail send. The code has more reasons `agentOffered` can refuse a type the old door accepted: the Obsidian append whose model-door approval was withdrawn (OR-AD-12, ruled after the spec), a wave lowered by a later model-door enable (`setModelWriteEnablement` replaces `max_wave`, `connector-writes/enablement-store.ts:69-85`), and policy (OD-1). Resolution, following OR-AD-9: **a legacy proposal is any first-party type that is `proposable` in the unchanged `ACTION_PROPOSABILITY` and that `agentOffered` does not accept, EXCEPT when the tool has a door approval that is suspended.** Suspension is never a legacy case (D-AD-15: "a hash mismatch ... is suspended at once").
5. **`ACTION_PROPOSABILITY` is not edited.** Spec § 7.3 retires it in AD3b. The tests "every Wave 4 row stays denied on the act door" (`connectors/proposable-actions.test.ts:243`) and "a bound row is never proposable" (`:287-321`) assert the TABLE and stay green; they are retitled to say the table is now the legacy baseline, and the reach assertions move to the agent-door tests.
6. **Routing.** `buildActDeps` routes by `proposableWriteTool(actionType)` (`ipc/capture-rpc.ts:151`), which covers 47 types; `github.pr.merge` would throw "Tool not found" (`:155`). `approvals-rpc.ts` `rowFacts` (`:71-77`) uses the same table, so a Wave 4 proposal would list with `wave: null` and no typed-confirm flag. Both move to `agentDoorRow` (`connector-writes/agent-door.ts:35-45`).
7. **The model door refuses a drifted row; the agent door does not yet.** `listedEntryFor` withholds a row whose preview template names an input key the listed schema does not declare (`engine/connector-write-agent-tools.ts:575-579`, `templateKeysInSchema` `:205`). `agentApprovableRows` (`agent-door.ts:104-120`) has no such check. Parity requires it at the enable and in the per-call definition check.
8. **Correction 16, with numbers.** The bound rows cap their own input: 96 KiB of serialised characters for a commit (`connector-writes/commit-limits.ts:21`), 64 KiB for CloudFormation and Kubernetes (`iac-limits.ts:39`, `k8s-limits.ts:29`), 4096 for Terraform (`iac-limits.ts:33`), measured in UTF-16 code units (`engine/prepare-step.ts:141-147`, `:165`). The capture cap is 65,536 UTF-8 BYTES of the whole payload (`mcp-sink/capture-validate.ts:27`, `:170-175`). A legal commit therefore cannot be queued. Resolution: `ACTION_PAYLOAD_MAX_BYTES = 327_680` (320 KiB) for `kind: action` only: 96 KiB of code units is at most 288 KiB of UTF-8, plus the envelope and the 300-character summary. The row's own cap still applies in the executor. The queue holds at most `action_max_pending` rows (1..100, default 10; `config/mcp-sink-toml.ts:41`, `:105`), so the worst case at the default is 3.2 MiB.
9. **Correction 12, completed.** `ERR_AGENT_TOOL_SUSPENDED` joins `CaptureErrorCode` (`mcp-sink/capture-types.ts:34-49`). A `rejected` action needs its own closed code set; `ACTION_ERROR_CODES` (`:126-132`) is for `failed`. `ActExecuteOutcome`'s rejected arm (`:157-159`) carries only a free `reason`.
10. **Correction 18, completed.** `propose_action`'s description says "send an email" and appends `proposableActionTypes` (`packages/cli/src/mcp/capture-tools.ts:212-217`, `:312`). The appended list comes from `listProposableActionTypes` (`connectors/proposable-actions.ts:369-385`), which reads only `PROPOSABLE_WRITE_TOOLS`. After the flip it must list what the door accepts now: the approved types and the legacy types.
11. **Status-drift and a reserved number.** `scripts/structure-audit/check-status-drift.ts:540` matches `Current ceiling ... I1–I(\d+)` and compares it with the canonical highest invariant, and `:531-536` compares the highest `## I<N>` heading. With I58 live and I57 unwritten, every ceiling must read `I1–I58`, with the words "(I57 is reserved by the incident-engine stream and has no section yet)" where prose allows. A split form `I1–I56, I58` would fail the regex. How the canonical value is derived from `security-invariants.test.ts` was not read (UNVERIFIED; Task 0 step 2).

## Owner decisions (design or limitation choices the spec and OR-AD-1 to OR-AD-13 do not settle)

- **OD-1 A `connector_write_model_access` lockoff and legacy proposals.** (a) Spec § 10 as written: either lockoff empties the door, legacy included; an org that locked off model connector writes loses the act door on upgrade, and the PR is arguably breaking for it. (b) A legacy proposal is held to today's rule (`mcp_action` only) until AD3b; an `approved` proposal needs both; the status warning names the lockoff. (c) As (b), but `status` prints nothing about policy. Recommendation: (b); it is what OR-AD-9 says and what the `feat` title claims. The difference is one predicate line and one row of the Task 10 table.
- **OD-2 An approved tool that a listing omits.** AD3a-1's `status` marks it suspended, sticky, with a NULL observed hash (`ipc/connector-rpc-handlers/agent-writes.ts:360-369`, `:385`). OR-AD-5 and OR-AD-13 rule on a CHANGED definition only. A tool can leave a listing with no change of definition: the model door records that an Outlook connection without `Mail.ReadWrite` never lists `outlook_draft_create` (`engine/connector-write-agent-tools.ts:160-165`). (a) Missing is refused while it is missing, reported `not listed now`, with no sticky mark and no audit row; when it returns with the approved hash it works again. (b) Keep the sticky mark (a re-approval by name is needed even for an unchanged definition). (c) Sticky only after two consecutive observations. Recommendation: (a). A listed tool whose schema cannot be read stays a sticky suspension (its definition did change, to something that cannot be hashed). AD3a-1 is unreleased, so no stored mark needs migrating.
- **OD-3 (belongs to AD3a-2b) What `describe_actions` tells an agent about scope.** The model door's description lists the approved Terraform directories and Kubernetes pairs so the model can name one (`connector-write-agent-tools.ts:293-306`). (a) The same text for an agent (parity; without it an agent cannot name a directory). (b) Withhold them; a proposal naming an unapproved directory is refused by the preflight. Recommendation: (a), stated as a bound: an approved agent learns the approved directory paths and the context and namespace names.

Process and slicing calls made here, in the manner of OD-1 and OD-6 of the AD3a plan: the two-PR split above; I58 with I57 left reserved.

## The six review follow-ups, each decided

| Follow-up | Decision | Whose | Where |
| --- | --- | --- | --- |
| `agentOffered` must re-read, per call, the Obsidian model-door approval, the iac workdir grants, the Kubernetes pairs and policy | It does: every call reads `getModelWriteEnablement`, `getDoorApproval`, `getIacGrants(db).workdirs`, `getK8sGrants(db)`, `isObsidianWriteGrantApproved(db)` and the live `enforcedPolicy()`; nothing is cached. A test changes each between submit and approval | plan | D-2, Task 3 |
| After an agent-only enable the model section says `enabled` with nothing offerable | The gateway's model reply stays byte-identical. The CLI line changes only when an enabled service has no write approved for the model: `<svc>  shared wave N  <n> writes, none approved for the model[, <m> awaiting approval]`; the `agents:` line follows | reviewer R-4 | Task 8 |
| A no-`--approve` enable at a lower wave silently drops higher-wave approvals | The prompt gains one `will be removed` line per approval the replace would delete, with its wave and reason (`above this wave`, or the row's `not approvable` reason); the payload carries `removes`, validated by the renderer | plan | Task 8 |
| `connector.writesStatus` has no caller-kind check, yet its agent section writes the sticky mark and can start a connector | The live check (listing, marking) runs only for a connection that declared `cli` or `ui` (`APPROVER_BY_KIND`, `mcp-sink/capture-client-policy.ts:30-39`); any other kind gets the stored view with `checked: false`. The CLI's `status` declares `cli` first (today it does not: `packages/cli/src/commands/connector-writes-cli.ts:501`) | reviewer R-5 | Task 8 |
| A missing tool is sticky-suspended | OD-2, recommendation (a) | owner | D-3, Task 2 |
| A missing, a null and a non-string description hash the same | A string hashes as itself and an absent description as `null`, so every hash AD3a-1 stored stays valid; a description that is PRESENT and not a string makes the definition unreadable (`definitionSha256` returns `undefined`). Whether Mastra lists an absent description as `undefined` or `""` is UNVERIFIED (Task 0) | reviewer R-3 | D-3, Task 2 |

## Every place that must change (sweeps, verified by grep in the AD3a-1 worktree)

### A. Code sites

| Site | Fact | Change |
| --- | --- | --- |
| `mcp-sink/capture-gate.ts:444-448` | 5a `requireProposable`, `requireDestinationAllowed`; 5b `requireConfigured` | 5a verdict (with a `suspended` arm), refusal by basis; 5b configured; 5c the definition, for `approved` only |
| `mcp-sink/capture-gate.ts:510-574` `writeSubmittedCapture` | inserts 10 columns; audit row has no basis | stores `agentDoorLegacy`; the audit row gains `basis`; the reply gains `legacy` |
| `mcp-sink/capture-act.ts:187-208` | step 4 verdict and configured; 4b destination | 4a verdict, 4b configured, 4c refusal by basis, 4d definition, 4e the approver rule for an `approved` basis |
| `mcp-sink/capture-act.ts:229-287` | provenance; `rejected` stores no code | provenance carries the basis; `finalizeAction` stores the reject code; the outcome audit row carries it |
| `ipc/capture-rpc.ts:87-109` `createActionDestinationRefusal` | builds `actDoorRefusal` | deleted here (retire = delete); the legacy branch of the agent door calls `actDoorRefusal` |
| `ipc/capture-rpc.ts:140-200` `buildActDeps` | routes by `proposableWriteTool`; no options; plain consent | `agentDoorRow`; `ExecuteOptions` from the listing; the vetoing consent; a reject code |
| `ipc/approvals-rpc.ts:71-77`, `:83-130` | `rowFacts` by `proposableWriteTool`; no legacy field | `agentDoorRow`; `legacy` per proposal and a `deprecation` header |
| `platform/assemble.ts:3948-3957` | `classifyActionType`, `listProposableActionTypes`, `createActionDestinationRefusal` | the agent door's runtime, late-bound to the mesh (correction 3) |
| `platform/assemble.ts:4795-4811` | `act` wiring | gains the agent door's act-side functions |
| `ipc/connector-rpc-handlers/agent-writes.ts:360-399` | `observe`, `recordSuspension` live in the status handler | moved to `connector-writes/agent-door-definition.ts`, shared by status, submit, approve and the veto |
| `agent-writes.ts:266`, `:439`; `connector-writes/enable-prompt.ts:3`, `:376`; `connector-writes/agent-door.ts:22`; `agent-door-notice.ts` | the not-enforced notice | deleted |
| `connector-writes/agent-door.ts:6-8` | "Nothing here is read at the capture gate yet" | rewritten; `agentOffered` added |
| `connector-writes/definition-hash.ts:29` | non-string description is `null` | R-3 |
| `engine/connector-write-agent-tools.ts:130-141`, `:441-455`, `:488-518` | fixed-refusal mapping and the two "unlisted" helpers are private to the model door | extracted and shared (D-5, D-6) |
| `engine/proposer-block.ts:45-51`, `engine/types.ts:58-70` | two proposer lines | an optional `deprecation` line |
| `packages/cli/src/mcp/capture-tools.ts:212-217`, `:239`, `:312` | tool texts | correction 10 |
| `packages/cli/src/commands/approvals.ts:138-168` | list and detail | the deprecation header and a per-row marker |
| `packages/cli/src/commands/connector-writes-cli.ts:42-43`, `:316-321`, `:467-492`, `:501` | policy text, "Recorded:", status lines | Task 8 |
| `packages/cli/src/commands/connector.ts:1427` | "recorded, not yet enforced" | removed |
| `packages/cli/src/commands/captures-format.ts:396-403` | a `rejected` line has no code | prints the code when present |

### B. Static rules and pins

| Site | Fact | Change |
| --- | --- | --- |
| checker `:2112-2132` | D49 has sub-rule (b) only | (a), (c), (d), (e), (f) (D-9) |
| checker `:4792` `RULE_ANCHORS`, error printer `:5156-5159` | one D49 anchor and line | anchors and lines for the new clauses |
| checker `:4036-4040`, `:4167-4171`, `:2416-2419` | D32(b)/(c)/(e), D39(e) allow-lists | unchanged |
| `security-invariants.test.ts:4244-4259` | pins `proposableWriteTool(actionType) ?? userMcpToolKeyForActionType` | rewritten to the new routing line |
| `security-invariants.test.ts:4215-4229` | pins `createActionDestinationRefusal(` in assemble | rewritten (correction 3) |
| `security-invariants.test.ts:4298-4313` | `humanOnlyConsent` has two users | unchanged; a sibling pin for the vetoing wrapper (one user: `ipc/capture-rpc.ts`) |
| `security-invariants.test.ts:4342-4437` | the AD3a-1 block, "recorded, not yet enforced" | the reach pin and the notice pin inverted; the block retitled |
| `ipc/capture-rpc.agent-origin.test.ts:153-214` | "the 47 proposable types are the 47 they were", "no proposable type is Wave 4" | restated as the legacy baseline |
| `packages/gateway/test/integration/mcp-sink/agent-door-enable.test.ts:247-285` | "reach is unchanged" | inverted on purpose |
| `packages/gateway/test/integration/mcp-sink/approvals-flow.test.ts:324-420` | A2 on a synthetic Wave 4 row | re-run on `github.pr.merge` |
| `mcp-sink/capture-act.test.ts:242` | a rejected action stores no code | inverted |
| `ipc/connector-rpc-agent-writes.test.ts:357`, `:506`, `:794`, `:894`, `:913-924`; `packages/cli/src/commands/connector-writes-cli.agent.test.ts:12` | assert the notice | deleted or rewritten |

### C. Counts and texts

| Item | Today | After AD3a-2a |
| --- | --- | --- |
| Schema ceiling | V97 | V97 |
| Invariant ceiling (`docs/SECURITY-INVARIANTS.md:3`, `CLAUDE.md:44`, `:308`, `GEMINI.md`, `docs/README.md`, `docs/SECURITY.md`, `.github/SECURITY.md`, `docs/architecture.md`, `docs/cli-reference.md`, `docs/roadmap.md`, `docs/schema-reference.md`, and the skills `nimbus-security-invariants.md:95`, `nimbus-file-map.md`, `nimbus-db-migrations.md`, `nimbus-federation-identity.md`, `nimbus-tool-output-envelope.md`) | I1–I56 | I1–I58, I57 reserved (correction 11) |
| Static rules | D10–D49 | D10–D49 (more clauses) |
| HITL types | 185 | 185 (no new type) |
| Proposable / denied / `not_yet_offered` (`docs/architecture.md:3216`, `CLAUDE.md:8`, `docs/SECURITY-INVARIANTS.md` I28, `docs/roadmap.md`, `docs/README.md`) | 47 / 138 / 9 | unchanged as counts of the LEGACY table; every site gains "the agent door reaches 108 rows; the table is the legacy baseline until AD3b" |
| Model-offerable rows | 109 of 125 | unchanged; "108 agent-reachable" added beside it |
| I28 one-liner (`CLAUDE.md:73`, `GEMINI.md`) | `actDoorRefusal` at submit and accept | per-basis refusal, the eligibility order, suspension, the legacy clause |
| I53 one-liner (`CLAUDE.md:99`, `GEMINI.md`) | model door only | one sentence: the agent door is a second origin with its own list and hash (I58) |
| I54, I20 one-liners (found by `- **I54**`, `- **I20**`; line numbers not read) | bound rows not proposable over MCP; delegation | I54: a bound row is proposable by an agent and the proposer's input is never a bound field; I20: wording already covers `origin: "agent"`, re-read only |
| `docs/SECURITY-INVARIANTS.md` I28 "Bounds: no bound row is proposable (D1c)" | true | rewritten |
| `engine/executor.ts` comment containing "no bound row" (grep hit, line not read) | stale after the flip | corrected |
| `docs/cli-reference.md:1642`, `:1689-1697`, `:1744-1758`, `:3304`, `:3365` | 47 types, the not-enforced wording | the agent door section, the deprecation, the codes |
| `docs/architecture.md:744`, `:3154-3250` | "recorded" | the verdict, the three check points, the legacy branch |
| `docs/roadmap.md:3077-3078` | both rows `[ ]` | *Write parity* `[x]` after AD3a-2b; *The same prompt* `[x]` after Task 10's A2 |
| Skills `.claude/commands/nimbus-mcp-sink.md:229`, `nimbus-file-map.md:350` | "not yet enforced" | rewritten |
| `policy/types.ts` (mentions `propose_action`; text not read) | describes `mcp_action` | re-read; add that agent writes also need `connector_write_model_access` |

### D. Seam types compared (not just names)

| Seam | Today | AD3a-2a |
| --- | --- | --- |
| `ActionVerdict` (`mcp-sink/capture-types.ts:144-147`) | `{ kind: "proposable" } \| { kind: "denied"; class: string } \| { kind: "unknown" }` | `{ kind: "proposable"; basis?: "approved" \| "legacy_unapproved" \| "legacy_mail_send" } \| { kind: "suspended" } \| denied \| unknown`. `basis` absent means a user-MCP type. `ActionClassification` (`connectors/proposable-actions.ts:53-59`) stays assignable |
| `CaptureGateDeps.classifyAction?(actionType: string): ActionVerdict` (`capture-gate.ts:80`) | synchronous | same signature; database reads only, no connector I/O |
| `CaptureGateDeps.actionDestinationRefusal(actionType, input): string \| undefined` (`:92-95`) | required, two parameters | a third parameter `basis: ActionBasis \| undefined` |
| new `CaptureGateDeps.verifyActionDefinition?(actionType: string): Promise<{ ok: true } \| { ok: false; code: "ERR_AGENT_TOOL_SUSPENDED" \| "ERR_CAPTURE_ACTION_NOT_PROPOSABLE"; detail: string }>` | none | absent refuses every `approved` proposal (fail closed); added to the `ActGateDeps` pick (`capture-act.ts:22-31`) |
| `submitCapture(...)` result (`capture-gate.ts:415`) | `{ id; state; expiresAt? }` | plus `legacy?: true` |
| `NewCaptureRow`, `CaptureRow` (`capture-store.ts:47-50`, `capture-types.ts:68-83`) | 14 fields; `toRow` ignores the 15th column | `agentDoorLegacy: boolean`, required, so every construction site fails typecheck until it says |
| `ActionProvenance` (`capture-types.ts:149-155`) | five fields | plus `basis: ActionBasis \| undefined` (the approval-time basis) |
| `ActExecuteOutcome` rejected arm (`:159`) | `{ status: "rejected"; reason?: string }` | plus `code?: ActionRejectCode` |
| `ActionAcceptResult.errorCode` (`capture-act.ts:57`) | `ActionErrorCode` | `ActionErrorCode \| ActionRejectCode` |
| `ActDeps` (`capture-types.ts:162-168`) | `execute` | plus `readonly humanOnly?: boolean` |
| `AgentProposer` (`engine/types.ts:58-70`) | seven fields | plus `deprecation?: string` (gateway text) |
| `CaptureActWiring` (`ipc/capture-rpc.ts:55-69`) | dispatcher, sinks, policy, credential, rows, KB | plus `listServerTools` and `recheckDefinition`, both required |
| `ConsentCoordinator` wrappers (`ipc/consent.ts:52-76`) | `humanOnlyConsent(inner, onNonHuman)` | plus `vetoingConsent(inner, recheck: () => Promise<string \| undefined>, onVeto: (reason: string) => void)` |
| `definitionSha256(toolId, listed): string \| undefined` (`definition-hash.ts:25-33`) | non-string description hashes as `null` | same signature; a present non-string description returns `undefined` |
| `AgentStatusReply` (`agent-writes.ts:335-341`) | `{ policyAllows; notice; hint?; services }` | `{ policyAllows; checked: boolean; hint?; legacy: { sinceMs; total; byType; notice } \| null; services }`; `notice` removed |
| `AgentEnableReply` (`:206-213`) | has `notice` | `notice` removed; `removed: string[]` added |
| `ExecuteOptions` (`engine/executor.ts:970-981`) | two flags | unchanged; the act door now passes it |

## Design decisions

**D-1 The predicate.** `agentOffered(row, facts): boolean` in `connector-writes/agent-door.ts`, pure: `enabledAndOfferable(facts.enablement, row)` (`model-write-source.ts:75-83`), `agentDoorRow(row.actionType) === row`, a door approval for `row.toolId` whose `suspendedAt` is null, `agentDoorPolicyAllows(facts.enforced)` (`agent-door.ts:141-149`), `scopeAvailable(row, hasWorkdir, hasK8sPair)` (`model-write-source.ts:130-137`), no `scopeGatedReason`, and for `obsidian_append_to_daily_note` the model grant (OR-AD-12). The parity test (correction 1 of the AD3a plan) is: for every row and every fact combination, `agentOffered` equals `enabledAndOfferable` AND the door approval AND the four door-specific conditions; and where the door-specific conditions hold and both doors approved the row, `agentOffered` equals the model's `recheck`.

**D-2 The runtime, `connector-writes/agent-door-runtime.ts`.** `createAgentDoor(deps)` with `deps = { db, enforcedPolicy, listServerTools, tribalKbConfig, classifyUserMcp, isServiceConfigured, now, rows? }` returns the functions the gate and the act wiring are given. Every function reads its facts at the call (follow-up 1).
- `verdict(actionType)`, in this order: a user-MCP type goes to `classifyActionType` unchanged; no row means the legacy check; a door approval with `suspendedAt` set is `suspended`; `agentOffered` true is `proposable/approved`; otherwise a type `proposable` in `ACTION_PROPOSABILITY` is `proposable/legacy_mail_send` (its row is one of the seven sends) or `proposable/legacy_unapproved`; otherwise `denied` with a fixed class (`agent_not_enabled`, `agent_wave`, `agent_not_approved`, `agent_never_offered`, `agent_not_offerable`, `agent_no_scope`, `agent_policy`, `agent_unroutable`) or `unknown`.
- `refusal(actionType, input, basis)`: `approved` runs `modelWriteRefusal` on the row's tool with the live ChatOps bindings and KB config (the shape of `model-write-source.ts:166-177`); a legacy basis runs `actDoorRefusal` exactly as `createActionDestinationRefusal` does today (`ipc/capture-rpc.ts:91-108`); a user-MCP type returns `undefined`.
- `verifyDefinition(actionType)`: D-3.
- `acceptedTypes()`: the approved types (no listing) and the legacy types whose service is configured, sorted, at most 200: what `capture.status` advertises.

**D-3 The definition check, `connector-writes/agent-door-definition.ts`** (the one place a mismatch is marked and audited; `agent-writes.ts` imports it). `checkAgentToolDefinition(deps, approval, listed)` returns `ok`, `changed` (the hash differs: `markDoorToolSuspended` and, when that call set the mark, one `connector.writes.agent.suspend` audit row, as `agent-writes.ts:385-397` does now), `unreadable` (listed, cannot be hashed: marked with a NULL observed hash), `missing` (OD-2: not marked) or `drifted` (correction 7: not marked, refused). `verifyDefinition` lists the service once; an `undefined` listing is `ERR_CAPTURE_ACTION_NOT_PROPOSABLE` with a fixed text and marks nothing; `changed` and `unreadable` are `ERR_AGENT_TOOL_SUSPENDED`; `missing` and `drifted` are `ERR_CAPTURE_ACTION_NOT_PROPOSABLE`. For a Wave 4 row it also refuses when the row's reader or prepare tool is not listed (the model door's rule at `connector-write-agent-tools.ts:592-609`).

**D-4 Submit** (`capture-gate.ts`), read top to bottom: 5a `verdict` (`suspended` is an audited `ERR_AGENT_TOOL_SUSPENDED`; `denied` and `unknown` are `ERR_CAPTURE_ACTION_NOT_PROPOSABLE` with the class's fixed text); 5a' `actionDestinationRefusal(type, input, basis)`; 5b configured; 5c for `approved` only, `await verifyActionDefinition`. The listing is last, so every other refusal stays free of connector I/O (correction 7 of the AD3a plan), and both awaits stay before the caps of steps 7 and 8. Stated bound: a proposal for an approved tool can start that connector, at most `4 x max_per_hour` times an hour (the attempt limiter, `:429`).

**D-5 Approve** (`capture-act.ts` step 4): 4a `verdict` again (`suspended` throws `ERR_AGENT_TOOL_SUSPENDED`; the row stays proposed, like every step-4 refusal, so a re-approval by name can still rescue it; reviewer decision R-2); 4b configured; 4c the refusal for the approval-time basis; 4d `verifyActionDefinition` for `approved`; 4e for `approved`, `act.humanOnly === true`, else `ERR_CAPTURE_FORBIDDEN_CLIENT` naming `nimbus approvals <id>` (R-6). The basis used everywhere after step 4 is the approval-time one: a row queued as legacy and since approved by name is held to the approved rules, and a row queued as approved whose approval was withdrawn is a legacy case if its type is one of the 47.
After the claim, `buildActDeps.execute`: route by `agentDoorRow`; list the service and compute `{ beforeReaderUnlisted, prepareToolUnlisted }` with the helpers extracted from the model door into `connector-writes/listed-support.ts`; build the executor on `vetoingConsent(consent, recheck, onVeto)` where `recheck` is `verifyDefinition` again; run the action with `ExecuteOptions`. A veto becomes `{ status: "rejected", code: "ERR_AGENT_TOOL_SUSPENDED" }`.

**D-6 Codes on a `rejected` action.** `ACTION_REJECT_CODES = ["ERR_AGENT_TOOL_SUSPENDED", "ERR_ACTION_GUARD_REFUSED", "ERR_ACTION_BEFORE_STATE_UNREADABLE", "ERR_ACTION_PREPARE_REFUSED", "ERR_ACTION_CREDENTIAL_UNVERIFIED"]` in `capture-types.ts`. The mapping from the executor's reason is the model door's (`connector-write-agent-tools.ts:441-455`: the row's guard reason, `WAVE4_BEFORE_REFUSAL`, the fixed bound refusals), extracted to `engine/door-rejection.ts` as `classifyDoorRejection(row, reason)` and used by both doors. A plain decline, a mistyped confirmation and a non-human answer store no code, as today. The owner's reply keeps the reason; the agent sees the code only.

**D-7 The legacy flag and the four warnings.** `writeSubmittedCapture` stores `agentDoorLegacy = basis is a legacy one`. One module, `connector-writes/agent-door-legacy.ts`, holds the two fixed lines and `legacyNoticeFor(actionType)`:
- unapproved: `Deprecated: <type> is not approved for outside agents by name. It is accepted for now and will be refused in a later release. To keep it working run: nimbus connector writes enable <service> --door agent`
- mail send: `Deprecated: outside agents will not be able to propose mail sends in a later release (drafts stay allowed). This proposal is accepted for now.`
Surfaces: (1) the `capture.submit` reply gains `deprecation` (added in `ipc/capture-rpc.ts`, because `mcp-sink/` cannot import the module) and the MCP tool prints it; (2) `approvals.list` and `approvals.get` carry `legacy` per proposal and a `deprecation` header, printed at the top by the CLI; (3) the approval prompt: `agentProposerOf` sets `proposer.deprecation` from the approval-time basis and `formatProposerBlock` appends it as a third line, escaped like the others; (4) `connector.writesStatus`'s agent section gains `legacy: { sinceMs, total, byType, notice }` from a new `CaptureStore.legacyActionTypesSince(sinceMs)` (30 days; a purged or pruned row leaves the count, stated). A test pins that all four carry the module's text; AD3b deletes the module, which fails that test on purpose.

**D-8 Enable and status.** Follow-ups 2, 3 and 4 as in the table. The enable prompt loses the notice line and keeps its closing pair (`enable-prompt.ts:377-378`). `runAgentEnable` prints `Approved:` instead of `Recorded:`.

**D-9 Static D49, the remaining clauses, against the real sites.**
- (a) The legacy table is consulted in one place: the identifiers `ACTION_PROPOSABILITY`, `classifyActionType`, `proposableWriteTool` and `PROPOSABLE_WRITE_TOOLS` are named in production only in `connectors/proposable-actions.ts` and `connector-writes/agent-door-runtime.ts`; and `createAgentDoor` only in its module and `platform/assemble.ts`.
- (c) `origin: "agent"` and a `proposer:` property are written only in `ipc/capture-rpc.ts`.
- (d) A comparison of an action's `origin` with a literal appears only in `engine/outside-origin.ts` (the static form of the test pin at `security-invariants.test.ts:14578`).
- (e) In `ipc/capture-rpc.ts` `buildActDeps`, `vetoingConsent(` precedes `buildAgentWriteExecutor(` and is its consent argument; in `capture-act.ts` `acceptAction`, `deps.classifyAction` and `deps.verifyActionDefinition` both precede `claimAction(`; in `capture-gate.ts` `submitCapture`, both precede `writeSubmittedCapture(`.
- (f) `agentDoorLegacy` is named only in `mcp-sink/capture-{types,store,gate}.ts`, `ipc/approvals-rpc.ts` and `ipc/capture-rpc.ts`; `legacyActionTypesSince` only in `capture-store.ts` and its one wiring site. AD3b removes (f) and the table half of (a).
Textual, with the usual stated bound: a dynamically composed name evades the scan and the behavioural tests are authoritative.

**D-10 Invariant I58** (text for `docs/SECURITY-INVARIANTS.md`, after I56): "An outside agent's first-party proposal is queued, approved and dispatched only as an `origin: "agent"` action through the door executor, for a service the owner enabled to the row's wave, for a row the owner approved for agents by name, whose listed definition hashes to the stored value, while policy allows both `mcp_action` and `connector_write_model_access`, never a row in the never-offered set and never the Slack DM row; all of it re-derived at submit, at approval and after the owner's answer. A changed definition suspends the tool until it is approved again by name. Until AD3b, a legacy proposal (a type the earlier act door accepted that this rule would refuse for any reason but a suspension) is accepted without the approval by name, flagged, counted and warned." Wiring: `connector-writes/{agent-door,agent-door-runtime,agent-door-definition,door-approval-store,definition-hash}.ts`, `mcp-sink/{capture-gate,capture-act}.ts`, `ipc/{capture-rpc,consent}.ts`, `platform/assemble.ts`. Bounds: the hash covers the listing, not behaviour; the kind is the connection's claim; a missing tool is not a suspension (OD-2); the window between the re-check and the connector call is the model door's.

## File map

New (gateway): `connectors/connector-writes/{agent-door-runtime,agent-door-definition,agent-door-legacy,listed-support}.ts`, `engine/door-rejection.ts`, a test each; `packages/gateway/test/integration/mcp-sink/agent-door-flow.test.ts`.
Deleted: `connectors/connector-writes/agent-door-notice.ts`.
Edited (gateway): `mcp-sink/{capture-types,capture-store,capture-validate,capture-gate,capture-act}.ts`, `ipc/{capture-rpc,approvals-rpc,consent,connector-rpc}.ts`, `ipc/connector-rpc-handlers/agent-writes.ts`, `ipc/server/dispatchers.ts`, `connectors/connector-writes/{agent-door,definition-hash,enable-prompt}.ts`, `engine/{connector-write-agent-tools,proposer-block,types}.ts`, `platform/assemble.ts`, `security-invariants.test.ts`, and the tests listed in sweep B.
Edited (scripts): `scripts/structure-audit/check-nimbus-invariants.ts` and its test.
Edited (cli): `mcp/capture-tools.ts`, `commands/{approvals,captures-format,connector-writes-cli,connector}.ts` and their tests.
Docs: Task 12.

## Tasks for AD3a-2a (test first; red-prove every guard by reverting the production line and watching its test fail)

### Task 0 - Preconditions

1. Branch `dev/asaf/p28-ad3a-2a` from `dev/asaf/p28-ad3a-1` in a new worktree (from `main` if #1999 has merged); verify `git rev-parse --abbrev-ref HEAD` before every commit. Strip `docs/superpowers/**` and `.superpowers/**` before the PR.
2. Re-derive the numbers: `git fetch origin`; for every open PR head (`gh pr list --state open --json headRefName`; at planning time the open PRs were #1999 and #1965, and #1965's files were not read) run `git ls-tree -r --name-only origin/<branch> -- packages/gateway/src/index` and look for `-v98-sql.ts`; read `docs/SECURITY-INVARIANTS.md:3` on `origin/main` and on every open PR that edits it, for I57, I58 and D50. Read how `check-status-drift.ts` derives the canonical invariant (`:499`). If I57 is still unwritten, keep I58 with the reserved wording; if another branch took I58 or D49's letters, renumber before writing code.
3. Baseline, scoped and sequential: `bun test packages/gateway/src/mcp-sink`, then `bun test packages/gateway/src/ipc`, then `bun test packages/gateway/src/connectors/connector-writes`, then `bun test packages/gateway/src/security-invariants.test.ts`, then `bun test scripts/structure-audit/check-nimbus-invariants.test.ts`; record counts.
4. Probes, each kept as a test or recorded in the PR: (a) the row facts at the top of this plan, re-run; (b) whether the installed `@mastra/mcp` `MCPClient.listTools` caches per client (UNVERIFIED since the AD3a plan; it decides whether a changed listing is seen without a slot restart); (c) what an absent tool description looks like in a real listing (`undefined` or `""`); (d) what the CLI's consent handler answers to a typed-confirmation request under `--yes` (UNVERIFIED; it bounds R-6).
5. Confirm OD-1 and OD-2 with the owner before Task 3; the plan assumes (b) and (a).

### Task 1 - Types, the store, the payload cap

Files: `mcp-sink/{capture-types,capture-store,capture-validate}.ts` and their tests.
1. Tests first. Store: `insert` with `agentDoorLegacy: true` writes `legacy = 1` and `toRow` reads it; a note with the flag throws at the V97 CHECK; `legacyActionTypesSince` counts only `legacy = 1` action rows created after the bound, groups by action type, skips an unparsable payload, and ignores a `legacy = 0` row. Validate: an action payload of 65,537 bytes is accepted and one of 327,681 is refused; a note, decision, term and link at 65,537 are still refused (the cap moved for `action` only); a 96 KiB-character commit input and a 51,200-byte template survive validation. Types: `ERR_AGENT_TOOL_SUSPENDED` is a `CaptureErrorCode`; every `ACTION_REJECT_CODES` member is at most 64 characters (the V97 CHECK). RED.
2. Implement. GREEN. `bun run typecheck` lists every `NewCaptureRow` site that must now say `agentDoorLegacy`.

### Task 2 - The definition check, the hash rule, the shared listing helpers

Files: `connector-writes/{definition-hash,agent-door-definition,listed-support,agent-door}.ts`, `engine/connector-write-agent-tools.ts` (imports only), `ipc/connector-rpc-handlers/agent-writes.ts`.
1. Tests first. Hash: a string description and an absent one hash exactly as the AD3a-1 fixtures do (golden values copied before the change); a `null`, a number and an object description return `undefined`. Definition check: `ok`; `changed` marks once and audits once, and a second call does neither; `unreadable` marks with a NULL hash; `missing` marks nothing and writes no audit row (OD-2); `drifted` (a template key the schema lacks) marks nothing; an `undefined` listing marks nothing. `agentApprovableRows` reports a drifted row `not_approvable` with a fixed reason. Listing helpers: the model door's offered tool set for a fixture table is identical before and after the extraction (snapshot taken first), including the Wave 4 "no reader, no offer" rows. Status still reports a changed tool with both prefixes and now reports a missing one as `not listed now` without `suspended_at`. RED.
2. Implement D-3 and R-3; move `observe` and `recordSuspension`. GREEN.
3. Red-proofs: remove the `missing` arm (the missing tool is marked again); restore `null` for a non-string description.

### Task 3 - `agentOffered` and the runtime

Files: `connector-writes/{agent-door,agent-door-runtime}.ts` and tests.
1. Tests first, real SQLite through the runner.
   - **Parity** (spec § 10): for every one of the 125 rows and each wave, the D-1 equation; `slack_message_post_dm` is the only model-offerable row never offered to an agent (derived).
   - **Per-call re-read**: with a row approved, each of these alone flips `agentOffered` to false on the next call with no restart: the V83 row removed; its wave lowered; the door approval removed; the approval suspended; `mcp_action` locked off; `connector_write_model_access` locked off; the last workdir grant removed (Terraform apply); the last Kubernetes pair removed; the Obsidian model approval removed. A policy accessor that throws, or returns `undefined`, is false.
   - **Verdict**: the precedence of D-2, one case per arm; a suspended approval of one of the 47 types is `suspended`, not legacy; each of the 47 types with an empty door table is `legacy_unapproved` or `legacy_mail_send`; a never-offered non-mail row, a Wave 4 row and a bound row with no approval are `denied`; a user-MCP type returns exactly what `classifyActionType` returns. OD-1: under a `connector_write_model_access` lockoff an approved type is legacy if it is one of the 47, else `denied/agent_policy`.
   - **Refusal**: each refusal of `modelWriteRefusal` once on an `approved` basis (messaging, broadcast, quick action, scoped label, remote content, null optional, calendar zone, KB target, commit path and credential look, IAM capability, RBAC, deploy); a Linear `assigneeId` is NOT refused on `approved` and IS on a legacy basis; a throwing policy accessor refuses a ChatOps post; a throwing KB accessor refuses a KB-capable row.
   - `acceptedTypes` lists approved and legacy types, never a suspended or denied one.
   RED.
2. Implement D-1, D-2. GREEN. Nothing in production calls the runtime yet (Task 9 wires it).

### Task 4 - Submit

Files: `mcp-sink/capture-gate.ts`, `mcp-sink/capture-gate.test.ts`, a new `capture-gate.ad3a.test.ts`.
1. Tests first, with fake deps. Order: a `suspended` verdict, a `denied` verdict, a refusal, an unconfigured service each refuse with ZERO calls of `verifyActionDefinition` (a spy); a legacy basis never calls it; an `approved` basis calls it once, after `isServiceConfigured`; an absent `verifyActionDefinition` refuses an `approved` proposal. Each refusal writes one `capture.submit` audit row with its code and queues nothing. A legacy proposal stores `legacy = 1`, replies `legacy: true`, and its audit row names the basis; an approved one stores 0. A verdict with no basis (the user-MCP path and today's production wiring) behaves exactly as before (the existing `capture-gate.test.ts` passes untouched). The caps still follow the awaits (a concurrent-submit test). RED.
2. Implement D-4. GREEN.
3. Red-proof: move 5c before 5a (the zero-listing tests fail).

### Task 5 - Approve

Files: `mcp-sink/capture-act.ts`, `mcp-sink/capture-act.test.ts`.
1. Tests first. Step 4: each of 4a-4e refuses with the row still `proposed`, no claim and no `capture.action.accept` row; `suspended` is `ERR_AGENT_TOOL_SUSPENDED`; a definition check that returns `changed` at approval refuses the same way. A row queued legacy and now approved is held to the approved rules; a row queued approved and now legacy is accepted with `provenance.basis` legacy. 4e: an `approved` basis without `act.humanOnly` is refused; a legacy basis is not. Finalize: a `rejected` outcome with a code stores it, the `capture.action.outcome` audit row carries it, and `captureStateFor` returns it; a plain decline stores none. Invert `capture-act.test.ts:242`. RED.
2. Implement D-5 (the gate half), D-6 (the store half). GREEN.

### Task 6 - The act deps: routing, options, the veto, the code

Files: `ipc/{capture-rpc,approvals-rpc,consent}.ts`, `engine/{door-rejection,proposer-block,types,connector-write-agent-tools}.ts`, tests beside each.
1. Tests first.
   - **Veto** (`ipc/consent.test.ts`): an approved answer with a passing re-check is returned unchanged; with a failing one it becomes a decline on the plain and the typed request (`typed: ""`), and `onVeto` gets the reason; a declined answer never runs the re-check; a re-check that throws is a veto (fail closed).
   - **Through the real executor** (`ipc/capture-rpc.agent-origin.test.ts`): the definition changes while the prompt is open; the write is not dispatched, the audit row is `rejected`, the ledger row is `blocked`, the outcome is `rejected` with `ERR_AGENT_TOOL_SUSPENDED`, the tool is marked. For `iac.cloudformation.deploy` the change set the prepare step created is discarded (the D43 path).
   - **Routing**: every agent-reachable type dispatches the row `agentDoorRow` names, byte for byte; the 47 types dispatch what they dispatched before (the AD1 snapshot); `mcpToolId`, `origin`, `proposer` and `confirm` inside `input` are inert.
   - **Options**: a wave 2-3 row whose reader is unlisted shows `before: unavailable (failed)`; a Wave 4 row whose reader is unlisted is refused before any prompt with `WAVE4_BEFORE_REFUSAL` and code `ERR_ACTION_BEFORE_STATE_UNREADABLE`; a bound row whose prepare tool is unlisted is refused with code `ERR_ACTION_PREPARE_REFUSED`.
   - **Rejection classifier**: the model door's results for a table of reasons are identical before and after the extraction (snapshot first).
   - **Proposer block**: `deprecation` adds one escaped line after the summary and nothing when absent.
   - `approvals.list` shows wave 4 and `typedConfirm` for `github.pr.merge`.
   RED.
2. Implement. `approvals-rpc.ts` passes `humanOnly: true`. GREEN.
3. Red-proofs: drop the `vetoingConsent` wrap; route by `proposableWriteTool` again.

### Task 7 - The four warnings

Files: `connector-writes/agent-door-legacy.ts`, `ipc/{capture-rpc,approvals-rpc}.ts`, `ipc/connector-rpc-handlers/agent-writes.ts`, `ipc/server/dispatchers.ts`, `packages/cli/src/mcp/capture-tools.ts`, `packages/cli/src/commands/{approvals,connector-writes-cli}.ts`, tests.
Tests first: `legacyNoticeFor` gives the mail text for each of the seven sends and the unapproved text otherwise, naming the service; the `capture.submit` reply of a legacy proposal carries it and an approved one does not; the MCP tool result prints it after the "has NOT run" sentence, control characters stripped; `approvals.list` and `approvals.get` carry the header only when a legacy row is shown, and the CLI prints it first; the prompt of a legacy approval contains it; status counts two legacy proposals of one type and one of another over 30 days, omits a 31-day-old one, and the CLI prints `legacy: <n> proposals in the last 30 days would be refused (<type> x<n>, ...)` with the command. One test asserts that all four surfaces contain the module's exact text. RED, implement D-7, GREEN.

### Task 8 - Enable and status follow-ups

Files: `ipc/connector-rpc-handlers/agent-writes.ts`, `connector-writes/enable-prompt.ts`, `packages/cli/src/commands/connector-writes-cli.ts`, tests.
Tests first: a no-`--approve` enable at wave 2 on a service holding wave 3 and 4 approvals shows one `will be removed` line per dropped approval and the reply's `removed` lists them; with `--approve` nothing is listed as removed; a malformed `removes` entry makes the renderer return `undefined`. Status from an `mcp`, `unknown`, `http`, `chatops`, `fleet` or `push` connection calls no listing (spy), marks nothing, and replies `checked: false`; from `cli` and `ui` it checks. The CLI's `status` records `session.declareKind` as its first call. The model line for an enabled service with nothing approved for the model reads `shared wave N ... none approved for the model`, and is unchanged when something is. RED, implement D-8 (the notice stays until Task 9), GREEN.

### Task 9 - The flip (ONE commit: wiring, docs, checker, tests)

Files: `platform/assemble.ts`, `ipc/capture-rpc.ts` (delete `createActionDestinationRefusal`), `connector-writes/{agent-door,enable-prompt}.ts`, delete `agent-door-notice.ts`, `agent-writes.ts`, CLI texts, the checker and its test, `docs/SECURITY-INVARIANTS.md`, `CLAUDE.md`, `GEMINI.md`, `security-invariants.test.ts`.
1. Tests first. Checker fixtures, one good set and one single-violation swap per clause and per name form: (a) `classifyActionType` named in `ipc/approvals-rpc.ts`, `proposableWriteTool` in `ipc/capture-rpc.ts`, `createAgentDoor` in a third file; (c) `origin: "agent"` and `proposer:` in `ipc/approvals-rpc.ts` and in `mcp-sink/capture-act.ts`; (d) `action.origin === "agent"` in `connectors/registry.ts`; (e) `buildAgentWriteExecutor(` before `vetoingConsent(`, and `claimAction(` before `verifyActionDefinition`; (f) `agentDoorLegacy` in `engine/executor.ts`. Comments and test files stay clean. `security-invariants.test.ts`, a new `I58` block: the wiring strings in `assemble.ts`; the order pins of (e) on the real files; the behavioural core (an approved type passes, an unapproved Wave 4 type is refused, a changed definition suspends at each of the three points, either lockoff refuses an approved type); the legacy exception (one of the 47 with no approval is accepted and flagged); the notice text exists in no file. Invert `:4414-4423` and delete `:4425-4436`; rewrite `:4215-4229` and `:4244-4259`. RED.
2. Wire: build the runtime with a late-bound listing holder before `captureGate`, bind it after `createSchedulerWithMesh` (`:4097`), pass its functions to the gate and the act wiring; `listProposableActionTypes` becomes `acceptedTypes` plus the user-MCP patterns. Delete the notice and every "not enforced" sentence in code. Add D49(a), (c)-(f) with anchors and `::error` lines. Write I58, rewrite the D49 section, and amend I28 (the submit and accept orders, the per-basis refusal, bound rows proposable, the stored code, the wiring list), I53 (the agent door as a second origin; `CONNECTOR_WRITE_OFFER_BY_KIND` unaffected), I54 (the proposer's input is never a bound field) and the one-liners. GREEN, then `bun run audit:invariants` and `bun run audit:status-drift`.
3. Red-proofs: revert each of the five clauses' production lines in turn and watch the audit fail.

### Task 10 - The behaviour end to end (integration, always on)

Files: `packages/gateway/test/integration/mcp-sink/{agent-door-flow,agent-door-enable,approvals-flow}.test.ts`. Real SQLite, the real dispatch entry those files already use, a real consent coordinator, a fake mesh listing.
- **The window (OR-AD-9).** With an empty door table: each of the 47 types is accepted from an `mcp` connection, stored `legacy = 1`, warned in the reply, listed with the header, approved through `approvals.approve` with the warning in the prompt, dispatched once; a mail send likewise; no listing call is made at submit; `status` counts them.
- **Opt-in.** Enable GitHub for agents at wave 4 and approve: `github.pr.merge` is accepted, `legacy = 0`, no warning. Without the enable it is `ERR_CAPTURE_ACTION_NOT_PROPOSABLE`; at wave 3 likewise; with the enable but the tool not approved likewise.
- **A2 on the real row** (replaces `approvals-flow.test.ts:324-420`): `github.pr.merge` is denied for an empty, a wrong-case, a trimmed and an echoed answer and for a non-human answer, approved only for the exact text; the prompt carries the before-state and the proposer block; an unreadable before-state is refused before any prompt.
- **Bound rows.** `github.file.commit` is proposed with 32 KiB of new text, the prompt carries the diff, and a caller-supplied bound field is refused before any read; `iac.terraform.apply` with no approved directory is refused at submit.
- **Suspension.** One byte of a listed description changes: refused at submit; changed after submit, refused at approval; changed while the prompt is open, refused after the answer; `status` lists both prefixes; `enable --approve <tool>` clears it and the proposal then runs.
- **Not legacy.** A never-offered non-mail row, a Wave 4 row with no approval and a suspended tool of one of the 47 types are refused.
- **Policy.** `mcp_action` off refuses everything; `connector_write_model_access` off refuses an approved Wave 4 type and (OD-1 (b)) still accepts one of the 47 as legacy.
- `captures.accept` from an undeclared connection still approves a legacy row and is refused for an approved one.

### Task 11 - The MCP tool text

Files: `packages/cli/src/mcp/capture-tools.ts` and its test. Tests first: the `propose_action` description no longer says "send an email"; it says the list is what this machine accepts now and that a deprecated type is accepted with a warning; the appended list is the gateway's; the result text is unchanged for an approved proposal. `capture_status`'s description gains that a `rejected` action may carry a code. RED, implement, GREEN.

### Task 12 - Docs (the five core docs, CHANGELOG, skills)

Every row of sweep C. `docs/CHANGELOG.md`: the deprecation first, then what newly works, then the bounds. `docs/roadmap.md`: progress notes; *The same prompt* closes. `docs/cli-reference.md`: the agent-door section rewritten as enforced, the legacy line of `status`, the reject codes. `docs/architecture.md`: the verdict, the three check points, the consent-side veto and why it is not a dispatcher wrapper. Skills: `nimbus-mcp-sink.md` (the new submit and accept orders), `nimbus-security-invariants.md` (the ceiling), `nimbus-file-map.md` (the new modules).

### Task 13 - Verification (sequential, never two runs at once; scoped, no whole-repo suite locally)

1. `bun run typecheck`, then `bun run typecheck:tests`.
2. `bun run preflight:fast`.
3. `bun test packages/gateway/src/mcp-sink`.
4. `bun test packages/gateway/src/connectors/connector-writes`.
5. `bun test packages/gateway/src/ipc` (the whole directory).
6. `bun test packages/gateway/src/security-invariants.test.ts` (the whole file).
7. `bun test packages/gateway/src/engine/connector-write-agent-tools.test.ts packages/gateway/src/engine/proposer-block.test.ts` and the new `door-rejection` test (file names to be confirmed by glob).
8. `bun test packages/gateway/test/integration/mcp-sink`.
9. `bun test packages/cli/src/commands`, then `bun test packages/cli/src/mcp`, then `bun test scripts/structure-audit`, then `bun run audit:invariants` and `bun run audit:status-drift` again.
10. Coverage of the new files against the 85% line and 80% branch floors is CI-Linux-authoritative: `bun run verify:docker --changed`.
11. Red-proofs recorded in the PR: (a) the `suspended` arm of the verdict; (b) the `WHERE` of the suspended check in `agentOffered`; (c) 5c at submit; (d) 4d at approval; (e) the `vetoingConsent` wrap; (f) the legacy write in `writeSubmittedCapture`; (g) each D49 clause; (h) the kind check on the status agent section; (i) the `humanOnly` rule of 4e.
12. Re-check the branch name, then strip the plan and spec before the PR.

## AD3a-2b in outline (`describe_actions`; its own short plan after AD3a-2a is reviewed)

1. **Gateway method `capture.describe { service?: string }`**, in `ipc/capture-rpc.ts`'s table beside `capture.status` (`:223`), for a connection whose role is `submit` only (`CAPTURE_ROLE_BY_KIND`). The `capture` namespace is already LAN-forbidden; nothing is added to the Tauri allowlist; no HTTP route. It returns, per accepted type: `actionType`, `wave`, `typedConfirm`, `bound`, `description`, `inputSchema`, `legacy`, `suspended` with the fixed reason. An approved type's description is the model door's own text (`describeFor`, `engine/connector-write-agent-tools.ts`, ending `:310`, exported), which wraps the listed description with `wrapToolDescription` (I11), and its schema is `offeredInputSchema` with the bound fields removed (`:408-411`). A legacy type carries its type and the deprecation line only, with no schema, because listing every configured service would start every connector (the reason `listProposableActionTypes` gives at `connectors/proposable-actions.ts:364-368`).
2. **Listing.** One listing per service that has an agent approval, sequentially. Reviewer decisions: whether a describe call marks a suspension on first observation (recommended: yes, through `checkAgentToolDefinition`, the one place that marks) and whether it has its own attempt limit.
3. **MCP tool `describe_actions`** in `packages/cli/src/mcp/capture-tools.ts`, read-only annotations, registered with `propose_action` (`actionEnabled`). `propose_action`'s description then points to it instead of appending the type list. Sweep: `docs/cli-reference.md:1642` ("21 read-only tools, plus up to five opt-in write tools ... and the read-only `capture_status`"), `packages/cli/src/commands/mcp-server.ts:79`, `capture-tools.test.ts` name lists (`:37-39`, `:141-155`, `:318-337`).
4. **Tests.** Every returned type passes `verdict` as accepted at that moment; a suspended tool appears with `suspended` and no schema; an injected description with a closing-envelope sequence stays inside the envelope; a bound field is absent from the schema; an `mcp` connection only; OD-3's text.
5. **I11** gains one sentence (the results an agent reads are `capture_status`'s fixed fields and `describe_actions`). No new invariant, no static rule.
6. PR title: `feat(gateway): add describe_actions, the read tool that tells an outside agent which writes it may propose`.

## Spec coverage (mapped to a task STEP, or to an AD3a-2b outline item)

| Requirement | Where |
| --- | --- |
| `agentOffered` beside the shared predicate; enabled to the wave, approved by name, hash, policy, grants (D-AD-5) | Task 3 step 1 "Parity", "Per-call re-read"; D-1 |
| It runs at submit, cheap, no reads (D-AD-5; correction 7 of the AD3a plan) | Task 4 step 1 "Order" |
| It runs at approval start (§ 7.2 step 4) | Task 5 step 1 "Step 4" |
| It runs before dispatch (D-AD-9; correction 8) | Task 6 step 1 "Veto", "Through the real executor"; correction 1 |
| One refusal set, `modelWriteRefusal` (D-AD-6) | Task 3 step 1 "Refusal" |
| `ERR_AGENT_TOOL_SUSPENDED`, the sticky mark and the audit row where first seen (D-AD-9, OR-AD-5) | Task 2 step 1; Task 4, 5, 6; Task 10 "Suspension" |
| Re-approval by name clears a suspension | Task 10 "Suspension" |
| Legacy accepted, flagged, counted (D-AD-15, OR-AD-9) | Task 3 "Verdict"; Task 4 step 1; Task 10 "The window" |
| The warning in the `propose_action` result, in `approvals` list and detail, in the prompt, in `status` (§ 11) | Task 7 |
| Mail sends: warn now, refuse in AD3b (OR-AD-3, OR-AD-9) | Task 3 "Verdict"; Task 7; Task 10 "The window" |
| A never-offered non-mail row, a Wave 4 row and a hash mismatch are not legacy (D-AD-15) | Task 3 "Verdict"; Task 10 "Not legacy" |
| A legacy proposal runs through the one executor path | Task 10 "The window" |
| Wave 4 offered only after `--wave 4 --door agent` and approval by name; refused before any prompt when the before-state is unreadable (OR-AD-7) | Task 10 "Opt-in", "A2 on the real row"; Task 6 "Options" |
| Bound rows proposable; the payload cap (D-AD-7; correction 16) | Task 1 step 1; Task 6 "Routing"; Task 10 "Bound rows"; correction 8 |
| A refusal at approval finalizes `rejected` with a fixed code (§ 7.2) | Task 5 step 1 "Finalize"; Task 6; D-6 |
| A2 on a real Wave 4 type (AD2's deferral) | Task 10 "A2 on the real row" |
| A policy lockoff of either capability empties the door (§ 10) | Task 10 "Policy"; OD-1 for the legacy half |
| Parity table over every row (§ 7.3, § 10) | Task 3 step 1 "Parity" |
| The tool texts (correction 18) | Task 11; AD3a-2b item 3 |
| I58 with its stated exception (§ 7.3) | Task 9 step 2; D-10 |
| D49 remaining clauses, red-proof per clause (§ 7.3, § 10; correction 9) | Task 9 steps 1, 3; D-9 |
| Delete `AGENT_DOOR_NOT_ENFORCED_NOTICE` and every "not enforced yet" statement | Task 9 step 2; Task 12 |
| `status` re-derives the hash and lists both prefixes (already in AD3a-1); the `legacy` line (§ 7.3) | Task 2; Task 7 |
| `describe_actions` (D-AD-10, OD-6) | AD3a-2b items 1-4 |
| Non-breaking `feat`, no `!` (§ 11) | Task 10 "The window"; the delta section |
| Five core docs and CHANGELOG | Task 12 |

## Risks / open questions

- **Reviewer decisions.** R-1 the consent-side veto in place of the dispatcher wrapper (correction 1). R-2 a suspension found at approval start leaves the row proposed. R-3 the description rule of the hash. R-4 the wording of the status line. R-5 the kind check on the status agent section. R-6 an `approved` proposal can be approved only through `approvals.approve`. R-7 the prompt's deprecation line follows the approval-time basis while the list and the count follow the stored flag. R-8 320 KiB for the action payload cap. R-9 the denied classes' fixed texts tell an agent which condition failed.
- **The executor's own audit row for a vetoed approval says the owner declined.** The veto turns an approval into a decline before the executor records it, so the executor's row carries the decline reason; the capture's outcome row carries `ERR_AGENT_TOOL_SUSPENDED` and the suspension has its own audit row. Stated in I58's bounds.
- **A listing at submit, at approval and after the answer** means up to three listings per approved proposal and a possible connector start at submit. `MCPClient.listTools` caching is UNVERIFIED (Task 0 step 4b): if it caches for the life of a slot, a definition changed without a slot restart is not seen. First-party definitions change only with the bundled connectors package, which needs a restart; AD5 must re-check for user MCP.
- **Upgrade friction (OR-AD-13)** now bites at submit, not only in `status`: after a connectors bump that edits a description, an approved tool is refused until re-approved. During the window a suspended tool of one of the 47 types is refused although the unapproved type next to it is accepted with a warning. That follows D-AD-15 and must be in the release notes.
- **The raw `captures.accept` RPC** still approves a legacy proposal from an undeclared connection with any answer source (the bound I28 already states). What the CLI answers to a typed-confirmation request under `--yes` is UNVERIFIED; R-6 keeps the new reach off that path whatever the answer.
- **Test churn.** Five existing pins are inverted on purpose (sweep B). Do those edits first inside Task 9 so a rewritten expectation cannot absorb a behavioural change; the 47-type snapshot of AD1 is kept as the legacy baseline, not deleted.
- **The flip commit is large** (wiring, checker, three invariant texts, one new invariant). The triple rule requires it; Tasks 1-8 keep it to wiring and text.
- **Not read in this plan (UNVERIFIED):** the desktop's `ProposedBy` contract in `packages/ui` (the plan adds the deprecation to the prompt text only and leaves `proposerDetails` unchanged); `ipc/approvals-rpc.test.ts` and `ipc/capture-rpc.contract.test.ts`; `docs/cli-reference.md:3365` beyond its first sentence; the text of `policy/types.ts` about `mcp_action`; PR #1965's files; the I57 reservation.

## PR

AD3a-2a title (conventional commit, no `!`; a user who changes nothing keeps every earlier use, with a warning):

`feat(gateway): hold outside agents to the writes the owner approved for them by name, with a deprecation warning for earlier use`

Description: the delta in both directions; the corrections that apply (1-11); OD-1 and OD-2 as ruled; the six follow-ups; I58 and D49(a), (c)-(f); the stated bounds; the red-proofs; the verification output. The release that ships it leads its notes with the deprecation. End with the attribution lines from the session. No `Release-As:` trailer.

## Review log

(empty)
