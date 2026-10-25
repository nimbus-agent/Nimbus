import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { type LayerKind, mergeLayerDocs, parseLayerDoc } from "../config/layered-merge.ts";
import { dbRun } from "../db/write.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import { reconcileCatchupRows } from "../sources/source-catchup.ts";
import { sourceTypesFor } from "../sources/source-kinds.ts";
import {
  BUILTIN_SOURCE_MAPPING,
  resolveSourceMapping,
  type SourceMapping,
} from "../sources/source-mapping.ts";
import type { ConsolidatorLlm } from "./glossary-consolidate.ts";
import { runGlossaryPass } from "./glossary-extract.ts";
import { reconcilePass } from "./glossary-reconcile.ts";
import {
  computeTermStats,
  getTerm,
  markConsolidated,
  upsertCandidate,
  upsertManualTerm,
} from "./glossary-store.ts";
import {
  glossarySets,
  isFastPath,
  isTermVisible,
  routesRemotely,
  sweepProjections,
  syncTermProjection,
} from "./glossary-visibility.ts";

function vecAvailable(): boolean {
  const probe = new Database(":memory:");
  tryLoadSqliteVec(probe);
  const ok = isVecLoaded(probe);
  probe.close();
  return ok;
}
const VEC_AVAILABLE = vecAvailable();

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});

describe("isFastPath", () => {
  test("true when every known type is effective", () => {
    expect(isFastPath(["a:b", "c:d"], ["c:d", "a:b", "e:f"])).toBe(true);
    expect(isFastPath([], [])).toBe(true);
  });
  test("false when any known type is not effective", () => {
    expect(isFastPath(["a:b", "c:d"], ["a:b"])).toBe(false);
  });
});

