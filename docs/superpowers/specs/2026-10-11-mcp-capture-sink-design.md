# S3 — MCP capture sink (I28) — design

> **Status:** draft for owner review, 2026-10-11. Opens Spine S3 with a lean scope: the MCP-server
> owner-sink that invariant `I28` has been reserved for since 2026-08-20. Branch
> `dev/asaf/s3-mcp-capture-sink`. This file never lands on `main` — strip it before the
> implementation PR.

## 1. Intent

**Outcome.** A coding agent connected to Nimbus over MCP (Claude Code, Cursor, any MCP client) can
*write* to the user's local brain, not only read it: record a session note, propose a decision,
propose a glossary term, propose a link between two indexed items. Nimbus becomes a two-way private
context backend for the user's agent stack — the S3 "Open Surface" thesis — without opening a
network port and without any byte leaving the machine.

**Who it is for.** The local owner, working with an AI coding agent that already reads the index via
the 21 read-only MCP tools.

**Success criteria.**

1. An agent's `capture_note` is searchable through the existing `search` MCP tool and `nimbus query`
   in the same session, labelled agent-authored.
2. An agent's `propose_decision` / `propose_term` / `propose_link` is visible **nowhere** that
   Nimbus asserts things (search, `decisions`, `glossary`, `why`, the graph) until the owner runs
   `nimbus captures accept <id>`; after acceptance it appears, still labelled agent-authored.
3. No MCP client can accept, reject or revoke anything.
4. Default off; one flag turns it on; org policy can lock it off.
5. `nimbus prove` is unaffected — nothing here is egress.

**Owner rulings recorded in brainstorming (do not relitigate).**

- Scope: *capture now, act later* — the I28 envelope is designed to cover HITL-gated connector
  actions, but only capture ships in this spec (§ 9 sketches the act door).
- All four capture kinds: notes, decisions, glossary terms, links.
- Trust is **tiered by blast radius**: notes are live at once; the other three are proposals that
  count only after owner acceptance. No blocking prompt in the agent's turn.
- Approach **A**: one `capture` table + one gate; native rows written only on accept.

## 2. Non-goals

- No HTTP/SSE transport. stdio only, so I5/I6/I10 are not engaged.
- No owner-side `nimbus note add` (owner capture). `capture.submit` serves declared-`mcp` clients only.
- No Tauri/desktop review UI; review is CLI-only in this slice.
- No connector actions (`propose_action`) — § 9, own spec.
- No edit of a capture after submit. A wrong capture is rejected/revoked and re-submitted.
- No ChatOps or HTTP exposure of any `capture.*`/`captures.*` method.

## 3. Architecture

```
MCP client (Claude Code / Cursor)
   │ stdio
   ▼
nimbus mcp-server  (packages/cli/src/mcp/)
   ├─ 21 existing read-only tools (unchanged)
   └─ capture-tools.ts — capture_note, propose_decision, propose_term, propose_link
        registered ONLY when capture.status says enabled AND session.declareKind("mcp") succeeded
   │ IPC  capture.submit   (session kind = declared "mcp")
   ▼
gateway  ipc/capture-rpc.ts  →  mcp-sink/capture-gate.ts  submitCapture()   ← I28 chokepoint
                                     │
                                     ├─ mcp-sink/capture-store.ts  (sole owner of the `capture` table)
                                     ├─ index/item-store.ts upsertIndexedItem  (notes; accepted proposals)
                                     └─ on accept only: decisions / glossary / graph native writers
owner:  nimbus captures list|show|accept|reject|revoke   →  ipc/capture-rpc.ts → capture-gate.ts
```

### 3.1 Files

