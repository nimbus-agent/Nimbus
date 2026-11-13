# Phase 28 — The Agent Door

Status: DRAFT for review (2026-11-13). Owner rulings OR-AD-1..9 and OR-ECO-8 are binding; do not reopen them.
Revision 2: the owner answered the four open questions the same day (OR-AD-6..9, § 2); the design and slices follow them.
Date: 2026-11-13. Slot: S4 (the next project to start, OR-ECO-8). Roadmap: `docs/roadmap.md` § Phase 28 (all nine
rows), § Direction, and the carried-in row *User-MCP write grants* (§ Carried into S4).
Substrate mapped on `origin/main` at `165fa4353` (2026-11-13). Every `file:line` below was read in that tree.

## 1. Goal

An MCP client (a coding agent, a chat bot, another tool) proposes any connector write the model door offers, and the
owner approves it in ONE action at the terminal, seeing exactly what the model door shows: the typed preview, the
before-state, the bound diff or plan, the proposer in an unverified block, and for a Wave 4 row the typed confirmation.
Nothing the agent supplies picks the tool, the confirm text or the credential. Every dispatch has one audit row and one
egress row that name the door and the proposer. Kits install the door into Claude Code, Codex, Cursor and VS Code and
say what each agent can still do outside it. The door guards what passes through it; an agent holding its own credentials
can act outside it, and the product says so.

Roadmap acceptance this project must meet (`docs/roadmap.md` § Phase 28):

- (A1) With a write enabled and approved, an MCP client proposes it and the owner sees the same preview the model door
  renders for the same input, asserted on the rendered text. -> AD1, AD2, AD3a.
- (A2) A Wave 4 proposal is denied without the exact confirm text, on every approval surface. -> AD1 (executor), AD2
  (terminal). The desktop and ChatOps surfaces are later rows (OR-AD-1); "every approval surface" means every surface that
  exists when this phase closes, and § 8 says so.
- (A3) From proposal to dispatch takes one owner action. -> AD2.
- (A4) The whole path works with no model configured in Nimbus. -> AD2 test (§ 10).
- (A5) Every dispatch has one egress row and one audit row naming the door and the proposer. -> AD4.
- (A6) At least two kits are verified against the real agent and the result is published as a matrix. -> AD7 (§ 7.6).
- (A7) The invariants touched are amended under the triple rule (wiring, docs, test in one commit). -> every slice; § 9.

## 2. Owner rulings

- **OR-ECO-8 (2026-11-12, carried).** The agent door is the next project inside S4; S4's exit condition grows by one.
- **OR-AD-1 (2026-11-13) The terminal first.** A new owner queue: `nimbus approvals` lists waiting proposals;
  `nimbus approvals <id>` shows the full model-door prompt (typed preview, before-state, bound diff or plan) and takes the
  typed confirmation in ONE owner action, with no separate `captures accept` first. The desktop follows after the signed
  desktop release (Reach), and ChatOps later. Both are recorded as later rows and not built here (§ 8).
- **OR-AD-2 (2026-11-13) A list per door.** The wave enable is shared; agents have their own approved-tool-id list
  (`nimbus connector writes enable <svc> --door agent`, with the existing `--wave` and `--approve` patterns). Existing
  act-door use stops until the owner re-approves by name.
- **OR-AD-3 (2026-11-13) No mail sends, ever.** The agent door uses the model door's never-offered list
  (`MODEL_NEVER_OFFERED_TOOL_IDS` / `MODEL_NEVER_OFFERED_REASONS`, `connectors/connector-writes/model-offerable.ts:17-42`).
  Drafts stay allowed. This removes a capability that exists today: all seven mail sends are proposable on the act door
  (`connectors/proposable-actions.ts:79-87`). It is a breaking change for anyone who uses it (§ 11).
- **OR-AD-4 (2026-11-13) Kits in the CLI.** `nimbus agent install <claude-code|codex|cursor|vscode>` and
  `nimbus agent status`; they ship with the gateway release.
- **OR-AD-5 (2026-11-13) A changed definition suspends.** Any change to a tool's definition (a hash of its schema and
  description) suspends that tool for agents until the owner re-approves it by name. `nimbus connector writes status`
  lists what is suspended and why.
- **OR-AD-6 (2026-11-13) Accept the self-approval bound; add friction.** Approvals only on an interactive TTY; no `--yes`;
  typed confirmation for Wave 4; each kit writes the agent's deny rule for `nimbus approvals` where the agent supports one;
  the README and every kit say plainly that an agent with a shell can still approve its own proposals until desktop
  approval ships. (Answers Q1.) Where this lands: § 7.2, § 7.6, § 7.8, § 12.
- **OR-AD-7 (2026-11-13) Full Wave 4 parity in the first release.** A Wave 4 row is offered after
  `nimbus connector writes enable <svc> --wave 4 --door agent` and the owner's approval of the row by name, with the typed
  confirmation and a readable before-state, as on the model door. (Answers Q2.) Where this lands: § 7.3, AD3a.
- **OR-AD-8 (2026-11-13) Our own dual-era MCP server layer.** The owner rejected the upstream options. The layer is built in
  `@nimbus-dev/sdk` (repo `nimbus-agent/nimbus-sdk`, MIT) and serves revision 2025-11-25 and the stateless 2026-07-28,
  including `server/discover`, the `_meta` protocol fields and the `InputRequiredResult` multi-round-trip successor to
  elicitation. The SDK is released; the CLI MCP adapter and the standalone connectors' consent path then consume it.
  (Answers Q3.) Where this lands: § 7.1, AD6a, AD6b, AD6c.
- **OR-AD-9 (2026-11-13) One release of deprecation, not an immediate major.** AD3a ships as a non-breaking `feat`: it applies
  the per-door eligibility, but a legacy act-door proposal that would now be refused is still accepted, with a deprecation
  warning in its response, in `nimbus approvals` and in `nimbus connector writes status`, and it is counted. AD3b, in the next
  minor release or later, enforces. Mail sends: AD3a warns, AD3b refuses. (Answers Q4.) Consequence recorded in § 11: under
  the repo's `!` rule AD3b DOES carry `feat(gateway)!:`, because a user who ignored the warning must act; the ruling postpones
  the major by one release and does not avoid it.

## 3. What exists today (verified)

| Fact | Where |
| --- | --- |
| The CLI MCP server registers `propose_action` and `capture_status` only when `capture.status` says the door is on; the client label is `server.server.getClientVersion()?.name`, the unverified `clientInfo.name`; the adapter declares `session.declareKind {kind:"mcp"}`. | `packages/cli/src/mcp/capture-tools.ts` (`CAPTURE_TOOL_SPECS`, `captureToolsFor`); `adapter.ts:263`, `:633` |
| `submitCapture` is the only entry; it runs the rate limit, validation, `classifyAction`, `actionDestinationRefusal`, configured-ness and the queue caps, then stores a `proposed` row with `expiresAt`. | `mcp-sink/capture-gate.ts:369`, `:259`, `:388`, `:313-362` |
| `acceptAction` runs a fixed 8-step order (capability, owner role, state and expiry, re-classify, destination, CAS claim, execute, finalize) and executes through `ActDeps` built by the RPC layer. | `mcp-sink/capture-act.ts` (`acceptAction`) |
| `buildActDeps` builds a fresh `ToolExecutor` per accept with NO delegation and NO before-state runner, around the ACCEPTING session's consent channel. The tool is gateway-chosen (`proposableWriteTool(actionType)` or the user-MCP key); the action is `{type, payload:{mcpToolId, input}}` with NO `origin`. | `ipc/capture-rpc.ts:196` |
| `provenanceConsent` REPLACES the executor's prompt text and details with the act door's own (`actConsentDisplay`), so a before-state, a bound diff or a plan cannot reach the owner. | `ipc/capture-rpc.ts:163`, `:78` |
| The act door ignores the V83/V84 enable and approvals, ignores `MODEL_NEVER_OFFERED`, and classifies by a static table: 47 proposable types including the seven mail sends; `not_yet_offered` is withheld "because the act door runs no before-read". | `connectors/proposable-actions.ts:33-46`, `:136`, `:280`, `:352` |
| `PlannedAction.origin` can only be `"model"`; it removes delegation (I20), adds the `Requested by: the model` line, and gates the before-state runner and `throwIfWave4WithoutPreview`. | `engine/types.ts:44`; `engine/executor.ts:421-427`, `:531`, `:1128`; `engine/before-state.ts:145`, `:444` |
| A before-state runner is built in two carriers in `run-ask.ts`: `buildModelWriteExecutor` (the door) and `newWorkflowWriteExecutor` (SA2/SA4, `readsEveryOrigin: true`). Static D40(b) already names both. | `engine/run-ask.ts:712-724`, `:778-790`; `docs/SECURITY-INVARIANTS.md` D40(b) |
| Standing approvals (I55, D44) exist; an `origin: "model"` action is a negative control; nothing names a second outside origin. | `engine/standing-rule-step.ts`; I55 |
| `hitl.pendingQueue` lists the DELEGATE broker's pending requests. `ConsentCoordinatorImpl` keeps a private `pending` map and exposes only `pendingCount()`: the owner has no local queue of pending consents. | `ipc/hitl-rpc.ts:76`; `ipc/consent.ts:43`, `:66`, `:237` |
| `consent.request` is written to the ACTING client only (`getWriter(clientId)`). The OS toast carries fixed text and cannot answer anything. | `ipc/consent.ts` (`open`); `util/approval-pending.ts` |
| `capture.state` returns state, expiry, `outcomeRef` and `errorCode` for ANY `cap_…` id to any MCP connection: no ownership check. The tool description says so. | `mcp-sink/capture-gate.ts:840-862`; `capture-tools.ts` (`capture_status`) |
| `CAPTURE_ROLE_BY_KIND` gives `unknown` the owner role; the kind is declared by the connection, so the role is the connection's own claim. | `mcp-sink/capture-client-policy.ts:12-21`; `ipc/server/client-kind.ts:13-46` |
| The dispatch audit row's `actionJson` is the whole action (so `origin` is in it) but nothing names a capture or a label; the egress row is `sourceType: "task"`, `sourceId = sessionId`; its hash covers `source_type|source_id|destination|method|hitl|result`, NOT `payload_summary`. | `engine/executor.ts:619-638`, `:828`; `egress/egress-record.ts:54`; `egress/egress-ledger.ts:29`; `db/audit-chain.ts:19` |
| User-MCP types `mcp_<id>.<tool>` are act-door-proposable for `--model` servers while `user_mcp_model_access` allows, shown as raw JSON. Tool-definition hashing exists only for extensions (V66 digest) and toolgen. | `connectors/proposable-actions.ts:334-350`; `connectors/user-mcp-store.ts` |
| Policy lockoffs in play: `mcp_capture`, `mcp_action`, `user_mcp_model_access`, `connector_write_model_access`. | `policy/types.ts:63-77` |
| Rate limits: one gateway-wide hourly attempt window; the durable hourly cap `maxActions` (default 50); `actionMaxPending`; the native pending cap. | `mcp-sink/capture-rate-limit.ts:12`; `config/nimbus-toml.ts:1092`, `:1109` |
| `capture`/`captures` are LAN-forbidden by entries in a DENYLIST; a new namespace is LAN-reachable by default. | `ipc/lan-rpc.ts:239-241` |
| The CLI depends on `@modelcontextprotocol/sdk` 1.32.0 (revision 2025-11-25). The standalone connectors (`nimbus-mcp-servers` `shared/consent-kit.ts:116`, `:273`) ask write consent with `server.server.elicitInput` on the same SDK 1.32.0. | `packages/cli/package.json:20`; nimbus-mcp-servers `package.json` |

