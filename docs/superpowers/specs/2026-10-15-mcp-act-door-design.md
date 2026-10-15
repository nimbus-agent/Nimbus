# S3 — MCP capture sink PR 3: the act door (I28 extended) — design

> **Status:** draft for owner review, 2026-10-15. PR 3 of 3 of the MCP capture sink. Branch
> `dev/asaf/s3-act-door`. This file never lands on `main` — strip it before the implementation PR.
> Builds on the PR 1/2 spec (`2026-10-11-mcp-capture-sink-design.md`, branch
> `dev/asaf/s3-mcp-capture-sink-pr2`), whose § 9 sketched this door and deferred it here.

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
   before dispatch (I29), and dispatches exactly the stored action — no other tool, no other input.
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
- No submit-time check that the connector actually exposes a tool for the action type (that would
  spawn the connector); an absent tool surfaces as `failed` at accept. Stated bound.
- No change to `engine/executor.ts` or `connectors/registry.ts`.

## 3. Architecture

```
MCP client ──stdio──▶ nimbus mcp-server (packages/cli/src/mcp/capture-tools.ts)
                        ├─ propose_action  ──IPC capture.submit──▶ capture-gate.submitCapture()   (I28 submit order)
                        └─ capture_status  ──IPC capture.state ──▶ capture-gate.captureStateFor()

owner CLI: nimbus captures accept <id> ──IPC captures.accept (withIpc, {kind:"prompt"}, BATCH timeout)
   ▼
ipc/capture-rpc.ts  builds ToolExecutor(bindConsentChannel(accepting client), audit, connector
                    dispatcher, delegation = undefined, makeEgressSink(db), policyHitl)
   ▼  injects execute() + consent channel
capture-gate.acceptCapture()  ── kind === "action" ──▶ capture-act.acceptAction()
   ▼
ToolExecutor.execute({type, payload:{input}})  → consent.request UNICAST to accepting client (I2)
                                               → egress_ledger row BEFORE dispatch (I29)
                                               → connectors.dispatch
```

New modules (gateway): `mcp-sink/capture-act.ts`, `mcp-sink/action-proposability.ts`,
`index/capture-action-v69-sql.ts`. Changed: `capture-types.ts`, `capture-validate.ts`,
`capture-gate.ts`, `capture-store.ts`, `capture-capability.ts`, `ipc/capture-rpc.ts`,
`config/mcp-sink-toml.ts`, `policy/types.ts`, `platform/assemble.ts` (wiring + boot reconcile),
doctor. CLI: `mcp/capture-tools.ts`, `commands/captures.ts`.

## 4. Data model — V69

SQLite cannot alter a CHECK, so V69 rebuilds `capture` (create `capture_new`, copy, drop, rename,
recreate the three indexes), inside the runner's transaction, asserting the row count before and
after — the same shape V68 used. Every V68 row is copied byte-identically (new columns NULL).

```sql
CREATE TABLE capture (
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
  CHECK (outcome_ref IS NULL OR (kind = 'action' AND state = 'executed' AND length(outcome_ref) <= 512)),
  CHECK (error_code  IS NULL OR (kind = 'action' AND state = 'failed'   AND length(error_code)  <= 64))
)
```

An action never has an `item_id` (it is never indexed or embedded) and never a `native_ref`.
`CURRENT_SCHEMA_VERSION` → 69. D32(a)'s allow-list gains `index/capture-action-v69-sql.ts`.

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
| `kinds` | `["note","decision","term","link"]` | — | **`"action"` must be listed explicitly.** `DEFAULT_MCP_SINK_CONFIG.kinds` stays the four; `CAPTURE_KINDS` gains `"action"` but the default is now a separate constant, so enabling the sink never enables the act door. |
| `action_ttl_hours` | 24 | 1..168 | refused loudly out of range |
| `action_max_pending` | 10 | 1..100 | counted separately from `max_pending` (unexpired `proposed` actions only) |

`max_per_hour` (the durable hourly cap) counts actions with every other kind.

Policy: `AI_V2_CAPABILITIES` gains `"mcp_action"` (the NINTH name). `CaptureCapability` grows a
`actionEnabled` field computed as `sink enabled ∧ "action" ∈ kinds ∧ ¬policy(mcp_capture) ∧
¬policy(mcp_action)`, fail-closed when the policy accessor is absent — read LIVE per call, as
`mcp_capture` is.

