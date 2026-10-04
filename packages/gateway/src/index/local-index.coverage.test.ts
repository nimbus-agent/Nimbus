/**
 * Branches of `LocalIndex` the rest of the suite leaves unexercised: the hybrid search's
 * service / item-type filters and 1536-dim query vector, a hybrid duplicate surfacing on the
 * ranked item, a rate-limited connector's Retry-After in the persisted status, the reauth
 * no-op, and the two audit readers' refusal of a corrupt `hitl_status`.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { getConnectorHealth, transitionHealth } from "../connectors/health.ts";
import type { DualVectorsOutcome } from "../embedding/embedding-readiness.ts";
import { upsertIndexedItem } from "./item-store.ts";
import { LocalIndex, type SemanticSearchDeps } from "./local-index.ts";

const MODEL_384 = "vec-test-model";
const MODEL_1536 = "openai/text-embedding-3-small";

function openIndex(semanticSearch?: SemanticSearchDeps): { idx: LocalIndex; db: Database } {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return {
    idx: semanticSearch === undefined ? new LocalIndex(db) : new LocalIndex(db, { semanticSearch }),
    db,
  };
}

function unitVec(dims: number): Float32Array {
  const v = new Float32Array(dims);
  v[0] = 1;
  return v;
}

function depsFor(outcome: DualVectorsOutcome): SemanticSearchDeps {
  return {
    model: MODEL_384,
    embedQuery: async () => null,
    embedQueryDualOutcome: async () => outcome,
    activeBackfillPass: () => null,
  };
}

/** Seeds one item plus a 1536-dim chunk for it, so ONLY the 1536 table can vector-rank it. */
function seedWith1536(
  db: Database,
  rowid: bigint,
  item: { service: string; type: string; externalId: string; title: string },
): void {
  const now = Date.now();
  upsertIndexedItem(db, { ...item, modifiedAt: now, syncedAt: now });
  db.run("INSERT INTO vec_items_1536(rowid, embedding) VALUES (?, vec_f32(?))", [
    rowid,
    unitVec(1536),
  ]);
  db.run(
    `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
     VALUES (?, 0, ?, ?, ?, 1536, ?)`,
    [`${item.service}:${item.externalId}`, item.title, rowid, MODEL_1536, now],
  );
}

describe("searchRankedAsync — hybrid branch options", () => {
  const vec1536Only: DualVectorsOutcome = {
    vectors: { vec384: null, vec1536: unitVec(1536), model384: null, model1536: MODEL_1536 },
    degraded: null,
  };

  function seedThree(): { idx: LocalIndex; db: Database } {
    const opened = openIndex(depsFor(vec1536Only));
    seedWith1536(opened.db, 1n, {
      service: "github",
      type: "pr",
      externalId: "acme/api#1",
      title: "quota throttling design",
    });
    seedWith1536(opened.db, 2n, {
      service: "gitlab",
      type: "pr",
      externalId: "grp/api!2",
      title: "quota throttling design",
    });
    seedWith1536(opened.db, 3n, {
      service: "github",
      type: "issue",
      externalId: "acme/api#3",
      title: "quota throttling design",
    });
    return opened;
  }

  test("service + itemType reach the hybrid search, and a 1536-only query vector ranks", async () => {
    const { idx, db } = seedThree();
    // Self-validating premise: without sqlite-vec the hybrid branch is never entered.
    expect(db.query("select vec_version() as v").get()).toBeDefined();

    const control = await idx.searchRankedAsync({ name: "quota throttling" });
    expect(control.items.map((i) => i.indexPrimaryKey).sort()).toEqual([
      "github:acme/api#1",
      "github:acme/api#3",
      "gitlab:grp/api!2",
    ]);

    const { items, retrieval } = await idx.searchRankedAsync({
      name: "quota throttling",
      service: "github",
      itemType: "pr",
    });
    expect(items.map((i) => i.indexPrimaryKey)).toEqual(["github:acme/api#1"]);
    expect(items[0]?.scoringFormula).toBe("hybrid_rrf");
    // Only the 1536 table holds a vector for this item, so a vector rank proves the 1536 query
    // embedding and its model were handed to the hybrid search.
    expect(items[0]?.vectorRank).toBe(1);
    expect(retrieval.vectorRanked).toBe(true);
    db.close();
  });

  test("a 1536 vector without its model name is not used for ranking", async () => {
    const { db } = seedThree();
    const idx = new LocalIndex(db, {
      semanticSearch: depsFor({
        vectors: { vec384: null, vec1536: unitVec(1536), model384: null, model1536: null },
        degraded: null,
      }),
    });
    const { items } = await idx.searchRankedAsync({ name: "quota throttling", service: "gitlab" });
    expect(items.map((i) => i.indexPrimaryKey)).toEqual(["gitlab:grp/api!2"]);
    expect(items[0]?.vectorRank ?? null).toBeNull();
    expect(items[0]?.bm25Rank).toBe(1);
    db.close();
  });

  test("an empty service / itemType is no filter at all", async () => {
    const { idx, db } = seedThree();
    const { items } = await idx.searchRankedAsync({
      name: "quota throttling",
      service: "",
      itemType: "",
    });
    expect(items).toHaveLength(3);
    db.close();
  });

  test("a hybrid duplicate by canonical URL is carried onto the ranked item", async () => {
    const { idx, db } = openIndex(
      depsFor({
        vectors: { vec384: null, vec1536: null, model384: null, model1536: null },
        degraded: "timeout",
      }),
    );
    const now = Date.now();
    for (const [service, externalId] of [
      ["github", "acme/web#7"],
      ["slack", "C1/1700000000.1"],
    ] as const) {
      upsertIndexedItem(db, {
        service,
        type: "pr",
        externalId,
        title: "checkout redesign rollout",
        canonicalUrl: "https://github.com/acme/web/pull/7",
        modifiedAt: now,
        syncedAt: now,
      });
    }
    const { items } = await idx.searchRankedAsync({ name: "checkout redesign" });
    expect(items).toHaveLength(1);
    const [only] = items;
    // The keyword-only path dedupes by canonical URL too, so prove the HYBRID branch ranked this.
    expect(only?.scoringFormula).toBe("hybrid_rrf");
    expect(only?.canonicalUrl).toBe("https://github.com/acme/web/pull/7");
    expect(only?.duplicates).toHaveLength(1);
    // The survivor is one service and the duplicate is the OTHER one.
    expect([only?.service, ...(only?.duplicates ?? [])].sort()).toEqual(["github", "slack"]);
    db.close();
  });
});

