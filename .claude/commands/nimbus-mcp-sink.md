---
name: nimbus-mcp-sink
description: >
  S3 MCP capture sink — the MCP server's write doors (invariant `I28` / static `D32(a)–(g)`,
  schema V67–V69). Content from an MCP client enters Nimbus only through
  `mcp-sink/capture-gate.ts` `submitCapture()` in a fixed order; `capture_note` writes a live,
  local-embed-only `nimbus:capture` item; `propose_decision`/`propose_term`/`propose_link` queue
  INERT proposals that count only after the owner's `acceptCapture()` (`'agent'` provenance, an
  I31-anchored disclosure); `propose_action` queues a connector action that runs only through
  `mcp-sink/capture-act.ts` `acceptAction()` and then the executor's own HITL prompt, dispatched to
  the ONE tool the write row names (`agentDoorRow` in `connectors/connector-writes/agent-door.ts`; the old routing table `connectors/proposable-actions.ts` was deleted in AD3b). Use when
  touching `packages/gateway/src/mcp-sink/`, `packages/gateway/src/ipc/capture-rpc.ts` or `packages/gateway/src/ipc/approvals-rpc.ts`, the MCP
  write tools (`capture_note`, `propose_decision`, `propose_term`, `propose_link`,
  `propose_action`, `describe_actions`, `capture_status`), `nimbus captures list|show|accept|reject|revoke|purge`, `nimbus approvals` (the owner's queue and one-step approval of an action proposal), the
  `[mcp_sink]` config, the `mcp_capture`/`mcp_action` org-policy lockoffs, making an action type
  proposable, adding a capture kind, or asking why a capture/proposal/action was refused.
---

# Nimbus S3 — MCP capture sink (I28 / D32)

## Why This Skill Exists

The MCP server was read-only until S3. The capture sink gives an MCP client (an editor AI) three
write doors into the owner's private index, and the writer is by definition **untrusted**: a model
the owner does not control, possibly steered by injected text. So every door is one gate with a
fixed order, everything but a note is inert until the owner accepts it, and an action leaves the
machine only through the same `ToolExecutor` HITL gate an owner-initiated action uses. DEFAULT OFF
(`[mcp_sink] enabled = false`); the act door is off even when the sink is on, unless `kinds`
lists `action`.

## The three doors

| Door | MCP tool(s) | Lands as | Becomes real when |
|---|---|---|---|
| Capture (PR 1, V67) | `capture_note` | `capture` row `live` + a `nimbus:capture` item | immediately (searchable unreviewed, by design) |
| Propose (PR 2, V68) | `propose_decision`, `propose_term`, `propose_link` | `capture` row `proposed`, NO item, NO native row, NO embedding | owner `nimbus captures accept <id>` |
| Act (PR 3, V69) | `propose_action`, plus `capture_status` to poll | `capture` row `proposed` with an `expires_at` | owner accept (TTY) AND the executor's HITL prompt |

States (`CAPTURE_STATES` in `mcp-sink/capture-types.ts`): `live`, `proposed`, `accepted`,
`rejected`, `revoked`, `executing`, `executed`, `failed`, `expired`. Kinds: `CAPTURE_KINDS`
(`note`/`decision`/`term`/`link`/`action`); `DEFAULT_CAPTURE_KINDS` omits `action`.

## Door 1 — `submitCapture()` fixed order

All three doors share this one entry (`capture.submit`). Order is the invariant; do not reorder.

| # | Check | Refusal | Audited? |
|---|---|---|---|
| 1 | Capability: config + LIVE org policy `mcp_capture` (absent accessor = disabled); an `action` also needs `actionEnabled` (`mcp_action` + `kinds`) | `ERR_CAPTURE_DISABLED` | no — counted |
| 2 | Caller declared the `mcp` kind (`CAPTURE_ROLE_BY_KIND` → `submit`) | `ERR_CAPTURE_FORBIDDEN_CLIENT` | no — counted |
| 3 | Gateway-wide attempt limit (`CaptureAttemptLimiter`, before any validation) | `ERR_CAPTURE_RATE_LIMITED` | no — counted |
| 4 | Kind allowed by `[mcp_sink] kinds` and `SUBMITTABLE_KINDS` | `ERR_CAPTURE_KIND_NOT_ALLOWED` | yes |
| 5 | Whitelist rebuild per kind (`capture-validate.ts`; unknown siblings dropped, caps enforced) | `ERR_CAPTURE_INVALID` | yes |
| 5a/5b | Action only: proposable now, its destination allowed (`actionDestinationRefusal` = the door's `refusal`, the model door's `modelWriteRefusal` since AD3b: a ChatOps channel, a broadcast mention, a GitLab quick action or scoped label, a draft, page, note or markup file that loads remote content (since B3r), a sent Outlook HTML mail, Teams HTML message or GitHub, GitLab or Linear Markdown body that loads remote content (since B3w), a calendar or Drive create with an optional field set to `null`, an Outlook or iCloud calendar event whose time does not show its zone or an iCloud event field or attendee with a line break or control character (since B4a), a model-door rule for a commit, an IaC, Kubernetes or deploy write, or a KB page target is refused), and its connector configured | `ERR_CAPTURE_ACTION_NOT_PROPOSABLE` / `ERR_CAPTURE_ACTION_REFUSED` / `ERR_CAPTURE_CONNECTOR_UNCONFIGURED` | yes |
| 6 | Referenced items exist (a link's endpoints must resolve) | `ERR_CAPTURE_UNKNOWN_ITEM` | yes |
| 7 | Durable hourly cap, read from the `capture` table (survives restart) | `ERR_CAPTURE_RATE_LIMITED` | yes |
| 8 | Pending cap, proposals only (`max_pending`; actions `action_max_pending`) | `ERR_CAPTURE_QUEUE_FULL` | yes |
| 9–10 | ONE transaction: `capture` row, item (notes only), `capture.submit` audit row; audit failure rolls all back | — | — |

Steps 1–3 refuse **without** an audit row on purpose (`refuseUnaudited`): they are counted
(`CaptureRefusalCounter`, surfaced by `capture.status`) so an unauthenticated flood cannot grow the
audit log; steps 4+ are bounded by step 3 and audited.

Capture items: type `nimbus:capture`, `agentAuthored: true` in metadata, embedded by the LOCAL
embedder only (`LOCAL_ONLY_PROSE_TYPES` in `packages/gateway/src/embedding/routing.ts`), and never
fed to decision/glossary extraction.

## Door 2 — proposals and `acceptCapture()`

`acceptCapture()` order: capability (a disabled sink FREEZES accept; reject/revoke still work) →
owner kind → row exists → (an `action` row branches to `acceptAction()` here) → `proposed` state →
referenced items still exist → kind precondition (`assertAcceptable` in `capture-native.ts`) →
ONE transaction: native row via `writeCaptureNative`, `markAccepted`, the `nimbus:capture` item,
and a `capture.accept` audit row with `hitl_status = 'not_required'`.

| Kind | Native row written | Notes |
|---|---|---|
| decision | `decision_record`, `extraction_source = 'agent'`, `capture_id` owner | `insertAgentDecision` (`decisions/decision-store.ts`) |
| term | `glossary_term`, `definition_source = 'agent'`, `capture_id` owner | `upsertAgentTerm` (`glossary/glossary-store.ts`); a `manual` (nimbus.toml) term wins → `ERR_CAPTURE_SUPERSEDED`; a model-`vetoed` term does NOT refuse |
| link | plain `graph_relation` of a `captured_*` type, owned via the capture's `native_ref` `from\|to\|type` | endpoint gone → `ERR_CAPTURE_LINK_UNRESOLVED` |

Rules that follow from it:

- **An accepted term is never projected** as a glossary item: `nimbus:glossary_term` is in
  `PROSE_HEAVY_TYPES` (remote-embedded when an OpenAI key resolves). Search finds it only through
  its local-only capture item.
- **Rebuilds keep agent rows.** `glossary --rebuild` / `decisions --rebuild` delete only
  non-`'agent'` rows; revoke is how an agent row leaves. `captured_*` edges are exempted from the
  graph populator's re-sync clear (`CROSS_ITEM_RELATION_TYPES` in
  `packages/gateway/src/graph/graph-populator.ts`).
- **Disclosure (I31):** accepted agent decisions/terms render with `AGENT_CAPTURE_ANCHOR`
  ("captured via MCP, accepted by the owner") from
  `packages/gateway/src/agents/_lib/brief-disclosures.ts`.
- **Revoke deletes only what the capture still owns** (`revokeCaptureNative`; `captureNativeStatus`
  reports owned / superseded / absent, shown by `nimbus captures show`). Audited `not_required`.
- **Reject** needs no capability, so the owner can drain the queue under a policy lock.
- **Batch:** `nimbus captures accept --all [--kind decision|term|link]` is a CLI loop over
  `captures.list` + `captures.accept` (no gateway method), asks once, needs a TTY, and **never takes
  an action** — `--kind action` parses only so it can say why it refuses.

## Door 3 — the act door, `acceptAction()`

`mcp-sink/capture-act.ts`, reached only from `acceptCapture()` (D32(e)). Fixed order:

1. Capability incl. `mcp_action` (live, fail-closed); no `ActDeps` → `ERR_CAPTURE_DISABLED`.
2. Owner only.
3. `proposed` and not expired (`ERR_CAPTURE_EXPIRED`; TTL `action_ttl_hours`). The row is read once.
4. Re-derive the verdict (the agent door's `verdict`, through `requireVerdictAtApproval`) and re-check
   configured-ness: an approval removed, a wave lowered, a policy tightening or a changed definition
   since submit takes effect here, and a proposal queued before AD3b for a type the owner never approved
   is refused here and stays proposed. 4b (Phase 9.7 B1): the destination again, `actionDestinationVerdict`
   over the injected `actionDestinationRefusal` (the door's `refusal`, which since AD3b is the model
   door's `modelWriteRefusal` alone: `messagingDestinationRefusal`, the commit, IaC, Kubernetes and
   deploy rules, then `knowledgeBaseRefusal`; built in `agent-door-runtime.ts`, both accessors read per
   call, and wired in `platform/assemble.ts` with `() => tribalKbConfigOf(tribalCfg)`): a ChatOps
   binding added since submit, a broadcast mention, a GitLab quick action or scoped label, a draft,
   page, note, markup file, Teams HTML message or GitHub, GitLab or Linear Markdown body that loads
   remote content, a calendar or Drive create with an optional field set to `null`, an Outlook or iCloud
   calendar event whose time does not show its zone or an iCloud event field or attendee with a line
   break or control character, or a page write to the tribal KB destination → `ERR_CAPTURE_ACTION_REFUSED`,
   the row stays proposed. (A Linear `assigneeId` and a page update under the KB are the executor's
   before-state guards, not the door's.)
5. Atomic claim (CAS incl. the expiry predicate) → `executing`.
6. Rebuild the action from the stored row.
7. Execute via `ActDeps.execute`, built per accept by `buildActDeps` in `ipc/capture-rpc.ts`: a
   fresh door executor (`buildAgentWriteExecutor`, the SAME maker as the model door's, Phase 28 AD1)
   bound to the ACCEPTING session's consent channel, **no delegate**, no standing rule, the real
   egress sink and policy overlay — so I2, I29, I22 and I42 apply unchanged. The proposal runs as an
   `origin: "agent"` action with a gateway-set `proposer`. The consent prompt is the EXECUTOR'S own
   (the typed preview with the target's current state, or the verbatim input for an untemplated
   row, invisibles rendered visibly), then the proposer as a trailing UNVERIFIED block
   (`engine/proposer-block.ts`). The old `provenanceConsent` wrapper is deleted.
8. Finalize in one transaction: `executed` (with a heuristic `outcome_ref`) or `failed` with a
   classified code (`ACTION_ERROR_CODES`: `ERR_ACTION_TIMEOUT`, `ERR_ACTION_TOOL_NOT_FOUND`,
   `ERR_ACTION_DISPATCH`, `ERR_ACTION_INTERRUPTED`), or `rejected` on owner deny. Never retried.

Boot: `reconcileActionsAtBoot` (called from `packages/gateway/src/platform/assemble.ts`) expires
overdue rows and marks rows left `executing` by a dead process `failed` /
`ERR_ACTION_INTERRUPTED`. `expireDueActionsAudited` also runs on list/get/state/status, writing a
`capture.action.expire` audit row — so opening the desktop Captures page can expire an action.

**Tool selection is always gateway-derived.** `buildActDeps` dispatches
`proposableWriteTool(type) ?? userMcpToolKeyForActionType(type)` as the payload `mcpToolId`; no
routing row means `Tool not found`, never dispatch-by-type. An agent-supplied `mcpToolId` (beside
`actionType` or inside `input`) is REFUSED at submit by `validateActionPayload`.

### Proposability — the agent door's verdict (AD3b)

There is no classification table any more (`connectors/proposable-actions.ts` was deleted in AD3b). A
first-party type is proposable by an outside agent when `agentDoorRow(actionType)` finds a write row
and `agentOffered` holds: the owner enabled the service to the row's wave and approved the tool for
agents by name, the listed definition hashes to the stored value, policy allows `mcp_action` and
`connector_write_model_access`, and the row is offered to the model (never one of the 16 never-offered
rows: the seven mail sends, the Bitbucket merge, the owner-only iac rows, the four `az`/`gcloud`-read
cloud rows, the pod delete) and not the Slack DM row. Anything else is `denied` with a fixed `agent_*`
class (`agent_not_enabled`, `agent_wave`, `agent_not_approved`, `agent_policy`, `agent_no_scope`,
`agent_never_offered`, `agent_not_offerable`, `agent_unroutable`) or `unknown` (a HITL type no row
routes to, such as `extension.run`, `standing.rule.create` or `email.draft.create`). A `mcp_*` type is
proposable only for a tool the owner approved for agents by name (`user_mcp_not_registered`,
`agent_not_approved`, `agent_policy` otherwise); `ext_*` is `unknown`.
`createAgentDoor(...).acceptedTypes` is what `capture.status` advertises (the approved types of
configured services, sorted, plus approved user-MCP tools; no legacy entry, no `mcp_<id>.*` pattern;
`connectors/connector-writes/agent-door-runtime.ts`).

Counts: derive from `CONNECTOR_WRITE_ROWS` and `MODEL_NEVER_OFFERED_TOOL_IDS` (as of AD3b: 125 rows on
124 types, 16 never offered, so 109 model-offerable rows, 108 reachable by an agent).

**Mesh-only servers:** `obsidian.note.append` is proposable although `obsidian` is not a catalog
connector. `resolveServerTool` attributes keys with `meshServerForToolKey` — the catalog rule
`serviceIdForToolKey` plus `MESH_ONLY_SERVER_IDS` (`packages/gateway/src/connectors/lazy-mesh/tool-map.ts`) —
while the I22 policy filter keeps using `serviceIdForToolKey`, so obsidian stays outside the org
connector allowlist. The act door's configured-ness comes from
`packages/gateway/src/connectors/proposable-service-configured.ts` (obsidian = boot-time
`[[filesystem.roots]]` non-empty; it has no Vault keys, so the manifest check would say yes vacuously). An accepted `obsidian.note.append` still writes only while the owner's `connector writes enable obsidian` approval includes the append, because that approval is the Obsidian sandbox's write grant (I15, Phase 9.7 B4b); without it the sandbox refuses the write.

## Surfaces

- **MCP tools** (`packages/cli/src/mcp/capture-tools.ts`): registered once, at MCP-server spawn,
  from `capture.status` — each proposal tool only for a kind in `kinds`; `propose_action` follows
  `actionEnabled`, never `kinds` alone, and so does `describe_actions` (read-only; the type list lives there, `propose_action`'s text only points to it). Gateway down or `session.declareKind` failed → no tools.
- **IPC** (`ipc/capture-rpc.ts`, routed by `tryDispatchCaptureRpc` in `ipc/server/dispatchers.ts`):
  `capture.status` (any local client), `capture.submit`, `capture.state`, `capture.mine` and
  `capture.describe` (`mcp` only; `capture.state` answers only for ids the asking connection
  submitted, `capture.mine` lists its own, `capture.describe` returns the door's types and, for
  approved types named by the caller, the model door's description and schema; AD3a-2b), `captures.list|get|accept|reject|revoke|purge` (owner kinds `cli`/`ui`/`unknown`; `http`,
  `chatops`, `fleet`, `push` refused). Both namespaces LAN-forbidden; no HTTP route; only
  `captures.list`/`captures.get` on the Tauri allowlist
  (`packages/ui/src-tauri/src/gateway_bridge.rs`).
- **AD4 proof** (Phase 28): the executor's audit row of an accepted action names `{door, captureId, label, labelSource}` and its egress row `agent:<captureId>`. The owner reads them with `nimbus prove --by-proposer` (`audit.proveByProposer`, which compares the two ledgers capture by capture) and `nimbus audit --door agent` (`audit.listByDoor`, a filtered listing of `audit_log` that compares nothing), both `cli`/`ui` only; labels are the client's own claim.
- **Approvals IPC** (Phase 28 AD2, `ipc/approvals-rpc.ts`, routed by `tryDispatchApprovalsRpc`):
  `approvals.list|get|approve|decline` for a connection that DECLARED `cli` or `ui`
  (`APPROVER_BY_KIND`; `unknown` is refused here although `captures.*` serves it). `approve` reaches the
  act door only through `acceptCapture` (so `acceptAction` keeps its one caller, D32(e)) around the
  connection's own consent channel, which `buildActDeps` wraps in `humanOnlyConsent` (`ipc/consent.ts`) when asked for `humanOnly` (the option also sets `ActDeps.humanOnly`; `approvals-rpc.ts` wraps nothing): an answer whose
  `answerSource` is not `human` becomes a decline. The reply is `{ id, state, outcomeRef?, errorCode?, reason? }`;
  `reason` appears only on `rejected`, escaped, and is never stored (V69 allows no code on a rejected row).
  Static D32(b)/(c) allow exactly two RPC modules, `ipc/capture-rpc.ts` and `ipc/approvals-rpc.ts`.
  `approvals` is in the LAN denylist; not on the Tauri allowlist; no HTTP route.
  A connection holds at most `min(3, action_max_pending)` proposed actions; a queued action raises a
  count-only toast (`mcp-sink/capture-toast.ts`); ids come from `mcp-sink/capture-id.ts` (128 bits).
- **CLI** (`packages/cli/src/commands/approvals.ts`): `nimbus approvals [list] [--json]`, `show <id>`,
  `<id>` (approve in one step; needs a TTY, checked before any RPC; `--yes`, `-y` and
  `--script-consent-source` are usage errors; consent choice `{ kind: "human" }`), `<id> --decline`,
  `--decline-all-from <label>` (a CLI loop). `nimbus captures accept <id>` on an action is an alias
  that declares `cli` and calls `approvals.approve`.
- **CLI** (`packages/cli/src/commands/captures.ts`): `nimbus captures [list] [--state] [--kind]
  [--limit] [--json]`, `show`, `revoke`, `accept <id>`, `accept --all`, `reject`, `purge`. `purge`
  deletes a FINISHED action row (`executed`/`failed`/`rejected`/`expired`) and its stored input; the
  action is not undone. `nimbus doctor` reports the sink (`packages/cli/src/commands/doctor-core.ts`).
- **Desktop** (`packages/ui/src/pages/Captures.tsx`): read-only list + detail; no owner verbs.
- **`nimbus negotiate`** agent-action lane (`packages/gateway/src/agents/_lib/negotiate-agent-actions.ts`,
  `AGENT_ACTION_LANES`): an executed agent CREATE whose result URL resolves to an indexed item is
  excluded from the subject's counts; an edit, or an unresolved URL, is disclosed instead.

### `[mcp_sink]` (`packages/gateway/src/config/mcp-sink-toml.ts`)

| Key | Default | Range |
|---|---|---|
| `enabled` | `false` | bool |
| `kinds` | `note, decision, term, link` | non-empty subset of `CAPTURE_KINDS` |
| `max_per_hour` | 30 | 1..1000 (attempt limit is 4 × this) |
| `max_pending` | 100 | 1..10000 |
| `action_ttl_hours` | 24 | 1..168 |
| `action_max_pending` | 10 | 1..100 |

Out-of-range values and unknown kinds refuse at load (capability reason `config_error`); nothing
is clamped.

**An approval list for agents (Phase 28 AD3a-1; enforced since AD3a-2a, invariant I58).** `nimbus connector writes enable <service> --door agent` records, per tool and with a hash of its listed definition, the writes the owner approved for outside agents (V97 `connector_write_door_approval`, written only by `connectors/connector-writes/door-approval-store.ts`, static D49(b)). `mcp-sink/` still never names the store or imports `connectors/` (D32(f)): the gate is injected with the agent door's `verdict`, `refusal` and `verifyDefinition` (`connectors/connector-writes/agent-door-runtime.ts`, built in `platform/assemble.ts` over a late-bound mesh listing that fails closed). Submit's action steps: verdict (`ERR_AGENT_TOOL_SUSPENDED` / `ERR_CAPTURE_ACTION_NOT_PROPOSABLE`), the refusal for the verdict's basis, configured, then for an `approved` basis the definition check last (it lists the connector). `acceptAction` step 4 re-derives them before the claim, a Wave 4 or bound row routes to the same executor, `approved` rows are approved only through `approvals.approve`, and `buildActDeps` wraps an `approved` basis in `vetoingConsent` (a post-answer definition recheck). Since AD3b (a breaking release) there is no other basis: a type the earlier table accepted with no approval (47 types, the seven mail sends among them) is refused like any other unapproved type, and a proposal queued before then is refused at approval and left to expire or be declined (the V97 `capture.legacy` column stays, unused). A rejected action stores a fixed code. Static D49(a), (c)-(e) pin the sites; (a) bans the window's names from production source.

**User MCP tools (Phase 28 AD5a, invariants I42 and I58).** `mcp_<id>.<tool>` has its own verdict in `agent-door-runtime.ts`: `suspended`, then `approved` (a V97 row for `(mcp_<id>, tool)` while policy allows `mcp_action` and `user_mcp_model_access`; no `--model` needed), else `denied` (since AD3b a `--model` server's unapproved tool is no longer a legacy case). `ActionBasis` has no basis-less proposable verdict. The owner approves tools with `connector.writesEnable { door: "agent", service: "mcp_<id>", approve: [...] }` (`ipc/connector-rpc-handlers/agent-writes-user-mcp.ts`; no `approve` is a list-only reply); the act wiring's `userMcpCallFacts` lists the server once, checks the hash on that listing and puts `userMcpCall` on the action (static D49(g)); raw `captures.accept` of an approved basis is refused (rule 4d); `capture.describe` describes an approved tool from a live listing and starts nothing for any other. After the owner's answer the recheck is bound to what the prompt showed (`UserMcpCallBinding`: the registration's creation time and, for an approved tool, the approval's full hash, compared in constant time): an approved tool re-reads the registration, the approval and a fresh listing; a mismatch overrules the answer with a fixed reason and marks nothing. A proposal older than the server's registration is refused at submit, approval and the call. The mesh bounds every user-server listing for the door with one 45-second deadline (`USER_MCP_LISTING_DEADLINE_MS`); an expired listing reads as unlistable (refused, nothing marked). The list-only enable returns at most 200 tools plus `omitted`.

## Stated bounds (I28)

- A live note is searchable unreviewed; acceptance proves the owner saw the text, not that it is true.
- Text reaching a model is delimited by I11, not sanitised. Homoglyphs are not caught by escaping.
- Approval proves the owner saw the call, not that it is wise.
- The TTY requirement on `nimbus approvals <id>` (and the `captures accept` alias) is a **CLI-side
  guard, not gateway-enforced**: a raw local-owner socket client can accept and answer its own consent
  prompt (local-owner trust model). The gateway's `captures.accept` on an action still serves an
  undeclared client with any answer source; `approvals.approve` is the human-only path. The connection
  kind is the connection's own claim. A restarted MCP server loses its ids. `Ctrl-C` at the prompt
  rejects the proposal for good.
- A transport failure is recorded `failed` though the remote may have acted; `outcome_ref` is a heuristic.
- The routing table is proven against the INSTALLED connectors package; a later tool rename surfaces as `failed`.
- Configured-ness treats a multi-key service as configured once ANY key is set, so an accept can
  pass it and fail at dispatch.
- `capture.describe` can start an approved connector (a listing per service, at most 3 services and 10 types per call, its own limiter), can record the one suspension audit row a submit would, names the approved Terraform directories and Kubernetes context and namespace names to an approved agent, and describes a user-registered type only when the owner approved that tool (I58 bounds 16 to 24). Describe does not say why a type cannot be proposed (one fixed `not_proposable` text; a refused submit names the class), a throwing check is one `unavailable` entry with a fixed text, and params are validated before the limiter (I58 bounds 20 to 24). It shares `verifyListed` with `verifyDefinition`: never copy the post-listing check.
- `capture.state` answers only for ids the asking connection submitted (any other id is
  `ERR_CAPTURE_NOT_FOUND`, as an absent one): state and a short outcome link, never the payload.
- The attempt limit is in-memory (resets on restart); the hourly cap is durable. Pre-limit refusals
  are counted, not audited. `data.delete --service nimbus` removes capture items, not `capture` rows.
- D32 text scans are evaded by dynamically composed identifiers; capability confinement is the real defense.

## Static D32 (`scripts/structure-audit/check-nimbus-invariants.ts`)

| Rule | Confines |
|---|---|
| (a) | the `capture` table identifier → `capture-store.ts`, `index/capture-v67-sql.ts`, `index/capture-action-v69-sql.ts` |
| (b) | `submitCapture`/`acceptCapture`/`rejectCapture`/`revokeCapture`/`purgeCapture` → `ipc/capture-rpc.ts` + `ipc/approvals-rpc.ts` + `capture-gate.ts` + `capture-gate/owner-verbs.ts` (revoke and purge) |
| (c) | value-import / re-export / dynamic import of `capture-gate.ts` → only `ipc/capture-rpc.ts` (`import type` allowed) |
| (d) | the four agent-row writers → their definitions + `capture-native.ts`; `writeCaptureNative`/`revokeCaptureNative` → `capture-native.ts` + `capture-gate.ts` + `capture-gate/owner-verbs.ts` |
| (e) | `acceptAction` → its definition + its one call in `capture-gate.ts` |
| (f) | no non-test `mcp-sink/` file imports `engine/executor.ts` or anything under `connectors/` (type-only included) — execution, classification, configured-ness arrive injected |
| (g) | the `mcpToolId` literal under `mcp-sink/` → `capture-validate.ts` only (which refuses it) |

## Where Things Live

| Path | Role |
|---|---|
| `packages/gateway/src/mcp-sink/capture-gate.ts` | `submitCapture` (the fixed order, with its named steps), `acceptCapture`, `rejectCapture`; re-exports the rest |
| `packages/gateway/src/mcp-sink/capture-gate/` | `contract.ts` (deps, views, constants), `shared.ts`, `reads.ts` (list/get/state/mine/proposals/status), `submit-support.ts` (audited and unaudited refusals, step 9-10 write; importable only by `capture-gate.ts`, pinned by `i28-capture-gate-confinement.test.ts`), `owner-verbs.ts` (`revokeCapture`, `purgeCapture`) |
| `packages/gateway/src/mcp-sink/capture-act.ts` | `acceptAction`, expiry sweep, boot reconcile, error classification |
| `packages/gateway/src/mcp-sink/capture-native.ts` | native-row write/revoke/status for decision/term/link |
| `packages/gateway/src/mcp-sink/capture-store.ts` | the only file naming the `capture` table |
| `packages/gateway/src/mcp-sink/capture-validate.ts` | per-kind whitelist rebuild + caps; `mcpToolId` refusal |
| `packages/gateway/src/mcp-sink/capture-capability.ts` | `resolveCaptureCapability` (config + policy → `enabled`, `kinds`, `actionEnabled`) |
| `packages/gateway/src/mcp-sink/capture-client-policy.ts` | `CAPTURE_ROLE_BY_KIND`, total over `ClientKind` |
| `packages/gateway/src/mcp-sink/capture-rate-limit.ts` | attempt limiter + refusal counter |
| `packages/gateway/src/mcp-sink/invisible-text.ts` | `FORMAT_INVISIBLE_RANGES` / `rangesRegExp` shared by validate and act |
| `packages/gateway/src/mcp-sink/capture-types.ts` | kinds, states, error codes, `ActDeps` seam |
| `packages/gateway/src/ipc/capture-rpc.ts` | IPC dispatch + `buildActDeps` (the executor seam) |
| `packages/gateway/src/index/capture-v67-sql.ts` · `capture-native-v68-sql.ts` · `capture-action-v69-sql.ts` | schema V67 / V68 / V69 (V97, `agent-door-v97-sql.ts`, rebuilds `capture` with a `legacy` column, unused since AD3b, and a code on a `rejected` action) |
| `packages/cli/src/mcp/capture-tools.ts` | MCP tool registration |
| `packages/cli/src/commands/captures.ts` · `captures-format.ts` | owner CLI + rendering |
| `packages/gateway/test/e2e/mcp-capture.e2e.test.ts` | real-gateway E2E |

## Checklist for changing this area

**Making an action type proposable:**
1. It must already be in `HITL_REQUIRED`, and a write row (`connector-writes/*.ts`, the generated manifest)
   must route to it with the **bare tool id the connector actually registers** — tool names are not
   derivable from types (e.g. `google_drive.file.create` → `gdrive_file_create`). The row's wave, its
   template and, for a Wave 4 row, its before-state reader or prepare step decide whether the model
   door offers it; the owner then approves it for agents by name (`enable <service> --door agent`).
2. The row table is generated from and tested against the installed `@nimbus-dev/connectors`
   (`connector-writes/rows.test.ts`, `manifest.generated.ts`); check the pin is current before trusting
   a red/green there.
3. Never make a type proposable whose tool literal is confined elsewhere (D17 ChatOps, D19 tribal
   KB, D20 connector writes are reasons a class is denied).
4. The service must be attributable by `meshServerForToolKey` (a catalog id, or a
   `MESH_ONLY_SERVER_IDS` entry) and have an honest configured-ness answer in
   `proposable-service-configured.ts` (catalog ids delegate to `isConnectorConfigured`,
   `packages/gateway/src/sync/connector-configured.ts`), or it is `unroutable`.
5. If its artifact lands in a `negotiate` lane, add it to `AGENT_ACTION_LANES`.
6. A NEW HITL type is `unknown` (refused) until classified; the totality test fails until you do.

**Adding a capture kind:** `CAPTURE_KINDS` + a payload type + validator; a migration that rebuilds
`capture` for the kind/state CHECK (V69 is the precedent); gate steps; MCP tool registration; CLI
usage/filters; docs. Adding a `ClientKind` is a compile error in `CAPTURE_ROLE_BY_KIND` — decide its role.

**Always:** the triple rule (wiring + `docs/SECURITY-INVARIANTS.md` + the `I28` describe block in
`packages/gateway/src/security-invariants/i28-mcp-capture-gate.test.ts`, same commit); run that WHOLE file, not `-t I28`
(other blocks pin counts this area moves, e.g. I22's). Each D32 rule needs a red-proving fixture.
Update `CLAUDE.md` + `GEMINI.md`, `docs/architecture.md` (§ MCP capture sink),
`docs/cli-reference.md` (§ `nimbus captures` and the MCP server section),
`docs/schema-reference.md`, `docs/roadmap.md`, `docs/CHANGELOG.md`. A Tauri exposure goes through
the `nimbus-tauri-allowlist` skill.

## Pitfalls

- **The LAN check is a denylist.** `checkLanMethodAllowed` (`packages/gateway/src/ipc/lan-rpc.ts`)
  refuses only what `FORBIDDEN_OVER_LAN` names; a new namespace is LAN-reachable by default. `capture`
  and `captures` are listed as whole namespaces — keep it that way, and test with a real
  `checkLanMethodAllowed` call, not a source grep.
- **Strip invisibles at WRITE time, not display.** Stored text (note/decision/term/link) is
  sanitised in `capture-validate.ts`, so the owner reviews exactly what is kept. An action's `input`
  is the exception: stored VERBATIM (the approved bytes are the dispatched bytes) and rendered with
  invisibles escaped. Build such character classes from numeric code-point tables
  (`invisible-text.ts`), never `\u` escapes in a regex literal — the repo's format-on-write hook can
  turn those into literal invisible characters. Scan code points after editing these files.
- **User-MCP actions need the gateway-derived `mcpToolId`.** With no payload key, the dispatcher
  (`packages/gateway/src/connectors/registry.ts`) resolves by type and its I42 pairing refuses
  (`ERR_USER_MCP_ACTION_MISMATCH`); with an agent-chosen key it could pick another tool on the same
  server. Hence `userMcpToolKeyForActionType` — and the D32(g) refusal at submit.
- **First-party writes are not dispatchable by type.** The mesh lists them as
  `<server>_<underscored tool>`; a fake dispatcher cannot catch a routing mistake — test through the
  real dispatcher over mesh-shaped keys.
- **`approved` is earned.** Owner verbs (accept/revoke/purge) audit `not_required`; only the
  executor's consent gate earns `approved` (I4).
- **The glossary veto is the model's,** not the owner's: an owner accept overrides `vetoed`; only a
  `manual` term refuses.

## The proposer label and its source (AD7a, V99)

A capture row holds `client_label` and, since V99, `label_source`: `declared` (the MCP client's `clientInfo.name`)
or `kit` (the `--agent <name>` value of `nimbus mcp-server --stdio --agent <name>`, sent as `labelSource: "kit"`
on `capture.submit`). Both are UNVERIFIED and DISPLAY ONLY: the prompt, `approvals.list`/`approvals.get`, the accept
audit row and the proof show the source; no step of `capture-gate.ts`, `capture-act.ts` or the executor may branch on
it (a source pin in the I28 block of `i28-mcp-capture-gate.test.ts` fails on any line there that is not a declaration or a
pass-through). A new fixture that builds a `NewCaptureRow` must set `labelSource`.

## The protocol layer (AD6b)

`packages/cli/src/mcp/adapter.ts` builds the server on `@nimbus-dev/sdk/mcp-server` (both MCP eras, one process).
The layer does NOT validate arguments: `toolFor` parses them with the tool's zod shape before `run`, and only the
members the shape names reach the tool. A new tool needs nothing else, but `adapter-eras.test.ts` requires it to
be named in `ADDED_SINCE_THE_RECORD` (the recorded upstream 1.32.0 listing is never regenerated). The client label
comes from the call's `ctx.clientInfo`, per request in the modern era. No tool may return `inputRequired`.

## Agent kits (AD7b)

`nimbus agent install|status` (`packages/cli/src/commands/agent.ts`, `packages/cli/src/agent-kits/`) writes the
server entry `nimbus mcp-server --stdio --agent <kit>` and steering into an agent's own configuration. CLI only.
Steering is guidance, never a boundary. When a connector write's action type is renamed or stops being
model-offerable, `scripts/agent-kits/steer-table.test.ts` fails: fix `steer-table.ts`, bump
`STEER_TABLE_VERSION` (installed kits then read as drifted), and update the table on the docs site's Agent kits
page (`scripts/agent-kits/kit-page.test.ts` holds it).