## 6. Proposability — `mcp-sink/action-proposability.ts`

```ts
type Proposability =
  | { readonly kind: "proposable" }
  | { readonly kind: "denied"; readonly class: DeniedClass };

export const ACTION_PROPOSABILITY: Readonly<Record<string, Proposability>>;  // keys == HITL_REQUIRED
export function classifyActionType(
  actionType: string,
  ctx: { modelAccessServices(): ReadonlySet<string>; userMcpModelAccessAllowed(): boolean },
): Proposability | { kind: "unknown" };
```

- A first-party type is proposable iff its table entry is `proposable`.
- A user-MCP type (`isUserMcpActionType`) is proposable iff its service id is in
  `listModelAccessServiceIds()` (the `model_access = 1` rows) AND the `user_mcp_model_access`
  capability is on (live, fail-closed — the same source `user-mcp-model-capability.ts` reads).
- Anything else (non-HITL type, unknown string) → `unknown` → refused.
- **Totality test:** `Object.keys(ACTION_PROPOSABILITY).sort()` deep-equals `[...HITL_REQUIRED].sort()`.
  Adding an action type to `executor.ts` fails this test until it is classified.

### 6.1 Initial classification (139 types — review line by line)

**Proposable (36):**

| group | types |
|---|---|
| chat | `slack.message.post`, `slack.chat.post`, `teams.message.post`, `teams.message.postChat`, `teams.chat.post` |
| email | `email.send`, `email.draft.send`, `email.draft.create`, `gmail.draft.create`, `gmail.draft.send`, `gmail.message.send`, `outlook.mail.send`, `fastmail.mail.send`, `imap.mail.send`, `protonmail.mail.send`, `apple.mail.send`, `apple.mail.draft.create` |
| calendar (create only) | `calendar.event.create`, `outlook.calendar.create`, `apple.calendar.event.create` |
| tickets / issues | `linear.issue.create`, `linear.issue.update`, `linear.comment.create`, `jira.issue.create`, `jira.issue.update`, `jira.comment.add`, `github.issue.create` |
| docs | `notion.page.create`, `notion.page.update`, `notion.block.append`, `notion.comment.create`, `confluence.page.create`, `confluence.page.update`, `confluence.comment.add`, `obsidian.note.append`, `google_drive.file.create` |

The implementation's test pins this exact list, not a count. Denied: 103 (11 + 3 + 11 + 11 + 10 + 6 +
6 + 8 + 11 + 8 + 2 + 16 below); 36 + 103 = 139 = `HITL_REQUIRED.size` at `436937b9`.

**Denied (by class):**

| class | types |
|---|---|
| `file` | `file.delete`, `file.move`, `file.rename`, `file.create`, `photo.delete`, `onedrive.delete`, `onedrive.move`, `onedrive.item.delete`, `onedrive.item.move`, `google_drive.file.move`, `google_drive.file.rename` |
| `calendar_delete` | `calendar.event.delete`, `outlook.calendar.delete`, `apple.calendar.event.delete` |
| `vcs` | `repo.pr.merge`, `repo.pr.close`, `repo.branch.delete`, `repo.tag.create`, `repo.commit.push`, `github.pr.merge`, `github.pr.close`, `github.branch.delete`, `github.tag.create`, `bitbucket.pr.merge`, `gitlab.mr.merge` |
| `pipeline` | `pipeline.trigger`, `pipeline.cancel`, `pipeline.rerun`, `jenkins.build.trigger`, `jenkins.build.abort`, `github_actions.run.trigger`, `github_actions.run.cancel`, `circleci.pipeline.trigger`, `circleci.job.cancel`, `gitlab.pipeline.retry`, `gitlab.pipeline.cancel` |
| `cloud` | `aws.ecs.service.update`, `aws.lambda.invoke`, `aws.ec2.instance.stop`, `aws.ec2.instance.start`, `azure.app_service.restart`, `azure.aks.node_pool.scale`, `gcp.cloud_run.deploy`, `gcp.gke.workload.restart`, `cloud.resource.scale`, `cloud.resource.stop` |
| `iac` | `iac.terraform.apply`, `iac.terraform.destroy`, `iac.cloudformation.deploy`, `iac.pulumi.up`, `infra.apply`, `infra.destroy` |
| `k8s` | `kubernetes.rollout.restart`, `kubernetes.pod.delete`, `kubernetes.deployment.scale`, `k8s.apply`, `k8s.delete`, `k8s.rollout.restart` |
| `deployment` | `deployment.apply`, `deployment.rollback`, `argocd.app.sync`, `argocd.app.rollback`, `flux.kustomization.reconcile`, `flux.helmrelease.reconcile`, `mlflow.model.promote`, `mlflow.model.transition_stage` |
| `incident` | `pagerduty.incident.acknowledge`, `pagerduty.incident.resolve`, `pagerduty.incident.escalate`, `alert.acknowledge`, `alert.silence`, `incident.escalate`, `incident.resolve`, `montecarlo.incident.acknowledge`, `montecarlo.incident.resolve`, `bigeye.issue.acknowledge`, `bigeye.issue.resolve` |
| `data_platform` | `snowflake.tag.set`, `snowflake.comment.set`, `tableau.datasource.refresh`, `tableau.workbook.refresh`, `looker.datagroup.trigger`, `looker.schedule.run_once`, `powerbi.dataset.refresh`, `powerbi.dataflow.refresh` |
| `tribal_kb` | `notion.knowledge.write`, `confluence.knowledge.write` — I25/D19: destination is config-pinned and the tool ids are confined to the tribal write gate |
| `gateway_internal` | `data.delete`, `data.export`, `connector.remove`, `connector.adoptLocalAuth`, `connector.addMcp`, `connector.reindex`, `extension.autoUpdate`, `extension.downgrade`, `extension.install`, `vault.set`, `vault.delete`, `teamvault.put`, `teamvault.delete`, `share.publish`, `egress.prune`, `tool.save` |

