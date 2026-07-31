import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";

/** There is no `runMigrations` export — this wrapper matches every other test in the repo. */
function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

import { dbRun } from "../db/write.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import type { ConsolidatorLlm } from "./glossary-consolidate.ts";
import { rebuildGlossary, runGlossaryPass } from "./glossary-extract.ts";
import { projectTerm } from "./glossary-project.ts";
import {
  clearGlossary,
  getTerm,
  listAllKeys,
  markConsolidated,
  readPassState,
  upsertCandidate,
} from "./glossary-store.ts";
import type { GlossaryPassProgress } from "./glossary-types.ts";

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

/**
 * Disables the phase-A reconcile sweep for the snippet-upgrade tests below.
 *
 * Those tests seed `glossary_term` rows directly via raw SQL rather than
 * through `markConsolidated`/`upsertCandidate`, so `stats_verified_at` is left
 * at its schema default of 0. With `OPTS.statsRecheckCooldownMs` at 0,
 * `reconcilePass` (which runs unconditionally at the top of every
 * `runGlossaryPass` call) would treat every one of those rows as stale,
 * recompute its FTS doc frequency against the throwaway backing item text
 * (which never mentions the synthetic term keys), find 0 < `minDocFreq`, and
 * demote the row back to `pending` with its definition cleared — before
 * `consolidatePhase` (the thing under test) ever runs. `statsRecheckPerPass: 0`
 * makes that sweep select zero rows, so the tests exercise only the
 * allocation logic they name.
 */
const PASS_OPTS = { ...OPTS, statsRecheckPerPass: 0 };

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

// --- snippet upgrades -------------------------------------------------

function llmReturning(json: string): ConsolidatorLlm {
  return {
    generateJson: () => Promise.resolve(json),
  };
}

/**
 * Backs a `top_sources` reference with a real `item` row so `snippetsFor`
 * does not short-circuit `consolidateTerm` into a `retry` for every term.
 * Idempotent (`upsertIndexedItem` upserts), so many terms can share one item.
 */
function seedBackingItem(itemId: string): void {
  const sep = itemId.indexOf(":");
  const service = sep === -1 ? "slack" : itemId.slice(0, sep);
  const externalId = sep === -1 ? itemId : itemId.slice(sep + 1);
  upsertIndexedItem(db, {
    service,
    type: "message",
    externalId,
    title: "t",
    bodyPreview: "t",
    modifiedAt: 2,
    syncedAt: 2,
  });
}

function seedSnippetTerm(key: string, itemId: string, score: number): void {
  seedBackingItem(itemId);
  dbRun(
    db,
    `INSERT INTO glossary_term
       (term_key, display_term, status, definition, definition_source, doc_freq,
        service_spread, score, form, first_seen_at, last_seen_at, top_sources,
        attempts, last_attempt_at, updated_at)
     VALUES (?, ?, 'consolidated', 'old snippet text', 'snippet', 5, 2, ?, 'acronym',
             1, 2, ?, 0, 0, 1)`,
    [
      key,
      key.toUpperCase(),
      score,
      JSON.stringify([{ itemId, title: "t", url: null, service: "slack", modifiedAt: 2 }]),
    ],
  );
}

function seedPendingTerm(key: string, score: number): void {
  seedBackingItem("slack:1");
  dbRun(
    db,
    `INSERT INTO glossary_term
       (term_key, display_term, status, doc_freq, service_spread, score, form,
        first_seen_at, last_seen_at, top_sources, attempts, last_attempt_at, updated_at)
     VALUES (?, ?, 'pending', 5, 2, ?, 'acronym', 1, 2, ?, 0, 0, 1)`,
    [
      key,
      key.toUpperCase(),
      score,
      JSON.stringify([
        { itemId: "slack:1", title: "t", url: null, service: "slack", modifiedAt: 2 },
      ]),
    ],
  );
}

test("does not run upgrades when no LLM is configured", async () => {
  seedSnippetTerm("cdr", "slack:1", 10);
  const summary = await runGlossaryPass(db, { ...PASS_OPTS });
  expect(summary.upgraded).toBe(0);
  const row = db
    .query("SELECT definition_source FROM glossary_term WHERE term_key='cdr'")
    .get() as {
    definition_source: string;
  };
  expect(row.definition_source).toBe("snippet");
});

test("upgrades a snippet definition in place and re-sources it as llm", async () => {
  seedSnippetTerm("cdr", "slack:1", 10);
  const summary = await runGlossaryPass(db, {
    ...PASS_OPTS,
    llm: llmReturning('{"isDomainTerm":true,"definition":"model definition","alsoKnownAs":[]}'),
  });
  expect(summary.upgraded).toBe(1);
  const row = db
    .query("SELECT definition, definition_source FROM glossary_term WHERE term_key='cdr'")
    .get() as { definition: string; definition_source: string };
  expect(row.definition).toBe("model definition");
  expect(row.definition_source).toBe("llm");
});

