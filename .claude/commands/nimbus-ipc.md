---
name: nimbus-ipc
description: >
  Complete reference for the Nimbus Gateway IPC layer: JSON-RPC 2.0 conventions, all
  method namespaces, notification + streaming patterns, the Tauri allowlist, error codes,
  and the checklist for adding a new method. Use when adding an IPC method, designing a
  notification, wiring an IPC call from CLI/UI, choosing a method name/namespace, deciding
  notification-vs-response or how to stream, checking Tauri-frontend exposure safety, or
  debugging an IPC contract. Consult before any code that touches packages/gateway/src/ipc/.
---

# Nimbus IPC Reference

## Transport

JSON-RPC 2.0 over a **local-only** domain socket (macOS/Linux) or named pipe (Windows). There is no TCP surface — the Gateway is never reachable over the network except via the opt-in encrypted LAN server (`packages/gateway/src/ipc/lan-server.ts`).

| Platform | Socket path |
|---|---|
| Windows 10+ | `\\.\pipe\nimbus-gateway` |
| macOS 13+ | `$TMPDIR/nimbus-gateway.sock` (defaults to `/tmp/nimbus-gateway.sock`) |
| Ubuntu 22.04+ | `$XDG_RUNTIME_DIR/nimbus-gateway.sock` (defaults to `/tmp/nimbus-gateway.sock` if `XDG_RUNTIME_DIR` is unset) |

Use `PlatformServices` to resolve the path — never hardcode it.

---

## Method Naming Convention

```
namespace.methodName
```

- **namespace** — lowercase, matches the subsystem (e.g. `engine`, `llm`, `connector`)
- **methodName** — camelCase (e.g. `listModels`, `askStream`)
- **Notifications** follow the same pattern but are sent server→client with no `id` and no response expected

❌ Wrong: `getConnectorList`, `LLM_LIST_MODELS`, `nimbus/connector/list`
✅ Right: `connector.list`, `llm.listModels`

---

## Requests vs Notifications

| Type | Has `id` | Expects response | Direction | Use for |
|---|---|---|---|---|
| **Request** | yes | yes | client→server | Queries, commands, one-shot fetches |
| **Response** | yes (matching) | — | server→client | Reply to a request |
| **Notification** | no | no | server→client | Async events, progress streams, health changes |

When a method needs to stream results, it returns a handle immediately and emits notifications:

```
→ engine.askStream({ input })           request  →  { streamId }
← engine.streamToken { streamId, token }           notification (×N)
← engine.streamDone  { streamId, result }          notification (×1)
← engine.streamError { streamId, error }           notification (on failure)
```

---

## Complete Method Registry

### `engine.*` — Agent queries

| Method | Type | Params | Returns / Emits |
|---|---|---|---|
| `engine.askStream` | request | `{ input, sessionId?, agent? }` | `{ streamId }` → see streaming notifications below |
| `engine.cancelStream` | request | `{ streamId }` | cancels an in-flight stream |
| `engine.getSessionTranscript` | request | `{ sessionId }` | session transcript rows (requires a configured local index) |

**Streaming notifications (engine):**

| Notification | Payload |
|---|---|
| `engine.streamToken` | `{ streamId, token }` |
| `engine.streamDone` | `{ streamId, result }` |
| `engine.streamError` | `{ streamId, error }` |

---

### `agent.*` — Multi-agent orchestration events (notifications only)

| Notification | Payload | Description |
|---|---|---|
| `agent.subTaskProgress` | `{ sessionId, subTaskId, status, description }` | Status update per sub-task |
| `agent.hitlBatch` | `{ sessionId, actions: HitlAction[] }` | Consolidated consent request for all HITL-required sub-tasks |
| `agent.gasLimitReached` | `{ sessionId, limit: 'depth' \| 'toolCalls' }` | Loop protection triggered |

`HitlAction` shape:
```ts
interface HitlAction {
  actionId: string;
  subTaskId: string;
  summary: string;
  diff?: string;   // before/after diff for file/code changes
}
```

---

### `llm.*` — Local model management

| Method | Type | Description |
|---|---|---|
| `llm.listModels` | request | Merged list from Ollama tags + `llm_models` SQLite table |
| `llm.pullModel` | request | Triggers Ollama pull; streams `llm.pullProgress` notifications |
| `llm.loadModel` | request | Loads or warms a local provider model; Ollama auto-loads on first generate |
| `llm.unloadModel` | request | Unloads a local provider model when the provider supports it |
| `llm.setDefault` | request | Sets `is_default = 1` for a model id |
| `llm.getRouterStatus` | request | Current routing decision per task type |
| `llm.listLocalModels` | request | Scans model dir for GGUF files (including subdirs + symlinks) |