### 6.2 Borderline — owner to confirm

Classified **denied** in the draft; flip any to proposable at review:

- `pagerduty.incident.acknowledge` / `alert.acknowledge` — low blast radius, but an ack silences a
  page for a human on call; an agent should not be able to queue that.
- `github.pr.close` / `repo.pr.close` — reversible, but closes someone else's work.
- `tableau.*.refresh` / `powerbi.*.refresh` — idempotent, but cost-bearing on the warehouse.
- `google_drive.file.create` is drafted **proposable**; `file.create` (local FS) **denied**.

## 7. Submit — `propose_action` → `submitCapture`

The PR 1/2 fixed order is unchanged; `action` plugs into existing steps:

| step | action-specific behaviour | refusal |
|---|---|---|
| 1 capability | requires `actionEnabled` when `kind === "action"` (unaudited, like today) | `ERR_CAPTURE_DISABLED` |
| 2 client kind | declared `mcp` only (unchanged) | `ERR_CAPTURE_FORBIDDEN_CLIENT` |
| 3 attempt limit | unchanged | `ERR_CAPTURE_RATE_LIMITED` |
| 4 kind allowed | `"action" ∈ kinds` | `ERR_CAPTURE_KIND_NOT_ALLOWED` |
| 5 whitelist rebuild | rebuild `{actionType, input, summary}` only; `actionType` non-empty ≤ 128; `input` a plain JSON object; **`mcpToolId` as a key of `input` REFUSES** (never dropped); `summary` truncates at 300; 64 KiB total cap | `ERR_CAPTURE_INVALID` |
| 5a proposability (NEW) | `classifyActionType` must return `proposable` | `ERR_CAPTURE_ACTION_NOT_PROPOSABLE` (audited) |
| 5b configured (NEW) | `isConnectorConfigured(serviceOf(actionType))`; a user-MCP service is configured iff registered | `ERR_CAPTURE_CONNECTOR_UNCONFIGURED` (audited) |
| 6 referenced items | n/a (an action references no items) | — |
| 7 hourly cap | unchanged, counts actions | `ERR_CAPTURE_RATE_LIMITED` |
| 8 pending cap | actions counted against `action_max_pending` (unexpired `proposed` actions) instead of `max_pending` | `ERR_CAPTURE_QUEUE_FULL` |
| write | state `proposed`, `expires_at = now + ttl`, no item, audit `capture.submit` | — |

Why refuse `mcpToolId` rather than drop it: `connectors/registry.ts`'s dispatcher resolves a
payload `mcpToolId` to a tool on the action type's server, while the HITL gate reads only
`action.type` (I3). A dropped key is indistinguishable from an honest payload; a refusal tells the
agent and the audit log that it tried. The action the act door builds never carries the key at all
(§ 8 step 6), so this is defence in depth over construction.

Submit returns `{id, expiresAt}`.