Two corrections to the brief, found while mapping: (1) D40(b) is no longer "built only in `buildModelWriteExecutor`": the
workflow write executor is a second carrier (SA2), so the amendment below names a shared maker. (2) `PlannedAction`
already has a second gateway-set field, `provenance`, so a `proposer` field follows an existing pattern.

## 4. Decided by me (D-AD-n, so review can challenge them)

- **D-AD-1 One door, one executor path; a second origin.** `PlannedAction.origin` becomes `"model" | "agent"`, and a new
  top-level gateway-set `proposer?: { door: "agent"; captureId: string; label: string | null; labelSource: "declared" |
  "kit" }` is added (the `provenance` pattern: never from IPC, payload or a door). One helper, `isOutsideOrigin(action)` in
  `engine/types.ts`, replaces the five `origin === "model"` reads (delegation fallback `executor.ts:1128`, runner gate
  `before-state.ts:444`, `throwIfWave4WithoutPreview` `before-state.ts:145`, the `requestedBy` display
  `executor.ts:421-427`, the line `executor.ts:531`) and the I55 negative control, so the two origins cannot drift. The agent
  door runs on the SAME executor as the model door: `run-ask.ts` gets one private maker `newDoorExecutor(p)` (no
  delegation, `createBeforeStateRunner` without `readsEveryOrigin`) which `buildModelWriteExecutor` and a new one-line
  `buildAgentWriteExecutor` both call. **D40(b) is amended**: the runner is built only in `engine/before-state.ts` and in
  `engine/run-ask.ts`, there only inside `newDoorExecutor` or `newWorkflowWriteExecutor`. **D39(e)** confines
  `buildAgentWriteExecutor` to `engine/run-ask.ts` and its one wiring site in `platform/assemble.ts`. Why no new runner
  site: a second site is a second place for the order to drift; the executor does not care who proposed, `origin` on the
  action decides.
