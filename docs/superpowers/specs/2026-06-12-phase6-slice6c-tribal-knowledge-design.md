# Phase 6 Slice 6c — Tribal-Knowledge Extraction (design)

**Date:** 2026-06-12
**Branch:** `dev/asafgolombek/phase6-slice6c-tribal-knowledge` (worktree `.claude/worktrees/phase6-slice6c`, off main `262d5365`)
**Status:** design — approved sections 1–3, pending written-spec review
**Completes:** Phase 6 Slice 6 (after 6a cross-colleague read-only agents + 6b federated action requests)

---

## 1. Summary

A **live Slack/Teams watcher** that detects repeated questions ("how do I deploy X?") in the
team's shared channels and proactively suggests capturing the answer into a **locally-configured
shared knowledge base** (Notion database / Confluence space). Capture synthesizes a draft answer
with citations from the team's already-indexed history, routes it through the **local owner's HITL
gate** (approve / edit / reject), and writes it via new **HITL-gated** Notion/Confluence write tools.

The write destination is **local-config-only** and never selectable by the chat message or IPC
caller — a new structural invariant **I25** (static **D19**), in the same "the wire never picks the
target" family as I23 (chat reply destination) and I24 (preflight command).

This is the heaviest 6.x slice: it adds the project's **first write tools** on the Notion/Confluence
connectors (their sync stays read-only), a **V39** migration, and a new invariant.

### Non-goals (YAGNI)

- No federated peer-query path: detection is **channel-scoped** via the existing Slice 5 ChatOps
  bot. The "cross-colleague" value comes from watching shared *team* channels, not from querying
  peers' indexes.
- No auto-write: nothing is ever written without the local owner's explicit HITL approval.
- No Phase 7 automation-template emission (the roadmap's "feeds the automation library" half is
  deferred to Phase 7 — 6c only produces KB pages).
- No caller-chosen destination, no arbitrary-page writes (structurally forbidden by I25).

---

## 2. Architecture & data flow

New subsystem: `packages/gateway/src/tribal/`. The live watcher rides on the **existing Slice 5
ChatOps transport** (Slack Socket Mode / Teams webhook) — it subscribes to the same inbound message
stream the bot already receives. The whole subsystem is gated on `[tribal].enabled` (ships inert).

Per inbound channel message, a cheap → expensive pipeline:

1. **Question classifier** (`is-question.ts`) — cheap gate: interrogative shape (`?`, leading
   question words). Non-questions drop here, before any embedding work.
2. **Repeat detector** (`repeat-detector.ts`) — two-stage, config-driven:
   - **Recall:** embed the question and vector-search the already-indexed Slack/Teams history
     (reuses the Nimbus embedding + search path) for prior semantically-similar questions.
   - **Precision (optional, `match = "embedding+llm"`):** an LLM-judge adjudicates the small
     candidate set for same-intent, reducing false clusters. Off by default (embedding-only).
   - Maintains/loads the cluster from the store; **fires** when occurrence count ≥ `min_occurrences`
     within `window_days`, and the cluster is not already `captured`/`dismissed`/in cooldown.
3. **Cluster store** (`cluster-store.ts` over the V39 `tribal_clusters` table) — persists each
   cluster so suggestions survive restarts and are de-duplicated.
4. **Suggestion post** — on fire, via the **I23 reply-dispatcher** (`chatops/reply-dispatcher.ts`)
   to a server-derived target (the originating channel, or a policy `notify` channel). The post is a
   lightweight nudge carrying a "Save to KB" affordance — **no answer is synthesized yet**.
5. **Capture (lazy synthesis + owner HITL)** — triggered by the chat button (via the Slice 5
   `approval-presenter`) *or* `nimbus tribal capture <id>`. Only now does the **answer synthesizer**
   (`answer-synthesizer.ts`) gather the cluster's prior threads from the index and draft an answer +
   citations; the draft is presented at the **local owner's HITL gate** (approve / edit / reject).
6. **KB write (I25 gate)** — `tribal/tribal-write-gate.ts` `captureToKnowledgeBase()` is the *sole*
   path from a capture to a KB write: destination resolved from **local config only** (fail-closed),
   then written via an ephemeral-credentialed Notion/Confluence connector spawn (reusing the
   Slice 2/5 credential-injection + I15-sandbox pattern).

