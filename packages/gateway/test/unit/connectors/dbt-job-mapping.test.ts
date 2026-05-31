import { describe, expect, test } from "bun:test";

import { jobUrl, mapDbtJobToItem } from "../../../src/connectors/dbt-job-mapping.ts";

function makeJob(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1234,
    name: "nightly-prod-run",
    account_id: 42,
    project_id: 77,
    environment_id: 5,
    dbt_version: "1.7.4",
    state: 1,
    schedule: { cron: "0 6 * * *" },
    triggers: { schedule: true, github_webhook: false, git_provider_webhook: false },
    created_at: "2021-02-10T20:03:11.000000Z",
    updated_at: "2022-03-15T08:30:00.000000Z",
    ...over,
  };
}

const NOW = 1_700_009_999_999;
const API_BASE = "https://cloud.getdbt.com";

function ctx(over: Partial<Parameters<typeof mapDbtJobToItem>[1]> = {}) {
  return {
    apiBase: API_BASE,
    accountId: 42,
    syncedAt: NOW,
    ...over,
  };
}

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapDbtJobToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapDbtJobToItem(null, ctx())).toBeNull();
    expect(mapDbtJobToItem("nope", ctx())).toBeNull();
    expect(mapDbtJobToItem([1, 2], ctx())).toBeNull();
  });

  test("returns null when id is missing or not a number", () => {
    const noId = makeJob();
    delete (noId as Record<string, unknown>)["id"];
    expect(mapDbtJobToItem(noId, ctx())).toBeNull();
    expect(mapDbtJobToItem(makeJob({ id: "1234" }), ctx())).toBeNull();
  });

  test("service/type fixed; externalId is <accountId>:<jobId>", () => {
    const row = mapDbtJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("dbt");
    expect(row.type).toBe("job");
    expect(row.externalId).toBe("42:1234");
  });

  test("title is the name; falls back to `job <id>` when name absent", () => {
    const row = mapDbtJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("nightly-prod-run");

    const noName = makeJob();
    delete (noName as Record<string, unknown>)["name"];
    const row2 = mapDbtJobToItem(noName, ctx());
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(row2.title).toBe("job 1234");
    expect(meta(row2)["name"]).toBeNull();
  });

  test("state maps 1→active, 2→deleted, else null", () => {
    const active = mapDbtJobToItem(makeJob({ state: 1 }), ctx());
    const deleted = mapDbtJobToItem(makeJob({ state: 2 }), ctx());
    const unknown = mapDbtJobToItem(makeJob({ state: 9 }), ctx());
    const missing = mapDbtJobToItem(makeJob({ state: undefined }), ctx());
    if (active === null || deleted === null || unknown === null || missing === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(meta(active)["state"]).toBe("active");
    expect(meta(deleted)["state"]).toBe("deleted");
    expect(meta(unknown)["state"]).toBeNull();
    expect(meta(missing)["state"]).toBeNull();
  });

  test("ids + dbt_version flow through; missing → null", () => {
    const row = mapDbtJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["job_id"]).toBe(1234);
    expect(m["account_id"]).toBe(42);
    expect(m["project_id"]).toBe(77);
    expect(m["environment_id"]).toBe(5);
    expect(m["dbt_version"]).toBe("1.7.4");

    const sparse = makeJob();
    delete (sparse as Record<string, unknown>)["project_id"];
    delete (sparse as Record<string, unknown>)["environment_id"];
    delete (sparse as Record<string, unknown>)["dbt_version"];
    const row2 = mapDbtJobToItem(sparse, ctx());
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(meta(row2)["project_id"]).toBeNull();
    expect(meta(row2)["environment_id"]).toBeNull();
    expect(meta(row2)["dbt_version"]).toBeNull();
  });

  test("schedule_cron pulled from schedule.cron; null when absent", () => {
    const row = mapDbtJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["schedule_cron"]).toBe("0 6 * * *");

    const noCron = mapDbtJobToItem(makeJob({ schedule: {} }), ctx());
    if (noCron === null) throw new Error("expected mapping to succeed");
    expect(meta(noCron)["schedule_cron"]).toBeNull();

    const noSchedule = makeJob();
    delete (noSchedule as Record<string, unknown>)["schedule"];
    const row3 = mapDbtJobToItem(noSchedule, ctx());
    if (row3 === null) throw new Error("expected mapping to succeed");
    expect(meta(row3)["schedule_cron"]).toBeNull();
  });

  test("triggers object passes through when a record; null otherwise", () => {
    const row = mapDbtJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["triggers"]).toEqual({
      schedule: true,
      github_webhook: false,
      git_provider_webhook: false,
    });

    const badTriggers = mapDbtJobToItem(makeJob({ triggers: "nope" }), ctx());
    if (badTriggers === null) throw new Error("expected mapping to succeed");
    expect(meta(badTriggers)["triggers"]).toBeNull();
  });

  test("created_at / updated_at parse ISO-8601; modifiedAt prefers updated_at", () => {
    const row = mapDbtJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const createdMs = Date.parse("2021-02-10T20:03:11.000000Z");
    const updatedMs = Date.parse("2022-03-15T08:30:00.000000Z");
    expect(meta(row)["created_at"]).toBe(createdMs);
    expect(meta(row)["updated_at"]).toBe(updatedMs);
    expect(row.modifiedAt).toBe(updatedMs);
  });

  test("modifiedAt falls back to created_at then syncedAt", () => {
    const noUpdated = makeJob();
    delete (noUpdated as Record<string, unknown>)["updated_at"];
    const row = mapDbtJobToItem(noUpdated, ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(Date.parse("2021-02-10T20:03:11.000000Z"));

    const noTimes = makeJob({ created_at: "not-a-date", updated_at: "also-bad" });
    const row2 = mapDbtJobToItem(noTimes, ctx());
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(meta(row2)["created_at"]).toBeNull();
    expect(meta(row2)["updated_at"]).toBeNull();
    expect(row2.modifiedAt).toBe(NOW);
  });

  test("most_recent_run status + finished_at surface when present", () => {
    const withRun = makeJob({
      most_recent_run: {
        status_humanized: "Success",
        finished_at: "2022-03-15T09:00:00.000000Z",
      },
    });
    const row = mapDbtJobToItem(withRun, ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["most_recent_run_status"]).toBe("Success");
    expect(meta(row)["most_recent_run_finished_at"]).toBe(
      Date.parse("2022-03-15T09:00:00.000000Z"),
    );
    expect(row.bodyPreview).toBe("nightly-prod-run — Success");
  });

  test("most_recent_completed_run is the fallback run object", () => {
    const withCompleted = makeJob({
      most_recent_completed_run: { status_humanized: "Error", finished_at: "bad-date" },
    });
    const row = mapDbtJobToItem(withCompleted, ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["most_recent_run_status"]).toBe("Error");
    expect(meta(row)["most_recent_run_finished_at"]).toBeNull();
  });

  test("no run object → run status null; bodyPreview falls back to state", () => {
    const row = mapDbtJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["most_recent_run_status"]).toBeNull();
    expect(meta(row)["most_recent_run_finished_at"]).toBeNull();
    expect(row.bodyPreview).toBe("nightly-prod-run — active");
  });

  test("canonical url points at the dbt Cloud job UI; url === canonicalUrl", () => {
    const row = mapDbtJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://cloud.getdbt.com/deploy/42/projects/77/jobs/1234");
    expect(row.url).toBe(row.canonicalUrl);
    expect(meta(row)["canonical_url"]).toBe(row.canonicalUrl);
  });

  test("canonical url falls back to account deploy page when project_id missing", () => {
    const noProject = makeJob();
    delete (noProject as Record<string, unknown>)["project_id"];
    const row = mapDbtJobToItem(noProject, ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://cloud.getdbt.com/deploy/42");
  });

  test("syncedAt propagates", () => {
    const row = mapDbtJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("jobUrl", () => {
  test("builds the full job-UI deep link", () => {
    expect(jobUrl("https://cloud.getdbt.com", 42, 77, 1234)).toBe(
      "https://cloud.getdbt.com/deploy/42/projects/77/jobs/1234",
    );
  });

  test("trims a trailing slash on the base", () => {
    expect(jobUrl("https://emea.dbt.com/", 1, 2, 3)).toBe(
      "https://emea.dbt.com/deploy/1/projects/2/jobs/3",
    );
  });

  test("falls back to the account deploy page when project id is null", () => {
    expect(jobUrl("https://cloud.getdbt.com", 42, null, 1234)).toBe(
      "https://cloud.getdbt.com/deploy/42",
    );
  });
});