- **D-AD-2 The prompt is the executor's.** `provenanceConsent` and `actConsentDisplay` are deleted (retire = delete). The
  executor's own prompt renders the typed preview, before-state, bound diff or plan and, new, a trailing block built from
  `action.proposer`: `Proposed by an outside agent (UNVERIFIED label "<escaped>", from <declared client name | kit
  config>) at <time>, expires <time>` and `Agent's summary (UNVERIFIED): <escaped>`. Both strings pass
  `sanitisePreviewText` and the existing `visibleLine` escaping (a quote or line break cannot fake the lines around it);
  the block is after the verified preview, never inside it, and structured details carry it only under `proposedBy`.
  Nothing in `input` selects the tool (the routing table does), the credential (the executor's resolver does) or the
  confirm text (typed by the owner against the row's `confirm` target, D41).
- **D-AD-3 The proposal waits as a capture row.** Reuse the V67-V69 `capture` table and its lifecycle
  (`proposed -> executing -> executed|rejected|failed|expired`). A new table would duplicate expiry, caps, boot reconcile
  (`reconcileActionsAtBoot`) and the CAS claim, all already audited. One migration adds what is missing (V97, § 7.3).
  The two-step legacy flow is retired: `captures accept <id>` on an action capture becomes an alias of `approvals.approve`
  (one code path); `captures accept --all` still refuses actions.
- **D-AD-4 Approval runs on the OWNER's session, after the proposal.** The agent's `propose_action` never blocks on a
  prompt. `approvals.approve` runs `acceptAction`'s fixed order on the owner's CLI connection, so `consent.request`
  reaches that terminal (`ipc/consent.ts`), the before-state reads happen then (fresh, never stored with the proposal), and
  the typed text is collected there. A proposal nobody opens makes no connector read.
- **D-AD-5 Eligibility = the model door's predicate plus a door.** One function, `agentOffered(e, row)`, beside
  `offeredUnder` in `connectors/connector-writes/model-write-source.ts`: the service is enabled (shared V83 row),
  `row.wave <= maxWave`, `isModelOfferableRow(row)` (this includes the never-offered list and the preview, before and confirm
  requirements), the tool id is in the AGENT approved set for that service (new, V97), the definition hash matches
  (D-AD-9), the org policy allows BOTH `mcp_action` and `connector_write_model_access` (monotonic-stricter; no new
  capability), and Terraform and Kubernetes rows have an approved directory or pair. It runs at submit (cheap, no reads),
  at approval start and before dispatch; the executor's own gates still run. From AD3b `ACTION_PROPOSABILITY`'s table is no
  longer consulted for first-party types. During the deprecation window (AD3a, OR-AD-9) a proposal that `agentOffered`
  refuses is still accepted when it is a legacy case (D-AD-15); every other rule, including `modelWriteRefusal`'s refusals
  that the old door also applied, still holds.
- **D-AD-6 One refusal set.** The agent door uses `modelWriteRefusal` (messaging, ChatOps, broadcast, quick action, remote
  content, null optionals, calendar zone, KB, commit paths and credential look, IAM capability, and the before-state
  guards), not `actDoorRefusal`. The act door's extra rules (Linear `assigneeId` always refused, KB page update refused
  whenever a KB destination exists) existed only because it had no before-state; the guards replace them.
  `actDoorRefusal` and `createActionDestinationRefusal` are deleted once no door calls them (D32(g) is rewritten). The
  model-door-only commit and IAM refusals now bind the agent too: the agent is not the owner.
- **D-AD-7 Bound rows become proposable.** I28's "no bound row (a commit) is proposable" existed because the act door's
  prompt replaced the executor's and carried no diff. Once D-AD-2 lands, the two commits and the iac rows run the I54
  preflight/prepare/settle/consent path on the agent door unchanged. The stored action payload cap must cover the commit
  limits (32 KiB new text, 32 KiB old text) plus the envelope; the current `capture.payload_bytes` cap was not found in this
  read (UNVERIFIED), and AD1 checks it and raises the action cap if needed.
- **D-AD-8 Delegation and standing rules never apply.** `isOutsideOrigin` is the delegation fallback (I20: "origin model
  or agent"); an `origin: "agent"` action is a negative control of I55; `buildAgentWriteExecutor` passes no delegation and no
  `standingRules`. `--yes` and scripted consent are refused on `approvals` entirely (the proposer is not the owner), not only
  for Wave 4.
- **D-AD-9 The definition hash (OR-AD-5).** `definitionSha256 = SHA-256(canonicalJson({toolId, description, inputSchema}))`
  of what the connector server lists for the row's tool (`listServerTools` / `toolsEpoch`, already read by the model door).
  Stored per approved tool id at `enable --door agent`; re-derived at submit, at approval start, immediately before dispatch
  inside the same `toolsEpoch` generation, and at every `status`. A mismatch refuses with the fixed code
  `ERR_AGENT_TOOL_SUSPENDED`, marks the tool suspended, and `status` prints `suspended: definition changed since approved
  <date> (approved <sha[:12]>, now <sha[:12]>)`. Re-approval is `enable <svc> --door agent --approve <toolId>`. It covers
  what a third party can change (the listing). Gateway-side row fields (wave, confirm, before, bound, preview template)
  change only with a signed gateway release, and a wave raise already needs a re-enable (`maxWave`). The hash does not
  cover runtime behaviour (§ 12).
- **D-AD-10 `describe_actions` read tool; still one write tool.** Agents get one write tool, `propose_action`, plus a new
  read-only `describe_actions` returning, for each action type the door would accept NOW: type, wave, the connector's
  description and input schema (escaped; user-MCP descriptions go through `wrapToolDescription` and
  `sanitiseUserMcpInputSchema`, I11/I42), whether a typed confirmation is required, and `suspended` with the fixed reason.
  Why not one MCP tool per write as the model door does: about a hundred tools in an outside agent's context, a list that
  changes whenever the owner approves something, and tool-list churn is exactly what the new revision's caching is meant to
  avoid (§ 7.1).
- **D-AD-11 Ownership of ids.** `capture.state` and a new `capture.mine` answer only for rows whose `session_id` equals the
  caller's connection (the gate already stores it, `capture-gate.ts:173`). Ids must be unguessable (>= 128 bits of CSPRNG);
  the current generator was not located in this read (UNVERIFIED) and AD2 verifies or replaces it.
- **D-AD-12 Per-connection caps.** In addition to the global window, a connection may hold at most 10 `proposed` actions
  (`actionMaxPending` is global, so one flooding agent fills it for everyone). A refused proposal returns a fixed code. The
  owner-facing signal is a count-only local notification ("N agent proposals are waiting", numbers only, built like the D45
  toast), never request text.
- **D-AD-13 Label source.** The label shown is `--agent <kit>` from the owner-written server config when present
  (`labelSource: "kit"`), else `clientInfo.name` (`"declared"`). Neither is trusted for any decision; the prompt says which.
- **D-AD-14 Opt-in by name.** The door stays behind the `[mcp_sink]` act switch and `mcp_action` policy, and the agent
  approved set is empty on upgrade. The owner's opt-in is `enable --door agent`; its prompt lists the rows by name, wave and
  typed-confirm flag, exactly as the model door's enable prompt does. From AD3b nothing is proposable without it; during the
  AD3a window the legacy cases of D-AD-15 still are, with a warning.
- **D-AD-15 The deprecation window (OR-AD-9).** AD3a defines a *legacy proposal*: one `agentOffered` refuses ONLY because
  the owner has not approved the tool id for agents (no agent approval, or no `--wave` high enough in the enable) or because
  the row is one of the seven mail sends, AND which the old door accepted (the type is `proposable` in the unchanged
  `ACTION_PROPOSABILITY` table and `actDoorRefusal` passes). It is stored, flagged `legacy` (a column in the V97
  migration), counted, and answered with a fixed deprecation line in the `propose_action` result, at the top of the
  `nimbus approvals` list and detail, in the approval prompt, and in `nimbus connector writes status` (count of legacy
  proposals in the last 30 days, by type). Everything else is enforced from AD3a: a hash mismatch (a tool the owner HAS
  approved, now changed) is suspended at once, a never-offered row other than the mail sends was never proposable and stays
  refused, a Wave 4 row is never a legacy case (the old door had none), and a legacy proposal still runs through the one
  executor path, so it gets the before-state, the guards and the proposer block. A legacy proposal for a mail send is
  approved on the owner's terminal like any other; nothing about the send changes in AD3a. AD3b deletes the legacy case, the
  column's writer and the table consult. AD3b may merge only after a release containing AD3a has been published (a manual
  check recorded in the AD3b PR).
- **D-AD-16 The IPC `kind` bound, and what is tightened.** The connection declares its own kind
  (`session.declareKind`, `ipc/server/client-kind.ts:37-46`) and `CAPTURE_ROLE_BY_KIND` maps `unknown` to the owner role
  (`capture-client-policy.ts:12-21`). Declaring `cli` costs a hostile local process nothing, so tightening `unknown` would not
  stop it; it would only break older clients that never declare a kind. Decision: AD2 tightens ONLY the new `approvals.*`
  methods (they need a declared `cli` or `ui` kind; they are new, so no existing client breaks). The existing `captures.*`
  role mapping is NOT changed, and `captures accept` on an action, kept as an alias, keeps its present roles. This is
  recorded as a stated bound (§ 12), not as a change; it needs no owner question because nothing existing breaks.

## 5. Non-goals

- No desktop or ChatOps approval surface (OR-AD-1); § 8 says what each needs.
- No mail send for agents, ever (OR-AD-3); no write the model door does not offer.
- No authentication of the MCP client (an unverified label only); no network MCP transport (stdio only, as today).
- No auto-approval of any kind: no standing rule, no delegate, no `--yes` for an agent proposal.
- No new connector write rows; AD1-AD5 need no connectors release (AD6c is a release of `nimbus-mcp-servers`, AD6a a release of `@nimbus-dev/sdk`).
- No protection against an agent that uses its own credentials or shell (§ 12).

## 6. Slices (one PR each, in order)

| Slice | Repo | Content |
| --- | --- | --- |
| AD1 | Nimbus | Executor generalisation: `origin: "agent"` and `proposer`, `isOutsideOrigin`, `newDoorExecutor`, the proposer block in the executor's prompt, delete `provenanceConsent`/`actConsentDisplay`; amend I20, I28, I53, I54, I55, D39(e), D40(b) |
| AD2 | Nimbus | Queue and one-step approval: `approvals.list/get/approve/decline`, `nimbus approvals`, ownership on `capture.state`, `capture.mine`, per-connection cap, count-only notification, LAN denylist entry (acceptance A3, A4) |
| AD3a | Nimbus | Per-door eligibility, non-breaking `feat` (OR-AD-9): V97 (door table, `legacy` flag), `enable/status --door agent` incl. `--wave 4` (OR-AD-7), `agentOffered`, the definition hash and suspension (OR-AD-5), parity with the model door; legacy proposals still accepted with a deprecation warning and counted (D-AD-15); the new invariant (with its stated legacy exception) and D49 |
| AD3b | Nimbus | Enforcement, `feat(gateway)!:`, in the next minor release or later: legacy case deleted, mail sends refused, the `ACTION_PROPOSABILITY` first-party consult, `actDoorRefusal` and `createActionDestinationRefusal` deleted, the invariant's exception retired (§ 11) |
| AD4 | Nimbus | Proof: door and proposer in the audit row and the egress `sourceId`, `nimbus prove --by-proposer`, audit views, completeness check |
| AD5 | Nimbus | User MCP servers through the door: the `--agent` grant, per-call approval display, definition hash for `mcp_*`, user-MCP write grants; amend I42 and I15 |
| AD6a | nimbus-sdk | A dual-era MCP server layer in `@nimbus-dev/sdk` (new entry point `./mcp-server`, dependency-free, wire implemented in-house): 2025-11-25 and 2026-07-28, `server/discover`, the `_meta` fields, `InputRequiredResult`; spec, conformance corpus and a published release (OR-AD-8) |
| AD6b | Nimbus | The CLI MCP adapter (`packages/cli/src/mcp`) on the new SDK; `@modelcontextprotocol/sdk` leaves `packages/cli` if nothing else needs it |
| AD6c | nimbus-mcp-servers | `shared/consent-kit.ts` on the new SDK: the `InputRequiredResult` successor to elicitation, dual-era; a connectors release |
| AD7 | Nimbus | Kits: `nimbus agent install|status`, steering rules and hooks per agent, the real-agent matrix, the bounds copy on the docs page and README |
| AD8 | registry repo + Nimbus docs | The Developer role pack in the official registry; README and security-page copy for the release that ships the door |

Order dependencies: AD2 needs AD1; AD3a needs AD2; AD4 needs AD1 (its fields) and may land before AD3a; AD5 needs AD3a;
AD3b needs AD3a AND a published release that contains it (D-AD-15), and may land after AD7 and AD8; AD6a is independent of
the gateway work and can start at once; AD6b needs the AD6a release and AD3a (its adapter carries `propose_action` and
`describe_actions`); AD6c needs the AD6a release; AD7 needs AD3a (and AD6b if it has shipped, so the kit's server entry is
whichever adapter ships); AD8 needs AD7. The release that ships AD3a carries the deprecation notice (§ 11).

Numbers re-derived from `origin/main` at `165fa4353`: the schema is at V96 (`runner-v96.test.ts` exists), so this spec says
**V97 (next free at merge)**; static rules run D10-D48, so **D49 (next free at merge)**; invariants run I1-I56. The
incident-engine spec reserves I57 and the sub-rules D46(a)/(c), so this spec's one new invariant is **I5x (next free at
merge, expected I58)**. Numbers follow merge order.

## 7. Design

### 7.1 MCP revision 2026-07-28 (AD6a, AD6b, AD6c): from the primary sources

Read from modelcontextprotocol.io on 2026-11-13:

- Versioning (<https://modelcontextprotocol.io/specification/versioning>): "The **current** protocol version is
  **2026-07-28**." It is Current, not Final (Final is for past revisions; it "may continue to receive backwards compatible
  changes"). 2025-11-25 is the previous revision.
- Changelog (<https://modelcontextprotocol.io/specification/2026-07-28/changelog>), the changes that matter here:
  1. Protocol-level sessions and `Mcp-Session-Id` are removed (SEP-2567).
  2. The `initialize`/`notifications/initialized` handshake is removed; every request carries
     `io.modelcontextprotocol/protocolVersion` and `.../clientCapabilities` in `_meta`; clients SHOULD send
     `.../clientInfo` and servers SHOULD return `.../serverInfo`; a version mismatch returns `UnsupportedProtocolVersionError`
     (code `-32022`) (SEP-2575).
  3. `server/discover` is a mandatory server RPC (versions, capabilities, identity); on stdio it is the probe.
  4. `ping`, `logging/setLevel` and `notifications/roots/list_changed` are removed; `subscriptions/listen` replaces
     `resources/subscribe`; SSE resumability is removed.
  5. Tasks leave the core for the extension `io.modelcontextprotocol/tasks` (SEP-2663).
  6. **Multi Round-Trip Requests (SEP-2322).** Server-initiated requests (`elicitation/create`, `sampling/createMessage`,
     `roots/list`) are replaced by an interim result, `InputRequiredResult` (`resultType: "input_required"`), carrying
     `inputRequests` and an opaque `requestState`; the client retries the SAME request under a new JSON-RPC id with
     `inputResponses` and the echoed `requestState`. It is allowed on `tools/call`, `prompts/get` and `resources/read`
     only. All results now carry `resultType`. A server MUST treat `requestState` as attacker-controlled and protect its
     integrity (HMAC or AEAD) when it influences authorization or business logic, and SHOULD bind it to the principal, a
     short expiry and a digest of the request. `notifications/elicitation/complete` and the URL-mode `elicitationId` are
     removed.
  7. Roots, Sampling and Logging are Deprecated; Dynamic Client Registration is deprecated for Client ID Metadata Documents;
     `tools/list` results gain `ttlMs` and `cacheScope`; `inputSchema` may use any JSON Schema 2020-12 keyword.
- Backward compatibility (<https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning>): a dual-era server
  "MAY serve both eras concurrently on the same endpoint or process", choosing by how the client opens (modern `_meta` ->
  stateless; `initialize` -> legacy semantics scoped to the stdio process). A legacy client against a modern-only server
  FAILS and has no fall-forward. So the adapter MUST stay dual-era, or every kit and every older agent breaks.
- MRTR (<https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr>): a server MUST NOT send
  `inputRequests` the client did not declare capability for (no `elicitation` capability, no `elicitation/create`).

**Why we build the layer (OR-AD-8).** The owner rejected the upstream options. The upstream TypeScript SDK v2 line does
implement this revision (<https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28>: `@modelcontextprotocol/server`
with `serveStdio`, `createMcpHandler`, `inputRequired`), but its release status is UNVERIFIED (a release note calls the first
beta "SDK v2 with support for the MCP 2026-07-28 specification revision", one blog says 2.0.0 shipped stable on 2026-07-28,
one article names 2.1.0; the official page states no status) and it is a package rename. The CLI pin today,
`@modelcontextprotocol/sdk` 1.32.0, declares 2025-11-25 and cannot speak 2026-07-28. The layer is built in our own SDK; the
upstream v2 page is used only as a reference for what a dual-era `serveStdio` and an MRTR handler API look like.

**Dependency rule of the SDK (read in `C:\gitrep\nimbus-sdk`, read only).** Its `CLAUDE.md` § Conventions says: "Dependency-free
at runtime. No `dependencies` in `package.json`. If you need a helper, inline it — never add a runtime dep to the published
surface." It also keeps the published surface from importing `@modelcontextprotocol/sdk` or `zod` (the connector-kit's
`ZodObjectSchema` is a structural type, and the scaffold templates that do use those packages are typechecked only in separate
CI jobs that install them). Decision: the layer does NOT depend on the upstream MCP SDK, not even as a peer; it implements the
wire itself. That is practical: stdio MCP is newline-delimited JSON-RPC 2.0, and the SDK already ships the NDJSON line reader
and framing under `./ipc`; the layer adds the request router, the two eras, `_meta` handling, `server/discover`, the tool
registry and MRTR on top. Tool input schemas are plain JSON Schema objects (2020-12 keywords, which the new revision allows),
not zod; callers holding zod schemas convert before registering (the CLI does this with `z.toJSONSchema`; the connectors do not
need to). Sampling and roots are not implemented (the revision deprecates them). Streamable HTTP is not implemented (Nimbus
serves MCP over stdio only); the module is a transport-neutral core plus a stdio binding, so HTTP can be added later.

**AD6a design (nimbus-sdk).** A new TypeScript-only entry point `@nimbus-dev/sdk/mcp-server` (the seventh `exports` entry),
`@moduleStability experimental` until a connector release has consumed it (RFC-0015 tiers), a normative spec at
`docs/spec/mcp-server/v1/` (the layout `signing` and `diagnostics` use) and a conformance corpus. Surface, in outline:
`createMcpServer({ name, version, title? })`, `server.tool({ name, description, inputSchema, annotations?, handler })`,
`serveStdio(server, { input, output, legacy: "serve" | "reject" })`, and a `ctx` passed to handlers with `ctx.era`
(`"modern" | "legacy"`), `ctx.clientInfo`, `ctx.clientCapabilities`, `ctx.protocolVersion`, `ctx.inputResponses`,
`ctx.requestState`, plus `inputRequired({ inputRequests, requestState })` with `inputRequired.elicit({...})`. Behaviour:

1. Era selection is per connection, from how the client opens: a first request carrying
   `_meta["io.modelcontextprotocol/protocolVersion"]` is modern and stateless; `initialize` selects legacy semantics for the
   stdio process (negotiating 2025-11-25 or an earlier version the layer lists). A dual-era server serves both on one process,
   as the spec's compatibility matrix allows; `legacy: "reject"` answers `initialize` with an error naming the supported
   versions, as the spec says a modern-only server SHOULD.
2. Modern requests: validate the `_meta` protocol version, else `UnsupportedProtocolVersionError` (`-32022`, `data.supported`,
   `data.requested`); read `clientCapabilities` and `clientInfo` per request; answer `server/discover` (supported versions,
   capabilities, identity); put `resultType: "complete"` on every result and `serverInfo` in `_meta`; `tools/list` results carry
   `ttlMs` and `cacheScope` in a deterministic order; no `ping`, no `logging/setLevel`, no session state.
3. Legacy requests: `initialize` / `notifications/initialized`, `ping`, per-connection capabilities, results without
   `resultType`.
4. MRTR: a handler returning `inputRequired(...)` yields a modern `InputRequiredResult` (`resultType: "input_required"`). The
   layer refuses (as a handler error) one that names a request the client did not declare capability for (spec server rule 7)
   or carries neither `inputRequests` nor `requestState` (rule 6). On a legacy connection the layer performs the old
   server-to-client `elicitation/create` itself, awaits the reply and re-invokes the handler with `inputResponses`, so one
   handler serves both eras (the shim; a per-server option disables it). `requestState` is opaque to the layer, which offers
   `sealState(key, payload, { principal, ttlMs, requestDigest })` and `openState(...)` (HMAC-SHA-256 through the SDK's existing
   `./crypto` module, no new dependency) so a handler need not invent integrity protection; a failed open is a protocol
   error, never a partial result.
5. Errors follow the spec's allocation (`-32020..-32099` reserved for MCP, `-32000..-32019` implementation-defined, resource
   not found `-32602`). A thrown handler error becomes `isError: true` content with the message the handler chose and never a
   stack trace. Unknown methods return `-32601`.

**Conformance (AD6a).** A normative corpus under `docs/spec/mcp-server/v1/conformance/`, built from the published specification
and not from our implementation. (a) Vectors transcribed from the examples in the 2026-07-28 pages (the
`UnsupportedProtocolVersionError` example with `-32022` and `supported: ["2026-07-28","2025-11-25"]`, the MRTR
`InputRequiredResult` example and its retry, `server/discover`, the `_meta` request and result shapes, the rows of the
compatibility matrix) and from the 2025-11-25 pages (the `initialize` handshake, `tools/list`, `tools/call`,
`elicitation/create`). (b) The published `schema.json` of both revisions, vendored with provenance (URL, retrieval date,
SHA-256) and a hand-written structural checker limited to the messages the layer emits (required fields, `resultType`, error
code ranges), because the repo's dependency-free rule makes a general JSON Schema validator hand-written work; a dev-only script
re-fetches the schemas and reports a hash change, run by a maintainer and not by CI. The runner drives every vector as a CLIENT
against the server over in-memory NDJSON, in BOTH eras: each tool-level vector (list, call, elicit, error) runs once with a
modern opener and once with a legacy opener and the results must be equal after removing the era envelope (`resultType`,
`serverInfo`, `ttlMs`); era-specific vectors (discover, `-32022`, `initialize`, the stdio probe fallback) run in the era they
belong to. Negative vectors: a modern request with no protocol version or with an unsupported one; `inputRequests` for an
undeclared capability; a tampered `requestState`; a `requestState` presented to a request it was not issued for; an
`initialize` after a modern request on the same process (the process stays modern); a request before `initialize` in legacy.
The SDK repo's rule applies ("a new conformance corpus needs a `docs/conformance-coverage.json` entry for every binding"), so
Python and Go each record a reason they do not claim it (the layer concerns a TypeScript process: the gateway spawns Bun
connectors). A separate CI job, like the scaffold jobs, installs the real upstream `@modelcontextprotocol/sdk` 1.32.0 client
(and the v2 client once a stable one exists) and runs interop smoke tests against a server built on the layer (list, call,
elicitation through the legacy shim); it is the only place the upstream package is installed. The api-surface, stability and
coverage guards apply as for any entry point. Release: `feat(sdk): ...` through release-please (a minor), published to npm
before AD6b and AD6c start.

**AD6b design (this repo).** `packages/cli/src/mcp/adapter.ts` builds its server with `createMcpServer` and `serveStdio` from
the new entry point. The tool specs (`CAPTURE_TOOL_SPECS`, the agent tools, the read tools) keep their zod schemas, converted to
JSON Schema at registration by one helper, with a test that each converted schema equals a snapshot of what the upstream SDK
1.32.0 produced before the swap. Differences to handle: (a) in the modern era there is no `initialize`, so the label comes from
`ctx.clientInfo` on each request (`run(deps, args, clientLabel)` already takes a thunk), and on a legacy connection from
`initialize`; `--agent <kit>` overrides it (D-AD-13). (b) `session.declareKind {kind:"mcp"}` (`adapter.ts:263`) is per connection
to the gateway, not to the MCP client, and is unchanged. (c) `tools/list` is deterministic and carries `ttlMs: 0`, because
`captureToolsFor` decides the tool set from live gateway state and the owner can disable the door mid-session. (d) A gateway
that is down yields no write tools (unchanged: a write tool is never offered on a guess). (e) Nimbus's own MCP server never
returns `inputRequired`: it asks the agent's client for nothing mid-call (approval is on the owner's terminal, not through the
agent's client), which is the point of the queue. The existing adapter tests run unchanged against both eras.

