import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

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
  // Required. Omitting it makes the reconcile cutoff NaN, which silently
  // matches nothing — the sweep becomes a no-op and the test still passes.
  statsRecheckCooldownMs: 0,
  minDocFreq: 3,
  consolidateTimeoutMs: 1000,
  // Required. Omitting it makes the backoff window NaN.
  retryBaseCooldownMs: 1000,
  nowMs: 5000,
};

/** Narrows the `glossary.briefReady` payload instead of casting it into shape. */
function isBriefReadyParams(v: unknown): v is { brief: string; findings: { kind: string } } {
  if (v === null || typeof v !== "object") return false;
  const o = v as { brief?: unknown; findings?: unknown };
  if (typeof o.brief !== "string") return false;
  if (o.findings === null || typeof o.findings !== "object") return false;
  return typeof (o.findings as { kind?: unknown }).kind === "string";
}

/** Narrows a `COUNT(*)` row from SQLite before the count is read. */
function countOf(v: unknown): number {
  if (v === null || typeof v !== "object") throw new Error("expected a count row");
  const c = (v as { c?: unknown }).c;
  if (typeof c !== "number") throw new Error("expected a numeric count");
  return c;
}

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
  // A second term evidenced by strictly fewer threads than CDR (3 vs 5), so a
  // non-empty assertion alone cannot pass an unsorted result.
  [
    "Every SLO breach pages the on-call.",
    "The SLO dashboard is stale.",
    "SLO review Friday.",
  ].forEach((t, i) => {
    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: `slo${String(i)}`,
      title: t,
      bodyPreview: t,
      modifiedAt: 2000 + i,
      syncedAt: 2000 + i,
    });
  });
  ["The CDR schema changed.", "CDR replay finished."].forEach((t, i) => {
    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: `extra${String(i)}`,
      title: t,
      bodyPreview: t,
      modifiedAt: 3000 + i,
      syncedAt: 3000 + i,
    });
  });
  const llm = {
    generateJson: async () => JSON.stringify({ isDomainTerm: true, definition: "d" }),
  };
  await runGlossaryPass(db, { ...PASS, llm });

  const brief = await runGlossary({}, { db, notify: () => undefined, sessionId: "e2e" });
  expect(brief.mode).toBe("list");
  expect(brief.entries.length).toBeGreaterThan(1);

  const ranks = brief.entries.map((e) => e.term.toLowerCase());
  expect(ranks).toContain("cdr");
  expect(ranks).toContain("slo");
  // CDR wins on BOTH inputs to the score — more citing documents (5 vs 3) and a
  // wider service spread (slack+jira vs slack) — so its position is unambiguous.
  // The list is score-ranked rather than docFreq-ranked, so asserting a globally
  // descending docFreq sequence would be asserting something the code does not
  // promise.
  const cdr = brief.entries[ranks.indexOf("cdr")];
  const slo = brief.entries[ranks.indexOf("slo")];
  expect(cdr?.docFreq).toBeGreaterThan(slo?.docFreq ?? 0);
  expect(ranks.indexOf("cdr")).toBeLessThan(ranks.indexOf("slo"));
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
  // The notification payload crosses the IPC boundary, so it is narrowed from
  // `unknown` rather than asserted into shape with a cast.
  const params: unknown = ready?.params;
  expect(isBriefReadyParams(params)).toBe(true);
  if (!isBriefReadyParams(params)) return;
  expect(params.brief.length).toBeGreaterThan(0);
  expect(params.findings.kind).toBe("glossary");
});

test("zero HITL: the agent source imports no executor and declares no HITL", async () => {
  // Anchored to this file, not the CWD — the sibling expert.e2e.test.ts does the
  // same. A CWD-relative read resolves locally but throws on CI, where the runner
  // starts from a different directory.
  const src = readFileSync(
    path.join(__dirname, "..", "..", "..", "src", "agents", "glossary.ts"),
    "utf8",
  );
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

  const row: unknown = db.query("SELECT COUNT(*) AS c FROM egress_ledger").get();
  expect(countOf(row)).toBe(0);
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