**Notifications (llm):**

| Notification | Payload |
|---|---|
| `llm.pullProgress` | `{ model, status, completed, total }` |

---

### `connector.*` — Connector health and management

| Method | Type | Description |
|---|---|---|
| `connector.list` | request | All connectors with current health state |
| `connector.history` | request | Last N health transitions for a connector |

**Notifications (connector):**

| Notification | Payload |
|---|---|
| `connector.healthChanged` | `{ service, state, reason?, timestamp }` |

Health states: `healthy` \| `degraded` \| `error` \| `rate_limited` \| `unauthenticated` \| `paused`

---

### `watcher.*` — Watcher CRUD

| Method | Type | Description |
|---|---|---|
| `watcher.list` | request | All watchers with enabled state + last-fired time |
| `watcher.create` | request | Create a new watcher |
| `watcher.update` | request | Update watcher definition |
| `watcher.delete` | request | Delete a watcher |
| `watcher.history` | request | Past fire events for a watcher |

---

### `workflow.*` — Pipeline management

| Method | Type | Description |
|---|---|---|
| `workflow.list` | request | All saved workflow pipelines |
| `workflow.create` | request | Create a pipeline |
| `workflow.update` | request | Update a pipeline |
| `workflow.delete` | request | Delete a pipeline |
| `workflow.run` | request | Execute a pipeline (supports `dryRun: true`) |
| `workflow.rerun` | request | Re-run from step N (`fromStep` param) |
| `workflow.history` | request | Run history with per-step status |

---

### `index.*` — Read-only index queries (plus CLI-only reembed)

Read methods are available to LAN peers without `grant-write` and never mutate data. The `index.reembed*` write methods are **CLI-only** — NOT in the Tauri renderer allowlist (I7), and listed by full method name in `FORBIDDEN_OVER_LAN` (I5).

| Method | Type | Description |
|---|---|---|
| `index.query` | request | Structured filter query over indexed items |
| `index.search` | request | Hybrid BM25 + vector search |
| `index.getItem` | request | Fetch a single item by id |
| `index.reembed` | request | Selectively re-embed items to a target model. Returns `{ jobId }`; emits `index.reembedProgress` / `index.reembedDone` / `index.reembedError` notifications. CLI-only — NOT in Tauri allowlist; NOT LAN-callable (T6 PR 3). |
| `index.reembedCancel` | request | Cancel an in-flight reembed job by `{ jobId }`. Returns `{ cancelled: boolean }`. |

**Notifications (index):**

| Notification | Payload |
|---|---|
| `index.changed` | `{ service, count }` — emitted after a sync cycle writes new rows |
| `index.reembedProgress` | `{ jobId, done, total, skipped }` per batch (T6 PR 3) |
| `index.reembedDone` | `{ jobId, succeeded, skipped, durationMs }` on completion (also fires for dry-runs with `dryRun: true` + `planned`) |
| `index.reembedError` | `{ jobId, code, message }` on fatal abort (vault key missing, unknown model, auth failure) |

---

### `status.*` — Health and diagnostics (read-only)

Available to LAN peers. Never mutates data.

| Method | Type | Description |
|---|---|---|
| `status.gateway` | request | Gateway uptime, version, platform |
| `status.index` | request | Item counts, p95 query latency, per-connector totals |
| `status.connectors` | request | All connectors + health + last-sync timestamp |

---

### `session.*` — RAG session memory

| Method | Type | Description |
|---|---|---|
| `session.create` | request | Start a new RAG session |
| `session.clear` | request | Clear session chunks |
| `session.list` | request | Active sessions |

---

### `updater.*` — Auto-update (Phase 4)

| Method | Type | Description |
|---|---|---|
| `updater.applyUpdate` | request | User-initiated; verifies Ed25519 signature before applying |

**Notifications (updater):**

| Notification | Payload |
|---|---|
| `updater.updateAvailable` | `{ version, notes }` — emitted on Gateway startup if newer version found |
| `updater.rolledBack` | `{ reason }` — emitted if corrupted binary triggers rollback |

---

### `voice.*` — Voice interface (Phase 4)

