import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  readEntityMetadata,
  upsertGraphEntity,
  upsertGraphEntityNamespaced,
} from "./relationship-graph.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE graph_entity (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, external_id TEXT NOT NULL,
    label TEXT NOT NULL, service TEXT, metadata TEXT,
    UNIQUE(type, external_id))`);
  return db;
}

function rawMetadata(db: Database, externalId: string): string | null {
  const row = db
    .query("SELECT metadata FROM graph_entity WHERE external_id = ?")
    .get(externalId) as { metadata: string | null } | null;
  return row?.metadata ?? null;
}

describe("upsertGraphEntityNamespaced", () => {
  // THE BUG, in miniature: two writers on one entity must not destroy each other.
  test("a second writer does not wipe the first writer's namespace", () => {
    const db = makeDb();
    upsertGraphEntityNamespaced(db, {
      type: "source_file",
      externalId: "file:/repo:a.ts",
      label: "a.ts",
      writer: "ownership",
      metadata: { ownerCount: 3 },
    });
    upsertGraphEntityNamespaced(db, {
      type: "source_file",
      externalId: "file:/repo:a.ts",
      label: "a.ts",
      writer: "symbols",
      metadata: { symbolCount: 9 },
    });
    const raw = rawMetadata(db, "file:/repo:a.ts");
    expect(readEntityMetadata(raw, "ownership")).toEqual({ ownerCount: 3 });
    expect(readEntityMetadata(raw, "symbols")).toEqual({ symbolCount: 9 });
  });

  // graph-populator's converted writes rely on this exactly.
  //
  // NOTE: an empty `metadata` object is NOT a full no-op — the two-step patch (see the doc
  // comment on `upsertGraphEntityNamespaced`) still clears the WRITER'S OWN namespace to `{}`
  // on every call, including this one. What survives untouched is only the SIBLING namespace
  // (`ownership`, asserted below), never the calling writer's own prior data. Harmless for
  // `graph-populator` today (it never previously wrote `symbols` data to lose), but a real
  // defect the moment a writer calls with `{}` expecting its OWN last write to persist.
  test("an EMPTY metadata object preserves SIBLING namespaces but clears the writer's own", () => {
    const db = makeDb();
    upsertGraphEntityNamespaced(db, {
      type: "source_file",
      externalId: "file:/repo:b.ts",
      label: "b.ts",
      writer: "ownership",
      metadata: { ownerCount: 2 },
    });
    upsertGraphEntityNamespaced(db, {
      type: "source_file",
      externalId: "file:/repo:b.ts",
      label: "b.ts",
      writer: "symbols",
      metadata: {},
    });
    expect(readEntityMetadata(rawMetadata(db, "file:/repo:b.ts"), "ownership")).toEqual({
      ownerCount: 2,
    });
  });

  test("a writer replaces its OWN namespace wholesale", () => {
    const db = makeDb();
    const row = {
      type: "source_file",
      externalId: "file:/repo:c.ts",
      label: "c.ts",
      writer: "ownership" as const,
    };
    upsertGraphEntityNamespaced(db, { ...row, metadata: { ownerCount: 1, stale: true } });
    upsertGraphEntityNamespaced(db, { ...row, metadata: { ownerCount: 5 } });
    expect(readEntityMetadata(rawMetadata(db, "file:/repo:c.ts"), "ownership")).toEqual({
      ownerCount: 5,
    });
  });

  // Spec § 5.1: json_patch DELETES on null. Pinned so the next writer inherits the fact.
  test("a null field inside a namespace is DELETED, not stored", () => {
    const db = makeDb();
    upsertGraphEntityNamespaced(db, {
      type: "source_file",
      externalId: "file:/repo:d.ts",
      label: "d.ts",
      writer: "ownership",
      metadata: { ownerCount: 4, gone: null },
    });
    const got = readEntityMetadata(rawMetadata(db, "file:/repo:d.ts"), "ownership");
    expect(got).toEqual({ ownerCount: 4 });
    expect(got !== null && "gone" in got).toBe(false);
  });
});

describe("readEntityMetadata", () => {
  test("absent namespace yields null", () => {
    expect(readEntityMetadata(JSON.stringify({ ownership: { a: 1 } }), "symbols")).toBeNull();
  });

  test("null raw yields null", () => {
    expect(readEntityMetadata(null, "ownership")).toBeNull();
  });

  test("malformed JSON yields null and does not throw", () => {
    expect(readEntityMetadata("{not json", "ownership")).toBeNull();
  });

  test("a JSON scalar or array yields null", () => {
    expect(readEntityMetadata("42", "ownership")).toBeNull();
    expect(readEntityMetadata("[1,2]", "ownership")).toBeNull();
  });

  // Spec § 5.2: NO fallback. Flat metadata must stay visible as unmigrated, so a clobber
  // or a skipped migration surfaces instead of rendering as valid ownership data.
  test("FLAT metadata is NOT resurrected as the ownership namespace", () => {
    expect(readEntityMetadata(JSON.stringify({ ownerCount: 3 }), "ownership")).toBeNull();
  });

  test("a namespace holding a non-object yields null", () => {
    expect(readEntityMetadata(JSON.stringify({ ownership: 7 }), "ownership")).toBeNull();
  });

  test("an empty-string raw yields null without throwing", () => {
    expect(readEntityMetadata("", "ownership")).toBeNull();
  });
});

describe("upsertGraphEntityNamespaced — service column", () => {
  test("an explicit service value is persisted alongside the namespaced metadata", () => {
    const db = makeDb();
    upsertGraphEntityNamespaced(db, {
      type: "source_file",
      externalId: "file:/repo:e.ts",
      label: "e.ts",
      service: "filesystem",
      writer: "ownership",
      metadata: { ownerCount: 1 },
    });
    const row = db
      .query("SELECT service FROM graph_entity WHERE external_id = ?")
      .get("file:/repo:e.ts") as { service: string | null } | null;
    expect(row?.service).toBe("filesystem");
  });
});

describe("upsertGraphEntity — compile-time co-owned-type guard", () => {
  test("a non-co-owned literal type is accepted", () => {
    const db = makeDb();
    // The real assertion is compile-time (a non-co-owned literal type-checks at all, unlike the
    // rejected case below) and is enforced by the `typecheck` gate, not by this runtime call.
    upsertGraphEntity(db, {
      type: "pr",
      externalId: "pr:1",
      label: "PR #1",
    });
  });

  test("a co-owned literal type is rejected at compile time", () => {
    const db = makeDb();
    upsertGraphEntity(db, {
      // @ts-expect-error — "source_file" is a CoOwnedEntityType; use upsertGraphEntityNamespaced instead.
      type: "source_file",
      externalId: "file:/repo:z.ts",
      label: "z.ts",
    });
  });
});