describe("glossarySets", () => {
  test("the built-in mapping on a fresh index is the fast path", () => {
    const sets = glossarySets(db, BUILTIN_SOURCE_MAPPING);
    expect(sets.effective).toEqual(sourceTypesFor("glossary"));
    expect(sets.known).toEqual(sourceTypesFor("glossary"));
    expect(sets.fast).toBe(true);
  });
  test("a tracked type that left the mapping turns the fast path off", () => {
    const cursor = { watermarkMs: 5, watermarkId: "x" };
    reconcileCatchupRows(db, "glossary", ["ext_notes:highlight"], new Set(), cursor);
    const sets = glossarySets(db, BUILTIN_SOURCE_MAPPING);
    expect(sets.known).toContain("ext_notes:highlight");
    expect(sets.fast).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Visibility, projection and the § 7.1 routing rule
// ---------------------------------------------------------------------------

function mappingOf(kind: LayerKind, body: string): SourceMapping {
  const doc = parseLayerDoc(
    { kind, id: kind === "pack" ? "p" : kind, path: `/virtual/${kind}.toml` },
    `[sources]\n${body}\n`,
  );
  return resolveSourceMapping({ doc: mergeLayerDocs([doc]) });
}

const WITH_NOTES = mappingOf("pack", 'map = ["ext_notes:highlight=note"]');
const NO_SLACK = mappingOf("base", 'exclude = ["slack:message"]');
const BUILTIN = sourceTypesFor("glossary");

function seedAs(service: string, type: string, id: string, text: string, at: number): void {
  upsertIndexedItem(db, {
    service,
    type,
    externalId: id,
    title: text,
    bodyPreview: text,
    modifiedAt: at,
    syncedAt: at,
  });
}

function seedSlack(count: number, text: string, at = 100): void {
  for (let i = 0; i < count; i++) seedAs("slack", "message", `s${String(at + i)}`, text, at + i);
}

/** A consolidated mined term whose stats are measured over `types`. No projection. */
function seedConsolidated(key: string, types: readonly string[]): void {
  upsertCandidate(db, {
    key,
    surface: key.toUpperCase(),
    form: "acronym",
    stats: computeTermStats(db, key, types),
    score: 5,
    nowMs: 1000,
  });
  markConsolidated(db, {
    termKey: key,
    definition: "a definition",
    definitionSource: "llm",
    synonyms: [],
    nearMisses: [],
    nowMs: 1000,
  });
}

function seedManual(key: string, display: string): void {
  upsertManualTerm(db, {
    termKey: key,
    displayTerm: display,
    definition: `${display} is authored`,
    synonyms: [],
    nearMisses: [],
    stats: computeTermStats(db, key, BUILTIN),
    score: 1,
    nowMs: 1000,
  });
}

/** Makes `ext_notes:highlight` a known glossary type, as a pass with `WITH_NOTES` would. */
function trackNotes(): void {
  reconcileCatchupRows(db, "glossary", WITH_NOTES.typesFor("glossary"), new Set(), {
    watermarkMs: 0,
    watermarkId: "",
  });
}

type ItemRow = { id: string; type: string; synced_at: number };
function glossaryItems(): ItemRow[] {
  return db
    .query(
      `SELECT id, type, synced_at FROM item
        WHERE service = 'nimbus' AND type IN ('glossary_term', 'glossary_term_local')
        ORDER BY id`,
    )
    .all() as ItemRow[];
}

function definingLlm(counter?: { calls: number }): ConsolidatorLlm {
  return {
    generateJson: async () => {
      if (counter !== undefined) counter.calls += 1;
      return JSON.stringify({ isDomainTerm: true, definition: "a definition" });
    },
  };
}

const PASS = {
  maxNewTermsPerPass: 25,
  statsRecheckPerPass: 50,
  // Large, so a pass's reconcile sweep re-checks nothing and only the path under test projects.
  statsRecheckCooldownMs: 1_000_000_000,
  minDocFreq: 3,
  consolidateTimeoutMs: 1000,
  retryBaseCooldownMs: 1000,
  nowMs: 5000,
};

describe("routesRemotely", () => {
  test("built-in and prose-heavy types embed remotely", () => {
    expect(routesRemotely(["jira:issue", "slack:message"])).toBe(true);
    expect(routesRemotely(["zoom:transcript"])).toBe(true);
  });
  test("a pack-added or local-only type keeps the term local", () => {
    expect(routesRemotely(["jira:issue", "ext_notes:highlight"])).toBe(false);
    expect(routesRemotely(["nimbus:web_clip"])).toBe(false);
  });
  test("a term with no occurrences stays on today's type", () => {
    expect(routesRemotely([])).toBe(true);
  });
});

describe("isTermVisible", () => {
  test("a mined term with no effective occurrence is hidden; manual terms are never hidden", () => {
    seedSlack(3, "the CDR and the WAL run");
    seedConsolidated("cdr", BUILTIN);
    seedManual("wal", "WAL");
    const hidden = glossarySets(db, NO_SLACK);
    expect(hidden.fast).toBe(false);
    const cdr = getTerm(db, "cdr");
    const wal = getTerm(db, "wal");
    if (cdr === null || wal === null) throw new Error("seed failed");
    expect(isTermVisible(db, cdr, hidden)).toBe(false);
    expect(isTermVisible(db, wal, hidden)).toBe(true);
    expect(isTermVisible(db, cdr, glossarySets(db, BUILTIN_SOURCE_MAPPING))).toBe(true);
  });
});

describe("syncTermProjection", () => {
  test("a local-only contributor projects the term as glossary_term_local", () => {
    trackNotes();
    seedSlack(2, "the CDR runs");
    seedAs("ext_notes", "highlight", "h1", "the CDR runs", 500);
    const sets = glossarySets(db, WITH_NOTES);
    seedConsolidated("cdr", sets.known);

    expect(syncTermProjection(db, "cdr", sets, 2000)).toBe("projected_local");
    const items = glossaryItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("glossary_term_local");
  });

  test("a remote-only term projects as glossary_term", () => {
    seedSlack(3, "the CDR runs");
    const sets = glossarySets(db, BUILTIN_SOURCE_MAPPING);
    seedConsolidated("cdr", sets.known);
    expect(syncTermProjection(db, "cdr", sets, 2000)).toBe("projected");
    expect(glossaryItems().map((r) => r.type)).toEqual(["glossary_term"]);
  });

  test("routing flips back when the contributor leaves the known set", () => {
    trackNotes();
    seedSlack(3, "the CDR runs");
    seedAs("ext_notes", "highlight", "h1", "the CDR runs", 500);
    seedConsolidated("cdr", glossarySets(db, WITH_NOTES).known);
    syncTermProjection(db, "cdr", glossarySets(db, WITH_NOTES), 2000);
    expect(glossaryItems().map((r) => r.type)).toEqual(["glossary_term_local"]);

    // What a rebuild leaves behind: the type is no longer tracked at all.
    dbRun(
      db,
      "DELETE FROM source_catchup_state WHERE pass = 'glossary' AND service_type = 'ext_notes:highlight'",
      [],
    );
    reconcilePass(db, {
      limit: 10,
      minDocFreq: 3,
      nowMs: 3000,
      cooldownMs: 0,
      sets: glossarySets(db, BUILTIN_SOURCE_MAPPING),
    });
    expect(glossaryItems().map((r) => r.type)).toEqual(["glossary_term"]);
  });

  test("a hidden term is unprojected; a missing row is skipped", () => {
    seedSlack(3, "the CDR runs");
    seedConsolidated("cdr", BUILTIN);
    syncTermProjection(db, "cdr", glossarySets(db, BUILTIN_SOURCE_MAPPING), 2000);
    expect(syncTermProjection(db, "cdr", glossarySets(db, NO_SLACK), 2100)).toBe("unprojected");
    expect(glossaryItems()).toHaveLength(0);
    expect(syncTermProjection(db, "absent", glossarySets(db, NO_SLACK), 2100)).toBe("skipped");
  });
});

describe.skipIf(!VEC_AVAILABLE)("routing flips and the vector tables", () => {
  test("a routing flip drops the old vectors", () => {
    const vdb = new Database(":memory:");
    LocalIndex.ensureSchema(vdb);
    // The drop must not lean on the FK cascade, which needs `foreign_keys = ON` on THIS
    // connection.
    dbRun(vdb, "PRAGMA foreign_keys = OFF");
    db = vdb;
    seedSlack(3, "the CDR runs");
    seedConsolidated("cdr", BUILTIN);
    syncTermProjection(db, "cdr", glossarySets(db, BUILTIN_SOURCE_MAPPING), 2000);
    const id = glossaryItems()[0]?.id ?? "";
    expect(glossaryItems()[0]?.type).toBe("glossary_term");

    const vec = new Float32Array(1536);
    vec[0] = 1;
    dbRun(db, "INSERT INTO vec_items_1536 (rowid, embedding) VALUES (?, vec_f32(?))", [77, vec]);
    dbRun(
      db,
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES (?, 0, 'remote chunk', 77, 'openai:text-embedding-3-small', 1536, 1)`,
      [id],
    );

    trackNotes();
    seedAs("ext_notes", "highlight", "h1", "the CDR runs", 500);
    expect(syncTermProjection(db, "cdr", glossarySets(db, WITH_NOTES), 3000)).toBe(
      "projected_local",
    );
    expect(glossaryItems().map((r) => [r.id, r.type])).toEqual([[id, "glossary_term_local"]]);
    const chunks = db
      .query("SELECT COUNT(*) AS c FROM embedding_chunk WHERE item_id = ?")
      .get(id) as { c: number };
    expect(chunks.c).toBe(0);
    const vecs = db.query("SELECT COUNT(*) AS c FROM vec_items_1536 WHERE rowid = 77").get() as {
      c: number;
    };
    expect(vecs.c).toBe(0);
    vdb.close();
  });
});

describe("sweepProjections", () => {
  test("manual terms are never hidden", () => {
    seedSlack(3, "the WAL runs");
    seedManual("wal", "WAL");
    sweepProjections(db, glossarySets(db, NO_SLACK), 2000);
    expect(glossaryItems().map((r) => r.type)).toEqual(["glossary_term"]);
  });

  test("sweep is a no-op when the effective set is unchanged", () => {
    seedSlack(3, "the CDR and the WAL run");
    seedConsolidated("cdr", BUILTIN);
    seedConsolidated("wal", BUILTIN);
    seedManual("slo", "SLO");
    const first = sweepProjections(db, glossarySets(db, NO_SLACK), 2000);
    // cdr and wal are hidden (no effective occurrence); slo is manual and projected.
    expect(first).toEqual({ projected: 1, unprojected: 2 });
    expect(sweepProjections(db, glossarySets(db, NO_SLACK), 3000)).toEqual({
      projected: 0,
      unprojected: 0,
    });
    expect(glossaryItems().map((r) => r.synced_at)).toEqual([2000]);
  });

  test("on the fast path, a newly known local-only type re-routes an existing remote copy", () => {
    seedSlack(3, "the CDR runs");
    seedConsolidated("cdr", BUILTIN);
    syncTermProjection(db, "cdr", glossarySets(db, BUILTIN_SOURCE_MAPPING), 2000);
    expect(glossaryItems().map((r) => r.type)).toEqual(["glossary_term"]);
    // A highlight no catch-up batch has reached yet: only the sweep can re-route the term.
    seedAs("ext_notes", "highlight", "h1", "the CDR runs", 500);
    trackNotes();
    const sets = glossarySets(db, WITH_NOTES);
    expect(sets.fast).toBe(true);
    expect(sweepProjections(db, sets, 3000)).toEqual({ projected: 1, unprojected: 0 });
    expect(glossaryItems().map((r) => r.type)).toEqual(["glossary_term_local"]);
  });

  test("the fast path projects consolidated terms that have no item", () => {
    seedSlack(3, "the CDR runs");
    seedConsolidated("cdr", BUILTIN);
    expect(sweepProjections(db, glossarySets(db, BUILTIN_SOURCE_MAPPING), 2000)).toEqual({
      projected: 1,
      unprojected: 0,
    });
    expect(glossaryItems().map((r) => r.type)).toEqual(["glossary_term"]);
  });
});

describe("a glossary pass", () => {
  test("a hidden term is unprojected and re-projected without a model call", async () => {
    seedSlack(3, "the CDR runs");
    await runGlossaryPass(db, { ...PASS, llm: definingLlm(), mapping: BUILTIN_SOURCE_MAPPING });
    const before = getTerm(db, "cdr");
    expect(before?.status).toBe("consolidated");
    expect(glossaryItems()).toHaveLength(1);

    const counter = { calls: 0 };
    await runGlossaryPass(db, {
      ...PASS,
      llm: definingLlm(counter),
      mapping: NO_SLACK,
      nowMs: 6000,
    });
    expect(glossaryItems()).toHaveLength(0);
    const hidden = getTerm(db, "cdr");
    expect(hidden?.status).toBe("consolidated");
    expect(hidden?.definition).toBe(before?.definition ?? "missing");
    expect(hidden?.docFreq).toBe(before?.docFreq ?? -1);

    await runGlossaryPass(db, {
      ...PASS,
      llm: definingLlm(counter),
      mapping: BUILTIN_SOURCE_MAPPING,
      nowMs: 7000,
    });
    expect(glossaryItems().map((r) => r.type)).toEqual(["glossary_term"]);
    expect(counter.calls).toBe(0);
  });

  test("an unchanged second pass re-projects nothing", async () => {
    seedSlack(3, "the CDR runs");
    for (let i = 0; i < 3; i++) seedAs("jira", "issue", `j${String(i)}`, "the WAL runs", 300 + i);
    await runGlossaryPass(db, { ...PASS, llm: definingLlm(), mapping: NO_SLACK });
    const first = glossaryItems();
    expect(first.length).toBeGreaterThan(0);
    await runGlossaryPass(db, { ...PASS, llm: definingLlm(), mapping: NO_SLACK, nowMs: 6000 });
    expect(glossaryItems()).toEqual(first);
  });

  test("the fast path still routes", async () => {
    for (let i = 0; i < 3; i++) {
      seedAs("ext_notes", "highlight", `h${String(i)}`, "the CDR runs", 100 + i);
    }
    await runGlossaryPass(db, { ...PASS, llm: definingLlm(), mapping: WITH_NOTES });
    expect(glossarySets(db, WITH_NOTES).fast).toBe(true);
    expect(getTerm(db, "cdr")?.status).toBe("consolidated");
    expect(glossaryItems().map((r) => r.type)).toEqual(["glossary_term_local"]);
  });

  test("a term that gains a local-only occurrence is re-routed in the same pass", async () => {
    seedSlack(3, "the CDR runs");
    await runGlossaryPass(db, { ...PASS, llm: definingLlm(), mapping: WITH_NOTES });
    expect(glossaryItems().map((r) => r.type)).toEqual(["glossary_term"]);

    seedAs("ext_notes", "highlight", "h1", "the CDR runs", 9000);
    await runGlossaryPass(db, { ...PASS, llm: definingLlm(), mapping: WITH_NOTES, nowMs: 6000 });
    expect(glossaryItems().map((r) => r.type)).toEqual(["glossary_term_local"]);
  });
});
