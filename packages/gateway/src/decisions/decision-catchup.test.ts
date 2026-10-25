import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { type LayerKind, mergeLayerDocs, parseLayerDoc } from "../config/layered-merge.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { sourceTypesFor } from "../sources/source-kinds.ts";
import {
  BUILTIN_SOURCE_MAPPING,
  resolveSourceMapping,
  type SourceMapping,
} from "../sources/source-mapping.ts";
import { catchupTypes, reconcileCatchupRows } from "./decision-catchup.ts";
import { CATCHUP_SCAN_SQL, runDecisionPass } from "./decision-extract.ts";
import { readPassState } from "./decision-store.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});

const BUILTIN = new Set(sourceTypesFor("decisions"));

function mappingOf(kind: LayerKind, body: string): SourceMapping {
  const doc = parseLayerDoc(
    { kind, id: kind === "pack" ? "p" : kind, path: `/virtual/${kind}.toml` },
    `[sources]\n${body}\n`,
  );
  return resolveSourceMapping({ doc: mergeLayerDocs([doc]) });
}

const WITH_READWISE = mappingOf("pack", 'map = ["readwise:highlight=note"]');

function seed(id: string, service: string, type: string, body: string, at: number): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body, body_preview, modified_at, synced_at, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [id, service, type, id, "t", body, body, at, at],
  );
}

function pass(mapping: SourceMapping, nowMs: number, extra: Record<string, unknown> = {}) {
  return runDecisionPass(db, {
    nowMs,
    useLlm: false,
    maxLlmCalls: 0,
    retryCooldownMs: 1_000,
    mapping,
    ...extra,
  });
}

type Row = { service_type: string; watermark_ms: number; watermark_id: string; done: number };
function catchupRow(serviceType: string): Row | null {
  return db
    .query(
      "SELECT service_type, watermark_ms, watermark_id, done FROM source_catchup_state WHERE pass = 'decisions' AND service_type = ?",
    )
    .get(serviceType) as Row | null;
}

function recordsFor(itemId: string): { id: string; updated_at: number }[] {
  return db
    .query("SELECT id, updated_at FROM decision_record WHERE source_item_id = ? ORDER BY id")
    .all(itemId) as { id: string; updated_at: number }[];
}

describe("reconcileCatchupRows", () => {
  const MAIN = { watermarkMs: 500, watermarkId: "m" };

  test("a new effective type starts at zero, a built-in starts done at the main cursor", () => {
    reconcileCatchupRows(db, "decisions", ["slack:message", "readwise:highlight"], BUILTIN, MAIN);
    expect(catchupRow("slack:message")).toEqual({
      service_type: "slack:message",
      watermark_ms: 500,
      watermark_id: "m",
      done: 1,
    });
    expect(catchupRow("readwise:highlight")).toEqual({
      service_type: "readwise:highlight",
      watermark_ms: 0,
      watermark_id: "",
      done: 0,
    });
  });

  test("a built-in not effective on first sight is parked at the main cursor, not done", () => {
    reconcileCatchupRows(db, "decisions", [], BUILTIN, MAIN);
    expect(catchupRow("slack:message")).toEqual({
      service_type: "slack:message",
      watermark_ms: 500,
      watermark_id: "m",
      done: 0,
    });
  });

  test("a done type that left the set is re-opened at the main cursor of that moment", () => {
    reconcileCatchupRows(db, "decisions", ["readwise:highlight"], BUILTIN, MAIN);
    db.run("UPDATE source_catchup_state SET done = 1 WHERE service_type = 'readwise:highlight'");
    reconcileCatchupRows(db, "decisions", [], BUILTIN, { watermarkMs: 900, watermarkId: "z" });
    expect(catchupRow("readwise:highlight")).toEqual({
      service_type: "readwise:highlight",
      watermark_ms: 900,
      watermark_id: "z",
      done: 0,
    });
  });

  test("a not-done type that left the set keeps its cursor", () => {
    reconcileCatchupRows(db, "decisions", ["readwise:highlight"], BUILTIN, MAIN);
    db.run(
      "UPDATE source_catchup_state SET watermark_ms = 42, watermark_id = 'k' WHERE service_type = 'readwise:highlight'",
    );
    reconcileCatchupRows(db, "decisions", [], BUILTIN, { watermarkMs: 900, watermarkId: "z" });
    expect(catchupRow("readwise:highlight")?.watermark_ms).toBe(42);
    expect(catchupRow("readwise:highlight")?.done).toBe(0);
  });

  test("catchupTypes lists only effective, not-done types", () => {
    reconcileCatchupRows(db, "decisions", ["slack:message", "readwise:highlight"], BUILTIN, MAIN);
    reconcileCatchupRows(db, "decisions", ["slack:message"], BUILTIN, MAIN);
    expect(catchupTypes(db, "decisions", ["slack:message"])).toEqual([]);
    expect(catchupTypes(db, "decisions", ["slack:message", "readwise:highlight"])).toEqual([
      { serviceType: "readwise:highlight", watermarkMs: 0, watermarkId: "" },
    ]);
  });
});

