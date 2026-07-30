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
import { getTerm, listAllKeys, readPassState } from "./glossary-store.ts";

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