**Lazy synthesis** is a deliberate efficiency choice: dismissed suggestions never cost an LLM call.

> **Implementation risk (verify in the plan):** today the Slice 5 ChatOps service routes only
> **@nimbus-addressed** messages to its `handleMessage` (the `IntentRouter` consumes `@nimbus …`).
> Tribal detection needs to observe **all** channel messages (questions not addressed to the bot).
> The plan must confirm the transport's event subscription delivers non-mention channel messages
> (Slack `message.channels` scope; Teams channel-message subscription) and add a **fan-out seam** so
> the inbound stream feeds *both* the existing intent-router and the new tribal watcher, without the
> tribal path ever invoking the executor write surface (it only reads + posts suggestions). This is
> a transport-scope + wiring change in `chatops/chatops-service.ts` / `chatops/transport/`, not a new
> transport.

### Components & responsibilities

| File | Responsibility | Depends on |
|---|---|---|
| `tribal/is-question.ts` | Pure: classify a message as a question (cheap, no I/O) | — |
| `tribal/repeat-detector.ts` | Embed + recall + optional LLM-judge → cluster decision | index/search, embeddings, cluster-store, (LLM) |
| `tribal/cluster-store.ts` | CRUD over `tribal_clusters`; status transitions, cooldown, dedup | `db/write.ts` (I14) |
| `tribal/answer-synthesizer.ts` | Draft answer + citations from a cluster's indexed threads | index read, LLM (`wrapToolOutput`, I11) |
| `tribal/tribal-write-gate.ts` | **I25**: config-only destination + owner HITL → KB write | config, HITL gate, connector spawn |
| `tribal/tribal-watcher.ts` | Wire the pipeline onto the ChatOps inbound stream; gated on enabled | chatops transport, the above |
| `tribal/tribal-suggestion.ts` | Build the suggestion message + "Save to KB" affordance; post via I23 | `chatops/reply-dispatcher.ts` |

---

## 3. Config schema

```toml
[tribal]
enabled = false                 # ships inert, like [chatops]/[federation]
match = "embedding"             # "embedding" | "embedding+llm"
min_occurrences = 3             # cluster fires at N repeats
window_days = 14                # …within this rolling window
cooldown_days = 30              # don't re-suggest a dismissed/captured cluster for this long
watch_channels = ["C0123..."]   # channel IDs to watch (empty = every channel the bot is in)

[tribal.notion]                 # configure one OR both targets; absent = that target unavailable
database_id = "…"               # captures = new rows (pages) in this Notion database

[tribal.confluence]
space_key = "ENG"
parent_page_id = "12345"        # captures = child pages under this parent
```

Parsing lives in `config/nimbus-toml.ts`; the parsed `TribalConfig` carries the validated
destinations. An unconfigured target makes capture to that target fail closed (`not_configured`).

---

## 4. Invariant I25 (static D19)

**Statement.** A tribal-knowledge capture writes only to a **locally-configured** knowledge-base
destination, behind the **local owner's HITL** gate; the chat message / IPC caller never selects the
destination, and an unconfigured destination fails closed.

- **Production wiring:** `tribal/tribal-write-gate.ts` `captureToKnowledgeBase()` — the sole path
  from a capture request to a Notion/Confluence KB write. It (a) resolves the target from
  `[tribal.notion]` / `[tribal.confluence]` **only** (fail-closed `not_configured` if absent),
  (b) requires the local owner's HITL approval before the write, (c) never reads a destination from
  the request payload.
- **Static D19:** `scripts/structure-audit/check-nimbus-invariants.ts` confines the KB write-tool
  identifiers (`notion_kb_append` / `confluence_kb_append`) to `tribal-write-gate.ts` (and the
  connector definition sites), mirroring D17/D18.
- **Runtime test** (`security-invariants.test.ts`, an `I25` describe block): proves
  (a) a caller-supplied destination field is ignored (only the config target is written),
  (b) fail-closed when the target is unconfigured,
  (c) the write tool is never invoked before HITL approval resolves.

This sits alongside **I23** (chat *reply* destination is server-derived) and **I24** (preflight
*command* from local config) — the same "the wire never picks the target" family. The triple
(wiring + docs row in `SECURITY-INVARIANTS.md` + runtime test + D19) lands in one commit.

---

## 5. Connector write tools (new)

The Notion and Confluence connectors gain their first **write** tools (sync stays read-only):

