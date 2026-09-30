# `nimbus audit replay` — durable, structure-only decision trace (M3 sub-project 1)

- **Status:** design approved in conversation 2026-09-30; awaiting written-spec review
- **Branch:** `dev/asafgolombek/audit-replay` (this file never lands on `main` — strip before the implementation PR)
- **Roadmap rows served:** North-Star **M3 — Accountable Autonomy** ("every decision replayable"; its substrate note: "faithful replay needs the agent's reasoning/evidence trace captured, not just actions + HITL status"), and the Killer Demo's `nimbus audit replay` step.

## 1. Goal

Make an `ask` or a built-in agent brief **replayable after the fact**: which route it took, which
index items were considered and why each was shown or cut, which tools it called, how synthesis
went, which HITL decisions and refusals happened, and which egress-ledger rows it produced —
ending on a locality verdict for *that session*, not for a time window.

`nimbus explain last` already answers most of these questions, but only for the newest ask, only in
memory, and only until the gateway restarts. This slice makes the answer durable, tamper-evident,
per-session, and extends it to agent briefs.

## 2. Decisions taken (do not relitigate)

| # | Decision | Rejected alternatives |
|---|---|---|
| D-1 | Replay unit is a **real session id**, with the reasoning trace persisted (M3 shape). | Time-window replay; session id on existing tables only. |
| D-2 | The trace stores **structure only** — no question, title, snippet or model output text. Content is re-resolved from the index at replay time and disclosed if it has changed. | Opt-in full text; always full text. Reason: the index is not encrypted at rest (SQLCipher rejected 2026-09-15), the same reasoning that deferred a durable `ask_explain` table when `explain last` shipped. |
| D-3 | v1 capture scope: **`runAsk`** (ask / `agent.invoke` / ChatOps read) **+ the built-in agent briefs**. | `runAsk` only; everything agentic (exec, computer-use, toolgen, media, fleet). |
| D-4 | Substrate is an **append-only, BLAKE3-chained event table** with the session carried by the existing `AsyncLocalStorage`. | One JSON record per session; a `session_id` column on `audit_log`/`egress_ledger` only. |
| D-5 | `audit_log` and `egress_ledger` get **no migration**; the trace references their rows. | Adding `session_id` to both (would change I29's verification inputs). |
| D-6 | No pruning in v1. | A retention window — needs its own HITL-tombstone design, like `egress.prune`. |
| D-7 | `nimbus demo` prints the replay command for its `oncall` step. | — |

## 3. Data model — schema V64

One new table (`index/trace-event-v64-sql.ts`):

```sql
CREATE TABLE IF NOT EXISTS trace_event (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT    NOT NULL,
  seq          INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  kind         TEXT    NOT NULL CHECK(kind IN (
                 'session_open','route','retrieval','tool_call','synthesis',
                 'hitl','refusal','egress_ref','session_close')),
  payload_json TEXT    NOT NULL,
  row_hash     TEXT    NOT NULL,
  prev_hash    TEXT    NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_trace_event_session ON trace_event(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_trace_event_ts      ON trace_event(ts);
```

- **One global chain**, not one per session: with a per-session chain, deleting a whole session
  would leave nothing to detect. Genesis and hashing reuse `db/audit-chain.ts` (`GENESIS_HASH`,
  BLAKE3); verification is timing-safe (I10).
- `seq` is dense per session, starting at 0 at `session_open`. `UNIQUE(session_id, seq)` makes a
  duplicate or reordered write a constraint error, not silent corruption.
- `session_open` and `session_close` carry what `trace.list` needs, so there is no separate
  session-header table.

### 3.1 Payload types (structure only)

Each kind has one exported readonly type in `trace/trace-payloads.ts`. **No type has a member able
to hold user or index content.** Permitted value classes: enum/code strings, numbers, booleans,
`sourceId`s, service/type names, tool ids, model/provider ids, egress row hashes, and **digests**
(`Blake3Hex`, 64 lowercase hex chars).

| kind | payload (summary) |
|---|---|
| `session_open` | `surface: "ask" \| "agent"`, `agent?: AgentName`, `clientKind: ClientKind`, `inputDigest: Blake3Hex` (question for ask; canonical params JSON for agent) |
| `route` | `route` (the five `AskExplainRecord` routes), `modelRoute?: {provider, model, isLocal}`, `classifier: {called:false, reason: code} \| {called:true, intent, confidence, destination}` (entities dropped — they are extracted text), `fallbackFromLocalRouter: boolean` |
| `retrieval` | `primary: {vectorRanked, partial, backfill}`, `truncation: {shown,total,atLeast}`, `candidates: {sourceId, service, indexedType, modifiedAt?, score?, pass: pass-kind only, outcome}[]`, `discardedTail` counts |
| `tool_call` | `toolId`, `service`, `status`, `durationMs`, `paramsDigest: Blake3Hex \| null`, `ranking?` counts |
| `synthesis` | `mode` (`off`/`local`/`allow-remote`), `ok`, `reason?: code`, `modelRoute?`, `outputDigest: Blake3Hex` (final markdown or answer) |
| `hitl` | `actionType`, `verdict: approved\|rejected\|not_required`, `rejectReasonCode?` |
| `refusal` | `code` (an `ERR_*` string) |
| `egress_ref` | `rowHash`, `sourceType`, `destination`, `resultStatus` |
| `session_close` | `outcome: ok\|error\|refused`, `durationMs`, `incomplete: boolean`, `droppedEvents: number` |

Notes:
- `ContributingPass` drops the `query`/`slug`/`term` strings (extracted user text); only `kind` survives.
- A search `sourceId` can embed a path or external key; that is an **identifier the index already
  holds in cleartext**, not new content, and it is what makes re-resolution possible.
- A runtime guard in the store rejects any `*Digest` field that is not 64 hex chars, so plaintext
  cannot slip into a digest field by mistake. A test pins every payload type's key set.

## 4. Capture flow

### 4.1 Modules (new `packages/gateway/src/trace/`)

- `trace-store.ts` — the **only** writer of `trace_event` (D32). `appendTraceEvent`, `verifyTraceChain`, `readSession`, `listSessions`.
- `trace-context.ts` — `openTraceSession`, `recordTraceEvent`, `closeTraceSession`. Adds a
  `trace?: { sessionId, nextSeq, incomplete, dropped }` member to the existing
  `AgentRequestContext` (`engine/agent-request-context.ts`).
- `trace-payloads.ts` — the payload types plus builders, including `fromExplainRecord(record)`,
  which converts an `AskExplainRecord` into `route`/`retrieval`/`tool_call` events.

**Why a separate `trace` member and not `AgentRequestContext.sessionId`:** `sessionId` is the
conversation-memory key (`run-ask.ts` loads and persists prior turns under it). Setting it for
every traced ask would silently give plain `nimbus ask` conversation memory.

### 4.2 Session opening — exactly two sites

1. **`runAsk`** (`engine/run-ask.ts`), which all three ask callers already reach inside
   `agentRequestContext.run`. It mints a trace id, writes `session_open`; the explain recorder's
   final record is converted via `fromExplainRecord` and appended; `session_close` is written in the
   same `finally` that already writes exactly one explain record per call, success or throw.
2. **The `agents.*` dispatcher** (`ipc/agents-rpc.ts`, already the sole entry for every brief per
   D22(d)). The session opens **before** `recordAgentBriefEgress`, so an MCP/HTTP brief's own
   egress row falls inside its session. `newSessionId(kind)` adopts the open trace id, so the
   `sessionId` the client already receives **is** the replay key.

### 4.3 The detached-work rule

`emitBriefWithSynthesis` returns `{ sessionId }` before its `void (async () => …)()` block runs.
`AsyncLocalStorage` captures the store when that promise is created, so the context propagates.
`synthesis` and `session_close` are therefore written **inside** that block — on the `briefReady`
path and on the `briefError` path — never when the dispatcher returns. A test pins that
`session_close` is written after `briefReady` is emitted.

### 4.4 Hooks inside a session (no-ops outside one)

- **`appendEgressEntry`** (`egress/egress-ledger.ts`, the sole ledger writer every appender reaches)
  → an `egress_ref` event with the returned `rowHash`. **Fail-closed:** if the trace append throws,
  `appendEgressEntry` throws, so the outbound call aborts exactly as an I29 append failure does.
  The ledger row is written first and stays; the error is reported as an egress append failure.
- **`ToolExecutor.gate()`** (`engine/executor.ts`) → a `hitl` event (best-effort).
- **Refusals** thrown as `ERR_*` from the two entry points → a `refusal` event (best-effort).

### 4.5 Failure policy

| Event class | On append failure |
|---|---|
| `egress_ref` | Fail-closed: abort the outbound call. |
| Everything else | Best-effort: increment `dropped`, set `incomplete`; the ask/brief result is unchanged. |
| `session_close` itself | Best-effort; a session with no close renders as `incomplete (no close event)`. |

## 5. Replay surface

### 5.1 IPC

`trace.list { limit? }` and `trace.replay { sessionId }`, handled in `ipc/diagnostics-rpc.ts`.

- **CLI-only:** not added to the Tauri `ALLOWED_METHODS` (stays at 105).
- **LAN-forbidden explicitly:** `checkLanMethodAllowed` is a denylist, so the `trace.*` namespace
  is added to it; tested by calling it over LAN, with a negative control.
- **Routed twice:** in the inner handler map **and** in `tryDispatchDiagnosticsRpc`'s outer method
  match (`ipc/server/dispatchers.ts`), with an e2e test over a real socket.
- `ERR_TRACE_SESSION_NOT_FOUND` for an unknown id.

### 5.2 CLI (subcommands of `nimbus audit`)

- `nimbus audit sessions [--limit N] [--json]` — id, surface / agent, started, duration, outcome, `incomplete`.
- `nimbus audit replay <session-id> [--json]` — the rendering below; `--json` emits the raw events plus the verdicts.

### 5.3 Rendering, in order

1. **Chain verdict** over the session's rows, **including the neighbouring rows** on both sides, so
   deleting an edge row is caught: `chain: verified` or `chain: BROKEN at seq N`. A broken chain
   still renders, under that heading.
2. **Timeline**, one line per event with a `+Δms` offset, e.g.
   `route local_context (llama3.2, local)` ·
   `retrieval 14 candidates — 6 shown · 5 cut: over cap · 3 cut: service fairness` ·
   `hitl github.pr.comment → rejected`. Unparseable payloads render as `(unreadable event)`.
3. **Re-resolved content.** Each `sourceId` resolves to its current title, suffixed
   `(changed since)` when `item.modified_at` > event `ts`, or `(no longer indexed)` when absent.
   Question and answer appear as digests, with one line saying the text is deliberately not stored.
4. **Locality verdict.** The count of `egress_ref` events, worded with `formatProveResult`'s
   coverage-class language (`packages/cli/src/commands/prove.ts`) — never a bare `0` — then the
   stated bound: *"N ledger rows in this session's window were not attributed to it (concurrent
   activity)."*

