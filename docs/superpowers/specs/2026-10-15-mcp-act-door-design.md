# S3 — MCP capture sink PR 3: the act door (I28 extended) — design

> **Status:** draft for owner review, 2026-10-15, **revision 2** (review
> `2026-10-15-mcp-act-door-review.md` folded in — see § 16 for the per-finding disposition). PR 3 of
> 3 of the MCP capture sink. Branch `dev/asaf/s3-act-door`. This file never lands on `main` — strip
> it before the implementation PR. Builds on the PR 1/2 spec (`2026-10-11-mcp-capture-sink-design.md`,
> branch `dev/asaf/s3-mcp-capture-sink-pr2`), whose § 9 sketched this door and deferred it here.

## 1. Intent

**Outcome.** A coding agent connected over MCP can *propose* a connector action — post a Slack
message, comment on a Jira ticket, open a GitHub issue, send an email — which waits in the owner's
capture queue. Nothing happens until the owner runs `nimbus captures accept <id>` and then answers
the ordinary executor HITL prompt. The agent can poll what became of its proposal.

**Who it is for.** The local owner, working with an MCP agent that already reads the index and
already captures notes/decisions/terms/links (PR 1/2).

**Success criteria.**

1. With `[mcp_sink] kinds` including `"action"`, an MCP client's `propose_action` stores a
   `proposed` action capture; nothing leaves the machine and no egress row is written.
2. `nimbus captures accept <id>` from the owner's TTY shows the verbatim stored input with agent
   provenance, prompts through the executor's consent gate (I2), appends one `egress_ledger` row
   before dispatch (I29), and dispatches exactly the stored action — to the ONE tool the gateway's
   own routing table names for that action type, with the stored input and nothing else.
3. No MCP client can accept, reject, or retry anything; no delegate (I20) can approve.
4. A proposal not accepted within its TTL can never run. A failed or interrupted execution is never
   retried from the same capture.
5. Turning the sink on does NOT turn the act door on; org policy can lock the act door off
   independently of capture.

**Owner rulings recorded in brainstorming (do not relitigate).**

- **Scope: broad minus a denylist** — any HITL frozen-set action type except destructive /
  gateway-internal classes — implemented FAIL-CLOSED as a classification table that tests make
  total over `HITL_REQUIRED`, so a new HITL type is unproposable until someone classifies it.
- **Staleness: TTL expiry** (default 24 h, configurable); an expired proposal can only be
  re-proposed.
- **Failure: terminal `failed`**, no retry from the same capture (no idempotency keys across ~90
  connectors; a timeout may have posted).
- **Feedback: `capture_status`** — the agent may read the state + a short outcome ref of a capture
  whose id it holds; never a response body.
- **User-MCP: only `--model` servers**, and only while `user_mcp_model_access` is on.
- **Approach A:** `action` is a fifth kind in the existing `capture` table and gate (one I28
  door), not a parallel table.

## 2. Non-goals

- No retry, edit, or re-execute of an action capture. Re-proposal is the only path.
- No HTTP/SSE transport, ChatOps, Tauri/desktop review, or LAN exposure of any new method.
- No owner-authored actions through this queue (the owner already has `nimbus connector call` and
  the engine).
- No idempotency/dedup across proposals: two identical proposals are two captures.
- No change to `engine/executor.ts`, `connectors/registry.ts` or `lazy-mesh/tool-map.ts`. The act
  door uses the dispatcher's EXISTING gateway-controlled `mcpToolId` path — the one
  `tribal/tribal-write-gate.ts` already uses — with the tool id taken from a new gateway-owned
  routing table (§ 6.3), never from the agent.
- No new credential path: a first-party proposable write runs with the connector's own (personal)
  credential exactly as the engine and ChatOps do today.

## 3. Architecture

```
MCP client ──stdio──▶ nimbus mcp-server (packages/cli/src/mcp/capture-tools.ts)
                        ├─ propose_action  ──IPC capture.submit──▶ capture-gate.submitCapture()   (I28 submit order, async)
                        └─ capture_status  ──IPC capture.state ──▶ capture-gate.captureStateFor()

owner CLI: nimbus captures accept <id> ──IPC captures.accept (withIpc, {kind:"prompt"}, BATCH timeout)
   ▼
ipc/capture-rpc.ts  injects ActDeps.execute(actionType, input, provenance):
                      toolId  = proposableWriteTool(actionType)            (connectors/, § 6.3)
                      consent = provenanceConsent(bindConsentChannel(accepting client), provenance, actionType, input)
                      new ToolExecutor(consent, audit, actDispatcher, undefined /*no delegate*/,
                                       makeEgressSink(db), policyHitl)
                        .execute({ type: actionType, payload: { mcpToolId: toolId, input } })
   ▼
capture-gate.acceptCapture()  ── kind === "action" ──▶ capture-act.acceptAction()  (async)
                                                          └─ calls ActDeps.execute(...)
```

`actDispatcher` is the SAME composition `gateway-main.ts` installs for `runAsk` and
`platform/assemble.ts` for ChatOps: `createConnectorWriteDispatcher(createConnectorDispatcher(
meshDispatcherClient(connectorMesh)), connectorWriteDeps)`, handed to the capture RPC context via
`ipcOpts`. A proposable type in `CONNECTOR_WRITES` would take the credential-aware transport; none
is today (warehouse/GitOps writes are denied, § 6.1), so proposables reach the mesh dispatcher.

**Module placement (D32(f)).** `mcp-sink/` imports neither `engine/executor.ts` nor anything under
`connectors/`. Everything connector-shaped is in `connectors/` and reaches the gate as injected
functions:

| module | holds | consumed by |
|---|---|---|
| `connectors/proposable-actions.ts` (NEW) | `ACTION_PROPOSABILITY` table, `classifyActionType`, `PROPOSABLE_WRITE_TOOLS` routing map, `proposableWriteTool` | `platform/assemble.ts` (wires `classify` into `CaptureGateDeps`), `ipc/capture-rpc.ts` (tool id) |
| `mcp-sink/capture-act.ts` (NEW) | `acceptAction` fixed order, `formatActionConsent` (pure), `outcomeRefOf` (pure) | `capture-gate.ts` |
| `index/capture-action-v69-sql.ts` (NEW) | V69 rebuild | migration runner |

Changed: `capture-types.ts`, `capture-validate.ts`, `capture-gate.ts`, `capture-store.ts`,
`capture-capability.ts`, `ipc/capture-rpc.ts`, `ipc/server/*` (ctx plumbing), `config/mcp-sink-toml.ts`,
`policy/types.ts`, `platform/assemble.ts` (wiring + boot reconcile), doctor. CLI:
`mcp/capture-tools.ts`, `commands/captures.ts`.

## 4. Data model — V69

SQLite cannot alter a CHECK, so V69 rebuilds `capture` (create `capture_v69`, copy with an
EXPLICIT column list on both sides — the V68 `${COLS}` precedent — drop, rename, recreate the three
indexes), inside the runner's transaction, asserting the row count before and after. Every V68 row
is copied byte-identically (new columns NULL).

```sql
CREATE TABLE capture_v69 (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK(kind IN ('note','decision','term','link','action')),
  state         TEXT NOT NULL CHECK(state IN ('live','proposed','accepted','rejected','revoked',
                                              'executing','executed','failed','expired')),
  item_id       TEXT,
  payload_json  TEXT,
  payload_bytes INTEGER NOT NULL,
  client_label  TEXT,
  session_id    TEXT NOT NULL,
  native_ref    TEXT,
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER,
  expires_at    INTEGER,              -- NEW: required for action, NULL otherwise
  outcome_ref   TEXT,                 -- NEW: ≤ 512 chars, action + executed only
  error_code    TEXT,                 -- NEW: ≤ 64 chars, action + failed only
  CHECK (
    (kind = 'note'   AND state IN ('live','revoked'))
    OR (kind IN ('decision','term','link') AND state IN ('proposed','accepted','rejected','revoked'))
    OR (kind = 'action' AND state IN ('proposed','executing','executed','failed','rejected','expired'))
  ),
  CHECK ((state = 'revoked') = (payload_json IS NULL)),
  CHECK ((kind = 'action') = (expires_at IS NOT NULL)),
  CHECK (kind <> 'action' OR (item_id IS NULL AND native_ref IS NULL)),
  CHECK (outcome_ref IS NULL OR (kind = 'action' AND state = 'executed' AND length(outcome_ref) <= 512)),
  CHECK (error_code  IS NULL OR (kind = 'action' AND state = 'failed'   AND length(error_code)  <= 64))
)
```

`CURRENT_SCHEMA_VERSION` → 69. D32(a)'s allow-list gains `index/capture-action-v69-sql.ts`.

**Store additions** (`capture-store.ts`, the only file naming the table):

- `countPendingActions(nowMs)` — `kind = 'action' AND state = 'proposed' AND expires_at > ?`.
- `countPendingNative()` — `kind <> 'action' AND state = 'proposed'`. Replaces the
  `countByState("proposed")` read used by the existing pending cap, so actions can neither starve
  nor be starved by native proposals.
- `expireDueActions(nowMs)` — returns the ids of `proposed` actions with `expires_at <= ?` and
  transitions them in ONE `UPDATE … RETURNING id` (bounded by `action_max_pending` + the hourly
  cap, so the per-id audit rows the caller writes in the same transaction stay small).
- `claimAction(id, nowMs)` — the compare-and-set of § 8 step 5; returns whether it won.
- `finalizeAction(id, state, {outcomeRef?, errorCode?}, nowMs)` — `WHERE state = 'executing'`.
- `failInterruptedActions(nowMs)` — boot reconcile.

**Action payload (stored `payload_json`):**

```ts
interface ActionPayload {
  readonly actionType: string;               // exact HITL frozen-set member or mcp_<id>.<tool>
  readonly input: Readonly<Record<string, unknown>>;   // JSON object, verbatim
  readonly summary: string;                  // agent's one-line why; prose, truncated at 300
}
```

## 5. Config and policy

`[mcp_sink]`:

| key | default | range | note |
|---|---|---|---|
| `kinds` | `["note","decision","term","link"]` | — | **`"action"` must be listed explicitly.** `CAPTURE_KINDS` gains `"action"`, but `DEFAULT_MCP_SINK_CONFIG.kinds` becomes a separate `DEFAULT_CAPTURE_KINDS` constant (the four), so enabling the sink never enables the act door. |
| `action_ttl_hours` | 24 | 1..168 | refused loudly out of range |
| `action_max_pending` | 10 | 1..100 | separate from `max_pending` (unexpired `proposed` actions only) |

`max_per_hour` (the durable hourly cap) counts actions with every other kind.

Policy: `AI_V2_CAPABILITIES` gains `"mcp_action"` (the NINTH name). `CaptureCapability` grows
`actionEnabled = sink enabled ∧ "action" ∈ kinds ∧ ¬locked(mcp_capture) ∧ ¬locked(mcp_action)`,
fail-closed when the policy accessor is absent, read LIVE per call as `mcp_capture` is.

## 6. Proposability and routing — `connectors/proposable-actions.ts`