| Method | Type | Description |
|---|---|---|
| `voice.startListening` | request | Begin STT capture |
| `voice.stopListening` | request | End capture and return transcript |
| `voice.speak` | request | TTS playback of a string |

---

### `extension.*` — Extension management

| Method | Type | Description |
|---|---|---|
| `extension.list` | request | All installed extensions |
| `extension.install` | request | Install from URL, tarball, or local path |
| `extension.enable` | request | Enable a disabled extension |
| `extension.disable` | request | Disable without removing |
| `extension.remove` | request | Uninstall |

---

### `diag.*` — Diagnostics (read-only, available to LAN peers)

| Method | Type | Description |
|---|---|---|
| `diag.snapshot` | request | Full diagnostic snapshot (index metrics, latency percentiles, connector health) |
| `diag.slowQueries` | request | Recent slow queries from ring buffer |

---

### `agents.*` — Built-in read-only agents (Phase 5 T3)

Each returns immediately and emits a `<agent>.briefReady { sessionId, brief }` notification with a Markdown brief. Read-only — never fires HITL.

| Method | Type | Description |
|---|---|---|
| `agents.expert` | request | "Who has the most context on this?" — ranked contributors + evidence |
| `agents.impact` | request | Reverse-dependency blast radius across five categories |
| `agents.catchup` | request | Personalized retrospective digest weighted by your involvement |

---

### `metrics.*` / `deploy.*` / `deployment.*` — CI/CD data layer (Phase 5 T4)

| Method | Type | Description |
|---|---|---|
| `metrics.dora` | request | Four DORA metrics for a service from the local index |
| `deploy.preflight` | request | Pre-deploy check: active P1 incidents, failing CI, open PR conflicts |
| `deployment.annotate` | request | Internal post-deploy annotation. **NOT** in the Tauri allowlist; also reachable via the `POST /v1/deployments` HTTP write surface (`I13`) |

---

### `security.*` — Credential-hygiene scan (Phase 5)

| Method | Type | Description |
|---|---|---|
| `security.scan` | request | Local secret scan over already-indexed content. CLI-only — `FORBIDDEN_OVER_LAN` (`I5`), NOT in the Tauri allowlist (`I7`), not on the HTTP API |

---

### `federation.*` — Team federation (Phase 6 Slice 1)

Consent-scoped peer-to-peer federated query over the E2EE LAN channel. Over-the-wire answering goes through the `query-gate.ts` leak-proof gate (`I17`). LAN admits **only** `federation.query` / `federation.expertise`; all management methods are local/Tauri-only (`I5`), and `federation.pair` is CLI-only (out-of-band pairing code, same class as `lan.pair`).

| Method | Type | Description |
|---|---|---|
| `federation.query` | request | **Over-the-wire** — answer an inbound federated query; grant + role + consent + namespace-filter scoped (`I17`). Answering `peerId` is forced from the authenticated session, never the request body (I17/R1) |
| `federation.expertise` | request | **Over-the-wire** — content-free expertise ranking ("who knows `auth.ts`?"); returns ranks only, never item bodies |
| `federation.ask` / `federation.askExpertise` | request | **Outbound** — send a federated query / expertise request to a paired peer |
| `federation.discover` | request | Discover peers (mDNS + manual fallback). Renderer-callable |
| `federation.peers` | request | List paired peers. Renderer-callable |
| `federation.namespace.grant` / `.publish` / `.revoke` | request | Per-peer namespace RBAC grants. Renderer-callable |
| `federation.consentRespond` | request | Owner's local consent decision for an over-the-wire query (`federation.consentRequest` is a notification delivered to the renderer) |
| `federation.pair` | request | Mutual-approval peer pairing. **CLI-only** — transmits an out-of-band pairing code |

---

### `identity.*` — SSO / OIDC identity (Phase 6 Slice 3)

OIDC device-code SSO; tokens validated only in `identity/verifier.ts`, raw tokens Vault-only (`I18`). The four read+login methods are renderer-callable; the credential-mutating `identity.bind` / `identity.unbind` are **CLI-only**.

| Method | Type | Description |
|---|---|---|
| `identity.login` | request | Begin OIDC device-code login |
| `identity.status` | request | Current identity / session status |
| `identity.logout` | request | Clear the local identity session |
| `identity.listBindings` | request | List operator ↔ identity bindings |
| `identity.bind` / `identity.unbind` | request | Bind/unbind an operator identity. **CLI-only** — not in the Tauri allowlist; tokens Vault-only (`I18`) |