test("leaves the snippet definition intact when the upgrade fails", async () => {
  seedSnippetTerm("cdr", "slack:1", 10);
  const summary = await runGlossaryPass(db, {
    ...PASS_OPTS,
    llm: { generateJson: () => Promise.resolve("not json") },
  });
  expect(summary.upgraded).toBe(0);
  const row = db
    .query("SELECT definition, definition_source, attempts FROM glossary_term WHERE term_key='cdr'")
    .get() as { definition: string; definition_source: string; attempts: number };
  expect(row.definition).toBe("old snippet text");
  expect(row.definition_source).toBe("snippet");
  expect(row.attempts).toBe(1);
});

test("vetoes an upgraded term, unprojects it, and names it in the summary", async () => {
  seedSnippetTerm("cdr", "slack:1", 10);
  // `seedSnippetTerm` inserts the `glossary_term` row directly via raw SQL and
  // never projects it, so without this the `item` row this test checks for
  // never existed in the first place and the count-goes-to-0 assertion below
  // would pass whether or not `unprojectTerm` actually ran. Projecting it
  // here first makes the assertion mean something: a real, user-visible
  // "glossary:cdr" search hit that the veto must remove.
  const seeded = getTerm(db, "cdr");
  if (seeded === null) throw new Error("seedSnippetTerm did not create the row");
  projectTerm(db, seeded, 1);
  const before = db
    .query("SELECT COUNT(*) AS n FROM item WHERE external_id = 'glossary:cdr'")
    .get() as { n: number };
  expect(before.n).toBe(1);

  const summary = await runGlossaryPass(db, {
    ...PASS_OPTS,
    llm: llmReturning('{"isDomainTerm":false,"definition":"","alsoKnownAs":[]}'),
  });
  expect(summary.upgradesVetoed).toBe(1);
  expect(summary.vetoedTerms).toEqual(["cdr"]);
  const status = db.query("SELECT status FROM glossary_term WHERE term_key='cdr'").get() as {
    status: string;
  };
  expect(status.status).toBe("vetoed");
  const after = db
    .query("SELECT COUNT(*) AS n FROM item WHERE external_id = 'glossary:cdr'")
    .get() as { n: number };
  expect(after.n).toBe(0);
});

// Budget allocation corners. UPGRADE_RESERVE is a FLOOR, not a ceiling, and
// neither queue may leave budget idle while the other has work. Assert BOTH
// numbers in every case: `upgraded` alone passes under several wrong
// allocations.
test("reserves upgrade slots when the pending queue exceeds the budget", async () => {
  for (let i = 0; i < 30; i++) seedPendingTerm(`pending${String(i)}`, 100 - i);
  for (let i = 0; i < 8; i++) seedSnippetTerm(`snip${String(i)}`, "slack:1", 5);
  const summary = await runGlossaryPass(db, {
    ...PASS_OPTS,
    maxNewTermsPerPass: 25,
    llm: llmReturning('{"isDomainTerm":true,"definition":"d","alsoKnownAs":[]}'),
  });
  expect(summary.consolidated).toBe(20);
  expect(summary.upgraded).toBe(5);
});

test("gives pending the whole budget when no upgrades are outstanding", async () => {
  for (let i = 0; i < 30; i++) seedPendingTerm(`pending${String(i)}`, 100 - i);
  const summary = await runGlossaryPass(db, {
    ...PASS_OPTS,
    maxNewTermsPerPass: 25,
    llm: llmReturning('{"isDomainTerm":true,"definition":"d","alsoKnownAs":[]}'),
  });
  expect(summary.consolidated).toBe(25);
  expect(summary.upgraded).toBe(0);
});

// The reserve must not become a CEILING: with nothing pending, upgrades take
// the whole budget rather than stopping at 5 and idling 20 slots.
test("gives upgrades the whole budget when nothing is pending", async () => {
  for (let i = 0; i < 40; i++) seedSnippetTerm(`snip${String(i)}`, "slack:1", 100 - i);
  const summary = await runGlossaryPass(db, {
    ...PASS_OPTS,
    maxNewTermsPerPass: 25,
    llm: llmReturning('{"isDomainTerm":true,"definition":"d","alsoKnownAs":[]}'),
  });
  expect(summary.consolidated).toBe(0);
  expect(summary.upgraded).toBe(25);
});

