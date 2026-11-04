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
- Changing delegation for the existing doors. Today I20 honours a delegate for connector-write types on the MCP sink, workflow and ChatOps doors; that stays as it is. Only the new model door is never delegable (§ 5.2).

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
- **Doors that reach a write today:** the MCP sink's `acceptAction` (I28), ChatOps `runGatedWrite`,
  tribal capture (I25), workflows. The model is offered none (`engine/agent.ts` `toolsFor`).
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
- `HITL_REQUIRED_BACKING` gains each manifest action type by derivation, checked by a test that the
  frozen set contains every manifest type (the set itself stays a literal; I2 forbids a derived,
  mutable set).
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
  tools: a non-owner, federated, LAN or demo turn sees none. That executor is built WITHOUT the
  turn's delegation, so a model-initiated write always asks the local owner (I3 keeps the gate
  blind to the door, so the guarantee is the executor's construction, pinned by a test).
- **Tool list and schemas:** the door lists the enabled connectors' tools from their running mesh
  servers (`listTools`, cached per server process, as the user-MCP source does), keeps only
  manifest write rows, and rebuilds each input schema with `sanitiseUserMcpInputSchema`. The
  manifest's schema hash is a drift check, not the schema source.
- **Opt-in (my call):** off by default. The owner enables model writes per connector with
  `nimbus connector writes enable <service> [--wave <n>]` (and `disable`, `status`); an org-policy
  lockoff `connector_write_model_access` (I22, tighten-only) can forbid it. Wave 4 writes are never
  offered by default even when the connector is enabled; they need `--wave 4` explicitly.
- A call builds an `Action` with the manifest's action type and `payload.mcpToolId`, and goes
  through `ToolExecutor.gate()`: HITL prompt, audit row, egress row, dispatch through
  `invokeConnectorWrite`. The tool result returns to the model wrapped in `<tool_output>` (I11). A
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
- CLI: the consent handler renders the preview as aligned lines (cleaned of control and bidi
  characters) before the yes/no question. Desktop: a `ConnectorWritePreview` component in
  `StructuredPreview`.
- On the model door a write with no template is never offered (and refused if called). The other
  doors (MCP sink, ChatOps, tribal, workflows) show the typed preview when a template exists and
  today's prompt otherwise, so nothing that works today breaks. Templates arrive with each write's
  wave; a test requires one for every row a wave turns on. The ChatOps approval card keeps its
  current rendering (out of scope).

### 5.4 Before-state (Waves 2–4)

- A group file may declare `before: { tool, args(payload) → readArgs, select(reply) → fields }`,
  naming one of the connector's READ tools. When present, the gateway runs that read through the
  normal read path (ledgered as a read, I29) before the prompt and shows `before` beside the new
  values. A failed or slow read (5 s) shows `before: unavailable (<reason>)`; it never blocks the
  prompt.
- Wave 4 writes require a `before` (or a plan, for IaC): a Wave 4 row without one is refused at the
  gate.

### 5.5 Egress and federation

- A contract test iterates the manifest: for each write, a gated approval appends exactly one
  egress row before dispatch; a denial appends one `blocked` row; an append failure dispatches
  nothing.
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
  `ToolExecutor.gate()` with HITL, is never delegated, appends its egress row before dispatch, and
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
  preview (executor, CLI, desktop); A3 the per-write egress coverage test; A4 the model door, the
  owner-only no-delegation executor, the opt-in command, the policy lockoff, the injection suite and
  I53.
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

## 12. Left to the builder

- The generator's exact output shape and how it reads the package (static analysis of
  `registerWriteTool` calls versus importing the package in a script).
- Preview line formatting and the desktop component's layout.
- Mock-server fixtures per wave.