**AD6c (nimbus-mcp-servers).** `shared/consent-kit.ts` asks write consent through `server.server.elicitInput` (`:116`) after
checking `getClientCapabilities().elicitation` (`:273`). On 2026-07-28 that server-initiated request is no longer supported
("Servers MUST send server-to-client requests using the MRTR pattern"). With the AD6a layer the consent kit becomes a handler
helper: the write tool returns `inputRequired` with an `ElicitRequest` for the confirmation and a sealed `requestState` binding
the tool name, a digest of the arguments, the principal and a short expiry; the retry re-opens the state, re-validates all
four and only then performs the write, and a changed argument digest re-asks. A server-side nonce makes the consent
single-use (the spec says the state alone does not guarantee that). Legacy connections get the old elicitation through the
layer's shim, so the tool code is written once. Scope: the standalone-mode path (a client talks to a connector directly, the
connector's own consent), independent of the gateway door. UNVERIFIED in this read: how the 94 connectors' standalone entry
point starts its server today; AD6c's first task maps it and either moves the shared entry helper onto the layer or states which
connectors keep the upstream server until a follow-up. Connectors the gateway spawns keep speaking to it as now, since the
gateway approves their writes itself.

### 7.2 The queue and one-step approval (AD2)

**Submit (agent side).** `propose_action { actionType, input, summary }` keeps its shape. `submitCapture` runs as today with
`classifyAction` replaced (AD3a; the legacy case of D-AD-15 until AD3b) by `agentOffered` and `modelWriteRefusal`; a refusal returns a fixed code and reason (the
existing `ERR_CAPTURE_*` family plus `ERR_AGENT_TOOL_SUSPENDED`). The tool result says: proposed `<id>`, NOT run, the owner
approves with `nimbus approvals <id>`, poll `capture_status`. The agent can see only `proposed`, `executing`, `executed` (+ the
`outcomeRef` link when the service returned one), `rejected`, `failed` (+ a fixed `errorCode`) and `expired`; never the payload
or the owner's typed text.

**Owner side.**

```
nimbus approvals                       # list: id, proposer (UNVERIFIED), action type, wave, age, expiry, escaped summary
nimbus approvals show <id>             # what the agent SENT, verbatim and escaped; says preview and before-state appear at approval
nimbus approvals <id>                  # approve: full prompt, answer or typed text, in one action
nimbus approvals <id> --decline        # reject (no dispatch)
nimbus approvals --decline-all-from <label>   # reject every waiting proposal with that declared label
```

`approvals.approve` is `acceptAction`'s eight steps with three changes. Step 2 requires a `cli` or `ui` connection (not
`unknown`). Step 4 re-runs `agentOffered` (enable, approved set, hash, policy, directory grants) and `modelWriteRefusal`.
Step 7's `ActDeps.execute` builds an `origin: "agent"` action with `proposer` from the stored row and runs it through
`buildAgentWriteExecutor` bound to the APPROVING client's consent channel. The executor then does, in its own fixed order,
what it does for the model: the before-state (<= 5 s, Wave 4 fail closed), the guard, `preflightPhase` and `preparePhase`
for a bound row, the confirm phase, and only then the owner's prompt. `consent.request` goes to the approving terminal. The
CLI refuses `approvals <id>` without an interactive TTY on stdin and stdout, and has no `--yes`.

A refusal at approval (a guard, an unreadable Wave 4 before-state, a prepare failure) finalizes the row as `rejected` with a
fixed `errorCode`, and tells the owner the reason; the agent sees only the code.

**Why a separate command from `captures`.** `captures list --kind action` shows the same rows, but without the proposer
block, the wave, or expiry order; `nimbus approvals` is the surface the docs point to, and `captures accept <id>` on an
action stays as an alias of the same RPC so there is one code path (D-AD-3).

**IPC.** `approvals.list`, `approvals.get`, `approvals.approve`, `approvals.decline`; none on the Tauri allowlist in this
phase (I7 unchanged). `"approvals"` is added to the LAN denylist beside `"capture"` and `"captures"`
(`ipc/lan-rpc.ts:239-241`), and a test enumerates every `approvals.*` method against `checkLanMethodAllowed`, because the
check is a denylist and a new namespace is reachable by default. No HTTP route (I13 unchanged).

**Wave 4.** `requestConfirmedApproval` is the only path (D41). The CLI's consent handler already collects typed text for a
confirm request; `approvals <id>` adds nothing that could echo it.

### 7.3 Eligibility, per-door lists and the hash (AD3a, AD3b)

**V97 (next free at merge).** `connector_write_door_approval(service TEXT, door TEXT, tool_id TEXT, approved_at INTEGER,
definition_sha256 TEXT NOT NULL, PRIMARY KEY (service, door, tool_id))`, with `door = 'agent'` (the model door keeps its V84
column; `door` is open for later doors). One writer, `connectors/connector-writes/door-approval-store.ts`; D49(b) pins that
the table identifier appears only there and in its DDL file (the D33(b) pattern). The shared wave enable (V83) stays one row
per service: `enable <svc> --door agent --wave N` creates or raises it, and `disable <svc>` removes both lists. Backfill:
none for the door table. The same migration adds `capture.legacy INTEGER NOT NULL DEFAULT 0` (written only by the capture
store, set only for a legacy proposal, D-AD-15). After upgrade the agent set is empty. In AD3a that means every existing
act-door use is a *legacy proposal*: still accepted, with the deprecation warning, counted (OR-AD-2 stands: the owner's
re-approval by name is what ends the warning; AD3b is when use without it stops). `status` says so once, with the exact
command.

**CLI.** `nimbus connector writes enable <svc> --door agent [--wave N] [--approve <pattern>...]` shows the enable prompt
listing ONLY rows `agentOffered` would accept, each with its wave and whether it needs a typed confirmation. A Wave 4 row
is listed only for `--wave 4` (OR-AD-7): `nimbus connector writes enable github --wave 4 --door agent` then the owner's
approval of each row by name, exactly the model door's flow, and the row still needs its typed confirmation and a readable
before-state at approval (a Wave 4 proposal whose before-state cannot be read is refused before any prompt,
`WAVE4_BEFORE_REFUSAL`). `status` gains an `agent` column per service, a `suspended` section (D-AD-9) and, in AD3a, a
`legacy` line (count of legacy proposals in the last 30 days by type, with the AD3b date once known). Rows withheld by
`MODEL_NEVER_OFFERED_REASONS` show their reason; the mail-send reason text becomes "mail sends are never offered to agents
or the model".

**Parity (row 1).** The agent door offers exactly the rows for which `isModelOfferableRow(row)` holds and the owner approved
the tool id for agents. AD3a asserts parity by test over every row: `agentOffered(e, row) <=> offeredUnder(e, row) &&
approvedForAgent(row)`. (`docs/roadmap.md` Phase 9.7 states the model is offered 108 of 124 rows, 16 never offered.) The
legacy case is outside this predicate and tested separately.

**Retired in AD3b.** The legacy case, `ACTION_PROPOSABILITY` for first-party types, the `not_yet_offered` class,
`actDoorRefusal` and `createActionDestinationRefusal` are deleted; the user-MCP branch of `classifyActionType` moves to AD5.
(`provenanceConsent` is already gone from AD1.) Nothing is left that can propose a write the model door could not.

**The new invariant (I5x).** "An outside agent's proposal dispatches only as an `origin: "agent"` action through the door
executor, for a service the owner enabled to that wave, for a row the owner approved for agents by name, whose current
definition hash equals the stored one, while policy allows both `mcp_action` and `connector_write_model_access`, never a row
in the never-offered set, re-derived at submit, at approval and before dispatch; a changed definition suspends the tool until
re-approved by name (static D49)." AD3a states one exception in the invariant's text, the way I2 states its own: "until
AD3b, a legacy proposal (D-AD-15) is accepted without the owner's approval by name, flagged, counted and warned"; AD3b
deletes that clause in the same commit that deletes the code (retire = delete). Wiring: `connectors/connector-writes/{agent-door,door-approval-store,definition-hash}.ts`,
`ipc/approvals-rpc.ts`, `engine/run-ask.ts`.

**Static D49.** (a) `buildAgentWriteExecutor` is named only in `engine/run-ask.ts` and its one wiring site; (b) the
`connector_write_door_approval` identifier appears only in its store and DDL; (c) the property `proposer:` is written only by
`ipc/approvals-rpc.ts`'s `ActDeps` (never from a payload, an IPC param or the capture gate) and `origin: "agent"` is
constructed only there; (d) the executor and `connectors/registry.ts` both call `isOutsideOrigin(`; (e) `approvals.approve`
calls `agentOffered(` before `buildAgentWriteExecutor(`. Textual, with the usual stated bound (D33(c)/D42): a dynamically
composed name evades the scan; the behavioural tests are authoritative. (f) in AD3a, the `legacy` flag is written only by
`submitCapture`'s legacy branch and read only by the status, approvals and prompt renderers; AD3b removes (f) with the branch.

### 7.4 Proof and audit (AD4)

