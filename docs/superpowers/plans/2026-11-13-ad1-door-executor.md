# Plan — Agent door AD1: the door executor (`origin: "agent"`, the proposer, `provenanceConsent` deleted)

Status: DRAFT for review (2026-11-13).
Spec: `docs/superpowers/specs/2026-11-13-agent-door.md` (approved, Antigravity round 2): § 2 (OR-AD-1..9), § 4 (D-AD-1, D-AD-2,
D-AD-7, D-AD-8), § 6 (the AD1 row), § 7.2, § 9 (invariant amendments), § 10 (AD1 tests).
Roadmap rows: Phase 28 *The same prompt* and the groundwork of *Write parity with the model door* (`docs/roadmap.md` § Phase 28).
Numbers re-derived on `origin/main` at `165fa4353` (2026-11-13): `CURRENT_SCHEMA_VERSION` = 96
(`index/local-index.ts:309`), static rules D10-D48 (`docs/SECURITY-INVARIANTS.md:3`), invariants I1-I56. **AD1 adds no migration, no
HITL type, no invariant, no static rule, no IPC method, no `ALLOWED_METHODS` entry and no egress class.** It amends D39(e), D40(b),
D41(a) and the texts of I20, I28 and I42, under the triple rule (§ Tasks 7, 8).

After AD1: the MCP act door builds its executor through the SAME maker as the model door (no delegation, the before-state runner), every
proposal is dispatched as an `origin: "agent"` action carrying a gateway-set `proposer`, the executor's own prompt (typed preview,
before-state) is what the owner sees with the proposer as a trailing UNVERIFIED block, and `provenanceConsent`, `actConsentDisplay`,
`formatActionConsent` and `formatActionProvenanceLines` no longer exist. What an outside agent can do is unchanged (below).

## The behavioural delta, stated precisely

What does NOT change (each pinned by a test, Task 9):

- The set of proposable action types: `ACTION_PROPOSABILITY` (`connectors/proposable-actions.ts:136`) and `classifyActionType` are not
  touched; the 47 proposable types stay, including the seven mail sends; the `not_yet_offered`, bound-row and user-MCP rules are
  unchanged. Submit-time checks (`classifyAction`, `actionDestinationRefusal`, configured-ness, the caps) and `acceptAction`'s eight
  steps (`mcp-sink/capture-act.ts`) are untouched. The V83/V84 enable, `MODEL_NEVER_OFFERED` and any per-door list are NOT consulted
  (that is AD3).
- The tool dispatched (`proposableWriteTool(actionType)` or `userMcpToolKeyForActionType`), the payload `{ mcpToolId, input }`, the
  owner-only role, the accepting session answering, no delegation, no standing rule, the I29 egress row per dispatch.

What DOES change, and in which direction:

1. **The prompt and the structured details.** Old: `Agent-proposed action — requires your approval` / `Proposed by MCP client "<label>" at
   <t>, expires <t>` / `Agent's summary (unverified): ...` / (templated) the typed preview, or (untemplated) `Type:` and `Input (verbatim,
   exactly what will be sent):` plus pretty JSON. New: the executor's `Action requires your approval` / `Type:` / `Requested by: an outside
   agent (unverified)` / the typed preview WITH its `Before:` block (templated) or the verbatim pretty JSON input (untemplated, with the same
   invisible-character escaping as before) / a trailing block `Proposed by an outside agent (UNVERIFIED label "...") at <t>, expires <t>`
   and `Agent's summary (UNVERIFIED): ...`. The desktop's details keep the same `proposedBy` object (`clientLabel`, `unverifiedSummary`,
   `createdAt`, `expiresAt`), so `ConnectorWritePreview.tsx`'s `ProposedBy` section keeps working with no UI change.
2. **A before-state read now runs at accept** for every proposable row that declares a `before` reader (the model door's runner,
   `engine/before-state.ts`): up to two ledgered, audited `<service>.before.read` actions through the same gate and dispatcher, 5 s together,
   shown to the owner only. The owner sees MORE; the agent's reach is not widened (a read of the same connector under the owner's
   credential, chosen by the gateway's row, parameterised by fields of the agent's own `input`: the model door's bound).
3. **A guard can refuse an accepted proposal before the prompt** (`BeforeStateRefusedError`, B2a): the row finalizes `rejected`. This only
   adds refusals. No proposable type is Wave 4 (Task 9 pins it), so `WAVE4_BEFORE_REFUSAL` cannot fire on the act door yet.
4. **The audit row** of the dispatch gains `origin: "agent"` and `proposer: { door, captureId }` (a deliberate projection: the agent's
   summary and label do not enter the chain; AD4 adds the label). The egress row is unchanged (AD4).
5. **`details.requestedBy` is NOT set for `"agent"`** (the UI only knows `"model"`; the agent is drawn by `proposedBy`).

Behaviour of `nimbus approvals` / the queue: none yet (AD2).

## Spec contradictions and corrections (checked against the code)

Where the spec is right the plan follows it; these are the points where the code disagrees and the plan's correction is binding for AD1.

1. **D41(a) is not in the spec's AD1 row.** `provenanceConsent` is the one named exception to D41(a): `requestConfirmedApproval` may be named
   only by `engine/executor.ts`, `engine/types.ts` and `ipc/capture-rpc.ts` inside `provenanceConsent`
   (`scripts/structure-audit/check-nimbus-invariants.ts:2783`, `D41_WRAPPER_FILE` `:2810`, the span check `:2852`, the rule text `:5336`).
   Deleting the wrapper makes that exception dead code. Correction: AD1 amends D41(a) to drop the wrapper clause (Task 7) and its fixtures
   (`check-nimbus-invariants.test.ts:4390-4418`).
