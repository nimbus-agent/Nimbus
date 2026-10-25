import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mergeLayerDocs, parseLayerDoc } from "../config/layered-merge.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  BUILTIN_SOURCE_MAPPING,
  resolveSourceMapping,
  type SourceMapping,
} from "../sources/source-mapping.ts";
import {
  agentDecisionOwned,
  clearDecisions,
  countByStatus,
  deleteAgentDecision,
  deleteEvidenceCitingItem,
  evidenceKey,
  insertAgentDecision,
  listDecisions,
  markExtracted,
  markVetoed,
  readPassState,
  recordAttempt,
  replaceEvidence,
  selectPendingByPriority,
  selectSnippetUpgrades,
  setConfidence,
  upsertCandidate,
  writePassState,
} from "./decision-store.ts";

let db: Database;

function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

function candidate(id: string, priority: number, decidedAt = 1_000): void {
  upsertCandidate(db, {
    id,
    sourceItemId: `item-${id}`,
    cueTier: "explicit",
    cueText: "we decided",
    priority,
    decidedAt,
    nowMs: 5_000,
  });
}

test("upsertCandidate is idempotent on the same id", () => {
  candidate("a", 0.4);
  candidate("a", 0.4);
  expect(countByStatus(db, BUILTIN_SOURCE_MAPPING).total).toBe(1);
});

test("selectPendingByPriority returns highest priority first", () => {
  candidate("low", 0.1);
  candidate("high", 0.9);
  expect(selectPendingByPriority(db, 10, 0, BUILTIN_SOURCE_MAPPING).map((r) => r.id)).toEqual([
    "high",
    "low",
  ]);
});

test("selectPendingByPriority breaks ties by decided_at DESC", () => {
  candidate("older", 0.5, 1_000);
  candidate("newer", 0.5, 9_000);
  expect(selectPendingByPriority(db, 10, 0, BUILTIN_SOURCE_MAPPING).map((r) => r.id)).toEqual([
    "newer",
    "older",
  ]);
});

test("a row attempted more recently than the cooldown is skipped", () => {
  candidate("a", 0.5);
  recordAttempt(db, "a", 10_000);
  expect(selectPendingByPriority(db, 10, 9_000, BUILTIN_SOURCE_MAPPING)).toHaveLength(0);
  expect(selectPendingByPriority(db, 10, 11_000, BUILTIN_SOURCE_MAPPING)).toHaveLength(1);
});

test("a vetoed row is never re-selected", () => {
  candidate("a", 0.5);
  markVetoed(db, "a", 6_000);
  expect(selectPendingByPriority(db, 10, 0, BUILTIN_SOURCE_MAPPING)).toHaveLength(0);
  expect(countByStatus(db, BUILTIN_SOURCE_MAPPING).vetoed).toBe(1);
});

test("markExtracted stores alternatives as a round-trippable array", () => {
  candidate("a", 0.5);
  markExtracted(
    db,
    "a",
    {
      statement: "Adopt Postgres",
      rationale: "pool exhaustion",
      alternatives: ["stay on MySQL", "shard"],
      extractionSource: "llm",
    },
    6_000,
  );
  const [row] = listDecisions(db, {
    sinceMs: 0,
    minConfidence: 0,
    limit: 10,
    mapping: BUILTIN_SOURCE_MAPPING,
  });
  expect(row?.alternatives).toEqual(["stay on MySQL", "shard"]);
  expect(row?.statement).toBe("Adopt Postgres");
});

test("selectSnippetUpgrades returns only snippet-sourced extracted rows, oldest attempt first", () => {
  candidate("a", 0.5);
  candidate("b", 0.5);
  const fields = {
    statement: "s",
    rationale: null,
    alternatives: [],
    extractionSource: "snippet",
  } as const;
  markExtracted(db, "a", fields, 6_000);
  markExtracted(db, "b", { ...fields, extractionSource: "llm" }, 6_000);
  recordAttempt(db, "a", 1_000);
  expect(selectSnippetUpgrades(db, 10, BUILTIN_SOURCE_MAPPING).map((r) => r.id)).toEqual(["a"]);
});

