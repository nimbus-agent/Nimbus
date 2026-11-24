import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { mapAirflowRunToItem } from "../../connectors/airflow-run-mapping.ts";
import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import { mapDagsterRunToItem } from "../../connectors/dagster-run-mapping.ts";
import { mapPrefectRunToItem } from "../../connectors/prefect-run-mapping.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import { HOUR, resolverFor, serviceConfig, T0 } from "../__fixtures__/index-writers.ts";
import { DATA_LIST_CAP } from "./caps.ts";
import { dataLane } from "./data.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});
function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}

const resolver = resolverFor(serviceConfig());
const OPEN = T0 + 100 * HOUR;
const META = { monitoredDataModelKeys: ["analytics.payments.orders"] };
const iso = (ms: number): string => new Date(ms).toISOString();

function dag(d: Database, id: string, title = id): void {
  upsertIndexedItem(
    d,
    {
      service: "airflow",
      type: "dag",
      externalId: id,
      title,
      bodyPreview: "",
      modifiedAt: T0,
      syncedAt: T0,
      metadata: {},
    },
    resolver,
  );
}

function airflowRun(
  d: Database,
  dagId: string,
  runId: string,
  over: { state: string; start: number; end?: number | null },
): string {
  const row = mapAirflowRunToItem(
    {
      dag_id: dagId,
      dag_run_id: runId,
      state: over.state,
      start_date: iso(over.start),
      end_date: over.end === null || over.end === undefined ? null : iso(over.end),
      run_type: "scheduled",
    },
    { baseUrl: "https://airflow.example", syncedAt: T0, failedTasks: new Map() },
  );
  if (row === null) throw new Error("unmapped");
  upsertIndexedItem(d, row, resolver);
  return `airflow:${dagId}|${runId}`;
}

const lane = (d: Database, openedAtMs: number | null = OPEN) =>
  dataLane(d, { metadata: META, openedAtMs });

describe("the data lane's runs", () => {
  test("lists runs of matched jobs that failed or ran in the window, newest first", () => {
    const d = db();
    dag(d, "orders_etl");
    dag(d, "billing_etl");
    const oldFail = airflowRun(d, "orders_etl", "fail-old", {
      state: "failed",
      start: OPEN - 50 * HOUR,
      end: OPEN - 50 * HOUR + 60_000,
    });
    const inWindow = airflowRun(d, "orders_etl", "ok-in", {
      state: "success",
      start: OPEN - 2 * HOUR,
      end: OPEN - HOUR,
    });
    const running = airflowRun(d, "orders_etl", "running", {
      state: "running",
      start: OPEN + 1000,
    });
    airflowRun(d, "orders_etl", "ok-old", {
      state: "success",
      start: OPEN - 60 * HOUR,
      end: OPEN - 59 * HOUR,
    });
    airflowRun(d, "orders_etl", "fail-late", {
      state: "failed",
      start: OPEN + 3 * HOUR,
      end: OPEN + 4 * HOUR,
    });
    airflowRun(d, "billing_etl", "other-dag", {
      state: "failed",
      start: OPEN - HOUR,
      end: OPEN,
    });

    const r = lane(d);
    expect(r.lane.runs?.map((x) => x.id)).toEqual([running, inWindow, oldFail]);
    expect(r.lane.totals.runs).toBe(3);
    const first = r.lane.runs?.[0];
    expect(first?.job).toBe("orders_etl");
    expect(first?.rule).toBe("data:run_of_matched_job");
    expect(first?.outcome).toBe("running");
    expect(r.gaps.some((g) => g.detail.includes("No Airflow run is indexed"))).toBe(false);
    expect(r.gaps.some((g) => g.detail.includes("DAG-run logs"))).toBe(false);
  });

  test("with no open time only failed runs are listed", () => {
    const d = db();
    dag(d, "orders_etl");
    const failed = airflowRun(d, "orders_etl", "f", {
      state: "failed",
      start: OPEN,
      end: OPEN + 1000,
    });
    airflowRun(d, "orders_etl", "s", { state: "success", start: OPEN, end: OPEN + 1000 });
    expect(lane(d, null).lane.runs?.map((x) => x.id)).toEqual([failed]);
  });

  test("a matched source with no run indexed at all reports a named gap, never silence", () => {
    const d = db();
    dag(d, "orders_etl");
    const r = lane(d);
    expect(r.lane.runs).toEqual([]);
    expect(r.gaps.some((g) => g.detail.includes("No Airflow run is indexed"))).toBe(true);
  });

  test("matched jobs with runs indexed but none in scope: no gap, an empty list", () => {
    const d = db();
    dag(d, "orders_etl");
    airflowRun(d, "orders_etl", "old", {
      state: "success",
      start: OPEN - 90 * HOUR,
      end: OPEN - 89 * HOUR,
    });
    const r = lane(d);
    expect(r.lane.runs).toEqual([]);
    expect(r.gaps.some((g) => g.detail.includes("No Airflow run is indexed"))).toBe(false);
  });

  test("a source with no matched job adds no run gap", () => {
    const d = db();
    expect(lane(d).gaps.some((g) => g.detail.includes("run is indexed"))).toBe(false);
  });

  test("the list is capped and the true count is disclosed", () => {
    const d = db();
    dag(d, "orders_etl");
    for (let i = 0; i < DATA_LIST_CAP + 2; i += 1) {
      airflowRun(d, "orders_etl", `f${String(i)}`, {
        state: "failed",
        start: OPEN - i * 1000,
        end: OPEN - i * 1000 + 10,
      });
    }
    const r = lane(d);
    expect(r.lane.runs).toHaveLength(DATA_LIST_CAP);
    expect(r.lane.totals.runs).toBe(DATA_LIST_CAP + 2);
  });

  test("Dagster and Prefect runs are read through their parent item ids", () => {
    const d = db();
    upsertIndexedItem(
      d,
      {
        service: "dagster",
        type: "job",
        externalId: "loc:repo:orders_job",
        title: "orders_job",
        bodyPreview: "",
        modifiedAt: T0,
        syncedAt: T0,
        metadata: {},
      },
      resolver,
    );
    upsertIndexedItem(
      d,
      {
        service: "prefect",
        type: "deployment",
        externalId: "dep-1",
        title: "orders deployment",
        bodyPreview: "",
        modifiedAt: T0,
        syncedAt: T0,
        metadata: {},
      },
      resolver,
    );
    const dagster = mapDagsterRunToItem(
      {
        runId: "dr1",
        jobName: "orders_job",
        status: "FAILURE",
        startTime: (OPEN - HOUR) / 1000,
        endTime: (OPEN - HOUR + 5000) / 1000,
        repositoryOrigin: { repositoryName: "repo", repositoryLocationName: "loc" },
      },
      { baseUrl: "https://dagster.example", syncedAt: T0 },
    );
    const prefect = mapPrefectRunToItem(
      {
        id: "pr1",
        name: "calm-fox",
        deployment_id: "dep-1",
        state_type: "CRASHED",
        state_name: "Crashed",
        start_time: iso(OPEN - 2 * HOUR),
        end_time: iso(OPEN - 2 * HOUR + 5000),
      },
      { syncedAt: T0, failedTasks: new Map() },
    );
    if (dagster === null || prefect === null) throw new Error("unmapped");
    upsertIndexedItem(d, dagster, resolver);
    upsertIndexedItem(d, prefect, resolver);

    const r = lane(d);
    expect(r.lane.runs?.map((x) => [x.service, x.outcome, x.job])).toEqual([
      ["dagster", "failed", "orders_job"],
      ["prefect", "failed", "orders deployment"],
    ]);
  });
});
