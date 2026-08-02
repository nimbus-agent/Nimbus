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

// `use_llm = false` reported `0 no model`, so `--refresh` printed
// "12 extracted, 0 upgraded, 0 no model" — the exact reading (`the LLM ran`)
// the counter exists to prevent. Every row on this branch IS a no-model
// extraction.
test("use_llm = false counts every row as noModel, not just extracted", async () => {
  for (let i = 0; i < 3; i++) {
    seed(`s${i}`, "slack", "message", "t", `We decided on thing ${i}.`, 5_000 + i);
  }
  const summary = await runDecisionPass(db, { ...OPTS, useLlm: false });
  expect(summary.extracted).toBe(3);
  expect(summary.noModel).toBe(3);
  expect(summary.upgraded).toBe(0);
  expect(summary.failed).toBe(0);
});

// The LLM branch normalises `maxLlmCalls` before it becomes a SQL LIMIT; the
// snippet branch passed it raw, so a non-finite value reached `LIMIT ?`.
test("use_llm = false normalises a non-finite maxLlmCalls instead of passing it to SQL", async () => {
  seed("s1", "slack", "message", "t", "We decided on a thing.", 5_000);
  const summary = await runDecisionPass(db, {
    ...OPTS,
    useLlm: false,
    maxLlmCalls: Number.POSITIVE_INFINITY,
  });
  expect(summary.extracted).toBe(0);
  expect(summary.noModel).toBe(0);
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
    discoveryComplete: true,
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

// Most connectors leave `body_preview` NULL for short items; the title alone
// still carries a heading cue, and both the scan text and the re-mined sentence
// have to tolerate the missing body rather than stringify it as "null".
test("an item with no body_preview is scanned and extracted from its title alone", async () => {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 0)`,
    ["s1", "confluence", "page", "s1", "Decision: adopt Postgres for billing", 5_000, 5_000],
  );
  const summary = await runDecisionPass(db, { ...OPTS, useLlm: false });
  expect(summary.discovered).toBe(1);
  const [row] = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 });
  expect(row?.statement).toBe("Decision: adopt Postgres for billing.");
});

// A decision outlives its source item — only `--rebuild` clears stored rows, so
// a re-sync that drops the item leaves the record behind. Re-mining then finds
// nothing, and the stored cue is the last thing left to say.
test("a candidate whose source item vanished falls back to the stored cue text", async () => {
  seed("s1", "slack", "message", "t", "We decided to move billing to Postgres.", 5_000);
  // Discover the candidate without spending budget on extraction.
  await runDecisionPass(db, { ...OPTS, useLlm: false, maxLlmCalls: 0 });
  expect(countByStatus(db).pending).toBe(1);
  db.run("DELETE FROM item WHERE id = ?", ["s1"]);

  const summary = await runDecisionPass(db, { ...OPTS, nowMs: 20_000, useLlm: false });
  expect(summary.extracted).toBe(1);
  const [row] = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 });
  expect(row?.statement).toBe("We decided");
  // Confidence still scores, with the source authority degraded to unknown
  // (0.25*0.6 cue + 0.2*0.3 authority) rather than throwing on the missing row.
  expect(row?.confidence).toBeCloseTo(0.21, 5);
});

// `sentenceFor` re-mines the whole item and picks the hit whose content-derived
// id matches THIS row. Taking the first hit instead would give every candidate
// in a multi-decision thread the same statement.
test("each candidate re-mines its own sentence, not the first cue in the item", async () => {
  seed(
    "s1",
    "slack",
    "message",
    "t",
    "We decided to move billing to Postgres. We decided to keep Redis for sessions.",
    5_000,
  );
  const summary = await runDecisionPass(db, { ...OPTS, useLlm: false });
  expect(summary.discovered).toBe(2);
  const statements = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 })
    .map((r) => r.statement)
    .sort();
  expect(statements).toEqual([
    "We decided to keep Redis for sessions.",
    "We decided to move billing to Postgres.",
  ]);
});

// The three non-upgrade outcomes of the UPGRADE queue. Each has its own
// counter convention, and only one of them may move `upgraded`.

test("an upgrade attempt with no model available counts noModel only, never upgraded", async () => {
  seed("s1", "slack", "message", "t", "We decided to move billing to Postgres.", 5_000);
  await runDecisionPass(db, { ...OPTS, useLlm: false });

  const summary = await runDecisionPass(db, {
    ...OPTS,
    nowMs: 20_000,
    llm: { complete: async () => null },
  });
  expect(summary.upgraded).toBe(0); // the row is still snippet-sourced — not a real upgrade
  expect(summary.noModel).toBe(1);
  expect(summary.extracted).toBe(0); // the pending queue was empty; this was upgrade work
  expect(summary.failed).toBe(0);
  const [row] = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 });
  expect(row?.extractionSource).toBe("snippet");
});

test("a model that rejects a snippet row on upgrade vetoes it and drops it from the list", async () => {
  seed("s1", "slack", "message", "t", "We decided to grab lunch at noon.", 5_000);
  await runDecisionPass(db, { ...OPTS, useLlm: false });
  expect(listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 })).toHaveLength(1);

  const summary = await runDecisionPass(db, {
    ...OPTS,
    nowMs: 20_000,
    llm: scriptedLlm({}, '{"is_decision":false}'),
  });
  expect(summary.vetoed).toBe(1);
  expect(summary.upgraded).toBe(0);
  expect(countByStatus(db).vetoed).toBe(1);
  expect(listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 })).toHaveLength(0);
});

test("unparseable model output on upgrade counts as failed and keeps the snippet row", async () => {
  seed("s1", "slack", "message", "t", "We decided to move billing to Postgres.", 5_000);
  await runDecisionPass(db, { ...OPTS, useLlm: false });

  const summary = await runDecisionPass(db, {
    ...OPTS,
    nowMs: 20_000,
    llm: { complete: async () => "not json at all" },
  });
  expect(summary.failed).toBe(1);
  expect(summary.upgraded).toBe(0);
  expect(summary.vetoed).toBe(0);
  // Garbage output is retryable, not a rejection: the row keeps its snippet
  // statement and stays eligible for a later upgrade.
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

// Regression: `writePassState` lived INSIDE the non-empty-delta branch, so a
// pass over an unchanged (or empty) index recorded nothing. `agents/decisions.ts`
// reads `lastPassAt` for its "the extraction pass has not run yet" gap note, so
// a user who ran `nimbus decisions --refresh` successfully was then advised to
// run `nimbus decisions --refresh`.
test("a pass over an EMPTY index still records last_pass_at", async () => {
  const summary = await runDecisionPass(db, { ...OPTS, useLlm: false });
  expect(summary.scanned).toBe(0);
  expect(summary.discovered).toBe(0);
  expect(readPassState(db).lastPassAt).toBe(OPTS.nowMs);
});

test("a pass over an UNCHANGED index records last_pass_at without moving the watermark", async () => {
  seed("s1", "slack", "message", "t", "We decided to move billing to Postgres.", 5_000);
  await runDecisionPass(db, { ...OPTS, useLlm: false });
  const first = readPassState(db);
  expect(first.watermarkMs).toBe(5_000);
  expect(first.scannedItems).toBe(1);

  // Second pass: same index, nothing new to scan.
  const summary = await runDecisionPass(db, { ...OPTS, nowMs: 20_000, useLlm: false });
  expect(summary.scanned).toBe(0);

  const second = readPassState(db);
  expect(second.lastPassAt).toBe(20_000);
  // The watermark and the running scanned total must NOT move on an empty
  // delta — a pass that read nothing has not read past anything.
  expect(second.watermarkMs).toBe(first.watermarkMs);
  expect(second.watermarkId).toBe(first.watermarkId);
  expect(second.scannedItems).toBe(first.scannedItems);
  expect(second.lastPassNew).toBe(0);
});

// Regression: `discoverPhase` called `scanDelta` ONCE, capped at
// SCAN_BATCH_LIMIT. `rebuildDecisions` clears the watermark and runs a single
// pass, so an index with more than one batch of source items had only its
// oldest batch rebuilt — and the summary reported success. Discovery drains now.
test("discovery drains past a single batch instead of truncating", async () => {
  for (let i = 0; i < 7; i++) {
    seed(`s${i}`, "slack", "message", "t", `We decided on thing ${String(i)}.`, 5_000 + i);
  }
  const summary = await runDecisionPass(db, {
    ...OPTS,
    useLlm: false,
    maxLlmCalls: 0,
    scanBatchLimit: 2,
  });
  expect(summary.scanned).toBe(7);
  expect(summary.discovered).toBe(7);
  expect(summary.discoveryComplete).toBe(true);
  expect(countByStatus(db).total).toBe(7);
  expect(readPassState(db).watermarkId).toBe("s6");
  expect(readPassState(db).scannedItems).toBe(7);
});

test("--rebuild re-discovers every item, not just the first batch", async () => {
  for (let i = 0; i < 5; i++) {
    seed(`s${i}`, "slack", "message", "t", `We decided on thing ${String(i)}.`, 5_000 + i);
  }
  await runDecisionPass(db, { ...OPTS, useLlm: false, maxLlmCalls: 0, scanBatchLimit: 2 });

  const summary = await rebuildDecisions(db, {
    ...OPTS,
    nowMs: 20_000,
    useLlm: false,
    maxLlmCalls: 0,
    scanBatchLimit: 2,
  });
  expect(summary.discovered).toBe(5);
  expect(summary.discoveryComplete).toBe(true);
  expect(countByStatus(db).total).toBe(5);
});

// The safety bound must be honest, not silently treated as completion: a capped
// scan reporting success is the very shape this fix exists to remove.
test("hitting the discovery batch bound reports discoveryComplete false and resumes next pass", async () => {
  for (let i = 0; i < 7; i++) {
    seed(`s${i}`, "slack", "message", "t", `We decided on thing ${String(i)}.`, 5_000 + i);
  }
  const capped = await runDecisionPass(db, {
    ...OPTS,
    useLlm: false,
    maxLlmCalls: 0,
    scanBatchLimit: 2,
    maxDiscoveryBatches: 2,
  });
  expect(capped.scanned).toBe(4);
  expect(capped.discoveryComplete).toBe(false);
  expect(readPassState(db).watermarkId).toBe("s3");

  // No work is LOST — the next pass resumes from the persisted watermark.
  const rest = await runDecisionPass(db, {
    ...OPTS,
    nowMs: 20_000,
    useLlm: false,
    maxLlmCalls: 0,
    scanBatchLimit: 2,
  });
  expect(rest.scanned).toBe(3);
  expect(rest.discoveryComplete).toBe(true);
  expect(countByStatus(db).total).toBe(7);
});

test("a non-finite scanBatchLimit falls back to the default instead of reaching SQL", async () => {
  seed("s1", "slack", "message", "t", "We decided on a thing.", 5_000);
  const summary = await runDecisionPass(db, {
    ...OPTS,
    useLlm: false,
    maxLlmCalls: 0,
    scanBatchLimit: Number.NaN,
    maxDiscoveryBatches: 0,
  });
  expect(summary.scanned).toBe(1);
  expect(summary.discoveryComplete).toBe(true);
});