- `notion_kb_append` — create a page/row in the configured database with the synthesized Q&A
  (title = question, body = answer + citations).
- `confluence_kb_append` — create a child page under the configured parent.

Both are **HITL-required**: new action types `notion.knowledge.write` / `confluence.knowledge.write`
join the `HITL_REQUIRED` frozen-set (I2), so the gate provably fires before either tool runs.
Credentials are injected via the ephemeral-credentialed connector spawn (Slice 2/5 pattern,
inheriting I1 env-scoping + I15 sandbox). The tools accept only a **config-resolved** destination
(passed by the I25 gate), never a caller-named page.

---

## 6. Schema — V39 migration

Adds `tribal_clusters`:

| column | type | note |
|---|---|---|
| `cluster_id` | TEXT PK | stable key for the canonical question |
| `representative_question` | TEXT | the canonical/first question text |
| `occurrence_count` | INTEGER | repeats observed in-window |
| `first_seen` / `last_seen` | INTEGER | epoch ms |
| `status` | TEXT | `pending` \| `suggested` \| `captured` \| `dismissed` |
| `channel_id` | TEXT | originating channel (for the suggestion target) |
| `suggested_at` | INTEGER NULL | when the suggestion was posted |
| `cooldown_until` | INTEGER NULL | suppress re-suggestion until this time |
| `captured_page_ref` | TEXT NULL | KB page/row id once written |

`CURRENT_SCHEMA_VERSION` → **39**. Append-only/forward-only per the migration rules.

---

## 7. Surfaces

**CLI — `nimbus tribal`:**

- `status` / `start` / `stop` — watcher control (mirrors `nimbus chatops`)
- `list` — pending / suggested clusters
- `capture <cluster-id>` — trigger the owner-HITL synthesis + write
- `dismiss <cluster-id>` — mark dismissed (enters cooldown)
- `scan` — on-demand detection over recent indexed history *without* the live watcher (useful
  before enabling the watcher, and for deterministic testing)

**IPC — `tribal.*`** (`status` / `start` / `stop` / `list` / `capture` / `dismiss` / `scan`),
**local-only — forbidden over the LAN wire** (like `chatops.*`).

**Tauri (I7):** read-only `tribal.status` / `tribal.list` are renderer-exposed; `capture` /
`dismiss` / `start` / `stop` / `scan` stay CLI-only (capture mutates a remote KB; start/stop are
control-plane).

---

## 8. Testing

- **HITL:** the gate fires before each new `*.knowledge.write` action type (I2 test).
- **I25 runtime test:** caller-destination ignored · fail-closed when unconfigured · write never
  fires before HITL approval resolves.
- **Detector unit tests:** embedding recall + LLM-judge stub; `min_occurrences` / `window_days` /
  `cooldown_days` boundaries; dedup; restart persistence via the store.
- **Synthesizer test:** draft answer + citations from seeded index threads (LLM stubbed).
- **Question classifier:** question vs non-question table.
- **E2E** (real gateway + mock Slack transport + mock Notion/Confluence connector): message stream →
  cluster fires → suggestion posted → CLI `capture` → owner approve → KB write dispatched; plus
  `dismiss` → cooldown suppresses re-suggestion; unconfigured target → fail-closed.
- **Docker-Linux coverage-floor** for every new file (≥80% line + branch).

---

## 9. Implementation sequencing (one spec, internal checkpoint)

Large but cohesive — one spec, but build and test the **read-only detection + suggestion path first**
(classifier → detector → cluster-store → suggestion post + the watcher wiring + `scan`/`list`/
`dismiss` CLI), green and merged-in-spirit, **before** the write path (synthesizer → I25 gate →
connector write tools → `capture` → HITL → V39 already lands with the store). This gives a natural
internal checkpoint where nothing can write yet, de-risking the invariant work.

---

## 10. Open questions / decisions captured

- **Detection:** embedding-recall by default, optional LLM-judge precision (`match` config). ✅
- **Answer source:** LLM-synthesized draft + citations, HITL-editable. ✅
- **Write target:** config-pinned KB, new invariant I25/D19. ✅
- **Capture trigger:** both chat button and `nimbus tribal capture`. ✅
- **Federation:** channel-scoped via the ChatOps bot; not a federated peer-query. ✅ (assumption)
- **Synthesis timing:** lazy (at capture), not on every fire. ✅