## 8. Accept — `acceptCapture` → `capture-act.ts` `acceptAction()`

`acceptCapture(deps, caller, id, act?)` keeps its synchronous path for the native kinds. For a row
with `kind === "action"` it returns `acceptAction(...)` (async); the RPC handler awaits either.
`act` carries the injected `execute(action, consent)` and the accepting client's `ConsentChannel`;
an action accept with `act` absent refuses (`ERR_CAPTURE_DISABLED`) — no fallback.

Fixed order:

1. **Capability** — `actionEnabled` (live, fail-closed). → `ERR_CAPTURE_DISABLED`
2. **Owner only** — `requireOwner(caller)` (refuses `mcp`, as today).
3. **State + expiry** — must be `proposed`; if `now ≥ expires_at`, CAS `proposed → expired`,
   audit, refuse `ERR_CAPTURE_EXPIRED`.
4. **Re-classify** — proposability and configured-ness re-checked against current state
   (`--model` may have been revoked, policy tightened, connector removed). Refusal leaves the row
   `proposed` (the owner may fix config and retry before expiry). →
   `ERR_CAPTURE_ACTION_NOT_PROPOSABLE` / `ERR_CAPTURE_CONNECTOR_UNCONFIGURED`
5. **Claim** — ONE transaction: `UPDATE capture SET state='executing', decided_at=? WHERE id=? AND
   state='proposed'`; zero rows changed → `ERR_CAPTURE_STATE`; audit `capture.action.accept`.
6. **Build** — from the row read in step 3 (read ONCE; no re-read after the claim):
   `{ type: payload.actionType, payload: { input: payload.input } }`. Never `mcpToolId`.
7. **Execute** — `await act.execute(action, provenanceConsent)` where `provenanceConsent` wraps the
   accepting client's channel and REPLACES the prompt/details with:
   ```
   Agent-proposed action — requires your approval
   Proposed by MCP client "<client_label|unlabelled>" at <created_at ISO>, expires <expires_at ISO>
   Agent's summary (unverified): <summary>
   Type: <actionType>
   Input (verbatim, exactly what will be sent):
   <JSON.stringify(input, null, 2)>
   ```
   Details are passed UNREDACTED: the values are agent-authored, never Vault-sourced, and are shown
   on the owner's own terminal; `redactPayloadForConsentDisplay`'s substring regex (`token|key|…`,
   which also matches `keywords`, `monkey`, `author`) would otherwise let a prompt-injected agent
   hide the field it wants approved — the reasoning `consentDisplayPayload` already applies to I42.
   The executor's own audit row keeps `redactAuditPayload`.
8. **Finalize** — ONE transaction + audit `capture.action.outcome`:
   - `{status:"ok"}` → `executed`, `outcome_ref` = first top-level string among `url`, `html_url`,
     `webUrl`, `permalink` with length ≤ 512 and an `https:` scheme, else NULL. The result body is
     not stored.
   - `{status:"rejected"}` (owner declined the prompt / consent disconnected) → `rejected`.
   - thrown → `failed`, `error_code` = a classified short code (`ERR_ACTION_TIMEOUT`,
     `ERR_ACTION_TOOL_NOT_FOUND`, `ERR_ACTION_DISPATCH`), never the message text.
   - a finalize failure after a successful dispatch is logged loudly and the row stays `executing`;
     the boot reconcile turns it `failed` (§ 9). Stated bound: such a row may have executed.

Return: `{id, state, outcomeRef?, errorCode?}`.

New `CaptureErrorCode` members: `ERR_CAPTURE_ACTION_NOT_PROPOSABLE`, `ERR_CAPTURE_CONNECTOR_UNCONFIGURED`,
`ERR_CAPTURE_EXPIRED`. Stored `error_code` values (not thrown): `ERR_ACTION_TIMEOUT`,
`ERR_ACTION_TOOL_NOT_FOUND`, `ERR_ACTION_DISPATCH`, `ERR_ACTION_INTERRUPTED`.

### 8.1 Reject / revoke

