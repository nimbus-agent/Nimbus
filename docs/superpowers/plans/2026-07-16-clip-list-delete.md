# `nimbus clip list` + `nimbus clip delete` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `nimbus clip list` (with `--tag`/`--limit`/`--json`) and `nimbus clip delete` (by id or URL, plus `--all --yes`) so a user can see and remove their web clips.

**Architecture:** Two new `clip.*` IPC methods (`clip.list`, `clip.delete`) in the existing clip RPC dispatcher, backed by the local-index SQLite DB (threaded into `ClipRpcDeps` via `ctx.options.localIndex.getDatabase()`). Tag filtering runs in SQL (`json_each`) so `--limit` stays correct; deletes resolve to primary keys and go through `deleteItemByPrimaryKey` (graph + cascade cleanup). The CLI adds two subcommands that call these methods and format the output.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict, `bun:sqlite`, `bun:test`. Linter: Biome.

**Spec:** [`docs/superpowers/specs/2026-07-16-clip-list-delete-design.md`](../specs/2026-07-16-clip-list-delete-design.md)

## Global Constraints

- **No `any`** — use `unknown` for external data; TS strict mode is non-negotiable.
- **Bound-param SQL only** (I9) — every user value is a `?` placeholder, never string-concatenated.
- **Deletes never use raw `DELETE FROM item`** — always `deleteItemByPrimaryKey(db, id)` (it also calls `deleteGraphEntitiesForItemKeys`).
- **`clip.delete` only ever deletes `type = 'web_clip'` rows** — every id/url/all query is type-guarded so a `nimbus:` id for a non-clip item cannot be deleted.
- **No new invariant, no migration, no security-surface change** (read + local delete; not outbound egress; `clip.*` is not renderer-exposed).
- **DB absent (abnormal boot):** `clip.list` fail-soft → `{ clips: [] }`; `clip.delete` **throws** `Error("Clip index unavailable.")` — it must never report a false `Deleted 0` when it couldn't even check (per the spec's Error-handling section). `pair`/`status`/`revoke` keep working.
- Run each task's tests with `--timeout 60000`. After the final task run `bun run preflight:fast` (validate via `bunx biome check packages scripts` if the worktree lint gate misbehaves).
- Commit on this branch only: `dev/asafgolombek/clip-list-delete`.

---

### Task 1: Gateway `clip.list` IPC method

**Files:**

- Modify: `packages/gateway/src/ipc/clip-rpc.ts` (add `db?` to `ClipRpcDeps`; add `clip.list` case + helpers)
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts:884-898` (thread `db` into clip deps)
- Test: `packages/gateway/src/ipc/clip-rpc.test.ts`

**Interfaces:**

- Consumes: `buildItemListSql({ services, types, limit })` from `../index/item-list-query.ts`; `ingestClip(db, input)` from `../clips/clip-ingest.ts` (test seeding); `LocalIndex.ensureSchema(db)` from `../index/local-index.ts` (test setup); `ctx.options.localIndex.getDatabase()` (dispatcher).
- Produces: IPC `clip.list` → `{ clips: ClipListEntry[] }` where
  `ClipListEntry = { id: string; title: string; url: string | null; clippedAt: number; tags: string[]; mode: string; wordCount: number }`, newest-first. Params: `{ limit?: number; tag?: string }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/src/ipc/clip-rpc.test.ts`. First add these imports at the top of the file (below the existing imports):

```ts
import { Database } from "bun:sqlite";
import { LocalIndex } from "../index/local-index.ts";
import { ingestClip } from "../clips/clip-ingest.ts";
```

Then append this block after the existing `describe("dispatchClipRpc", ...)`:

```ts
function seededDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function seedClip(
  db: Database,
  o: { url: string; title: string; body: string; mode: "article" | "selection"; tags: string[]; capturedAt: number },
): string {
  return ingestClip(db, {
    url: o.url,
    title: o.title,
    body: o.body,
    mode: o.mode,
    tags: o.tags,
    capturedAt: o.capturedAt,
  }).id;
}

