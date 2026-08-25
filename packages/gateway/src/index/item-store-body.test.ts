import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { BODY_MAX_PROSE } from "./body-caps.ts";
import type { UpsertSyncDeps } from "./item-store.ts";
import {
  selectItemBodyFetchState,
  upsertIndexedItem,
  upsertIndexedItemForSync,
} from "./item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "./local-index.ts";
import { runIndexedSchemaMigrations } from "./migrations/runner.ts";

function db(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  return d;
}

function read(d: Database, id: string) {
  return d.query("SELECT body, body_preview, body_complete FROM item WHERE id = ?").get(id) as {
    body: string | null;
    body_preview: string | null;
    body_complete: number;
  };
}

const base = {
  service: "slack",
  type: "message",
  externalId: "1",
  title: "a title",
  modifiedAt: 1,
  syncedAt: 1,
};

test("a declared-full prose body is stored whole and marked complete", () => {
  const d = db();
  const body = "x".repeat(4000);
  upsertIndexedItem(d, { ...base, body });

  const row = read(d, "slack:1");
  expect(row.body).toBe(body);
  expect(row.body_preview).toHaveLength(512);
  expect(row.body_complete).toBe(1);
  d.close();
});

test("body_preview is always the first 512 code units of body", () => {
  const d = db();
  const body = "y".repeat(4000);
  upsertIndexedItem(d, { ...base, body });

  const row = read(d, "slack:1");
  expect(row.body_preview).toBe(row.body?.slice(0, 512) ?? null);
  d.close();
});

test("a prose body over 16 KiB is clamped and marked incomplete", () => {
  const d = db();
  upsertIndexedItem(d, { ...base, body: "z".repeat(BODY_MAX_PROSE + 100) });

  const row = read(d, "slack:1");
  expect(row.body).toHaveLength(BODY_MAX_PROSE);
  expect(row.body_complete).toBe(0);
  d.close();
});

test("a non-prose type is still clamped at 512 even when declared full", () => {
  const d = db();
  upsertIndexedItem(d, {
    ...base,
    service: "aws",
    type: "resource",
    body: "w".repeat(4000),
  });

  const row = read(d, "aws:1");
  expect(row.body).toHaveLength(512);
  expect(row.body_complete).toBe(0);
  d.close();
});

test("the legacy bodyPreview path clamps at 512 and never claims completeness", () => {
  const d = db();
  upsertIndexedItem(d, { ...base, bodyPreview: "v".repeat(4000) });

  const row = read(d, "slack:1");
  expect(row.body).toHaveLength(512);
  expect(row.body_preview).toHaveLength(512);
  expect(row.body_complete).toBe(0);
  d.close();
});

test("an item with no body at all falls back to its title", () => {
  const d = db();
  upsertIndexedItem(d, base);

  const row = read(d, "slack:1");
  expect(row.body).toBe("a title");
  expect(row.body_preview).toBe("a title");
  expect(row.body_complete).toBe(0);
  d.close();
});

test("a full body is keyword-searchable past the 512-character mark", () => {
  const d = db();
  upsertIndexedItem(d, {
    ...base,
    body: `${"filler ".repeat(600)}kumquat`,
  });

  const hits = d.query("SELECT rowid FROM item_fts WHERE item_fts MATCH 'kumquat'").all() as Array<{
    rowid: number;
  }>;
  expect(hits).toHaveLength(1);
  d.close();
});

test("re-upserting a shorter body shrinks both columns", () => {
  const d = db();
  upsertIndexedItem(d, { ...base, body: "q".repeat(4000) });
  upsertIndexedItem(d, { ...base, body: "short" });

  const row = read(d, "slack:1");
  expect(row.body).toBe("short");
  expect(row.body_preview).toBe("short");
  d.close();
});

test("bodyTruncated forces body_complete = 0 even under the cap", () => {
  const d = db();
  upsertIndexedItem(d, {
    ...base,
    service: "notion",
    type: "page",
    externalId: "p1",
    body: "short text",
    bodyTruncated: true,
  });

  const row = read(d, "notion:p1");
  expect(row.body_complete).toBe(0);
  d.close();
});

test("body without bodyTruncated still reports complete", () => {
  const d = db();
  upsertIndexedItem(d, {
    ...base,
    service: "notion",
    type: "page",
    externalId: "p2",
    body: "short text",
  });

  const row = read(d, "notion:p2");
  expect(row.body_complete).toBe(1);
  d.close();
});

test("selectItemBodyFetchState reads modified_at and metadata.bodyFetch", () => {
  const d = db();
  upsertIndexedItem(d, {
    ...base,
    service: "notion",
    type: "page",
    externalId: "p3",
    body: "text",
    modifiedAt: 4242,
    metadata: { notionPageId: "p3", bodyFetch: "capped" },
  });

  expect(selectItemBodyFetchState(d, "notion:p3")).toEqual({
    modifiedAt: 4242,
    bodyFetch: "capped",
  });
  d.close();
});