- **Audit.** `auditPayload` already serialises the whole action (`executor.ts:828`; `auditedAction` keeps top-level
  `origin`). AD4 adds `proposer` to the kept fields, placed FIRST like the digests (the payload is size-capped):
  `{door:"agent", captureId, label (escaped, <= 80 chars), labelSource}`. The `capture.action.accept` and
  `capture.action.outcome` rows (`capture-act.ts`) already carry `captureId`, so the two chains join on it.
- **Egress.** The row hash covers `source_id` but not `payload_summary` (`egress-ledger.ts:29`), and `EGRESS_SOURCE_TYPES` is
  a closed set whose members each carry a coverage class and a history of rejected reuse; a new type for one actor is the
  wrong tool. Decision: keep `sourceType: "task"`, set `sourceId = "agent:" + captureId` for an agent action (the hash formula
  is unchanged, so every existing chain still verifies), and prefix `payload_summary` with `{door, label}` (best-effort, not
  hashed). The before-state reads of that action are separate `<service>.before.read` rows with the same `sourceId`.
- **Prove.** `nimbus prove --by-proposer` groups agent rows by the audit chain's hashed `proposer` (not the capture row,
  which `captures purge` can delete) and reports per label: proposed, approved, declined, executed, failed, expired and
  dispatches. Completeness check: the egress rows with `sourceId LIKE 'agent:%'` that are dispatches equal the audit
  dispatch rows with `proposer.door = "agent"`; a mismatch prints `indeterminate`, as `nimbus prove` does today. The audit
  views (`nimbus audit`) filter `--door agent` and `--proposer <label>`.
- **Bound.** Grouping is by an unverified label: two agents with one label are one group, and a forged label hides nothing the
  owner approved (the prompt showed it) but can make a report read as another agent.

### 7.5 User MCP servers through the door (AD5)

