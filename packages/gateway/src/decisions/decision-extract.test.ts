import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { rebuildDecisions, runDecisionPass } from "./decision-extract.ts";
import type { DecisionLlm } from "./decision-llm-adapter.ts";
import { countByStatus, listDecisions, readPassState } from "./decision-store.ts";

let db: Database;

function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

function seed(
  id: string,
  service: string,
  type: string,
  title: string,
  body: string,
  at: number,
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [id, service, type, id, title, body, at, at],
  );
}

const OPTS = {
  nowMs: 10_000,
  useLlm: true,
  maxLlmCalls: 25,
  minConfidence: 0,
  retryCooldownMs: 1_000,
};

function scriptedLlm(replies: Record<string, string>, fallback: string): DecisionLlm {
  return {
    complete: async (prompt: string) => {
      for (const [needle, reply] of Object.entries(replies)) {
        if (prompt.includes(needle)) return reply;
      }
      return fallback;
    },
  };
}

test("discovers a cue, extracts it, and stores statement and rationale", async () => {
  seed("s1", "slack", "message", "thread", "We decided to move billing to Postgres.", 5_000);
  const llm = scriptedLlm(
    {
      billing:
        '{"is_decision":true,"statement":"Move billing to Postgres","rationale":"pool exhaustion","alternatives":["MySQL"]}',
    },
    '{"is_decision":false}',
  );
  const summary = await runDecisionPass(db, { ...OPTS, llm });
  expect(summary.discovered).toBe(1);
  expect(summary.extracted).toBe(1);
  const [row] = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 });
  expect(row?.statement).toBe("Move billing to Postgres");
  expect(row?.rationale).toBe("pool exhaustion");
});

test("a vetoed candidate is not re-asked on a second pass", async () => {
  seed("s1", "slack", "message", "thread", "We decided to grab lunch at noon.", 5_000);
  let calls = 0;
  const llm: DecisionLlm = {
    complete: async () => {
      calls++;
      return '{"is_decision":false}';
    },
  };
  await runDecisionPass(db, { ...OPTS, llm });
  expect(calls).toBe(1);
  expect(countByStatus(db).vetoed).toBe(1);

  await runDecisionPass(db, { ...OPTS, nowMs: 20_000, llm });
  expect(calls).toBe(1);
});

test("the watermark advances even when extraction fails", async () => {
  seed("s1", "slack", "message", "thread", "We decided to ship it.", 5_000);
  const llm: DecisionLlm = { complete: async () => "unparseable" };
  await runDecisionPass(db, { ...OPTS, llm });
  expect(readPassState(db).watermarkMs).toBe(5_000);
  expect(countByStatus(db).pending).toBe(1); // stays pending, retries later
});

test("with no LLM the pass still produces snippet-sourced rows", async () => {
  seed("s1", "slack", "message", "thread", "We decided to move billing to Postgres.", 5_000);
  const summary = await runDecisionPass(db, { ...OPTS, useLlm: false });
  expect(summary.extracted).toBe(1);
  const [row] = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 });
  expect(row?.extractionSource).toBe("snippet");
});

test("a later pass with an LLM upgrades a snippet row to llm-sourced", async () => {
  seed("s1", "slack", "message", "thread", "We decided to move billing to Postgres.", 5_000);
  await runDecisionPass(db, { ...OPTS, useLlm: false });

  const llm = scriptedLlm(
    { billing: '{"is_decision":true,"statement":"Move billing to Postgres","rationale":"pool"}' },
    '{"is_decision":false}',
  );
  const summary = await runDecisionPass(db, { ...OPTS, nowMs: 20_000, llm });
  expect(summary.upgraded).toBe(1);
  const [row] = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 });
  expect(row?.extractionSource).toBe("llm");
});

// The review's point 3: weak cues must not consume the whole budget.
test("a heading candidate is extracted before a pool of weak ones", async () => {
  for (let i = 0; i < 5; i++) {
    seed(`w${i}`, "slack", "message", "t", `We'll use option ${i} for this.`, 1_000 + i);
  }
  seed("h1", "confluence", "page", "RFC", "Decision: adopt Postgres for billing.", 900);

  const seen: string[] = [];
  const llm: DecisionLlm = {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return '{"is_decision":true,"statement":"x"}';
    },
  };
  await runDecisionPass(db, { ...OPTS, maxLlmCalls: 1, llm });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain("adopt Postgres");
});

// The review's point 4.1: upgrades get a reserve, not leftovers.
test("a snippet upgrade still happens when new candidates would fill the budget", async () => {
  seed("s1", "slack", "message", "t", "We decided to move billing to Postgres.", 5_000);
  await runDecisionPass(db, { ...OPTS, useLlm: false });

  for (let i = 0; i < 20; i++) {
    seed(`n${i}`, "slack", "message", "t", `We decided on thing ${i}.`, 6_000 + i);
  }
  const llm: DecisionLlm = {
    complete: async () => '{"is_decision":true,"statement":"x"}',
  };
  const summary = await runDecisionPass(db, { ...OPTS, nowMs: 20_000, maxLlmCalls: 5, llm });
  expect(summary.upgraded).toBeGreaterThan(0);
});

