import { describe, expect, test } from "bun:test";

import {
  jobUrl,
  mapDatabricksJobToItem,
  type RunSummary,
} from "../../../src/connectors/databricks-job-mapping.ts";

const NOW = 1_700_009_999_999;
const HOST = "https://dbc-abc123.cloud.databricks.com";

const CREATED_MS = 1_613_001_791_000;
const RUN_START_MS = 1_699_900_000_000;

function makeJob(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: 555,
    creator_user_name: "alice@acme.com",
    created_time: CREATED_MS,
    settings: {
      name: "Nightly ETL",
      format: "MULTI_TASK",
      schedule: {
        quartz_cron_expression: "0 0 6 * * ?",
        timezone_id: "UTC",
        pause_status: "UNPAUSED",
      },
    },
    ...over,
  };
}

function makeRun(over: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: 9001,
    life_cycle_state: "TERMINATED",
    result_state: "SUCCESS",
    start_time: RUN_START_MS,
    run_duration: 123_456,
    creator_user_name: "scheduler@acme.com",
    cluster_id: "0712-abc-xyz",
    ...over,
  };
}

function ctx(over: Partial<Parameters<typeof mapDatabricksJobToItem>[1]> = {}) {
  return {
    host: HOST,
    runsByJobId: new Map<number, RunSummary>(),
    syncedAt: NOW,
    ...over,
  };
}

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapDatabricksJobToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapDatabricksJobToItem(null, ctx())).toBeNull();
    expect(mapDatabricksJobToItem("nope", ctx())).toBeNull();
    expect(mapDatabricksJobToItem([1, 2], ctx())).toBeNull();
  });

  test("returns null when job_id is missing or not a number", () => {
    const noId = makeJob();
    delete noId["job_id"];
    expect(mapDatabricksJobToItem(noId, ctx())).toBeNull();
    expect(mapDatabricksJobToItem(makeJob({ job_id: "555" }), ctx())).toBeNull();
  });

  test("service/type fixed; externalId is job_<jobId>", () => {
    const row = mapDatabricksJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("databricks");
    expect(row.type).toBe("data_pipeline");
    expect(row.externalId).toBe("job_555");
  });

  test("name pulled from the nested settings.name", () => {
    const row = mapDatabricksJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Nightly ETL");
    expect(meta(row)["name"]).toBe("Nightly ETL");
  });

  test("title falls back to `Job <id>` when settings.name missing/empty; metadata.name stays null", () => {
    const noName = makeJob({ settings: { format: "MULTI_TASK" } });
    const row = mapDatabricksJobToItem(noName, ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Job 555");
    expect(meta(row)["name"]).toBeNull();

    const emptyName = makeJob({ settings: { name: "" } });
    const row2 = mapDatabricksJobToItem(emptyName, ctx());
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(row2.title).toBe("Job 555");
    expect(meta(row2)["name"]).toBe("");
  });

  test("creator_user_name + format flow through; missing → null", () => {
    const row = mapDatabricksJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["creator_user_name"]).toBe("alice@acme.com");
    expect(meta(row)["format"]).toBe("MULTI_TASK");

    const sparse = makeJob({ settings: { name: "X" } });
    delete sparse["creator_user_name"];
    const row2 = mapDatabricksJobToItem(sparse, ctx());
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(meta(row2)["creator_user_name"]).toBeNull();
    expect(meta(row2)["format"]).toBeNull();
  });

  test("schedule_cron descends settings.schedule.quartz_cron_expression; null when absent", () => {
    const row = mapDatabricksJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["schedule_cron"]).toBe("0 0 6 * * ?");

    const noSchedule = makeJob({ settings: { name: "X" } });
    const row2 = mapDatabricksJobToItem(noSchedule, ctx());
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(meta(row2)["schedule_cron"]).toBeNull();

    const emptySchedule = makeJob({ settings: { name: "X", schedule: {} } });
    const row3 = mapDatabricksJobToItem(emptySchedule, ctx());
    if (row3 === null) throw new Error("expected mapping to succeed");
    expect(meta(row3)["schedule_cron"]).toBeNull();
  });

  test("created_at passes through as epoch ms (no Date.parse); null when absent", () => {
    const row = mapDatabricksJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBe(CREATED_MS);

    const noCreated = makeJob();
    delete noCreated["created_time"];
    const row2 = mapDatabricksJobToItem(noCreated, ctx());
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(meta(row2)["created_at"]).toBeNull();
  });

  test("latest-run enrichment present: status, ids, epoch-ms start/duration, cluster, triggered-by", () => {
    const runsByJobId = new Map<number, RunSummary>([[555, makeRun()]]);
    const row = mapDatabricksJobToItem(makeJob(), ctx({ runsByJobId }));
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["latest_run_id"]).toBe(9001);
    expect(m["latest_run_status"]).toBe("TERMINATED/SUCCESS");
    expect(m["latest_run_started_at"]).toBe(RUN_START_MS);
    expect(m["latest_run_duration_ms"]).toBe(123_456);
    expect(m["latest_run_cluster_id"]).toBe("0712-abc-xyz");
    expect(m["latest_run_triggered_by"]).toBe("scheduler@acme.com");
    expect(row.bodyPreview).toBe("Nightly ETL — TERMINATED/SUCCESS");
    expect(row.modifiedAt).toBe(RUN_START_MS);
  });

  test("status string is life_cycle only when result_state is null", () => {
    const runsByJobId = new Map<number, RunSummary>([
      [555, makeRun({ life_cycle_state: "RUNNING", result_state: null })],
    ]);
    const row = mapDatabricksJobToItem(makeJob(), ctx({ runsByJobId }));
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["latest_run_status"]).toBe("RUNNING");
  });

  test("latest-run enrichment absent: all latest_run_* fields null; bodyPreview says 'no runs'", () => {
    const row = mapDatabricksJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["latest_run_id"]).toBeNull();
    expect(m["latest_run_status"]).toBeNull();
    expect(m["latest_run_started_at"]).toBeNull();
    expect(m["latest_run_duration_ms"]).toBeNull();
    expect(m["latest_run_cluster_id"]).toBeNull();
    expect(m["latest_run_triggered_by"]).toBeNull();
    expect(row.bodyPreview).toBe("Nightly ETL — no runs");
  });

  test("modifiedAt falls back to created_at when no run, then syncedAt when neither", () => {
    const row = mapDatabricksJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(CREATED_MS);

    const noCreated = makeJob();
    delete noCreated["created_time"];
    const row2 = mapDatabricksJobToItem(noCreated, ctx());
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(row2.modifiedAt).toBe(NOW);
  });

  test("canonical url points at the workspace job UI; url === canonicalUrl", () => {
    const row = mapDatabricksJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://dbc-abc123.cloud.databricks.com/jobs/555");
    expect(row.url).toBe(row.canonicalUrl);
    expect(meta(row)["canonical_url"]).toBe(row.canonicalUrl);
  });

  test("syncedAt propagates", () => {
    const row = mapDatabricksJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("jobUrl", () => {
  test("builds the workspace job deep link", () => {
    expect(jobUrl("https://dbc-abc123.cloud.databricks.com", 555)).toBe(
      "https://dbc-abc123.cloud.databricks.com/jobs/555",
    );
  });

  test("trims a trailing slash on the host", () => {
    expect(jobUrl("https://adb-123.azuredatabricks.net/", 7)).toBe(
      "https://adb-123.azuredatabricks.net/jobs/7",
    );
  });
});
