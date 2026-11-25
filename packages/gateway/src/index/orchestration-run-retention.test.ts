import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_ORCHESTRATION_CONFIG,
  parseNimbusTomlOrchestration,
} from "../config/orchestration-toml.ts";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { resolverFor, serviceConfig } from "../incident/__fixtures__/index-writers.ts";
import { upsertIndexedItem } from "./item-store.ts";
import {
  pruneOrchestrationRuns,
  startOrchestrationRunRetention,
} from "./orchestration-run-retention.ts";

const DAY = 24 * 3_600_000;
const NOW = 1_800_000_000_000;
const resolver = resolverFor(serviceConfig());
const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});
function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}
const noYield = (): Promise<void> => Promise.resolve();

function put(
  d: Database,
  service: string,
  type: string,
  externalId: string,
  metadata: Record<string, unknown>,
  modifiedAt = NOW,
): string {
  upsertIndexedItem(
    d,
    {
      service,
      type,
      externalId,
      title: externalId,
      bodyPreview: "",
      modifiedAt,
      syncedAt: NOW,
      metadata,
    },
    resolver,
  );
  return `${service}:${externalId}`;
}
const ids = (d: Database): string[] =>
  (d.query("SELECT id FROM item ORDER BY id").all() as { id: string }[]).map((r) => r.id);

describe("pruneOrchestrationRuns", () => {
  test("an old run goes; a recent run and its parent DAG item stay", async () => {
    const d = db();
    const dag = put(d, "airflow", "dag", "etl", {});
    const old = put(d, "airflow", "dag_run", "etl|old", { end_ms: NOW - 40 * DAY });
    const fresh = put(d, "airflow", "dag_run", "etl|new", { end_ms: NOW - 2 * DAY });
    const r = await pruneOrchestrationRuns(d, {
      retentionDays: 30,
      nowMs: NOW,
      yieldToEventLoop: noYield,
    });
    expect(r).toEqual({ deleted: 1, more: false });
    expect(ids(d)).toEqual([dag, fresh].sort());
    expect(ids(d)).not.toContain(old);
  });

  test("a run with no end is judged by its start, then by modified_at; all three services are covered", async () => {
    const d = db();
    put(d, "dagster", "job_run", "a", { start_ms: NOW - 50 * DAY });
    put(d, "prefect", "flow_run", "b", {}, NOW - 50 * DAY);
    const keep = put(d, "prefect", "flow_run", "c", { start_ms: NOW - DAY });
    put(
      d,
      "airflow",
      "dag_run",
      "x|y",
      "not an object" as unknown as Record<string, unknown>,
      NOW - 50 * DAY,
    );
    await pruneOrchestrationRuns(d, { retentionDays: 30, nowMs: NOW, yieldToEventLoop: noYield });
    expect(ids(d)).toEqual([keep]);
  });

  test("other item types of the same services are never touched, however old", async () => {
    const d = db();
    const a = put(d, "airflow", "dag", "etl", { end_ms: 1 }, 1);
    const b = put(d, "dagster", "job", "loc:repo:j", { end_ms: 1 }, 1);
    const c = put(d, "prefect", "deployment", "dep", { end_ms: 1 }, 1);
    const e = put(d, "github", "dag_run", "x", { end_ms: 1 }, 1);
    await pruneOrchestrationRuns(d, { retentionDays: 30, nowMs: NOW, yieldToEventLoop: noYield });
    expect(ids(d)).toEqual([a, b, c, e].sort());
  });

  test("batches are bounded and yield; a capped pass says more remain", async () => {
    const d = db();
    for (let i = 0; i < 7; i += 1) put(d, "airflow", "dag_run", `d|${String(i)}`, { end_ms: 1 });
    let yields = 0;
    const first = await pruneOrchestrationRuns(d, {
      retentionDays: 30,
      nowMs: NOW,
      batchSize: 3,
      maxBatches: 2,
      yieldToEventLoop: async () => {
        yields += 1;
      },
    });
    expect(first).toEqual({ deleted: 6, more: true });
    expect(yields).toBe(2);
    const second = await pruneOrchestrationRuns(d, {
      retentionDays: 30,
      nowMs: NOW,
      batchSize: 3,
      yieldToEventLoop: noYield,
    });
    expect(second).toEqual({ deleted: 1, more: false });
  });
});

describe("startOrchestrationRunRetention", () => {
  test("prunes at boot, drains a backlog larger than one pass, and stops", async () => {
    const d = db();
    for (let i = 0; i < 5; i += 1) put(d, "prefect", "flow_run", `r${String(i)}`, { end_ms: 1 });
    const h = startOrchestrationRunRetention(d, {
      retentionDays: () => 30,
      nowMs: () => NOW,
      yieldToEventLoop: noYield,
      intervalMs: 1_000_000,
    });
    await h.idle();
    expect(ids(d)).toEqual([]);
    h.stop();
  });
});

describe("[orchestration] run_retention_days", () => {
  test("defaults to 30; in range parses; out of range falls back and is reported", () => {
    expect(parseNimbusTomlOrchestration("").runRetentionDays).toBe(30);
    expect(DEFAULT_ORCHESTRATION_CONFIG.runRetentionDays).toBe(30);
    expect(
      parseNimbusTomlOrchestration("[orchestration]\nrun_retention_days = 7\n").runRetentionDays,
    ).toBe(7);
    expect(
      parseNimbusTomlOrchestration("[orchestration]\nrun_retention_days = 365\n").runRetentionDays,
    ).toBe(365);
    const msgs: string[] = [];
    for (const bad of ["6", "366", "0", "x", "-3"]) {
      const c = parseNimbusTomlOrchestration(
        `[orchestration]\nrun_retention_days = ${bad}\n`,
        (m) => void msgs.push(m),
      );
      expect(c.runRetentionDays).toBe(30);
    }
    expect(msgs).toHaveLength(5);
    expect(msgs[0]).toContain("[orchestration].run_retention_days");
    expect(parseNimbusTomlOrchestration("[other]\nrun_retention_days = 9\n").runRetentionDays).toBe(
      30,
    );
  });
});