### 5.4 Demo tie-in

`nimbus demo`'s closing locality panel (`packages/cli/src/lib/locality-panel.ts`, via `run-tour.ts`)
prints `→ nimbus audit replay <sessionId>` for the `oncall` step's session.

## 6. Invariant I42 and static rule D32

**I42 — decision-trace integrity, structure only at rest.** A trace event reaches disk only via
`trace/trace-store.ts`, BLAKE3-chained. No trace payload type has a member able to hold user or index
content; digest fields are runtime-checked as 64-hex. An egress append inside a traced session
whose `egress_ref` cannot be written aborts the outbound call.
**Stated bounds:** (1) attribution relies on `AsyncLocalStorage` propagation — work that escapes the
context is unattributed, and replay discloses the count rather than preventing it; (2) type pinning
cannot stop a non-digest identifier from being misused, only content-shaped members; (3) like
`audit_log`, the chain defends against careless code and partial deletion, **not** a filesystem-write
attacker, who can rewrite the chain consistently.

Triple rule, one commit: wiring, a `docs/SECURITY-INVARIANTS.md` section, and an enforcement test in
`security-invariants.test.ts`. `CLAUDE.md` and `GEMINI.md` invariant lists are updated together.

**D32** (`scripts/structure-audit/check-nimbus-invariants.ts`), written as what cannot pass:
- (a) the `trace_event` identifier, bare or SQLite-quoted, appears only in `trace/trace-store.ts`
  and `index/trace-event-v64-sql.ts`;
