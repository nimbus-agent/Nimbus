# Phase 6 Slice 6c — Tribal-Knowledge Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live Slack/Teams watcher that detects repeated questions in allowlisted team channels and, on the owner's HITL approval, captures a synthesized Q&A into a config-pinned shared knowledge base (Notion/Confluence) — behind new invariant **I25** (static **D19**).

**Architecture:** A new `packages/gateway/src/tribal/` subsystem taps the existing Slice 5 ChatOps inbound message stream (fan-out seam in `chatops-boot.ts handleMessage`). Pipeline: cheap question classifier → embedding-recall repeat-detector (post-filtered to the `watch_channels` allowlist) → persistent `tribal_clusters` store (V39) → I23 suggestion post. Capture is lazy: it synthesizes a draft answer + citations only when triggered (CLI `capture` or chat button), routes through the **local owner's HITL gate**, then writes via new HITL-gated `notion_kb_append`/`confluence_kb_append` tools whose destination is resolved **from local config only** (I25). Built in two sequenced phases: **Phase A** = read-only detection + suggestion (nothing can write); **Phase B** = the write path + invariant.

**Tech Stack:** Bun 1.2+ / TypeScript strict · bun:sqlite · existing embedding worker (`embedQuery`, local MiniLM) · `vectorSearchChunks` · ChatOps transport (Slack Socket Mode / Teams webhook) · executor HITL gate (I2) · MCP connectors (Notion/Confluence) · `dispatchByMethod` IPC · static structure-audit.

---

## Verified load-bearing facts (from codebase exploration)

- **Inbound chokepoint:** `packages/gateway/src/chatops/chatops-boot.ts:255-276` — the `handleMessage` closure inside `buildChatopsBoot()`. `ChatMessage` = `{ platform, channelId, userId, text, ts }` (`chatops/types.ts:7-17`); **no thread field**. Transport: `ChatTransport.onMessage(h: (m: ChatMessage)=>Promise<void>)` (`chatops/transport/transport.ts:4-11`).
- **Slack delivers only `app_mention` today** (`chatops/transport/slack-socket-adapter.ts:54` rejects non-`app_mention`). Teams webhook delivers all `message` activities (`teams-webhook-adapter.ts:7`). Seeing all Slack messages requires (a) widening the Slack normalizer and (b) the deployed Slack app manifest subscribing to `message.channels` (deployment doc, not code).
- **I23 post:** `ReplyDispatcher.send(target, text)` with `ReplyTarget = {kind:"originating",platform,channelId} | {kind:"namespaceNotify",namespace}` (`chatops/reply-dispatcher.ts:21-33`, `chatops/types.ts:42-44`).
- **`item` table** (`index/unified-item-v3-sql.ts:16-31`): columns `id, service, type, external_id, title, body_preview, url, canonical_url, modified_at, author_id, metadata(TEXT JSON), synced_at, pinned`. **No channel column** — Slack messages store channel in `metadata.channel`, thread in `metadata.thread_ts` (`connectors/slack-sync.ts:276-293`); `service="slack"`, `type="message"`, `external_id="${channel}:${ts}"`.
- **Embed:** `WorkerBridge.embedQuery(text): Promise<Float32Array|null>` (`embedding/worker-bridge.ts:221-237`), local MiniLM `all-MiniLM-L6-v2` (384-dim, no network). Model name via `getEmbeddingModel()`.
- **Vector search:** `vectorSearchChunks(db, {queryEmbedding, model, limit, service?, itemType?, since?}): VectorChunkHit[]` (`search/vec-store.ts:12-72`); returns `{itemId, chunkIndex, chunkText, vecRowid, distance}`. **No channel filter** — post-filter on `metadata.channel`.
- **Read item:** `LocalIndex.getBodyPreview(id)` (`index/local-index.ts:462-471`); full rows via `item` query.
- **HITL frozen-set:** `HITL_REQUIRED_BACKING` (module-private `Set<string>`) in `engine/executor.ts:17`; public `HITL_REQUIRED.has(x)` (line 108); `gate()` consults `HITL_REQUIRED.has(action.type)` (line 228). Action-type→tool resolution: `action.payload.mcpToolId` else `action.type` (`engine/registry.ts:63-81`).
- **Notion/Confluence connectors:** `packages/mcp-connectors/{notion,confluence}/src/server.ts`. Notion HTTP helper `notionFetch(path, init?)` reads `NOTION_ACCESS_TOKEN`; create-page = `POST /v1/pages` with `{parent:{database_id|page_id}, properties}`. Confluence helper `confFetch()` reads `CONFLUENCE_BASE_URL/EMAIL/API_TOKEN`; create-page = `POST /content` with `{type:"page", title, space:{key}, ancestors:[{id}], body:{storage:{value, representation:"storage"}}}`. Secrets: `notion: ["notion.oauth"]`, `confluence: ["confluence.api_token","confluence.email","confluence.base_url"]` (`connectors/connector-secrets-manifest.ts`).
- **Config:** `parseNimbus<X>Toml` + `loadNimbus<X>FromConfigDir` convention (`config/nimbus-toml.ts`, `[chatops]` ~1085). Helpers: `forEachSectionEntry`, `parseBool`, `parseStringArray`, `loadTomlSection`.
- **Migration:** `CURRENT_SCHEMA_VERSION = 38` (`index/local-index.ts:269`); `simpleStep(from,to,label,SQL)` in `index/migrations/runner.ts` `INDEXED_SCHEMA_STEPS`; SQL const file `*-v38-sql.ts`.
- **CLI:** `COMMAND_NAMES` (`cli/src/commands/registry.ts`), `COMMAND_HANDLERS` (`cli/src/index.ts`), per-command file pattern (`commands/chatops.ts`).
- **IPC:** `dispatchByMethod` in `ipc/<ns>-rpc.ts`; wired via `tryDispatch<X>Rpc` in `ipc/server/dispatchers.ts`; LAN-forbid via the set in `ipc/lan-rpc.ts`; context on `ServerCtx` (`ipc/server/context.ts`).
- **Tauri allowlist:** `ALLOWED_METHODS` in `ui/src-tauri/src/gateway_bridge.rs`; **current count 88** (assert at ~line 481); JS-mirror assertion in `security-invariants.test.ts` (`allowlist_exact_size`).
- **Invariant triple exemplar (I24/D18):** runtime block in `security-invariants.test.ts`; static rule `checkPreflightRunnerInvariant` in `scripts/structure-audit/check-nimbus-invariants.ts` (confines `runPreflightCommand`); docs row in `docs/SECURITY-INVARIANTS.md`.
- **Boot:** ChatOps assembled in `platform/assemble.ts:1053-1128` gated `if (chatopsCfg.enabled)`. ChatOps internal closures (reply-dispatcher, service) are NOT exposed on the boot return — to wire tribal, pass the watcher INTO `buildChatopsBoot()` so it can hook `handleMessage` and reuse the reply-dispatcher.

---

## File structure

**New (gateway):**

- `packages/gateway/src/tribal/is-question.ts` — pure question classifier
- `packages/gateway/src/tribal/cluster-store.ts` — `tribal_clusters` CRUD + status/cooldown + nearest-cluster assignment
- `packages/gateway/src/tribal/repeat-detector.ts` — embed→recall→allowlist filter→cluster decision (+ optional LLM-judge)
- `packages/gateway/src/tribal/tribal-suggestion.ts` — build + post suggestion via I23
- `packages/gateway/src/tribal/tribal-watcher.ts` — pipeline orchestrator (`ingest(msg)`)
- `packages/gateway/src/tribal/answer-synthesizer.ts` — draft answer + citations from cluster sources (Phase B)
- `packages/gateway/src/tribal/tribal-write-gate.ts` — **I25** capture: config-only destination + owner HITL → KB write (Phase B)
- `packages/gateway/src/tribal/tribal-boot.ts` — assembles the subsystem, exposes RPC ctx
- `packages/gateway/src/index/tribal-clusters-v39-sql.ts` — V39 DDL
- `packages/gateway/src/ipc/tribal-rpc.ts` — `tribal.*` dispatcher

**New (cli):** `packages/cli/src/commands/tribal.ts`

**New (connectors):** `notion_kb_append` in `packages/mcp-connectors/notion/src/server.ts`; `confluence_kb_append` in `packages/mcp-connectors/confluence/src/server.ts`

**Modified:** `chatops/types.ts` (+`addressedToBot`), `chatops/transport/slack-socket-adapter.ts` (+message events), `chatops/chatops-boot.ts` (+fan-out hook + `buildChatopsBoot` dep), `search/vec-store.ts` (+optional `metadataChannelIn` SQL filter, review §2.1), `config/nimbus-toml.ts` (+`[tribal]`), `index/local-index.ts` (`CURRENT_SCHEMA_VERSION`), `index/migrations/runner.ts` (+V39 step), `engine/executor.ts` (+2 action types), `engine/registry.ts` (tool map for new tools, if needed), `ipc/server/{context,dispatchers}.ts`, `ipc/lan-rpc.ts`, `cli/src/commands/registry.ts`, `cli/src/commands/index.ts`, `cli/src/index.ts`, `cli/src/types/agents.ts` (if a brief type is surfaced), `ui/src-tauri/src/gateway_bridge.rs`, `security-invariants.test.ts`, `scripts/structure-audit/check-nimbus-invariants.ts`, docs.

---

## PHASE A — Read-only detection + suggestion (nothing can write)

## Task 1: V39 migration — `tribal_clusters`

**Files:**

- Create: `packages/gateway/src/index/tribal-clusters-v39-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts`, `packages/gateway/src/index/local-index.ts:269`
- Test: `packages/gateway/src/index/migrations/tribal-clusters-v39.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tribal-clusters-v39.test.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "./runner.ts";

test("V39 creates tribal_clusters with the expected columns", () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 39);
  const cols = (db.query("PRAGMA table_info(tribal_clusters)").all() as { name: string }[]).map(
    (r) => r.name,
  );
  for (const c of [
    "cluster_id",
    "representative_question",
    "representative_vec",
    "occurrence_count",
    "first_seen",
    "last_seen",
    "status",
    "channel_id",
    "platform",
    "suggested_at",
    "cooldown_until",
    "captured_page_ref",
  ]) {
    expect(cols).toContain(c);
  }
});

test("V39 is idempotent", () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 39);
  runIndexedSchemaMigrations(db, 39);
  expect(db.query("SELECT count(*) AS n FROM tribal_clusters").get()).toEqual({ n: 0 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/gateway && timeout 60 bun test src/index/migrations/tribal-clusters-v39.test.ts`