test("replaceEvidence is idempotent and readable back through listDecisions", () => {
  candidate("a", 0.5);
  markExtracted(
    db,
    "a",
    { statement: "s", rationale: null, alternatives: [], extractionSource: "llm" },
    6_000,
  );
  const ev = [
    { kind: "pr", entityId: "e1", itemId: null, label: "#412", url: null, occurredAt: 7_000 },
  ] as const;
  replaceEvidence(db, "a", ev);
  replaceEvidence(db, "a", ev);
  const [row] = listDecisions(db, {
    sinceMs: 0,
    minConfidence: 0,
    limit: 10,
    mapping: BUILTIN_SOURCE_MAPPING,
  });
  expect(row?.evidence).toHaveLength(1);
  expect(row?.evidence[0]?.label).toBe("#412");
});

// Regression: `decision_evidence` was keyed on (decision_id, kind, label).
// `label` is an item TITLE, so two distinct PRs sharing a title and
// corroborating one decision collided and the second silently replaced the
// first through `INSERT OR REPLACE` — data loss that reads as "only one PR
// corroborates this". V47 keys on the total `evidence_key` instead.
test("two same-titled PRs on one decision BOTH survive replaceEvidence", () => {
  candidate("a", 0.5);
  markExtracted(
    db,
    "a",
    { statement: "s", rationale: null, alternatives: [], extractionSource: "llm" },
    6_000,
  );
  const ev = [
    {
      kind: "pr",
      entityId: "gh:pr:1",
      itemId: "item-pr-1",
      label: "Bump deps",
      url: "https://example.test/1",
      occurredAt: 7_000,
    },
    {
      kind: "pr",
      entityId: "gh:pr:2",
      itemId: "item-pr-2",
      label: "Bump deps",
      url: "https://example.test/2",
      occurredAt: 8_000,
    },
  ] as const;
  replaceEvidence(db, "a", ev);

  const [row] = listDecisions(db, {
    sinceMs: 0,
    minConfidence: 0,
    limit: 10,
    mapping: BUILTIN_SOURCE_MAPPING,
  });
  expect(row?.evidence).toHaveLength(2);
  expect(row?.evidence.map((e) => e.entityId).sort()).toEqual(["gh:pr:1", "gh:pr:2"]);
  // Re-running must still be idempotent, not additive.
  replaceEvidence(db, "a", ev);
  const [again] = listDecisions(db, {
    sinceMs: 0,
    minConfidence: 0,
    limit: 10,
    mapping: BUILTIN_SOURCE_MAPPING,
  });
  expect(again?.evidence).toHaveLength(2);
});

test("evidenceKey prefers entity id, then item id, then the label", () => {
  const base = { kind: "pr", label: "Bump deps", url: null, occurredAt: null } as const;
  expect(evidenceKey({ ...base, entityId: "e1", itemId: "i1" })).toBe("entity:e1");
  expect(evidenceKey({ ...base, entityId: null, itemId: "i1" })).toBe("item:i1");
  expect(evidenceKey({ ...base, entityId: null, itemId: null })).toBe("label:Bump deps");
});

test("listDecisions filters by since and min confidence, newest first", () => {
  candidate("old", 0.5, 1_000);
  candidate("new", 0.5, 9_000);
  const f = { statement: "s", rationale: null, alternatives: [], extractionSource: "llm" } as const;
  markExtracted(db, "old", f, 6_000);
  markExtracted(db, "new", f, 6_000);
  setConfidence(db, "old", 0.9, false, 6_000, null);
  setConfidence(db, "new", 0.1, false, 6_000, null);

  expect(
    listDecisions(db, {
      sinceMs: 5_000,
      minConfidence: 0,
      limit: 10,
      mapping: BUILTIN_SOURCE_MAPPING,
    }).map((r) => r.id),
  ).toEqual(["new"]);
  expect(
    listDecisions(db, {
      sinceMs: 0,
      minConfidence: 0.5,
      limit: 10,
      mapping: BUILTIN_SOURCE_MAPPING,
    }).map((r) => r.id),
  ).toEqual(["old"]);
});

test("listDecisions never returns pending or vetoed rows", () => {
  candidate("p", 0.5);
  candidate("v", 0.5);
  markVetoed(db, "v", 6_000);
  expect(
    listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10, mapping: BUILTIN_SOURCE_MAPPING }),
  ).toHaveLength(0);
});

test("pass state round-trips", () => {
  writePassState(db, {
    watermarkMs: 42,
    watermarkId: "item-9",
    lastPassAt: 100,
    lastPassNew: 3,
    scannedItems: 7,
  });
  expect(readPassState(db)).toEqual({
    watermarkMs: 42,
    watermarkId: "item-9",
    lastPassAt: 100,
    lastPassNew: 3,
    scannedItems: 7,
  });
});