```ts
type DeniedClass =
  | "file" | "calendar_delete" | "vcs" | "pipeline" | "cloud" | "iac" | "k8s" | "deployment"
  | "incident" | "data_platform" | "tribal_kb" | "chatops_confined" | "unroutable" | "gateway_internal";

type Proposability = { readonly kind: "proposable" } | { readonly kind: "denied"; readonly class: DeniedClass };

export const ACTION_PROPOSABILITY: Readonly<Record<string, Proposability>>;   // keys == HITL_REQUIRED
export const PROPOSABLE_WRITE_TOOLS: Readonly<Record<string, string>>;        // actionType → bare tool id

export type ActionClassification =
  | { readonly kind: "proposable" }
  | { readonly kind: "denied"; readonly class: DeniedClass | "user_mcp_no_model_access" | "user_mcp_policy" }
  | { readonly kind: "unknown" };

export function classifyActionType(
  actionType: string,
  ctx: { modelAccessServices(): ReadonlySet<string>; userMcpModelAccessAllowed(): boolean },
): ActionClassification;

/** The tool id the act door dispatches for a proposable type. `undefined` for user-MCP types (the
 *  dispatcher derives their key from the type, I42) and for anything not proposable. */
export function proposableWriteTool(actionType: string): string | undefined;
```

- A first-party type is proposable iff its table entry is `proposable` (which, by the routing test
  below, implies a `PROPOSABLE_WRITE_TOOLS` row).
- A user-MCP type (`isUserMcpActionType`, imported from `engine/executor.ts` — no cycle, executor
  does not import this module) is proposable iff its service id is in
  `listModelAccessServiceIds()` (`model_access = 1`) AND `user_mcp_model_access` is on (live,
  fail-closed — the source `user-mcp-model-capability.ts` reads). For these the act door sets NO
  `mcpToolId`: `connectors/registry.ts` derives the key from the type (`mcp_x.tool` → `mcp_x_tool`).
- Anything else (non-HITL type, unknown string) → `unknown` → refused.

### 6.1 Classification (139 types — review line by line)

**Proposable (30):**

| group | types |
|---|---|
| chat | `slack.message.post`, `teams.message.post`, `teams.message.postChat`† |
| email | `gmail.draft.create`, `gmail.draft.send`, `gmail.message.send`, `outlook.mail.send`, `fastmail.mail.send`, `imap.mail.send`†, `protonmail.mail.send`†, `apple.mail.send`†, `apple.mail.draft.create` |
| calendar (create only) | `outlook.calendar.create`, `apple.calendar.event.create` |
| tickets / issues | `linear.issue.create`, `linear.issue.update`, `linear.comment.create`, `jira.issue.create`, `jira.issue.update`, `jira.comment.add`, `github.issue.create` |
| docs | `notion.page.create`, `notion.page.update`, `notion.block.append`, `notion.comment.create`, `confluence.page.create`, `confluence.page.update`, `confluence.comment.add`, `obsidian.note.append`, `google_drive.file.create` |

† Registered in the connectors package through a shared kit or template (`${toolPrefix}_mail_send`),
so a literal `mutates:` grep at spec time did not find them. **Rule, not an open point:** each † type
stays proposable only if the routing sync test (§ 6.3) resolves its registration; one it cannot
resolve moves to `unroutable` in the implementation, and the plan records which.

**Denied (109, by class):**

| class | types |
|---|---|
| `file` (11) | `file.delete`, `file.move`, `file.rename`, `file.create`, `photo.delete`, `onedrive.delete`, `onedrive.move`, `onedrive.item.delete`, `onedrive.item.move`, `google_drive.file.move`, `google_drive.file.rename` |
| `calendar_delete` (3) | `calendar.event.delete`, `outlook.calendar.delete`, `apple.calendar.event.delete` |
| `vcs` (11) | `repo.pr.merge`, `repo.pr.close`, `repo.branch.delete`, `repo.tag.create`, `repo.commit.push`, `github.pr.merge`, `github.pr.close`, `github.branch.delete`, `github.tag.create`, `bitbucket.pr.merge`, `gitlab.mr.merge` |
| `pipeline` (11) | `pipeline.trigger`, `pipeline.cancel`, `pipeline.rerun`, `jenkins.build.trigger`, `jenkins.build.abort`, `github_actions.run.trigger`, `github_actions.run.cancel`, `circleci.pipeline.trigger`, `circleci.job.cancel`, `gitlab.pipeline.retry`, `gitlab.pipeline.cancel` |
| `cloud` (10) | `aws.ecs.service.update`, `aws.lambda.invoke`, `aws.ec2.instance.stop`, `aws.ec2.instance.start`, `azure.app_service.restart`, `azure.aks.node_pool.scale`, `gcp.cloud_run.deploy`, `gcp.gke.workload.restart`, `cloud.resource.scale`, `cloud.resource.stop` |
| `iac` (6) | `iac.terraform.apply`, `iac.terraform.destroy`, `iac.cloudformation.deploy`, `iac.pulumi.up`, `infra.apply`, `infra.destroy` |
| `k8s` (6) | `kubernetes.rollout.restart`, `kubernetes.pod.delete`, `kubernetes.deployment.scale`, `k8s.apply`, `k8s.delete`, `k8s.rollout.restart` |
| `deployment` (8) | `deployment.apply`, `deployment.rollback`, `argocd.app.sync`, `argocd.app.rollback`, `flux.kustomization.reconcile`, `flux.helmrelease.reconcile`, `mlflow.model.promote`, `mlflow.model.transition_stage` |
| `incident` (11) | `pagerduty.incident.acknowledge`, `pagerduty.incident.resolve`, `pagerduty.incident.escalate`, `alert.acknowledge`, `alert.silence`, `incident.escalate`, `incident.resolve`, `montecarlo.incident.acknowledge`, `montecarlo.incident.resolve`, `bigeye.issue.acknowledge`, `bigeye.issue.resolve` |
| `data_platform` (8) | `snowflake.tag.set`, `snowflake.comment.set`, `tableau.datasource.refresh`, `tableau.workbook.refresh`, `looker.datagroup.trigger`, `looker.schedule.run_once`, `powerbi.dataset.refresh`, `powerbi.dataflow.refresh` |
| `tribal_kb` (2) | `notion.knowledge.write`, `confluence.knowledge.write` — I25/D19: destination config-pinned, tool ids confined to the tribal write gate |
| `chatops_confined` (2) | `slack.chat.post`, `teams.chat.post` — I23/D17 confine their tool literals to the ChatOps reply surface |
| `unroutable` (4) | `email.send`, `email.draft.send`, `email.draft.create`, `calendar.event.create` — generic types with no connector server of that name (`serviceOf` → `email`/`calendar`), so no tool can resolve and `isConnectorConfigured` would answer `true` vacuously |
| `gateway_internal` (16) | `data.delete`, `data.export`, `connector.remove`, `connector.adoptLocalAuth`, `connector.addMcp`, `connector.reindex`, `extension.autoUpdate`, `extension.downgrade`, `extension.install`, `vault.set`, `vault.delete`, `teamvault.put`, `teamvault.delete`, `share.publish`, `egress.prune`, `tool.save` |