| File | Role |
|---|---|
| `packages/gateway/src/mcp-sink/capture-types.ts` | `CaptureKind`, `CaptureState`, per-kind payload types, error codes |
| `packages/gateway/src/mcp-sink/capture-validate.ts` | whitelist rebuild per kind (I32 shape), caps |
| `packages/gateway/src/mcp-sink/capture-store.ts` | the ONLY module naming the `capture` table |
| `packages/gateway/src/mcp-sink/capture-gate.ts` | `submitCapture`, `acceptCapture`, `rejectCapture`, `revokeCapture` — ordered checks |
| `packages/gateway/src/mcp-sink/capture-native.ts` | the accept-time native writers (decision / term / link) and their inverse for revoke; called only by the gate |
| `packages/gateway/src/mcp-sink/capture-rate-limit.ts` | per-session sliding hour window (in-memory) |
| `packages/gateway/src/mcp-sink/capture-capability.ts` | config + policy resolution, read live per call |
| `packages/gateway/src/mcp-sink/capture-client-policy.ts` | total `Record<ClientKind, …>` for submit vs owner methods |
| `packages/gateway/src/ipc/capture-rpc.ts` | `capture.*` + `captures.*` dispatcher |
| `packages/gateway/src/config/nimbus-toml-mcp-sink.ts` | `[mcp_sink]` loader |
| `packages/gateway/src/index/capture-v66-sql.ts` | V66 DDL (PR 1) |
| `packages/gateway/src/index/capture-native-v67-sql.ts` | V67 rebuilds + relation types (PR 2) |
| `packages/cli/src/mcp/capture-tools.ts` | the four MCP tools |
| `packages/cli/src/commands/captures.ts` | `nimbus captures …` |

## 4. Data model

### 4.1 V66 — `capture` (PR 1)

```sql
CREATE TABLE IF NOT EXISTS capture (
  id            TEXT PRIMARY KEY,               -- 'cap_' || ULID
  kind          TEXT NOT NULL CHECK(kind IN ('note','decision','term','link')),
  state         TEXT NOT NULL CHECK(state IN ('live','proposed','accepted','rejected','revoked')),
  item_id       TEXT,                           -- nimbus:capture item; NULL while proposed / after revoke
  payload_json  TEXT,                           -- whitelist-rebuilt payload; NULL after revoke (tombstone)
  payload_bytes INTEGER NOT NULL,               -- byte length at submit; survives revoke for the audit trail
  client_label  TEXT,                           -- MCP clientInfo.name, truncated 100; display only, never trusted
  session_id    TEXT NOT NULL,                  -- gateway clientId of the submitting connection
  native_ref    TEXT,                           -- set on accept: decision_record.id | glossary term_key | '<from>|<to>|<type>'
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER,
  CHECK (
    (kind = 'note' AND state IN ('live','revoked'))
    OR (kind <> 'note' AND state IN ('proposed','accepted','rejected','revoked'))
  ),
  CHECK ((state = 'revoked') = (payload_json IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_capture_state_created ON capture(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capture_session_created ON capture(session_id, created_at DESC);
```

Legal transitions, enforced in `capture-store.ts` by `UPDATE … WHERE state = <expected>` with a
row-count check (a lost race refuses rather than double-applies):

- note: `live → revoked`
- decision / term / link: `proposed → accepted | rejected`; `accepted → revoked`

`rejected` keeps its payload (owner may want to see what was refused) and is pruned by retention
(§ 4.5). `revoked` clears the payload in the same statement.

### 4.2 Payloads (whitelist-rebuilt, never spread)

`capture-validate.ts` builds a fresh object from named fields only. Prose fields **truncate**;
structured fields **refuse** (`ERR_CAPTURE_INVALID`) — the I32 split.

| kind | field | type | bound |
|---|---|---|---|
| note | `title` | string | truncate 200 |
| | `body` | markdown string | truncate `BODY_MAX_PROSE` (16,384); refuse empty |
| | `tags` | string[] | ≤ 10 entries, each ≤ 50, refuse beyond |
| | `relatesTo` | item id[] | ≤ 10, each must exist in `item` |
| decision | `statement` | string | truncate 500; refuse empty |
| | `rationale` | string | truncate 4,096 |
| | `alternatives` | string[] | ≤ 10, each truncate 500 |
| | `decidedAt` | integer ms | inside `Date` range, else refuse; default = submit time |
| | `evidence` | item id[] | ≤ 10, each must exist |
| term | `term` | string | ≤ 100 (refuse beyond — it is a key) ; refuse empty |
| | `definition` | string | truncate 2,048; refuse empty |
| | `synonyms` | string[] | ≤ 10, each ≤ 100 |
| link | `fromItemId`, `toItemId` | item id | must exist; must differ |
| | `relation` | enum | `relates_to` \| `fixes` \| `caused_by` \| `supersedes` \| `documents` |
| | `note` | string | truncate 500 |