describe("dispatchClipRpc — clip.list", () => {
  test("lists web_clip items newest-first with tags/mode/wordCount", async () => {
    const db = seededDb();
    seedClip(db, { url: "https://a.com/1", title: "Older", body: "one two three", mode: "article", tags: ["x"], capturedAt: 1000 });
    seedClip(db, { url: "https://b.com/2", title: "Newer", body: "four five", mode: "article", tags: ["rust", "async"], capturedAt: 2000 });
    const out = await dispatchClipRpc("clip.list", {}, { ...deps(), db });
    const clips = (out as { value: { clips: Array<Record<string, unknown>> } }).value.clips;
    expect(clips.map((c) => c["title"])).toEqual(["Newer", "Older"]);
    expect(clips[0]).toMatchObject({ tags: ["rust", "async"], mode: "article", wordCount: 2 });
    expect(typeof clips[0]?.["clippedAt"]).toBe("number");
    db.close();
  });

  test("--tag filters in SQL and survives past the LIMIT boundary", async () => {
    const db = seededDb();
    // 3 newest UNTAGGED clips + 1 OLDER tagged clip. An in-memory filter after LIMIT 2
    // would return the 2 newest untagged → 0 matches. SQL filtering must still find the tagged one.
    seedClip(db, { url: "https://a.com/x", title: "Tagged-old", body: "b", mode: "article", tags: ["rust"], capturedAt: 1000 });
    seedClip(db, { url: "https://a.com/1", title: "U1", body: "b", mode: "article", tags: [], capturedAt: 3000 });
    seedClip(db, { url: "https://a.com/2", title: "U2", body: "b", mode: "article", tags: [], capturedAt: 4000 });
    seedClip(db, { url: "https://a.com/3", title: "U3", body: "b", mode: "article", tags: [], capturedAt: 5000 });
    const out = await dispatchClipRpc("clip.list", { tag: "rust", limit: 2 }, { ...deps(), db });
    const clips = (out as { value: { clips: Array<Record<string, unknown>> } }).value.clips;
    expect(clips.map((c) => c["title"])).toEqual(["Tagged-old"]);
    db.close();
  });

  test("respects --limit", async () => {
    const db = seededDb();
    for (let i = 0; i < 5; i++) {
      seedClip(db, { url: `https://a.com/${i}`, title: `T${i}`, body: "b", mode: "article", tags: [], capturedAt: 1000 + i });
    }
    const out = await dispatchClipRpc("clip.list", { limit: 2 }, { ...deps(), db });
    expect((out as { value: { clips: unknown[] } }).value.clips).toHaveLength(2);
    db.close();
  });

  test("tolerates malformed metadata (tags empty, never throws)", async () => {
    const db = seededDb();
    const id = seedClip(db, { url: "https://a.com/1", title: "T", body: "b", mode: "article", tags: ["x"], capturedAt: 1000 });
    db.run("UPDATE item SET metadata = '{not json' WHERE id = ?", [id]);
    const out = await dispatchClipRpc("clip.list", {}, { ...deps(), db });
    const clips = (out as { value: { clips: Array<Record<string, unknown>> } }).value.clips;
    expect(clips[0]).toMatchObject({ tags: [], mode: "", wordCount: 0 });
    db.close();
  });

  test("--tag filter does not crash when another row has malformed metadata", async () => {
    const db = seededDb();
    // A valid tagged clip + a second clip whose metadata is later corrupted to invalid JSON.
    seedClip(db, { url: "https://a.com/1", title: "Good", body: "b", mode: "article", tags: ["rust"], capturedAt: 2000 });
    const bad = seedClip(db, { url: "https://a.com/2", title: "Bad", body: "b", mode: "article", tags: [], capturedAt: 1000 });
    db.run("UPDATE item SET metadata = '{not json' WHERE id = ?", [bad]);
    // Without the json_valid guard, json_each would raise "malformed JSON" and abort this query.
    const out = await dispatchClipRpc("clip.list", { tag: "rust" }, { ...deps(), db });
    const clips = (out as { value: { clips: Array<Record<string, unknown>> } }).value.clips;
    expect(clips.map((c) => c["title"])).toEqual(["Good"]);
    db.close();
  });

  test("returns empty when db is absent (fail-soft)", async () => {
    const out = await dispatchClipRpc("clip.list", {}, deps());
    expect(out).toEqual({ kind: "hit", value: { clips: [] } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gateway/src/ipc/clip-rpc.test.ts --timeout 60000`
Expected: FAIL — `clip.list` currently hits `default → { kind: "miss" }`, so assertions on `.value.clips` fail.

- [ ] **Step 3: Implement `clip.list` in `clip-rpc.ts`**

Replace the import block and `ClipRpcDeps` at the top of `packages/gateway/src/ipc/clip-rpc.ts`:

```ts
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { listClipFingerprints, revokeClipToken } from "../clips/clip-token-store.ts";
import type { PairingWindowController } from "../clips/pairing-window.ts";
import { buildItemListSql } from "../index/item-list-query.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export interface ClipRpcDeps {
  readonly pairing: PairingWindowController;
  readonly vault: NimbusVault;
  /** Local-index DB handle. Present when the index is wired; absent → list/delete fail-soft. */
  readonly db?: Database;
}

export interface ClipListEntry {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly clippedAt: number;
  readonly tags: string[];
  readonly mode: string;
  readonly wordCount: number;
}
```

Add these helpers just above `export async function dispatchClipRpc`:

```ts
function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(1000, Math.trunc(n));
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rowToClipEntry(row: Record<string, unknown>): ClipListEntry {
  const meta = parseMetadata(row["metadata"]);
  const tags = Array.isArray(meta["tags"])
    ? (meta["tags"].filter((t) => typeof t === "string") as string[])
    : [];
  return {
    id: String(row["id"]),
    title: typeof row["title"] === "string" ? row["title"] : "",
    url: typeof row["url"] === "string" ? row["url"] : null,
    clippedAt: typeof row["modified_at"] === "number" ? row["modified_at"] : 0,
    tags,
    mode: typeof meta["mode"] === "string" ? meta["mode"] : "",
    wordCount: typeof meta["wordCount"] === "number" ? meta["wordCount"] : 0,
  };
}

function listClips(db: Database, limit: number, tag: string | undefined): ClipListEntry[] {
  let rows: Record<string, unknown>[];
  if (tag === undefined) {
    const { sql, vals } = buildItemListSql({ services: [], types: ["web_clip"], limit });
    rows = db.query(sql).all(...vals) as Record<string, unknown>[];
  } else {
    // Guard json_each with json_valid: json_each raises "malformed JSON" (aborting the whole
    // query) if ANY web_clip row has invalid metadata. Clip ingest always writes valid JSON, but
    // this keeps a tampered/legacy row from crashing the listing — bad JSON → treated as no tags.
    rows = db
      .query(
        "SELECT item.* FROM item, json_each(" +
          "CASE WHEN json_valid(item.metadata) THEN item.metadata ELSE '{\"tags\":[]}' END, " +
          "'$.tags') " +
          "WHERE item.type = 'web_clip' AND json_each.value = ? " +
          "ORDER BY item.modified_at DESC LIMIT ?",
      )
      .all(tag, limit) as Record<string, unknown>[];
  }
  return rows.map(rowToClipEntry);
}
```

Add the `clip.list` case inside the `switch (method)` in `dispatchClipRpc`, before `default`:

```ts
    case "clip.list": {
      if (deps.db === undefined) return { kind: "hit", value: { clips: [] } };
      const limit = clampLimit(rec["limit"]);
      const tag =
        typeof rec["tag"] === "string" && rec["tag"].length > 0 ? (rec["tag"] as string) : undefined;
      return { kind: "hit", value: { clips: listClips(deps.db, limit, tag) } };
    }
```

- [ ] **Step 4: Thread `db` into the clip dispatcher**

In `packages/gateway/src/ipc/server/dispatchers.ts`, in `tryDispatchClipRpc`, change the `dispatchClipRpc` call to add the db (mirrors the agents dispatcher which already uses `ctx.options.localIndex.getDatabase()`):

```ts
  const out = await dispatchClipRpc(method, params, {
    pairing: ctx.options.clipPairingController,
    vault: ctx.options.vault,
    ...(ctx.options.localIndex === undefined
      ? {}
      : { db: ctx.options.localIndex.getDatabase() }),
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/gateway/src/ipc/clip-rpc.test.ts --timeout 60000`
Expected: PASS (all existing + 5 new `clip.list` tests).

- [ ] **Step 6: Typecheck the gateway**

Run: `bun run --filter '@nimbus/gateway' typecheck`
Expected: `Done` with no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/ipc/clip-rpc.ts packages/gateway/src/ipc/server/dispatchers.ts packages/gateway/src/ipc/clip-rpc.test.ts
git commit -m "feat(gateway): clip.list IPC method (web_clip listing + --tag SQL filter)"
```

---

### Task 2: Gateway `clip.delete` IPC method

**Files:**

- Modify: `packages/gateway/src/ipc/clip-rpc.ts` (add `clip.delete` case + resolver helpers)
- Test: `packages/gateway/src/ipc/clip-rpc.test.ts`

**Interfaces:**

- Consumes: `canonicalizeUrl(raw)` from `../clips/clip-ingest.ts`; `deleteItemByPrimaryKey(db, id)`, `upsertIndexedItem(db, row)` from `../index/item-store.ts` (test seeding of a non-clip row).
- Produces: IPC `clip.delete` → `{ deleted: number; matched: number }`. Params: `{ target?: string }` OR `{ all?: boolean }`, plus optional `{ dryRun?: boolean }` (dryRun → `{ deleted: 0, matched: N }`, deletes nothing).

- [ ] **Step 1: Write the failing tests**

Add this import near the other test imports in `clip-rpc.test.ts`:

```ts
import { upsertIndexedItem } from "../index/item-store.ts";
```

Append after the `clip.list` describe block:

```ts
describe("dispatchClipRpc — clip.delete", () => {
  test("deletes a single clip by id", async () => {
    const db = seededDb();
    const id = seedClip(db, { url: "https://a.com/1", title: "T", body: "b", mode: "article", tags: [], capturedAt: 1 });
    const out = await dispatchClipRpc("clip.delete", { target: id }, { ...deps(), db });
    expect(out).toEqual({ kind: "hit", value: { deleted: 1, matched: 1 } });
    expect(db.query("SELECT 1 FROM item WHERE id = ?").get(id)).toBeNull();
    db.close();
  });

  test("deleting by URL removes the article + all selections from that page", async () => {
    const db = seededDb();
    seedClip(db, { url: "https://a.com/p", title: "Article", body: "full", mode: "article", tags: [], capturedAt: 1 });
    seedClip(db, { url: "https://a.com/p", title: "Sel1", body: "sel one", mode: "selection", tags: [], capturedAt: 2 });
    seedClip(db, { url: "https://a.com/p", title: "Sel2", body: "sel two", mode: "selection", tags: [], capturedAt: 3 });
    const out = await dispatchClipRpc("clip.delete", { target: "https://a.com/p" }, { ...deps(), db });
    expect((out as { value: { deleted: number } }).value.deleted).toBe(3);
    expect(db.query("SELECT COUNT(*) c FROM item WHERE type='web_clip'").get()).toEqual({ c: 0 });
    db.close();
  });

  test("--all deletes only web_clip rows, leaving other nimbus items", async () => {
    const db = seededDb();
    seedClip(db, { url: "https://a.com/1", title: "T", body: "b", mode: "article", tags: [], capturedAt: 1 });
    upsertIndexedItem(db, {
      service: "nimbus",
      type: "note",
      externalId: "note:keep",
      title: "Keep me",
      bodyPreview: "not a clip",
      modifiedAt: 1,
      syncedAt: 1,
      metadata: {},
    });
    const out = await dispatchClipRpc("clip.delete", { all: true }, { ...deps(), db });
    expect((out as { value: { deleted: number } }).value.deleted).toBe(1);
    expect(db.query("SELECT COUNT(*) c FROM item").get()).toEqual({ c: 1 });
    db.close();
  });

  test("dryRun reports the match count without deleting", async () => {
    const db = seededDb();
    seedClip(db, { url: "https://a.com/1", title: "T", body: "b", mode: "article", tags: [], capturedAt: 1 });
    const out = await dispatchClipRpc("clip.delete", { all: true, dryRun: true }, { ...deps(), db });
    expect(out).toEqual({ kind: "hit", value: { deleted: 0, matched: 1 } });
    expect(db.query("SELECT COUNT(*) c FROM item WHERE type='web_clip'").get()).toEqual({ c: 1 });
    db.close();
  });

  test("empty / blank target deletes nothing (no query)", async () => {
    const db = seededDb();
    seedClip(db, { url: "https://a.com/1", title: "T", body: "b", mode: "article", tags: [], capturedAt: 1 });
    expect(await dispatchClipRpc("clip.delete", { target: "" }, { ...deps(), db })).toEqual({ kind: "hit", value: { deleted: 0, matched: 0 } });
    expect(await dispatchClipRpc("clip.delete", { target: "   " }, { ...deps(), db })).toEqual({ kind: "hit", value: { deleted: 0, matched: 0 } });
    db.close();
  });

  test("a nimbus: id for a NON-clip item is not deletable via clip.delete", async () => {
    const db = seededDb();
    upsertIndexedItem(db, {
      service: "nimbus",
      type: "note",
      externalId: "note:keep",
      title: "Keep me",
      bodyPreview: "x",
      modifiedAt: 1,
      syncedAt: 1,
      metadata: {},
    });
    const nonClipId = db.query("SELECT id FROM item WHERE type='note'").get() as { id: string };
    const out = await dispatchClipRpc("clip.delete", { target: nonClipId.id }, { ...deps(), db });
    expect(out).toEqual({ kind: "hit", value: { deleted: 0, matched: 0 } });
    expect(db.query("SELECT 1 FROM item WHERE id = ?").get(nonClipId.id)).not.toBeNull();
    db.close();
  });

  test("non-existent target → deleted 0 (idempotent)", async () => {
    const db = seededDb();
    const out = await dispatchClipRpc("clip.delete", { target: "https://nowhere.example/x" }, { ...deps(), db });
    expect(out).toEqual({ kind: "hit", value: { deleted: 0, matched: 0 } });
    db.close();
  });

  test("delete throws when db is absent (never a false 'Deleted 0')", async () => {
    await expect(dispatchClipRpc("clip.delete", { all: true }, deps())).rejects.toThrow(
      "Clip index unavailable.",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gateway/src/ipc/clip-rpc.test.ts --timeout 60000`
Expected: FAIL — `clip.delete` hits `default → miss`.

- [ ] **Step 3: Implement `clip.delete` in `clip-rpc.ts`**

Add `canonicalizeUrl` + `deleteItemByPrimaryKey` to the imports at the top:

```ts
import { canonicalizeUrl } from "../clips/clip-ingest.ts";
import { deleteItemByPrimaryKey } from "../index/item-store.ts";
```

Add these resolver helpers next to the list helpers:

```ts
function allClipIds(db: Database): string[] {
  return (db.query("SELECT id FROM item WHERE type = 'web_clip'").all() as { id: string }[]).map(
    (r) => r.id,
  );
}

function clipIdIfExists(db: Database, id: string): string[] {
  const row = db.query("SELECT id FROM item WHERE id = ? AND type = 'web_clip'").get(id);
  return row === null ? [] : [id];
}

function clipIdsByCanonicalUrl(db: Database, canonical: string): string[] {
  return (
    db.query("SELECT id FROM item WHERE type = 'web_clip' AND canonical_url = ?").all(canonical) as {
      id: string;
    }[]
  ).map((r) => r.id);
}

function resolveClipIdsToDelete(db: Database, rec: Record<string, unknown>): string[] {
  if (rec["all"] === true) return allClipIds(db);
  const target = typeof rec["target"] === "string" ? rec["target"].trim() : "";
  if (target === "") return [];
  return target.startsWith("nimbus:")
    ? clipIdIfExists(db, target)
    : clipIdsByCanonicalUrl(db, canonicalizeUrl(target));
}
```

Add the `clip.delete` case before `default`:

```ts
    case "clip.delete": {
      // Do NOT fail-soft to a false success here: a delete that can't reach the index must not
      // report "Deleted 0" (which reads as "nothing matched"). Surface it (spec Error handling).
      if (deps.db === undefined) throw new Error("Clip index unavailable.");
      const ids = resolveClipIdsToDelete(deps.db, rec);
      if (rec["dryRun"] === true) {
        return { kind: "hit", value: { deleted: 0, matched: ids.length } };
      }
      for (const id of ids) deleteItemByPrimaryKey(deps.db, id);
      return { kind: "hit", value: { deleted: ids.length, matched: ids.length } };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/ipc/clip-rpc.test.ts --timeout 60000`
Expected: PASS (all `clip.delete` tests green).

- [ ] **Step 5: Typecheck the gateway**

Run: `bun run --filter '@nimbus/gateway' typecheck`
Expected: `Done`.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/clip-rpc.ts packages/gateway/src/ipc/clip-rpc.test.ts
git commit -m "feat(gateway): clip.delete IPC method (id/url/--all, web_clip-scoped, graph-clean)"
```

---

### Task 3: CLI `nimbus clip list`

**Files:**

- Modify: `packages/cli/src/commands/clip.ts` (add `parseLimit`, `formatClipList`, `runClipList`, the `list` case, extend `CLIP_USAGE`)
- Test: `packages/cli/src/commands/clip.test.ts`

**Interfaces:**

- Consumes: IPC `clip.list` → `{ clips: ClipListEntry[] }` (Task 1). `createMockIpcClient` / `captureOutput` test helpers (already imported in `clip.test.ts`).
- Produces: `runClipList(client, { tag?: string; limit: number; json: boolean }): Promise<void>`; `parseLimit(raw: string | undefined): number`; `formatClipList(clips, tag): string`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/commands/clip.test.ts`. Add `runClipList`, `parseLimit`, `formatClipList` to the existing import from `./clip.ts`, then append:

```ts
const CLIP_ROW = {
  id: "nimbus:clip:abc",
  title: "Understanding Rust Async",
  url: "https://blog.ex.com/rust-async",
  clippedAt: 1721145600000,
  tags: ["rust", "async"],
  mode: "article",
  wordCount: 42,
};

describe("parseLimit", () => {
  it("returns the number when valid", () => {
    expect(parseLimit("25")).toBe(25);
  });
  it("falls back to 50 on non-numeric / non-positive", () => {
    expect(parseLimit("foo")).toBe(50);
    expect(parseLimit("-3")).toBe(50);
    expect(parseLimit("0")).toBe(50);
    expect(parseLimit(undefined)).toBe(50);
  });
  it("caps at 1000", () => {
    expect(parseLimit("999999")).toBe(1000);
  });
});

describe("formatClipList", () => {
  it("shows an empty-state line when there are no clips", () => {
    expect(formatClipList([], undefined)).toMatch(/no clips saved/i);
  });
  it("shows a tag-specific empty state", () => {
    expect(formatClipList([], "rust")).toContain('tag "rust"');
  });
  it("renders title, tags and url", () => {
    const s = formatClipList([CLIP_ROW], undefined);
    expect(s).toContain("Understanding Rust Async");
    expect(s).toContain("rust");
    expect(s).toContain("https://blog.ex.com/rust-async");
  });
});

describe("runClipList", () => {
  beforeEach(() => out.reset());

  it("calls clip.list and prints the table", async () => {
    const { client, calls } = createMockIpcClient([{ clips: [CLIP_ROW] }]);
    await runClipList(client, { limit: 50, json: false });
    expect(calls[0]).toEqual({ method: "clip.list", params: { limit: 50 } });
    expect(out.stdout).toContain("Understanding Rust Async");
  });

  it("passes the tag param when filtering", async () => {
    const { client, calls } = createMockIpcClient([{ clips: [] }]);
    await runClipList(client, { tag: "rust", limit: 50, json: false });
    expect(calls[0]).toEqual({ method: "clip.list", params: { limit: 50, tag: "rust" } });
    expect(out.stdout).toContain('tag "rust"');
  });

  it("emits JSON (incl. wordCount) with --json", async () => {
    const { client } = createMockIpcClient([{ clips: [CLIP_ROW] }]);
    await runClipList(client, { limit: 50, json: true });
    const parsed = JSON.parse(out.stdout);
    expect(parsed[0].wordCount).toBe(42);
    expect(parsed[0].id).toBe("nimbus:clip:abc");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/src/commands/clip.test.ts --timeout 60000`
Expected: FAIL — `runClipList`/`parseLimit`/`formatClipList` are not exported yet (import error).

> If the run errors with `Cannot find module '@nimbus-dev/client'`, run `bun install` once in the worktree first, then re-run.

- [ ] **Step 3: Implement in `clip.ts`**

Add the entry type + helpers above `runClip`:

```ts
export interface ClipListEntry {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly clippedAt: number;
  readonly tags: string[];
  readonly mode: string;
  readonly wordCount: number;
}

export function parseLimit(raw: string | undefined): number {
  const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(1000, n) : 50;
}

export function formatClipList(clips: ClipListEntry[], tag: string | undefined): string {
  if (clips.length === 0) {
    return tag === undefined ? "No clips saved yet." : `No clips match tag "${tag}".`;
  }
  return clips
    .map((c) => {
      const when = new Date(c.clippedAt).toISOString().slice(0, 16).replace("T", " ");
      const tags = c.tags.length > 0 ? c.tags.join(", ") : "-";
      return `${when}  ${c.title}  [${tags}]  ${c.url ?? ""}`.trimEnd();
    })
    .join("\n");
}

export async function runClipList(
  client: IPCClient,
  opts: { tag?: string; limit: number; json: boolean },
): Promise<void> {
  const params: { limit: number; tag?: string } = { limit: opts.limit };
  if (opts.tag !== undefined) params.tag = opts.tag;
  const out = await client.call<{ clips: ClipListEntry[] }>("clip.list", params);
  if (opts.json) {
    console.log(JSON.stringify(out.clips, null, 2));
    return;
  }
  console.log(formatClipList(out.clips, opts.tag));
}
```

Add the `list` case to the `switch (sub)` in `runClip`, before `default`:

```ts
    case "list": {
      const tagIdx = rest.indexOf("--tag");
      const tag = tagIdx >= 0 ? rest[tagIdx + 1] : undefined;
      const limitIdx = rest.indexOf("--limit");
      const limit = parseLimit(limitIdx >= 0 ? rest[limitIdx + 1] : undefined);
      const json = rest.includes("--json");
      await withIpc((c) => runClipList(c, { ...(tag !== undefined ? { tag } : {}), limit, json }));
      return;
    }
```

Extend `CLIP_USAGE` (add the two lines before the closing backtick):

```ts
export const CLIP_USAGE = `Usage:
  nimbus clip pair [--label <device>]   open a pairing window and print the one-time code
  nimbus clip status                    list paired browsers (labels + token fingerprints)
  nimbus clip revoke <label|--all>      revoke a paired browser's token
  nimbus clip list [--tag <t>] [--limit N] [--json]   list saved clips
  nimbus clip delete <id|url> | --all [--yes]         delete clips`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/src/commands/clip.test.ts --timeout 60000`
Expected: PASS.

- [ ] **Step 5: Typecheck the CLI**

Run: `bun run --filter '@nimbus/cli' typecheck`
Expected: `Done`.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/clip.ts packages/cli/src/commands/clip.test.ts
git commit -m "feat(cli): nimbus clip list (--tag/--limit/--json)"
```

---

### Task 4: CLI `nimbus clip delete`

**Files:**

- Modify: `packages/cli/src/commands/clip.ts` (add `runClipDelete` + the `delete` case)
- Test: `packages/cli/src/commands/clip.test.ts`

**Interfaces:**

- Consumes: IPC `clip.delete` → `{ deleted: number; matched: number }` (Task 2).
- Produces: `runClipDelete(client, target: string | undefined, opts: { all: boolean; yes: boolean }): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Add `runClipDelete` to the `./clip.ts` import in `clip.test.ts`, then append:

```ts
describe("runClipDelete", () => {
  beforeEach(() => out.reset());

  it("deletes by target and reports the count", async () => {
    const { client, calls } = createMockIpcClient([{ deleted: 1, matched: 1 }]);
    await runClipDelete(client, "https://a.com/p", { all: false, yes: false });
    expect(calls[0]).toEqual({ method: "clip.delete", params: { target: "https://a.com/p" } });
    expect(out.stdout).toContain("Deleted 1 clip.");
  });

  it("pluralizes for multiple", async () => {
    const { client } = createMockIpcClient([{ deleted: 3, matched: 3 }]);
    await runClipDelete(client, "https://a.com/p", { all: false, yes: false });
    expect(out.stdout).toContain("Deleted 3 clips.");
  });

  it("--all without --yes only reports the count (dry run, no delete)", async () => {
    const { client, calls } = createMockIpcClient([{ deleted: 0, matched: 12 }]);
    await runClipDelete(client, undefined, { all: true, yes: false });
    expect(calls[0]).toEqual({ method: "clip.delete", params: { all: true, dryRun: true } });
    expect(out.stdout).toContain("12 clips would be deleted");
    expect(out.stdout).toContain("--yes");
  });

  it("--all --yes deletes everything", async () => {
    const { client, calls } = createMockIpcClient([{ deleted: 12, matched: 12 }]);
    await runClipDelete(client, undefined, { all: true, yes: true });
    expect(calls[0]).toEqual({ method: "clip.delete", params: { all: true } });
    expect(out.stdout).toContain("Deleted 12 clips.");
  });

  it("throws usage when no target and not --all", async () => {
    const { client } = createMockIpcClient([]);
    await expect(runClipDelete(client, undefined, { all: false, yes: false })).rejects.toThrow(
      "Usage: nimbus clip delete",
    );
  });

  it("rejects a target together with --all (no accidental mass-delete)", async () => {
    const { client, calls } = createMockIpcClient([]);
    await expect(
      runClipDelete(client, "https://a.com/p", { all: true, yes: true }),
    ).rejects.toThrow("not both");
    expect(calls).toHaveLength(0);
  });
});

describe("runClip (dispatcher) — list + delete routing", () => {
  beforeEach(() => out.reset());
  afterEach(() => clearFixture());

  it("routes 'list' through withIpc", async () => {
    const ipc = createMockIpcClient([{ clips: [] }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runClip(["list"]);
    expect(ipc.calls[0]).toEqual({ method: "clip.list", params: { limit: 50 } });
  });

  it("routes 'delete <url>' through withIpc", async () => {
    const ipc = createMockIpcClient([{ deleted: 1, matched: 1 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runClip(["delete", "https://a.com/p"]);
    expect(ipc.calls[0]).toEqual({ method: "clip.delete", params: { target: "https://a.com/p" } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/src/commands/clip.test.ts --timeout 60000`
Expected: FAIL — `runClipDelete` not exported; `runClip` has no `delete`/`list` route yet (the list-route test may already pass from Task 3; the delete tests fail).

- [ ] **Step 3: Implement in `clip.ts`**

Add `runClipDelete` below `runClipList`:

```ts
export async function runClipDelete(
  client: IPCClient,
  target: string | undefined,
  opts: { all: boolean; yes: boolean },
): Promise<void> {
  const hasTarget = target !== undefined && target.trim() !== "";
  // Reject `clip delete <url> --all` — otherwise --all would silently win and wipe every clip
  // even though the user named a specific target.
  if (opts.all && hasTarget) {
    throw new Error("Specify either a target or --all, not both.");
  }
  if (opts.all) {
    if (!opts.yes) {
      const preview = await client.call<{ matched: number }>("clip.delete", {
        all: true,
        dryRun: true,
      });
      console.log(`${preview.matched} clips would be deleted. Re-run with --yes to confirm.`);
      return;
    }
    const out = await client.call<{ deleted: number }>("clip.delete", { all: true });
    console.log(`Deleted ${out.deleted} clip${out.deleted === 1 ? "" : "s"}.`);
    return;
  }
  if (target === undefined || target.trim() === "") {
    throw new Error("Usage: nimbus clip delete <id|url> | --all [--yes]");
  }
  const out = await client.call<{ deleted: number }>("clip.delete", { target });
  console.log(`Deleted ${out.deleted} clip${out.deleted === 1 ? "" : "s"}.`);
}
```

Add the `delete` case to the `switch (sub)` in `runClip`, before `default`:

```ts
    case "delete": {
      const all = rest.includes("--all");
      const yes = rest.includes("--yes");
      const target = rest.find((a) => !a.startsWith("--"));
      await withIpc((c) => runClipDelete(c, target, { all, yes }));
      return;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/src/commands/clip.test.ts --timeout 60000`
Expected: PASS.

- [ ] **Step 5: Typecheck the CLI**

Run: `bun run --filter '@nimbus/cli' typecheck`
Expected: `Done`.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/clip.ts packages/cli/src/commands/clip.test.ts
git commit -m "feat(cli): nimbus clip delete (id/url/--all --yes)"
```

---

### Task 5: Docs + full verification

**Files:**

- Modify: `docs/cli-reference.md` (document `clip list` + `clip delete`)
- Modify: `docs/CHANGELOG.md` (one dated entry)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the CLI reference sections**

In `docs/cli-reference.md`, immediately after the `### \`nimbus clip pair …\`` section (before `### \`nimbus clip status\``), insert:

```markdown
### `nimbus clip list [--tag <t>] [--limit N] [--json]`

List saved web clips, newest first. `--tag` filters to clips carrying that exact tag
(matched in SQL, so `--limit` stays correct). `--limit` defaults to 50 (invalid values fall
back to the default). `--json` emits structured rows (`id, title, url, clippedAt, tags, mode,
wordCount`) for scripting.

```bash
nimbus clip list
nimbus clip list --tag rust --limit 20
nimbus clip list --json
```text

---

### `nimbus clip delete <id|url>` / `nimbus clip delete --all [--yes]`

Delete clips. A `nimbus:` argument is treated as a clip ID (from `clip list`); anything else
is treated as a page URL and every clip from that page (the article plus any text selections)
is removed. `--all` clears every clip but is guarded: without `--yes` it only reports how many
would be deleted. Deleting a missing id/url is idempotent (`Deleted 0 clips.`).

```bash
nimbus clip delete https://blog.example.com/rust-async
nimbus clip delete nimbus:clip:abc123…
nimbus clip delete --all --yes
```text

---

```

- [ ] **Step 2: Add the CHANGELOG entry**

In `docs/CHANGELOG.md`, add this as the first bullet under `## Post-Phase-6 deliveries`:

```markdown
- **2026-07-16 — `nimbus clip list` + `nimbus clip delete`.** Two new read/manage commands
  for web clips, backed by two new local-index IPC methods (`clip.list`, `clip.delete`).
  `clip list` shows saved clips newest-first with `--tag` (SQL `json_each` filter, so
  `--limit` is honored), `--limit`, and `--json` (incl. `wordCount`). `clip delete` removes a
  clip by ID or by page URL (article + all selections), or `--all --yes` to clear everything;
  deletes go through `deleteItemByPrimaryKey` (graph + FTS + embedding/vec cascade cleanup) and
  are strictly `web_clip`-scoped. No new invariant, no migration (read + local delete is not
  outbound egress).
```

- [ ] **Step 3: Run the full clip test suites + typecheck**

Run:

```bash
bun test packages/gateway/src/ipc/clip-rpc.test.ts packages/cli/src/commands/clip.test.ts --timeout 60000
bun run --filter '@nimbus/gateway' --filter '@nimbus/cli' --sequential typecheck
```

Expected: all PASS; typecheck `Done`.

- [ ] **Step 4: Lint the changed files**

Run: `bunx biome check packages/gateway/src/ipc/clip-rpc.ts packages/gateway/src/ipc/server/dispatchers.ts packages/cli/src/commands/clip.ts packages/gateway/src/ipc/clip-rpc.test.ts packages/cli/src/commands/clip.test.ts`
Expected: `No fixes applied` / no errors.

- [ ] **Step 5: Static invariant audit (sanity — no invariant touched)**

Run: `bun scripts/structure-audit/check-nimbus-invariants.ts`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add docs/cli-reference.md docs/CHANGELOG.md
git commit -m "docs: document nimbus clip list + clip delete"
```

- [ ] **Step 7: Coverage-floor dry run (Linux-authoritative)**

Per the repo's cross-platform note, `audit:coverage-floor` is CI-Linux-authoritative. If Docker is available, run the Linux dry run for the two changed packages before opening a PR; otherwise flag that the coverage floor must be confirmed in CI. New lines in `clip-rpc.ts` and `clip.ts` are covered by the tests above; if any file dips below the 80% line/branch floor, add a targeted test (the most likely gap is an uncovered `default`/guard branch).

---

## Self-Review

**Spec coverage:**

- `clip list` (`--tag`/`--limit`/`--json`, newest-first, empty states) → Tasks 1, 3. ✅
- SQL `json_each` tag filter (LIMIT-correct) + regression test → Task 1. ✅
- `wordCount` in `--json` → Tasks 1, 3. ✅
- `clip delete` by id / URL (article+selections) / `--all --yes` guard → Tasks 2, 4. ✅
- ID-vs-URL `nimbus:` auto-detect + web_clip type-guard → Task 2. ✅
- `deleteItemByPrimaryKey` (graph/FTS/embedding cascade), never raw DELETE → Task 2 + Global Constraints. ✅
- Empty/blank delete target guard → Task 2. ✅
- `--limit` validation → Tasks 1 (gateway clamp) + 3 (`parseLimit`). ✅
- DB absent: `clip.list` empty (fail-soft) / `clip.delete` throws `Clip index unavailable.` → Tasks 1, 2. ✅
- `--tag` query resilient to a malformed-metadata row (`json_valid` guard) → Task 1. ✅
- `<target> --all` mutual-exclusion guard → Task 4. ✅
- DB threaded via `ctx.options.localIndex.getDatabase()` → Task 1. ✅
- Docs (cli-reference + CHANGELOG) → Task 5. ✅
- No new invariant/migration → Global Constraints + Task 5 sanity audit. ✅

**Type consistency:** `ClipListEntry` fields (`id, title, url, clippedAt, tags, mode, wordCount`) match between gateway (Task 1) and CLI (Task 3). IPC shapes: `clip.list` → `{ clips }`, `clip.delete` → `{ deleted, matched }` — consistent across producer (Tasks 1/2) and consumer (Tasks 3/4). `runClipDelete`/`runClipList` signatures match their call sites in `runClip`.

**Placeholder scan:** none — every code step carries complete code and exact commands.

## Plan Review Resolution

Plan review ([2026-07-16-clip-list-delete-review.md](./2026-07-16-clip-list-delete-review.md)) — all three points accepted after verification:

1. **`json_each` crashes on malformed JSON** — FIXED. Verified a raw `json_each` tag query throws `malformed JSON` when any `web_clip` row has invalid metadata; wrapped the input in `CASE WHEN json_valid(...)` (verified to return the good rows). Added a Task-1 test with a corrupted sibling row under `--tag`.
2. **DB-absent delete mismatch (plan vs. spec)** — FIXED. The plan had `clip.delete` fail-soft to `{deleted:0}`, contradicting the spec's "surface `Clip index unavailable.`". Aligned the handler to throw and updated the test + Global Constraints.
3. **`<target> --all` mutual exclusion** — FIXED. Added a `runClipDelete` guard that rejects a target combined with `--all` (prevents an accidental mass-delete), plus a test asserting no IPC call is made.