---

### `scim.*` — SCIM provisioning (Phase 6 Slice 3)

SCIM v2 user-provisioning admin surface. The two read methods are renderer-callable; `scim.setToken` / `scim.deprovision` are **CLI-only**. (Inbound SCIM writes arrive over the HTTP `/scim/v2/Users` routes on the `I13` write allowlist — not these IPC methods.)

| Method | Type | Description |
|---|---|---|
| `scim.status` | request | SCIM provisioning status |
| `scim.listUsers` | request | List SCIM-provisioned users |
| `scim.setToken` | request | Set the SCIM bearer token (Vault). **CLI-only** |
| `scim.deprovision` | request | Deprovision a user. **CLI-only** |

---

### `share.*` — Outbound share (Phase 6 Slice 8)

The one deliberate outbound-share path — invariant `I27`. `share.create` is the sole `createShare()` emit path (redact → owner-HITL `share.publish` → sign → persist → emit); emit-class methods are kept off the Tauri allowlist, read verbs are renderer-callable. See the `nimbus-share-virality` skill.

| Method | Type | Description |
|---|---|---|
| `share.create` | request | Create a redacted, signed share (CLI-only; `FORBIDDEN_OVER_LAN`) |
| `share.list` / `share.get` | request | List / fetch share records (read; renderer-exposed) |
| `share.pubkey` | request | Gateway share-signing pubkey (read; renderer-exposed) |
| `share.verify` | request | Verify a share file/URL signature (read; renderer-exposed) |
| `share.replay` | request | Re-run a share's read-only tool calls locally; divergence report (8c) |
| `share.inbox` | request | List inbound forwarded shares from `share_inbox` (read; renderer-exposed; 8d) |
| `share.prune` | request | Prune expired share records (CLI-only) |
| `share.approvalRespond` | request | Owner HITL response for `share.publish` |
| `federation.shareForward` / `federation.shareReceive` | request | Forward to a peer (local-only) / receive inbound (LAN-answerable; 8d) |

---

### `egress.*` — Egress ledger (provable locality, Phase 6 / S1)

The append-only, BLAKE3-chained egress ledger — invariant `I29` / static `D22`. Four read verbs are renderer-callable; `egress.prune` is the sole mutation (HITL-gated, CLI-only). See the `nimbus-egress` skill.

| Method | Type | Description |
|---|---|---|
| `egress.head` | request | Ledger head hash + row count (read; renderer-exposed) |
| `egress.list` | request | List ledger rows, clamped (read; renderer-exposed) |
| `egress.verify` | request | Offline BLAKE3-chain verify, timing-safe (I10) (read; renderer-exposed) |
| `egress.proveWindow` | request | Rows + completeness tier for `nimbus prove` (read; renderer-exposed) |
| `egress.prune` | request | Sole mutation: HITL-gated continuing tombstone (I2). **CLI-only** |

---

### `clip.*` — Web clipper (Phase 6 / Slice 9)

Owner-side management of the browser web clipper — invariant `I30` (fail-closed pairing window). The browser extension itself never speaks JSON-RPC; it talks to the HTTP write surface (`POST /v1/clips`, `POST /v1/clips/pair/confirm`) and the bearer-authed read route `POST /v1/clips/related`. These methods are the local owner's control plane over that surface. All five are **CLI-only** (not on the Tauri renderer allowlist — `clip.pair` mints a credential).

| Method | Type | Description |
|---|---|---|
| `clip.pair` | request | Open the single-use, expiring pairing window and return the 6-digit code (I30). **CLI-only** |
| `clip.status` | request | List minted clip tokens by label (never the token bytes). **CLI-only** |
| `clip.revoke` | request | Revoke one label or all clip tokens. **CLI-only** |
| `clip.list` | request | List indexed `nimbus:web_clip` items (`--tag` / `--limit`). **CLI-only** |
| `clip.delete` | request | Delete clips by id / URL, or all. **CLI-only** |

Handlers: `packages/gateway/src/ipc/clip-rpc.ts`. CLI: `nimbus clip pair|status|revoke|list|delete`.

---

### `audit.*` — Audit log (read-only; CLI-only)