Unknown sibling keys are dropped silently by construction (never read). The total rebuilt payload
is additionally refused above 32 KiB, independent of the per-field caps, so the bound holds even if
a future field is added without a cap.

**Item-existence check** is one `SELECT id FROM item WHERE id IN (…)`. A referenced id that is
itself a `nimbus:capture` item is allowed only when that capture is `live` or `accepted`.

### 4.3 The `nimbus:capture` item

`service = "nimbus"`, `type = "capture"`, `externalId = <capture id>`, so the item primary key is
derived by the existing `itemPrimaryKey("nimbus", id)`. Written via `upsertIndexedItem` and then
scheduled for embedding (the `ingestClip` pattern).

- **note** — created at submit. Title = note title; body = note body; `metadata` =
  `{ captureKind: "note", captureId, agentAuthored: true, clientLabel, tags, relatesTo }`.
- **decision / term / link** — **no item while proposed.** The item is created at accept time with
  a rendered body (`Decision: …\nRationale: …`, `Term: … — …`, `Link: <from> —relates_to→ <to>`).
  Consequence: a proposal is absent from search, embeddings and every brief **by construction** —
  there is no row to filter, so no reader needs a proposed-state filter.

**Extraction passes cannot see capture items.** `DECISION_SOURCE_TYPES` and
`GLOSSARY_SOURCE_TYPES` are allowlists that do not contain `nimbus:capture`; a test pins that
neither set ever contains it, so agent text never reaches a native store by being "extracted".

### 4.4 V67 — native-store provenance (PR 2)

Table rebuilds (the V46 `glossary_term` rebuild is the precedent; follow `nimbus-db-migrations`):

- `decision_record.extraction_source` CHECK widens to `('llm','snippet','agent')`.
- `glossary_term.definition_source` CHECK widens to `('llm','snippet','manual','agent')`.
- Five new directed relation types, prefixed so they can never coincide with a populator-written
  edge: `captured_relates_to`, `captured_fixes`, `captured_caused_by`, `captured_supersedes`,
  `captured_documents`. Revoke can then delete the edge without ever removing an edge a populator
  owns, since `upsertGraphRelation`'s `ON CONFLICT (from_id,to_id,type)` can only collide with
  another capture.

Both rebuilds must preserve every existing row byte-identically (integration test, § 10).

### 4.5 Retention

`rejected` rows older than 90 days are deleted by the existing nightly prune hook (same 90-day bound
as `pushed_brief`). `live`, `accepted` and `revoked` (payload-free) rows are kept. A GDPR purge
deletes all capture rows and their items.

## 5. The gate (I28)

### 5.1 `submitCapture(deps, ctx, input)` — fixed order

1. **Capability** — `capture-capability.ts`: refuse `ERR_CAPTURE_DISABLED` when `[mcp_sink]
   enabled = false` or the resolved org policy disables `mcp_capture`; refuse when the policy
   accessor is absent (fail-closed, I22).