test("pass state defaults to a zero cursor before any pass", () => {
  expect(readPassState(db).watermarkMs).toBe(0);
  expect(readPassState(db).lastPassAt).toBeNull();
});

describe("agent decisions (capture sink)", () => {
  const base = {
    id: "capture:cap_1",
    captureId: "cap_1",
    sourceItemId: "nimbus:cap_1",
    statement: "Adopt WAL",
    rationale: "fewer writer stalls",
    alternatives: ["rollback journal"],
    decidedAt: 5_000,
    evidence: [
      {
        kind: "source" as const,
        entityId: null,
        itemId: "slack:m1",
        label: "thread",
        url: null,
        occurredAt: null,
      },
    ],
    nowMs: 6_000,
  };
  const list = () =>
    listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10, mapping: BUILTIN_SOURCE_MAPPING });

  test("insertAgentDecision writes an extracted 'agent' row, confidence 1, with its evidence", () => {
    insertAgentDecision(db, base);
    const [r] = list();
    expect(r?.extractionSource).toBe("agent");
    expect(r?.status).toBe("extracted");
    expect(r?.confidence).toBe(1);
    expect(r?.alternatives).toEqual(["rollback journal"]);
    expect(r?.evidence.map((e) => e.itemId)).toEqual(["slack:m1"]);
    const owner = db.query("SELECT capture_id FROM decision_record WHERE id = ?").get(base.id);
    expect(owner).toEqual({ capture_id: "cap_1" });
  });

  test("deleteAgentDecision removes only a row this capture owns, with its evidence", () => {
    insertAgentDecision(db, base);
    expect(agentDecisionOwned(db, base.id, "cap_other")).toBe(false);
    expect(deleteAgentDecision(db, base.id, "cap_other")).toBe(false);
    expect(list()).toHaveLength(1);
    expect(agentDecisionOwned(db, base.id, "cap_1")).toBe(true);
    expect(deleteAgentDecision(db, base.id, "cap_1")).toBe(true);
    expect(list()).toHaveLength(0);
    const ev = db.query("SELECT COUNT(*) AS n FROM decision_evidence").get() as { n: number };
    expect(ev.n).toBe(0);
  });

  test("deleteAgentDecision never deletes a mined row, even one sharing the id shape", () => {
    candidate("m1", 1);
    markExtracted(
      db,
      "m1",
      { statement: "s", rationale: null, alternatives: [], extractionSource: "llm" },
      2,
    );
    expect(deleteAgentDecision(db, "m1", "cap_1")).toBe(false);
    expect(list()).toHaveLength(1);
  });

  test("deleteEvidenceCitingItem removes every evidence row naming the item, and only those", () => {
    insertAgentDecision(db, base);
    insertAgentDecision(db, {
      ...base,
      id: "capture:cap_2",
      captureId: "cap_2",
      evidence: [
        {
          kind: "source",
          entityId: null,
          itemId: "slack:m1",
          label: "a",
          url: null,
          occurredAt: null,
        },
        {
          kind: "source",
          entityId: null,
          itemId: "slack:m2",
          label: "b",
          url: null,
          occurredAt: null,
        },
      ],
    });
    expect(deleteEvidenceCitingItem(db, "slack:m1")).toBe(2);
    const left = db.query("SELECT item_id FROM decision_evidence").all();
    expect(left).toEqual([{ item_id: "slack:m2" }]);
  });

  test("clearDecisions (--rebuild) keeps 'agent' rows and their evidence, clears the rest", () => {
    insertAgentDecision(db, base);
    candidate("m1", 1);
    writePassState(db, {
      watermarkMs: 9,
      watermarkId: "x",
      lastPassAt: 9,
      lastPassNew: 1,
      scannedItems: 1,
    });
    clearDecisions(db);
    const ids = db.query("SELECT id FROM decision_record").all();
    expect(ids).toEqual([{ id: base.id }]);
    const ev = db.query("SELECT COUNT(*) AS n FROM decision_evidence").get() as { n: number };
    expect(ev.n).toBe(1);
    const ps = db.query("SELECT COUNT(*) AS n FROM decision_pass_state").get() as { n: number };
    expect(ps.n).toBe(0);
  });
});

