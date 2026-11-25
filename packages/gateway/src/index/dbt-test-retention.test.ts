import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { writeDbtTest } from "../incident/__fixtures__/dbt-writers.ts";
import { resolverFor, serviceConfig } from "../incident/__fixtures__/index-writers.ts";
import { openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import { pruneDbtTests } from "./dbt-test-retention.ts";
import { startItemHistoryRetention } from "./item-history-retention.ts";
import { upsertIndexedItem } from "./item-store.ts";

const DAY = 86_400_000;
const NOW = 1000 * DAY;
const resolver = resolverFor(serviceConfig());
const noYield = async (): Promise<void> => {};

function dbtTest(db: Database, uid: string, ageDays: number): string {
  return writeDbtTest(db, resolver, {
    uniqueId: `test.shop.${uid}.h`,
    status: "fail",
    modelKeys: ["analytics.sales.orders"],
    finishedAtMs: NOW - ageDays * DAY,
  });
}

function other(db: Database, service: string, ageDays: number): void {
  upsertIndexedItem(
    db,
    {
      service,
      type: "data_quality_test",
      externalId: `${service}-old`,
      title: `${service} test`,
      bodyPreview: "",
      modifiedAt: NOW - ageDays * DAY,
      syncedAt: NOW,
      metadata: { monitoredDataModelKeys: ["analytics.sales.orders"] },
    },
    resolver,
  );
}

function ids(db: Database): string[] {
  return (
    db.query("SELECT id FROM item WHERE type = 'data_quality_test' ORDER BY id").all() as {
      id: string;
    }[]
  ).map((r) => r.id);
}

describe("pruneDbtTests", () => {
  test("deletes old dbt tests with their graph entities; recent dbt and other sources' tests stay", async () => {
    const db = openMemoryIndexDatabase();
    try {
      const old = dbtTest(db, "old", 45);
      const recent = dbtTest(db, "recent", 5);
      other(db, "montecarlo", 400);
      other(db, "bigeye", 400);
      other(db, "great_expectations", 400);
      const entitiesBefore = (
        db
          .query("SELECT count(*) AS n FROM graph_entity WHERE type = 'data_quality_test'")
          .get() as {
          n: number;
        }
      ).n;
      expect(entitiesBefore).toBe(5);
      const r = await pruneDbtTests(db, {
        retentionDays: 30,
        nowMs: NOW,
        yieldToEventLoop: noYield,
      });
      expect(r).toEqual({ deleted: 1, more: false });
      const left = ids(db);
      expect(left).not.toContain(old);
      expect(left).toContain(recent);
      expect(left.filter((i) => !i.startsWith("dbt:"))).toHaveLength(3);
      const entities = db
        .query("SELECT external_id FROM graph_entity WHERE type = 'data_quality_test'")
        .all() as { external_id: string }[];
      expect(entities.map((e) => e.external_id)).not.toContain(old);
      expect(entities).toHaveLength(4);
    } finally {
      db.close();
    }
  });

  test("works in bounded batches, yields between them and reports a backlog", async () => {
    const db = openMemoryIndexDatabase();
    try {
      for (let i = 0; i < 7; i += 1) dbtTest(db, `t${String(i)}`, 90);
      let yields = 0;
      const capped = await pruneDbtTests(db, {
        retentionDays: 30,
        nowMs: NOW,
        batchSize: 2,
        maxBatches: 2,
        yieldToEventLoop: async () => {
          yields += 1;
        },
      });
      expect(capped).toEqual({ deleted: 4, more: true });
      expect(yields).toBe(2);
      const rest = await pruneDbtTests(db, {
        retentionDays: 30,
        nowMs: NOW,
        batchSize: 2,
        yieldToEventLoop: noYield,
      });
      expect(rest).toEqual({ deleted: 3, more: false });
      expect(ids(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("the daily tick", () => {
  test("prunes dbt tests with the configured days, re-read on each tick", async () => {
    const db = openMemoryIndexDatabase();
    try {
      dbtTest(db, "a", 45);
      const keep = dbtTest(db, "b", 5);
      const h = startItemHistoryRetention(db, {
        retentionDays: () => 180,
        dbtTestRetentionDays: () => 30,
        nowMs: () => NOW,
        setTimer: () => ({ clear: () => {} }),
      });
      await h.idle();
      h.stop();
      expect(ids(db)).toEqual([keep]);
    } finally {
      db.close();
    }
  });
});
