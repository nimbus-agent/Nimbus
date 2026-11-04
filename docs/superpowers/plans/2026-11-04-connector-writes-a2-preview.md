# Connector Writes A2: Typed Write Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a connector write has a preview template, the owner's consent prompt shows a typed preview instead of today's `Details: {json}` line. The preview is built from the exact tool input that will be dispatched, and it is the same in the CLI and the desktop. The first templates go on the 18 `write`-transport rows.

**Architecture:**
- A pure builder, `connectors/connector-writes/preview.ts`, turns a `PlannedAction` into a `ConnectorWritePreview`. It finds the action's write row, reads the row's template, and fills it from the normalised tool input. It returns `undefined` when there is no matching row or no template.
- The executor's display seam, `consentDisplayPayload` and `formatConsentPrompt` in `engine/executor.ts`, uses the preview when one exists:
  - the prompt text gets aligned, sanitised lines, which is what the CLI prints;
  - the consent `details` become the preview object, which the desktop renders with a new `ConnectorWritePreview` component.
- Audit rows, egress rows, HITL decisions and dispatch are untouched.

**Tech Stack:** Bun, TypeScript strict, `bun:test` for the gateway, React and vitest for `packages/ui`.

**Spec:** `docs/superpowers/specs/2026-11-04-connector-writes-design.md` (branch `dev/asaf/connector-writes-spec`), § 5.3 and § 10 (A2).

## Global Constraints

- Branch from `origin/main`. This plan and the spec never land on `main`.
- **Display only.** Whether HITL is required is still decided by `action.type` alone (I3). The preview's row lookup may read `payload.mcpToolId`, because it only decides what to SHOW. `auditPayload` and `redactAuditPayload` stay exactly as they are, so the audit row is still redacted. No change to egress, delegation, policy or dispatch.
- **Not redacted, except `secret` fields** (spec § 5.3, the I42 reasoning). The preview never passes through `redactPayloadForConsentDisplay`. Only fields the template marks `kind: "secret"` are masked, shown as `(hidden, N characters)`. The consent request is unicast to the asking client (`ipc/consent.ts`), so nothing is broadcast.
- **The preview never shows less than will be sent.** Every top-level input key the template does not name is listed under `Other fields`. Routing keys are not part of the input and are not shown: the normalised input excludes `mcpToolId`, exactly as `extractToolInput` does.
- **Sanitising.** Every string in the preview is model- or caller-controlled, including input KEYS. The builder removes:
  - every ESC (U+001B), unconditionally, so no CSI, OSC (titles, hyperlinks, clipboard), DCS or two-byte escape (RIS, reverse line feed, cursor save) survives;
  - C0 controls other than `\n` and `\t`;
  - DEL and the C1 range U+007F–U+009F;
  - U+2028 and U+2029;
  - bidi embeddings, overrides and isolates (U+202A–U+202E, U+2066–U+2069).

  In the CLI text, every interpolated string (`target`, `summary`, each field label and value, each `Other fields` key and value) renders a newline as the two characters `\n` and a tab as `\t`, so no input can forge a prompt line. The CLI text is one physical line per preview line, always.
