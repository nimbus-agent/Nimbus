# Connector Write-Enablement (Phase 9.7, the first S4 project): design

**Status:** draft, 2026-11-04. Branch `dev/asaf/connector-writes-spec`; this file never lands on `main`.
**Slot:** Spine S4 (Autonomous Agent), opened by the owner on 2026-11-04.

## 1. Intent

Nimbus indexes ~90 services, but its model cannot change anything in them. The write tools mostly
exist already: `@nimbus-dev/connectors` 0.3.0 registers writes in 33 connectors, and the gateway
classifies 92 write tool ids. What is missing is the path from "the model decided to act" to "the
owner approved exactly this change" to "the change was made with the right credential and
recorded". Phase 9.7 builds that path once, then turns the roster's writes on through it in order of
blast radius. Phase 10 (standing approvals, scheduled writes) is the consumer.

## 2. Goals, non-goals, anti-goals

**Goals**
- One authoring contract for a connector write; adding a write is one declaration, not 7–9 edits.
- The conversational model can call first-party write tools; every call stops at the owner's HITL
  prompt.
- The prompt shows the exact change in a typed preview, the same in the CLI and the desktop.
- Every write is ledgered before dispatch and refused over federation, with a test per write.
- Waves 2–4 of the roadmap delivered end to end: productivity, code and change, infra and
  production writes.

**Non-goals**
- Standing approvals, auto-fire, scheduled writes, the taint barrier (Phase 10, owner ruling W3).
- New connectors. Mobile release writes (TestFlight, Firebase, Codemagic) need new connector tools
  in `nimbus-mcp-servers`; they are in scope only as that cross-repo work (§ 9).
- Changing delegation for the existing doors. Today the MCP sink's `acceptAction` passes no
  delegate (I28), ChatOps routes a write's approval to the policy-resolved resource owner as its
  delegate, and the ask executor (`run-ask.ts` `buildAskExecutor`) passes the turn's delegation. That
  stays as it is. Only the new model door is never delegable, and structurally so (§ 5.2).

**Anti-goals** (works, and is still a failure)
- A write that can run without the owner seeing what it will change.
- A model-visible write the owner did not opt into, or one a federated peer, a delegate, a LAN
  client, a demo gateway or a non-owner turn can reach.
- A preview that shows less than the payload that will be sent (the preview is derived from the
  payload, never written separately).
- An approval prompt that leaks a credential or a secret field.

## 3. Owner rulings (2026-11-04)

- **W1 Who writes:** the conversational model is offered first-party write tools; each call is
  HITL at the executor (I2), never delegable, ledgered first (I29), refused over federation. A new
  invariant (§ 8) covers the model door.
- **W2 Preview:** a typed preview (target, field changes, destination) in Wave 1, rendered in CLI
  and desktop; a real before/after is added per write in Waves 2–4 where the connector can read the
  current state.
- **W3 Taint:** the provenance tag and its invariant ship with Phase 10, not here (9.7 has no
  auto-fire).
- **W4 Breadth:** all four waves, one programme; Waves 3 and 4 each get a design round before their
  plans.

## 4. What exists (2026-11-04 research)

- **Classification:** 18 dispatchable `CONNECTOR_WRITES` rows (warehouse/BI 12, GitOps/ML 6), 70
  `MIGRATED_WRITE_TOOL_IDS` (write-ness only: no row, so the credential-aware write transport never
  routes them), 4 gate-confined ids (ChatOps posts, tribal KB append).
- **Coupling sites per new write:** the connector's `registerWriteTool`; `HITL_REQUIRED_BACKING`; a
  group SSoT or the migrated set; the hand-spelled D20 regex; `ACTION_PROPOSABILITY` (and
  `PROPOSABLE_WRITE_TOOLS`); group count tests; I26 doc lists.
- **Doors that reach a write today:** the MCP sink's `acceptAction` (I28, no delegate), ChatOps
  `runGatedWrite` (owner-as-delegate), tribal capture (I25, no delegate), workflows. The model is offered none (`engine/agent.ts` `toolsFor`).
- **Consent:** `formatConsentPrompt` = `Type:` + JSON of the redacted payload; the desktop's
  `StructuredPreview` falls back to key/value rows. No before/after anywhere. The connector kit's
  `capturePreState` runs after approval and only in standalone mode.