30 + 109 = 139 = `HITL_REQUIRED.size` at `436937b9`. The implementation's tests pin the exact lists.

### 6.2 Borderline — owner to confirm

Classified **denied** in the draft; flip any to proposable at review:

- `pagerduty.incident.acknowledge` / `alert.acknowledge` — low blast radius, but an ack silences a
  page for a human on call.
- `github.pr.close` / `repo.pr.close` — reversible, but closes someone else's work.
- `tableau.*.refresh` / `powerbi.*.refresh` — idempotent, but cost-bearing on the warehouse.

### 6.3 Routing — why a gateway-owned table is required

The first draft built `{type, payload:{input}}` and assumed the dispatcher would find the tool from
`action.type`. It would not: `connectors/registry.ts` resolves `mcpToolId ?? action.type` through
`resolveServerTool`, which tries the bare id and `<server>_<id>`. A first-party write is listed by
the mesh as `<server>_<tool>` with an UNDERSCORED tool name (`slack_slack_message_post`), so
`slack.message.post` matches neither and every first-party accept would have ended
`ERR_ACTION_TOOL_NOT_FOUND`. `connector-write-tool-ids.ts` states it plainly: these writes are
"NOT dispatchable from the gateway" by type — no actionType→toolId map exists for them. The only
shipped first-party write that does dispatch, the tribal KB append, supplies a GATEWAY-chosen
`mcpToolId`.

So `PROPOSABLE_WRITE_TOOLS` maps each first-party proposable type to its bare tool id
(`"slack.message.post": "slack_message_post"`, `"google_drive.file.create": "gdrive_file_create"`,
`"obsidian.note.append": "obsidian_append_to_daily_note"`, …), and `capture-rpc.ts` puts it in the
payload. The agent never supplies it (§ 7 refuses the key); `mcp-sink/` never names it (D32(g)).

Two tests keep the table honest:

- **Totality:** keys of `PROPOSABLE_WRITE_TOOLS` == the first-party `proposable` entries of
  `ACTION_PROPOSABILITY`, exactly.