describe("connector health on the persisted status", () => {
  test("a rate-limited connector reports its Retry-After instant in ms", () => {
    const { idx, db } = openIndex();
    idx.ensureConnectorSchedulerRegistration("github", 60_000, 1_000);
    idx.ensureConnectorSchedulerRegistration("slack", 60_000, 1_000);
    const retryAt = new Date(1_900_000_000_000);
    transitionHealth(db, "github", { type: "rate_limited", retryAfter: retryAt });

    const [github] = idx.persistedConnectorStatuses("github");
    expect(github?.healthState).toBe("rate_limited");
    expect(github?.healthRetryAfterMs).toBe(1_900_000_000_000);
    const [slack] = idx.persistedConnectorStatuses("slack");
    expect(slack?.healthRetryAfterMs).toBeNull();
    db.close();
  });

  test("markConnectorReauthenticated clears unauthenticated, and only unauthenticated", () => {
    const { idx, db } = openIndex();
    transitionHealth(db, "github", { type: "unauthenticated" });
    idx.markConnectorReauthenticated("github");
    expect(getConnectorHealth(db, "github").state).toBe("healthy");

    const retryAt = new Date(1_900_000_000_000);
    transitionHealth(db, "jira", { type: "rate_limited", retryAfter: retryAt });
    idx.markConnectorReauthenticated("jira");
    const jira = getConnectorHealth(db, "jira");
    expect(jira.state).toBe("rate_limited");
    expect(jira.retryAfter?.getTime()).toBe(1_900_000_000_000);
    db.close();
  });
});

describe("audit readers", () => {
  function insertCorruptAuditRow(db: Database): void {
    // The column is CHECK-constrained; only a bypassed constraint (a damaged or hand-edited
    // database) can hold a status outside the union.
    db.run("PRAGMA ignore_check_constraints = ON");
    db.run(
      `INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp, row_hash, prev_hash)
       VALUES ('slack.message.post', 'pending', '{}', 1, 'h', 'p')`,
    );
    db.run("PRAGMA ignore_check_constraints = OFF");
  }

  test("a valid row maps to an AuditEntry", () => {
    const { idx, db } = openIndex();
    idx.recordAudit({
      actionType: "slack.message.post",
      hitlStatus: "approved",
      actionJson: '{"a":1}',
      timestamp: 42,
    });
    expect(idx.listAudit(10)).toEqual([
      {
        id: 1,
        actionType: "slack.message.post",
        hitlStatus: "approved",
        actionJson: '{"a":1}',
        timestamp: 42,
      },
    ]);
    db.close();
  });

  test("listAudit refuses a row whose hitl_status is outside the union", () => {
    const { idx, db } = openIndex();
    insertCorruptAuditRow(db);
    expect(() => idx.listAudit(10)).toThrow("Corrupt audit_log row: invalid hitl_status");
    db.close();
  });

  test("listAuditWithChain refuses the same corrupt row", () => {
    const { idx, db } = openIndex();
    insertCorruptAuditRow(db);
    expect(() => idx.listAuditWithChain(10)).toThrow("Corrupt audit_log row: invalid hitl_status");
    db.close();
  });
});

describe("getAuditVerifiedThroughId", () => {
  function setRaw(db: Database, value: string): void {
    db.run("UPDATE _meta SET value = ? WHERE key = 'audit_verified_through_id'", [value]);
  }

  test("a non-numeric stored value reads as 0", () => {
    const { idx, db } = openIndex();
    setRaw(db, "not-a-number");
    expect(idx.getAuditVerifiedThroughId()).toBe(0);
    db.close();
  });

  test("a negative stored value reads as 0", () => {
    const { idx, db } = openIndex();
    setRaw(db, "-7");
    expect(idx.getAuditVerifiedThroughId()).toBe(0);
    db.close();
  });

  test("a valid stored value round-trips, and the setter floors and clamps", () => {
    const { idx, db } = openIndex();
    setRaw(db, "12");
    expect(idx.getAuditVerifiedThroughId()).toBe(12);
    idx.setAuditVerifiedThroughId(9.9);
    expect(idx.getAuditVerifiedThroughId()).toBe(9);
    idx.setAuditVerifiedThroughId(-3);
    expect(idx.getAuditVerifiedThroughId()).toBe(0);
    db.close();
  });
});