2. **Client kind** — `capture-client-policy.ts`'s total `Record<ClientKind, "submit" | "owner" |
   "refuse">`: only `mcp` maps to `submit`. `unknown` maps to `owner`, so an undeclared CLI cannot
   submit. Otherwise `ERR_CAPTURE_FORBIDDEN_CLIENT`.
3. **Kind allowed** — `kind ∈ [mcp_sink] kinds`, else `ERR_CAPTURE_KIND_NOT_ALLOWED`.
4. **Rebuild + validate** — § 4.2, else `ERR_CAPTURE_INVALID`.
5. **Referenced items exist** — else `ERR_CAPTURE_UNKNOWN_ITEM` (names the first missing id).
6. **Rate limit** — per `session_id`, `max_per_hour`, else `ERR_CAPTURE_RATE_LIMITED`. Counts are
   in-memory; a gateway restart resets them (stated bound; the pending cap is durable).
7. **Pending cap** — for non-note kinds, `COUNT(*) WHERE state='proposed'` < `max_pending`, else
   `ERR_CAPTURE_QUEUE_FULL`.
8. **Write** — in ONE transaction: `capture` row; for a note, the item too.
9. **Audit** — one `capture.submit` `audit_log` row: `{captureId, kind, payloadBytes, clientLabel,
   outcome}`, `hitl_status = 'not_required'` for every kind (for a proposal, the
   proposal *is* the request for approval; approval is recorded on `capture.accept`). A refusal at
   steps 1–7 also appends one row with `outcome: <code>` and no payload. An audit append failure
   rolls back the write (fail-closed).

After commit, a note's item is scheduled for embedding (outside the transaction, the `ingestClip`
pattern).

### 5.2 `acceptCapture(deps, ctx, id)` — owner only

1. Capability check as above (a disabled sink also cannot accept — turning it off freezes the queue).
2. Client kind must map to `owner` (`cli`, `ui`, `unknown`); `mcp` and every other kind refuse
   `ERR_CAPTURE_FORBIDDEN_CLIENT`.
3. Row must be `proposed`, else `ERR_CAPTURE_STATE` (names the current state).
4. Re-check referenced items still exist (they may have been deleted since submit), else
   `ERR_CAPTURE_UNKNOWN_ITEM`.
5. Kind-specific precondition:
   - **decision** — none beyond 4.
   - **term** — if a `glossary_term` row exists for the term key with `status='vetoed'` or
     `definition_source='manual'`, refuse `ERR_CAPTURE_SUPERSEDED` (the owner's own veto / config
     wins). An `llm`/`snippet` row is taken over, exactly as a manual term takes over a mined one.
   - **link** — each endpoint must resolve to an existing `graph_entity` with
     `external_id = <itemId>` and `type ∈ ITEM_LINKED_ENTITY_TYPES`
     (`graph/relationship-graph.ts`). Else `ERR_CAPTURE_LINK_UNRESOLVED`; the capture stays
     `proposed` so it can be accepted after a regraph.
6. In ONE transaction: create the `nimbus:capture` item; write the native row via
   `capture-native.ts`; set `state='accepted'`, `native_ref`, `decided_at`; append `capture.accept`
   audit row with `hitl_status='approved'`.
   - **decision** → `decision_record` (`status='extracted'`, `extraction_source='agent'`,
     `confidence=1.0`, `cue_tier='explicit'`, `cue_text='agent capture'`, `source_item_id` = the
     capture item, `decided_at` = payload) + one `decision_evidence` row per evidence id
     (`kind='source'`).
   - **term** → `glossary_term` (`status='consolidated'`, `definition_source='agent'`,
     `consolidated_at` = now; stats computed by the existing `computeTermStats`).
   - **link** → `upsertGraphRelation(from, to, 'captured_<relation>', now)`; `native_ref` =
     `<fromEntityId>|<toEntityId>|captured_<relation>`.

`rejectCapture` = steps 1–3, then `state='rejected'`, audit `capture.reject` with
`hitl_status='rejected'`. Nothing native is written.

### 5.3 `revokeCapture(deps, ctx, id)` — owner only

Allowed from `live` (note) or `accepted`. ONE transaction: delete the native row via
`capture-native.ts`'s inverse (decision_record cascades its evidence; glossary row deleted only if
it is still `definition_source='agent'` — if a later pass or manual term took it over, it is left
alone; graph edge by its triple), delete the item and its chunks/embeddings through the existing
item-delete path, set `state='revoked'`, `payload_json=NULL`, `item_id=NULL`; audit
`capture.revoke`. Idempotent: revoking a `revoked` row is a no-op success.

**Revoke does not require the sink to be enabled** — withdrawing agent text must always be possible,
including after the owner turned the feature off because something went wrong.

### 5.4 Disclosure after acceptance (I31)

Accepted agent text is never presented as owner-authored or extracted:

- `nimbus decisions` / `nimbus why` render an accepted `extraction_source='agent'` decision with a
  disclosure line: *"Agent-authored (captured via MCP, accepted by the owner on <date>)."*
- `nimbus glossary` renders a `definition_source='agent'` term with the same disclosure.
- Each sentence is defined once in `agents/_lib/brief-disclosures.ts` with its anchors, so the
  synthesis guard (`contractViolations`) fails a rewrite that drops it.
- When a capture item reaches a model (search results, agent tools), it already passes through
  `wrapToolOutput` (I11); its `metadata.agentAuthored = true` is included in the wrapped result.

## 6. MCP tool contract

`packages/cli/src/mcp/capture-tools.ts`, mirroring `agent-tools.ts`. Each tool's zod schema is never
stricter than the gateway's validation (the gateway is authoritative; the adapter only shapes).

| Tool | Input | Success text |
|---|---|---|
| `capture_note` | `title`, `body`, `tags?`, `relatesTo?` | `Captured note <id>. It is stored locally, searchable now, and labelled agent-authored. The owner can revoke it with \`nimbus captures revoke <id>\`.` |
| `propose_decision` | `statement`, `rationale?`, `alternatives?`, `decidedAt?` (ISO 8601, converted), `evidence?` | `Proposed decision <id>. It is NOT recorded yet: it appears nowhere until the owner runs \`nimbus captures accept <id>\`. Do not tell the user it has been recorded.` |
| `propose_term` | `term`, `definition`, `synonyms?` | same shape |
| `propose_link` | `fromItemId`, `toItemId`, `relation`, `note?` | same shape |