- `captures reject <id>` on a `proposed` action → `rejected` (existing path, kind-agnostic).
- `captures revoke <id>` on any action → `ERR_CAPTURE_STATE` ("an executed action cannot be
  undone; reject a proposed one").

## 9. Expiry, reconcile, retention

- **Lazy expiry**: `getCapture`, `listCaptures`, `captureStateFor` and accept step 3 report/transition
  a past-`expires_at` `proposed` action as `expired` (the read paths transition via a CAS UPDATE so
  the state they report is the stored state).
- **Boot sweep** (beside the existing `pruneRejected`): `proposed` actions past `expires_at` →
  `expired`; `executing` actions → `failed` with `error_code = 'ERR_ACTION_INTERRUPTED'` — never
  back to `proposed`.
- **Retention**: `expired` and `rejected` actions are pruned on the existing
  `REJECTED_RETENTION_MS` clock from `decided_at` (expired rows set `decided_at` at transition).
  `executed` and `failed` rows are KEPT — the history of what agents caused.

## 10. Agent surface

`packages/cli/src/mcp/capture-tools.ts`, registered only when `capture.status` reports
`actionEnabled` and `declareKind("mcp")` succeeded:

- **`propose_action`** `{actionType: string, input: object, summary: string}` →
  `Proposed cap_… — expires <ISO>. The owner must accept it with \`nimbus captures accept\`.`
  Its description lists the proposable action types for currently configured connectors plus the
  `--model` user-MCP servers, obtained from `capture.status` (new field `proposableActionTypes`,
  sorted, capped at 200 entries).
- **`capture_status`** `{id: string}` → `{kind, state, expiresAt?, outcomeRef?, errorCode?}`.
  Registered whenever ANY capture kind is enabled (a decision proposer benefits too). Backed by new
  IPC `capture.state` — `mcp` kind only (the owner uses `captures.get`); no payload, no session
  data, no listing. Unknown id → `ERR_CAPTURE_NOT_FOUND`. The `capture.*` namespace is already
  LAN-forbidden and absent from the Tauri allowlist; no HTTP route.

## 11. Owner surface

- `nimbus captures accept <id>`: `withIpc(c => c.call("captures.accept", {id}), {kind:"prompt"},
  BATCH_RPC_TIMEOUT_MS)`. No TTY → refuse up front (exit 1, message names the TTY requirement),
  never auto-approve. Output: `executed <outcomeRef|—>`, `rejected`, or
  `failed <code> — the action may or may not have reached <service>` for `ERR_ACTION_TIMEOUT` /
  `ERR_ACTION_DISPATCH` / `ERR_ACTION_INTERRUPTED`.
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
> atomic claim → the action rebuilt from the stored row, read once, never carrying `mcpToolId` →
> `ToolExecutor` with the ACCEPTING session's consent channel and no delegate, so I2, I29, I22 and
> I42 apply unchanged → one terminal outcome, never retried. The owner is shown the verbatim stored
> input with its agent provenance. **Bounds:** approval proves the owner saw the call, not that it
> is wise; a transport failure is recorded `failed` though the remote may have acted; `outcome_ref`
> is a heuristic; whether the connector exposes a tool for the type is learned only at accept.

Triple rule: `docs/SECURITY-INVARIANTS.md` § I28, CLAUDE.md + GEMINI.md I28 bullets, and the
`security-invariants.test.ts` I28 row extended (accept-of-action reaches `execute` only after the
claim; a built action has no `mcpToolId`; `delegation` is `undefined` at the capture-rpc site).

### 12.2 D32 additions (`scripts/structure-audit/check-nimbus-invariants.ts`)

- **D32(e)** — `acceptAction` is defined only in `capture-act.ts` and called only from
  `capture-gate.ts`.
- **D32(f)** — no file under `packages/gateway/src/mcp-sink/` imports `engine/executor.ts` or any
  module under `connectors/` (type-only imports included). Execution reaches `capture-act.ts` only
  as an injected function; `ipc/capture-rpc.ts` is the one place it is built. Capability
  confinement is the primary defence.
- **D32(g)** — the `mcpToolId` literal (comment-stripped) appears under `mcp-sink/` only in
  `capture-validate.ts`.

Each red-proved by a fixture that must fail. Stated bound as D32(a): a dynamically composed string
evades a text scan.

## 13. Testing

| layer | file | proves |
|---|---|---|
| unit | `action-proposability.test.ts` | key set == `HITL_REQUIRED`; exact proposable list pinned; non-HITL/unknown → `unknown`; user-MCP proposable only with `model_access = 1` AND policy on; policy accessor absent → denied |
| unit | `capture-validate.test.ts` | `mcpToolId` key refuses; non-object / array `input` refuses; `actionType` bounds; `summary` truncates; 64 KiB cap; sibling keys dropped |
| unit | `capture-act.test.ts` (fake `execute`, fake consent) | each step's refusal in order; claim CAS loses cleanly when the row moved; `ok`/`rejected`/throw → right terminal state + audit; prompt text carries verbatim input + provenance; details unredacted; built action has no `mcpToolId` and `type === actionType`; `outcome_ref` extraction (https only, ≤ 512, field order); `act` absent → refuses |
| unit | `capture-gate.test.ts` | submit step 5a/5b refusals audited; action pending cap separate; reject on action works; revoke on action refuses |
| unit | `mcp-sink-toml.test.ts` | default kinds exclude `action`; `action` accepted when listed; TTL / pending bounds refuse loudly (write branch tests up front — 80% branch floor) |
| unit | `capture-capability.test.ts` | `actionEnabled` truth table incl. `mcp_action` lock-off and absent accessor |
| unit (cli) | `capture-tools.test.ts` | `propose_action` absent unless `actionEnabled`; `capture_status` present with any kind; description lists types |
| unit (cli) | `captures.test.ts` | accept refuses without TTY; failed-output wording per code |
| integration | `test/integration/mcp-sink/capture-action-v69.test.ts` | V69 on a populated V68 DB: every row byte-identical, count asserted; new CHECKs reject invalid kind/state/expires/outcome/error combos |
| integration | `test/integration/mcp-sink/capture-action-flow.test.ts` (real SQLite, real `ToolExecutor`, real egress sink, fake dispatcher) | accept → one egress row BEFORE dispatch, dispatcher receives exactly `{type, {input}}`; declined → `blocked` row, no dispatch, state `rejected`; an active delegation is NOT consulted; lazy + boot expiry; boot reconcile `executing → failed`; retention keeps executed/failed, prunes expired/rejected |
| E2E | `packages/gateway/test/e2e/mcp-act-door.e2e.test.ts` | real gateway + real `nimbus mcp-server` (stdio) + a mock user-MCP server registered `--model`: `propose_action` → `capture_status` = proposed → owner IPC client `captures.accept` answering `consent.request` → mock server receives the call with the exact input → `capture_status` = executed; a non-`--model` server refused at submit; an expired action refused at accept. Proves outer IPC routing for `capture.state`. |
| invariant | `security-invariants.test.ts` | I28 row extended |
| static | invariant fixtures | D32(e)(f)(g) each red-proved |

The E2E uses a user-MCP mock because it is the only connector that can be dispatched for real
without cloud credentials; first-party types are covered at the integration layer.

## 14. Delivery

ONE PR, `feat(mcp): act door — agent-proposed connector actions, owner-accepted (S3, I28)` — no
`!` (default off twice; nothing an existing user must change). Splitting would ship either an
unacceptable queue or a door with no queue.

Docs in the same PR: `docs/SECURITY-INVARIANTS.md` § I28; `docs/architecture.md` § Spine S3; `docs/cli-reference.md`
(`captures accept` for actions, new MCP tools); `docs/CHANGELOG.md`; `docs/roadmap.md` S3 row (capture sink 3/3 ✅);
CLAUDE.md + GEMINI.md (I28 bullet, NINE AI_V2 names, schema V69, D32 letters).

Out of scope, still owed: `nimbus negotiate`'s unattributable lane counting accepted agent
decisions (PR 2 follow-up).

## 15. Risks and open points

- **Approval fatigue.** One keystroke approves an agent-written post. Mitigations: TTL; a small
  separate pending cap; the provenance header labelling the summary unverified; default off twice;
  org lock-off. Residual stated in I28.
- **Classification staleness.** Mitigated by the totality test; the risk shifts to a reviewer
  classifying a new type carelessly — the per-entry table is reviewed in the PR.
- **Ambiguous failures.** `failed` ≠ "didn't happen"; the CLI says so for transport-class codes.
- **Executor result shape.** `ActionResult` `{status:"ok", result}` carries the connector's raw
  result; `outcome_ref` extraction reads only top-level fields and tolerates anything.
- **Concurrent accept from CLI + another owner session.** The CAS claim makes exactly one win.
- **Long consent wait.** `BATCH_RPC_TIMEOUT_MS` bounds the CLI. A consent that ends by disconnect
  (`ConsentDisconnectedError`) is `rejected` by the executor, so the capture ends `rejected`, not
  `failed`. **To verify at planning:** whether the consent coordinator has its own TTL and what
  `gate()` returns when it fires — the plan must pin the terminal state for that path.