test("selectItemBodyFetchState returns null bodyFetch when the key is absent", () => {
  const d = db();
  upsertIndexedItem(d, {
    ...base,
    service: "notion",
    type: "page",
    externalId: "p4",
    bodyPreview: "",
    modifiedAt: 7,
    metadata: { notionPageId: "p4" },
  });

  expect(selectItemBodyFetchState(d, "notion:p4")).toEqual({ modifiedAt: 7, bodyFetch: null });
  d.close();
});

test("selectItemBodyFetchState returns null for an unknown id", () => {
  const d = db();
  expect(selectItemBodyFetchState(d, "notion:nope")).toBeNull();
  d.close();
});

function ctxAt(d: Database, depth: "metadata_only" | "summary" | "full"): UpsertSyncDeps {
  // `UpsertSyncDeps` is now exactly what the store call needs, so this no longer has to lie with a
  // cast about being a whole SyncContext.
  return { db: d, depth };
}

test("metadata_only writes no body even when the connector passes body:", () => {
  const d = db();
  upsertIndexedItemForSync(ctxAt(d, "metadata_only"), {
    ...base,
    externalId: "m1",
    title: "Subject line",
    body: "secret contents",
  });
  const row = read(d, "slack:m1");
  expect(row.body ?? "").toBe("");
  expect(row.body_complete).toBe(0);
  d.close();
});

test("metadata_only leaves body_preview empty too", () => {
  const d = db();
  upsertIndexedItemForSync(ctxAt(d, "metadata_only"), {
    ...base,
    externalId: "m2",
    title: "Subject line",
    body: "secret contents",
  });
  expect(read(d, "slack:m2").body_preview ?? "").toBe("");
  d.close();
});

test("metadata_only does NOT store the title as the body", () => {
  // Regression guard: upsertIndexedItem computes
  //   raw = row.body ?? row.bodyPreview ?? row.title
  // so merely OMITTING the body input falls through to the title.
  const d = db();
  upsertIndexedItemForSync(ctxAt(d, "metadata_only"), {
    ...base,
    externalId: "m3",
    title: "Quarterly numbers",
    body: "secret",
  });
  const row = read(d, "slack:m3");
  expect(row.body ?? "").not.toBe("Quarterly numbers");
  expect(row.body_preview ?? "").not.toBe("Quarterly numbers");
  d.close();
});

test("summary downgrades a body: caller to 512 and never claims completeness", () => {
  const d = db();
  upsertIndexedItemForSync(ctxAt(d, "summary"), {
    ...base,
    externalId: "s1",
    body: "x".repeat(20_000),
  });
  const row = read(d, "slack:s1");
  expect(row.body ?? "").toHaveLength(512);
  expect(row.body_complete).toBe(0);
  d.close();
});

test("full passes a body through at the per-type cap", () => {
  const d = db();
  upsertIndexedItemForSync(ctxAt(d, "full"), {
    ...base,
    externalId: "f1",
    body: "y".repeat(20_000),
  });
  const row = read(d, "slack:f1");
  expect(row.body ?? "").toHaveLength(16_384);
  expect(row.body_complete).toBe(0); // over cap
  d.close();
});

test("an unrecognised depth passes the body through rather than clamping it", () => {
  // Unreachable through the typed API — `SyncContext["depth"]` is required
  // and the scheduler always supplies one of the three — but the DIRECTION of
  // the fallback has to agree with everything else that resolves an
  // unspecified depth: `getDepthForService()`, the `sync_state` insert in
  // `connectors/health.ts`, and the V49 backfill all answer `full`. Routing
  // an unknown value into the `summary` arm instead would silently truncate
  // to 512 characters. `imap-sync-core.test.ts`'s `fakeCtx()` casts past the
  // required field, so a shape like this really can reach the chokepoint.
  const d = db();
  // A deps object with NO depth at all — the pass-through arm.
  const unknownDepthCtx = { db: d } as unknown as UpsertSyncDeps;
  upsertIndexedItemForSync(unknownDepthCtx, {
    ...base,
    externalId: "u1",
    body: "z".repeat(2_000),
  });
  const row = read(d, "slack:u1");
  expect(row.body ?? "").toHaveLength(2_000);
  expect(row.body_complete).toBe(1);
  d.close();
});

test("a bodyPreview: caller is unaffected at full depth", () => {
  const d = db();
  upsertIndexedItemForSync(ctxAt(d, "full"), {
    ...base,
    externalId: "p1",
    bodyPreview: "short",
  });
  const row = read(d, "slack:p1");
  expect(row.body).toBe("short");
  expect(row.body_complete).toBe(0);
  d.close();
});
