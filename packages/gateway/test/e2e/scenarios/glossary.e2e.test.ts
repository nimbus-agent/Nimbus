import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { emitGlossaryBrief, runGlossary } from "../../../src/agents/glossary.ts";
import { runGlossaryPass } from "../../../src/glossary/glossary-extract.ts";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";

/** There is no `runMigrations` export — this wrapper matches every other test in the repo. */
function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

import { upsertIndexedItem } from "../../../src/index/item-store.ts";

let db: Database;

const PASS = {
  maxNewTermsPerPass: 25,
  statsRecheckPerPass: 50,
  minDocFreq: 3,
  consolidateTimeoutMs: 1000,
  nowMs: 5000,
};

function seedThreads(): void {
  const texts = [
    "We adopted Change Data Record (CDR) for the sync path last quarter.",
    "The CDR envelope carries the before and after row images.",
    "Every CDR is replayed by the backfill job when a shard splits.",
  ];
  texts.forEach((t, i) => {
    upsertIndexedItem(db, {
      service: i === 2 ? "jira" : "slack",
      type: i === 2 ? "issue" : "message",
      externalId: `t${String(i)}`,
      title: t,
      bodyPreview: t,
      modifiedAt: 1000 + i,
      syncedAt: 1000 + i,
    });
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

test("extraction to brief: a term evidenced by 3 threads is defined with dates", async () => {
  seedThreads();
  const llm = {
    generateJson: async () =>
      JSON.stringify({
        isDomainTerm: true,
        definition: "The per-row change envelope used by the sync path.",
      }),
  };
  await runGlossaryPass(db, { ...PASS, llm });

  const brief = await runGlossary(
    { term: "CDR" },
    { db, notify: () => undefined, sessionId: "e2e" },
  );

  expect(brief.mode).toBe("term");
  const entry = brief.entries[0];
  expect(entry).toBeDefined();
  expect(entry?.docFreq).toBeGreaterThanOrEqual(3);
  expect(entry?.serviceSpread).toBeGreaterThanOrEqual(2);
  expect(entry?.firstSeenAt).toBeGreaterThan(0);
  expect(entry?.lastSeenAt).toBeGreaterThanOrEqual(entry?.firstSeenAt ?? 0);
  expect(entry?.topSources.length).toBeGreaterThan(0);
});

test("the no-argument list is frequency ranked", async () => {
  seedThreads();
  const llm = {
    generateJson: async () => JSON.stringify({ isDomainTerm: true, definition: "d" }),
  };
  await runGlossaryPass(db, { ...PASS, llm });

  const brief = await runGlossary({}, { db, notify: () => undefined, sessionId: "e2e" });
  expect(brief.mode).toBe("list");
  expect(brief.entries.length).toBeGreaterThan(0);
});

test("the briefReady notification carries markdown and typed findings", async () => {
  seedThreads();
  const llm = {
    generateJson: async () => JSON.stringify({ isDomainTerm: true, definition: "d" }),
  };
  await runGlossaryPass(db, { ...PASS, llm });

  const seen: Array<{ method: string; params: unknown }> = [];
  await emitGlossaryBrief(
    { term: "CDR" },
    { db, notify: (method, params) => seen.push({ method, params }), sessionId: "e2e" },
  );
  await Bun.sleep(50);

  const ready = seen.find((s) => s.method === "glossary.briefReady");
  expect(ready).toBeDefined();
  const p = ready?.params as { brief?: string; findings?: { kind?: string } };
  expect(typeof p.brief).toBe("string");
  expect(p.brief?.length).toBeGreaterThan(0);
  expect(p.findings?.kind).toBe("glossary");
});

test("zero HITL: the agent source imports no executor and declares no HITL", async () => {
  const src = await Bun.file("packages/gateway/src/agents/glossary.ts").text();
  expect(src).not.toContain("ToolExecutor");
  expect(src).not.toContain("HITL_REQUIRED");
});

test("zero egress: a full pass plus a brief appends no egress_ledger rows", async () => {
  seedThreads();
  const llm = {
    generateJson: async () => JSON.stringify({ isDomainTerm: true, definition: "d" }),
  };
  await runGlossaryPass(db, { ...PASS, llm });
  await runGlossary({ term: "CDR" }, { db, notify: () => undefined, sessionId: "e2e" });

  const rows = db.query("SELECT COUNT(*) AS c FROM egress_ledger").get() as { c: number };
  expect(rows.c).toBe(0);
});

test("an unknown term returns did-you-mean suggestions", async () => {
  seedThreads();
  const llm = {
    generateJson: async () => JSON.stringify({ isDomainTerm: true, definition: "d" }),
  };
  await runGlossaryPass(db, { ...PASS, llm });

  const brief = await runGlossary(
    { term: "CDC" },
    { db, notify: () => undefined, sessionId: "e2e" },
  );
  expect(brief.mode).toBe("miss");
  expect(brief.suggestions).toContain("cdr");
});
