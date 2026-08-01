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
import { runGlossaryPass } from "./glossary-extract.ts";
import { getTerm, readPassState, selectPendingBatch } from "./glossary-store.ts";

let db: Database;

const BASE = {
  maxNewTermsPerPass: 25,
  statsRecheckPerPass: 50,
  statsRecheckCooldownMs: 0,
  minDocFreq: 3,
  consolidateTimeoutMs: 1000,
  retryBaseCooldownMs: 1000,
  nowMs: 5000,
};

/** Far-future `nowMs` so assertions see every pending row regardless of backoff. */
const QUEUE = { nowMs: 9_000_000, retryBaseCooldownMs: 1000, minDocFreq: 0 };

function seed(text: string, count = 3, startId = 0): void {
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

test("aborting phase B holds the watermark and leaves candidates pending", async () => {
  seed("CDR and SLO and RPO metrics");
  const controller = new AbortController();
  const llm: ConsolidatorLlm = {
    generateJson: async () => {
      controller.abort();
      return JSON.stringify({ isDomainTerm: true, definition: "d" });
    },
  };

  const out = await runGlossaryPass(db, { ...BASE, llm, signal: controller.signal });

  expect(out.aborted).toBe(true);
  // Phase A committed before any LLM call, so the scan is not repeated.
  expect(readPassState(db).watermarkMs).toBeGreaterThan(0);
  expect(selectPendingBatch(db, 10, QUEUE).length).toBeGreaterThan(0);
});

test("the next pass completes candidates stranded by an abort", async () => {
  seed("CDR and SLO and RPO metrics");
  const controller = new AbortController();
  const abortingLlm: ConsolidatorLlm = {
    generateJson: async () => {
      controller.abort();
      return JSON.stringify({ isDomainTerm: true, definition: "d" });
    },
  };
  await runGlossaryPass(db, { ...BASE, llm: abortingLlm, signal: controller.signal });

  const goodLlm: ConsolidatorLlm = {
    generateJson: async () => JSON.stringify({ isDomainTerm: true, definition: "later" }),
  };
  await runGlossaryPass(db, { ...BASE, llm: goodLlm, nowMs: 6000 });

  expect(selectPendingBatch(db, 10, QUEUE)).toHaveLength(0);
});

test("a candidate stranded by the cap is reached by a later pass", async () => {
  seed("CDR and SLO and RPO and MTTR metrics");
  const llm: ConsolidatorLlm = {
    generateJson: async () => JSON.stringify({ isDomainTerm: true, definition: "d" }),
  };
  await runGlossaryPass(db, { ...BASE, maxNewTermsPerPass: 1, llm });
  const afterFirst = selectPendingBatch(db, 10, QUEUE).length;
  expect(afterFirst).toBeGreaterThan(0);

  // No new items — the batch must still be selected globally, not from this
  // pass's (empty) discoveries.
  await runGlossaryPass(db, { ...BASE, maxNewTermsPerPass: 10, llm, nowMs: 6000 });
  expect(selectPendingBatch(db, 10, QUEUE)).toHaveLength(0);
});

test("a retry outcome leaves the term pending rather than vetoed", async () => {
  seed("the CDR pipeline runs nightly");
  const badLlm: ConsolidatorLlm = { generateJson: async () => "not json" };
  await runGlossaryPass(db, { ...BASE, llm: badLlm });
  expect(getTerm(db, "cdr")?.status).toBe("pending");
});

test("a persistently failing high-score term does not starve lower-score terms", async () => {
  // `zzz` is seeded far more often, so it outranks `cdr` and is selected
  // first — and it ALWAYS fails. Without the retry backoff it would occupy
  // the single consolidation slot on every pass forever and `cdr` would never
  // be defined. This is the head-of-line-blocking regression test.
  seed("ZZZ metric review", 8, 0);
  seed("the CDR pipeline runs nightly", 3, 100);

  const llm: ConsolidatorLlm = {
    generateJson: async (prompt: string) =>
      prompt.includes("ZZZ")
        ? "not json"
        : JSON.stringify({ isDomainTerm: true, definition: "defined" }),
  };

  await runGlossaryPass(db, { ...BASE, maxNewTermsPerPass: 1, llm, nowMs: 5000 });
  expect(getTerm(db, "zzz")?.status).toBe("pending");

  // Second pass, still inside zzz's backoff window: cdr must get the slot.
  await runGlossaryPass(db, { ...BASE, maxNewTermsPerPass: 1, llm, nowMs: 5500 });
  expect(getTerm(db, "cdr")?.status).toBe("consolidated");
});

test("a failed term records an attempt and is withheld while backing off", async () => {
  seed("the CDR pipeline runs nightly");
  const badLlm: ConsolidatorLlm = { generateJson: async () => "not json" };
  await runGlossaryPass(db, { ...BASE, llm: badLlm, nowMs: 5000 });

  const out = await runGlossaryPass(db, { ...BASE, llm: badLlm, nowMs: 5100 });
  expect(out.retried).toBe(0); // still cooling down — not re-attempted
});

test("a signal aborted before the call starts skips phase B entirely, before any LLM call", async () => {
  seed("CDR and SLO and RPO metrics");
  const controller = new AbortController();
  controller.abort(); // already aborted — distinct from aborting mid phase-B
  let calls = 0;
  const llm: ConsolidatorLlm = {
    generateJson: async () => {
      calls += 1;
      return JSON.stringify({ isDomainTerm: true, definition: "d" });
    },
  };

  const out = await runGlossaryPass(db, { ...BASE, llm, signal: controller.signal });

  expect(out.aborted).toBe(true);
  expect(out.consolidated).toBe(0);
  expect(out.vetoed).toBe(0);
  expect(out.retried).toBe(0);
  // Proves consolidatePhase never started, not merely that it did nothing.
  expect(calls).toBe(0);
  // Phase A (pure SQL) still ran and left work for the next pass.
  expect(out.discovered).toBeGreaterThan(0);
  expect(selectPendingBatch(db, 10, QUEUE).length).toBeGreaterThan(0);
});