- **Routing sync** (`proposable-actions.sync.test.ts`, beside `connector-write-sync.test.ts` and
  reusing `testing/connector-write-registrations.ts`'s source scan, extended to capture each
  registration's `mutates:` literal): for every row, the installed `@nimbus-dev/connectors`
  registers a write named `toolId` whose `mutates` equals `actionType`, in a connector whose mesh
  server name equals `serviceOf(actionType)` (so `resolveServerTool`'s server-prefix check passes).
  A registration it cannot follow is a violation, never a skip — the I26 guard's fail-closed rule.

## 7. Submit — `propose_action` → `submitCapture`

`submitCapture` becomes `async` (step 5b reads the Vault). Two new injected deps on
`CaptureGateDeps`, wired in `platform/assemble.ts`:

```ts
classifyAction(actionType: string): ActionClassification;     // connectors/proposable-actions.ts + live ctx
isServiceConfigured(service: string): Promise<boolean>;       // sync/connector-configured.ts; user-MCP: registered
```

The PR 1/2 fixed order is unchanged; `action` plugs into existing steps:

| step | action-specific behaviour | refusal |
|---|---|---|
| 1 capability | requires `actionEnabled` when the raw `kind` is `"action"` (unaudited, like today) | `ERR_CAPTURE_DISABLED` |
| 2 client kind | declared `mcp` only (unchanged) | `ERR_CAPTURE_FORBIDDEN_CLIENT` |
| 3 attempt limit | unchanged | `ERR_CAPTURE_RATE_LIMITED` |
| 4 kind allowed | `"action" ∈ kinds` | `ERR_CAPTURE_KIND_NOT_ALLOWED` |
| 5 whitelist rebuild | rebuild `{actionType, input, summary}` only; `actionType` non-empty ≤ 128; `input` a plain JSON object (not array/null); **`mcpToolId` as a key of `input` REFUSES** (never dropped); `summary` truncates at 300; 64 KiB total cap | `ERR_CAPTURE_INVALID` |
| 5a proposability (NEW) | `classifyAction` must return `proposable` | `ERR_CAPTURE_ACTION_NOT_PROPOSABLE` (audited) |
| 5b configured (NEW) | `await isServiceConfigured(serviceOf(actionType))` | `ERR_CAPTURE_CONNECTOR_UNCONFIGURED` (audited) |
| 6 referenced items | n/a (an action references no items) | — |
| 7 hourly cap | unchanged, counts actions | `ERR_CAPTURE_RATE_LIMITED` |
| 8 pending cap | actions: `countPendingActions(now) < action_max_pending`; others: `countPendingNative() < max_pending` | `ERR_CAPTURE_QUEUE_FULL` |
| write | state `proposed`, `expires_at = now + ttl`, no item, audit `capture.submit` | — |

The write transaction re-reads nothing from the await in 5b: steps 7–8 and the write run after it,
synchronously, in one transaction, so a concurrent submit cannot slip past the caps.

Why refuse `mcpToolId` rather than drop it: the dispatcher resolves a payload `mcpToolId` to a tool
on the action type's server while the HITL gate reads only `action.type` (I3). A dropped key is
indistinguishable from an honest payload; a refusal tells the agent and the audit log that it
tried. The action the act door builds takes its tool id from § 6.3 only, so this is defence in
depth over construction.

Submit returns `{id, state: "proposed", expiresAt}`.

## 8. Accept — `acceptCapture` → `capture-act.ts` `acceptAction()`

`acceptCapture(deps, caller, id, act?)` keeps its synchronous path for the native kinds and returns
`acceptAction(...)` (a Promise) for a row with `kind === "action"`; the RPC handler awaits either.

```ts
export interface ActionProvenance {
  readonly captureId: string;
  readonly clientLabel: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly summary: string;
}
export interface ActDeps {
  /** Built per call by ipc/capture-rpc.ts: resolves the tool id (§ 6.3), wraps the ACCEPTING client's
   *  consent channel with formatActionConsent(provenance, …), constructs a ToolExecutor with no
   *  delegate + the real egress sink + the policy overlay, and executes. */
  execute(actionType: string, input: Readonly<Record<string, unknown>>, provenance: ActionProvenance):
    Promise<{ readonly status: "ok"; readonly result: unknown } | { readonly status: "rejected" }>;
}
```

An action accept with `act` absent refuses (`ERR_CAPTURE_DISABLED`) — no fallback.

Fixed order:

1. **Capability** — `actionEnabled` (live, fail-closed). → `ERR_CAPTURE_DISABLED`
2. **Owner only** — `requireOwner(caller)` (refuses `mcp`, as today).
3. **State + expiry** — must be `proposed`; if `now ≥ expires_at`, expire it (store CAS + audit
   `capture.action.expire`, one transaction) and refuse `ERR_CAPTURE_EXPIRED`.
4. **Re-classify** — `classifyAction` and `await isServiceConfigured` again (`--model` revoked,
   policy tightened, connector removed). Refusal leaves the row `proposed` (the owner may fix
   config and retry before expiry). → `ERR_CAPTURE_ACTION_NOT_PROPOSABLE` /
   `ERR_CAPTURE_CONNECTOR_UNCONFIGURED`
5. **Claim** — ONE transaction: `claimAction(id, now)` (`UPDATE … SET state='executing',
   decided_at=? WHERE id=? AND state='proposed' AND expires_at > ?`); lost → `ERR_CAPTURE_STATE`;
   audit `capture.action.accept`. The expiry predicate in the CAS closes the window between step 3
   and the await in step 4.
6. **Build** — from the row read in step 3 (read ONCE; no re-read after the claim): `actionType`,
   `input`, and `ActionProvenance`.
7. **Execute** — `await act.execute(actionType, input, provenance)`. The prompt the owner answers is
   `formatActionConsent` (pure, in `capture-act.ts`):
   ```
   Agent-proposed action — requires your approval
   Proposed by MCP client "<client_label|unlabelled>" at <created_at ISO>, expires <expires_at ISO>
   Agent's summary (unverified): <summary>
   Type: <actionType>
   Input (verbatim, exactly what will be sent):
   <JSON.stringify(input, null, 2)>
   ```
   Details are passed UNREDACTED: the values are agent-authored, never Vault-sourced, and shown on
   the owner's own terminal; `redactPayloadForConsentDisplay`'s substring regex (`token|key|…`, which
   also matches `keywords`, `monkey`, `author`) would otherwise let a prompt-injected agent hide the
   field it wants approved — the reasoning `consentDisplayPayload` already applies to I42. The
   wrapper REPLACES the prompt/details the executor passes and forwards `actionType` unchanged; the
   executor's own audit row keeps `redactAuditPayload`.
8. **Finalize** — ONE transaction: `finalizeAction` + audit `capture.action.outcome`:
   - `{status:"ok"}` → `executed`, `outcome_ref = outcomeRefOf(result)`: the first top-level string
     among `url`, `html_url`, `webUrl`, `permalink` with an `https:` scheme and length ≤ 512, else
     NULL. The result body is not stored.
   - `{status:"rejected"}` (owner declined, or the accepting client disconnected —
     `ToolExecutor.gate()` maps `ConsentDisconnectedError` to `rejected`, verified § 16) → `rejected`.
   - thrown → `failed`, `error_code` = a classified short code (`ERR_ACTION_TIMEOUT`,
     `ERR_ACTION_TOOL_NOT_FOUND`, `ERR_ACTION_DISPATCH`), never the message text.
   - a finalize failure after a successful dispatch is logged loudly and the row stays `executing`;
     the boot reconcile turns it `failed` (§ 9). Stated bound: such a row may have executed.

Return: `{id, state, outcomeRef?, errorCode?}`.

New `CaptureErrorCode` members: `ERR_CAPTURE_ACTION_NOT_PROPOSABLE`,
`ERR_CAPTURE_CONNECTOR_UNCONFIGURED`, `ERR_CAPTURE_EXPIRED`. Stored `error_code` values (never
thrown): `ERR_ACTION_TIMEOUT`, `ERR_ACTION_TOOL_NOT_FOUND`, `ERR_ACTION_DISPATCH`,
`ERR_ACTION_INTERRUPTED`.

### 8.1 Reject / revoke

- `captures reject <id>` on a `proposed` action → `rejected` (existing path, kind-agnostic).
- `captures revoke <id>` on any action → `ERR_CAPTURE_STATE` ("an executed action cannot be
  undone; reject a proposed one").

### 8.2 Audit rows

All through `appendAuditEntry`, in the same transaction as the state change they record, payloads
built through `redactAuditPayload`:

| `actionType` | `hitlStatus` | payload |
|---|---|---|
| `capture.submit` (existing) | `not_required` | existing shape, `kind: "action"`, plus `actionType` |
| `capture.action.accept` | `not_required` | `{captureId, actionType}` — the HITL approval is the executor's own row |
| `capture.action.outcome` | `not_required` | `{captureId, actionType, outcome, outcomeRef?, errorCode?}` |
| `capture.action.expire` | `not_required` | `{captureId, expiredAt, outcome: "expired"}` |

`approved` is never written on these rows: per the PR 1 ruling it belongs only to a row a consent
gate earned, and the consent here is earned — and recorded — by `ToolExecutor.gate()`.

## 9. Expiry, reconcile, retention

- **Lazy expiry**: `listCaptures`, `getCapture`, `captureStateFor` and `captureStatus` first run
  `expireDueActions(now)` + one `capture.action.expire` audit row per returned id, in one
  transaction, so the state they report is the stored state. Accept step 3 expires the one row it
  holds.
- **Boot sweep** (beside the existing `pruneRejected`): `expireDueActions(now)`; then
  `failInterruptedActions(now)` — `executing` → `failed`, `error_code = 'ERR_ACTION_INTERRUPTED'`,
  never back to `proposed`; each audited.
- **Retention**: `expired` and `rejected` actions are pruned on the existing
  `REJECTED_RETENTION_MS` clock from `decided_at`. `executed` and `failed` rows are KEPT — the
  history of what agents caused.

## 10. Agent surface

`packages/cli/src/mcp/capture-tools.ts`, registered only after `declareKind("mcp")` succeeded:

- **`propose_action`** `{actionType: string, input: object, summary: string}` — registered iff
  `capture.status` reports `actionEnabled`. Returns `Proposed cap_… — expires <ISO>. The owner must
  accept it with \`nimbus captures accept\`.` Its description lists `proposableActionTypes` from
  `capture.status`.
- **`capture_status`** `{id: string}` → `{kind, state, expiresAt?, outcomeRef?, errorCode?}` —
  registered whenever ANY capture kind is enabled (a decision proposer benefits too). Backed by new
  IPC `capture.state` — `mcp` kind only (the owner uses `captures.get`); no payload, no session data,
  no listing. Unknown id → `ERR_CAPTURE_NOT_FOUND`. The `capture.*` namespace is already
  LAN-forbidden and absent from the Tauri allowlist; no HTTP route.

`CaptureStatus` (returned by `capture.status`) gains:

```ts
readonly actionEnabled: boolean;
readonly proposableActionTypes: readonly string[];   // sorted; [] unless actionEnabled; cap 200
readonly actionPending: number;                      // countPendingActions(now)
readonly actionMaxPending: number;
readonly actionTtlHours: number;
```

`proposableActionTypes` = first-party `proposable` types whose service `isServiceConfigured`, plus
`mcp_<id>.<tool>` for each `--model` server's listed tools when `user_mcp_model_access` is on.
`pending` keeps meaning native proposals (now `countPendingNative()`), so the existing doctor line
is unchanged in meaning.

## 11. Owner surface

- `nimbus captures accept <id>`: `runCapturesCmd` checks `process.stdin.isTTY && process.stdout.isTTY`
  BEFORE connecting when the target is an action (it reads `captures.get` first to learn the kind;
  native kinds keep today's non-interactive accept). No TTY → `CliExit(1)` with
  `nimbus captures accept requires an interactive terminal (TTY) to approve an agent-proposed action.`
  — never auto-approve. The accept call itself is `withIpc(c => c.call("captures.accept", {id}),
  {kind:"prompt"}, BATCH_RPC_TIMEOUT_MS)`.
- **Result handling** — `assertAcceptResult` and `confirmation()` today require
  `state === "accepted"` and a non-empty `nativeRef`, and would reject every action result. They
  branch on the returned state:
  - `accepted` → today's behaviour, unchanged.
  - `executed` → `[ok] executed <actionType> (<outcomeRef | no outcome reference>)`, exit 0.
  - `rejected` → `[rejected] not executed — you declined the approval`, exit 1.
  - `failed` → `[failed] <errorCode> — the action may or may not have reached <service>` for
    `ERR_ACTION_TIMEOUT` / `ERR_ACTION_DISPATCH` / `ERR_ACTION_INTERRUPTED`; `[failed] <errorCode>`
    otherwise; exit 1.
  - anything else → today's "malformed result" error.
- `nimbus captures list`: action rows show `actionType`, age, and `expires in …` / terminal state.
- `nimbus captures show <id>`: the full verbatim input, summary labelled unverified.
- `nimbus doctor` (sink enabled with `action`): info line `N agent-proposed actions awaiting
  review (M expire within 1h) — nimbus captures`.

## 12. Invariants and static rules

### 12.1 I28 — appended text

> …A proposed connector action leaves the machine only through `mcp-sink/capture-act.ts`'s
> `acceptAction()`, reached only from the owner's `acceptCapture()`, in a fixed order: capability
> incl. `mcp_action` (fail-closed) → owner only → not expired → proposability (a table tests make
> total over `HITL_REQUIRED`; user-MCP only for `--model` servers) and configured-ness re-checked →
> atomic claim → the action rebuilt from the stored row, read once, dispatched to the ONE tool the
> gateway's routing table names for that type (never an agent-supplied `mcpToolId`) →
> `ToolExecutor` with the ACCEPTING session's consent channel and no delegate, so I2, I29, I22 and
> I42 apply unchanged → one terminal outcome, never retried. The owner is shown the verbatim stored
> input with its agent provenance. **Bounds:** approval proves the owner saw the call, not that it
> is wise; a transport failure is recorded `failed` though the remote may have acted; `outcome_ref`
> is a heuristic; the routing table is proven against the INSTALLED connectors package, so a
> connector renaming a tool between that check and runtime surfaces as `failed`.

Triple rule: `docs/SECURITY-INVARIANTS.md` § I28, CLAUDE.md + GEMINI.md I28 bullets, and the
`security-invariants.test.ts` I28 row extended (accept-of-action reaches `execute` only after the
claim; the dispatched payload's `mcpToolId` is the routing table's value; `delegation` is
`undefined` at the capture-rpc `new ToolExecutor` site, which also passes `policyHitl`).

### 12.2 D32 additions (`scripts/structure-audit/check-nimbus-invariants.ts`)

- **D32(e)** — `acceptAction` is defined only in `capture-act.ts` and called only from
  `capture-gate.ts`.
- **D32(f)** — no non-test file under `packages/gateway/src/mcp-sink/` imports
  `engine/executor.ts` or any module under `connectors/` (type-only imports included). Execution,
  classification and configured-ness reach the sink only as injected functions; `ipc/capture-rpc.ts`
  and `platform/assemble.ts` are where they are built. Capability confinement is the primary
  defence.
- **D32(g)** — the `mcpToolId` literal (comment-stripped) appears under `mcp-sink/` only in
  `capture-validate.ts`.

Each red-proved by a fixture that must fail. Stated bound as D32(a): a dynamically composed string
evades a text scan.

## 13. Testing

| layer | file | proves |
|---|---|---|
| unit | `connectors/proposable-actions.test.ts` | key set == `HITL_REQUIRED`; exact proposable list pinned; `PROPOSABLE_WRITE_TOOLS` keys == first-party proposables; non-HITL/unknown → `unknown`; user-MCP proposable only with `model_access = 1` AND policy on; policy accessor absent → denied; `proposableWriteTool` undefined for user-MCP and denied types |
| sync | `connectors/proposable-actions.sync.test.ts` | every routing row resolves to a write registered by the installed package with `mutates === actionType` on server `serviceOf(actionType)`; an unfollowable registration fails |
| unit | `capture-validate.test.ts` | `mcpToolId` key refuses; non-object / array / null `input` refuses; `actionType` bounds; `summary` truncates; 64 KiB cap; sibling keys dropped |
| unit | `capture-act.test.ts` (fake `ActDeps`, fake classify/configured) | each step's refusal in order; claim CAS loses cleanly when the row moved or expired; `ok`/`rejected`/throw → right terminal state + audit; `formatActionConsent` carries verbatim input + provenance; `outcomeRefOf` (https only, ≤ 512, field order); `act` absent → refuses |
| unit | `capture-gate.test.ts` | submit async; step 5a/5b refusals audited; action vs native pending caps separate; reject on action works; revoke on action refuses; lazy expiry audited per row |
| unit | `capture-store.test.ts` | `countPendingActions` excludes expired; `countPendingNative` excludes actions; `expireDueActions` returns exactly the due ids |
| unit | `mcp-sink-toml.test.ts` | default kinds exclude `action`; `action` accepted when listed; TTL / pending bounds refuse loudly (write branch tests up front — 80% branch floor) |
| unit | `capture-capability.test.ts` | `actionEnabled` truth table incl. `mcp_action` lock-off and absent accessor |
| unit | `ipc/capture-rpc.test.ts` | the injected `execute` builds `{type, payload:{mcpToolId: <routing value>, input}}` for first-party and NO `mcpToolId` for user-MCP; consent wrapper replaces prompt/details; `delegation` undefined |
| unit (cli) | `capture-tools.test.ts` | `propose_action` absent unless `actionEnabled`; `capture_status` present with any kind; description lists types |
| unit (cli) | `captures.test.ts` | accept of an action refuses without TTY; native accept unchanged; result branches for executed/rejected/failed wording + exit codes |
| integration | `test/integration/mcp-sink/capture-action-v69.test.ts` | V69 on a populated V68 DB: every row byte-identical, count asserted; each new CHECK rejects its invalid combination |
| integration | `test/integration/mcp-sink/capture-action-routing.test.ts` | the REAL `createConnectorDispatcher` over a fake mesh client whose tool map is keyed exactly as the mesh lists tools (`slack_slack_message_post`, `mcp_x_tool`): the action the capture-rpc `execute` builds resolves to the right tool for a first-party and a user-MCP type — the test the first draft lacked, which would have caught § 6.3 |
| integration | `test/integration/mcp-sink/capture-action-flow.test.ts` (real SQLite, real `ToolExecutor`, real egress sink, fake dispatcher) | accept → one egress row BEFORE dispatch; declined → `blocked` row, no dispatch, state `rejected`; consent disconnect → `rejected`; an active delegation is NOT consulted; lazy + boot expiry; boot reconcile `executing → failed`; retention keeps executed/failed, prunes expired/rejected |
| E2E | `packages/gateway/test/e2e/mcp-act-door.e2e.test.ts` | real gateway + real `nimbus mcp-server` (stdio) + a mock user-MCP server registered `--model`: `propose_action` → `capture_status` = proposed → owner IPC client `captures.accept` answering `consent.request` → mock server receives the call with the exact input → `capture_status` = executed; a non-`--model` server refused at submit; an expired action refused at accept. Proves outer IPC routing for `capture.state`. |
| invariant | `security-invariants.test.ts` | I28 row extended |
| static | invariant fixtures | D32(e)(f)(g) each red-proved |

The E2E uses a user-MCP mock because it is the only connector dispatched for real without cloud
credentials; first-party routing is proven by the routing integration test over the real
dispatcher plus the sync test over the real package.

## 14. Delivery

ONE PR, `feat(mcp): act door — agent-proposed connector actions, owner-accepted (S3, I28)` — no
`!` (default off twice; nothing an existing user must change). Splitting would ship either an
unacceptable queue or a door with no queue.

Docs in the same PR: `docs/SECURITY-INVARIANTS.md` § I28; `docs/architecture.md` § Spine S3;
`docs/cli-reference.md` (`captures accept` for actions, new MCP tools); `docs/CHANGELOG.md`;
`docs/roadmap.md` S3 row (capture sink 3/3 ✅); CLAUDE.md + GEMINI.md (I28 bullet, NINE AI_V2 names,
schema V69, D32 letters).

Out of scope, still owed: `nimbus negotiate`'s unattributable lane counting accepted agent
decisions (PR 2 follow-up).

## 15. Risks

- **Approval fatigue.** One keystroke approves an agent-written post. Mitigations: TTL; a small
  separate pending cap; the provenance header labelling the summary unverified; default off twice;
  org lock-off. Residual stated in I28.
- **Classification / routing staleness.** The totality test forces a decision for every new HITL
  type; the routing sync test fails a connectors bump that renames or re-scopes a proposable tool.
  `audit:connector-version-skew` already forces those bumps through CI.
- **Ambiguous failures.** `failed` ≠ "didn't happen"; the CLI says so for transport-class codes.
- **Concurrent accept from CLI + another owner session.** The CAS claim makes exactly one win.
- **Long consent wait.** The row sits `executing` for as long as the prompt is open — bounded by the
  CLI's `BATCH_RPC_TIMEOUT_MS` (6 h); when the CLI gives up its connection closes, the coordinator's
  `onClientDisconnect` raises `ConsentDisconnectedError`, and the capture ends `rejected`.

## 16. Review disposition (2026-10-15 review)

| # | finding | disposition | where |
|---|---|---|---|
| 2.1 | first-party actions cannot dispatch by `action.type` | **FIXED — confirmed against the code.** Rather than the review's "normalise dots to underscores" (a naming convention, not a contract: `obsidian.note.append` → `obsidian_append_to_daily_note`, `google_drive.file.create` → `gdrive_file_create`) or a change to `registry.ts`, a gateway-owned routing table supplies the `mcpToolId`, proven against the installed package's `mutates:` registrations. Non-goals kept: no `registry.ts`/`tool-map.ts` change. | § 2, § 3, § 6.3, § 13 |
| 2.2 | `ToolExecutor.execute` takes no consent arg; rpc lacks provenance | **FIXED** as suggested: `ActDeps.execute(actionType, input, provenance)`, per-call `ToolExecutor` in `capture-rpc.ts`. | § 3, § 8 |
| 3.1 | `isConnectorConfigured` is async | **FIXED**: `submitCapture` async; `isServiceConfigured` injected. | § 7 |
| 3.2 | generic `email.*` / `calendar.event.create` vacuously configured | **FIXED**: also unroutable (no server named `email`/`calendar`) → new denied class `unroutable`. While re-deriving, `slack.chat.post`/`teams.chat.post` moved to new class `chatops_confined` (I23/D17 forbid naming their tool literals outside ChatOps). Proposable 36 → 30. | § 6.1 |
| 3.3 | `action-proposability.ts` in `mcp-sink/` breaks D32(f) | **FIXED differently**: rather than moving `isUserMcpActionType` (the user-MCP pattern lives in `connectors/user-mcp-store.ts`, also D32(f)-forbidden), the whole module moves to `connectors/proposable-actions.ts` and reaches the gate as injected functions — where the routing table (2.1) belongs anyway. | § 3, § 6 |
| 4.1 | no CHECK for action `item_id`/`native_ref` | **FIXED**. | § 4 |
| 4.2 | explicit column lists in the rebuild | **FIXED** (V68 precedent). | § 4 |
| 4.3 | `countByState("proposed")` counts both queues | **FIXED**: `countPendingActions(now)` / `countPendingNative()`. | § 4, § 7 |
| 4.4 | expiry audit undefined; batch update | **FIXED**: `capture.action.expire` row per capture; one `UPDATE … RETURNING` batch. Full audit table added for all action rows. | § 8.2, § 9 |
| 5.1 | CLI `assertAcceptResult` rejects action results | **FIXED**: state branches. | § 11 |
| 5.2 | TTY guard placement | **FIXED**: checked before connecting, stdin AND stdout, only for action targets so native accept stays scriptable. | § 11 |
| 5.3 | `CaptureStatus` fields | **FIXED** (field set adjusted: `pending` keeps its meaning; `actionTtlHours` added). | § 10 |
| 6 | consent TTL open point | **RESOLVED — verified**: `ipc/consent.ts` has no timer; only `onClientDisconnect` settles a pending request, and `ToolExecutor.gate()` maps `ConsentDisconnectedError` to `rejected`. | § 8 step 8, § 15 |

Nothing deferred.