| Method | Type | Description |
|---|---|---|
| `audit.verify` | request | Verify the BLAKE3 chain integrity of the audit log |
| `audit.exportAll` | request | Export the full audit log as a JSON array |
| `audit.getSummary` | request | Aggregate audit summary |
| `audit.toolCalls` | request | Forensic `tool_call_log` read surface (V29; complement to `I11`). NOT LAN-callable, NOT in the Tauri allowlist |

---

### `vault.*` ⛔ — Credential store (Gateway-internal only)

**NOT in the Tauri UI `ALLOWED_METHODS` list.** Never callable from the frontend.

| Method | Description |
|---|---|
| `vault.set` | Write a credential |
| `vault.get` | Read a credential |
| `vault.delete` | Remove a credential |
| `vault.list` | List key names only (never values) |

---

### `db.*` ⛔ — Database internals (Gateway-internal only)

**NOT in the Tauri UI `ALLOWED_METHODS` list.**

| Method | Description |
|---|---|
| `db.verify` | Check database integrity |
| `db.repair` | Attempt repair |
| `db.snapshot` | Write a backup snapshot |

---

## Error Codes

| Code | Constant | Meaning |
|---|---|---|
| -32700 | `PARSE_ERROR` | Invalid JSON |
| -32600 | `INVALID_REQUEST` | Not a valid JSON-RPC object |
| -32601 | `METHOD_NOT_FOUND` | Method does not exist |
| -32602 | `INVALID_PARAMS` | Missing or invalid parameters |
| -32603 | `INTERNAL_ERROR` | Unhandled server error |
| -32000 | `ERR_METHOD_NOT_ALLOWED` | Method exists but blocked by Tauri allowlist |
| -32001 | `ERR_HITL_REJECTED` | User rejected a HITL action |
| -32002 | `ERR_GAS_LIMIT` | `maxToolCallsPerSession` exceeded |
| -32003 | `ERR_VAULT_LOCKED` | Vault unavailable (e.g. screen locked on macOS) |
| -32004 | `ERR_CONNECTOR_UNAVAILABLE` | Connector not running or unauthenticated |
| -32005 | `ERR_AIR_GAP` | Outbound HTTP blocked by `enforce_air_gap = true` |

---

## Tauri UI Allowlist

`packages/ui/src-tauri/src/gateway_bridge.rs` maintains `ALLOWED_METHODS: &[&str]` at compile time. Any `rpc_call` for a method not in this set returns `ERR_METHOD_NOT_ALLOWED` before the request reaches the Gateway socket.

**Blocked from the UI (never add these):**
- `vault.*` — credential values must never be readable from the webview
- `db.*` — raw database operations are internal-only

**When adding a new UI-facing method:**
1. Add it to `ALLOWED_METHODS` in `gateway_bridge.rs`
2. Consider: is this read-only or write? Write methods need HITL in the executor
3. Is it sensitive (touches credentials or raw DB)? If yes, keep it Gateway-internal

---

## Checklist: Adding a New IPC Method

1. **Choose the namespace** — match the subsystem (`engine`, `llm`, `connector`, etc.)
2. **Name it** — `namespace.camelCaseMethod`
3. **Decide the type** — request/response, or notification-only?
4. **Streaming?** — return `{ streamId }` immediately; emit `namespace.eventName { streamId, ... }` notifications
5. **Write the handler** — `packages/gateway/src/ipc/handlers/<namespace>.ts`
6. **Register it** — in the IPC server (handler map)
7. **Tauri-accessible?** — add to `ALLOWED_METHODS` in `gateway_bridge.rs`
8. **HITL-required?** — if it triggers a write/destructive action, add the tool to `HITL_REQUIRED` in `executor.ts`
9. **Write the unit test** — `packages/gateway/test/unit/ipc/<namespace>-<method>.test.ts`
10. **Update `@nimbus-dev/client`** — add a typed wrapper in the standalone [nimbus-agent/nimbus-client](https://github.com/nimbus-agent/nimbus-client) repo so CLI and extensions can call it without raw JSON-RPC

---

## @nimbus-dev/client Usage

The published `@nimbus-dev/client` package wraps raw IPC with typed methods. Always use it in the CLI and extensions — never construct raw JSON-RPC in application code.

```ts
import { NimbusClient } from '@nimbus-dev/client';

const client = new NimbusClient();
const result = await client.engine.ask({ prompt: 'summarize my week' });

// For testing — use MockClient, never a real socket
import { MockClient } from '@nimbus-dev/client';
const mock = new MockClient();
mock.connector.list.mockResolvedValue([...]);
```