describe("catch-up in the decisions pass", () => {
  test("a newly mapped type's existing items are mined", async () => {
    seed("h1", "readwise", "highlight", "Decision: adopt Postgres for billing.", 1_000);
    seed("s1", "slack", "message", "We decided to ship it.", 2_000);
    await pass(BUILTIN_SOURCE_MAPPING, 10_000);
    expect(recordsFor("h1")).toHaveLength(0);
    expect(recordsFor("s1")).toHaveLength(1);

    const summary = await pass(WITH_READWISE, 20_000);
    expect(recordsFor("h1")).toHaveLength(1);
    expect(summary.discovered).toBe(1);
    expect(summary.discoveryComplete).toBe(true);
    expect(catchupRow("readwise:highlight")?.done).toBe(1);
  });

  test("built-in types are not re-scanned on upgrade", async () => {
    seed("s1", "slack", "message", "We decided to ship it.", 2_000);
    await pass(BUILTIN_SOURCE_MAPPING, 10_000);
    const before = recordsFor("s1");
    // An index from before V74: the main cursor is past every item and no catch-up row exists.
    db.run("DELETE FROM source_catchup_state");

    const summary = await pass(BUILTIN_SOURCE_MAPPING, 20_000);
    expect(summary.scanned).toBe(0);
    expect(summary.discovered).toBe(0);
    expect(recordsFor("s1")).toEqual(before);
    expect(catchupRow("slack:message")).toEqual({
      service_type: "slack:message",
      watermark_ms: 2_000,
      watermark_id: "s1",
      done: 1,
    });
  });

  test("re-adding a type catches up only the unmapped window", async () => {
    seed("h1", "readwise", "highlight", "Decision: adopt Postgres for billing.", 1_000);
    await pass(WITH_READWISE, 10_000);
    const minedBefore = recordsFor("h1");
    expect(minedBefore).toHaveLength(1);

    // Unmapped for a run, while the main cursor moves on.
    seed("s1", "slack", "message", "We decided to ship it.", 3_000);
    await pass(BUILTIN_SOURCE_MAPPING, 20_000);
    expect(catchupRow("readwise:highlight")).toMatchObject({
      done: 0,
      watermark_ms: 1_000,
      watermark_id: "h1",
    });

    // Modified while unmapped: the delta scan moves past it without seeing it.
    seed("h2", "readwise", "highlight", "Decision: drop the legacy queue.", 4_000);
    seed("s2", "slack", "message", "We decided to retire it.", 5_000);
    await pass(BUILTIN_SOURCE_MAPPING, 30_000);
    expect(recordsFor("h2")).toHaveLength(0);
    expect(readPassState(db).watermarkMs).toBe(5_000);

    await pass(WITH_READWISE, 40_000);
    expect(recordsFor("h2")).toHaveLength(1);
    expect(recordsFor("h1")).toEqual(minedBefore); // not re-upserted: updated_at unchanged
    expect(catchupRow("readwise:highlight")?.done).toBe(1);
  });

  test("catch-up never moves the main watermark", async () => {
    seed("s1", "slack", "message", "We decided to ship it.", 9_000);
    await pass(BUILTIN_SOURCE_MAPPING, 10_000);
    expect(readPassState(db).watermarkMs).toBe(9_000);
    seed("h1", "readwise", "highlight", "Decision: adopt Postgres.", 1_000);
    seed("h2", "readwise", "highlight", "Decision: drop the queue.", 2_000);

    // Observed between catch-up batches too: a rewind there is what a crash would leave behind,
    // even though the end-of-run pass-state write would cover it up.
    const seen: number[] = [];
    const mappingAt = () => {
      seen.push(readPassState(db).watermarkMs);
      return WITH_READWISE;
    };
    await pass(WITH_READWISE, 20_000, { scanBatchLimit: 1, mappingAt });
    expect(recordsFor("h1")).toHaveLength(1);
    expect(recordsFor("h2")).toHaveLength(1);
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen)).toEqual(new Set([9_000]));
    expect(readPassState(db).watermarkMs).toBe(9_000);
    expect(readPassState(db).watermarkId).toBe("s1");
  });

  test("catch-up shares the run's batch budget and resumes next run", async () => {
    seed("s1", "slack", "message", "We decided to ship it.", 9_000);
    await pass(BUILTIN_SOURCE_MAPPING, 10_000);
    for (let i = 0; i < 5; i++) {
      seed(`h${i}`, "readwise", "highlight", `Decision: adopt thing ${i}.`, 1_000 + i);
    }
    seed("s2", "slack", "message", "We decided to retire it.", 9_500);

    const capped = await pass(WITH_READWISE, 20_000, { scanBatchLimit: 2, maxDiscoveryBatches: 2 });
    expect(capped.discoveryComplete).toBe(false);
    expect(capped.scanned).toBe(4);
    expect(recordsFor("s2")).toHaveLength(0); // the delta had no batch left
    expect(readPassState(db).watermarkMs).toBe(9_000);

    const rest = await pass(WITH_READWISE, 30_000, { scanBatchLimit: 2 });
    expect(rest.discoveryComplete).toBe(true);
    expect(recordsFor("h4")).toHaveLength(1);
    expect(recordsFor("s2")).toHaveLength(1);
    expect(catchupRow("readwise:highlight")?.done).toBe(1);
  });

  test("catch-up stops a type that left the set mid-run", async () => {
    seed("s1", "slack", "message", "We decided to ship it.", 9_000);
    await pass(BUILTIN_SOURCE_MAPPING, 10_000);
    for (let i = 0; i < 5; i++) {
      seed(`h${i}`, "readwise", "highlight", `Decision: adopt thing ${i}.`, 1_000 + i);
    }
    let calls = 0;
    // The first check (before batch 1) sees the pack; every later check sees it removed.
    const mappingAt = () => (calls++ === 0 ? WITH_READWISE : BUILTIN_SOURCE_MAPPING);
    const summary = await pass(WITH_READWISE, 20_000, { scanBatchLimit: 2, mappingAt });
    expect(summary.scanned).toBe(2);
    expect(recordsFor("h0")).toHaveLength(1);
    expect(recordsFor("h2")).toHaveLength(0);
    expect(catchupRow("readwise:highlight")).toMatchObject({ done: 0, watermark_id: "h1" });
  });
});

describe("catch-up query plan", () => {
  test("one type's window is a seek on the composite index, with no sort", () => {
    const plan = db
      .query(`EXPLAIN QUERY PLAN ${CATCHUP_SCAN_SQL}`)
      .all("slack", "message", 0, "", 9, "z", 5000) as { detail: string }[];
    const details = plan.map((p) => p.detail);
    // The cursor range must be part of the index seek, not a filter over the whole type.
    expect(
      details.some(
        (d) => d.includes("idx_item_service_type_modified") && d.includes("(modified_at,id)>"),
      ),
    ).toBe(true);
    expect(details.filter((d) => d.includes("TEMP B-TREE"))).toEqual([]);
  });
});