Today `mcp_<id>.<tool>` is proposable only for `--model` servers (`proposable-actions.ts:334-350`), shown as raw JSON.
**I42 is amended** ("every `mcp_*`/`ext_*` action requires HITL at the gate and is never delegable; `--model` tools are offered
to the local owner only"): an `mcp_*` action reaches an outside agent only for a server registered with a separate `--agent`
grant, for a tool the owner approved by name for agents, with its definition hash unchanged, and every call is an
`origin: "agent"` action approved on the owner's terminal. The `--model` and `--agent` grants are independent. Why separate:
`--model` means Nimbus's own model may call the tool on my turn; an outside agent is a different principal. The
`user_mcp_model_access` policy gates both (monotonic-stricter).

- **The per-call approval shows:** the server id and its sandbox grants (`--read`, `--net`, `--write` lines), the tool name,
  the server-supplied description in an unverified block (closer-escaped by `wrapToolDescription`), the input as verbatim
  pretty JSON (no template exists for a user-MCP type, so no preview can hide a field), the first 12 hex of the definition
  hash, and the proposer block. A user-MCP tool has no before-state, no wave and no confirm target; the prompt says "no
  before-state is available for a user MCP tool".
- **Definition hash:** over the server's `tools/list` entry for the tool, snapshotted at `enable --agent` and compared at
  submit, at approval and immediately before the call (same listing generation). A server that changes a tool between listing
  and call is caught only if the gateway's held listing differs from its re-read; a server that lies in both is not (§ 12).
  The sandbox (I15) and the per-call approval of the raw input are the controls for that.
- **User-MCP write grants (the carried-in row).** `connector add --mcp ... --write <dir>` (repeatable) adds
  `filesystem.write` entries to that server's sandbox policy, validated by the same canonical-directory rules as the iac
  workdir grants (a link, alias, filesystem root, home directory, drive root or Nimbus folder is refused), shown in the add
  prompt and in every per-call approval for that server, stored with the server row (no second table if the existing
  user-MCP row can carry it) and removed by `connector remove`. I15 gains: user-MCP write access is limited to
  owner-approved canonical directories. If review wants it separate it becomes AD5b.
- **Names.** `mcp_*` action types are resolved by `userMcpToolKeyForActionType` and checked by `userMcpToolSegmentOk`
  (`^[A-Za-z0-9_-]{1,64}$`); an agent cannot name a tool outside the owner's server list.

### 7.6 The kits (AD7)

`nimbus agent install <claude-code|codex|cursor|vscode> [--scope user|project] [--dry-run] [--yes]` and
`nimbus agent status [--json]`. Install prints the exact files and the diff it would write and writes only after a typed
`yes` (it edits another product's configuration; no silent writes). Status checks, for each installed agent: the MCP entry
exists and points at this machine's `nimbus`, the steering block is present and unmodified (a marker-delimited block carrying
a hash), the agent's version, and that the gateway answers `capture.status`; it reports `ok`, `drifted` or `missing`, and
never rewrites.

The server entry is the same everywhere: command `nimbus` (an absolute path when `nimbus` is not on `PATH`), args
`["mcp-server", "--stdio", "--agent", "<kit>"]` (D-AD-13). The steering differs per agent. "Steering" is guidance or a
best-effort policy in the agent's own harness; none of it is a security boundary, and each kit's page says so.

| Agent | MCP configuration (primary source) | Rules or hooks that can steer destructive commands | State of this evidence |
| --- | --- | --- | --- |
| Claude Code | `claude mcp add --scope user nimbus -- nimbus mcp-server --stdio --agent claude-code`. Local and user scope live in `~/.claude.json`; project scope in `.mcp.json` (`"mcpServers"`, no `type` = stdio) (<https://code.claude.com/docs/en/mcp>) | `PreToolUse` hooks in `~/.claude/settings.json`, `.claude/settings.json` or `.claude/settings.local.json`: a `Bash` matcher with an `if` pattern returns `permissionDecision` `deny` or `ask` with a reason (exit 2 also blocks); MCP tools match as `mcp__<server>__<tool>`. The page says the `if` field "is best-effort, so use the permission system, not a hook, for hard allow or deny enforcement" (<https://code.claude.com/docs/en/hooks>) | MCP and hooks read from the docs. The `permissions.deny` rule syntax: UNVERIFIED (that page was not read); AD7 verifies it before writing deny rules |
| Codex CLI | `codex mcp add nimbus -- nimbus mcp-server --stdio --agent codex` writes `[mcp_servers.nimbus]` into `~/.codex/config.toml`; a project `.codex/config.toml` applies only when the project is trusted; per-tool `tools.<tool>.approval_mode` exists (<https://learn.chatgpt.com/docs/extend/mcp>) | Rules: `~/.codex/rules/*.rules` (project `.codex/rules/` when trusted), Starlark `prefix_rule(pattern=[...], decision="forbidden"\|"prompt"\|"allow", justification=...)`, the most restrictive match wins; they govern commands run outside the sandbox; `&&`, `\|\|`, `;` and `\|` chains are split, a script with redirection, substitution or variables is evaluated whole; experimental. `AGENTS.md` carries instructions (<https://learn.chatgpt.com/docs/agent-configuration/rules>). A hooks page exists and was not read: UNVERIFIED | MCP and rules read from the docs |
| Cursor | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global): `{"mcpServers":{"nimbus":{"type":"stdio","command":"nimbus","args":[...]}}}`; Cursor asks approval per MCP tool by default; Enterprise has an admin MCP allowlist (<https://cursor.com/docs/context/mcp>) | Rules in `.cursor/rules/*.mdc` and `AGENTS.md` are context; the rules page itself says AI guidance should not be the only security control (<https://cursor.com/docs/context/rules>). The pages read mention no hook and no command denylist; whether Cursor has one is UNVERIFIED | MCP read from the docs. Enforcement: none found |
| VS Code (Copilot) | `.vscode/mcp.json` `{"servers":{"nimbus":{"type":"stdio","command":"nimbus","args":[...]}}}`, a user-profile `mcp.json`, and `code --add-mcp '{"name":"nimbus",...}'`. The reference calls these the Local harness, "deprecated and will be removed in February 2027", and says new Copilot setups should use "native destinations" without giving their paths: UNVERIFIED (<https://code.visualstudio.com/docs/agents/reference/mcp-configuration>) | `.github/copilot-instructions.md` and `AGENTS.md`; terminal auto-approval rules with "known limitations"; `preToolUse` hooks returning `allow`, `deny` or `ask`, "not a substitute for enforced permissions"; enterprise policy `ChatMCP` (<https://code.visualstudio.com/docs/copilot/security>). Hook file location: UNVERIFIED | MCP: the Local-harness path read; the native path not found |

What the kits steer: a small versioned table in the gateway maps destructive commands that have a door equivalent to the
door's action type (for example `gh pr merge` -> `github.pr.merge`, `terraform apply` -> `iac.terraform.apply`,
`kubectl apply|delete|scale|rollout restart` -> the Kubernetes rows, `aws lambda invoke`, `git push --force`, and the three
owner commands `nimbus approvals`, `nimbus connector writes` and `nimbus captures`, which an agent must not run). Claude Code
gets a hook `deny` with the reason "use Nimbus propose_action <type>"; Codex gets `forbidden` or `prompt` rules with the same
justification; Cursor and VS Code get an instructions block (and a hook where AD7 verifies one). The table is data, tested
for every entry against a real row; a command with no door equivalent is not listed. **Per OR-AD-6, every kit that can
express a deny rule for `nimbus approvals` writes it** (Claude Code: the hook `deny`, and a `permissions.deny` entry once its
syntax is verified; Codex: a `forbidden` `prefix_rule`; VS Code: a `preToolUse` hook once its location is verified); Cursor,
where no enforcement was found, gets the instruction text and `nimbus agent status` reports it as `guidance only`. The deny
covers `nimbus approvals` for every subcommand, so the agent cannot approve, decline or list.

**What each agent can still do outside the door** (stated on each kit's page and printed by `nimbus agent status`): run any
command its harness allows, with the credentials already on the machine (`gh`, `aws`, `kubectl`, cloud logins, SSH keys,
tokens in the environment), write files and reach the network. A rule matching a command prefix does not see a command inside
a script, another spelling, an alias or a language runtime's HTTP call. In particular an agent with a shell can run
`nimbus approvals <id>` itself and, until desktop approval ships, can still approve its own proposals (OR-AD-6; § 12). Every
kit's page opens its "outside the door" section with that sentence.

**Acceptance A6, and how it is verified.** At least two kits are verified against the REAL agent and the result is a
published matrix (docs page *Agent kits*, one row per kit: agent version, OS, MCP listed and callable, a proposal reaches the
queue, the hook or rule blocks the listed destructive command, `status` detects drift, date, who ran it). Procedure (manual,
by the owner, because it needs the agents' own accounts; recorded in the AD7 PR): in a scratch `HOME` and an empty git repo,
against a test gateway whose connector is the repo's mock MCP server (the e2e tree's pattern; no cloud call; never the owner's
real state): run `nimbus agent install <kit>`; start the agent headless (Claude Code `claude -p`, Codex `codex exec`) with a
fixed prompt asking it to (1) list the Nimbus tools, (2) propose a Slack post through `propose_action`, (3) run
`gh pr merge 1`. Assert from the gateway: one `proposed` row labelled with the kit and no dispatch. Assert from the transcript:
the merge was denied with the Nimbus reason. Then `nimbus approvals <id>` approves and the mock server sees the call. Claude
Code and Codex are the recommended two (both scriptable, both with documented enforcement); Cursor and VS Code are published as
"MCP verified, enforcement unverified or none" until someone runs them.

### 7.7 The Developer role pack (AD8)

A pack in the official registry (a separate repo; the role-pack mechanism, I47, is shipped). It is small: the brief agents a
developer's coding agent should reach through the read tools, as one layer of owner-editable defaults: `catchup`,
`preflight`, `pre-mortem`, `impact`, `ghost`, `why`, `changelog`, `ownership`; an `[agents]` default set naming them; and a
short `AGENTS.md` fragment telling the agent to call `describe_actions` before proposing. It holds no credentials, no write
enablement and no approval (a pack never grants a write; I47: the owner approves the exact defaults text). The registry CI
scores it with `nimbus eval` like any pack. Nothing in this repo beyond docs.

### 7.8 Bounds stated in the product (AD7, AD8)

One sentence set in one source file, rendered into the README paragraph, the security page and each kit page, with a test that
all of them contain it: "The agent door guards writes that pass through Nimbus. An agent that holds its own credentials, or
can run commands, can act without it. The ledger records the actions Nimbus dispatches, not network traffic. The proposer's
name is not verified. Until desktop approval ships, an agent that can run commands in your terminal can still approve its own
proposals." (OR-AD-6: the README and every kit state the last sentence plainly.) The README headline does not change before the
phase ships (§ Direction); the copy lands in the release that ships AD3a, and the headline waits for AD3b.

## 8. Later rows (not built here)

- **Desktop approvals** (after the signed desktop release, Reach). Needs `approvals.list` and `approvals.get` on the Tauri
  allowlist (`ALLOWED_METHODS`, I7, read-only), and `approvals.approve`/`decline` only with a NATIVE confirmation. Today
  `consent.respond` answers the renderer's own session, so a renderer that both calls `approvals.approve` and answers the
  resulting `consent.request` could self-approve after an XSS (the B1 chain C1 lesson in `nimbus-tauri-allowlist`). The Rust
  side must own the typed-confirmation dialog, or bind the answer to a user gesture the bridge verifies; Wave 4 stays typed.
- **ChatOps approvals.** Needs the D0c typed-confirmation card (Slack modal, Teams `Input.Text`) fed by a queue entry instead
  of an executor-held prompt, so the approval must start inside the gateway when the owner taps (a channel cannot hold the
  executor open); I20 extended so an `origin: "agent"` action is never delegated and only the resource owner's typed text
  approves; I23/I29 for the card and modal open (already ledgered); the same `agentOffered` re-derivation at tap time. A bound
  commit stays unapprovable in ChatOps (no channel to show the diff).
- **An authenticated client identity** (a signed client assertion) to replace the unverified label: not designed.

## 9. Security analysis (assume a malicious MCP client)

Invariant amendments (triple rule, in the slice that makes each true):
**I2/I3** unchanged in text (the new origin only removes delegation and adds a line; `type` alone decides HITL; the tool is the
routing table's). **I11** the results returned to the agent are `capture_status`'s fixed fields and `describe_actions`
(escaped; user-MCP descriptions closer-escaped). **I20** "origin model or agent". **I28** rewritten: the submit order uses
`agentOffered` and `modelWriteRefusal`, bound rows are proposable, `acceptAction` stays the only leaving point (called only
from `acceptCapture` and `approvals.approve`, D32(e)) and still imports no executor (D32(f)). **I29** door and proposer in both
ledgers (AD4). **I42** the `--agent` grant (AD5). **I53** the agent door as a second origin with a per-door list and hash
(`CONNECTOR_WRITE_OFFER_BY_KIND` is a model-turn concept and is unaffected). **I54** the proposer's input is never a bound
field (a caller-supplied bound field is still refused before any read). **I55** `origin: "agent"` is a negative control.
**I7** unchanged (nothing is added to the allowlist). New: I5x and D49.

| Attack | Control | Residual |
| --- | --- | --- |
| Proposal flooding | Global attempt window; durable hourly cap `maxActions` (50); `actionMaxPending`; NEW per-connection cap of 10; a refusal is cheap (no reads); a proposal nobody opens causes no connector read; count-only notification | An agent can fill its 10 slots and the hour's cap and make `approvals` noisy; the owner has `--decline-all-from <label>` |
| Forged client label | The label is never used for a decision; shown as UNVERIFIED with its source; stored hashed in the audit row | A forged label can make a report read as another agent (§ 7.4) |
| Input that picks a different tool or smuggles a confirm text | `actionType` is a closed key of the routing table; the dispatched action is `{type, payload:{mcpToolId: <gateway>, input}}`, so `mcpToolId`, `origin`, `proposer` or `confirm` inside `input` are data (I3); the gate and dispatcher refuse a tool named under another row's type (I53); the confirm text is computed by the executor from the row's `confirm` target and compared with what the owner TYPES (D41); a bound field in `input` is refused (I54) | None found; pin tests send each such key |
| TOCTOU, proposal to approval | Everything is re-derived at approval (`agentOffered`, hash, policy, grants, refusals, configured-ness) and the before-state is read then; CAS claim with expiry; the executor re-checks per phase | The window from the owner's "yes" to the connector call is the model door's stated bound |
| Stale before-state | Read at approval, never stored with the proposal; Wave 4 fails closed when unreadable; 5 s cap | A cold start may exceed 5 s and the write is refused (existing bound) |
| Polling another agent's ids | `capture.state` answers only for the submitting connection (D-AD-11); unguessable ids; `capture_status` returns state, expiry, link and code only | A restarted MCP server loses its own handle (the owner still sees the row) |
| Agent calls owner-only IPC | The adapter exposes only its tools; the NEW `approvals.*` methods need a declared `cli` or `ui` connection (`unknown` is refused there); the namespaces are LAN-forbidden | A process that opens the IPC socket and declares `cli` is the owner as far as the gateway can tell (the kind is the connection's claim, so `captures.*` still maps `unknown` to the owner role, D-AD-16); the same as `captures accept` today (§ 12) |
| Definition-hash bypass (a server changes tools between listing and call) | Hash checked at submit, at approval and immediately before dispatch within one `toolsEpoch`; first-party connectors are inside the signed binary and change only with a gateway release | A user-MCP server that returns the same listing and behaves differently at call time; controlled by the sandbox and the per-call approval of the raw input |
| Before-read as a probe | Reads run only when the owner opens a proposal, only the row's reader type, only a read of the SAME connector, ledgered, 5 s, shown to the owner only | The agent chooses the read's target (an id inside `input`) on a service the owner enabled; the model door has the same bound |
| Injection into the owner (escape sequences, fake prompt lines) | Every agent string passes `sanitisePreviewText` and `visibleLine`; the proposer block follows the verified preview; invisible and bidi characters are shown escaped | None found |
| Agent self-approval through its shell | TTY required, no `--yes`, kit deny rules for `nimbus approvals`, `connector writes`, `captures` | An agent that can allocate a pty can run `nimbus approvals <id>` and type the confirm text. Accepted by OR-AD-6; stated in the README and every kit |
| The agent holds its own credentials | Out of scope by construction | The headline bound (§ 12) |
| Downgrade through a legacy MCP client | Dual-era server; `describe_actions` and `propose_action` behave identically in both eras | A legacy `initialize` `clientInfo` is as unverified as before |
| `requestState` replay in AD6c | AEAD, principal, expiry and argument digest, per the spec's security section; a server nonce for single use | Single use rests on the consent kit's nonce, not on the state |

## 10. Testing and acceptance

Each slice also runs `bun run preflight:fast` and updates the five core docs and the CHANGELOG.

- **AD1.** Executor: for each of `{model, agent}` the same case table. Delegation is never consulted; the runner runs; a Wave 4
  row with no preview is refused (`WAVE4_BEFORE_REFUSAL`); the prompt carries the right `Requested by` line, and for the agent
  the unverified proposer block with an injected quote, newline, bidi character and astral character all escaped;
  `payload.origin` and `payload.proposer` are inert; `isOutsideOrigin` is the only reader (a source pin over the five old
  sites); the I55 negative control; a census that `provenanceConsent` and `actConsentDisplay` no longer exist; D40(b) and
  D39(e) fixtures with a red-proof of a second runner site.
- **AD2.** Real SQLite, a real gateway subprocess and the mock MCP server (the E2E tree: a gateway-spawning test belongs
  there). An MCP client proposes; `approvals` lists it; `approvals <id>` shows the same prompt text as the model door for the
  same input (rendered-text equality, A1); a Wave 4 row is denied for an empty, a wrong-case, a trimmed and an echo answer and
  approved only for the exact text (A2); proposal to dispatch is one owner action (A3); the same path with NO model configured
  (`[llm]` empty; the approvals module imports nothing from `llm/`; A4); `capture.state` from a second connection is
  `ERR_CAPTURE_NOT_FOUND`; the per-connection cap; the `unknown` kind is refused; every `approvals.*` method against
  `checkLanMethodAllowed`; no `--yes`; non-TTY refused.
- **AD3a.** The parity table test over every row; each refusal in `modelWriteRefusal` once through the agent door; a Wave 4
  row is offered only after `--wave 4 --door agent` and approval by name, and refused before any prompt when its before-state
  cannot be read (OR-AD-7); the V97 migration (fresh and upgrade; empty set after upgrade; `capture.legacy` default 0); the
  legacy cases: an unapproved tool and a mail send are still accepted, flagged, counted, with the deprecation line in the
  `propose_action` result, in `approvals` list and detail, in the prompt and in `status`, and still run through the one
  executor path; a never-offered non-mail row, a Wave 4 row, and a hash mismatch on an approved tool are NOT legacy cases and
  are refused; a tool whose listed description changes by one byte is suspended at submit, at approval and before dispatch,
  `status` lists it with both hash prefixes, and re-approval by name clears it; a policy lockoff of either capability empties
  the door (legacy included); D49 present and clean with a red-proof per clause.
- **AD3b.** The AD3a legacy tests invert: every former legacy case is refused with its fixed reason, mail sends with the
  never-offered reason; the legacy column's writer, `actDoorRefusal`, `createActionDestinationRefusal` and the table consult no
  longer exist (a census); the invariant's exception clause and D49(f) are gone; the PR title carries `!`.
- **AD4.** One audit row and one egress row per dispatch, both naming door and proposer, both chains verify with the
  unchanged formula; `prove --by-proposer` counts; the completeness mismatch prints `indeterminate`.
- **AD5.** A `--agent` user-MCP tool is proposed, approved and called; a `--model`-only server's tool is refused; a hash change
  suspends; the write-grant validator refuses a link, a root and a Nimbus folder; the prompt shows the grants.
- **AD6a.** In nimbus-sdk: the conformance corpus of § 7.1 run in both eras (equal results after removing the era envelope),
  the negative vectors, the `sealState`/`openState` round trip and tamper cases, the coverage-matrix entries for the other
  bindings, the api-surface and stability guards, and the upstream-client interop CI job; the release is published before
  AD6b and AD6c start.
- **AD6b.** In this repo, the adapter's existing tests run against both eras of the new layer; a scripted 2026-07-28 client
  (`server/discover`, then `tools/list` and `tools/call` with `_meta`) and a scripted 2025-11-25 client (`initialize`) against
  one process both list the same tools and both complete a `propose_action`; an unsupported version returns `-32022` with the
  supported list; the label comes from `ctx.clientInfo`, overridden by `--agent`; every converted JSON Schema equals the
  pre-swap snapshot; and `describe_actions` is identical in both eras.
- **AD6c.** In nimbus-mcp-servers: a write tool returns `input_required` with `requestState`; a tampered, expired or
  other-argument state is rejected; a legacy client gets the elicitation path; no consent means no write.
- **AD7.** `agent install` dry-run output is the exact write set (golden per kit); install is idempotent; drift detection; the
  steering table's every entry maps to a real row; the bounds sentence appears in the README, the security page and each kit
  page; the matrix PR records the real-agent runs of § 7.6.
- **Acceptance mapping:** A1 -> AD2; A2 -> AD2; A3 -> AD2; A4 -> AD2; A5 -> AD4; A6 -> AD7; A7 -> each slice's block in
  `security-invariants.test.ts`.

## 11. Release and compatibility

**AD3a, release N: not breaking.** Its PR is `feat(gateway):`. A user who changes nothing sees every previous act-door use
keep working, plus a deprecation warning in the `propose_action` result the agent reads, at the top of `nimbus approvals`, in
the approval prompt and in `nimbus connector writes status`, with the exact fix (`nimbus connector writes enable <svc> --door
agent`, then approve the rows by name) and a count of the proposals that would have been refused. The notes of release N lead
with the deprecation, name the mail sends, and say which release enforces if known. AD1 and AD2 are also non-breaking:
`origin: "agent"`, the proposer block and `approvals` add behaviour and `captures accept` on an action keeps working as an
alias.

**AD3b, release N+1 or later: breaking, and it carries the `!`.** By the repo's test ("what does an existing user have to
change to keep working?"), a user who ignored the warning must act: (1) the seven mail sends can no longer be proposed over
MCP; (2) every act-door proposal without an agent approval by name is refused. So the PR title is `feat(gateway)!:`, the PR
description has a `BREAKING CHANGE:` paragraph with those two points and the exact commands, `docs/CHANGELOG.md` and the
release notes lead with it, and the first run after upgrade prints a one-time notice from `status`. The owner's ruling
(OR-AD-9) postpones the major by one release; it does not avoid it, and it spends the major the repo's rule says is permanent.
AD3b does not merge until a release containing AD3a is published (D-AD-15), so no user meets the break without a prior
warning.

## 12. Stated bounds

- The door guards writes that pass through it. An agent with its own credentials, a shell or a network can act without it.
- The terminal approval is only as strong as the owner's terminal: a program that can open the IPC socket as the owner, or
  allocate a pty and run `nimbus approvals`, can approve. TTY-only, no `--yes`, the typed confirmation for Wave 4 and the
  kits' deny rules for `nimbus approvals` reduce accident, not malice (OR-AD-6). Until desktop approval ships, an agent with a
  shell can still approve its own proposals; the README and every kit say so. The structural fix is an approval surface the
  agent's process cannot reach (a desktop native dialog, ChatOps; § 8).
- The gateway IPC `kind` is the connection's own claim (`session.declareKind`), and `CAPTURE_ROLE_BY_KIND` maps `unknown` to
  the owner role (`capture-client-policy.ts:12-21`). A local process that can open the socket is therefore the owner for
  `captures.*`, and can declare `cli` for anything else. AD2 tightens only the NEW `approvals.*` methods (a declared `cli` or
  `ui` kind is required); it does not change the `captures.*` mapping, because that would break clients that never declare a
  kind (older CLI and editor-extension builds) and would stop no hostile process, for which declaring `cli` is free (D-AD-16).
  A stated bound, not a change.
- During the AD3a window, legacy act-door proposals (D-AD-15) bypass the owner's approval by name; they still need the owner's
  approval at the prompt. That window ends at AD3b.
- The proposer label is unverified in prompts, audit rows and reports.
- The definition hash covers the listed schema and description, not behaviour; a user-MCP server can change behaviour under
  one listing. First-party connectors are covered by the signed binary and the pin.
- The before-state is the connector's claim, read at approval time; the window to dispatch is the model door's.
- Steering rules are best-effort in every agent (prefix matching; scripts and aliases evade it). No Cursor enforcement was
  found in the documentation read. The VS Code native config path, Claude Code `permissions.deny` syntax and the Codex and
  VS Code hook locations are UNVERIFIED until AD7.
- The MCP facts in § 7.1 come from the published specification read on 2026-11-13. The in-house layer is checked against
  vectors transcribed from that specification and against the vendored schemas, not against a third party's reference
  implementation; the interop CI job covers the upstream 1.32.0 client only, so a later upstream client may differ. Upstream
  SDK v2's release status is UNVERIFIED and does not affect the plan.
- The layer implements stdio only and no sampling or roots; a client that requires either is not served.
- Textual static rules (D49) evade a dynamically composed name; the behavioural tests are authoritative.
- Live connector reply shapes are not verified against live accounts (as in Phase 9.7).

## Owner questions (resolved)

The four questions of revision 1 were answered by the owner on 2026-11-13. Each answer is a binding ruling in § 2; none is
open. No new owner question arose from the revision.

| Question (revision 1) | Ruling | Where it landed |
| --- | --- | --- |
| Q1. Can an agent with a shell approve its own proposal, and what do we accept? | OR-AD-6: accept the bound, add friction (TTY only, no `--yes`, typed confirm for Wave 4, kit deny rules for `nimbus approvals`, plain statements in the README and every kit). Related bound found while mapping (the IPC `kind` is the connection's claim; `unknown` maps to the owner role) is stated, and only the new `approvals.*` methods are tightened | § 7.2, § 7.6, § 7.8, § 12, D-AD-16 |
| Q2. Wave 4 for agents in the first release? | OR-AD-7: full parity; `--wave 4 --door agent`, approval by name, typed confirm and a readable before-state | § 7.3, AD3a |
| Q3. Which MCP SDK? | OR-AD-8: our own dual-era layer in `@nimbus-dev/sdk`, wire implemented in-house (the SDK is dependency-free), released, then consumed by the CLI and by `consent-kit.ts` | § 7.1, AD6a, AD6b, AD6c |
| Q4. The `!` and the major | OR-AD-9: one release of deprecation; AD3a non-breaking, AD3b `feat(gateway)!:` one release later or more | § 11, D-AD-15, AD3a, AD3b |

## Review log