Expected: FAIL (no such table / version < 39).

- [ ] **Step 3: Create the V39 SQL const**

```typescript
// packages/gateway/src/index/tribal-clusters-v39-sql.ts
/**
 * V39 — tribal_clusters: the asker-side cluster ledger for Phase 6 Slice 6c
 * (tribal-knowledge extraction). One row per detected repeated-question cluster;
 * survives restarts, dedups suggestions, and tracks capture/dismiss + cooldown state.
 */
export const TRIBAL_CLUSTERS_V39_SQL = `
CREATE TABLE IF NOT EXISTS tribal_clusters (
  cluster_id              TEXT PRIMARY KEY,
  representative_question  TEXT NOT NULL,
  representative_vec       BLOB,
  occurrence_count         INTEGER NOT NULL DEFAULT 1,
  first_seen               INTEGER NOT NULL,
  last_seen                INTEGER NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending',
  channel_id               TEXT NOT NULL,
  platform                 TEXT NOT NULL,
  suggested_at             INTEGER,
  cooldown_until           INTEGER,
  captured_page_ref        TEXT
);
CREATE INDEX IF NOT EXISTS idx_tribal_clusters_status ON tribal_clusters(status);
CREATE INDEX IF NOT EXISTS idx_tribal_clusters_channel ON tribal_clusters(channel_id);
`;
```

- [ ] **Step 4: Wire the migration step**

In `packages/gateway/src/index/migrations/runner.ts`: add the import near the other `*-sql.ts` imports:

```typescript
import { TRIBAL_CLUSTERS_V39_SQL } from "../tribal-clusters-v39-sql.ts";
```

Append to the `INDEXED_SCHEMA_STEPS` array (after the V38 step):

```typescript
simpleStep(38, 39, "tribal_clusters (tribal-knowledge cluster ledger v39)", TRIBAL_CLUSTERS_V39_SQL),
```

In `packages/gateway/src/index/local-index.ts:269`, bump:

```typescript
export const CURRENT_SCHEMA_VERSION = 39;
```

(If `runner.ts` keeps a `BACKFILL_LABELS` array, append `"tribal_clusters (tribal-knowledge cluster ledger v39) (backfilled)"` to keep label parity — check whether the V38 step added one; mirror it.)

- [ ] **Step 5: Run to verify it passes**

Run: `cd packages/gateway && timeout 60 bun test src/index/migrations/tribal-clusters-v39.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/index/tribal-clusters-v39-sql.ts packages/gateway/src/index/migrations/runner.ts packages/gateway/src/index/local-index.ts packages/gateway/src/index/migrations/tribal-clusters-v39.test.ts
git commit -m "feat(phase6-slice6c): V39 tribal_clusters cluster ledger"
```

---

## Task 2: `[tribal]` config parse

**Files:**

- Modify: `packages/gateway/src/config/nimbus-toml.ts`
- Test: `packages/gateway/src/config/nimbus-toml.tribal.test.ts`

The parsed type. Note `watchChannels` REQUIRED non-empty when `enabled` (review §1.1) is enforced at **boot** (Task 11), not in the pure parser — the parser just surfaces the values; keep the parser pure/total.

- [ ] **Step 1: Write the failing test**

```typescript
// nimbus-toml.tribal.test.ts
import { expect, test } from "bun:test";
import { DEFAULT_NIMBUS_TRIBAL_TOML, parseNimbusTribalToml } from "./nimbus-toml.ts";

test("defaults: disabled, embedding match, empty channels, no targets", () => {
  expect(parseNimbusTribalToml("")).toEqual(DEFAULT_NIMBUS_TRIBAL_TOML);
});

test("parses [tribal] scalars + watch_channels + subtables", () => {
  const raw = `
[tribal]
enabled = true
match = "embedding+llm"
min_occurrences = 5
window_days = 7
cooldown_days = 60
watch_channels = ["C1", "C2"]

[tribal.notion]
database_id = "db_123"

[tribal.confluence]
space_key = "ENG"
parent_page_id = "9999"
`;
  const t = parseNimbusTribalToml(raw);
  expect(t.enabled).toBe(true);
  expect(t.match).toBe("embedding+llm");
  expect(t.minOccurrences).toBe(5);
  expect(t.windowDays).toBe(7);
  expect(t.cooldownDays).toBe(60);
  expect(t.watchChannels).toEqual(["C1", "C2"]);
  expect(t.notion).toEqual({ databaseId: "db_123" });
  expect(t.confluence).toEqual({ spaceKey: "ENG", parentPageId: "9999" });
});

test("invalid match falls back to embedding", () => {
  expect(parseNimbusTribalToml(`[tribal]\nmatch = "bogus"\n`).match).toBe("embedding");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/gateway && timeout 60 bun test src/config/nimbus-toml.tribal.test.ts`
Expected: FAIL (`parseNimbusTribalToml` not exported).

- [ ] **Step 3: Implement the parser**

Add to `packages/gateway/src/config/nimbus-toml.ts` (mirror the `[chatops]` block; reuse the existing `forEachSectionEntry`, `parseBool`, `parseStringArray`, and the per-namespace subtable collector used by `[federation.preflight."<ns>"]` for the `[tribal.notion]`/`[tribal.confluence]` subtables — read those helpers first):

```typescript
export type TribalMatchMode = "embedding" | "embedding+llm";

export type TribalNotionTarget = { databaseId: string };
export type TribalConfluenceTarget = { spaceKey: string; parentPageId: string };

export type NimbusTribalToml = {
  enabled: boolean;
  match: TribalMatchMode;
  minOccurrences: number;
  windowDays: number;
  cooldownDays: number;
  watchChannels: readonly string[];
  notion?: TribalNotionTarget;
  confluence?: TribalConfluenceTarget;
};

export const DEFAULT_NIMBUS_TRIBAL_TOML: NimbusTribalToml = {
  enabled: false,
  match: "embedding",
  minOccurrences: 3,
  windowDays: 14,
  cooldownDays: 30,
  watchChannels: [],
};

function applyTribalKey(out: Partial<NimbusTribalToml>, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "match":
      out.match = unquote(valRaw) === "embedding+llm" ? "embedding+llm" : "embedding";
      break;
    case "min_occurrences": {
      const n = Number.parseInt(unquote(valRaw), 10);
      if (Number.isInteger(n) && n > 0) out.minOccurrences = n;
      break;
    }
    case "window_days": {
      const n = Number.parseInt(unquote(valRaw), 10);
      if (Number.isInteger(n) && n > 0) out.windowDays = n;
      break;
    }
    case "cooldown_days": {
      const n = Number.parseInt(unquote(valRaw), 10);
      if (Number.isInteger(n) && n >= 0) out.cooldownDays = n;
      break;
    }
    case "watch_channels":
      out.watchChannels = parseStringArray(valRaw);
      break;
    default:
      break;
  }
}

export function parseNimbusTribalToml(
  raw: string,
  defaults: NimbusTribalToml = DEFAULT_NIMBUS_TRIBAL_TOML,
): NimbusTribalToml {
  const out: Partial<NimbusTribalToml> = {};
  forEachSectionEntry(raw, "[tribal]", (key, valRaw) => applyTribalKey(out, key, valRaw));

  const notionDb = readSubtableScalar(raw, "[tribal.notion]", "database_id");
  const confSpace = readSubtableScalar(raw, "[tribal.confluence]", "space_key");
  const confParent = readSubtableScalar(raw, "[tribal.confluence]", "parent_page_id");

  const merged: NimbusTribalToml = { ...defaults, ...out };
  if (notionDb !== undefined && notionDb !== "") merged.notion = { databaseId: notionDb };
  if (confSpace !== undefined && confParent !== undefined && confSpace !== "" && confParent !== "") {
    merged.confluence = { spaceKey: confSpace, parentPageId: confParent };
  }
  return merged;
}

export function loadNimbusTribalFromConfigDir(configDir: string): NimbusTribalToml {
  return loadTomlSection(join(configDir, "nimbus.toml"), DEFAULT_NIMBUS_TRIBAL_TOML, parseNimbusTribalToml);
}
```

> **Implementation note:** `unquote`, `readSubtableScalar` — if helpers by these exact names don't exist, reuse the equivalent the `[chatops]`/preflight-subtable parsers already use (read `nimbus-toml.ts` and match the existing idiom; do NOT introduce a new TOML parser). The `[tribal.notion]`/`[tribal.confluence]` subtables follow the same single-section-scalar extraction `[chatops]` uses, just with a different header.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/gateway && timeout 60 bun test src/config/nimbus-toml.tribal.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd packages/gateway && bunx tsc --noEmit && cd ../..
git add packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/config/nimbus-toml.tribal.test.ts
git commit -m "feat(phase6-slice6c): [tribal] config parse (match/window/channels/targets)"
```

---

## Task 3: `is-question.ts` classifier (pure)

**Files:**

- Create: `packages/gateway/src/tribal/is-question.ts`
- Test: `packages/gateway/src/tribal/is-question.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// is-question.test.ts
import { expect, test } from "bun:test";
import { isQuestion } from "./is-question.ts";

test("classifies questions", () => {
  for (const q of [
    "how do I deploy the gateway?",
    "Where does the vault key live?",
    "what's the difference between I23 and I24",
    "can someone explain the preflight gate",
  ]) {
    expect(isQuestion(q)).toBe(true);
  }
});