Descriptions state that content is stored on the user's machine, labelled agent-authored, and (for
`propose_*`) inert until owner review. Annotations: `readOnlyHint: false`, `destructiveHint: false`,
`idempotentHint: false`, `openWorldHint: false`.

**Advertising.** At adapter start, after `session.declareKind("mcp")`, the adapter calls
`capture.status`. The four tools are registered only when it returns `enabled: true`, and only for
the kinds in `kinds`. If `declareKind` failed, or `capture.status` is `Method not found` (older
gateway), or `enabled` is false, no capture tool is registered and `nimbus mcp-server --help`
explains the condition. A config change takes effect on the next MCP-server start (documented).

**Errors** reach the client as `isError: true` results: `<CODE>: <one sentence>`, built by
`tool-runtime.ts`'s existing `runTool` envelope.

## 7. IPC surface

| Method | Allowed kinds | Params → result |
|---|---|---|
| `capture.status` | all | `{}` → `{enabled, kinds, pending, maxPending, maxPerHour, disabledReason?}` |
| `capture.submit` | `mcp` | `{kind, payload, clientLabel?}` → `{id, state}` |
| `captures.list` | owner | `{state?, kind?, limit?}` → `{captures: CaptureSummary[]}` (no payload body, title/statement/term preview ≤ 120) |
| `captures.get` | owner | `{id}` → full capture incl. payload |
| `captures.accept` | owner | `{id}` → `{id, state, nativeRef}` |
| `captures.reject` | owner | `{id}` → `{id, state}` |
| `captures.revoke` | owner | `{id}` → `{id, state}` |

- **Routing:** both namespaces are wired in `ipc/server/dispatchers.ts`'s outer method match AND in
  the inner `capture-rpc.ts` dispatcher; the E2E test proves the outer entry (the `ask.explainLast`
  lesson).
- **LAN:** all seven added to the `checkLanMethodAllowed` denylist (it is a denylist; a new namespace
  is LAN-reachable by default).
- **Tauri:** none added to `ALLOWED_METHODS` (stays at 107).
- **HTTP:** no route.
- **Demo (I41):** a demo-rooted gateway serves them against its demo DB; nothing to gate, since the
  sink makes no outbound call and writes only the demo index.

## 8. Config, policy, CLI

### 8.1 `[mcp_sink]`

```toml
[mcp_sink]
enabled = false                                   # DEFAULT OFF
kinds = ["note", "decision", "term", "link"]      # non-empty subset; unknown name refuses at load
max_per_hour = 30                                 # 1..1000, per MCP session
max_pending = 100                                 # 1..10000, proposals awaiting review
```