test("rebuildDecisions clears vetoes so a candidate is re-evaluated", async () => {
  seed("s1", "slack", "message", "t", "We decided to grab lunch.", 5_000);
  await runDecisionPass(db, { ...OPTS, llm: scriptedLlm({}, '{"is_decision":false}') });
  expect(countByStatus(db).vetoed).toBe(1);

  const llm = scriptedLlm({}, '{"is_decision":true,"statement":"Lunch at noon"}');
  await rebuildDecisions(db, { ...OPTS, nowMs: 30_000, llm });
  expect(countByStatus(db).vetoed).toBe(0);
  expect(countByStatus(db).extracted).toBe(1);
});

test("items outside the source allowlist are never scanned", async () => {
  seed("w1", "wiz", "issue", "finding", "We decided to accept this risk.", 5_000);
  const summary = await runDecisionPass(db, { ...OPTS, useLlm: false });
  expect(summary.discovered).toBe(0);
});

// Fix-round-1 regression pair, mirroring glossary's
// "gives upgrades the whole budget when nothing is pending" /
// "gives pending the whole budget when no upgrades are outstanding".

test("maxLlmCalls: 1 with only an upgrade candidate outstanding still performs the upgrade", async () => {
  seed("s1", "slack", "message", "t", "We decided to move billing to Postgres.", 5_000);
  await runDecisionPass(db, { ...OPTS, useLlm: false });

  const llm = scriptedLlm(
    { billing: '{"is_decision":true,"statement":"Move billing to Postgres"}' },
    '{"is_decision":false}',
  );
  const summary = await runDecisionPass(db, { ...OPTS, nowMs: 20_000, maxLlmCalls: 1, llm });
  expect(summary.upgraded).toBe(1);
});

test("maxLlmCalls: 5 with 20 pending and 1 upgrade candidate makes exactly 5 LLM calls", async () => {
  seed("s1", "slack", "message", "t", "We decided to move billing to Postgres.", 5_000);
  await runDecisionPass(db, { ...OPTS, useLlm: false });

  for (let i = 0; i < 20; i++) {
    seed(`n${i}`, "slack", "message", "t", `We decided on thing ${i}.`, 6_000 + i);
  }
  let calls = 0;
  const llm: DecisionLlm = {
    complete: async () => {
      calls++;
      return '{"is_decision":true,"statement":"x"}';
    },
  };
  await runDecisionPass(db, { ...OPTS, nowMs: 20_000, maxLlmCalls: 5, llm });
  expect(calls).toBe(5); // not 2 — no slot goes idle
});

test("maxLlmCalls: 5 with pending candidates and no upgrades sends all 5 slots to pending", async () => {
  for (let i = 0; i < 6; i++) {
    seed(`p${i}`, "slack", "message", "t", `We decided on thing ${i}.`, 1_000 + i);
  }
  let calls = 0;
  const llm: DecisionLlm = {
    complete: async () => {
      calls++;
      return '{"is_decision":true,"statement":"x"}';
    },
  };
  const summary = await runDecisionPass(db, { ...OPTS, maxLlmCalls: 5, llm });
  expect(calls).toBe(5);
  expect(summary.upgraded).toBe(0);
});

test("maxLlmCalls: 0 makes no LLM call and still returns a well-formed summary", async () => {
  seed("s1", "slack", "message", "t", "We decided to ship it.", 5_000);
  let calls = 0;
  const llm: DecisionLlm = {
    complete: async () => {
      calls++;
      return '{"is_decision":true,"statement":"x"}';
    },
  };
  const summary = await runDecisionPass(db, { ...OPTS, maxLlmCalls: 0, llm });
  expect(calls).toBe(0);
  expect(summary).toEqual({
    scanned: 1,
    discovered: 1,
    extracted: 0,
    vetoed: 0,
    upgraded: 0,
    failed: 0,
    noModel: 0,
  });
});

// The whole point of this fix: `[decisions].use_llm = true` with no model
// available at call time must NOT be treated as failure or veto — it falls
// back to the snippet path, same as `useLlm: false`, and is picked up again
// by the upgrade reserve once a real model answers.
test("a pass with an LLM that has no model available produces snippet rows, not failures or vetoes", async () => {
  seed("s1", "slack", "message", "t", "We decided to move billing to Postgres.", 5_000);
  const noModelLlm: DecisionLlm = { complete: async () => null };
  const summary = await runDecisionPass(db, { ...OPTS, llm: noModelLlm });
  expect(summary.extracted).toBe(1);
  expect(summary.noModel).toBe(1);
  expect(summary.failed).toBe(0);
  expect(summary.vetoed).toBe(0);
  expect(countByStatus(db).vetoed).toBe(0);
  expect(countByStatus(db).pending).toBe(0);
  const [row] = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 });
  expect(row?.extractionSource).toBe("snippet");
});

test("a later pass with a working LLM upgrades rows that previously had no model available", async () => {
  seed("s1", "slack", "message", "t", "We decided to move billing to Postgres.", 5_000);
  const noModelLlm: DecisionLlm = { complete: async () => null };
  await runDecisionPass(db, { ...OPTS, llm: noModelLlm });

  const llm = scriptedLlm(
    { billing: '{"is_decision":true,"statement":"Move billing to Postgres","rationale":"pool"}' },
    '{"is_decision":false}',
  );
  const summary = await runDecisionPass(db, { ...OPTS, nowMs: 20_000, llm });
  expect(summary.upgraded).toBe(1);
  const [row] = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 });
  expect(row?.extractionSource).toBe("llm");
});