test("rejects non-questions and noise", () => {
  for (const s of [
    "deploying now",
    "lgtm 🚀",
    "thanks!",
    "",
    "?",
    "ok",
    "<@U123> shipped it",
  ]) {
    expect(isQuestion(s)).toBe(false);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/gateway && timeout 60 bun test src/tribal/is-question.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```typescript
// packages/gateway/src/tribal/is-question.ts
/**
 * Cheap, dependency-free question gate — runs on EVERY watched channel message
 * before any embedding work, so it must be fast and conservative (favor precision:
 * a missed question is cheap, a false-positive wastes an embedding).
 */
const QUESTION_WORDS = /^(how|what|where|why|when|who|which|can|could|should|does|is|are|do)\b/i;
const MIN_QUESTION_WORDS = 3;

export function isQuestion(textRaw: string): boolean {
  const text = textRaw.trim();
  if (text.length < 8) return false;
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < MIN_QUESTION_WORDS) return false;
  const endsWithQ = text.endsWith("?");
  const startsInterrogative = QUESTION_WORDS.test(text);
  return endsWithQ || startsInterrogative;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/gateway && timeout 60 bun test src/tribal/is-question.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/tribal/is-question.ts packages/gateway/src/tribal/is-question.test.ts
git commit -m "feat(phase6-slice6c): cheap question classifier"
```

---

## Task 4: `cluster-store.ts`

**Files:**

- Create: `packages/gateway/src/tribal/cluster-store.ts`
- Test: `packages/gateway/src/tribal/cluster-store.test.ts`

Writes go through `dbRun`/`dbExec` (I14). The store owns status transitions + cooldown semantics (review §3.2): in-cooldown clusters ignore new occurrences; after `cooldown_until` passes, counting restarts fresh.

- [ ] **Step 1: Write the failing test**

```typescript
// cluster-store.test.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { TribalClusterStore } from "./cluster-store.ts";

function db(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, 39);
  return d;
}

test("insert + bump occurrence; fires at threshold", () => {
  const s = new TribalClusterStore(db());
  const c = s.upsertOccurrence({ clusterId: "k1", question: "how to deploy?", vec: null, channelId: "C1", platform: "slack", now: 1000 });
  expect(c.occurrenceCount).toBe(1);
  const c2 = s.upsertOccurrence({ clusterId: "k1", question: "how to deploy?", vec: null, channelId: "C1", platform: "slack", now: 2000 });
  expect(c2.occurrenceCount).toBe(2);
});

test("dismiss enters cooldown; in-cooldown occurrences are ignored", () => {
  const s = new TribalClusterStore(db());
  s.upsertOccurrence({ clusterId: "k1", question: "q", vec: null, channelId: "C1", platform: "slack", now: 1000 });
  s.markDismissed("k1", { now: 1000, cooldownUntil: 5000 });
  const c = s.upsertOccurrence({ clusterId: "k1", question: "q", vec: null, channelId: "C1", platform: "slack", now: 2000 });
  expect(c.status).toBe("dismissed");
  expect(c.occurrenceCount).toBe(1); // unchanged during cooldown
});

test("after cooldown expiry, counting restarts fresh", () => {
  const s = new TribalClusterStore(db());
  s.upsertOccurrence({ clusterId: "k1", question: "q", vec: null, channelId: "C1", platform: "slack", now: 1000 });
  s.markDismissed("k1", { now: 1000, cooldownUntil: 5000 });
  const c = s.upsertOccurrence({ clusterId: "k1", question: "q", vec: null, channelId: "C1", platform: "slack", now: 6000 });
  expect(c.status).toBe("pending");
  expect(c.occurrenceCount).toBe(1);
});

test("listByStatus + markSuggested + markCaptured", () => {
  const s = new TribalClusterStore(db());
  s.upsertOccurrence({ clusterId: "k1", question: "q", vec: null, channelId: "C1", platform: "slack", now: 1000 });
  s.markSuggested("k1", 1500);
  expect(s.listByStatus("suggested").map((c) => c.clusterId)).toEqual(["k1"]);
  s.markCaptured("k1", { now: 2000, pageRef: "notion:pg1", cooldownUntil: 9000 });
  expect(s.get("k1")?.capturedPageRef).toBe("notion:pg1");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/gateway && timeout 60 bun test src/tribal/cluster-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** (use `dbRun` from `db/write.ts` for writes — I14)

```typescript
// packages/gateway/src/tribal/cluster-store.ts
import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";

export type TribalStatus = "pending" | "suggested" | "captured" | "dismissed";

export interface TribalCluster {
  clusterId: string;
  representativeQuestion: string;
  representativeVec: Float32Array | null;
  occurrenceCount: number;
  firstSeen: number;
  lastSeen: number;
  status: TribalStatus;
  channelId: string;
  platform: string;
  suggestedAt: number | null;
  cooldownUntil: number | null;
  capturedPageRef: string | null;
}

interface Row {
  cluster_id: string;
  representative_question: string;
  representative_vec: Uint8Array | null;
  occurrence_count: number;
  first_seen: number;
  last_seen: number;
  status: TribalStatus;
  channel_id: string;
  platform: string;
  suggested_at: number | null;
  cooldown_until: number | null;
  captured_page_ref: string | null;
}

function rowToCluster(r: Row): TribalCluster {
  return {
    clusterId: r.cluster_id,
    representativeQuestion: r.representative_question,
    representativeVec:
      r.representative_vec === null
        ? null
        : new Float32Array(r.representative_vec.buffer, r.representative_vec.byteOffset, r.representative_vec.byteLength / 4),
    occurrenceCount: r.occurrence_count,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    status: r.status,
    channelId: r.channel_id,
    platform: r.platform,
    suggestedAt: r.suggested_at,
    cooldownUntil: r.cooldown_until,
    capturedPageRef: r.captured_page_ref,
  };
}

function vecBytes(v: Float32Array | null): Uint8Array | null {
  return v === null ? null : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export class TribalClusterStore {
  constructor(private readonly db: Database) {}

  get(clusterId: string): TribalCluster | undefined {
    const r = this.db.query("SELECT * FROM tribal_clusters WHERE cluster_id = ?").get(clusterId) as Row | null;
    return r === null ? undefined : rowToCluster(r);
  }

  listByStatus(status: TribalStatus): TribalCluster[] {
    return (this.db.query("SELECT * FROM tribal_clusters WHERE status = ? ORDER BY last_seen DESC").all(status) as Row[]).map(rowToCluster);
  }

  /** Record one observation. New cluster → pending(count 1). Existing in-cooldown → unchanged
   *  unless cooldown expired (then reset to pending count 1). Otherwise bump count + last_seen. */
  upsertOccurrence(p: {
    clusterId: string;
    question: string;
    vec: Float32Array | null;
    channelId: string;
    platform: string;
    now: number;
  }): TribalCluster {
    const existing = this.get(p.clusterId);
    if (existing === undefined) {
      dbRun(
        this.db,
        `INSERT INTO tribal_clusters (cluster_id, representative_question, representative_vec, occurrence_count, first_seen, last_seen, status, channel_id, platform)
         VALUES (?, ?, ?, 1, ?, ?, 'pending', ?, ?)`,
        [p.clusterId, p.question, vecBytes(p.vec), p.now, p.now, p.channelId, p.platform],
      );
      return this.get(p.clusterId)!;
    }
    const inCooldown = existing.cooldownUntil !== null && p.now < existing.cooldownUntil;
    if (inCooldown) return existing; // ignore occurrences during cooldown (review §3.2)
    const cooldownExpired = existing.cooldownUntil !== null && p.now >= existing.cooldownUntil;
    if (cooldownExpired) {
      dbRun(
        this.db,
        `UPDATE tribal_clusters SET occurrence_count = 1, first_seen = ?, last_seen = ?, status = 'pending', suggested_at = NULL, cooldown_until = NULL WHERE cluster_id = ?`,
        [p.now, p.now, p.clusterId],
      );
      return this.get(p.clusterId)!;
    }
    dbRun(this.db, `UPDATE tribal_clusters SET occurrence_count = occurrence_count + 1, last_seen = ? WHERE cluster_id = ?`, [p.now, p.clusterId]);
    return this.get(p.clusterId)!;
  }

  markSuggested(clusterId: string, now: number): void {
    dbRun(this.db, `UPDATE tribal_clusters SET status = 'suggested', suggested_at = ? WHERE cluster_id = ?`, [now, clusterId]);
  }

  markDismissed(clusterId: string, p: { now: number; cooldownUntil: number }): void {
    dbRun(this.db, `UPDATE tribal_clusters SET status = 'dismissed', cooldown_until = ? WHERE cluster_id = ?`, [p.cooldownUntil, clusterId]);
  }

  markCaptured(clusterId: string, p: { now: number; pageRef: string; cooldownUntil: number }): void {
    dbRun(this.db, `UPDATE tribal_clusters SET status = 'captured', captured_page_ref = ?, cooldown_until = ? WHERE cluster_id = ?`, [p.pageRef, p.cooldownUntil, clusterId]);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/gateway && timeout 60 bun test src/tribal/cluster-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/tribal/cluster-store.ts packages/gateway/src/tribal/cluster-store.test.ts
git commit -m "feat(phase6-slice6c): tribal cluster store (status + cooldown semantics)"
```

---

## Task 5: `repeat-detector.ts`

**Files:**

- Create: `packages/gateway/src/tribal/repeat-detector.ts`
- Test: `packages/gateway/src/tribal/repeat-detector.test.ts`

The detector: question → embed → recall similar prior questions (vectorSearchChunks, service slack/teams, type message) → **post-filter to `watchChannels` (review §1.1)** by parsing `metadata.channel` → assign to the nearest existing cluster within threshold OR derive a stable cluster_id (review §2.3) → `upsertOccurrence` → decide fire (count ≥ minOccurrences within windowDays, not captured/dismissed/cooldown). LLM-judge is an injected optional dep (review detection two-stage). All external collaborators are injected (DI, no `mock.module`).

- [ ] **Step 1: Write the failing test**

```typescript
// repeat-detector.test.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { TribalClusterStore } from "./cluster-store.ts";
import { detectRepeat, type RepeatDetectorDeps } from "./repeat-detector.ts";

function freshDb(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, 39);
  return d;
}

function deps(over: Partial<RepeatDetectorDeps>): RepeatDetectorDeps {
  return {
    embed: async () => new Float32Array([1, 0, 0]),
    recall: () => [], // VectorChunkHit-like {itemId, channelId, question}
    store: new TribalClusterStore(freshDb()),
    watchChannels: new Set(["C1"]),
    minOccurrences: 2,
    windowDays: 14,
    matchMode: "embedding",
    similarityThreshold: 0.85,
    llmJudge: undefined,
    now: () => 1000,
    ...over,
  };
}

test("a message outside watch_channels never clusters", async () => {
  const d = deps({});
  const r = await detectRepeat(d, { text: "how to deploy?", channelId: "C_PRIVATE", platform: "slack" });
  expect(r.fired).toBe(false);
  expect(r.reason).toBe("channel_not_watched");
});

test("first occurrence does not fire; threshold fires", async () => {
  const store = new TribalClusterStore(freshDb());
  const base = deps({ store, minOccurrences: 2 });
  const a = await detectRepeat(base, { text: "how to deploy the gateway?", channelId: "C1", platform: "slack" });
  expect(a.fired).toBe(false);
  const b = await detectRepeat({ ...base, now: () => 2000 }, { text: "how to deploy the gateway?", channelId: "C1", platform: "slack" });
  expect(b.fired).toBe(true);
  expect(b.cluster?.occurrenceCount).toBe(2);
});

test("recall to an existing cluster's channel reuses its cluster_id (near-dup merge)", async () => {
  // recall returns a prior similar question already in cluster k-existing within threshold
  const store = new TribalClusterStore(freshDb());
  const base = deps({
    store,
    minOccurrences: 2,
    recall: () => [{ clusterId: "k-existing", channelId: "C1", distance: 0.05 }],
  });
  store.upsertOccurrence({ clusterId: "k-existing", question: "how do I deploy?", vec: null, channelId: "C1", platform: "slack", now: 500 });
  const r = await detectRepeat(base, { text: "how do I deploy the service?", channelId: "C1", platform: "slack" });
  expect(r.fired).toBe(true);
  expect(r.cluster?.clusterId).toBe("k-existing");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/gateway && timeout 60 bun test src/tribal/repeat-detector.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** (inject `recall` so the test never needs the real vec store; the production `recall` wraps `vectorSearchChunks` + `metadata.channel` post-filter — built in Task 7's wiring)

```typescript
// packages/gateway/src/tribal/repeat-detector.ts
import { createHash } from "node:crypto";
import type { TribalCluster, TribalClusterStore } from "./cluster-store.ts";

/** A prior similar question surfaced by recall, already mapped to its cluster + channel. */
export interface RecallHit {
  clusterId: string;
  channelId: string;
  distance: number;
}

export interface RepeatDetectorDeps {
  embed: (text: string) => Promise<Float32Array | null>;
  /** Production: vectorSearchChunks over slack/teams `message` items, channel-filtered IN SQL via
   *  `json_extract(metadata,'$.channel') IN (watchChannels)` so the top-N are all watched-channel
   *  hits (review §2.1 — never push watched hits out of top-N), then map item→cluster. */
  recall: (vec: Float32Array) => RecallHit[];
  store: TribalClusterStore;
  watchChannels: ReadonlySet<string>;
  minOccurrences: number;
  windowDays: number;
  matchMode: "embedding" | "embedding+llm";
  similarityThreshold: number;
  /** Optional precision pass; absent in embedding-only mode. Returns true if same intent. */
  llmJudge?: (a: string, b: string) => Promise<boolean>;
  now: () => number;
}

export interface DetectResult {
  fired: boolean;
  cluster?: TribalCluster;
  reason?: "channel_not_watched" | "below_threshold" | "in_cooldown_or_done" | "fired";
}

/** Stable cluster id for a brand-new question (no near match): normalize + hash. */
function newClusterId(text: string): string {
  const norm = text.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
  return `tq_${createHash("sha256").update(norm).digest("hex").slice(0, 16)}`;
}

export async function detectRepeat(
  deps: RepeatDetectorDeps,
  msg: { text: string; channelId: string; platform: string },
): Promise<DetectResult> {
  if (!deps.watchChannels.has(msg.channelId)) return { fired: false, reason: "channel_not_watched" };

  const vec = await deps.embed(msg.text);
  if (vec === null) return { fired: false, reason: "below_threshold" };

  // Nearest existing cluster within threshold (review §2.3) — recall only returns watched-channel hits.
  const hits = deps
    .recall(vec)
    .filter((h) => deps.watchChannels.has(h.channelId))
    .sort((a, b) => a.distance - b.distance);
  let clusterId = newClusterId(msg.text);
  const nearest = hits[0];
  if (nearest !== undefined && nearest.distance <= 1 - deps.similarityThreshold) {
    if (deps.matchMode === "embedding+llm" && deps.llmJudge !== undefined) {
      const existing = deps.store.get(nearest.clusterId);
      const same = existing !== undefined ? await deps.llmJudge(existing.representativeQuestion, msg.text) : true;
      if (same) clusterId = nearest.clusterId;
    } else {
      clusterId = nearest.clusterId;
    }
  }

  const cluster = deps.store.upsertOccurrence({
    clusterId,
    question: msg.text,
    vec,
    channelId: msg.channelId,
    platform: msg.platform,
    now: deps.now(),
  });

  if (cluster.status === "captured" || cluster.status === "dismissed") {
    return { fired: false, cluster, reason: "in_cooldown_or_done" };
  }
  const windowMs = deps.windowDays * 86_400_000;
  const inWindow = cluster.lastSeen - cluster.firstSeen <= windowMs;
  if (cluster.status === "pending" && cluster.occurrenceCount >= deps.minOccurrences && inWindow) {
    return { fired: true, cluster, reason: "fired" };
  }
  return { fired: false, cluster, reason: "below_threshold" };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/gateway && timeout 60 bun test src/tribal/repeat-detector.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/tribal/repeat-detector.ts packages/gateway/src/tribal/repeat-detector.test.ts
git commit -m "feat(phase6-slice6c): repeat detector (recall + allowlist + near-dup merge)"
```

---

## Task 6: `tribal-suggestion.ts` (post via I23)

**Files:**

- Create: `packages/gateway/src/tribal/tribal-suggestion.ts`
- Test: `packages/gateway/src/tribal/tribal-suggestion.test.ts`

The suggestion posts via the injected I23 `send(target, text)` to the originating channel. Lightweight nudge — NO synthesis. Marks the cluster `suggested`.

- [ ] **Step 1: Write the failing test**

```typescript
// tribal-suggestion.test.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { TribalClusterStore } from "./cluster-store.ts";
import { postSuggestion } from "./tribal-suggestion.ts";

test("posts to originating channel and marks suggested", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 39);
  const store = new TribalClusterStore(db);
  const c = store.upsertOccurrence({ clusterId: "k1", question: "how to deploy?", vec: null, channelId: "C1", platform: "slack", now: 1000 });
  const sent: { target: unknown; text: string }[] = [];
  await postSuggestion({ send: async (target, text) => void sent.push({ target, text }), store, now: () => 1500 }, c);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.target).toEqual({ kind: "originating", platform: "slack", channelId: "C1" });
  expect(sent[0]?.text).toContain("nimbus tribal capture k1");
  expect(store.get("k1")?.status).toBe("suggested");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/gateway && timeout 60 bun test src/tribal/tribal-suggestion.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// packages/gateway/src/tribal/tribal-suggestion.ts
import type { ReplyTarget } from "../chatops/types.ts";
import type { TribalCluster, TribalClusterStore } from "./cluster-store.ts";

export interface SuggestionDeps {
  send: (target: ReplyTarget, text: string) => Promise<void>;
  store: TribalClusterStore;
  now: () => number;
}

export async function postSuggestion(deps: SuggestionDeps, cluster: TribalCluster): Promise<void> {
  const target: ReplyTarget = {
    kind: "originating",
    platform: cluster.platform as ReplyTarget extends { platform: infer P } ? P : never,
    channelId: cluster.channelId,
  } as ReplyTarget;
  const text =
    `📌 This question has come up ${cluster.occurrenceCount}× — “${cluster.representativeQuestion}”.\n` +
    `Save the answer to the team KB? Run \`nimbus tribal capture ${cluster.clusterId}\` (or \`tribal dismiss ${cluster.clusterId}\`).`;
  await deps.send(target, text);
  deps.store.markSuggested(cluster.clusterId, deps.now());
}
```

> **Note:** the `platform` cast is to satisfy the `ReplyTarget` literal `"slack"|"teams"` union; cluster.platform is already one of those. If `ReplyTarget`'s `platform` type is exported as `ChatPlatform`, import and cast `cluster.platform as ChatPlatform` instead of the conditional-type gymnastics.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/gateway && timeout 60 bun test src/tribal/tribal-suggestion.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/tribal/tribal-suggestion.ts packages/gateway/src/tribal/tribal-suggestion.test.ts
git commit -m "feat(phase6-slice6c): I23 suggestion post + mark-suggested"
```

---

## Task 7: `tribal-watcher.ts` (pipeline orchestrator)

**Files:**

- Create: `packages/gateway/src/tribal/tribal-watcher.ts`
- Test: `packages/gateway/src/tribal/tribal-watcher.test.ts`

`TribalWatcher.ingest(msg)` runs: isQuestion gate → detectRepeat → on fire, postSuggestion. The production `recall` closure (wrapping `vectorSearchChunks` + `metadata.channel` post-filter) is built here and injected into the detector. `ingest` swallows its own errors (a watcher must never break the chat path) and never touches the executor write surface.

- [ ] **Step 1: Write the failing test**

```typescript
// tribal-watcher.test.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { TribalWatcher, type TribalWatcherDeps } from "./tribal-watcher.ts";

function deps(over: Partial<TribalWatcherDeps>): TribalWatcherDeps {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 39);
  return {
    db,
    embed: async () => new Float32Array([1, 0, 0]),
    recall: () => [],
    send: async () => {},
    watchChannels: new Set(["C1"]),
    botUserIds: new Set(["BOT"]),
    minOccurrences: 2,
    windowDays: 14,
    cooldownDays: 30,
    matchMode: "embedding",
    now: () => 1000,
    ...over,
  };
}

test("the bot's own message is never ingested (no embed, no post)", async () => {
  let embeds = 0;
  const w = new TribalWatcher(deps({ embed: async () => { embeds++; return new Float32Array([1]); } }));
  await w.ingest({ platform: "slack", channelId: "C1", userId: "BOT", text: "how do I deploy the gateway?", ts: "1" });
  expect(embeds).toBe(0);
});

// NOTE: Task 8 adds the required `addressedToBot` field to ChatMessage and updates every
// fixture in this file (its Step 3 covers "update all ChatMessage fixtures") — so the fixtures
// above are written against the Task-7-era ChatMessage shape (no `addressedToBot`).

test("non-question is ignored (no embed, no post)", async () => {
  let embeds = 0;
  const sent: string[] = [];
  const w = new TribalWatcher(deps({ embed: async () => { embeds++; return new Float32Array([1]); }, send: async (_t, text) => void sent.push(text) }));
  await w.ingest({ platform: "slack", channelId: "C1", userId: "U", text: "lgtm 🚀", ts: "1" });
  expect(embeds).toBe(0);
  expect(sent).toHaveLength(0);
});

test("repeated question fires a suggestion exactly once at threshold", async () => {
  const sent: string[] = [];
  const w = new TribalWatcher(deps({ send: async (_t, text) => void sent.push(text), minOccurrences: 2, now: () => 1000 }));
  await w.ingest({ platform: "slack", channelId: "C1", userId: "U", text: "how do I deploy the gateway?", ts: "1" });
  expect(sent).toHaveLength(0);
  await w.ingest({ platform: "slack", channelId: "C1", userId: "U", text: "how do I deploy the gateway?", ts: "2" });
  expect(sent).toHaveLength(1);
});

test("ingest never throws even if embed fails", async () => {
  const w = new TribalWatcher(deps({ embed: async () => { throw new Error("worker down"); } }));
  await w.ingest({ platform: "slack", channelId: "C1", userId: "U", text: "how do I deploy?", ts: "1" });
  // no throw = pass
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/gateway && timeout 60 bun test src/tribal/tribal-watcher.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// packages/gateway/src/tribal/tribal-watcher.ts
import type { Database } from "bun:sqlite";
import type { ChatMessage, ReplyTarget } from "../chatops/types.ts";
import { TribalClusterStore } from "./cluster-store.ts";
import { isQuestion } from "./is-question.ts";
import { detectRepeat, type RecallHit } from "./repeat-detector.ts";
import { postSuggestion } from "./tribal-suggestion.ts";

export interface TribalWatcherDeps {
  db: Database;
  embed: (text: string) => Promise<Float32Array | null>;
  recall: (vec: Float32Array) => RecallHit[];
  send: (target: ReplyTarget, text: string) => Promise<void>;
  watchChannels: ReadonlySet<string>;
  /** The bot's own platform user/app ids — messages from these are skipped to prevent a
   *  suggestion→ingest feedback loop (review §1.1). Captured at boot (Task 11). */
  botUserIds: ReadonlySet<string>;
  minOccurrences: number;
  windowDays: number;
  cooldownDays: number;
  matchMode: "embedding" | "embedding+llm";
  llmJudge?: (a: string, b: string) => Promise<boolean>;
  now: () => number;
  log?: (m: string) => void;
}

export class TribalWatcher {
  private readonly store: TribalClusterStore;
  constructor(private readonly deps: TribalWatcherDeps) {
    this.store = new TribalClusterStore(deps.db);
  }

  /** Fan-out target: called for every watched inbound message. Never throws. */
  async ingest(msg: ChatMessage): Promise<void> {
    try {
      if (this.deps.botUserIds.has(msg.userId)) return; // never ingest our own posts (review §1.1)
      if (!this.deps.watchChannels.has(msg.channelId)) return;
      if (!isQuestion(msg.text)) return;
      const result = await detectRepeat(
        {
          embed: this.deps.embed,
          recall: this.deps.recall,
          store: this.store,
          watchChannels: this.deps.watchChannels,
          minOccurrences: this.deps.minOccurrences,
          windowDays: this.deps.windowDays,
          matchMode: this.deps.matchMode,
          similarityThreshold: 0.85,
          ...(this.deps.llmJudge !== undefined ? { llmJudge: this.deps.llmJudge } : {}),
          now: this.deps.now,
        },
        { text: msg.text, channelId: msg.channelId, platform: msg.platform },
      );
      if (result.fired && result.cluster !== undefined) {
        await postSuggestion({ send: this.deps.send, store: this.store, now: this.deps.now }, result.cluster);
      }
    } catch (err) {
      this.deps.log?.(`tribal ingest error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/gateway && timeout 60 bun test src/tribal/tribal-watcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/tribal/tribal-watcher.ts packages/gateway/src/tribal/tribal-watcher.test.ts
git commit -m "feat(phase6-slice6c): tribal watcher pipeline orchestrator"
```

---

## Task 8: Transport widening + fan-out seam

**Files:**

- Modify: `packages/gateway/src/chatops/types.ts` (+`addressedToBot`)
- Modify: `packages/gateway/src/chatops/transport/slack-socket-adapter.ts`
- Modify: `packages/gateway/src/chatops/chatops-boot.ts` (fan-out hook + `buildChatopsBoot` dep)
- Test: `packages/gateway/src/chatops/transport/slack-socket-adapter.test.ts` (extend), `packages/gateway/src/chatops/chatops-boot.tribal-fanout.test.ts`

> **Deployment note (NOT code):** seeing non-mention messages requires the Slack app manifest to subscribe to the `message.channels` bot event. Document in `docs/` setup; without it the watcher only sees mentions (degraded, not broken).

- [ ] **Step 1: Write the failing test (ChatMessage discriminator + Slack message events)**

Extend the slack adapter test: an `app_mention` event → `addressedToBot: true`; a plain `message` event (with `channel/user/text/ts`, no `bot_id`) → a `ChatMessage` with `addressedToBot: false`; a `message` with `subtype` (e.g. `bot_message`/`message_changed`) → `undefined` (skipped).

```typescript
// in slack-socket-adapter.test.ts — add
test("plain channel message → ChatMessage with addressedToBot=false", () => {
  const m = normalize({ type: "events_api", payload: { event: { type: "message", channel: "C1", user: "U1", text: "how do I deploy?", ts: "1.2" } } });
  expect(m).toEqual({ platform: "slack", channelId: "C1", userId: "U1", text: "how do I deploy?", ts: "1.2", addressedToBot: false });
});

test("app_mention → addressedToBot=true", () => {
  const m = normalize({ type: "events_api", payload: { event: { type: "app_mention", channel: "C1", user: "U1", text: "<@B> hi", ts: "1.3" } } });
  expect(m?.addressedToBot).toBe(true);
});

test("bot/subtype messages are skipped", () => {
  expect(normalize({ type: "events_api", payload: { event: { type: "message", subtype: "bot_message", channel: "C1", text: "x", ts: "1" } } })).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/gateway && timeout 60 bun test src/chatops/transport/slack-socket-adapter.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add `addressedToBot` to ChatMessage + widen the Slack normalizer**

In `chatops/types.ts`, add to `ChatMessage`:

```typescript
  /** true if the message @-mentions the bot (routes to IntentRouter); false = ambient (tribal-only). */
  readonly addressedToBot: boolean;
```

In `slack-socket-adapter.ts`, replace the `app_mention`-only guard so it accepts both `app_mention` (→ `addressedToBot:true`) and `message` events with no `subtype` and no `bot_id` (→ `addressedToBot:false`), and rejects everything else:

```typescript
const ev = event as Record<string, unknown> | undefined;
const t = ev?.["type"];
if (t !== "app_mention" && t !== "message") return undefined;
if (t === "message" && (ev?.["subtype"] !== undefined || ev?.["bot_id"] !== undefined)) return undefined;
const channel = ev?.["channel"]; const user = ev?.["user"]; const text = ev?.["text"]; const ts = ev?.["ts"];
if (typeof channel !== "string" || typeof text !== "string" || typeof ts !== "string") return undefined;
return {
  platform: "slack",
  channelId: channel,
  userId: typeof user === "string" ? user : "",
  text,
  ts,
  addressedToBot: t === "app_mention",
};
```

Update the Teams webhook adapter + any other `ChatMessage` construction site to set `addressedToBot` (Teams: `true` if the text mentions the bot, else `false` — reuse the existing mention-detection if present, else default `true` to preserve current behavior). Update all test fixtures that build a `ChatMessage` to include `addressedToBot` (tsc will flag every one).

- [ ] **Step 4: Add the fan-out hook in `chatops-boot.ts`**

Add an optional dep to `buildChatopsBoot`'s deps type:

```typescript
  /** Slice 6c: called for every inbound message (before routing). Never throws. */
  readonly onInboundMessage?: (m: ChatMessage) => Promise<void>;
```

In the `handleMessage` closure (chatops-boot.ts:255), immediately after `lastPlatformByChannel.set(...)`:

```typescript
  if (deps.onInboundMessage !== undefined) await deps.onInboundMessage(msg);
```

And route to the IntentRouter ONLY for addressed messages (preserves today's behavior — today all delivered messages are `app_mention` so `addressedToBot` is true):

```typescript
  // after the approve/reject verdict block:
  if (!msg.addressedToBot) return; // ambient message: tribal-only, never a command
  await routerFor(msg).handle(msg);
```

- [ ] **Step 5: Write + run the fan-out test**

```typescript
// chatops-boot.tribal-fanout.test.ts — assert onInboundMessage is invoked for an ambient message
// and that the IntentRouter is NOT invoked for it (addressedToBot=false), but IS for a mention.
```

Run: `cd packages/gateway && timeout 90 bun test src/chatops/transport/slack-socket-adapter.test.ts src/chatops/chatops-boot.tribal-fanout.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full chatops suite for regressions, then commit**

Run: `cd packages/gateway && timeout 120 bun test src/chatops`
Expected: PASS (fix any fixtures missing `addressedToBot`).

```bash
git add packages/gateway/src/chatops
git commit -m "feat(phase6-slice6c): ChatMessage.addressedToBot + ambient-message fan-out seam"
```

---

## Task 9: `tribal-rpc.ts` IPC + dispatcher wiring + LAN-forbid

**Files:**

- Create: `packages/gateway/src/ipc/tribal-rpc.ts`
- Modify: `packages/gateway/src/ipc/server/context.ts`, `packages/gateway/src/ipc/server/dispatchers.ts`, `packages/gateway/src/ipc/lan-rpc.ts`
- Test: `packages/gateway/src/ipc/tribal-rpc.test.ts`

Phase A wires status/list/dismiss/scan/start/stop. `capture` is added in Phase B (Task 17) — include the method key now returning a `not_implemented` error so the surface is stable, OR omit until Task 17 (omit; add in 17).

- [ ] **Step 1–5:** Follow the exact `chatops-rpc.ts` recipe (dispatchByMethod, `TribalRpcCtx`, `tryDispatchTribalRpc` in `dispatchers.ts` platform group, `"tribal"` added to the `FORBIDDEN_OVER_LAN` set in `lan-rpc.ts`). `TribalRpcCtx` interface:

```typescript
export interface TribalRpcCtx {
  readonly status: () => { enabled: boolean; clusters: number };
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly list: (status?: string) => unknown;
  readonly dismiss: (clusterId: string) => Promise<void>;
  readonly scan: () => Promise<{ scanned: number; fired: number }>;
}
```

Test (dispatchByMethod hit/miss + a fake ctx): `tribal.status` returns the ctx value; an unknown `tribal.foo` returns a miss; assert `"tribal"` ∈ FORBIDDEN_OVER_LAN.

Run: `cd packages/gateway && timeout 60 bun test src/ipc/tribal-rpc.test.ts`
Expected: PASS.

```bash
git add packages/gateway/src/ipc/tribal-rpc.ts packages/gateway/src/ipc/server/context.ts packages/gateway/src/ipc/server/dispatchers.ts packages/gateway/src/ipc/lan-rpc.ts packages/gateway/src/ipc/tribal-rpc.test.ts
git commit -m "feat(phase6-slice6c): tribal.* IPC (local-only, LAN-forbidden)"
```

---

## Task 10: `nimbus tribal` CLI

**Files:**

- Create: `packages/cli/src/commands/tribal.ts`
- Modify: `packages/cli/src/commands/registry.ts`, `packages/cli/src/commands/index.ts`, `packages/cli/src/index.ts`
- Test: `packages/cli/src/commands/tribal.test.ts`, `packages/cli/src/commands/tribal.dispatcher.test.ts`

Follow the `chatops.ts` command pattern: `parseTribalArgs(argv): TribalCommand` (status/start/stop/list/dismiss/scan; `capture` added in Task 17), `runTribalCommand(client, cmd)`, `runTribal(argv)`. Use DI for the IPC client in tests (no `mock.module`). Register `"tribal"` in `COMMAND_NAMES` (alphabetical) + `COMMAND_HANDLERS`.

- [ ] **Step 1–5:** Write `parseTribalArgs` table test (each subcommand + bad input throws usage), then the dispatcher test (each `kind` calls the right IPC method on an injected fake client), then implement, then register, then run.

Run: `timeout 60 bun test packages/cli/src/commands/tribal.test.ts packages/cli/src/commands/tribal.dispatcher.test.ts`
Expected: PASS.

```bash
git add packages/cli/src/commands/tribal.ts packages/cli/src/commands/registry.ts packages/cli/src/commands/index.ts packages/cli/src/index.ts packages/cli/src/commands/tribal.test.ts packages/cli/src/commands/tribal.dispatcher.test.ts
git commit -m "feat(phase6-slice6c): nimbus tribal CLI (status/start/stop/list/dismiss/scan)"
```

---

## Task 11: Boot wiring (`tribal-boot.ts` + assemble.ts)

**Files:**

- Create: `packages/gateway/src/tribal/tribal-boot.ts`
- Modify: `packages/gateway/src/platform/assemble.ts`
- Test: `packages/gateway/src/tribal/tribal-boot.test.ts`

`buildTribalBoot(deps)` constructs the `TribalWatcher`, exposes `onInboundMessage = (m) => watcher.ingest(m)` for `buildChatopsBoot`, and returns the `TribalRpcCtx` (status/list/dismiss/scan/start/stop). **Boot-time validation (review §1.1):** if `tribalCfg.enabled && watchChannels.length === 0`, throw a clear fail-closed error.

**Production `recall` closure (review §2.1):** wraps `vectorSearchChunks(db, { queryEmbedding, model, limit, service:"slack"|"teams", itemType:"message" })` but the channel-allowlist filter is applied **in SQL** — extend `search/vec-store.ts` `vectorSearchChunks` with an optional `metadataChannelIn?: readonly string[]` param that appends `AND json_extract(i.metadata, '$.channel') IN (?, ?, …)` to the query (the `item` row is already joined as `i`). The recall passes `watchChannels` so the top-N hits are all from watched channels (never pushing a watched hit out of top-N by post-filtering). Run it once per `service` (slack + teams) and union. Map each `VectorChunkHit.itemId` to its cluster_id (the cluster store keyed the item when it was first observed — or derive via the item's stored cluster mapping; if a hit's item isn't yet clustered, skip it). **Defer** a `json_extract` expression index (`CREATE INDEX … ON item(json_extract(metadata,'$.channel'))`) as a future optimization — YAGNI until a large `item` table proves the filter slow; the embedding KNN already bounds the candidate set to top-N.

> **vec-store edit (small, shared file):** add the optional `metadataChannelIn` param + the `IN (…)` clause + bound params; add a unit test in `search/vec-store.test.ts` proving a hit in a non-allowlisted channel is excluded. Do this as Step 0 of this task before building the closure.

- [ ] **Step 1: Write the failing test** — `buildTribalBoot` with enabled + empty watchChannels throws; with channels returns a boot whose `onInboundMessage` forwards to a watcher; `rpcCtx.status().enabled` is true.

- [ ] **Step 2–4: Implement `tribal-boot.ts`**, then wire into `assemble.ts` after the chatops block:

```typescript
const tribalCfg = loadNimbusTribalFromConfigDir(paths.configDir);
let tribalBoot: TribalBoot | undefined;
if (tribalCfg.enabled) {
  if (tribalCfg.watchChannels.length === 0) {
    throw new Error("[tribal].enabled requires a non-empty watch_channels allowlist (fail-closed; review §1.1)");
  }
  tribalBoot = buildTribalBoot({
    db,
    cfg: tribalCfg,
    embedQuery: (t) => embeddingBridge.embedQuery(t),
    embeddingModel: embeddingBridge.getEmbeddingModel(),
    // Bot self-filter (review §1.1): the bot's own platform user/app ids, so the watcher never
    // ingests its own suggestion posts. Source from the chatops bot identity — Slack bot user id
    // (resolvable via the bot `auth.test`/`slack_user_info` already used by chatops, or the
    // configured bot id) + the Teams bot app id (`chatopsCfg.teamsBotAppId`). If the Slack id
    // isn't readily resolvable at boot, fall back to the configured ids; the Slack normalizer's
    // `bot_id`/`subtype` skip (Task 8) is the primary guard, this is defense-in-depth.
    botUserIds: new Set([chatopsCfg.teamsBotAppId, /* slack bot user id if available */].filter((s) => s !== "")),
    send: /* reuse the chatops reply-dispatcher send; expose it from chatopsBoot or pass the connector-post seam */,
    log: (m) => syncLogger.warn(m),
  });
  ipcOpts.tribalRpcCtx = tribalBoot.rpcCtx;
}
```

Pass `tribalBoot?.onInboundMessage` into `buildChatopsBoot({ ..., onInboundMessage: tribalBoot?.onInboundMessage })`. Because tribal needs the chatops reply-dispatcher's `send`, and chatops needs tribal's `onInboundMessage`, resolve the cycle by: build the watcher first (it only needs db/embed/config + a `send` seam), construct chatops with `onInboundMessage`, and give the watcher the chatops `send` via a late-bound setter (mirror how `preflightConsent.setBroadcast` is late-bound in assemble.ts). Read that pattern and follow it.

- [ ] **Step 5: Run + commit**

Run: `cd packages/gateway && timeout 60 bun test src/tribal/tribal-boot.test.ts`

```bash
git add packages/gateway/src/tribal/tribal-boot.ts packages/gateway/src/platform/assemble.ts packages/gateway/src/tribal/tribal-boot.test.ts
git commit -m "feat(phase6-slice6c): tribal boot wiring (fail-closed on empty allowlist)"
```

---

## Task 12: Tauri allowlist (read-only `tribal.status`/`tribal.list`)

**Files:**

- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs` (88 → 90)
- Modify: `packages/gateway/src/security-invariants.test.ts` (count assertion)
- Test: the existing Rust `#[test]` + the JS `allowlist_exact_size`

- [ ] **Step 1:** Update the JS-mirror assertion test first (expect 90), run it to FAIL.
- [ ] **Step 2:** Add `"tribal.list"` and `"tribal.status"` (alphabetical) to `ALLOWED_METHODS`; bump the Rust `assert_eq!(ALLOWED_METHODS.len(), 90)`. (`start`/`stop`/`dismiss`/`scan`/`capture` stay CLI-only — control-plane / mutating.)
- [ ] **Step 3:** Run `cd packages/gateway && timeout 60 bun test src/security-invariants.test.ts` → PASS; `cargo test` on the bridge if available, else rely on the JS mirror.
- [ ] **Step 4: Commit**

```bash
git add packages/ui/src-tauri/src/gateway_bridge.rs packages/gateway/src/security-invariants.test.ts
git commit -m "feat(phase6-slice6c): Tauri allowlist 88->90 (tribal.status/list read-only)"
```

**Phase A checkpoint:** detection + suggestion are live and tested; nothing can write. Run `cd packages/gateway && timeout 600 bun test src/tribal src/chatops src/config src/ipc/tribal-rpc.test.ts` and `timeout 120 bun test packages/cli/src/commands/tribal*` — all green before starting Phase B.

---

## PHASE B — Write path + invariant (I25/D19)

## Task 13: `answer-synthesizer.ts`

**Files:**

- Create: `packages/gateway/src/tribal/answer-synthesizer.ts`
- Test: `packages/gateway/src/tribal/answer-synthesizer.test.ts`

Gathers the cluster's source threads from the index (recall by the cluster's representative vec, **filtered to `watchChannels`**), then an injected `llm` drafts `{ title, bodyMarkdown, citations }`. LLM + recall are injected (test stubs them). Output is the draft shown at HITL.

**Constrain the synthesis output (review §3.1):** the LLM prompt MUST instruct a **simple** markdown shape — plain paragraphs separated by blank lines, plus an optional `-` bulleted list, and **no** headers/tables/code-fences/inline HTML. This keeps the Notion/Confluence converter (Task 14) trivial and robust. The synthesizer appends the `Sources` section itself (from `citations`), not the LLM, so source links are always well-formed.

- [ ] **Step 1: Write the failing test** — given a fake recall returning 2 source items (with channel ∈ allowlist) and a fake llm echoing a draft, `synthesizeAnswer` returns `{ title, bodyMarkdown, citations: [{itemId, channelId, url}] }`; a source whose channel ∉ allowlist is excluded from citations.

- [ ] **Step 2–4: Implement** — interface:

```typescript
export interface SynthSource { itemId: string; channelId: string; url: string | null; text: string }
export interface SynthDeps {
  gatherSources: (cluster: TribalCluster) => SynthSource[]; // recall + watchChannels filter + body fetch
  watchChannels: ReadonlySet<string>;
  llm: (prompt: string, sources: SynthSource[]) => Promise<{ title: string; bodyMarkdown: string }>;
}
export interface SynthesizedAnswer {
  title: string;
  bodyMarkdown: string;
  citations: { itemId: string; channelId: string; url: string | null }[];
}
export async function synthesizeAnswer(deps: SynthDeps, cluster: TribalCluster): Promise<SynthesizedAnswer>;
```

The implementation filters `gatherSources` output to `watchChannels` (defense-in-depth even though recall already filters), calls `llm`, and maps surviving sources to citations.

- [ ] **Step 5: Run + commit**

```bash
git add packages/gateway/src/tribal/answer-synthesizer.ts packages/gateway/src/tribal/answer-synthesizer.test.ts
git commit -m "feat(phase6-slice6c): answer synthesizer (draft + allowlist-filtered citations)"
```

---

## Task 14: Connector write tools `notion_kb_append` / `confluence_kb_append`

**Files:**

- Modify: `packages/mcp-connectors/notion/src/server.ts`, `packages/mcp-connectors/confluence/src/server.ts`
- Test: the connectors' existing `test/` (extend with a fetch-mocked tool test)

`notion_kb_append` input: `{ databaseId, title, bodyMarkdown, citationsJson }` → `POST /v1/pages` with `{ parent: { database_id }, properties: { Name: { title: [...] } }, children: [...] }`. `confluence_kb_append` input: `{ spaceKey, parentPageId, title, storageHtml }` → `POST /content` with ancestors. Reuse `notionFetch`/`confFetch`. These are **the only** new write tools; the gate passes destination from config (Task 16).

**Robust, minimal markdown→blocks converter (review §3.1).** Because Task 13 constrains synthesis to simple markdown (paragraphs + `-` bullets, no headers/code/tables), the Notion converter is a small line-walker: a line starting `-` → a `bulleted_list_item` block; a blank line → skip; **any other non-empty line → a `paragraph` block** (the fallback — it never throws on unexpected markup; worst case a stray `#` becomes paragraph text). Confluence's `storageHtml` is built the same way (`<ul><li>` for bullets, `<p>` for everything else), HTML-escaping text. Add a unit test feeding markdown with a stray header/code line and asserting the converter emits valid blocks (paragraph fallback) without throwing.

- [ ] **Step 1: Write fetch-mocked tests** for each tool (assert the request body shape + that the tool returns the created page id).
- [ ] **Step 2–4: Implement** mirroring the existing `notion_page_create` / `confluence_page_create` tool registrations in each `server.ts`.
- [ ] **Step 5: Run the connectors' tests + typecheck the workspace** (`bun run typecheck` from root — connector tsconfig variance, see memory), commit.

```bash
git add packages/mcp-connectors/notion packages/mcp-connectors/confluence
git commit -m "feat(phase6-slice6c): notion_kb_append + confluence_kb_append write tools"
```

---

## Task 15: HITL action types

**Files:**

- Modify: `packages/gateway/src/engine/executor.ts` (`HITL_REQUIRED_BACKING`)
- Test: `packages/gateway/src/engine/executor.hitl.test.ts` (extend, or the security-invariants HITL test)

- [ ] **Step 1:** Add a test asserting `HITL_REQUIRED.has("notion.knowledge.write")` and `HITL_REQUIRED.has("confluence.knowledge.write")` are true; run → FAIL.
- [ ] **Step 2:** Add the two strings to `HITL_REQUIRED_BACKING` (near the other notion/confluence entries).
- [ ] **Step 3:** Run → PASS; commit.

```bash
git add packages/gateway/src/engine/executor.ts packages/gateway/src/engine/executor.hitl.test.ts
git commit -m "feat(phase6-slice6c): HITL action types notion/confluence.knowledge.write"
```

---

## Task 16: `tribal-write-gate.ts` (I25 capture)

**Files:**

- Create: `packages/gateway/src/tribal/tribal-write-gate.ts`
- Test: `packages/gateway/src/tribal/tribal-write-gate.test.ts`

`captureToKnowledgeBase()` is the **sole** path from a capture to a KB write:

1. resolve `target` (`notion`|`confluence`) — sole-config default, else require `--target` (review §3.1), else error;
2. resolve the **destination from local config only** (`cfg.notion.databaseId` / `cfg.confluence`), fail-closed `not_configured` if absent;
3. `synthesizeAnswer` (Task 13);
4. build a `PlannedAction` (`type: "notion.knowledge.write"` | `"confluence.knowledge.write"`, payload `{ mcpToolId: "notion_kb_append"|"confluence_kb_append", <config destination>, title, bodyMarkdown, citationsJson }`) and submit through the **executor gate** (HITL fires; injected `submitAction`);
5. on approval+write success, `store.markCaptured`; return leak-proof `{ ok, pageRef }`.

The destination is **never** read from the caller payload — only `--target` (a KB selector) comes from the caller. D19 confines the `notion_kb_append`/`confluence_kb_append` literals to this file.

- [ ] **Step 1: Write the failing tests:**
  - caller-supplied `databaseId` in the request is ignored — only `cfg.notion.databaseId` is written;
  - unconfigured target → `{ ok: false, error: "not_configured" }`, `submitAction` never called;
  - both targets configured + no `--target` → `{ ok:false, error:"target_ambiguous" }`;
  - HITL rejected (submitAction returns rejected) → no markCaptured, `{ ok:false, error:"rejected" }`;
  - happy path → submitAction called with the config destination + action type `notion.knowledge.write`; markCaptured called with the returned pageRef.

- [ ] **Step 2–4: Implement.** Interface:

```typescript
export interface WriteGateDeps {
  cfg: { notion?: { databaseId: string }; confluence?: { spaceKey: string; parentPageId: string } };
  synthesize: (cluster: TribalCluster) => Promise<SynthesizedAnswer>;
  submitAction: (action: { type: string; payload: Record<string, unknown> }) => Promise<{ status: "approved" | "rejected"; result?: { pageRef: string } }>;
  store: TribalClusterStore;
  cooldownDays: number;
  now: () => number;
}
export type CaptureTarget = "notion" | "confluence";
export async function captureToKnowledgeBase(
  deps: WriteGateDeps,
  cluster: TribalCluster,
  requested?: CaptureTarget,
): Promise<{ ok: true; pageRef: string } | { ok: false; error: "not_configured" | "target_ambiguous" | "rejected" | "write_failed" }>;
```

> Resolve the action `type`/`mcpToolId` from the chosen target only. The string literals `"notion_kb_append"` / `"confluence_kb_append"` must appear ONLY in this file (gateway side) for D19.

- [ ] **Step 5: Run + commit**

```bash
git add packages/gateway/src/tribal/tribal-write-gate.ts packages/gateway/src/tribal/tribal-write-gate.test.ts
git commit -m "feat(phase6-slice6c): I25 tribal write-gate (config-only dest, owner HITL)"
```

---

## Task 17: `tribal.capture` IPC + CLI `--target`

**Files:**

- Modify: `packages/gateway/src/ipc/tribal-rpc.ts` (+`tribal.capture`), `packages/gateway/src/tribal/tribal-boot.ts` (wire the write-gate into the ctx), `packages/cli/src/commands/tribal.ts` (+`capture` subcommand with `--target`)
- Test: extend `tribal-rpc.test.ts`, `tribal.dispatcher.test.ts`

- [ ] **Step 1:** Add `capture: (clusterId, target?) => Promise<{ok:boolean; pageRef?:string; error?:string}>` to `TribalRpcCtx`; the `tribal.capture` handler parses `clusterId` + optional `target`. CLI `capture <cluster-id> [--target notion|confluence]` (parse `--target` like `preflight.ts` parses `--namespace`). Boot wires `capture` → `captureToKnowledgeBase` with `submitAction` bound to the executor.
- [ ] **Step 2–4:** Tests (dispatcher routes `capture` with target; CLI parses `--target`), implement, run.
- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/tribal-rpc.ts packages/gateway/src/tribal/tribal-boot.ts packages/cli/src/commands/tribal.ts packages/gateway/src/ipc/tribal-rpc.test.ts packages/cli/src/commands/tribal.dispatcher.test.ts
git commit -m "feat(phase6-slice6c): tribal capture IPC + CLI --target"
```

---

## Task 18: I25/D19 invariant triple (ONE commit)

**Files:**

- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (D19 rule)
- Modify: `packages/gateway/src/security-invariants.test.ts` (I25 block)
- Modify: `docs/SECURITY-INVARIANTS.md` (I25 row), `CLAUDE.md` + `GEMINI.md` (I25 line + static-complement line + invariant-count prose), `docs/architecture.md` (I1–I25)

Mirror the I24/D18 pattern exactly.

- [ ] **Step 1: D19 static rule** — in `check-nimbus-invariants.ts`, add `checkTribalKbWriteInvariant`:

```typescript
// The static audit scans BOTH packages/*/src/**/*.ts AND packages/mcp-connectors/*/src/**/*.ts
// (verified: scripts/structure-audit/lib.ts iterateSourceFiles), so the two connector definition
// sites MUST be allow-listed alongside the gateway gate (review §4.1) — they DEFINE the tools; only
// the gateway-side INVOCATION is confined to the write-gate.
const TRIBAL_KB_WRITE_ALLOWED = [
  "packages/gateway/src/tribal/tribal-write-gate.ts",
  "packages/mcp-connectors/notion/src/server.ts",
  "packages/mcp-connectors/confluence/src/server.ts",
];
const TRIBAL_KB_WRITE_RE = /\b(notion_kb_append|confluence_kb_append)\b/;
export function checkTribalKbWriteInvariant(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (TRIBAL_KB_WRITE_ALLOWED.some((p) => f.relPath === p)) continue;
    const lines = stripComments(f.contents).split("\n");
    const orig = f.contents.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (TRIBAL_KB_WRITE_RE.test(lines[i] ?? "")) {
        out.push({ rule: "D19-tribal-kb-write", file: f.relPath, line: i + 1, snippet: (orig[i] ?? "").trim() });
      }
    }
  }
  return out;
}
```

Register it in `run()` next to `checkPreflightRunnerInvariant`. (Verified: `iterateSourceFiles` in `scripts/structure-audit/lib.ts` globs `packages/mcp-connectors/*/src/**/*.ts`, so the connector `server.ts` files ARE scanned and are pre-allow-listed above — without them the tool-definition sites would trip D19.)

- [ ] **Step 2: I25 runtime test** — add the `describe("I25 ...")` block to `security-invariants.test.ts`: import `captureToKnowledgeBase`, assert (a) caller-supplied `databaseId` ignored → only config dest in the submitted action, (b) unconfigured → `not_configured`, submitAction never called, (c) rejected HITL → no markCaptured, (d) `expect(audit).toContain("D19-tribal-kb-write")`.

- [ ] **Step 3: Docs** — add the I25 row to `SECURITY-INVARIANTS.md` (statement + wiring + anti-pattern + comply, mirroring I24); add the I25 bullet + extend the static-complement line in `CLAUDE.md` and `GEMINI.md`; update `architecture.md` `I1–I24` → `I1–I25`.

- [ ] **Step 4: Run the triple**

Run: `timeout 60 bun scripts/structure-audit/check-nimbus-invariants.ts all` (exit 0) and `cd packages/gateway && timeout 90 bun test src/security-invariants.test.ts` (PASS).

- [ ] **Step 5: Commit (the whole triple together)**

```bash
git add scripts/structure-audit/check-nimbus-invariants.ts packages/gateway/src/security-invariants.test.ts docs/SECURITY-INVARIANTS.md CLAUDE.md GEMINI.md docs/architecture.md
git commit -m "feat(phase6-slice6c): I25 invariant + D18-style static D19 + triple"
```

---

## Task 19: Chat-button capture affordance (second trigger)

**Files:**

- Modify: `packages/gateway/src/chatops/chatops-boot.ts` (verdict handling: a `capture <id>`/save reply on a suggestion routes to the owner-HITL capture), `packages/gateway/src/tribal/tribal-boot.ts`
- Test: `packages/gateway/src/tribal/tribal-capture-trigger.test.ts`

Reuse the Slice 5 verdict-reply mechanism: when a user replies to a suggestion in-channel with the capture intent, route to `captureToKnowledgeBase` (which itself fires the owner HITL). Keep this thin — the CLI path (Task 17) is the primary trigger; this is the in-chat convenience. If the approval-presenter coupling proves heavy, scope this to a simple `@nimbus tribal capture <id>` command routed through the existing IntentRouter (addressedToBot path) rather than a custom card.

- [ ] **Steps:** test the in-chat trigger calls the gate; implement minimally; run; commit.

```bash
git commit -m "feat(phase6-slice6c): in-chat capture trigger"
```

---

## Task 20: Two-gateway-free E2E (real gateway + mock Slack + mock connectors)

**Files:**

- Create: `packages/gateway/test/e2e/tribal-e2e.test.ts`

Mirror the Slice 5 `chatops-e2e.test.ts` harness (real gateway subprocess, `[tribal].enabled` + `[chatops].enabled`, mock Slack transport via the env sink seam, mock Notion/Confluence connector via the e2e sink). Assert end-to-end:

1. ambient repeated question across the threshold → a suggestion is posted to the channel sink;
2. `nimbus tribal capture <id>` → owner HITL auto-approve → a `notion_kb_append` call hits the connector sink with the **config** databaseId (not any caller value); cluster → `captured`;
3. `tribal dismiss` → cooldown suppresses a re-suggestion;
4. `[tribal].enabled` with empty `watch_channels` → gateway boot fails closed;
5. capture with no configured target → `not_configured`.

- [ ] **Steps:** write the e2e, run `cd packages/gateway && timeout 300 bun test test/e2e/tribal-e2e.test.ts`, commit.

```bash
git commit -m "test(phase6-slice6c): tribal e2e (suggest -> capture -> KB write; fail-closed)"
```

---

## Task 21: Docs + coverage-floor + preflight

**Files:** `docs/CHANGELOG.md`, `docs/roadmap.md` (Slice 6 → 6c ✅), `CLAUDE.md`/`GEMINI.md` status line (V38→V39, I24→I25, Slice 6c shipped), schema-version prose in `docs/architecture.md`, a `docs/` tribal setup note (Slack `message.channels` scope + embedding-cost note), `coverage/lcov.info` (reseed later from PR merge artifact).

- [ ] **Step 1:** CHANGELOG entry (mirror the 6b entry shape; describe the pipeline, I25/D19, V39, surfaces, the Slack-manifest scope note).
- [ ] **Step 2:** roadmap Slice 6 row → mark 6c ✅; status lines in CLAUDE.md/GEMINI.md (schema **V39**, invariants **I1–I25**, Slice 6c shipped); architecture schema-ref V39.
- [ ] **Step 3:** `bun scripts/structure-audit/check-nimbus-invariants.ts all` (exit 0); `cd packages/gateway && bunx tsc --noEmit && cd ../cli && bunx tsc --noEmit && cd ../..`; `timeout 600 bun test packages/gateway/src`; `timeout 120 bun test packages/cli/src`.
- [ ] **Step 4:** `bun run preflight:fast` (validate biome via `bunx biome check packages scripts` in-worktree); `bunx markdownlint-cli2 --fix "docs/superpowers/specs/2026-06-12-phase6-slice6c-*.md" "docs/superpowers/plans/2026-06-12-phase6-slice6c-*.md"`.
- [ ] **Step 5: Docker Linux coverage-floor** — invoke the `nimbus-coverage-floor` agent (oven/bun:latest) to bring every new file (tribal/*, tribal-rpc, tribal-clusters-v39-sql, cli/tribal, the two connector tools) to ≥80% line+branch. **There IS a migration this slice (V39)** — no `*-v39-sql.ts` coverage needed (DDL string), but the migration step is exercised by Task 1's test.
- [ ] **Step 6: Push + open PR.** Do NOT reseed the committed baseline from local Docker — reseed `coverage/lcov.info` from the PR's OWN `coverage-lcov-merged` artifact + `audit:coverage-floor:update-baseline` after the merge-commit CI runs ([[true-coverage-program-workstream]] rule). Expect ≤1 red CI round (incidental sibling coverage + SonarCloud new-code dup — fix-not-exclude). If main has moved (another coverage PR merged), resolve the baseline conflict by taking main's baseline + keeping only THIS branch's stricter watermarks (the Slice 6b lesson).

```bash
git add coverage/lcov.info
git commit -m "test(phase6-slice6c): reseed coverage baseline from PR merge lcov"
```

---

## Self-review (plan ↔ spec)

- **Spec coverage:** §2 pipeline → T3–T8; §2.1 privacy allowlist → T2/T5/T11/T13 (parse + detector filter + boot fail-closed + synth filter); §2.2 near-dup → T5; §2.3 edits/cost → snapshot recall (T5/T7) + local-MiniLM (T11); §3 config → T2; §3.1 multi-target → T16/T17; §3.2 cooldown → T4; §4 I25/D19 → T16/T18; §5 write tools → T14/T15; §6 V39 → T1; §7 CLI/IPC/Tauri → T9/T10/T12/T17; §8 testing → per-task + T20; §9 sequencing → Phase A/B split. ✅ All mapped.
- **Type consistency:** `TribalCluster`/`TribalClusterStore` (T4) consumed in T5/T6/T7/T13/T16; `RecallHit` (T5) produced by the boot `recall` closure (T11); `SynthesizedAnswer` (T13) consumed by the write-gate (T16); `TribalRpcCtx` (T9) extended in T17; `ChatMessage.addressedToBot` (T8) read in chatops-boot routing (T8) + watcher ingest (T7). Action types `notion.knowledge.write`/`confluence.knowledge.write` consistent T15↔T16↔T18; tool ids `notion_kb_append`/`confluence_kb_append` consistent T14↔T16↔T18. ✅
- **Open risk (carried from spec):** Slack `message.channels` manifest scope (T8 deployment note) + the chatops↔tribal boot cycle resolved via late-bound `send` setter (T11, mirroring `preflightConsent.setBroadcast`). Both flagged in-task.