Out-of-range values or unknown kinds refuse **loudly at config load**, naming key and value — never
clamped (the `max_subjects` / `vlm_base_url` posture).

### 8.2 Policy

`mcp_capture` becomes the eighth `AI_V2_CAPABILITIES` name (`policy/types.ts`). Locked off: status
reports `disabledReason: "policy"`, submit and accept refuse; list/get/reject/revoke still work so
the owner can drain the queue. Read live per call; absent accessor = disabled.

### 8.3 `nimbus captures`

```
nimbus captures [list] [--state proposed|live|accepted|rejected|revoked] [--kind …] [--json]
nimbus captures show <id> [--json]
nimbus captures accept <id>
nimbus captures reject <id>
nimbus captures revoke <id>
```

`list` defaults to `--state proposed`. `show` prints the full payload with the client label and the
agent-authored banner. `accept` prints what native row was written. Exit codes: `0` success, `1`
refusal (code printed), `2` usage. `nimbus doctor` adds one line when `[mcp_sink]` is enabled and
proposals are pending (`N captures awaiting review — nimbus captures`).

## 9. The act door (sketch only — separate spec)

```
propose_action (MCP) → capture kind 'action', state proposed      (same gate, same queue, same cap)
nimbus captures accept cap_…   (owner's CLI session)
  → acceptCapture builds an executor action → ToolExecutor.gate()
      → consent.request UNICAST to the accepting session (I2) — the owner, never the agent
      → egress_ledger row before dispatch (I29) → connectors.dispatch
```

The agent never holds the approval channel, so no out-of-band approval surface is needed. That
spec adds `'action'` to the `kind` CHECK (a new migration), a per-action-type whitelist, I42
interplay for `mcp_*` services, and the I28 wording extension. Nothing in this spec pre-allows it.

## 10. Invariant + static rule

### 10.1 I28 (fills the reserved slot)

> **I28** — content from an MCP client enters Nimbus only through `mcp-sink/capture-gate.ts`'s
> `submitCapture()`, and becomes something Nimbus asserts only through the owner's
> `acceptCapture()`. Submit runs a fixed order (capability incl. policy, fail-closed → declared `mcp`
> kind only → kind allowed → whitelist rebuild → referenced items exist → rate limit → pending cap →
> one-transaction write → audit, fail-closed). A proposal has no item, no native row and no
> embedding until accepted, so it is absent from search and every brief by construction. Accept,
> reject and revoke refuse the `mcp` kind, and the MCP adapter registers no tool that reaches them
> (capability removal primary, kind check defense in depth). Accepted text keeps `'agent'`
> provenance and an anchored disclosure (I31). Extraction passes cannot read capture items (their
> source-type allowlists exclude `nimbus:capture`). **Bounds:** acceptance proves the owner saw the
> text, not that it is true; a live note is searchable unreviewed, by design; text reaching a model
> is delimited by I11, not sanitised; the hourly rate limit resets on gateway restart (the pending
> cap does not).

Docs: `docs/SECURITY-INVARIANTS.md` § I28 replaces the reservation note; CLAUDE.md and GEMINI.md
I28 bullets updated; triple rule — wiring + docs + `security-invariants.test.ts` row in the same
commit.

### 10.2 D32 (static, `check-nimbus-invariants.ts`)

- **D32(a)** — the `capture` table identifier (bare or SQLite-quoted, word-bounded so `capture_*`
  and `tribal capture` do not match) appears only in `mcp-sink/capture-store.ts` and
  `index/capture-v66-sql.ts`.
- **D32(b)** — `submitCapture` / `acceptCapture` / `rejectCapture` / `revokeCapture` are called only
  from `ipc/capture-rpc.ts` (and defined only in `capture-gate.ts`).
- **D32(c)** (PR 2) — the `'agent'` provenance literal inside a `decision_record` or `glossary_term`
  write appears only in `mcp-sink/capture-native.ts` and `index/capture-native-v67-sql.ts`.

