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
  the ONE tool the gateway's routing table names (`connectors/proposable-actions.ts`). Use when
  touching `packages/gateway/src/mcp-sink/` or `packages/gateway/src/ipc/capture-rpc.ts`, the MCP
  write tools (`capture_note`, `propose_decision`, `propose_term`, `propose_link`,
  `propose_action`, `capture_status`), `nimbus captures list|show|accept|reject|revoke|purge`, the
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
| 5a/5b | Action only: proposable now, and its connector configured | `ERR_CAPTURE_ACTION_NOT_PROPOSABLE` / `ERR_CAPTURE_CONNECTOR_UNCONFIGURED` | yes |
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
4. Re-classify (`classifyActionType`) and re-check configured-ness — a `--model` revoke or policy
   tightening since submit takes effect here.
5. Atomic claim (CAS incl. the expiry predicate) → `executing`.
6. Rebuild the action from the stored row.
7. Execute via `ActDeps.execute`, built per accept by `buildActDeps` in `ipc/capture-rpc.ts`: a
   fresh `ToolExecutor` bound to the ACCEPTING session's consent channel, **no delegate**, the real
   egress sink and policy overlay — so I2, I29, I22 and I42 apply unchanged. The consent prompt is
   `formatActionConsent` (provenance + verbatim input, invisibles rendered visibly).
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

### Proposability — `packages/gateway/src/connectors/proposable-actions.ts`

| Table | Role |
|---|---|
| `PROPOSABLE_WRITE_TOOLS` | actionType → bare tool id as registered by `@nimbus-dev/connectors`; its keys ARE the first-party proposable set |
| `ACTION_PROPOSABILITY` | classifies EVERY `HITL_REQUIRED` type (totality test); unlisted → `unknown` → refused |
| `classifyActionType` | adds the user-MCP arm: `mcp_*` types are proposable only for a `--model` server while `user_mcp_model_access` allows (`user_mcp_no_model_access` / `user_mcp_policy` otherwise); `ext_*` is `unknown` |
| `listProposableActionTypes` | what `capture.status` advertises (configured first-party types + one `mcp_<id>.*` pattern per `--model` server) |

Counts — derive from `HITL_REQUIRED` (`packages/gateway/src/engine/executor.ts`) and
`ACTION_PROPOSABILITY` (as of 2026-10-24: 143 HITL types, **29 proposable / 114 denied**, 0
unclassified). Denied classes (`DeniedClass`): `file`, `calendar_delete`, `vcs`, `pipeline`,
`cloud`, `iac`, `k8s`, `deployment`, `incident`, `data_platform`, `tribal_kb` (I25/D19),
`chatops_confined` (I23/D17), `unroutable`, `gateway_internal`.

**Known gap:** `obsidian.note.append` is denied `unroutable` — `obsidian` is absent from the
connector catalog (`packages/gateway/src/connectors/lazy-mesh/tool-map.ts` service ids), so its tool key cannot be attributed.

## Surfaces

- **MCP tools** (`packages/cli/src/mcp/capture-tools.ts`): registered once, at MCP-server spawn,
  from `capture.status` — each proposal tool only for a kind in `kinds`; `propose_action` follows
  `actionEnabled`, never `kinds` alone. Gateway down or `session.declareKind` failed → no tools.
- **IPC** (`ipc/capture-rpc.ts`, routed by `tryDispatchCaptureRpc` in `ipc/server/dispatchers.ts`):
  `capture.status` (any local client), `capture.submit` and `capture.state` (`mcp` only),
  `captures.list|get|accept|reject|revoke|purge` (owner kinds `cli`/`ui`/`unknown`; `http`,
  `chatops`, `fleet`, `push` refused). Both namespaces LAN-forbidden; no HTTP route; only
  `captures.list`/`captures.get` on the Tauri allowlist
  (`packages/ui/src-tauri/src/gateway_bridge.rs`).
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

## Stated bounds (I28)

- A live note is searchable unreviewed; acceptance proves the owner saw the text, not that it is true.
- Text reaching a model is delimited by I11, not sanitised. Homoglyphs are not caught by escaping.
- Approval proves the owner saw the call, not that it is wise.
- The TTY requirement on `nimbus captures accept` is a **CLI-side guard, not gateway-enforced**: a
  raw local-owner socket client can accept and answer its own consent prompt (local-owner trust model).
- A transport failure is recorded `failed` though the remote may have acted; `outcome_ref` is a heuristic.
- The routing table is proven against the INSTALLED connectors package; a later tool rename surfaces as `failed`.
- Configured-ness treats a multi-key service as configured once ANY key is set, so an accept can
  pass it and fail at dispatch.
- `capture.state` answers for any capture id to any `mcp` client (ids are random): state and a
  short outcome link, never the payload.
- The attempt limit is in-memory (resets on restart); the hourly cap is durable. Pre-limit refusals
  are counted, not audited. `data.delete --service nimbus` removes capture items, not `capture` rows.
- D32 text scans are evaded by dynamically composed identifiers; capability confinement is the real defense.