2. **The wiring site of `buildAgentWriteExecutor` is `ipc/capture-rpc.ts`, not `platform/assemble.ts`.** Spec D-AD-1 says "its one wiring
   site in `platform/assemble.ts`". The executor needs the ACCEPTING client's id and the consent coordinator, which exist only per accept in
   `buildActDeps` (`ipc/capture-rpc.ts:196`); `assemble.ts:4790` only builds the static `CaptureActWiring`. Correction: D39(e) allows
   `buildAgentWriteExecutor` in `engine/run-ask.ts` and `ipc/capture-rpc.ts`; assemble gains one more field of the static wiring
   (`getTribalKbConfig`). AD2 adds `ipc/approvals-rpc.ts` to the list if `approvals` builds the deps itself (it will call `acceptCapture`,
   spec § 7.2, so likely not).
3. **The I55 "negative control" needs no edit.** Spec D-AD-1 lists the I55 control among the five `origin === "model"` reads to replace.
   `engine/standing-rule-step.ts:98` is already `if (action.origin !== undefined) return undefined;`, so an `"agent"` origin is refused
   by construction. AD1 adds the test, not a code change. The real reads are four (Task 2 table), plus the type.
4. **`proposer` needs more than the spec's four fields.** The spec lists `{ door, captureId, label, labelSource }`; the prompt and the desktop
   details also need the agent's `summary`, `createdAt` and `expiresAt` (today carried by `ActionProvenance`, `mcp-sink/capture-types.ts:149`).
   Correction: `AgentProposer = { door: "agent"; captureId; label: string | null; labelSource: "declared" | "kit"; summary; createdAt;
   expiresAt }`. AD1 always sets `labelSource: "declared"` (the `--agent` kit label arrives with AD6b).
5. **`newExecutorOnChannel` takes a `LocalIndex`, the act door has an `AuditSink`.** The shared builder reads `p.localIndex` as the audit sink
   (`engine/run-ask.ts:697` area); `CaptureActWiring.audit` is `{ recordAudit: appendAuditEntry }` and the tests build it from a bare db
   (`ipc/capture-rpc.test.ts:226-256`). Correction: Task 5 changes the shared builder to take `audit: AuditSink`; the two existing callers pass
   `p.localIndex`. No behaviour change for them.
6. **The census test slices `run-ask.ts` by function names.** `security-invariants.test.ts:13838-13866` reads the source between
   `export function buildModelWriteExecutor(` and `export function buildWorkflowWriteExecutor(` and demands no `standingRules` there. New
   exports must go between or after those two without moving them, or the test's slice must be updated in the same commit (Task 5).
7. **Bound rows stay unproposable in AD1.** Spec § 7 D-AD-7 makes bound rows proposable "once D-AD-2 lands". The classification table is
   AD3's; AD1 leaves `security-invariants.test.ts:13155` ("no bound row is proposable on the MCP act door") true, and rewrites only its
   reason string (it names `provenanceConsent`).
8. **`beforeReaderUnlisted` is not available on the act door.** The model door tells the executor when the reader tool is missing from the
   server's listing (`ExecuteOptions.beforeReaderUnlisted`, `engine/executor.ts:1523`). The act door has no listing; the read runs and a
   missing reader surfaces as `Before: unavailable (failed)` (a Wave 4 row would be refused). Fine for AD1 (no Wave 4 proposable); AD3a must
   decide whether to feed the listing in. Recorded in Risks.

## Every place `origin === "model"` or the `"model"` literal type is assumed (the sweep, verified by grep over `packages/` and `scripts/`)

| Site | Assumption | AD1 change |
| --- | --- | --- |
| `engine/types.ts:44` | `origin?: "model"` | `origin?: "model" \| "agent"`; add `proposer?: AgentProposer` (top level only) |
| `engine/executor.ts:421-427` (`consentDisplayPayload`) | `!== "model"` returns the plain payload; else adds `requestedBy: "model"` | helper-based: model adds `requestedBy`; agent adds `proposedBy` (gateway value wins over a payload key) |
| `engine/executor.ts:531` (`formatConsentPrompt`) | one fixed line `Requested by: the model` | model line unchanged; agent line `Requested by: an outside agent (unverified)`; proposer block appended on every prompt shape |
| `engine/executor.ts:1129` (`tryDelegatedApproval`) | `=== "model"` falls back | `isOutsideOrigin(action)` (I20) |
| `engine/executor.ts:619-638` (`auditedAction`) | serialises the whole action | project `proposer` to `{ door, captureId }` |
| `engine/before-state.ts:145` (`throwIfWave4WithoutPreview`) | `=== "model"` | `isOutsideOrigin` |
| `engine/before-state.ts:444` (`read`) | `!== "model" && readsEveryOrigin !== true` returns undefined | `!isOutsideOrigin && ...`; doc comments at `:9`, `:136`, `:173`, `:384` reworded |
| `engine/standing-rule-step.ts:98` | `origin !== undefined` refuses | none (already generic); header comment `:12` reworded; test added |
| `engine/connector-write-agent-tools.ts:430` | sets `origin: "model"` (the model door) | none; D39(d) still pins the literal in the door file |
| `engine/user-mcp-agent-tools.ts:238` | `payload: { ..., requestedBy: "model" }` (a payload marker for user-MCP, a different mechanism) | none; noted so nobody conflates it with `origin` |
| `connectors/connector-writes/preview.ts:46-47` | `requestedBy?: "model"` on `ConnectorWritePreview` | none (the agent does not use `requestedBy`) |
| `connectors/connector-writes/standing-scenarios.test-helpers.ts:188` | test sets `origin: "model"` | none; the I55 test gets an `"agent"` twin |
| `packages/ui/src/components/hitl/ConnectorWritePreview.tsx:29-39`, `StructuredPreview.tsx:795-800` | only `requestedBy === "model"` draws the origin line | none (agent uses `proposedBy`, `ConnectorWritePreview.tsx` `ProposedBy`) |
| `scripts/structure-audit/check-nimbus-invariants.ts:2338-2356, :2670, :5306` (D39) | the door file contains `origin: "model"` | none |
| `ipc/capture-rpc.ts:225-237` (`buildActDeps`) | builds an action with NO origin | sets `origin: "agent"` and `proposer` |

## Design decisions