- (b) `openTraceSession(` is called only from `engine/run-ask.ts` and `ipc/agents-rpc.ts`.
Stated bound: a dynamically assembled identifier evades (a); capability confinement (only the store
holds the SQL) is the real defense there, as in D27(b).

## 7. Testing

- **Unit:** each payload builder; `fromExplainRecord` drops every text field (question, titles,
  entities, pass queries); non-digest rejection; chain append + verify; payload key-set pin.
- **Integration (real migrated SQLite, temp dirs):**
  - V64 migration on a pre-V64 database;
  - a `runAsk` session yields `session_open → route → retrieval → session_close`, `seq` dense;
  - a brief's `synthesis` + `session_close` land **after** `briefReady` (detached-work test);
  - an `egress_ref` append failure aborts the outbound call and leaves the ledger row;
  - two concurrent sessions do not interleave events, and the unattributed-window count is right;
  - deleting a row, including one at a session edge, renders `BROKEN at seq N`;
  - a best-effort failure marks `incomplete` without changing the ask result.
- **E2E (real gateway subprocess):** `trace.list` / `trace.replay` over a real socket (routing);
  `nimbus demo` → the printed `oncall` session id replays.
- **Negative controls:** LAN refusal by actually calling it; Tauri allowlist asserted by name as well as by count.
- **Tests that expect a prompt** — none; all new CLI paths are non-interactive.

## 8. Out of scope — recorded deferrals

- **Pruning / retention** — needs a HITL-gated tombstone design, like `egress.prune`.
- **Confidence changes across a session** — the roadmap's "honesty extension" row.
- **Tracing fleet, exec, computer-use, toolgen and media** — each has its own gate order; a follow-up slice.
- **Storing content** — rejected, not deferred, while the index is unencrypted at rest.
- **Desktop / VS Code replay surface** — CLI first.

## 9. Documentation to update with the implementation

`docs/architecture.md` (new subsystem + IPC catalogue), `docs/cli-reference.md`
(`audit sessions` / `audit replay`), `docs/roadmap.md` (M3 substrate note and Killer Demo step),
`docs/SECURITY-INVARIANTS.md` (I42), `docs/CHANGELOG.md`, `CLAUDE.md` + `GEMINI.md` (I42, D32, V64).
