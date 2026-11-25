import { describe, expect, test } from "bun:test";

import {
  clampName,
  DAG_RUN_MAX_FAILED_TASKS,
  failedTaskNames,
  runDurationMs,
} from "../../../src/connectors/_lib/dag-run.ts";
import { airflowRunKey, mapAirflowRunToItem } from "../../../src/connectors/airflow-run-mapping.ts";
import { mapDagsterRunToItem } from "../../../src/connectors/dagster-run-mapping.ts";
import { mapPrefectRunToItem } from "../../../src/connectors/prefect-run-mapping.ts";

const NOW = 1_700_000_000_000;
const SECRET = "ssn-123-45-6789";

const airflow = (over: Record<string, unknown> = {}) =>
  mapAirflowRunToItem(
    {
      dag_id: "etl",
      dag_run_id: "run1",
      state: "failed",
      start_date: "2026-06-01T02:00:00+00:00",
      end_date: "2026-06-01T02:01:00+00:00",
      run_type: "manual",
      conf: { v: SECRET },
      note: SECRET,
      ...over,
    },
    { baseUrl: "https://af.example/", syncedAt: NOW, failedTasks: new Map() },
  );
const dagster = (over: Record<string, unknown> = {}) =>
  mapDagsterRunToItem(
    {
      runId: "r1",
      jobName: "job",
      status: "SUCCESS",
      startTime: 1000.25,
      endTime: 1010,
      repositoryOrigin: { repositoryName: "repo", repositoryLocationName: "loc" },
      tags: [{ key: "dagster/sensor_name", value: SECRET }],
      runConfigYaml: SECRET,
      stepStats: [],
      ...over,
    },
    { baseUrl: "https://dg.example", syncedAt: NOW },
  );
const prefect = (over: Record<string, unknown> = {}) =>
  mapPrefectRunToItem(
    {
      id: "p1",
      name: "calm-fox",
      deployment_id: "d1",
      state_type: "COMPLETED",
      state_name: "Completed",
      start_time: "2026-06-01T02:00:00+00:00",
      end_time: "2026-06-01T02:00:30+00:00",
      parameters: { v: SECRET },
      state: { message: SECRET, data: SECRET },
      ...over,
    },
    { syncedAt: NOW, failedTasks: new Map() },
  );

describe("run mappers: metadata only", () => {
  test("the three mappers emit the same metadata key set", () => {
    const keys = [airflow(), dagster(), prefect()].map((r) =>
      Object.keys(r?.metadata ?? {}).sort(),
    );
    expect(keys[0]).toEqual(keys[1]);
    expect(keys[1]).toEqual(keys[2]);
    expect(keys[0]).toContain("parent_item_id");
    expect(keys[0]).toContain("failed_tasks");
  });

  test("no field the vendor may fill with data reaches the row (conf, parameters, messages, tag values, run config)", () => {
    for (const row of [airflow(), dagster(), prefect()]) {
      expect(JSON.stringify(row)).not.toContain(SECRET);
    }
  });

  test("rows missing an id are skipped", () => {
    expect(airflow({ dag_id: "" })).toBeNull();
    expect(airflow({ dag_run_id: undefined })).toBeNull();
    expect(dagster({ runId: undefined })).toBeNull();
    expect(prefect({ id: "" })).toBeNull();
    expect(
      mapAirflowRunToItem("x", { baseUrl: "", syncedAt: 1, failedTasks: new Map() }),
    ).toBeNull();
    expect(mapDagsterRunToItem(null, { baseUrl: "", syncedAt: 1 })).toBeNull();
    expect(mapPrefectRunToItem([], { syncedAt: 1, failedTasks: new Map() })).toBeNull();
  });

  test("Airflow: parent, outcome, duration, failed tasks from the task-instance map", () => {
    const row = mapAirflowRunToItem(
      {
        dag_id: "etl",
        dag_run_id: "r",
        state: "failed",
        start_date: "2026-06-01T02:00:00Z",
        end_date: "2026-06-01T02:02:00Z",
      },
      {
        baseUrl: "https://af.example",
        syncedAt: NOW,
        failedTasks: new Map([[airflowRunKey("etl", "r"), ["b", "a", "a"]]]),
      },
    );
    expect(row?.externalId).toBe("etl|r");
    expect(row?.metadata["parent_item_id"]).toBe("airflow:etl");
    expect(row?.metadata["outcome"]).toBe("failed");
    expect(row?.metadata["duration_ms"]).toBe(120_000);
    expect(row?.metadata["failed_tasks"]).toEqual(["a", "b"]);
    expect(row?.metadata["failed_task_count"]).toBe(2);
    expect(row?.url).toBe("https://af.example/dags/etl/grid?dag_run_id=r");
  });

  test("Airflow states: queued and running are running, an unknown state is other", () => {
    expect(airflow({ state: "queued" })?.metadata["outcome"]).toBe("running");
    expect(airflow({ state: "success" })?.metadata["outcome"]).toBe("success");
    expect(airflow({ state: "upstream_failed" })?.metadata["outcome"]).toBe("other");
    expect(airflow({ end_date: null })?.metadata["duration_ms"]).toBeNull();
  });

  test("Dagster: seconds become ms, the parent is the job's item id, the trigger comes from tag keys", () => {
    const row = dagster({ status: "FAILURE" });
    expect(row?.metadata["start_ms"]).toBe(1_000_250);
    expect(row?.metadata["end_ms"]).toBe(1_010_000);
    expect(row?.metadata["parent_item_id"]).toBe("dagster:loc:repo:job");
    expect(row?.metadata["outcome"]).toBe("failed");
    expect(row?.metadata["trigger"]).toBe("sensor");
    expect(dagster({ tags: [] })?.metadata["trigger"]).toBe("manual");
    expect(dagster({ repositoryOrigin: null })?.metadata["parent_item_id"]).toBeNull();
    expect(dagster({ status: "STARTED" })?.metadata["outcome"]).toBe("running");
  });

  test("Prefect: CRASHED counts as failed, no deployment means no parent, auto_scheduled is the trigger", () => {
    expect(prefect({ state_type: "CRASHED" })?.metadata["outcome"]).toBe("failed");
    expect(prefect({ deployment_id: null })?.metadata["parent_item_id"]).toBeNull();
    expect(prefect({ auto_scheduled: true })?.metadata["trigger"]).toBe("schedule");
    expect(prefect({ state_type: "CANCELLED" })?.metadata["outcome"]).toBe("other");
  });
});

describe("dag-run helpers", () => {
  test("failedTaskNames sorts, de-duplicates, clamps and caps", () => {
    const many = Array.from({ length: 30 }, (_, i) => `t${String(i).padStart(2, "0")}`);
    const r = failedTaskNames(many);
    expect(r.list).toHaveLength(DAG_RUN_MAX_FAILED_TASKS);
    expect(r.total).toBe(30);
    expect(failedTaskNames(["", "  ", "x\nforged"]).list).toEqual(["x forged"]);
    expect(clampName("a".repeat(500))).toHaveLength(121);
  });

  test("runDurationMs refuses an end before the start", () => {
    expect(runDurationMs(10, 5)).toBeNull();
    expect(runDurationMs(null, 5)).toBeNull();
    expect(runDurationMs(5, 10)).toBe(5);
  });
});
