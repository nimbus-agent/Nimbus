import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";

/** There is no `runMigrations` export — this wrapper matches every other test in the repo. */
function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

import { upsertIndexedItem } from "../index/item-store.ts";
import type { ConsolidatorLlm } from "./glossary-consolidate.ts";
import { rebuildGlossary, runGlossaryPass } from "./glossary-extract.ts";
import {
  clearGlossary,
  getTerm,
  listAllKeys,
  markConsolidated,
  readPassState,
  upsertCandidate,
} from "./glossary-store.ts";

let db: Database;

const OPTS = {
  maxNewTermsPerPass: 25,
  statsRecheckPerPass: 50,
  statsRecheckCooldownMs: 0,
  minDocFreq: 3,
  consolidateTimeoutMs: 1000,
  retryBaseCooldownMs: 1000,
  nowMs: 5000,
};

function definingLlm(): ConsolidatorLlm {
  return {
    generateJson: async () => JSON.stringify({ isDomainTerm: true, definition: "a definition" }),
  };
}

function seedTermItems(count: number, text: string, startId = 0): void {
  for (let i = 0; i < count; i++) {
    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: `m${String(startId + i)}`,
      title: text,
      bodyPreview: text,
      modifiedAt: 1000 + startId + i,
      syncedAt: 1000 + startId + i,
    });
  }
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

test("discovers, consolidates and projects a qualifying term", async () => {
  seedTermItems(3, "the CDR pipeline runs nightly");
  const out = await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });

  expect(out.discovered).toBeGreaterThan(0);
  expect(getTerm(db, "cdr")?.status).toBe("consolidated");
  const items = db.query("SELECT * FROM item WHERE type = 'glossary_term'").all();
  expect(items.length).toBeGreaterThan(0);
});

test("a term below the frequency floor is never stored", async () => {
  seedTermItems(2, "the CDR pipeline runs nightly");
  await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });
  expect(getTerm(db, "cdr")).toBe(null);
});

test("running the pass twice converges on identical statistics", async () => {
  seedTermItems(4, "the CDR pipeline runs nightly");
  await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });
  const first = getTerm(db, "cdr");
  await runGlossaryPass(db, { ...OPTS, llm: definingLlm(), nowMs: 6000 });
  const second = getTerm(db, "cdr");

  expect(second?.docFreq).toBe(first?.docFreq ?? -1);
  expect(second?.serviceSpread).toBe(first?.serviceSpread ?? -1);
  expect(second?.firstSeenAt).toBe(first?.firstSeenAt ?? -1);
});

test("the second pass makes zero LLM calls when nothing changed", async () => {
  seedTermItems(4, "the CDR pipeline runs nightly");
  await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });

  let calls = 0;
  const counting: ConsolidatorLlm = {
    generateJson: async () => {
      calls += 1;
      return JSON.stringify({ isDomainTerm: true, definition: "d" });
    },
  };
  await runGlossaryPass(db, { ...OPTS, llm: counting, nowMs: 6000 });
  expect(calls).toBe(0);
});

test("the per-pass consolidation cap is honoured", async () => {
  seedTermItems(3, "CDR and SLO and RPO and MTTR and SLA metrics", 0);
  const out = await runGlossaryPass(db, { ...OPTS, maxNewTermsPerPass: 2, llm: definingLlm() });
  expect(out.consolidated).toBeLessThanOrEqual(2);
});

test("a vetoed term is stored vetoed and never projected", async () => {
  seedTermItems(3, "the CDR pipeline runs nightly");
  const vetoing: ConsolidatorLlm = {
    generateJson: async () => JSON.stringify({ isDomainTerm: false, definition: "" }),
  };
  await runGlossaryPass(db, { ...OPTS, llm: vetoing });

  expect(getTerm(db, "cdr")?.status).toBe("vetoed");
  expect(db.query("SELECT * FROM item WHERE type = 'glossary_term'").all().length).toBe(0);
});

test("with no LLM the definition is snippet-sourced", async () => {
  seedTermItems(3, "The CDR is the per-row change envelope.");
  await runGlossaryPass(db, OPTS);
  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("consolidated");
  expect(t?.definitionSource).toBe("snippet");
});