test("lets upgrades absorb the slack of a partially-filled pending queue", async () => {
  for (let i = 0; i < 3; i++) seedPendingTerm(`pending${String(i)}`, 100 - i);
  for (let i = 0; i < 40; i++) seedSnippetTerm(`snip${String(i)}`, "slack:1", 50 - i);
  const summary = await runGlossaryPass(db, {
    ...PASS_OPTS,
    maxNewTermsPerPass: 25,
    llm: llmReturning('{"isDomainTerm":true,"definition":"d","alsoKnownAs":[]}'),
  });
  expect(summary.consolidated).toBe(3);
  expect(summary.upgraded).toBe(22);
});

// Completeness corner: both queues non-empty but together under budget —
// nothing should be left behind or arbitrarily truncated.
test("processes both queues fully when their combined size is under budget", async () => {
  for (let i = 0; i < 3; i++) seedPendingTerm(`pending${String(i)}`, 100 - i);
  for (let i = 0; i < 4; i++) seedSnippetTerm(`snip${String(i)}`, "slack:1", 50 - i);
  const summary = await runGlossaryPass(db, {
    ...PASS_OPTS,
    maxNewTermsPerPass: 25,
    llm: llmReturning('{"isDomainTerm":true,"definition":"d","alsoKnownAs":[]}'),
  });
  expect(summary.consolidated).toBe(3);
  expect(summary.upgraded).toBe(4);
});

// `UPGRADE_RESERVE` (5) clamps to half the budget at small budgets so it can
// never starve pending outright: at budget 4 a naive `min(5, 4)` reserve
// would hand upgrades the ENTIRE budget. Half-budget clamping keeps both
// queues represented even when the configured pass is tiny (a real setting —
// `max_new_terms_per_pass` is how a laptop-class local LLM is throttled).
test("halves the reserve at a small budget instead of letting it consume the whole pass", async () => {
  for (let i = 0; i < 10; i++) seedPendingTerm(`pending${String(i)}`, 100 - i);
  for (let i = 0; i < 10; i++) seedSnippetTerm(`snip${String(i)}`, "slack:1", 50 - i);
  const summary = await runGlossaryPass(db, {
    ...PASS_OPTS,
    maxNewTermsPerPass: 4,
    llm: llmReturning('{"isDomainTerm":true,"definition":"d","alsoKnownAs":[]}'),
  });
  expect(summary.consolidated).toBe(2);
  expect(summary.upgraded).toBe(2);
});

// Pins VETOED_TERMS_REPORTED (10) and proves `upgradesVetoed` and
// `vetoedTerms.length` are independent counters — nothing distinguishes the
// cap from an unconditional push, or from a much larger cap, without this.
test("caps the reported vetoed-term names while still counting every veto", async () => {
  for (let i = 0; i < 12; i++) seedSnippetTerm(`snip${String(i)}`, "slack:1", 100 - i);
  const summary = await runGlossaryPass(db, {
    ...PASS_OPTS,
    maxNewTermsPerPass: 25,
    llm: llmReturning('{"isDomainTerm":false,"definition":"","alsoKnownAs":[]}'),
  });
  expect(summary.upgradesVetoed).toBe(12);
  expect(summary.vetoedTerms.length).toBe(10);
});

test("onProgress reports per-term counts across both queues and finishes done === total", async () => {
  for (let i = 0; i < 3; i++) seedPendingTerm(`pending${String(i)}`, 100 - i);
  for (let i = 0; i < 4; i++) seedSnippetTerm(`snip${String(i)}`, "slack:1", 50 - i);
  const events: GlossaryPassProgress[] = [];
  await runGlossaryPass(db, {
    ...PASS_OPTS,
    maxNewTermsPerPass: 25,
    llm: llmReturning('{"isDomainTerm":true,"definition":"d","alsoKnownAs":[]}'),
    onProgress: (p) => events.push(p),
  });
  // 3 pending + 4 upgrades = 7 units of work — `total` must count BOTH
  // queues, not just the one `onProgress` happened to have been introduced
  // alongside. A regression back to `total: batch.length` (pending only)
  // would report `total: 3` instead.
  expect(events.length).toBe(7);
  expect(events.at(-1)).toEqual({
    done: 7,
    total: 7,
    consolidated: 3,
    upgraded: 4,
    vetoed: 0,
    retried: 0,
  });
});

test("reports llmConfigured and llmProduced separately", async () => {
  seedPendingTerm("cdr", 10);
  const none = await runGlossaryPass(db, { ...PASS_OPTS });
  expect(none.llmConfigured).toBe(false);
  expect(none.llmProduced).toBe(false);

  const dead = await runGlossaryPass(db, {
    ...PASS_OPTS,
    llm: { generateJson: () => Promise.resolve(null) },
  });
  expect(dead.llmConfigured).toBe(true);
  expect(dead.llmProduced).toBe(false);
});