Stated bound: a dynamically composed identifier evades a text scan; capability confinement (only the
store receives the `Database` for the table) is the real defense, as with D27(b).

Each rule is red-proved by a fixture that must fail.

## 11. Testing

| Layer | File(s) | Proves |
|---|---|---|
| unit | `capture-validate.test.ts` | sibling keys dropped; prose truncates; structured fields refuse; 32 KiB total cap; empty required fields refuse |
| unit | `capture-client-policy.test.ts` | `Record` total over `ClientKind`; only `mcp` submits; `mcp` never owner |
| unit | `capture-gate.test.ts` | each refusal code at its step; order (a disabled sink refuses before validation — no payload read); audit row per outcome; audit failure rolls back |
| unit | `capture-rate-limit.test.ts` | window edges per session |
| unit | `nimbus-toml-mcp-sink.test.ts` | defaults; loud refusal for each bad value (80% branch floor — write branch tests up front) |
| unit | `capture-tools.test.ts` (cli) | tools absent when disabled / declareKind failed / Method not found; registered per `kinds`; result texts |
| integration (real SQLite, `CURRENT_SCHEMA_VERSION`) | `test/integration/mcp-sink/*.test.ts` | V66 applies on a populated DB; proposal absent from search/decisions/glossary/graph; accept writes native row + item in one txn; revoke removes all and tombstones; vetoed/manual term wins; link unresolved stays proposed; lost-race transition refuses; `DECISION_SOURCE_TYPES`/`GLOSSARY_SOURCE_TYPES` exclude `nimbus:capture`; (PR 2) V67 rebuilds preserve every existing row byte-identically and the manual glossary pass leaves `'agent'` rows alone |
| E2E | `packages/gateway/test/e2e/mcp-capture.e2e.test.ts` | real gateway + real `nimbus mcp-server` subprocess driven by the MCP SDK client over stdio: `capture_note` → found by `search`; (PR 2) `propose_decision` → absent from `nimbus decisions`; `nimbus captures accept` → present with disclosure; `revoke` → gone; sink off → tools absent from `tools/list`. Proves outer IPC routing. |
| invariant | `security-invariants.test.ts` | I28 row |
| static | `check-nimbus-invariants` fixtures | D32(a)(b)(c) each red-proved |

All fixtures built through the real writers (`upsertIndexedItem`, the decision/glossary stores),
never hand-written rows — the lane-contract lesson.

## 12. Delivery

**PR 1 — notes end to end.** V66; `capture-*` modules (note kind only exercised, but validate/store
already typed for all four); `capture.status` / `capture.submit`; `captures.list|get|revoke`;
`capture_note`; `[mcp_sink]`; `mcp_capture` policy name; I28 + D32(a)(b); `nimbus captures`
(list/show/revoke); doctor line; E2E for notes. Docs: SECURITY-INVARIANTS, architecture
(§ Spine S3 Subsystems, new), cli-reference, CHANGELOG, roadmap S3 row (lean scope recorded),
CLAUDE.md + GEMINI.md.

**PR 2 — proposals.** V67 rebuilds + `captured_*` relation types; `propose_decision|term|link`;
`captures.accept|reject`; `capture-native.ts`; brief disclosures; D32(c); manual-pass `'agent'`
exclusion; E2E extended.

**PR 3 — act door.** Own spec (§ 9).

PR titles: `feat(mcp): …` — no `!` (nothing an existing user must change; default off).

## 13. Risks and open points

- **Prompt-injected notes.** A live note is searchable unreviewed. Mitigation: label + revoke +
  rate limit + default off. Accepted residual, stated in I28.
- **Review fatigue.** If the owner never reviews, `max_pending` stops new proposals and `doctor`
  says so — the failure is visible, not silent.
- **`clientInfo.name` is attacker-controlled.** Display only, truncated, never used for any
  decision.
- **Glossary takeover semantics** rely on the existing manual-over-mined path; PR 2 must confirm
  `glossary-store.ts`'s upsert keeps `'agent'` from being demoted by the next extraction pass (an
  extraction pass must treat `'agent'` like `'manual'`: never overwrite).