## Static D32 (`scripts/structure-audit/check-nimbus-invariants.ts`)

| Rule | Confines |
|---|---|
| (a) | the `capture` table identifier → `capture-store.ts`, `index/capture-v67-sql.ts`, `index/capture-action-v69-sql.ts` |
| (b) | `submitCapture`/`acceptCapture`/`rejectCapture`/`revokeCapture`/`purgeCapture` → `ipc/capture-rpc.ts` + `capture-gate.ts` |
| (c) | value-import / re-export / dynamic import of `capture-gate.ts` → only `ipc/capture-rpc.ts` (`import type` allowed) |
| (d) | the four agent-row writers → their definitions + `capture-native.ts`; `writeCaptureNative`/`revokeCaptureNative` → `capture-native.ts` + `capture-gate.ts` |
| (e) | `acceptAction` → its definition + its one call in `capture-gate.ts` |
| (f) | no non-test `mcp-sink/` file imports `engine/executor.ts` or anything under `connectors/` (type-only included) — execution, classification, configured-ness arrive injected |
| (g) | the `mcpToolId` literal under `mcp-sink/` → `capture-validate.ts` only (which refuses it) |

## Where Things Live

| Path | Role |
|---|---|
| `packages/gateway/src/mcp-sink/capture-gate.ts` | `submitCapture`, `acceptCapture`, `rejectCapture`, `revokeCapture`, `purgeCapture`, list/get/state/status |
| `packages/gateway/src/mcp-sink/capture-act.ts` | `acceptAction`, expiry sweep, boot reconcile, `formatActionConsent`, error classification |
| `packages/gateway/src/mcp-sink/capture-native.ts` | native-row write/revoke/status for decision/term/link |
| `packages/gateway/src/mcp-sink/capture-store.ts` | the only file naming the `capture` table |
| `packages/gateway/src/mcp-sink/capture-validate.ts` | per-kind whitelist rebuild + caps; `mcpToolId` refusal |
| `packages/gateway/src/mcp-sink/capture-capability.ts` | `resolveCaptureCapability` (config + policy → `enabled`, `kinds`, `actionEnabled`) |
| `packages/gateway/src/mcp-sink/capture-client-policy.ts` | `CAPTURE_ROLE_BY_KIND`, total over `ClientKind` |
| `packages/gateway/src/mcp-sink/capture-rate-limit.ts` | attempt limiter + refusal counter |
| `packages/gateway/src/mcp-sink/invisible-text.ts` | `FORMAT_INVISIBLE_RANGES` / `rangesRegExp` shared by validate and act |
| `packages/gateway/src/mcp-sink/capture-types.ts` | kinds, states, error codes, `ActDeps` seam |
| `packages/gateway/src/ipc/capture-rpc.ts` | IPC dispatch + `buildActDeps` (the executor seam) |
| `packages/gateway/src/connectors/proposable-actions.ts` | proposability + routing tables |
| `packages/gateway/src/index/capture-v67-sql.ts` · `capture-native-v68-sql.ts` · `capture-action-v69-sql.ts` | schema V67 / V68 / V69 |
| `packages/cli/src/mcp/capture-tools.ts` | MCP tool registration |
| `packages/cli/src/commands/captures.ts` · `captures-format.ts` | owner CLI + rendering |
| `packages/gateway/test/e2e/mcp-capture.e2e.test.ts` | real-gateway E2E |

## Checklist for changing this area

**Making an action type proposable:**
1. It must already be in `HITL_REQUIRED`. Move it from its `denied(...)` group into
   `PROPOSABLE_WRITE_TOOLS` with the **bare tool id the connector actually registers** — tool names
   are not derivable from types (e.g. `google_drive.file.create` → `gdrive_file_create`).
2. `proposable-actions.sync.test.ts` proves the row against the installed `@nimbus-dev/connectors`;
   check the pin is current before trusting a red/green there.
3. Never make a type proposable whose tool literal is confined elsewhere (D17 ChatOps, D19 tribal
   KB, D20 connector writes are reasons a class is denied).
4. The service must be attributable by the mesh and checkable by `isConnectorConfigured`
   (`packages/gateway/src/sync/connector-configured.ts`), or it is `unroutable`.
5. If its artifact lands in a `negotiate` lane, add it to `AGENT_ACTION_LANES`.
6. A NEW HITL type is `unknown` (refused) until classified; the totality test fails until you do.

**Adding a capture kind:** `CAPTURE_KINDS` + a payload type + validator; a migration that rebuilds
`capture` for the kind/state CHECK (V69 is the precedent); gate steps; MCP tool registration; CLI
usage/filters; docs. Adding a `ClientKind` is a compile error in `CAPTURE_ROLE_BY_KIND` — decide its role.

**Always:** the triple rule (wiring + `docs/SECURITY-INVARIANTS.md` + the `I28` describe block in
`packages/gateway/src/security-invariants.test.ts`, same commit); run that WHOLE file, not `-t I28`
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