- **Value rendering.** A string is shown as is (after sanitising). Any other value is shown as compact `JSON.stringify` output. **Nothing is truncated** (review fix, stricter than the spec's 2,000-character cap): a value cut before display could hide input past the cut that is still dispatched. The CLI prints the whole value. The desktop collapses a value over 2,000 characters behind a "Show full" toggle, as `ScalarValue` in `StructuredPreview.tsx` already does, and says how long it is.
- **No template, no change.** An action with no matching row or no template keeps today's prompt and details, byte for byte. The existing executor tests prove this, and they must stay unedited.
- **A payload can never pose as a preview.** `details.kind === "connector-write"` must mean the gateway built it. `consentDisplayPayload` therefore wraps any OTHER display record whose top-level `kind` is `"connector-write"` (a user-MCP payload is shown verbatim, I42) as `{ payload: <record> }`. The desktop also requires `details.actionType === action` before it renders the typed preview, as a second check.
- **Row and type must agree.** If `payload.mcpToolId` names a row whose `actionType` is not `action.type`, there is no typed preview. The owner sees today's prompt rather than a preview of a different write.
- No comparator-less `.sort()`. No `any`.
- Before every push, run `bun run preflight:fast`, `bun run typecheck:tests` and `bun test packages/cli --parallel` once. The 11 TUI Yoga failures there are pre-existing. Also run `cd packages/ui && bunx vitest run test/components/hitl`.
- Do not compile the gateway. Never run a broad `docker kill`.
- Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JmSjrEwpdoFU8rCxeon9x9`.

## Rulings this plan makes (beyond the spec)

- **P1: `destination` is the service id only in A2.** The spec's credential kind and account label need a config and Vault dependency that the executor does not have. The model door, A5, adds that dependency and fills `destination.credential`. A2 types the field as optional and never sets it.
- **P2: `markdown` fields render as plain text in A2**, in both the CLI and the desktop. That meets "no raw HTML, no remote images, links not followed" by construction. A real markdown renderer can come with Wave 2, once a write needs it.
- **P3: There is no `diff` kind yet.** It arrives with the Wave 3 design round.
- **P4: Templates live on the row,** added with a `withPreview(row, template)` helper, so `row()`'s signature does not change.
- **P5: The first templates are the 18 `write` rows.** They have the simplest inputs, and today they reach the owner through ChatOps and the IPC doors with a raw JSON prompt. No row in `PROPOSABLE_WRITE_TOOLS` gets a template in A2. The MCP sink replaces the executor's prompt with its own provenance prompt (`ipc/capture-rpc.ts` `provenanceConsent`), so a tripwire test fails the day a proposable row gains a template, telling that author to extend `provenanceConsent`.
- **P6: `extractToolInput` moves to a pure module.** It moves to `engine/tool-input.ts`. `connectors/registry.ts` both imports it (its dispatcher calls it) and re-exports it: `import { extractToolInput } from "../engine/tool-input.ts";` plus `export { extractToolInput };`.
- **P7: Unset optional fields show their real default.** A template field may set `whenUnset`, the text shown when the input omits the key, e.g. `(not set: defaults to true, archives the current Production version)`. Without `whenUnset` it shows `(not set)`. The builder checks presence with `Object.hasOwn`, never `input[key]`, so `{toString}` reads as absent.
- **P8: Template keys never repeat under `Other fields`.** A key is "named by the template" when it is a `fields[].key` OR a `{key}` placeholder in `target` or `summary` (`/\{([A-Za-z0-9_]+)\}/g`); only the rest go under `Other fields`.
- **P9: The desktop heading is fixed text.** For a typed preview, `HitlPopupPage`'s heading is "Approve this connector write?" rather than the multi-line prompt; the component below shows the details.

## Review Focus

1. **A model hides text under a key like `issueKey`, `author` or `apiKeyHint`.** The preview shows it in full, because only template `secret` fields are masked. Task 1 pins this.
2. **A value carries `\x1b[2K\rApproved: yes`, or a U+202E override.** The CLI text shows no escape, no carriage return and no bidi character, and the value stays on its own line. Task 1 pins this.
3. **An input key the template does not name**, such as an extra `force: true`, appears under `Other fields`. Task 1 pins this.
4. **`mcpToolId` names a different write than `action.type`.** The prompt is today's, not a typed preview. Task 1 pins this.
5. **The audit row for a templated action** is still redacted. Task 3 pins it with an `apiToken` input key.

---

### Task 1: The pure preview builder

**Files:**
- Create: `packages/gateway/src/engine/tool-input.ts` (move `extractToolInput` here)
- Modify: `packages/gateway/src/connectors/registry.ts`. Replace the function body with `export { extractToolInput } from "../engine/tool-input.ts";`, and keep every existing import of it working.
- Modify: `packages/gateway/src/connectors/connector-writes/types.ts`, adding the template types, the optional `preview` field on `ConnectorWriteRow`, and `withPreview`
- Create: `packages/gateway/src/connectors/connector-writes/preview.ts`
- Test: `packages/gateway/src/connectors/connector-writes/preview.test.ts`, `packages/gateway/src/engine/tool-input.test.ts`

**Interfaces:**
- Produces, in `types.ts`:
  ```ts
  export type PreviewFieldKind = "text" | "markdown" | "list" | "secret";
  export interface PreviewFieldTemplate { readonly key: string; readonly label: string; readonly kind: PreviewFieldKind; readonly whenUnset?: string }
  export interface ConnectorWritePreviewTemplate {
    /** `{key}` placeholders over top-level input keys, e.g. "{namespace}/{name}". */
    readonly target: string;
    readonly summary: string;
    readonly fields: readonly PreviewFieldTemplate[];
  }
  // ConnectorWriteRow gains: readonly preview?: ConnectorWritePreviewTemplate;
  export function withPreview(r: ConnectorWriteRow, preview: ConnectorWritePreviewTemplate): ConnectorWriteRow; // frozen copy
  ```
- Produces, in `preview.ts`:
  ```ts
  export interface ConnectorWritePreviewField { readonly label: string; readonly kind: PreviewFieldKind; readonly value: string }
  export interface ConnectorWritePreview {
    readonly kind: "connector-write";
    readonly service: string;
    readonly actionType: string;
    readonly toolId: string;
    readonly target: string;
    readonly summary: string;
    readonly fields: readonly ConnectorWritePreviewField[];
    readonly otherFields: readonly { readonly key: string; readonly value: string }[];
    readonly destination: { readonly service: string; readonly credential?: "personal" | "team" };
  }
  export function buildConnectorWritePreview(action: PlannedAction): ConnectorWritePreview | undefined;
  export function renderConnectorWritePreviewLines(p: ConnectorWritePreview): string[]; // CLI text lines
  /** The desktop collapses a value longer than this behind "Show full"; nothing is ever cut. */
  export const PREVIEW_COLLAPSE_AT = 2000;
  ```
- **Row lookup:**
  - If `action.payload?.mcpToolId` is a string, the row is the one whose `toolId` equals it, or whose `` `${serviceOf(row.actionType)}_${row.toolId}` `` equals it. That row is used only if `row.actionType === action.type`; otherwise the builder returns `undefined`.
  - With no `mcpToolId`, the row is the unique `transport: "write"` row with `actionType === action.type`.
  - `preview.ts` imports `CONNECTOR_WRITE_ROWS` from `./index.ts`, and never `connector-write-registry.ts`, which pulls in the ChatOps and tribal gates.
- **Interpolation:**
  - `{key}` is replaced by the rendered value of the input's OWN property `key` (`Object.hasOwn`), or by `(not set)` when it is absent, `undefined` or `null`. A field with `whenUnset` shows that text instead of `(not set)`.
  - Text with no braces is left alone. An unknown placeholder shape such as `{a.b}` is left literal.
  - The input is `extractToolInput(action)`. When that is not a plain object, `fields` is empty, and `otherFields` holds one entry, `{ key: "(input)", value: <rendered> }`.
- **CLI lines**, as `renderConnectorWritePreviewLines` returns them:
  ```
  Service: <service>
  Target:  <target>
  <summary>

    <label>: <value>
  Other fields:
    <key>: <value>
  ```
  The `Other fields:` block is left out when it is empty. Every value has been sanitised, and its `\n` and `\t` are shown escaped.

- [ ] **Step 1: Write the failing tests** in `preview.test.ts`. Use a test-only template on a real row: build the action for `argocd.app.sync`, and in the test, set a template on a copy with `withPreview` and inject it through a seam. To make that possible, export `buildConnectorWritePreviewFrom(action, rows: readonly ConnectorWriteRow[])`, and have `buildConnectorWritePreview` call it with `CONNECTOR_WRITE_ROWS`.
  - `"fills target, summary and fields from the input"`: input `{ name: "web", revision: "abc" }` with the template target `"{name}"`, summary `"Sync Argo CD application {name}"`, and field `revision`. The result is `target "web"`, `summary "Sync Argo CD application web"`, and the field value `"abc"`.
  - `"a missing key shows (not set)"`.
  - `"every input key the template does not name is listed under Other fields"`: an extra `force: true` gives `otherFields` equal to `[{ key: "force", value: "true" }]`.
  - `"mcpToolId is a routing key, never shown"`: with the payload `{ mcpToolId: "argocd_app_sync", input: {...} }`, no `otherFields` entry has the key `mcpToolId`.
  - `"a key that looks sensitive is shown in full"`: the input `{ name: "x", issueKey: "SECRET-1", author: "eve" }` shows `SECRET-1` and `eve`, and the result contains no `[REDACTED]`.
  - `"a secret field is masked"`: a template field of kind `secret` with a value of 12 characters renders as `(hidden, 12 characters)`.
  - `"control, escape and bidi characters are stripped; newlines are escaped in CLI lines"`: the value `"a\x1b[2K\rApproved: yes\u202Eb\nc\x1b]8;;http://x\x1b\\L\x1bc"` has none of `\x1b`, `\r` or `\u202E` in the builder output. The rendered line contains the two characters `\n`, and no line returned by `renderConnectorWritePreviewLines` starts with `Approved`.
  - `"a newline in the target, the summary or an input KEY cannot forge a line"`: with `name: "web\nType: file.delete"` (in `target` and `summary`) and an extra key `"x\nApproved"`, `renderConnectorWritePreviewLines` returns exactly the expected number of lines and none starts with `Type:` or `Approved`.
  - `"a long value is never truncated"`: a 2,500-character value is present in full in the preview and in the CLI lines.
  - `"template keys do not repeat under Other fields"`: for a `{namespace}/{name}` target with no fields, input `{ namespace: "a", name: "b" }` gives `otherFields` equal to `[]`.
  - `"an unset field shows its whenUnset text"`, and `"a prototype key reads as absent"` (`{toString}` → `(not set)`).
  - `"a non-string value is compact JSON"`: `{ a: [1, 2] }` renders as `{"a":[1,2]}`.
  - `"mcpToolId naming a different write gives no preview"`: the payload `{ mcpToolId: "argocd_app_rollback", input: {} }` on an `argocd.app.sync` action returns `undefined`.
  - `"a namespaced mcpToolId resolves"`: `argocd_argocd_app_sync` resolves to the row.
  - `"no template gives no preview"`: a row with no template returns `undefined`.
  - `"a non-object input is shown whole"`.
  - `"extractToolInput still behaves as before"`: in `engine/tool-input.test.ts`, the three shapes, with no payload, `input`, and flat with `mcpToolId` dropped.

- [ ] **Step 2: Run, expect FAIL.** Run `bun test packages/gateway/src/connectors/connector-writes/preview.test.ts`. The module is missing.
- [ ] **Step 3: Implement** the move, the types and the builder. Write the sanitiser as one named function with a comment naming each range, using escapes and no invisible literals. The repo already has `PROMPT_UNSAFE_AFTER_JSON` in `executor.ts`; do not import it, because it does not cover ANSI or C0.
- [ ] **Step 4: Run** `bun test packages/gateway/src/connectors packages/gateway/src/engine/tool-input.test.ts` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat(connectors): build a typed preview of a connector write from its tool input`.

### Task 2: Templates for the 18 `write` rows, and the tripwires

**Files:**
- Modify: `packages/gateway/src/connectors/connector-writes/warehouse-bi.ts`, `gitops-ml.ts`
- Test: extend `connector-writes/rows.test.ts` and `connector-writes/manifest.sync.test.ts`

**The templates**, as `toolId: target | summary | fields`. Every field is `kind: "text"`, labelled with the key unless a label is given:

- **Warehouse:**
  - `snowflake_tag_set`: `{object}` | `Set tag {tag} to {value} on {object}` | `tag`, `value`
  - `snowflake_comment_set`: `{object}` | `Set the comment on {object}` | `comment` (label `Comment`)
- **BI:**
  - `tableau_datasource_refresh`: `{id}` | `Refresh Tableau data source {id}` | (none)
  - `tableau_workbook_refresh`: `{id}` | `Refresh Tableau workbook {id}` | (none)
  - `looker_datagroup_trigger`: `{datagroupId}` | `Trigger Looker datagroup {datagroupId}` | (none)
  - `looker_schedule_run_once`: `{scheduledPlanId}` | `Run Looker scheduled plan {scheduledPlanId} once` | (none)
  - `powerbi_dataset_refresh`: `{datasetId}` | `Refresh Power BI dataset {datasetId}` | `groupId` (label `Workspace`)
  - `powerbi_dataflow_refresh`: `{dataflowId}` | `Refresh Power BI dataflow {dataflowId}` | `groupId` (label `Workspace`)
- **Data quality:**
  - `montecarlo_incident_acknowledge`: `{incidentId}` | `Acknowledge Monte Carlo incident {incidentId}` | (none)
  - `montecarlo_incident_resolve`: `{incidentId}` | `Resolve Monte Carlo incident {incidentId}` | (none)
  - `bigeye_issue_acknowledge`: `{issueId}` | `Acknowledge Bigeye issue {issueId}` | (none)
  - `bigeye_issue_resolve`: `{issueId}` | `Resolve Bigeye issue {issueId}` | (none)
- **GitOps:**
  - `argocd_app_sync`: `{name}` | `Sync Argo CD application {name}` | `revision`, `prune`
  - `argocd_app_rollback`: `{name}` | `Roll back Argo CD application {name} to history id {id}` | (none)
  - `flux_kustomization_reconcile`: `{namespace}/{name}` | `Reconcile Flux Kustomization {namespace}/{name}` | (none)
  - `flux_helmrelease_reconcile`: `{namespace}/{name}` | `Reconcile Flux HelmRelease {namespace}/{name}` | (none)
- **ML:**
  - `mlflow_model_promote`: `{name} v{version}` | `Promote MLflow model {name} version {version}` | `archiveExisting` (label `Archive existing versions`)
  - `mlflow_model_transition_stage`: `{name} v{version}` | `Move MLflow model {name} version {version} to {stage}` | `stage`, `archiveExisting` (label `Archive existing versions`)

Keys not named stay visible under `Other fields`. That includes any key whose upstream schema differs from this table, such as an extra Looker datagroup field.

**Defaults (ruling P7).** These two are known from the upstream handlers in the installed package:
- `snowflake_tag_set`: the summary is `Set or remove tag {tag} on {object}`, and the `value` field has `whenUnset: "(not set: the tag is REMOVED)"`, because the handler runs `UNSET TAG` when `value` is omitted.
- `mlflow_model_promote`: the `archiveExisting` field has `whenUnset: "(not set: defaults to true, archives the current version)"`, because the handler does `archiveExisting ?? true`.

For every other templated optional key (for example `prune` and `revision` on `argocd_app_sync`, `archiveExisting` on `mlflow_model_transition_stage`, `groupId` on `powerbi_dataset_refresh`), read the handler in the installed `@nimbus-dev/connectors` source, set `whenUnset` to the real effect where it is not "nothing", and list each finding in your report.

- [ ] **Step 1: Write the failing tests:**
  - In `rows.test.ts`, `"every write-transport row has a preview template"`: `CONNECTOR_WRITE_ROWS.filter(r => r.transport === "write" && r.preview === undefined)` equals `[]`.
  - In `rows.test.ts`, `"no proposable row has a template yet (the MCP sink replaces the executor prompt)"`: the rows whose `toolId` is a value of `PROPOSABLE_WRITE_TOOLS` and that have `preview` equal `[]`. The failure message reads: "extend ipc/capture-rpc.ts provenanceConsent to show the typed preview first".
  - In `manifest.sync.test.ts`, `"every template key names an input key the connector declares"`: for each row with a template, take every `{key}` in its `target` and `summary` plus every `fields[].key`. Each must appear as `` `${key}:` `` INSIDE that tool's registering call: slice `stripComments(file text)` by the registration's `r.span` (as the existing mutates test does), never the whole file, where `id:` or `name:` appears for other tools. Problems: `[]`. Rows with `registeredAs: "read"` are skipped. Also assert a negative control: a made-up key `nonexistentKey` is reported as a problem for `tableau_datasource_refresh`, so the check can fail.
  - In `preview.test.ts`, `"a real row renders: flux_kustomization_reconcile"`: `buildConnectorWritePreview({ type: "flux.kustomization.reconcile", payload: { namespace: "apps", name: "web" } })` gives `target` `"apps/web"`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the templates with `withPreview(row(...), {...})`.
- [ ] **Step 4: Run** `bun test packages/gateway/src/connectors`. Expected: PASS. If the key test fails because an upstream key differs from this table, fix the template to the upstream key and record the difference in your report. Never weaken the test.
- [ ] **Step 5: Commit.** Message: `feat(connectors): preview templates for the warehouse, BI, GitOps and ML writes`.

### Task 3: The executor shows the preview

**Files:**
- Modify: `packages/gateway/src/engine/executor.ts` (`consentDisplayPayload`, `formatConsentPrompt`)
- Test: `packages/gateway/src/engine/executor-connector-write-preview.test.ts`

**Interfaces:**
- Consumes `buildConnectorWritePreview` and `renderConnectorWritePreviewLines` from Task 1.
- In `consentDisplayPayload`, after the user-MCP branch and before the extension branches: if `buildConnectorWritePreview(action)` returns a preview, return it, cast to `Record<string, unknown>`.
- In `formatConsentPrompt`, after the header lines and before the generic `Details:` line: if there is a preview, push `""` and then its lines, and return. No `Details:` line follows.
- `buildConnectorWritePreview` is pure and cheap; call it in each of the two functions, with no cache.
- In `consentDisplayPayload`, every non-preview return path passes its record through one helper that wraps a top-level `kind: "connector-write"` as `{ payload: record }` (the spoofing rule in Global Constraints).

- [ ] **Step 1: Write the failing tests:**
  - `"a templated write prompts with the typed preview, not a Details line"`: run a `ToolExecutor` with a recording consent channel, `execute({ type: "argocd.app.sync", payload: { name: "web", revision: "abc" } })`. The prompt contains `Target:  web` and `Sync Argo CD application web`, and does not contain `Details:`. `details.kind` is `"connector-write"`.
  - `"the audit row stays redacted"`: the same action with an extra `apiToken: "s3cr3t"` input key. The recorded `actionJson` does not contain `s3cr3t`, while the prompt does, under `Other fields`. This is the stated I42-style choice.
  - `"an untemplated write keeps today's prompt byte for byte"`: `jira.issue.create` with `{ mcpToolId: "jira_issue_create", input: { summary: "x" } }` gives a prompt equal to the string the current code produces. Compute it from a hard-coded expected string, never from the function under test.
  - `"a mismatched mcpToolId keeps today's prompt"`.
  - `"HITL still decided by type: a templated write with no consent approval dispatches nothing"`: a denying channel gives a dispatch count of 0 and a `rejected` status.
  - `"a payload cannot pose as a typed preview"`: a user-MCP action (`mcp_demo.run`) whose payload is `{ kind: "connector-write", target: "harmless" }` produces details whose top-level `kind` is NOT `"connector-write"` (it is wrapped under `payload`). The same for an untemplated first-party write.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test packages/gateway/src/engine packages/gateway/src/security-invariants.test.ts packages/gateway/src/mcp-sink packages/gateway/src/chatops packages/gateway/src/ipc`. Expected: PASS, with every existing prompt-text assertion unchanged.
- [ ] **Step 5: Commit.** Message: `feat(engine): the consent prompt shows a connector write's typed preview`.

### Task 4: The desktop renders the preview

**Files:**
- Create: `packages/ui/src/components/hitl/ConnectorWritePreview.tsx`
- Modify: `packages/ui/src/components/hitl/StructuredPreview.tsx`. Add the branch `if (details["kind"] === "connector-write" && details["actionType"] === action) return <ConnectorWritePreview details={details} />;` before the `action` branches. The component and its file are both named `ConnectorWritePreview`. Read the fields defensively from `unknown`; the UI never imports gateway code.
- Modify: `packages/ui/src/components/hitl/HitlPopupPage.tsx`. For a typed preview (the same two-part test), the heading is the fixed text "Approve this connector write?" (ruling P9), not `head.prompt`.
- Test: `packages/ui/test/components/hitl/ConnectorWritePreview.test.tsx`

- [ ] **Step 1: Write the failing tests** with vitest and Testing Library, as the sibling `StructuredPreview.test.tsx` does:
  - It renders the service, target, summary, each field label and value, and the `Other fields` rows.
  - A value containing `<img src=x onerror=alert(1)>` is rendered as TEXT. `container.querySelector("img")` is `null`.
  - A `markdown` field renders as plain preformatted text (ruling P2). `**bold**` shows its asterisks, and no `<strong>` exists.
  - A `secret` field shows the gateway's masked string as given.
  - Malformed details, such as missing `fields` or a non-string target, render without throwing, and show what is valid.
  - Through `StructuredPreview`, `details.kind === "connector-write"` with a matching `actionType` reaches the new component (a `data-testid`). With `actionType` different from `action`, it falls back to the generic rows.
  - A value over 2,000 characters is collapsed behind "Show full", and clicking it shows the whole value.
  - In `HitlPopupPage.test.tsx`: a typed preview's heading is "Approve this connector write?", and the multi-line prompt is not rendered as the heading.
- [ ] **Step 2: Run, expect FAIL.** Run `cd packages/ui && bunx vitest run test/components/hitl/ConnectorWritePreview.test.tsx`.
- [ ] **Step 3: Implement** with the existing Tailwind classes and patterns of `StructuredPreview.tsx`. Use plain JSX text nodes only, and never `dangerouslySetInnerHTML`.
- [ ] **Step 4: Run** `cd packages/ui && bunx vitest run test/components/hitl` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat(ui): render a connector write's typed preview in the approval popup`.

### Task 5: Docs

**Files:** `docs/architecture.md` (the consent and HITL section), `docs/SECURITY-INVARIANTS.md` (I2's consent-display note, and I26 "How to comply" gaining "give the row a preview template"), `docs/roadmap.md` (Phase 9.7 Wave 1), and `docs/CHANGELOG.md` (a new top entry)

- [ ] **Step 1:** Describe what the preview shows and why it is not redacted beyond `secret` fields: the consent request is unicast, and the audit row stays redacted. Also cover the sanitising and the 2,000-character cap, that a write with no template keeps today's prompt, and the tripwire for proposable rows.
- [ ] **Step 2:** In the roadmap, tick "HITL consent preview renderer" with the note: typed preview of target and every input field; a before-state read arrives per write in Waves 2–4 (spec § 5.4). Leave the rest of Wave 1 unticked.
- [ ] **Step 3: Run** `bun run audit:doc-refs`, `bun run audit:status-drift`, `bun run preflight:fast` and `bun run typecheck:tests`. Expected: pass.
- [ ] **Step 4: Commit.** Message: `docs: the typed connector-write preview`.

## PR

- Title: `feat(gateway): a typed preview in the approval prompt for connector writes`. Not breaking, so no `!`.
- Body: what the owner now sees, the display-only boundary, the no-redaction choice and its reasons, rulings P1–P6, the tests, and the attribution lines. No unbalanced `(`.
- Auto-merge. Resolve every review thread.