test("the scan skips a non-allowlisted service even when its bare type is allowlisted", async () => {
  // `issue` is allowlisted for linear/jira/github/gitlab. `wiz:issue` is a
  // cloud-security-posture finding: same bare type, out of scope. A bare-type
  // filter would mine it, and its terms would enter the glossary.
  for (let i = 0; i < 3; i++) {
    upsertIndexedItem(db, {
      service: "wiz",
      type: "issue",
      externalId: `w${String(i)}`,
      title: "the CDR bucket is publicly readable",
      bodyPreview: "the CDR bucket is publicly readable",
      modifiedAt: 1000 + i,
      syncedAt: 1000 + i,
    });
  }
  const out = await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });
  expect(out.scanned).toBe(0);
  expect(out.discovered).toBe(0);
  expect(getTerm(db, "cdr")).toBe(null);
});

test("the watermark advances past the scanned items", async () => {
  seedTermItems(3, "the CDR pipeline runs nightly");
  await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });
  expect(readPassState(db).watermarkMs).toBeGreaterThan(0);
});

test("a second pass scans only new items", async () => {
  seedTermItems(3, "the CDR pipeline runs nightly", 0);
  await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });
  const out = await runGlossaryPass(db, { ...OPTS, llm: definingLlm(), nowMs: 6000 });
  expect(out.scanned).toBe(0);
});

test("an empty index yields an empty summary", async () => {
  const out = await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });
  expect(out.discovered).toBe(0);
  expect(out.consolidated).toBe(0);
});

test("rebuildGlossary clears rows, projections and the watermark", async () => {
  seedTermItems(3, "the CDR pipeline runs nightly");
  await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });
  expect(listAllKeys(db).length).toBeGreaterThan(0);

  await rebuildGlossary(db, { ...OPTS, llm: definingLlm(), nowMs: 7000 });
  expect(getTerm(db, "cdr")?.status).toBe("consolidated");
  expect(readPassState(db).watermarkMs).toBeGreaterThan(0);
});

test("a null body preview falls back to empty text rather than the literal 'null'", async () => {
  seedTermItems(3, "the CDR pipeline runs nightly");
  // The most-recently-modified item is examined first for both mining text
  // (discoverPhase) and snippet text (consolidatePhase, since all 3 items
  // fit within TOP_SOURCE_LIMIT) — an item indexed with a title but no body
  // preview (e.g. a bare link share) must not surface the string "null" in
  // either place.
  db.run("UPDATE item SET body_preview = NULL WHERE id = 'slack:m2'");

  await runGlossaryPass(db, OPTS); // no llm => snippet-sourced definition
  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("consolidated");
  expect(t?.definition).not.toBeNull();
  const definition = t?.definition ?? "";
  expect(definition).not.toContain("null");
  expect(definition.toLowerCase()).toContain("cdr");
});

test("items sharing one modified_at value do not each re-trigger the watermark advance", async () => {
  const text = "the CDR pipeline runs nightly";
  for (let i = 0; i < 3; i++) {
    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: `tie${String(i)}`,
      title: text,
      bodyPreview: text,
      modifiedAt: 2000,
      syncedAt: 2000,
    });
  }
  const out = await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });
  expect(out.scanned).toBe(3);
  // The cursor lands on the LAST row of the batch, so the timestamp half is
  // that shared value and the id half identifies which tied row it stopped on.
  const state = readPassState(db);
  expect(state.watermarkMs).toBe(2000);
  expect(state.watermarkId).toBe("slack:tie2");
});

test("a tie group truncated by SCAN_BATCH_LIMIT resumes instead of being skipped", async () => {
  // The batch limit is 5000. Seeding 5001 items that share ONE modified_at —
  // ordinary whenever a connector bulk-imports with a job-level timestamp —
  // truncates the batch strictly inside the tie group. A timestamp-only
  // watermark would advance to that value and the 5001st row, no longer
  // `> watermark`, would never be scanned again.
  const text = "the CDR pipeline runs nightly";
  db.transaction(() => {
    for (let i = 0; i < 5001; i++) {
      upsertIndexedItem(db, {
        service: "slack",
        type: "message",
        externalId: `bulk${String(i).padStart(5, "0")}`,
        title: text,
        bodyPreview: text,
        modifiedAt: 2000,
        syncedAt: 2000,
      });
    }
  })();

  const first = await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });
  expect(first.scanned).toBe(5000);
  expect(readPassState(db).watermarkMs).toBe(2000);

  const second = await runGlossaryPass(db, { ...OPTS, llm: definingLlm(), nowMs: 6000 });
  expect(second.scanned).toBe(1);

  const third = await runGlossaryPass(db, { ...OPTS, llm: definingLlm(), nowMs: 7000 });
  expect(third.scanned).toBe(0);
});