**D-1 `engine/outside-origin.ts`.** Exports `isOutsideOrigin(action: Pick<PlannedAction, "origin">): boolean` (true for `"model"` and
`"agent"`, false for undefined) and the type guard `isAgentOrigin`. Four reads use it; `engine/standing-rule-step.ts` keeps `!== undefined`.
A source pin (Task 2) asserts no gateway file outside this module compares `.origin` to a string literal.

**D-2 `AgentProposer` in `engine/types.ts`.** Set only in `ipc/capture-rpc.ts` `buildActDeps` from the stored row's `ActionProvenance`;
never from IPC, payload or a door (the `provenance` pattern, `engine/types.ts` `PlannedAction`). It rides the action to the dispatcher
because `structuredClone(planned)` (`engine/executor.ts:1700`) preserves it; a test proves nothing in `proposer` reaches the connector call.

**D-3 The proposer block lives in `engine/proposer-block.ts`.** `formatProposerBlock(p): string[]` = the old
`formatActionProvenanceLines` rewritten (same `visibleLine` / `visible` escaping: backslash and quote first, then
`rangesRegExp([[0,9],[0xb,0x1f], ...FORMAT_INVISIBLE_RANGES])`, LF escaped in one-line fields) and wording ("UNVERIFIED"). It imports only the
pure data in `mcp-sink/invisible-text.ts` (no gate code, so D32(f)'s direction is untouched). `agentVerbatimInputLines(input)` carries the old
`Input (verbatim, exactly what will be sent):` rendering for untemplated rows (user-MCP types and rows without a template), so I42's "no preview
can hide a field" display and the invisible-character protection survive.

**D-4 One door maker.** `engine/run-ask.ts` gets a private `newDoorExecutor(p, consent)` = no delegation, `createBeforeStateRunner({ rows, guardContext:
() => ({ kb: p.getTribalKbConfig() }) })` WITHOUT `readsEveryOrigin`. `buildModelWriteExecutor(p: RunAskParams)` becomes a call of it over
`bindConsentChannel(p.consentCoordinator, p.clientId)`; the new exported `buildAgentWriteExecutor(p: AgentWriteExecutorParams)` is another
one-line call. `AgentWriteExecutorParams = { clientId; consentCoordinator; audit: AuditSink; dispatcher; egressSink; policyHitl?; previewCredentialFor?;
beforeStateRows?; getTribalKbConfig }` (required `getTribalKbConfig`: an absent KB config would let the KB-child guards pass, fail open).
`newWorkflowWriteExecutor` is untouched except for taking `audit`. D40(b) then reads: the runner is built only in `engine/before-state.ts`
and inside `newDoorExecutor` or `newWorkflowWriteExecutor` in `engine/run-ask.ts`.

**D-5 `CaptureActWiring` (`ipc/capture-rpc.ts:60`).** Keeps `dispatcher`, `egressSink`, `audit`, `policyHitl`, `previewCredentialFor`; gains required
`getTribalKbConfig`; `previewRows` is renamed `beforeStateRows` (the test seam the runner and preview already use). `assemble.ts:4790` passes the
same KB accessor the act door's destination refusal already reads (`platform/assemble.ts:3949`, `() => tribalKbConfigOf(tribalCfg)`, which is the source of `platform.tribalKbConfig`, the accessor `gateway-main.ts:235` hands the model door).
`createActionDestinationRefusal` (`:133`) is untouched (AD3b retires it).

**D-6 The credential refresh.** `buildActDeps` today calls `previewCredentialFor.refresh` itself and returns `{ status: "rejected" }` on failure
(`ipc/capture-rpc.ts:196-215`). The executor does it too (`refreshPreviewInstance`, `engine/executor.ts:1488`), raising `PrepareRefusedError`. Keep
the explicit pre-check in `buildActDeps` (same fixed outcome, no prompt, nothing dispatched; the existing GHES tests at `capture-rpc.test.ts:387-500`
pin it), and let the executor's second refresh be a harmless repeat.

## File map

New: `engine/outside-origin.ts` (+ test), `engine/proposer-block.ts` (+ test), `ipc/capture-rpc.agent-origin.test.ts` (the delta and parity tests).
Edited: `engine/types.ts`, `engine/executor.ts`, `engine/before-state.ts`, `engine/run-ask.ts`, `ipc/capture-rpc.ts`, `mcp-sink/capture-act.ts` (delete the
two formatters), `platform/assemble.ts` (one wiring field), `scripts/structure-audit/check-nimbus-invariants.ts` (+ test), the tests listed in Task 9.
Docs: § Task 10. No new files under `index/` (no migration).

## Tasks (test first; red-prove every guard by reverting the production line and watching its test fail)

### Task 0 - Preconditions

1. Worktree from current `main` at an absolute path (`git -C C:\gitrep\Nimbus worktree add C:\gitrep\Nimbus\.claude\worktrees\p28-ad1 -b dev/asaf/p28-ad1
   main`); verify `git rev-parse --abbrev-ref HEAD` before every commit. `bun install`; on Windows build the sandbox helper
   (`pwsh -NoProfile -File ./scripts/build-sandbox-helper-win32.ps1`). The spec and this plan are STRIPPED from the branch before the PR.
2. Re-derive the numbers: `grep -n "CURRENT_SCHEMA_VERSION =" packages/gateway/src/index/local-index.ts` (96), the D and I ceilings in
   `docs/SECURITY-INVARIANTS.md:3` (D48, I56). AD1 uses none of them, but if another slice merged and added a rule that touches D39-D41, rebase first.
3. Baseline before any edit: `bun test packages/gateway/src/ipc/capture-rpc.test.ts packages/gateway/src/mcp-sink packages/gateway/src/engine
   scripts/structure-audit/check-nimbus-invariants.test.ts` green; record the counts. Confirm with a one-off script that no proposable type is Wave 4:
   `Object.entries(ACTION_PROPOSABILITY)` filtered to proposable, joined to `CONNECTOR_WRITE_ROWS` by `actionType`, all `row.wave < 4` (this becomes
   a test in Task 9). If any is Wave 4, STOP: delta item 3 changes.

### Task 1 - Types and `isOutsideOrigin`

Files: `engine/types.ts`, `engine/outside-origin.ts` (new), `engine/outside-origin.test.ts` (new).

1. Test first: truth table for `isOutsideOrigin` (`undefined` false, `"model"` true, `"agent"` true), `isAgentOrigin`, and a type-level test that
   `{ origin: "agent" }` without `proposer` still typechecks (the gate does not require it) while `proposer` alone does not mark an outside origin
   (`isOutsideOrigin({ proposer })` is false: only `origin` decides, I3). RED (module missing).
2. `engine/types.ts:44`: `origin?: "model" | "agent"`; extend its comment ("gateway-set; removes delegation, adds a consent line, enables the
   before-state runner; HITL still decided by `type` alone, I3; top level only"). Add `AgentProposer` (D-2, deviation 4) and `proposer?: AgentProposer`.
3. `engine/outside-origin.ts` as D-1. GREEN; `bun run typecheck`.

### Task 2 - Replace the four reads (and the display) with the helper

Files: `engine/executor.ts`, `engine/before-state.ts`, `engine/standing-rule-step.ts` (comment only), their tests.

1. Tests first, each run for BOTH origins with the same fixture (extend the existing model-origin tests; do not fork them):
   - `engine/executor-delegation*.test.ts` (find with `git grep -ln "origin: \"model\"" packages/gateway/src/engine`): an `"agent"` action with an active
     delegate prompts the local owner, delegate never asked (I20).
   - `engine/before-state*.test.ts`: the runner reads for `"agent"` (a templated row with a reader) and returns undefined for an action with no origin
     when `readsEveryOrigin` is not set; `throwIfWave4WithoutPreview` throws `WAVE4_BEFORE_REFUSAL` for `"agent"` on a synthetic Wave 4 row with no
     preview (via `beforeStateRows`).
   - `engine/standing-rule-step.test.ts`: an `"agent"` action never matches a rule (twin of the `"model"` negative control; no production change).
   - A source pin in `security-invariants.test.ts` (new `describe("AD1 ...")` inside the I20/I53 area): no non-test gateway file other than
     `engine/outside-origin.ts` and `engine/standing-rule-step.ts` matches `/\.origin\s*[!=]==?\s*["']/`; red-prove by re-adding a literal compare.
   RED.
2. `executor.ts:1129`, `before-state.ts:145` and `:444`: use `isOutsideOrigin` (`:444`: `!isOutsideOrigin(action) && options.readsEveryOrigin !== true`).
   Reword the comments at `before-state.ts:9`, `:136`, `:173`, `:384`, `executor.ts:401` and `standing-rule-step.ts:12` ("an `origin: model` or `agent`
   action"). GREEN: `bun test packages/gateway/src/engine`.

### Task 3 - The proposer block (`engine/proposer-block.ts`)

1. Port the escaping tests first from `mcp-sink/capture-act.test.ts:311-430` (`formatActionConsent` carries provenance and verbatim input; the quote and
   backslash label cannot close its quotes and fake the lines after it, `:382`; C0, bidi, zero-width and astral characters shown as `\uXXXX` / `\u{XXXXX}`;
   LF escaped in one-line fields; the verbatim pretty JSON keeps its layout newlines) into `engine/proposer-block.test.ts`, retargeted at
   `formatProposerBlock` and `agentVerbatimInputLines`. Add: the block names `UNVERIFIED`, the label source (`declared`), `unlabelled` for a null label, ISO
   times, and the summary escaped as one line. RED.
2. Implement per D-3. GREEN. Do NOT delete the old formatters yet (Task 6 does, after `buildActDeps` stops using them).

### Task 4 - The executor renders the agent origin

Files: `engine/executor.ts`, `engine/executor.agent-origin.test.ts` (new).

1. Tests first (real `ToolExecutor`, fake dispatcher and consent, as `engine/executor-*.test.ts` do):
   - **Prompt, templated row** (a real proposable row, e.g. `slack.message.post` or `jira.comment.add`): lines are `Action requires your approval`, ``, `Type: ...`,
     `Requested by: an outside agent (unverified)`, ``, the typed-preview lines, ``, then the proposer block; the proposer block is LAST and never inside the
     preview lines; the summary and label with an injected `\n` + fake `Type:` line stay on one escaped line.
   - **Prompt, untemplated** (a user-MCP `mcp_x.y` action): `Input (verbatim, exactly what will be sent):` + pretty JSON with a U+202E in a value shown
     as `\u202e`; the single-line `Details:` is NOT used for the agent origin.
   - **Details**: `consentDisplayPayload` for the agent origin has `proposedBy: { clientLabel, unverifiedSummary, createdAt, expiresAt }` (same shape the UI
     reads), no `requestedBy`; a payload key named `proposedBy` or `requestedBy` is overwritten/ignored (the gateway's wins); `details.kind` is still the
     gateway's preview kind for a templated row.
   - **Model origin unchanged**: the existing `Requested by: the model` assertions stay green byte-for-byte.
   - **Audit**: the audit row for an agent dispatch contains `"origin":"agent"` and `"proposer":{"door":"agent","captureId":"cap_x"}` and does NOT contain the
     summary or label strings (use a sentinel); `redactAuditPayload`'s cap does not cut the projection (it sits before `payload`).
   - **Wave 4** (synthetic row with `confirm`, via `beforeStateRows`): the agent origin goes `captureBeforePhase` -> confirm -> `requestConfirmedApproval` only,
     denied for a wrong, empty, trimmed or cased answer, approved for the exact text, `requestApproval` never called (D41(d)); a Wave 4 row with an unreadable
     before-state is refused with `WAVE4_BEFORE_REFUSAL` before any prompt.
   - **Nothing from `proposer` reaches the connector**: the fake dispatcher receives an action whose `payload` equals the input and a serialisation of
     the dispatched call args contains no summary sentinel.
   RED.
2. `formatConsentPrompt` (`executor.ts:524`): split the current body into `formatConsentPromptBody`, add the origin line via `outsideOriginLine(action)`, and
   append `formatProposerBlock(action.proposer)` (preceded by a blank line) after EVERY shape the body returns (`promptText`, enable, eval, typed, Details); an
   agent action without `proposer` is a bug and throws (a test). For the agent origin the untemplated branch uses `agentVerbatimInputLines`. `consentDisplayPayload`
   (`:410-428`): add the agent arm. `auditedAction` (`:619`): project `proposer`. GREEN.

### Task 5 - One door maker in `run-ask.ts`

Files: `engine/run-ask.ts`, `engine/run-ask.*.test.ts`, `security-invariants.test.ts`.

1. Tests first: (a) `buildAgentWriteExecutor` and `buildModelWriteExecutor` produce executors with the same observable behaviour for a fixture row (no delegation,
   runner present, `readsEveryOrigin` false: an action with no origin gets no before-state read); (b) `buildAgentWriteExecutor` requires `getTribalKbConfig`
   (type test) and a throwing accessor refuses a KB-child-guarded row (fail closed, as the model door); (c) the census at `security-invariants.test.ts:13838`
   still passes and its slice names are unchanged. RED.
2. Refactor `newExecutorOnChannel` (`run-ask.ts:686`) to take `audit: AuditSink` in place of `localIndex`; `newTurnExecutor` and `newWorkflowWriteExecutor` pass
   `p.localIndex`. Add `newDoorExecutor` and `buildAgentWriteExecutor` AFTER `buildModelWriteExecutor` and BEFORE `buildWorkflowWriteExecutor`, keeping both
   named exports in place (deviation 6); `buildModelWriteExecutor` calls `newDoorExecutor`. GREEN: `bun test packages/gateway/src/engine`.

### Task 6 - The act door runs the door executor; delete `provenanceConsent`

Files: `ipc/capture-rpc.ts`, `mcp-sink/capture-act.ts`, `platform/assemble.ts`, `ipc/capture-rpc.test.ts`, `mcp-sink/capture-act.test.ts`.

1. Tests first (rewrite in place, Task 9 lists each): the act door's accept path asserts the executor's prompt, not the old one; new
   `ipc/capture-rpc.agent-origin.test.ts` holds the delta and parity tests of Task 9.
2. `buildActDeps` (`:196`): keep the tool resolution and the explicit credential refresh (D-6); build the action
   `{ type: actionType, origin: "agent", proposer: <from provenance>, payload: { mcpToolId: toolId, input } }`; get the executor from
   `buildAgentWriteExecutor({ clientId, consentCoordinator: coordinator, audit: w.audit, dispatcher: w.dispatcher, egressSink: w.egressSink, policyHitl: w.policyHitl,
   previewCredentialFor: w.previewCredentialFor, beforeStateRows: w.beforeStateRows, getTribalKbConfig: w.getTribalKbConfig })` (this is the only `new ToolExecutor(`
   site in the file today, `:225`, and it goes away: the census `expect(sites.length).toBeGreaterThan(5)` and the `policyHitl|NO_POLICY_OVERLAY` pin at
   `security-invariants.test.ts` ~`:3030` must still hold with one fewer site: re-check both). Delete `provenanceConsent` (`:163`), `actConsentDisplay` (`:78`) and the
   `confirmPromptLine`, `sanitisePreviewText`, `renderConnectorWritePreviewLines`, `buildConnectorWritePreviewFrom`, `isPlainObject` and `CONNECTOR_WRITE_ROWS` imports
   they alone used (let `bun run typecheck` and Biome name them). `CaptureActWiring`: D-5. Delete `formatActionConsent` and `formatActionProvenanceLines` from
   `mcp-sink/capture-act.ts` with the now-dead `visible`, `visibleLine`, `escapeCodePoint`, `INVISIBLE_RE` (the ported copies live in `engine/proposer-block.ts`).
3. `platform/assemble.ts:4790`: add `getTribalKbConfig` to `captureRpcCtx.act` (the same accessor `gateway-main.ts` passes for the model door; `git grep -n
   getTribalKbConfig packages/gateway/src/gateway-main.ts packages/gateway/src/platform/assemble.ts` finds it; if it is built in `gateway-main.ts` only, thread it
   through the existing platform handle, and say so in the PR). GREEN: `bun test packages/gateway/src/ipc packages/gateway/src/mcp-sink`.

### Task 7 - Static rules D39(e), D40(b), D41(a) (check + fixtures + docs in ONE commit)

Files: `scripts/structure-audit/check-nimbus-invariants.ts`, `.test.ts`, `docs/SECURITY-INVARIANTS.md`.

1. Fixtures first (`check-nimbus-invariants.test.ts`, red-proved: each must fail on the old checker):
   - D39(e): `buildAgentWriteExecutor` named in `engine/run-ask.ts` and `ipc/capture-rpc.ts` is clean; named in a third file is `connector-write-builders-confined`
     (rule id `connector-write-builders-confined`, `:5302`); a fixture for `buildModelWriteExecutor` unchanged.
   - D40(b): `createBeforeStateRunner` inside `newDoorExecutor` is clean; inside `buildModelWriteExecutor` (the old carrier) is a violation; a third function in
     `run-ask.ts` is a violation (the existing "second builder" red-proof, retargeted at the new names, `:2716`).
   - D41(a): `requestConfirmedApproval` named in `ipc/capture-rpc.ts` is now a violation (`confirm-channel-confined`); the old wrapper fixture
     (`:4390-4418`) is replaced by this one; the other three allowed files stay clean.
   RED.
2. Checker: `D39_BUILDERS` (`:2377-2385`) adds `[/\bbuildAgentWriteExecutor\b/g, ["packages/gateway/src/engine/run-ask.ts", "packages/gateway/src/ipc/capture-rpc.ts"]]`;
   `checkBeforeStateRead`'s carrier list (`:2716`) becomes `["newDoorExecutor", "newWorkflowWriteExecutor"]`; `D41_CHANNEL_ALLOWED` drops `ipc/capture-rpc.ts`, the
   `D41_WRAPPER_FILE` branch (`:2852-2859`) and its `d41Span` call are deleted (the helper stays: the executor-order clauses use it), and the rule text (`:2783`, `:4871`, `:5336`) is rewritten. Update the rule-description
   strings at `:5303`, `:5321`. GREEN: `bun test scripts/structure-audit/check-nimbus-invariants.test.ts` and `bun run audit:invariants`.
3. `docs/SECURITY-INVARIANTS.md`: D39 (e) text and its stated bound, D40 (b) (`:1849`), D41 (`:1851`: drop "`ipc/capture-rpc.ts` inside `provenanceConsent`"), the I53
   anti-patterns line `:1853` ("giving any executor but the door's or the workflow write executor's a before-state runner" -> "the door maker's (`newDoorExecutor`,
   built for the model and, since AD1, for the MCP act door) or the workflow write executor's"), the bounds paragraph `:934` ("no bound row is proposable ... `provenanceConsent`
   replaces" -> the new reason: the classification table, until AD3) and `:914` (the act-door preview paragraph: now the executor's own prompt).

### Task 8 - Invariant texts (CLAUDE.md, GEMINI.md, SECURITY-INVARIANTS.md, `.claude/commands/nimbus-mcp-sink.md`)

Amended under the triple rule, with the wiring and tests already in Tasks 2-7:
- **I20**: "any action with `origin: "model"`" -> "`origin: "model"` or `"agent"`" (wiring `engine/executor.ts` `tryDelegatedApproval`; test Task 2).
- **I28**: the act door's prompt is the executor's own with the proposer as a trailing UNVERIFIED block (it no longer replaces it); the bound-row bound is re-stated as the
  classification table's (until AD3); `acceptAction` is unchanged; add "an accepted proposal is dispatched as an `origin: "agent"` action through the door maker".
- **I42**: the user-MCP act-door prompt shows the verbatim pretty input in the executor's prompt with the same invisible-character escaping (test: Task 4).
- **I53 / I54 / I55 / I11 / I29**: text unchanged except the I53 sentence "only `engine/connector-write-agent-tools.ts` builds model tools from the write table (static D39)"
  stays true; I55's negative-control list gains "`origin: "agent"`" (test only). I29: one sentence in `docs/SECURITY-INVARIANTS.md`'s I29 stated bounds: an agent
  proposal's before-state reads are separate ledgered `<service>.before.read` rows (AD4 names the proposer on them).
- `CLAUDE.md` and `GEMINI.md` carry identical edits (I20, I28 lines of the Security Invariants list). `.claude/commands/nimbus-mcp-sink.md` has no
  `provenanceConsent` mention (grep confirmed); update its act-door paragraph for the new prompt anyway (`audit:doc-refs` resolves every path it cites: run it).

### Task 9 - Every test that pins the act-door prompt or `provenanceConsent`, and the delta tests

| Test | Pins today | After AD1 |
| --- | --- | --- |
| `ipc/capture-rpc.test.ts:29, :43` imports | `formatActionConsent`, `formatActionProvenanceLines`, `provenanceConsent` | imports removed; the file imports `formatProposerBlock` only where it asserts the block |
| `:226-256` `wiring()` (`buildActDeps` describe) and every `const w: CaptureActWiring = {` (`:236, :331, :661, :1025, :1112, :1212`, plus the ones in the B2/B3 describes) | a wiring without `getTribalKbConfig`/`beforeStateRows` | add a shared `testActWiring(overrides)` helper returning `getTribalKbConfig: () => undefined`; rename `previewRows` to `beforeStateRows` |
| `:257-270` first-party / user-MCP payload tests | payload `{ mcpToolId, input }` | unchanged; add `origin === "agent"` and `proposer.captureId` assertions on the dispatched action |
| `:277-288` "the consent prompt is the provenance prompt, with UNREDACTED details" (`:283` `toContain("Agent-proposed action")`) | old header | prompt contains `Requested by: an outside agent (unverified)` and the proposer block; details are the executor's, UNREDACTED for the user-MCP/untemplated case (still verbatim input) |
| `:306-386` "typed preview for a templated proposable row (F5)", incl. `:347` (header then preview) and `:371` (details: proposer ONLY under `proposedBy`, template summary kept) | provenance header, preview, `proposedBy` shape | prompt = executor header + preview + trailing block; `proposedBy` shape identical (UI contract), template `summary` still not overwritten |
| `:357-358` `lines[0]`/`lines[2]` of `formatActionProvenanceLines` | exact old lines | move to `engine/proposer-block.test.ts` (Task 3) |
| `:387-500` GHES `Instance:` tests (team/personal/invalid base) | old prompt + refresh | same assertions on the executor prompt; the invalid-base case still rejects with no prompt and no dispatch (D-6) |
| `:504-512` "no template: today's verbatim prompt and `{ actionType, input }` details, exactly" (`:509` `toBe(formatActionConsent(...))`) | old verbatim prompt | replaced: prompt has `Input (verbatim, exactly what will be sent):` + the same pretty JSON via `agentVerbatimInputLines`; details are `{ ...payload, proposedBy }`; asserts the invisible-character escaping is identical to the old output for a U+202E/U+200B fixture |
| `:513-640` `captures.accept` wiring tests | prompt at accept | same flow; prompt text per above |
| `:644-710`, `:1008-1090`, `:1095-1190`, `:1195-1266` (B1/B2/B3/B4a "provenance header, then the real row's typed preview" for every proposable type; the `:697, :1066, :1152, :1248` expectations built from `formatActionProvenanceLines(PROV)`) | exact old prompt per type; "with no before" titles | expectations rebuilt from the real executor: header + `renderConnectorWritePreviewLines(preview WITH the runner's before block)`; the fake dispatcher answers `<service>.before.read` per row's reader (use the real row's reader through a canned reply table, as `engine/before-state.test.ts` does) or the row is asserted to render `Before: unavailable (failed)` where the stub does not answer; titles lose "with no before" |
| `:2008-2095` `describe("provenanceConsent: type-to-confirm ...")` (`:2020, :2033, :2045, :2065, :2073, :2095`) | the wrapper forwards `requestConfirmedApproval` with its own prompt/details | DELETED with the wrapper; the type-to-confirm behaviour for the agent origin is covered by Task 4's Wave 4 tests (executor level) |
| `mcp-sink/capture-act.test.ts:10, :311-430` (`formatActionConsent` cases) | the old formatter | DELETED; ported to `engine/proposer-block.test.ts` (Task 3). The `acceptAction` step tests in this file are untouched |
| `connectors/proposable-actions.test.ts:288-291` (comment) | "`provenanceConsent` replaces the executor's prompt ... making one proposable needs provenanceConsent to carry the preview first" | comment rewritten: the executor's prompt now carries it; the classification and every assertion in the file are unchanged |
| `connectors/connector-writes/rows.test.ts:184` (comment naming `actConsentDisplay`) | comment | reworded; assertions unchanged |
| `security-invariants.test.ts:13155` "no bound row is proposable on the MCP act door (provenanceConsent shows no diff)" | classification | title reworded ("classification table; AD3 revisits"); assertion unchanged |
| `security-invariants.test.ts` I28/I53/D41 blocks that read `capture-rpc.ts` source (find with `git grep -n "capture-rpc" packages/gateway/src/security-invariants.test.ts`) | source pins naming `provenanceConsent`/`new ToolExecutor` in `capture-rpc.ts` | repinned to `buildAgentWriteExecutor(` and the absence of `provenanceConsent` |
| `packages/gateway/test/e2e/user-mcp.e2e.test.ts:569-571` | `toContain("Agent-proposed action")`, `toContain('Proposed by MCP client "e2e-agent"')` | `Requested by: an outside agent`, `UNVERIFIED label "e2e-agent"`; the rest of the e2e (sandboxed user-MCP, approval, dispatch) unchanged. Gateway-spawning, so it lives in the E2E tree and runs in the `packages/gateway/test` pass |
| `scripts/structure-audit/check-nimbus-invariants.test.ts:2432` (`import { formatActionConsent } ...` in an act-door fixture) | fixture string only | fixture string updated to another exported name (it only needs "another export of capture-act.ts is not covered") |
| `check-nimbus-invariants.test.ts:4390-4418` | D41 wrapper fixtures | Task 7 |
| `packages/ui` tests for `ProposedBy` (`git grep -ln "connector-write-proposed-by" packages/ui`) | `proposedBy` shape | unchanged (the shape is preserved); run the UI vitest for the file |

New in `ipc/capture-rpc.agent-origin.test.ts`:
- **Parity of reach**: for every type in `ACTION_PROPOSABILITY` classified proposable, the dispatched tool, payload and approval requirement are identical to the
  pre-AD1 snapshot (a table committed in the test, generated once from `main`); the proposable count is 47 and the seven mail-send types are in it (AD3b flips this
  assertion, and the test says so); the denied and `not_yet_offered` types are still refused at submit.
- **No proposable Wave 4 type** (Task 0 step 3).
- **Before-state on the act door**: a row with a reader (`jira.comment.add`) accepts with a read ledgered (`<service>.before.read` egress row, audited), shown in the
  prompt, one dispatch, owner-only; a guard refusal (a Notion page update of a page under the KB parent) finalizes `rejected`, no prompt, no dispatch.
- **Still no delegate, no standing rule** with an active delegation and a live matching rule in the fixture.
- **Two doors, one maker**: building via `buildModelWriteExecutor` and via `buildAgentWriteExecutor` on the same fixture yields the same preview text.

### Task 10 - Docs (the five core docs every PR, CHANGELOG, SECURITY-INVARIANTS)

- `CLAUDE.md` and `GEMINI.md` (identical): the status paragraph gains one "Phase 28 AD1" sentence (the MCP act door runs on the door executor as
  `origin: "agent"` with a gateway-set proposer; the old two-part prompt is gone; the owner sees the before-state of a proposed write; reach unchanged: 47
  proposable types; D39(e), D40(b), D41(a) amended; no migration, no new invariant; schema stays V96); the Security Invariants I20 and I28 lines per Task 8.
  Run `bun run audit:status-drift` (no `schema` or ceiling change expected; it must stay green).
- `docs/roadmap.md`: Phase 28 *The same prompt* row gets a dated progress sub-note ("AD1 delivered the executor's prompt for proposals; the row stays `[ ]` until the
  typed confirmation is exercised on every surface that exists, AD2"); Phase 28 stays "Planned" until AD3a.
- `docs/architecture.md`: `:684` (the act-door preview bullet, which describes `provenanceC...`) rewritten; `:724` (`PlannedAction.origin?: "model"`) gains `"agent"` and the
  proposer; the executor/phase description gains "the door maker".
- `docs/README.md`: the status paragraph gets the AD1 sentence.
- `docs/cli-reference.md`: `nimbus captures accept` section (find with `git grep -n "captures accept" docs/cli-reference.md`): the approval prompt now shows the typed preview with
  the target's current state and `Requested by: an outside agent (unverified)`; the proposer and the agent's summary appear last and are labelled unverified.
- `docs/CHANGELOG.md`: a dated entry in the existing style: what the owner sees (prompt, before-state), what did not change (reach, the 47 types), the deleted
  functions, the amended rules and invariants, the stated bounds.
- `docs/SECURITY-INVARIANTS.md`: Task 7 step 3 and Task 8.
- `.claude/commands/nimbus-file-map.md`: rows for `engine/outside-origin.ts` and `engine/proposer-block.ts` (gated by `audit:doc-refs`).

### Task 11 - Verification (run sequentially, never beside each other; a failing step hides later ones, so run each)

1. `bun run typecheck` and `bun run typecheck:tests` (the latter covers `packages/gateway/test/**`; the baseline must not grow).
2. `bun run preflight:fast` (types, Biome, `audit:invariants`, `audit:status-drift`, `audit:doc-refs`).
3. `bun test packages/gateway/src`
4. `bun test packages/gateway/test packages/cli` (a `src` run does not load `test/`; the user-MCP e2e is here).
5. `bun test scripts`
6. `bun test scripts/structure-audit/check-nimbus-invariants.test.ts` and `bun run audit:invariants` once more after any later edit.
7. UI: `bun run --cwd packages/ui test -- ConnectorWritePreview` (vitest) to prove the `proposedBy` section is unaffected.
8. Coverage: every file this slice touches or adds meets the floor of 85% lines and 80% branches (`audit:coverage-floor` is CI-Linux-authoritative:
   run `bun run verify:docker --full` or `bun run verify:docker --changed` for the Linux numbers; locally `bun test --coverage --coverage-reporter=lcov` on the files, then
   `bun run audit:coverage-floor`). `engine/outside-origin.ts`, `engine/proposer-block.ts` and the new executor arms are fully covered by Tasks 1-4; the branch floor is
   the risk for `formatConsentPrompt`'s new arms (cover: agent with each prompt shape, agent without a proposer, model, none).
9. `bun run preflight` if time allows; `bun run verify:docker --changed` if Docker is available (its one known red exec-e2e is the harness).
10. Known LOCAL baselines, not this branch: six migration e2e tests fail when run alongside `packages/cli/src` in one process (reproducer in the memory note
    `migration-e2e-fails-beside-cli-src-in-one-process`); five `install.ps1`/gpg tests fail on this machine; on Windows build the sandbox helper first; do not run the
    sandbox tests beside a background `preflight`. Anything else red is this branch.
11. Before opening the PR re-check `git rev-parse --abbrev-ref HEAD`, then strip `docs/superpowers/**` from the branch.

## Spec coverage (spec § 4 D-AD-1/2/7/8, § 6 AD1 row, § 7.2, § 9, § 10 AD1, mapped to a task STEP)

| Requirement | Where implemented |
| --- | --- |
| `origin: "model" \| "agent"`; gateway-set top-level `proposer` (D-AD-1) | Task 1 steps 2-3; D-2; deviation 4 (fields) |
| One helper replaces the `origin === "model"` reads (D-AD-1) | Task 2 (table above, sweep); deviation 3 (the I55 site is already generic) |
| Same executor as the model door; `newDoorExecutor`; `buildAgentWriteExecutor`; D40(b) and D39(e) amended (D-AD-1) | Task 5 step 2; Task 7 steps 1-3; deviation 2 (the wiring site) |
| `provenanceConsent`/`actConsentDisplay` deleted; the executor's own prompt reaches the owner (D-AD-2) | Task 6 step 2; Task 4 |
| Proposer in a trailing UNVERIFIED block, escaped, after the verified preview (D-AD-2) | Task 3; Task 4 step 2 |
| Nothing in `input` selects the tool, credential or confirm text (D-AD-2, I3) | Task 6 step 2 (tool from the routing table, unchanged); Task 4 (payload keys inert, no `proposer` to the connector); Task 9 parity table |
| Before-state, guard, Wave 4 refusal and typed confirm for the agent origin | Task 2 (before-state, `throwIfWave4WithoutPreview`); Task 4 Wave 4 tests; Task 9 before-state test |
| No delegation, no standing rule for the agent origin (D-AD-8) | Task 2 (delegation, I55 twin); Task 9 "still no delegate" |
| I20, I28, I42 text amended with wiring + test in one commit | Task 7, Task 8 |
| D41(a) loses its wrapper clause (found while mapping) | Task 7; deviation 1 |
| Payload cap vs commit limits (D-AD-7) | NOT AD1: bound rows stay unproposable (deviation 7); AD3a/AD3b verify the `capture.payload_bytes` cap |
| AD1 changes no reach (spec § 6 "eligibility is AD3") | The delta section; Task 9 parity table |
| Five core docs, CHANGELOG, SECURITY-INVARIANTS | Task 10 |

## Risks / open questions

- **Owner / reviewer decisions to look at:** (1) the `proposer` projection in the audit row is `{ door, captureId }` only (AD4 adds the label); (2) `details.requestedBy`
  is not set for the agent (the UI contract is `proposedBy`); (3) D39(e) names `ipc/capture-rpc.ts` as a builder site (deviation 2); (4) the shared builder now takes
  `audit: AuditSink` (deviation 5), a small refactor of a function three executors share.
- **More ledgered reads on the act door.** Each accepted proposal for a row with a reader adds up to two `<service>.before.read` audit and egress rows. Any test or doc
  that says "one egress row per accept" must be re-read (grep `egress` in `capture-rpc.test.ts` and the act-door e2e); AD4's acceptance counts DISPATCH rows.
- **The 5 s before-read cap and CLI cold start** now applies to act-door accepts of reader rows: a slow read shows `unavailable (timeout)`; not a refusal for Waves 2-3.
- **`beforeReaderUnlisted`** (deviation 8): the act door cannot say a reader is unlisted; a missing reader shows `unavailable (failed)`. Matters for Wave 4 (AD3a).
- **Rewriting ~40 prompt-pinning tests** is the bulk of the work; the parity table is generated from `main` BEFORE the edit so that a rewritten expectation cannot
  silently absorb a behavioural change. Do it first (Task 0 step 3, Task 9).
- **User-MCP verbatim display** depends on `agentVerbatimInputLines` keeping the exact escaping set; the ported tests are the guard. A regression here reopens the
  "hidden bidi character in an approved input" hole the old act door closed.
- **The census at `security-invariants.test.ts:13838`** slices `run-ask.ts` by function names; moving either export breaks it silently (deviation 6).
- **A second `ToolExecutor` per accept** is unchanged (one per accept, bound to the accepting session); no pooling.
- Live connector reply shapes for the before-readers are read from their mappers and tests, not verified against live accounts.

## PR

Title (conventional commit, no `!`; nothing here requires a user to act, and the set of proposable actions is unchanged):

`feat(gateway): run the MCP act door on the door executor, so an approval shows the typed preview, the before-state and the unverified proposer`

Description: the delta (the five points), the four spec corrections (short), the amended rules and invariants, the stated bounds, the verification output. End with the
attribution lines from the session. No `Release-As:` trailer.

## Review log