describe("read visibility follows the effective source mapping", () => {
  function ownerMapping(body: string): SourceMapping {
    const doc = parseLayerDoc(
      { kind: "base", id: "base", path: "/virtual/base.toml" },
      `[sources]\n${body}\n`,
    );
    return resolveSourceMapping({ doc: mergeLayerDocs([doc]) });
  }
  const NO_SLACK = ownerMapping('exclude = ["slack:message"]');

  function item(id: string, service: string, type: string): void {
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, pinned)
       VALUES (?, ?, ?, ?, ?, 1000, 1000, 0)`,
      [id, service, type, id, id],
    );
  }

  function extractedFrom(id: string, sourceItemId: string, decidedAt = 1_000): void {
    upsertCandidate(db, {
      id,
      sourceItemId,
      cueTier: "explicit",
      cueText: "we decided",
      priority: 0.5,
      decidedAt,
      nowMs: 5_000,
    });
    markExtracted(
      db,
      id,
      { statement: id, rationale: null, alternatives: [], extractionSource: "llm" },
      5_000,
    );
  }

  const rowCount = (): number =>
    (db.query("SELECT COUNT(*) AS n FROM decision_record").get() as { n: number }).n;
  const ids = (mapping: SourceMapping, limit = 10): string[] =>
    listDecisions(db, { sinceMs: 0, minConfidence: 0, limit, mapping }).map((r) => r.id);

  test("excluded type's rows are hidden from list and counts", () => {
    item("slack:m1", "slack", "message");
    item("jira:J-1", "jira", "issue");
    extractedFrom("slack-d", "slack:m1", 2_000);
    extractedFrom("jira-d", "jira:J-1", 1_000);
    upsertCandidate(db, {
      id: "slack-pending",
      sourceItemId: "slack:m1",
      cueTier: "explicit",
      cueText: "we decided",
      priority: 0.5,
      decidedAt: 1_000,
      nowMs: 5_000,
    });
    expect(rowCount()).toBe(3);

    expect(ids(NO_SLACK)).toEqual(["jira-d"]);
    expect(countByStatus(db, NO_SLACK)).toEqual({
      total: 1,
      pending: 0,
      extracted: 1,
      vetoed: 0,
    });
    expect(rowCount()).toBe(3);

    expect(ids(BUILTIN_SOURCE_MAPPING)).toEqual(["slack-d", "jira-d"]);
    expect(countByStatus(db, BUILTIN_SOURCE_MAPPING)).toEqual({
      total: 3,
      pending: 1,
      extracted: 2,
      vetoed: 0,
    });
    expect(rowCount()).toBe(3);
  });

  test("orphan decisions are shown", () => {
    extractedFrom("orphan", "slack:deleted");
    expect(ids(BUILTIN_SOURCE_MAPPING)).toEqual(["orphan"]);
    expect(ids(NO_SLACK)).toEqual(["orphan"]);
    expect(countByStatus(db, NO_SLACK).extracted).toBe(1);
  });

  test("agent decisions are never hidden", () => {
    item("nimbus:capture:c1", "nimbus", "capture");
    insertAgentDecision(db, {
      id: "capture:c1",
      captureId: "c1",
      sourceItemId: "nimbus:capture:c1",
      statement: "Adopt WAL",
      rationale: null,
      alternatives: [],
      decidedAt: 1_000,
      evidence: [],
      nowMs: 5_000,
    });
    const NO_ANYTHING = ownerMapping(
      `exclude = [${BUILTIN_SOURCE_MAPPING.typesFor("decisions")
        .map((t) => `"${t}"`)
        .join(", ")}]`,
    );
    expect(NO_ANYTHING.typesFor("decisions")).toEqual([]);
    for (const m of [BUILTIN_SOURCE_MAPPING, NO_SLACK, NO_ANYTHING]) {
      expect(ids(m)).toEqual(["capture:c1"]);
      expect(countByStatus(db, m).extracted).toBe(1);
    }
  });

  test("limit counts visible rows", () => {
    item("slack:m1", "slack", "message");
    item("jira:J-1", "jira", "issue");
    // The three hidden rows are the NEWEST, so a post-LIMIT filter would return nothing.
    extractedFrom("h1", "slack:m1", 9_000);
    extractedFrom("h2", "slack:m1", 8_000);
    extractedFrom("h3", "slack:m1", 7_000);
    extractedFrom("v1", "jira:J-1", 2_000);
    extractedFrom("v2", "jira:J-1", 1_000);
    expect(ids(NO_SLACK, 2)).toEqual(["v1", "v2"]);
  });
});