test("a term whose row vanishes mid-consolidation (concurrent rebuild) still counts, unprojected", async () => {
  seedTermItems(3, "the CDR pipeline runs nightly");
  const clearingLlm: ConsolidatorLlm = {
    generateJson: async () => {
      // Simulates a concurrent `rebuildGlossary` wiping the table while this
      // term's LLM call is in flight: by the time `markConsolidated` runs,
      // the row it targets no longer exists.
      clearGlossary(db);
      return JSON.stringify({ isDomainTerm: true, definition: "a definition" });
    },
  };
  const out = await runGlossaryPass(db, { ...OPTS, llm: clearingLlm });

  expect(out.consolidated).toBe(1);
  expect(getTerm(db, "cdr")).toBe(null);
  // projectTerm must have been skipped — no dangling glossary_term item.
  expect(db.query("SELECT * FROM item WHERE type = 'glossary_term'").all().length).toBe(0);
});

test("a pending term whose stored sources were wiped retries instead of fabricating a definition", async () => {
  // Per the comment in glossary-consolidate.ts: a pending term's `topSources`
  // can go empty if its sources are deleted between discovery and
  // consolidation — `reconcilePass` cannot catch this because it only
  // re-verifies `consolidated` rows. Simulate that exact state directly.
  seedTermItems(3, "the CDR pipeline runs nightly");
  const controller = new AbortController();
  controller.abort();
  await runGlossaryPass(db, { ...OPTS, llm: definingLlm(), signal: controller.signal });
  expect(getTerm(db, "cdr")?.status).toBe("pending");

  db.run("UPDATE glossary_term SET top_sources = '[]' WHERE term_key = 'cdr'");

  let calls = 0;
  const countingLlm: ConsolidatorLlm = {
    generateJson: async () => {
      calls += 1;
      return JSON.stringify({ isDomainTerm: true, definition: "should never be reached" });
    },
  };
  const out = await runGlossaryPass(db, { ...OPTS, llm: countingLlm, nowMs: 6000 });

  // `snippetsFor` short-circuits on an empty id list, so consolidateTerm sees
  // zero snippets and retries without ever calling the model.
  expect(calls).toBe(0);
  expect(out.retried).toBe(1);
  expect(getTerm(db, "cdr")?.status).toBe("pending");
});

test("consolidation is atomic — a crash between markConsolidated and projectTerm rolls both back", async () => {
  seedTermItems(3, "the CDR pipeline runs nightly");
  // Simulates a crash exactly in the un-self-healing window: after
  // markConsolidated's UPDATE has already run, but before projectTerm's
  // INSERT into `item` commits. A DB-level trigger fires precisely on that
  // INSERT and raises, so the first write is genuinely applied before the
  // failure — this exercises consolidatePhase's own `db.transaction()`.
  db.run(
    `CREATE TRIGGER simulated_crash_before_project
     BEFORE INSERT ON item
     WHEN NEW.type = 'glossary_term'
     BEGIN SELECT RAISE(ABORT, 'simulated crash before projectTerm'); END`,
  );

  await expect(runGlossaryPass(db, { ...OPTS, llm: definingLlm() })).rejects.toThrow();

  db.run("DROP TRIGGER simulated_crash_before_project");

  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("pending");
  expect(t?.definition).toBe(null);
  expect(db.query("SELECT * FROM item WHERE type = 'glossary_term'").all().length).toBe(0);
});

test("stored near-misses draw from consolidated keys only, not pending or vetoed ones", async () => {
  seedTermItems(3, "the CDR pipeline runs nightly");

  // A consolidated near-miss (edit distance 1 from "cdr") must surface.
  upsertCandidate(db, {
    key: "cdz",
    surface: "CDZ",
    form: "acronym",
    stats: { docFreq: 3, serviceSpread: 1, firstSeenAt: 1, lastSeenAt: 2, topSources: [] },
    score: 1,
    nowMs: 5000,
  });
  markConsolidated(db, {
    termKey: "cdz",
    definition: "d",
    definitionSource: "llm",
    synonyms: [],
    nearMisses: [],
    nowMs: 5000, // matches OPTS.nowMs so the reconcile sweep does not touch it
  });

  // A pending near-miss (edit distance 1 from "cdr") must NOT surface.
  upsertCandidate(db, {
    key: "cdq",
    surface: "CDQ",
    form: "acronym",
    stats: { docFreq: 3, serviceSpread: 1, firstSeenAt: 1, lastSeenAt: 2, topSources: [] },
    score: 1,
    nowMs: 5000,
  });

  await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });

  const t = getTerm(db, "cdr");
  expect(t?.nearMisses).toContain("cdz");
  expect(t?.nearMisses).not.toContain("cdq");
});
