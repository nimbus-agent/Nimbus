# Plan — Agent door AD3a: per-door eligibility (`--door agent`, the definition hash, suspension, the deprecation window)

Status: DRAFT for review (2026-11-13). Not yet reviewed by Antigravity. **Recommendation: split into two stacked PRs.** AD3a-1 (this plan, in full): schema V97, the per-door approval store, the definition hash, `nimbus connector writes enable|disable|status --door agent`, static D49(b). AD3a-2 (in outline at the end): `agentOffered` at the gate, suspension on the act path, the legacy flag and its four warnings, Wave 4 and bound rows for agents, acceptance A2 on a real Wave 4 type, invariant I58 and the rest of D49.
Spec: `docs/superpowers/specs/2026-11-13-agent-door.md` (approved, round 2): § 2 (OR-AD-2, OR-AD-3, OR-AD-5, OR-AD-7, OR-AD-9), § 4 (D-AD-5, D-AD-6, D-AD-7, D-AD-9, D-AD-14, D-AD-15), § 6 (the AD3a row), § 7.2 (submit and approve steps), § 7.3, § 9, § 10 (AD3a bullet), § 11, § 12.
Roadmap row: Phase 28 *Write parity with the model door* (`docs/roadmap.md`, Phase 28 section, line 3055 onward), and the open half of *The same prompt* (typed confirmation on a real Wave 4 proposal).
Base: AD3a sits on AD2 (PR #1997, branch `dev/asaf/p28-ad2`, head `96d89e376`). **Every `file:line` below was read in the worktree `C:\gitrep\Nimbus\.claude\worktrees\p28-ad2`.** Paths are relative to `packages/gateway/src/` unless they start with `packages/`, `scripts/`, `docs/` or `.claude/`. Numbers re-derived there: `CURRENT_SCHEMA_VERSION` = 96 (`index/local-index.ts:309`); no `*-v97-sql.ts` exists; `docs/SECURITY-INVARIANTS.md:3` says invariants I1–I56 and static rules D10–D48. So the migration is **V97**, the static rule is **D49**, and the invariant is **I58** (I57 is reserved by the incident-engine spec according to the agent-door spec § 6; that reservation is not written anywhere in this tree, so it is UNVERIFIED here and Task 0 re-checks it).
Row facts were derived by running the write table read-only (`bun -e` over `connectors/connector-writes/index.ts`, `model-offerable.ts`, `connectors/proposable-actions.ts`): 125 write rows, 124 distinct action types, 109 model-offerable rows (wave 2: 39, wave 3: 29, wave 4: 41), 16 never offered, 6 bound rows, 39 services with an offerable row; 47 proposable types, 185 classified, 138 denied, 9 `not_yet_offered`; the only proposable types whose row is not model-offerable are the seven mail sends; no proposable type is Wave 4.

After AD3a-1: the owner can approve connector writes for outside agents by name (`nimbus connector writes enable <svc> --door agent [--wave N] [--approve <pattern>...]`), each approval stores a SHA-256 of the tool's listed definition, `status` shows an agent column and lists every tool whose definition changed since it was approved, and `disable` removes the agent list. The schema is ready for AD3a-2 (the `legacy` column, an error code on a `rejected` action). **What an outside agent can propose does not change in AD3a-1**: the capture gate still classifies by `ACTION_PROPOSABILITY`. AD3a-2 makes the list count.

## Size and split

AD3a as the spec's § 6 row describes it touches the migration runner, a new store, the mesh listing, the enable handler and its prompt, the CLI, the capture gate's submit order, the act door's step 4, the dispatch path, four warning surfaces, the routing table, the refusal set, a new invariant and a six-clause static rule. AD2 was eleven tasks; this is about twice that. The split point is where the triple rule allows one: AD3a-1 adds data and an owner surface and no enforcement claim; AD3a-2 adds the enforcement and therefore the invariant. Sub-rule D49(b) (the table confinement) lands with its table in AD3a-1, as D46(b) landed alone with (a) and (c) reserved (`scripts/structure-audit/check-nimbus-invariants.ts:1021-1028`).

Consequence that needs the owner (Owner decision OD-1): between the two merges, `enable --door agent` records approvals that nothing reads yet.

## The behavioural delta of AD3a-1, stated precisely

What does NOT change (each pinned by a test, Task 9):

- **Reach.** `ACTION_PROPOSABILITY`, `classifyActionType`, `PROPOSABLE_WRITE_TOOLS`, `actDoorRefusal`, `submitCapture`'s order (`mcp-sink/capture-gate.ts:411-495`) and `acceptAction`'s eight steps (`mcp-sink/capture-act.ts:153-289`) are untouched. The 47 proposable types stay; no Wave 4 or bound type becomes proposable; mail sends stay proposable with no warning yet.
- **The model door.** `offeredUnder` (`connectors/connector-writes/model-write-source.ts:74-82`) returns the same value for every input. A model-door `enable` with no `door` param runs the same code path and writes the same rows.
- **HITL types (185), the Tauri allowlist, LAN lists, HTTP routes.** No new IPC method, no new HITL type: the agent enable is the existing `connector.writes.enable` type with `door: "agent"` in its payload (I3: the gate reads the type only).

What DOES change:

1. **Schema V97.** A new table `connector_write_door_approval`; `capture` is rebuilt to add `legacy INTEGER NOT NULL DEFAULT 0` and to let a `rejected` action carry an `error_code`. No row is written to `legacy` and no code is stored on a `rejected` row until AD3a-2.
2. **`connector.writesEnable` takes `door: "agent"`** and optional `approve: string[]`. It lists the service's tools, shows a prompt of exactly the rows that can be approved for agents (name, type, wave, typed-confirmation flag, first 12 hex of the definition hash), and on approval stores one row per tool with its hash. It creates the shared V83 row or raises its wave; it never lowers it and never touches the model's approved set.
3. **`connector.writesDisable`** also removes the service's agent approvals; with `door: "agent"` it removes only those.
4. **`connector.writesStatus`** gains, per service, the agent approvals and a `suspended` list, re-derived from a live listing; a tool whose hash no longer matches is marked suspended in the table (sticky) and stays so until re-approved by name.
5. **The shared wave can now be raised by an agent enable.** The model is offered nothing new by that (V84 gates by name); a test pins it and I53 gains a stated bound.

## Spec contradictions and corrections (checked against the code)

Each is binding for this plan and is reported. Corrections 8, 9, 12, 16 and 18 land in AD3a-2 and are listed here so its plan does not re-search.

1. **The parity formula in § 7.3 would require the MODEL's approval too.** `agentOffered(e, row) <=> offeredUnder(e, row) && approvedForAgent(row)`: `offeredUnder` includes `e.approvedToolIds.has(row.toolId)`, the model's V84 set (`model-write-source.ts:74-82`). That contradicts OR-AD-2 and D-AD-5 ("the wave enable is shared; agents have their own approved-tool-id list"). Resolution: factor the three shared conditions out of `offeredUnder` into one exported `enabledAndOfferable(e, row)` (service match, `row.wave <= e.maxWave`, `isModelOfferableRow(row)`); the model predicate is that plus the V84 set, the agent predicate is that plus the door set. The parity test compares both against the shared function.
2. **Counts.** The spec says "108 of 124 rows, 16 never offered". The tree has 125 rows, 109 offerable, 16 never offered (SA2 added the Gmail archive; `CLAUDE.md:8` "Counts at SA2"). Tests derive counts from the table and never hard-code 108.
3. **An action type does not identify a row.** `propose_action` names an action type; the door approves by tool id. `slack.message.post` has two rows, `slack_message_post` and `slack_message_post_dm`, and `PROPOSABLE_WRITE_TOOLS` routes it to the first (`connectors/proposable-actions.ts:76`; the I28 doc says the act door does not route the Slack DM). The routing table covers only the 47 proposable types (`:75-134`), so the 62 other offerable rows have no route. Resolution: a total routing function over the write table, `agentDoorRow(actionType)` (D-3), with one named tie-break; the Slack DM row cannot be reached by an agent. Owner decision OD-2.
4. **"The existing `--wave` and `--approve` patterns" (OR-AD-2) and "exactly as the model door's enable prompt does" (D-AD-14).** No `--approve` flag exists anywhere in `packages/cli/src` or `packages/gateway/src` (grep), and the model's enable prompt shows tool id, type, wave and a state marker but no typed-confirmation flag (`connectors/connector-writes/enable-prompt.ts:230-256`). The model door approves "by name" by listing every offerable row in one prompt (`ipc/connector-rpc-handlers/model-writes.ts:433-435`). Resolution: `--approve` is NEW and optional (D-6); the agent prompt adds the typed-confirmation flag; the model prompt is not changed.
5. **The DDL in § 7.3 has nowhere to record a suspension.** D-AD-9 says a mismatch "marks the tool suspended" until re-approval by name. If suspension were only the live comparison, a server that changed a definition and changed it back would un-suspend itself. Resolution: two nullable columns, `suspended_at` and `suspended_sha256`, set once by a conditional UPDATE and cleared only by re-approval.
6. **`definitionSha256 = SHA-256(canonicalJson({toolId, description, inputSchema}))`.** The listed `inputSchema` is not JSON: the mesh hands out what `MCPClient.listTools()` returned (`connectors/lazy-mesh/mesh.ts:956-958`), and the door reads it through `readListedJsonSchema` (`engine/user-mcp-agent-tools.ts:101-108`), which returns `undefined` for an unrecognised shape. Resolution: hash the JSON Schema that function returns; `undefined` means the tool cannot be approved (and in AD3a-2 a proposal for it is refused). The repo's `extensions/canonical-json.ts` `canonicalize` is unsuitable: it NFC-normalises string values and refuses non-integer numbers (`:36-43`), so a one-byte change could be invisible and a schema with `0.5` would throw. `automation/workflow-steps.ts:431-439` `canonicalJson` has the right behaviour (sorted keys, no normalisation).
7. **"`agentOffered` runs at submit (cheap, no reads)" (D-AD-5) against "the hash is re-derived at submit" (D-AD-9).** Re-deriving needs `listFirstPartyServerTools`, which ensures the service's slot and may spawn the connector (`mesh.ts:924-960`). Resolution for AD3a-2: order the submit checks so the listing is last and runs only for a tool the owner has approved for agents on an enabled, configured service; every other refusal stays free of I/O. Stated: a proposal for an approved tool can start that connector's process, as a model turn's listing does. Reviewer decision (the alternative is to hash at submit only when the slot is already running).
8. **"Immediately before dispatch inside the same `toolsEpoch` generation" (D-AD-9).** The act path's last seam before the connector call is before `executor.execute` (`ipc/capture-rpc.ts:183-188`), which is before the before-state and the owner's prompt. AD3a-2 needs a dispatcher wrapper that re-checks for the write's own action type only and keeps the bound-write capabilities (`connectors/connector-write-dispatch.ts:20-25`; static D42(h) lets only `connectors/registry.ts` name them, `scripts/structure-audit/check-nimbus-invariants.ts:3230-3243`), so the wrapper lives under `connectors/`.
9. **Static D49 as the spec words it does not match the code.** (a) repeats D39(e), which already confines `buildAgentWriteExecutor` to `engine/run-ask.ts` and `ipc/capture-rpc.ts` (checker `:2392-2395`). (c) says `proposer:` and `origin: "agent"` are written only by `ipc/approvals-rpc.ts`; they are written in `ipc/capture-rpc.ts` `buildActDeps` (`:183-188`), pinned there by `security-invariants.test.ts:4248-4249`, and `approvals-rpc.ts` only calls `buildActDeps` (`ipc/approvals-rpc.ts:142-151`). (e) says `approvals.approve` calls `agentOffered(` before `buildAgentWriteExecutor(`; `approvals.approve` calls `acceptCapture`, and nothing under `mcp-sink/` may import `connectors/` (D32(f)), so the predicate arrives injected. AD3a-2 rewrites (a), (c), (e) against the real sites.
10. **"`enable --door agent --wave N` creates or raises it".** The only V83 writer, `setModelWriteEnablement`, replaces `max_wave` and `approved_tool_ids` whole (`connectors/connector-writes/enablement-store.ts:69-85`). Resolution: a second writer, `raiseWriteEnablementWave`, that inserts a row with an empty model set or raises `max_wave` and touches nothing else. Stated: a later model-door `enable <svc> --wave 2` still replaces the row, so it narrows the agent door too.
11. **`enable iac` and `enable kubernetes` replace the shared grants** (`model-writes.ts:408-437`; `parseIacGrants` requires a directory or cloud, `:280-282`). Resolution: `--door agent` takes no scope flag; it reads the existing V85/V86 grants and a Terraform or Kubernetes row is approvable only while one exists.
12. **`ERR_AGENT_TOOL_SUSPENDED`** is not a member of `CaptureErrorCode` (`mcp-sink/capture-types.ts:34-49`) or `ACTION_ERROR_CODES` (`:126-132`). AD3a-2 adds it.
13. **Where the predicate lives.** D-AD-5 says "beside `offeredUnder` in `model-write-source.ts`"; § 7.3's wiring list says `connectors/connector-writes/agent-door.ts`. Resolution: the shared half is exported from `model-write-source.ts`; everything agent-specific is in `agent-door.ts`. The capture gate is wired in `platform/assemble.ts:3935-3961`, not in `ipc/approvals-rpc.ts`.
14. **"Re-derived at every `status`".** `handleConnectorWritesStatus` is synchronous and reads no listing (`model-writes.ts:463-508`); the CLI reference says status "does not check credentials or the server's listing" (`docs/cli-reference.md:3302`). Resolution: the model's status function is unchanged; a separate async `agentWritesStatus` lists only services that have an agent approval.
15. **V69 and AD2's regression test.** AD2 pinned that `finalizeAction(id, "rejected", { errorCode })` throws (`mcp-sink/capture-gate.ad2.test.ts:221-227`). V97 relaxes the CHECK (`index/capture-action-v69-sql.ts:40`), so Task 1 inverts that test, and adds a pin that `acceptAction` still stores no code on a `rejected` row until AD3a-2.
16. **Payload cap for bound rows (D-AD-7).** `PAYLOAD_MAX_BYTES = 65_536` bounds the JSON of the whole payload (`mcp-sink/capture-validate.ts:27`, `:171`). A 51,200-byte CloudFormation template or 32 KiB of file text can exceed it once JSON-escaped. AD3a-2 raises the cap for `kind: action` only.
17. **The Obsidian sandbox write grant reads the MODEL's set** (`enablement-store.ts:112-116`). An append approved for agents only would be refused by the sandbox. Owner decision OD-4.
18. **`capture.status` and the tool text.** `propose_action`'s description says "send an email" and appends `proposableActionTypes` (`packages/cli/src/mcp/capture-tools.ts:213-217`). AD3a-2 changes what is advertised.

## Owner decisions (design or limitation choices the spec does not settle)

- **OD-1 Releasing the two parts.** (a) Merge AD3a-1 and AD3a-2 before the release PR that "ships AD3a" is merged, so no release carries an approval list nothing reads. (b) Allow a release in between; AD3a-1's `enable` and `status` then print one interim line saying the list takes effect in the next release. (c) Do not split: one large PR. Recommendation: (a).
- **OD-2 The Slack DM row.** (a) An agent cannot propose a Slack DM in AD3a; the parity test names that one row as the stated exception. (b) `propose_action` gains an optional `tool` field (changes the tool schema AD6b snapshots). (c) A separate agent-door action type alias for the DM. Recommendation: (a).
- **OD-3 Who may approve `enable --door agent`.** (a) A connection that declared `cli` or `ui`, and a human answer only (`--yes` and scripted consent become a decline), the rule `approvals.approve` and `standing.rule.create` use. (b) The model door's rule: any answer source, any owner connection. (c) Human-only for `--wave 4` only. Recommendation: (a); it is the same friction OR-AD-6 asks of approvals, and the kits already steer agents away from `nimbus connector writes`. This plan is written for (a).
- **OD-4 Obsidian for agents.** (a) The append is approvable for agents only while the model-door approval (which is the sandbox grant) exists; I15 is unchanged. (b) An agent approval also turns the sandbox write grant on; I15 is amended and the agent prompt shows the widening lines. (c) The Obsidian append is not approvable for agents. Recommendation: (a).
- **OD-5 A gateway upgrade that changes a first-party definition.** First-party listings change only with the bundled connectors package. (a) OR-AD-5 taken literally: every changed tool is suspended for agents after the upgrade until re-approved by name; `status` says how many and why. (b) First-party hashes are re-based automatically on a gateway version change and only user-MCP tools (AD5) suspend. Recommendation: (a), because the ruling says "any change".
- **OD-6 `describe_actions` (D-AD-10) belongs to no slice in § 6**, yet AD6b and AD7 assume it. (a) AD3a-2 adds the gateway method and the MCP tool. (b) A small slice of its own after AD3a-2. (c) AD6b builds it. Recommendation: (a) for the gateway method, because it needs AD3a-2's eligibility and hash; the MCP tool can follow in the same PR.

## Every place that must change (sweeps, verified by grep in the AD2 worktree)

### A. IPC routing, LAN, Tauri

| Site | Fact | AD3a-1 change |
| --- | --- | --- |
| `ipc/connector-rpc.ts:294-305` | three cases call the handlers with `await modelWritesDeps()`; status is called without `await` on the handler | the enable and disable cases branch on the door inside the handlers; the status case merges `await agentWritesStatus(...)` into the reply |
| `ipc/connector-rpc.ts:199-221` `modelWritesDeps` | has `db`, `toolExecutor`, `getEnforcedPolicy`, and `connectorMesh` for three Obsidian and iac members | add `listServerTools` (`connectorMesh.listFirstPartyServerTools`), `clientKind`, `agentAnswerWasNonHuman` |
| `ipc/server/dispatchers.ts:2385-2392` | ONE gate-only `ToolExecutor` per connector RPC, on `bindConsentChannel(ctx.consentImpl, clientId)` | the consent passed to that one executor is `humanOnlyConsent(ctx.consentImpl, mark)` when the method is `connector.writesEnable` and `params.door === "agent"`; no second `new ToolExecutor(` site (the executor-site censuses stay as they are). Also pass `clientKind: ctx.getClientKind(clientId)` |
| `ipc/lan-rpc.ts:100-102`, `:266-267` | the three methods are already full-method entries in `FORBIDDEN_OVER_LAN`; enable and disable are in `WRITE_METHODS` | none (no new method). The existing LAN test rows cover them |
| `packages/ui/src-tauri/src/gateway_bridge.rs:608-611` | `allowlist_ws5c_connector_writes` asserts only `connector.setConfig`; no test says the three writes methods are NOT renderer-callable | add `allowlist_connector_writes_never_renderer` (three `assert!(!is_method_allowed(..))`); I7 unchanged |
| `ipc/consent.ts:52-76` `humanOnlyConsent` | AD2's pin says it is used only by `approvals-rpc.ts` (`security-invariants.test.ts`, the AD2 test at `:4292`) | the pin is amended to the two users: `ipc/approvals-rpc.ts` and `ipc/server/dispatchers.ts` (the agent-door enable) |

### B. Static rules and their allow-lists

| Site | Fact | AD3a-1 change |
| --- | --- | --- |
| checker `:2075-2079` `D32_CAPTURE_TABLE_ALLOWED` | three files may name the `capture` table | add `packages/gateway/src/index/agent-door-v97-sql.ts` (the rebuild names it). The real scan skips `-sql.ts` files (comment at `:932`), so this matters for synthetic sets and the docs |
| checker `:2065` `sqlTableReferenceRe`, `checkTableConfinement` (`:2081`) | the shared table-confinement helper | new D49(b): `connector_write_door_approval` only in `connectors/connector-writes/door-approval-store.ts` and the V97 DDL file |
| checker `:4768` `RULE_ANCHORS` | every rule anchors on a scanned file | add `connectors/connector-writes/door-approval-store.ts` |
| checker error printer (the D46(b) line at `:5125` is the model) | one `::error` line per rule | add the D49(b) line |
| `docs/SECURITY-INVARIANTS.md:3` | "static rules D10–D48" | D10–D49, with D49(b) described as tied to no invariant until AD3a-2 lands I58; a `## D49` section after the D48 section (`:2164`) |
| `CLAUDE.md:104` and `GEMINI.md` | "static rules D10–D48" | D10–D49 |
| checker `:2392-2395` D39(e) | `buildAgentWriteExecutor` allow-list | unchanged in both parts |

### C. Counts and texts

| Item | Today | AD3a-1 |
| --- | --- | --- |
| Schema ceiling ("schema V96") in `CLAUDE.md:8`, `GEMINI.md`, `docs/README.md`, `docs/roadmap.md` | V96 | V97 everywhere `audit:status-drift` reads (`scripts/structure-audit/check-status-drift.ts:519-522`); the SQL file name must end `-v97-sql.ts` (`:165`) |
| HITL types (`engine/executor-confirm.test.ts:543`) | 185 | 185 |
| Proposable / denied / `not_yet_offered` | 47 / 138 / 9 | unchanged (AD3a-2 states what the door accepts beside these) |
| Never-offered reason text for the seven sends (`connectors/connector-writes/model-offerable.ts:18-24`) | "never offered to the model" | "mail sends are never offered to agents or the model" (spec § 7.3). Grep the old text in tests and docs before changing it |
| CLI usage and help (`packages/cli/src/commands/connector-writes-cli.ts:12-18`, `packages/cli/src/commands/connector.ts:1425-1427`) | no door | the `--door agent` forms |
| `docs/cli-reference.md:3294-3302`, `:3317-3330` | model door only | a `--door agent` subsection |
| `docs/architecture.md:718`, `:728`, `:744` | three methods, the approved set | the door param, the door table, the hash |
| `docs/schema-reference.md` | V67 `capture` DDL at `:1046-1072`; the header's "latest" sentence is stale at V85 | add V97 (table DDL, the rebuilt `capture` constraints) |
| MCP tool texts (`packages/cli/src/mcp/capture-tools.ts`) | unchanged | AD3a-2 |

### D. Seam types compared (not just names)

| Seam | Today | AD3a-1 |
| --- | --- | --- |
| `setModelWriteEnablement(db, service, maxWave, now, approvedToolIds: readonly string[]): void` (`enablement-store.ts:69-75`) | upsert that replaces all four columns | unchanged; new `raiseWriteEnablementWave(db, service, maxWave: ConnectorWriteWave, now): void` |
| `ModelWriteEnablement { service; maxWave; enabledAt; approvedToolIds: ReadonlySet<string> }` (`:13-23`) | model only | unchanged; agent approvals are a separate type, never a field of this one |
| `ModelWritesDeps` (`model-writes.ts:62-112`) | no listing, no caller kind | new `AgentWritesDeps = ModelWritesDeps & { listServerTools: ConnectorWriteToolSource["listServerTools"]; clientKind: ClientKind; agentAnswerWasNonHuman(): boolean }` |
| `ConnectorWriteToolSource["listServerTools"]`: `(service: string) => Promise<Readonly<Record<string, unknown>> \| undefined>` (`engine/connector-write-agent-tools.ts:90`) | the model door's listing | the same function type for the enable and status handlers; each entry is `{ description: unknown; inputSchema: unknown }` keyed by `mcpClientToolKey(service, toolId)` (`mesh.ts:949-958`, `lazy-mesh/tool-map.ts:98-100`) |
| `enableWritesPromptLines(payload: Record<string, unknown> \| undefined): string[] \| undefined` (`enable-prompt.ts:221-223`) | returns `undefined` for a malformed payload, and the executor then leaves the purpose-built rendering (`engine/executor.ts:576-582`; what it renders instead was not read, UNVERIFIED) | a `door: "agent"` payload has its own validated shape; the handler calls the function itself first and refuses when it returns `undefined`, so a malformed payload never reaches a prompt |
| `handleConnectorWritesStatus(deps): { services: [...]; policyAllows: boolean }` (`model-writes.ts:463-480`), synchronous | model only | unchanged; the RPC reply gains `agent: { policyAllows: boolean; notice?: string; services: Array<{ service; approved: number; suspended: Array<{ toolId; approvedAt; approvedSha12; nowSha12 }>; unverified?: string }> }` |
| `CaptureStore.finalizeAction(id, state: "executed" \| "failed" \| "rejected", f: { outcomeRef?; errorCode? }, nowMs): boolean` (`mcp-sink/capture-store.ts:301-315`) | a code on `rejected` throws at the CHECK | the signature is unchanged; the table now accepts it |
| `RawRow` / `toRow` (`capture-store.ts:52-89`), `SELECT *` | 14 columns | the 15th column `legacy` is ignored by `toRow` until AD3a-2 adds `CaptureRow.legacy`; `insert` names its columns (`:99-117`), so the default 0 applies |

## Design decisions

**D-1 V97, one step, one SQL file `index/agent-door-v97-sql.ts`.** (a) `CREATE TABLE IF NOT EXISTS connector_write_door_approval (service TEXT NOT NULL, door TEXT NOT NULL, tool_id TEXT NOT NULL, approved_at INTEGER NOT NULL, definition_sha256 TEXT NOT NULL CHECK (length(definition_sha256) = 64), suspended_at INTEGER, suspended_sha256 TEXT, CHECK ((suspended_at IS NULL) = (suspended_sha256 IS NULL)), PRIMARY KEY (service, door, tool_id)) WITHOUT ROWID`. `door` has no value CHECK because the spec keeps it open for later doors; the store's type allows only `"agent"` (reviewer decision: the migrations skill asks for a CHECK on enum-like columns). (b) `capture` rebuilt as `capture_v97` with every V69 column named on both sides of the copy (the V69 pattern, `index/capture-action-v69-sql.ts:9-47`), plus `legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1))`, `CHECK (legacy = 0 OR kind = 'action')`, and the error-code CHECK changed to `state IN ('failed','rejected')`; the three indexes are recreated. The step is a hand-written `migrateIndexedV96ToV97` like `migrateIndexedV68ToV69` (`index/migrations/runner.ts:429-446`): count rows before and after and throw on a difference. It must be re-runnable (the suites rewind `user_version`, `.claude/commands/nimbus-db-migrations.md` § V95): probe `PRAGMA table_info(capture)` and skip the rebuild when `legacy` exists. No backfill.

**D-2 `connectors/connector-writes/door-approval-store.ts`, the only module that names the table (D49(b)).** `type WriteDoor = "agent"`. `listDoorApprovals(db, door, service?)`, `getDoorApproval(db, door, service, toolId)`, `replaceDoorApprovals(db, door, service, entries, now)` (delete the service's rows, insert the given ones), `upsertDoorApprovals(db, door, service, entries, now)` (re-approval: sets the new hash and clears both suspension columns), `removeDoorApprovals(db, service, door?)`, `markDoorToolSuspended(db, door, service, toolId, observedSha, now): boolean` (one UPDATE `WHERE suspended_at IS NULL`, so the first observation wins and a repeat is a no-op). Every write goes through `dbRun` (I14). An entry is `{ toolId: string; definitionSha256: string }`.

**D-3 `connectors/connector-writes/agent-door.ts`** (no `engine/executor.ts` import, so no cycle with `proposable-actions.ts`).
- `agentDoorRow(actionType, rows = CONNECTOR_WRITE_ROWS): ConnectorWriteRow | undefined`: the one row of that type; for a type with several rows, the row named in `AGENT_DOOR_TYPE_TIEBREAK` (`{ "slack.message.post": "slack_message_post" }`); a test makes the tie-break total over multi-row types and equal to `PROPOSABLE_WRITE_TOOLS` for them.
- `agentApprovableRows(service, maxWave, ctx): Array<{ row; state: "approvable" } | { row; state: "not_approvable"; reason: string }>`: `writesEnabledBy(service, maxWave)` (`enablement-store.ts:126-132`), each row approvable when `isModelOfferableRow(row)`, `agentDoorRow(row.actionType) === row`, no `scopeGatedReason`, a Terraform row has an approved directory and a Kubernetes row an approved pair (the rule of `directoryAvailable`, `model-write-source.ts:111-115`), its listed entry exists and hashes (D-4), and for `obsidian_append_to_daily_note` the model grant exists (OD-4). Every reason is a fixed text; a never-offered row shows its `MODEL_NEVER_OFFERED_REASONS` text.
- `agentDoorPolicyAllows(enforced)`: `isConnectorWriteModelAccessEnabled(enforced)` AND `mcp_action` not locked off (`mcp-sink/capture-capability.ts`, `MCP_ACTION_CAPABILITY`); `undefined` is false.
- AD3a-1 does NOT add `agentOffered`: a predicate with no production caller is the B1 anti-pattern. It arrives wired, in AD3a-2.

**D-4 `connectors/connector-writes/definition-hash.ts`.** `definitionSha256(toolId: string, listedEntry: unknown): string | undefined`: `undefined` unless the entry is an object and `readListedJsonSchema(entry.inputSchema)` returns an object; otherwise lower-case hex SHA-256 (`node:crypto`) of the canonical JSON of `{ toolId, description: <the listed string, or null>, inputSchema: <that JSON Schema> }`. Canonical JSON is sorted keys by code unit, no whitespace, no Unicode normalisation: move `canonicalJson` from `automation/workflow-steps.ts:426-439` to `util/canonical-json.ts` and import it from both (reviewer decision; the alternative is a twelve-line copy with an equality test). Stated bound: the hash covers the JSON Schema as this gateway's Mastra version converts it, so a Mastra upgrade that converts differently suspends tools (UNVERIFIED how stable that conversion is across versions).

**D-5 The agent enable handler, `ipc/connector-rpc-handlers/agent-writes.ts`** (a new file; `model-writes.ts` is already 508 lines). `handleConnectorWritesEnable` dispatches to it when `rec.door === "agent"`; any other `door` value except absent or `"model"` is `-32602`. Named steps, in this order, read top to bottom:
1. `requireAgentEnableCaller`: a `toolExecutor` exists and `APPROVER_BY_KIND[clientKind]` (`mcp-sink/capture-client-policy.ts`, the AD2 table), else `ERR_CONNECTOR_WRITES_AGENT_CLIENT`.
2. `parseWave`, `parseEligibleService` (reused, `model-writes.ts:330-347`); any of `workdirs`, `clouds`, `regions`, `net`, `k8sGrants` present is `ERR_CONNECTOR_WRITES_AGENT_SCOPE` (correction 11).
3. `agentDoorPolicyAllows(getEnforcedPolicy())`, else the existing `ERR_CONNECTOR_WRITES_POLICY` with a message naming both capabilities.
4. `await listServerTools(service)`; `undefined` is `ERR_CONNECTOR_WRITES_AGENT_UNLISTED` (the connector is not configured or lists nothing). This is the only I/O before the prompt.
5. `agentApprovableRows(...)`; with `approve` patterns keep only approvable rows whose tool id equals a pattern or starts with its prefix before a single trailing `*`; no match is `ERR_CONNECTOR_WRITES_AGENT_NO_MATCH`. No approvable row at all is `ERR_CONNECTOR_WRITES_AGENT_NOTHING`.
6. Build the payload `{ door: "agent", service, maxWave, raisesSharedWaveFrom?, writes: [{ toolId, actionType, wave, typedConfirm, bound, state, sha12?, reason? }] }`, render it with `enableWritesPromptLines` and refuse `-32603` if that returns `undefined`.
7. `toolExecutor.gate({ type: "connector.writes.enable", payload })`; anything but `proceed` is `ERR_CONNECTOR_WRITES_DECLINED`, with the non-human text when `agentAnswerWasNonHuman()`.
8. ONE `db.transaction`: `raiseWriteEnablementWave`, then `replaceDoorApprovals` (no `approve`) or `upsertDoorApprovals` (with `approve`), each entry carrying the hash computed from the listing of step 4, the one whose prefix the prompt showed.
9. Reply `{ service, door: "agent", maxWave, approved, writes }`.
Row states in the prompt: `already approved`, `will be approved`, `re-approved (definition changed)`, `not approvable (<reason>)`. The prompt's fixed lines: `Door: outside agents (MCP)`, the raised-wave sentence when it applies ("This raises the shared wave for <svc> from <a> to <b>; the model is offered nothing new until you approve it by name"), and the closing pair "Each proposal still asks you, at `nimbus approvals`." and "An agent holding its own credentials can act without Nimbus."

**D-6 `--approve`.** Without it, approving the prompt approves every approvable row up to the wave and replaces the service's agent list (the model door's semantics). With it, only the matching rows are approved and other approvals are kept; this is how a suspended tool is re-approved by name (`enable <svc> --door agent --approve <toolId>`). Patterns are an exact tool id or a prefix ending in one `*`.

**D-7 Disable.** `handleConnectorWritesDisable` also calls `removeDoorApprovals(db, service)`; with `door: "agent"` it removes only the agent rows and leaves V83 alone. Narrowing needs no approval, as today (`model-writes.ts:443-456`).

**D-8 Status.** `agentWritesStatus(deps)`: for each service with at least one agent approval, sequentially (a listing may spawn; the model door's reason at `engine/connector-write-agent-tools.ts:643-644`): list, hash each approved tool, and for a mismatch call `markDoorToolSuspended` and append one audit row (`connector.writes.agent.suspend`, `not_required`, tool id and the two 12-hex prefixes). A service whose listing is `undefined` is reported `unverified: its tools could not be listed` and nothing is marked. A tool already marked is reported from the stored columns. When no agent approval exists at all the reply carries the one-time notice with the exact command. The model part of the reply is byte-identical to today's.

**D-9 The CLI** (`packages/cli/src/commands/connector-writes-cli.ts`). `enable <svc> --door agent [--wave N] [--approve <p>]...`; `--door` takes only `agent` or `model`; `--approve` without `--door agent`, and any iac flag or `--grant` with it, are usage errors (exit 2). For the agent door the connection declares `cli` first (`declareCliClientKind`, as `packages/cli/src/commands/approvals.ts:267` does) and uses `consent: { kind: "human" }`. `disable <svc> [--door agent]`. `status` prints, after each service line that has agent approvals, `  agents: <n> approved` and one `  suspended: <toolId> definition changed since approved <date> (approved <sha12>, now <sha12>)` line per suspended tool, then the notice, then `Agent policy: allows` or `forbids (<capability>)`. New refusal mappings beside the existing ones (`:21-40`).

## File map

New (gateway): `index/agent-door-v97-sql.ts`, `index/migrations/runner-v97.test.ts`, `connectors/connector-writes/{door-approval-store,definition-hash,agent-door}.ts` with a test each, `ipc/connector-rpc-handlers/agent-writes.ts`, `ipc/connector-rpc-agent-writes.test.ts`, `util/canonical-json.ts` (+ test) if the move is accepted, one integration file (Task 9).
Edited (gateway): `index/migrations/runner.ts`, `index/local-index.ts` (97), `connectors/connector-writes/{enablement-store,model-write-source,model-offerable,enable-prompt}.ts`, `ipc/connector-rpc-handlers/model-writes.ts`, `ipc/connector-rpc.ts`, `ipc/server/dispatchers.ts`, `automation/workflow-steps.ts` (import only), `mcp-sink/capture-gate.ad2.test.ts`, `security-invariants.test.ts`.
Edited (scripts): `scripts/structure-audit/check-nimbus-invariants.ts` and its test.
Edited (cli): `commands/connector-writes-cli.ts` and its test, `commands/connector.ts` (help).
Edited (ui): `packages/ui/src-tauri/src/gateway_bridge.rs` (a negative test only).
Docs: Task 10.

## Tasks for AD3a-1 (test first; red-prove every guard by reverting the production line and watching its test fail)

### Task 0 - Preconditions

1. Branch `dev/asaf/p28-ad3a-1` from `dev/asaf/p28-ad2` in a new worktree; verify `git rev-parse --abbrev-ref HEAD` before every commit. While #1997 is open the PR's base is `dev/asaf/p28-ad2`; after it merges, retarget to `main` and rebase. The spec and this plan are stripped from the branch before the PR.
2. Re-derive the three numbers. V97: `git fetch origin`, then for every open PR head (`gh pr list --state open --json headRefName`) run `git ls-tree -r --name-only origin/<branch> -- packages/gateway/src/index` and look for a `-v97-sql.ts` or higher; also read `INDEXED_SCHEMA_STEPS` on `origin/main`. D49 and I58: `docs/SECURITY-INVARIANTS.md:3` on `origin/main` and on every open PR that edits that file. If another branch took a number, renumber here before writing code. (This plan's check covered the remote refs present in the local clone and found none; it did not query open PRs.)
3. Baseline, scoped and sequential: `bun test packages/gateway/src/index/migrations`, then `bun test packages/gateway/src/connectors/connector-writes packages/gateway/src/ipc/connector-rpc-model-writes.test.ts`, then `bun test packages/gateway/src/mcp-sink`, then `bun test scripts/structure-audit/check-nimbus-invariants.test.ts`; record counts.
4. Three probes, each kept as a test later: (a) on a V96 in-memory database, `SELECT name, type FROM sqlite_master WHERE sql LIKE '%capture%'` lists only the `capture` table and its three indexes (no trigger or view names it; a grep of `index/*-sql.ts` found none); (b) the row facts at the top of this plan, re-run; (c) read the installed `@mastra/mcp` `MCPClient.listTools` to learn whether it caches per client (UNVERIFIED in this plan; it decides whether a changed listing is seen without a restart, which the Task 9 fake does not prove). If (a) finds a dependent, STOP: the rebuild must recreate it.
5. Confirm OD-1 to OD-5 with the owner before Task 5; the plan assumes the recommended option of each.

### Task 1 - V97 (migration, D32(a) allow-list)

Files: `index/agent-door-v97-sql.ts`, `index/migrations/runner.ts`, `index/local-index.ts`, `index/migrations/runner-v97.test.ts`, `mcp-sink/capture-gate.ad2.test.ts`, the checker's `D32_CAPTURE_TABLE_ALLOWED`.

1. Tests first (`runner-v97.test.ts`, the `runner-v84.test.ts` shape): a fresh database reaches 97 with both objects; an upgrade from 96 with one capture row of every kind and state keeps every column value, sets `legacy` 0, and leaves `connector_write_door_approval` empty; the row count check aborts a lossy copy (a test that plants a failing copy and expects `MigrationRollbackError`); the three `capture` indexes exist after the rebuild; a `rejected` action accepts an `error_code` of 64 characters and refuses 65; a `proposed` action still refuses any; `legacy = 1` is refused on a note; `legacy = 2` is refused; the door table refuses a 63-character hash and a row with only one suspension column; running the step twice (rewind `user_version` to 96) keeps a `legacy = 1` row; `CURRENT_SCHEMA_VERSION` equals `maxRegisteredIndexedSchemaVersion()`. Invert `capture-gate.ad2.test.ts:221-227` (the store now accepts a code on `rejected`) and add beside it: `acceptAction` with an `ActDeps` that returns `rejected` stores a NULL `error_code` (AD3a-2 changes that, on purpose). RED.
2. Implement D-1; register `{ fromVersion: 96, toVersion: 97, apply: migrateIndexedV96ToV97 }` after the V96 step (`runner.ts:809-815`); `CURRENT_SCHEMA_VERSION = 97`. GREEN.
3. Checker: add the V97 file to `D32_CAPTURE_TABLE_ALLOWED` with a fixture that the same SQL in any other file is a D32(a) violation.

### Task 2 - The door store, the wave raiser, D49(b) (ONE commit: wiring, docs, fixtures)

Files: `connectors/connector-writes/door-approval-store.ts` (+ test), `enablement-store.ts`, the checker and its test, `docs/SECURITY-INVARIANTS.md`.

1. Tests first, real SQLite through the migration runner. Store: replace keeps only the given set; upsert keeps other rows, replaces the hash and clears a suspension; `markDoorToolSuspended` returns true once and false on a second call with another hash, and the stored `suspended_sha256` is the first; remove by service and by door; a list is sorted by service then tool id. `raiseWriteEnablementWave`: creates a row with `approved_tool_ids = '[]'`; raises 2 to 4; called with 2 on a row at 4 leaves 4; never changes `approved_tool_ids` or `enabled_at` of an existing row (compare the whole row). Checker fixtures: the table named in the store and the DDL file is clean; named in `ipc/connector-rpc-handlers/agent-writes.ts`, in `mcp-sink/capture-store.ts` and in a new file is `door-approval-confined`, for each form `sqlTableReferenceRe` covers (`FROM`, `INTO`, `UPDATE`, `JOIN`, quoted, schema-qualified); a comment naming it is clean. RED.
2. Implement D-2 and the raiser; add `checkDoorApprovalConfinement` (the `checkTableConfinement` helper), its anchor, its `::error` line; register it in `run()`. GREEN, then `bun run audit:invariants`.
3. Red-proof: add a `SELECT ... FROM connector_write_door_approval` to `agent-door.ts` locally and watch the audit fail; remove it.

### Task 3 - The definition hash

Files: `connectors/connector-writes/definition-hash.ts` (+ test), `util/canonical-json.ts` if moved.

Tests first: the same entry hashes the same whatever its key order; a one-byte change in the description, in a property name, in a nested `enum` value and in `required` each change the hash; the tool id is part of it (two tools with one definition differ); a description that is not a string hashes as `null` and differs from the empty string; an NFC and an NFD spelling of one description hash DIFFERENTLY (the reason `extensions/canonical-json.ts` is not used); a schema holding `0.5` hashes; an entry that is not an object, or whose schema `readListedJsonSchema` cannot read, returns `undefined`; the output is 64 lower-case hex characters. If `canonicalJson` moves, `automation/` tests stay green unchanged. RED, implement D-4, GREEN.

### Task 4 - Routing and the approvable set

Files: `connectors/connector-writes/agent-door.ts` (+ test), `model-write-source.ts` (export `enabledAndOfferable`), `model-offerable.ts` (the mail-send text).

Tests first: `agentDoorRow` is total over the table's action types (every type resolves to a row of that type); every multi-row type has a tie-break entry and it equals `PROPOSABLE_WRITE_TOOLS[type]`; `slack_message_post_dm` is the only model-offerable row no type routes to (derived, so a new shared type fails the test until someone decides); every one of the 47 proposable types routes to the tool `proposableWriteTool` names (the two routing tables agree where both exist). `agentApprovableRows`: for every service, the approvable set equals `offerableWritesEnabledBy(service, wave)` minus unroutable, unlisted, scope-gated and directory-less rows; a Wave 4 row appears only at wave 4; each never-offered row is `not_approvable` with its recorded reason, the seven sends with the new text; a tool missing from the listing and a tool whose schema cannot be read are `not_approvable`; the Obsidian append follows OD-4. `enabledAndOfferable`: `offeredUnder` is unchanged for a table of inputs (snapshot the old function's results before the refactor, as AD1 did for the 47 types). `agentDoorPolicyAllows` is false for `undefined`, for either lockoff alone and for both. RED, implement D-3, GREEN.

### Task 5 - The enable and disable handlers

Files: `ipc/connector-rpc-handlers/agent-writes.ts`, `model-writes.ts` (the two dispatch points), `enable-prompt.ts`, `ipc/connector-rpc.ts`, `ipc/server/dispatchers.ts`, `ipc/connector-rpc-agent-writes.test.ts`.

Tests first, with a real in-memory database, a real `ToolExecutor` in gate-only form, a real `ConsentCoordinatorImpl` whose fake writer answers each `consent.request` as the test says, and a fake `listServerTools`:
- **Order.** Each refusal of steps 1-6 happens with ZERO consent requests and zero rows written; steps 1-3 happen with zero listing calls (a spy). One case per refusal code.
- **Kind and answer.** `unknown`, `mcp`, `http`, `chatops`, `fleet` and `push` are refused; `cli` and `ui` reach the prompt; an approval with `answerSource` `auto`, `script`, `unknown`, `delegate`, `remote` or `none` writes nothing and replies declined with the non-human text; `human` writes.
- **Prompt.** The rendered lines contain, for GitHub at wave 4, every approvable row with its wave, `typed confirmation` on Wave 4 rows, `bound` on the commit, and a 12-hex prefix equal to the stored hash's prefix; a tool id or description carrying a control character is escaped by `sanitisePreviewText`; a payload with `door: "agent"` and a missing field renders `undefined` and the handler refuses before the gate.
- **Writes.** After approval: one row per approvable tool with `definition_sha256` equal to `definitionSha256` of the listing shown; the V83 row exists with the model's `approved_tool_ids` unchanged (compare bytes) and `max_wave` raised, never lowered; with `approve: ["github_pr_*"]` only those rows change and the others keep their `approved_at`; re-approving a suspended tool clears the suspension; a decline writes nothing; a failure between the two writes rolls both back (one transaction: plant a throw).
- **The model is offered nothing new.** After `enable github --door agent --wave 4` on a service the model had at wave 2, `createModelWriteToolSource(...).offerableEnabledRows()` is the same list as before, and `recheck` of a Wave 4 row is false.
- **Scope.** `iac` with no approved directory lists the Terraform apply as `not_approvable`; with one, as approvable; `kubernetes` likewise by pair; any scope param is refused.
- **Disable.** Plain disable removes the V83 row and the agent rows; `door: "agent"` removes only the agent rows; both are idempotent.
- **Model path unchanged.** Every existing case of `ipc/connector-rpc-model-writes.test.ts` passes untouched, and a model enable does not read the listing (spy).
RED, implement D-5 to D-7 and the dispatcher change of sweep A, GREEN. Amend the AD2 pin about `humanOnlyConsent`'s users in the same commit.

### Task 6 - Status

Files: `agent-writes.ts`, `ipc/connector-rpc.ts`, the test file of Task 5.

Tests first: no approvals gives the notice and lists no service; an unchanged tool is counted and not suspended; change one byte of a listed description and status reports the tool with both prefixes, marks it (the row has `suspended_at`), writes one audit row, and a second status writes no second audit row; restore the old description and the tool is STILL suspended (sticky); a service whose listing is `undefined` is `unverified` and nothing is marked; services without agent approvals are never listed (spy); the `services` and `policyAllows` members equal `handleConnectorWritesStatus`'s output exactly. RED, implement D-8, GREEN.

### Task 7 - The CLI

Files: `packages/cli/src/commands/connector-writes-cli.ts` and its existing test, `packages/cli/src/commands/connector.ts`.

Tests first (the fake `call` seam at `:6-10`): parse table for every form in D-9, including the usage errors; the agent enable sends `{ service, door: "agent", wave?, approve? }` and nothing else; the recorded calls for an agent enable begin with `session.declareKind`; the consent choice for it is `human` even with `NIMBUS_SCRIPT_CONSENT_SOURCE` set, and the model enable's choice is unchanged; each new refusal code prints its one line and exits 2; `status` prints the agent lines, a suspended line with both prefixes and the date, the notice once, and the agent policy line; `status --json` prints the raw reply; control characters in a tool id from the gateway are stripped. RED, implement, GREEN. Update the help block at `connector.ts:1425-1427`.

### Task 8 - Invariant and rule text (same commits as the wiring they describe)

- **D49(b)**: Task 2. The section says the other clauses arrive with AD3a-2 and I58.
- **I53** (`docs/SECURITY-INVARIANTS.md:1827` section; the line in `CLAUDE.md:99` and `GEMINI.md` is unchanged in wording): a stated bound, "the shared wave may be raised by an agent-door enable; the model's offer is unchanged because V84 approves by name", with the Task 5 test copied into the I53 block of `security-invariants.test.ts`.
- **I28**: one sentence in the AD2 paragraph, "since V97 a `rejected` action may carry an error code; none is written until AD3a-2", and the V97 file in the wiring list and in D32(a)'s allow-list text.
- **I2 / I20**: text unchanged. `connector.writes.enable` stays in the frozen set and stays never delegable (`engine/executor.ts:274`, `:1197`); add to the I20 test at `security-invariants.test.ts:2523` a payload with `door: "agent"`.
- `security-invariants.test.ts`, a new "AD3a-1" block: the dispatcher source wraps the consent with `humanOnlyConsent` for the agent enable; `agent-writes.ts` contains `requireAgentEnableCaller(` before `listServerTools(` before `.gate(` before `replaceDoorApprovals(`; the door store is the only non-test file containing the table name; `gateway_bridge.rs` has no `"connector.writes` entry line.

### Task 9 - The behaviour end to end (integration, always on)

File: `packages/gateway/test/integration/mcp-sink/agent-door-enable.test.ts` (beside `approvals-flow.test.ts`). Real SQLite from the runner, the real dispatch entry `tryDispatchPhase4Rpc` or the connector dispatcher that `server.ts` calls (use the entry the existing connector-writes integration tests use; find it by grep), a real consent coordinator, a fake mesh listing.

- An owner `cli` connection enables GitHub for agents at wave 4 and approves; `status` shows the approvals; the listing changes; `status` shows the suspension; `enable --approve <tool>` clears it.
- **Reach is unchanged**: with every GitHub tool approved for agents, an `mcp` connection's `capture.submit` of `github.pr.merge` is still `ERR_CAPTURE_ACTION_NOT_PROPOSABLE`, and of `github.issue.create` is still accepted exactly as before the enable (same reply shape, same audit row keys). This is the pin AD3a-2 will invert.
- An `mcp` connection calling `connector.writesEnable { door: "agent" }` is refused before any prompt.
- An upgrade: a database at 96 holding a model opt-in and queued captures migrates, the model's offer is unchanged and the agent list is empty.

### Task 10 - Docs (the five core docs, CHANGELOG, SECURITY-INVARIANTS, skills)

- `CLAUDE.md` and `GEMINI.md` (identical): one "Phase 28 AD3a-1" sentence in the status paragraph (the per-door list, the hash, `--door agent`, status, V97, D49(b), no new invariant, reach unchanged); "schema V97"; "D10–D49".
- `docs/roadmap.md`: a progress note on *Write parity with the model door* (stays `[ ]`).
- `docs/architecture.md` (`:718-744`): the door param, the store, the hash, the status shape. `docs/schema-reference.md`: V97. `docs/README.md`: the sentence. `docs/cli-reference.md` (`:3294-3330`): the `--door agent` subsection, including what is not approvable and why, the shared-wave note and re-approval after a definition change.
- `docs/CHANGELOG.md`: what the owner can do, that nothing an agent can propose changed, the upgrade-suspension bound (OD-5), the Slack DM bound (OD-2).
- Skills: `.claude/commands/nimbus-db-migrations.md` (newest is V97), `nimbus-file-map.md` (three new modules), `nimbus-mcp-sink.md` (a short "approval list for agents, not yet enforced" paragraph). `nimbus-ipc.md` does not list the `connector.writes*` methods (grep), so it is unchanged.

### Task 11 - Verification (sequential, never two runs at once; scoped, no whole-repo suite locally)

1. `bun run typecheck`, then `bun run typecheck:tests`.
2. `bun run preflight:fast`.
3. `bun test packages/gateway/src/index/migrations`.
4. `bun test packages/gateway/src/connectors/connector-writes`.
5. `bun test packages/gateway/src/ipc/connector-rpc-agent-writes.test.ts packages/gateway/src/ipc/connector-rpc-model-writes.test.ts`.
6. `bun test packages/gateway/src/mcp-sink packages/gateway/src/security-invariants.test.ts`.
7. `bun test packages/gateway/test/integration/mcp-sink`.
8. `bun test packages/cli/src/commands`, then `bun test scripts/structure-audit`, then `bun run audit:invariants` again.
9. Rust, where installed: `cargo test allowlist_` in the UI crate; otherwise say so (CI runs it).
10. Coverage of the new files against the 85% line and 80% branch floors is CI-Linux-authoritative: `bun run verify:docker --changed`. The branch risk is `agent-writes.ts`'s refusal arms; Task 5's order table covers each.
11. Red-proofs recorded in the PR: revert (a) the count check in the V97 step, (b) the `WHERE suspended_at IS NULL` in `markDoorToolSuspended`, (c) `requireAgentEnableCaller`, (d) the `humanOnlyConsent` wrap in the dispatcher, (e) the transaction around step 8, (f) `MAX(max_wave, ...)` in the raiser, (g) the D49(b) allow-list. Each named test must go red.
12. Known local baselines are not this branch (the AD2 plan's Task 11 step 9 lists them). Re-check the branch name, then strip `docs/superpowers/**` before the PR.

## AD3a-2 in outline (its own plan follows after AD3a-1 is reviewed)

Each item names the code it must be checked against.

1. **The verdict seam.** `ActionVerdict` (`mcp-sink/capture-types.ts:144-147`) gains a `basis` on `proposable` (`approved`, `legacy_unapproved`, `legacy_mail_send`; absent for a user-MCP type) and a `suspended` arm. `platform/assemble.ts:3948` composes `classifyAction` from `agent-door.ts` for a first-party type and `classifyActionType` for `mcp_*`. `agentOffered` = `enabledAndOfferable` + the door set + not suspended + `agentDoorPolicyAllows` + the directory rule. A legacy case is exactly D-AD-15: refused only for a missing approval or wave, or a mail send, AND `proposable` in the unchanged `ACTION_PROPOSABILITY` (40 non-mail types and 7 sends today).
2. **Submit** (`capture-gate.ts:444-448`): 5a the verdict; the refusal set by basis (`modelWriteRefusal` for `approved`, the existing `actDoorRefusal` for legacy); 5b configured; 5c for `approved` only, the listing and hash (correction 7). `writeSubmittedCapture` stores `legacy`. The await stays before the caps.
3. **Approve** (`capture-act.ts:187-208`): step 4 re-runs the verdict and the hash; a legacy row re-runs the old checks. **Before dispatch**: the wrapper of correction 8. A refusal at approval finalizes `rejected` WITH a fixed code (the V97 CHECK), and `capture.state` shows it.
4. **Feed the listing to the executor** (AD1's correction 8): `ExecuteOptions.beforeReaderUnlisted` and `prepareToolUnlisted` (`engine/executor.ts:975-980`), with the Wave 4 rule of `engine/connector-write-agent-tools.ts:592-609` shared by both doors through one extracted helper.
5. **Routing**: `buildActDeps` (`ipc/capture-rpc.ts:150`) uses `agentDoorRow` for an approved type; bound rows and Wave 4 rows become proposable; the payload cap (correction 16).
6. **Warnings**: the fixed deprecation line in the `propose_action` result, at the top of `approvals.list` and `approvals.get`, in the executor prompt (through the proposer block), and the `legacy` count in status (last 30 days by type, read from `capture`; a purged row leaves the count, stated).
7. **Tests of § 10**: the parity table over every row; each `modelWriteRefusal` refusal once through the agent door; Wave 4 offered only after `--wave 4 --door agent` and refused before any prompt when the before-state cannot be read; **A2 re-run with a real Wave 4 type** (`github.pr.merge`), replacing AD2's synthetic row; suspension at submit, at approval and before dispatch; either lockoff empties the door, legacy included.
8. **I58 and D49(a), (c)-(f)** rewritten per correction 9, with the legacy exception stated in the invariant's text; I28, I53, I54 text; `describe_actions` if OD-6 says so.
9. PR title: `feat(gateway): hold outside agents to the writes the owner approved for them by name, with a deprecation warning for earlier use`.

## Spec coverage (mapped to a task STEP, or to an AD3a-2 outline item)

| Requirement | Where |
| --- | --- |
| V97 door table (§ 7.3) | Task 1 steps 1-2; correction 5 (suspension columns) |
| `capture.legacy` default 0 (§ 7.3, § 10) | Task 1 steps 1-2; its writer is AD3a-2 item 2 |
| Relaxed V69 CHECK (AD2's deferral) | Task 1 steps 1-2; first use is AD3a-2 item 3 |
| One writer, `door-approval-store.ts`; D49(b) | Task 2 steps 1-3 |
| `enable <svc> --door agent [--wave N] [--approve ...]` (OR-AD-2, § 7.3) | Task 5 (gateway), Task 7 (CLI); corrections 4, 10, 11 |
| The prompt lists only approvable rows, with wave and typed-confirm flag (§ 7.3, D-AD-14) | Task 4 (the set), Task 5 "Prompt" |
| `--wave 4 --door agent`, approval by name (OR-AD-7) | Task 5 "Prompt" and "Writes"; the offer itself is AD3a-2 item 7 |
| Shared wave created or raised; `disable` removes both lists (§ 7.3) | Task 2 step 1 (raiser), Task 5 "Writes" and "Disable" |
| Agent set empty after upgrade (§ 7.3, § 10) | Task 1 step 1, Task 9 "An upgrade" |
| Definition hash stored at enable (D-AD-9) | Task 3, Task 5 "Writes" |
| Hash re-derived at every `status`; suspended list with both prefixes; re-approval clears (OR-AD-5, § 10) | Task 6; Task 5 "Writes" (re-approval) |
| Hash at submit, at approval, before dispatch (D-AD-9) | AD3a-2 items 2, 3; corrections 7, 8 |
| `status` says once what to run (§ 7.3) | Task 6 (notice), Task 7 |
| Never-offered rows show their reason; the mail-send text (§ 7.3, OR-AD-3) | Task 4 |
| Policy needs both capabilities (D-AD-5) | Task 4 (`agentDoorPolicyAllows`), Task 5 step 3; at the gate AD3a-2 item 1 |
| `agentOffered`, parity over every row (§ 7.3, § 10) | AD3a-2 items 1, 7; correction 1 |
| One refusal set (D-AD-6) | AD3a-2 item 2 |
| Bound rows proposable (D-AD-7) | AD3a-2 item 5; correction 16 |
| Legacy accepted, flagged, counted, warned in four places (OR-AD-9, D-AD-15) | AD3a-2 items 1, 2, 6 |
| A2 on a real Wave 4 type (AD2's deferral) | AD3a-2 item 7 |
| I58 with its legacy exception; D49 (§ 7.3) | D49(b): Task 2; the rest AD3a-2 item 8; correction 9 |
| Non-breaking `feat`, no `!` (§ 11) | PR section; Task 9 "Reach is unchanged" |
| Five core docs and CHANGELOG | Task 10 |

## Risks / open questions

- **Reviewer decisions:** the canonical JSON helper's home (D-4); no value CHECK on `door` (D-1); `status` writing the suspension mark and an audit row (D-8); `disable --door agent` (D-7); the `--approve` grammar (D-6); refusing scope flags with `--door agent` (correction 11); whether the rebuild should also add a `session_id` index (AD2 left the per-connection count unindexed; V67 says the column is deliberately not indexed, `index/capture-v67-sql.ts:5-7`; this plan adds none); the listing at submit (correction 7).
- **An approval list that nothing enforces** exists between the two merges (OD-1). The CHANGELOG entry and the `--door agent` doc section must not say agents are held to it yet.
- **`status` can start connectors.** One listing per service that has agent approvals, sequentially; a cold start may take seconds each. The model's status stays instant. If this is too slow in use, a `--no-check` flag is the smallest fix.
- **Upgrade friction (OD-5).** Under the literal reading, a connectors bump that edits descriptions suspends those tools for agents until re-approved.
- **`MCPClient.listTools()` caching is UNVERIFIED** (Task 0 step 4c). If it caches for the life of a slot, a definition changed without a restart is not seen until the slot restarts; first-party definitions cannot change without one, and AD5 (user MCP) must re-check this.
- **The rebuild runs on every upgrade** and copies the whole `capture` table (payloads up to 64 KiB each). The runner writes one backup first; a large queue makes the step slower, not unsafe.
- **Test churn.** `capture-gate.ad2.test.ts`'s V69 pin and the `humanOnlyConsent` user pin are inverted or widened on purpose; do those edits first so a rewritten expectation cannot absorb a behavioural change.
- **What the executor shows for an unrenderable enable payload** was not read past `engine/executor.ts:582` (UNVERIFIED); the handler's own render-or-refuse check makes it moot for the agent door.
- The reservation of I57 and of D46(a)/(c) by the incident-engine stream is taken from the agent-door spec, not from this tree (UNVERIFIED here).

## PR

Title (conventional commit, no `!`; nothing requires a user to act and reach is unchanged):

`feat(gateway): add an approval list for outside agents (nimbus connector writes enable --door agent), with a hash of each approved tool's definition`

Description: the delta (five points), the corrections that apply to this part (1-6, 10, 11, 13-15, 17), the owner decisions taken, D49(b), the stated bounds, the red-proofs, the verification output. If #1997 is still open, the PR is stacked and its base is `dev/asaf/p28-ad2`. End with the attribution lines from the session. No `Release-As:` trailer.

## Review log

(empty)

### Critical Files for Implementation
- C:\gitrep\Nimbus\.claude\worktrees\p28-ad2\packages\gateway\src\ipc\connector-rpc-handlers\model-writes.ts
- C:\gitrep\Nimbus\.claude\worktrees\p28-ad2\packages\gateway\src\connectors\connector-writes\model-write-source.ts
- C:\gitrep\Nimbus\.claude\worktrees\p28-ad2\packages\gateway\src\connectors\connector-writes\enablement-store.ts
- C:\gitrep\Nimbus\.claude\worktrees\p28-ad2\packages\gateway\src\index\migrations\runner.ts
- C:\gitrep\Nimbus\.claude\worktrees\p28-ad2\scripts\structure-audit\check-nimbus-invariants.ts