- **Egress:** the gate appends the row before dispatch; no test covers every write id; a federated
  write refusal writes an audit row but no egress row (the roadmap's acceptance criterion expects a
  `blocked` one).

## 5. Wave 1 — the write-authoring framework

### 5.1 One write manifest

- A generated module, `connectors/connector-write-manifest.generated.ts`, produced by a script from
  the installed `@nimbus-dev/connectors` package (the same pattern as
  `bundled-connector-registry.ts`), lists every registered write: `toolId`, `server`, `actionType`
  (from the connector's `mutates`), `recoverable`, the scope-target field, and the input schema
  hash. The gateway still imports nothing else from the package at runtime (I26 boundary).
- A hand-written `connectors/connector-writes/*.ts` file per service group carries what the
  package cannot know: the wave (2/3/4), the preview template (§ 5.3), whether the write is
  model-offerable (§ 5.2), and an optional before-state reader (§ 5.4).
- `CONNECTOR_WRITES`, `MIGRATED_WRITE_TOOL_IDS` and the group SSoTs are replaced by this one
  table. Each row records its `transport`, which stays what it is today (my call, after the builder
  check): `write` for the 18 rows that route through `invokeConnectorWrite`, `mesh` for the rest,
  which keep dispatching through the long-lived mesh. Moving a `mesh` row to `write` is per-row work
  in Waves 2-4, done only where a spawner and a service-scoped vault view exist (the Google and
  Microsoft bundles and the local connectors have neither today), and never silently switching a
  connector configured `credential = "team"` onto the team path. The gate-confined ChatOps and
  tribal sets stay separate (D17/D19 confine their literals); the table imports those sets, it
  never spells their ids.
- **Action types:** the gateway's existing action type wins over the connector's `mutates` string
  (it is the frozen-set entry, the I29 destination, the delegation scope and the audit history).
  The manifest records both; a test lists every mismatch, and 9.7 renames no type. Write ids with no
  frozen-set type today (e.g. `slack_message_post_dm`) and tools registered as reads that mutate
  (e.g. `gdrive_file_trash`) are classified in A1, each with a type added to the frozen set.
- **Mutating reads:** the generator sees `registerWriteTool` calls only, so a tool that mutates while
  registered as a read (`gdrive_file_trash` today) is invisible to it. A hand-written overlay,
  `connectors/connector-writes/mutating-reads.ts`, lists those ids; the generator merges it into the
  manifest, and a test asserts every overlay id is in the manifest and `isConnectorWriteToolId`
  returns true for it, so the federated refusal (I26) never loses one when the hand-kept
  `MIGRATED_WRITE_TOOL_IDS` is deleted.
- **Proposability:** every action type A1 adds to the frozen set is classified in
  `ACTION_PROPOSABILITY` in the same PR (`denied("unroutable", ...)` until a wave makes it
  proposable), because that table's totality test fails on an unclassified frozen-set type.
- `HITL_REQUIRED_BACKING` stays a hand-written literal in `engine/executor.ts` (I2 forbids a
  derived, mutable set). Each manifest action type is added to it by hand, and a test asserts the
  literal contains every manifest type.
- D20 is regenerated from the manifest instead of hand-spelled: the static rule confines write tool
  ids to the manifest and the transport sites.
- The sync test (`connector-write-sync.test.ts`) becomes: every installed `registerWriteTool`
  appears in the manifest, every manifest row has a group-file entry, and every group-file entry
  names a real tool. A connector-package bump that adds a write fails until it is classified.

### 5.2 The model door

- A new tool source, `engine/connector-write-agent-tools.ts`, offers the model one tool per
  model-offerable write, named `<server>__<tool>` within the 64-character model limit, with the
  description wrapped by `wrapToolDescription` and the input schema rebuilt from the structural
  allowlist (`sanitiseUserMcpInputSchema`, I11).
- It is offered only on the local owner's turn, through a per-request executor in the request
  context, exactly like the user-MCP source (`getAgentRequestUserMcpExecutor`). No executor, no
  tools: a non-owner, federated, LAN or demo turn sees none.
- **Never delegated, structurally (review fix):** construction alone is not enough, because the ask
  turn's one executor (`buildAskExecutor`) carries the turn's delegation. The door therefore builds
  each `PlannedAction` with a gateway-set top-level `origin: "model"` (never inside `payload`; the
  model's arguments live only under `payload.input`), and `ToolExecutor.tryDelegatedApproval`
  returns `"fallback"` for it, beside the existing `registry.add` / `pack.install` / `extension.*`
  exemption. `origin` only removes delegation; whether HITL is required is still decided by
  `action.type` alone (I3). The door's executor is also built with `delegation: undefined`, and a
  test proves both: with an active in-scope delegate, a model-origin write still prompts the local
  owner, on either executor.
- **Tool list and schemas:** the door lists the enabled connectors' tools from their running mesh
  servers (`listTools`, cached per server process, as the user-MCP source does), keeps only
  manifest write rows, and rebuilds each input schema with `sanitiseUserMcpInputSchema`. The
  manifest's schema hash is a drift check, not the schema source: when a running server's schema
  hash differs from the manifest's, that tool is not offered (one warning per server process), and
  `nimbus connector writes status` names it until the manifest is regenerated.
- **Opt-in (my call):** off by default. The owner enables model writes per connector with
  `nimbus connector writes enable <service> [--wave <n>]` (and `disable`, `status`); an org-policy
  lockoff `connector_write_model_access` (I22, tighten-only) can forbid it.
  - Storage: a new SQLite table `connector_write_enablement(service PRIMARY KEY, max_wave,
    enabled_at)`, the same shape as the user-MCP `--model` flag (a row, not `nimbus.toml`, so the
    layered config reader D35 is untouched and no profile can turn it on).
  - `--wave` sets `max_wave`; omitted, it is 3. Wave 4 needs `--wave 4` explicitly.
  - `enable` is an owner HITL type (`connector.writes.enable`, frozen set, gate-only executor) on an
    IPC method that is not renderer-exposed (I7) and refused on LAN; `disable` needs no approval.
  - Every call re-reads the row, the policy lockoff and the row's wave at execute time, not only
    when the tool list was built, so a `disable` mid-turn stops the next call.
- A call builds a `PlannedAction` with the manifest's action type, `origin: "model"` and
  `payload: { mcpToolId, input }`, and calls `ToolExecutor.execute()`, which runs `gate()` (HITL
  prompt, audit row, egress row) and then `connectors.dispatch`. The dispatcher routes by the
  manifest row's `transport`: `write` through `invokeConnectorWrite`, `mesh` through the mesh
  client under the row's `<server>_<tool>` key (the mesh lists first-party tools under that key; a
  bare tool id is "Tool not found"). The door never calls a transport itself. The tool result returns to the model wrapped in `<tool_output>` (I11). A
  denial returns a fixed "the owner declined" result, never the payload.
- Prompt injection: the envelope note already tells the model tool output is data; this project
  adds a suite of injection fixtures (an indexed item, a tool reply and a federated answer each
  instructing a write) that must each end at the HITL prompt and never at a dispatch.

### 5.3 The typed preview

- Each manifest row has a preview template: `target` (a field path or a short template over the
  payload, e.g. `"{repo}#{number}"`), `summary` (one line), `fields` (the payload fields to show,
  in order, each with a label and a kind: text, markdown, list, diff, secret), and `destination`
  (the service and account the credential belongs to).
- The executor builds a `ConnectorWritePreview` `{ kind: "connector-write", service, actionType,
  target, summary, fields[], destination, before? }` and sends it as the consent details. Paths are
  relative to the tool INPUT (`payload.input` on the model door, the args object on the other
  doors, normalised once). The preview is NOT passed through the `SENSITIVE_PAYLOAD_KEY` substring
  redaction, for the reason I42 gives: an injected model can move content under a key like
  `issueKey` and the owner would approve `[REDACTED]`. Only fields the template marks `secret` are
  masked (my call). Credentials never travel in the payload, so none can appear.
- A field the template names but the input lacks shows `(not set)`. Every top-level input key the
  template does not name is listed under `Other fields`, its value as compact JSON cut at 2,000
  characters with a marker, so the preview never shows less than will be sent. Routing keys the
  executor adds (`mcpToolId`, `requestedBy`) are not part of the input and are not shown.
- Every string the preview carries (`target`, `summary`, each field value, `Other fields`) is
  model-controlled. The gateway strips C0/C1 control characters, ANSI escapes and bidi overrides
  from each one when it builds the preview, and the CLI renders each value on its own labelled line
  so a value cannot forge a line of the prompt (a newline inside a value is shown as `\n`).
- CLI: the consent handler renders the preview as aligned lines before the yes/no question.
  Desktop: a `ConnectorWritePreview` component in `StructuredPreview`; a `markdown` field renders
  with raw HTML disabled, no remote images, and links shown as text, never followed.
- `destination` is the service id plus the credential kind (`personal` or `team`) and, where the
  Vault holds one for that service, its stored account label; it never needs a credential read
  beyond the existing configured-check.
- On the model door a write with no template is never offered (and refused if called). The other
  doors (MCP sink, ChatOps, tribal, workflows) show the typed preview when a template exists and
  today's prompt otherwise, so nothing that works today breaks. Templates arrive with each write's
  wave; a test requires one for every row a wave turns on. The ChatOps approval card keeps its
  current rendering (out of scope).

### 5.4 Before-state (Waves 2–4)

- A group file may declare `before: { tool, args(payload) → readArgs, select(reply) → fields }`,
  naming one of the connector's READ tools. When present, the gateway runs that read as a
  `PlannedAction` through the same executor's `execute()` before the prompt, so the dispatch
  chokepoint appends its `authorized` egress row first (I29; a read type needs no HITL). `args` may
  use only the row's target-identifying fields, the read runs only for a row the owner enabled, and
  its reply feeds the preview alone: it is never returned to the model. A failed or slow read (5 s)
  shows `before: unavailable (<reason>)`; it never blocks the prompt.
- Wave 4 writes require a `before` (or a plan, for IaC): a Wave 4 row without one is refused at the
  gate.

### 5.5 Egress and federation

- A contract test iterates the manifest: for each write, `ToolExecutor.execute()` with a recording
  dispatcher and a real egress sink shows that an approval appends exactly one row before dispatch,
  a denial appends one `blocked` row, and an append failure dispatches nothing. It needs no model
  door and no live transport, so it ships on its own.
- The federated refusal of a write stays an audit row only, with no egress row (my call, reversing
  the first draft): I29 records only real egress, a peer's refused request never leaves the
  machine, and a ledger row per refusal would let a peer inflate `nimbus prove` counts. The
  roadmap's acceptance criterion is reworded to "no dispatch, and a `write_forbidden` audit row".

## 6. Wave 2 — productivity writes

Turn on, with templates, injection fixtures and an e2e test against the connector's mock server:
Gmail/Outlook draft create; GitHub/GitLab issue and PR comment; Jira/Linear comment; Jira/Linear
issue create and status transition; GitHub/GitLab issue create and label/assign; Notion/Confluence
page append (composing with I25: the model door never targets the tribal KB destination, which stays
behind its own gate); Slack/Teams/Discord post (the existing `*.message.post` types, folded in).
Before-state where cheap: issue status and labels, page current tail.

## 7. Waves 3 and 4

- **Wave 3 — code and change:** VCS branch create, commit, PR create/update (preview shows the diff
  and target branch, before = the branch head); PagerDuty/OpsGenie acknowledge and resolve; feature
  flag toggle and rollout (shared with Phase 7 Wave 3's flag surface, built once here).
- **Wave 4 — infra and production:** Kubernetes apply, Terraform plan then apply (preview = the
  plan), Vercel/Netlify deploy, CI pipeline triggers, mobile release writes (cross-repo, § 9), the
  existing warehouse and ML writes moved under the contract. Preview-mandatory with a before or
  plan; never offered to the model unless enabled with `--wave 4`; excluded from Phase 10 auto-fire
  by default.
- Each of Waves 3 and 4 starts with a short design round (an addendum to this spec) settling, per
  write, the preview, the before-state read and any extra confirmation (e.g. typing the target name
  for a destructive Wave 4 write).

## 8. Invariants

- **I53 (new):** a first-party connector write reaches the model only as a tool offered on the
  local owner's turn for a connector the owner enabled (and policy allows); every call goes through
  `ToolExecutor.execute()` with HITL, carries `origin: "model"` so no delegate can approve it, appends its egress row before dispatch, and
  shows a preview derived from the payload it will send; no other door offers it to a model. Static
  rule: the model tool source is the only file that builds model tools from the write manifest.
- **I26 amended:** writes are declared in the one manifest; D20 derived from it.
- **I29:** unchanged; the per-write coverage test (§ 5.5) extends its tests.
- **I2:** unchanged in kind; the frozen set gains the manifest types (a test proves coverage).
Each lands under the triple rule in the PR that wires it.

## 9. Cross-repo work

- `nimbus-mcp-servers`: any Wave 2–4 write whose connector tool is missing, wrong or lacks a
  `mutates` type is fixed there first (one connectors release per wave at most), then the gateway
  pin moves. Mobile release writes are new tools there.
- The connector kit's `capturePreState` stays the standalone-mode audit; the gateway's before-state
  read (§ 5.4) is separate and runs before the prompt.

## 10. Delivery

One PR at a time from `main`, a plan per PR on this branch reviewed by Antigravity:
- **Project A (Wave 1):** A1 the manifest generator, group files, the `transport` field, the
  classification of unclassified writes, and the derived D20 (no behaviour change); A2 the typed
  preview (executor, CLI, desktop); A3 the per-write egress coverage test; A4 the opt-in command,
  the `connector_write_enablement` table, the `connector.writes.enable` approval and the policy
  lockoff (nothing reads them yet but `status`); A5 the model door, `origin: "model"` and its
  delegation refusal, the injection suite and I53.
- **Project B (Wave 2):** B1 messaging and comments; B2 issues (create, transition, label/assign);
  B3 drafts and knowledge append; before-state readers where cheap.
- **Project C (Wave 3)** and **Project D (Wave 4):** design round, then PRs per write group.
- The roadmap's Phase 9.7 rows are ticked as each ships; the stale "only a handful can write"
  sentence is corrected in A1.

## 11. Open questions for the owner

None. The builder check (2026-11-04) raised nine points; all are settled above within rulings
W1-W4: delegation is refused on the model door only; the preview is unredacted except `secret`
fields; rows keep their transport; templates gate only the model door; schemas come from the running
mesh; the gateway's action type wins; the federated refusal stays audit-only; preview paths are
relative to the tool input; D20's allowed sites follow from A1.

The Antigravity review (2026-11-04) raised fifteen points. Applied: structural non-delegation
(`origin: "model"`); the mutating-read overlay; dispatch through `execute()` by `transport`; the
before-state read through the executor chokepoint and never shown to the model; the proposability
classification in A1; preview sanitisation and safe markdown; the corrected per-door delegation
facts; opt-in storage, default wave and per-call re-check; drift semantics; `destination`; the A4/A5
split. Not applied: substring redaction of `Other fields` (it reopens the hole § 5.3 closes;
credentials never travel in the payload), and an egress row for a federated refusal (kept
audit-only, the call listed for the owner).

## 12. Left to the builder

- The generator's exact output shape and how it reads the package (static analysis of
  `registerWriteTool` calls versus importing the package in a script).
- Preview line formatting and the desktop component's layout.
- Mock-server fixtures per wave.

## 13. Addendum (2026-11-05, before A5): rulings from the A5 research

- **Drift is structural, not a hash.** The generated manifest comes from a static scan and can hold no schema hash. The model door offers a tool only when every preview-template key (and every `whenUnset` field key) is a property of the input schema the running server lists; otherwise it is not offered, with one warning per server process (`getToolsEpoch`), and `nimbus connector writes status` names it.
- **The § 5.4 Wave-4 rule binds the model door only.** A Wave-4 row is offered to the model only with a `before` reader (or a plan); the existing doors (ChatOps, IPC, workflows) keep today's behaviour for those rows. Today all 18 templated rows are Wave 4 with no `before`, so after A5 the model is offered no write in production until Project B templates Wave 2 rows; A5 is proven with test fixtures.
- **Offerable vs covered.** `status` and the enable prompt distinguish the writes an opt-in covers from those offerable now (templated, and Wave < 4 or with a `before`).
- **Team-credential connectors are not listed** in A5 (they have no personal mesh process to list from); stated bound, revisited in Project B.
- **Demo turns are excluded** explicitly (`isDemo`), since the user-MCP precedent does not exclude them.
- **`payload.mcpToolId` is the listed key** `<service>_<toolId>`; the door asserts it equals `mcpClientToolKey(serviceOf(row.actionType), row.toolId)`.
- **Delivery:** A5 splits into A5a (plumbing with no model exposure: `PlannedAction.origin` and its delegation refusal, the consent line, the preview's credential kind, a raw per-server mesh listing, share-replay write refusal, offerable counts) and A5b (the door, its request-context executor without delegation, the injection suite, I53 and static rule D39).

## 14. Project B (Wave 2) design addendum (2026-11-05)

Research (read-only, 2026-11-05) against `@nimbus-dev/connectors` 0.3.0 and the gateway after A5b, plus the owner's rulings of the same day.

**Owner rulings.**
- **Re-consent.** An opt-in records exactly which writes the owner approved (the offerable set shown in the `connector.writes.enable` prompt). A write that becomes offerable later (a new template or `before`) is not offered until the owner re-runs `enable` and approves the new list; `status` shows `N new writes awaiting approval`.
- **ChatOps loop.** The model door refuses a Slack or Teams post whose channel is one ChatOps listens on (a model post goes out with the owner's own token, and ChatOps would read it as the owner's command).
- **Knowledge-base guard (I25).** The door refuses a Notion or Confluence page write whose target is exactly the configured tribal KB database, parent page, or space and parent page. No ancestry read.
- **Scope.** Beyond § 6, Project B templates: Notion page create/update/comment, Confluence page create/comment, Jira issue update, Teams chat post, Slack DM; Outlook and Apple calendar event create (they send invitations: the preview names the attendees explicitly); Google Drive file create; Obsidian daily-note append (its sandbox grant is widened to write inside the configured vault paths, an owner-approved widening); Discord post as the bot (a new tool; the preview says it posts as the bot).

**What the code needs first (B0, no row turned on).**
- Per-service listing and generation: `FIRST_PARTY_LISTING` becomes a map from each wave-2 service to its own mesh slot, credential check and ensure function (the predicates already in `lazy-mesh/credential-orchestration.ts`, extracted once); `toolsGenerationFor(service)` reads that slot's generation.
- The before-state reader (§ 5.4), door-only: a `BeforeStateReader { tool, argKeys, args(input), select(reply) }` on the row; the door's executor runs it after delegation falls back and before the prompt, as a `<service>.before.read` action through `gate()` (audit and egress rows land) and then dispatch, raced against 5 s; the reply is sanitised into the preview's `before` and never returned to the model. The dispatcher refuses a `*.before.read` action whose resolved tool is not a read (`isReadOnlyToolId` and not `isConnectorWriteToolId`); a static rule (D40) confines the `.before.read` literal. Other doors run no before-read.
- The MCP sink's act door shows the typed preview (`ipc/capture-rpc.ts`: provenance header plus the preview), replacing the A2 tripwire with a positive test: 23 of the 24 wave-2 rows are proposable.
- Re-consent storage: the opt-in row records the approved tool ids; the door offers only rows in that set; `status` and the enable prompt name the difference.
- Door refusals for the ChatOps-channel and KB-target rulings.

**Cross-repo (nimbus-mcp-servers, one release, owner-authorised PRs with auto-merge):** GitHub issue/PR comment, issue update (labels, assignees, state) and a `GITHUB_API_BASE_URL` override; GitLab issue create, issue note, MR note, issue update; Jira issue transition and a transitions list; Outlook draft create; Discord message post (bot); Confluence page append. Each new write then needs its row, frozen-set type, proposability class and template.

**Spec corrections.** Discord has no `*.message.post` type today (it is a new tool). "Page current tail" is cheap for Confluence (one `confluence_page_get`) but not for Notion (children are paged from the front; Notion's before shows at most the first blocks). Most connector hosts are hard-coded, so an end-to-end test against a fake server is possible only for hosts that are configurable (Jira, Confluence, GitLab); the others are proven in-process. § 5.3's `diff` kind remains unbuilt; Confluence append avoids needing it.

**Delivery.** B0 framework (above); B-X the nimbus-mcp-servers tools and release, then the pin bump with rows; B1 messaging and comments; B2 issues (create, update, transition, label/assign); B3 drafts, pages and knowledge append; B4 calendar, Drive, Obsidian, Discord. Each B PR adds its templates, before-readers where cheap, injection fixtures, and (for Jira/Confluence/GitLab) an end-to-end test against a fake server.
