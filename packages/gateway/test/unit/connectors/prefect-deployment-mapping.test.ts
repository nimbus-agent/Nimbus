import { describe, expect, test } from "bun:test";

import {
  mapPrefectDeploymentToItem,
  parseIsoMs,
} from "../../../src/connectors/prefect-deployment-mapping.ts";

const NOW = 1_700_009_999_999;
const API_URL = "https://api.prefect.cloud/api/accounts/a/workspaces/w";

function makeDeployment(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "nightly-etl",
    flow_id: "22222222-2222-2222-2222-222222222222",
    description: "Nightly extract-transform-load flow",
    tags: ["etl", "tier-1"],
    paused: false,
    work_pool_name: "default-pool",
    work_queue_name: "default-queue",
    schedules: [{ schedule: { cron: "0 2 * * *" } }],
    status: "READY",
    created: "2026-05-30T12:00:00+00:00",
    updated: "2026-05-31T12:00:00+00:00",
    ...over,
  };
}

function ctx(over: Partial<Parameters<typeof mapPrefectDeploymentToItem>[1]> = {}) {
  return { apiUrl: API_URL, syncedAt: NOW, ...over };
}

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapPrefectDeploymentToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapPrefectDeploymentToItem(null, ctx())).toBeNull();
    expect(mapPrefectDeploymentToItem("nope", ctx())).toBeNull();
    expect(mapPrefectDeploymentToItem(42, ctx())).toBeNull();
  });

  test("returns null when id is missing or empty", () => {
    const noId = makeDeployment();
    delete noId["id"];
    expect(mapPrefectDeploymentToItem(noId, ctx())).toBeNull();
    expect(mapPrefectDeploymentToItem(makeDeployment({ id: "" }), ctx())).toBeNull();
    expect(mapPrefectDeploymentToItem(makeDeployment({ id: 123 }), ctx())).toBeNull();
  });

  test("service/type fixed; externalId is the deployment id", () => {
    const row = mapPrefectDeploymentToItem(makeDeployment(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("prefect");
    expect(row.type).toBe("deployment");
    expect(row.externalId).toBe("11111111-1111-1111-1111-111111111111");
  });

  test("title includes name + description; url and canonicalUrl are null", () => {
    const row = mapPrefectDeploymentToItem(makeDeployment(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("nightly-etl — Nightly extract-transform-load flow");
    expect(row.url).toBeNull();
    expect(row.canonicalUrl).toBeNull();
    expect(meta(row)["canonical_url"]).toBeNull();
  });

  test("title is just the name when description absent", () => {
    const row = mapPrefectDeploymentToItem(makeDeployment({ description: undefined }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("nightly-etl");
    expect(meta(row)["description"]).toBeNull();
  });

  test("title falls back to id when name absent", () => {
    const row = mapPrefectDeploymentToItem(
      makeDeployment({ name: undefined, description: undefined }),
      ctx(),
    );
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("11111111-1111-1111-1111-111111111111");
    expect(meta(row)["name"]).toBeNull();
  });

  test("extracts flat fields into metadata", () => {
    const row = mapPrefectDeploymentToItem(makeDeployment(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["deployment_id"]).toBe("11111111-1111-1111-1111-111111111111");
    expect(m["name"]).toBe("nightly-etl");
    expect(m["flow_id"]).toBe("22222222-2222-2222-2222-222222222222");
    expect(m["description"]).toBe("Nightly extract-transform-load flow");
    expect(m["tags"]).toEqual(["etl", "tier-1"]);
    expect(m["paused"]).toBe(false);
    expect(m["work_pool_name"]).toBe("default-pool");
    expect(m["work_queue_name"]).toBe("default-queue");
    expect(m["status"]).toBe("READY");
  });

  test("paused true only when literally true", () => {
    const row = mapPrefectDeploymentToItem(makeDeployment({ paused: "yes" }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["paused"]).toBe(false);

    const paused = mapPrefectDeploymentToItem(makeDeployment({ paused: true }), ctx());
    if (paused === null) throw new Error("expected mapping to succeed");
    expect(meta(paused)["paused"]).toBe(true);
  });

  test("schedule stringifies the schedules array", () => {
    const row = mapPrefectDeploymentToItem(makeDeployment(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["schedule"]).toBe(JSON.stringify([{ schedule: { cron: "0 2 * * *" } }]));
  });

  test("schedule falls back to the single schedule object (older API)", () => {
    const row = mapPrefectDeploymentToItem(
      makeDeployment({ schedules: undefined, schedule: { cron: "@daily" } }),
      ctx(),
    );
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["schedule"]).toBe(JSON.stringify({ cron: "@daily" }));
  });

  test("schedule is null when absent or an empty array", () => {
    const a = mapPrefectDeploymentToItem(
      makeDeployment({ schedules: undefined, schedule: undefined }),
      ctx(),
    );
    if (a === null) throw new Error("expected mapping to succeed");
    expect(meta(a)["schedule"]).toBeNull();

    const b = mapPrefectDeploymentToItem(makeDeployment({ schedules: [] }), ctx());
    if (b === null) throw new Error("expected mapping to succeed");
    expect(meta(b)["schedule"]).toBeNull();
  });

  test("parses created and updated into ms", () => {
    const row = mapPrefectDeploymentToItem(makeDeployment(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created"]).toBe(Date.parse("2026-05-30T12:00:00+00:00"));
    expect(meta(row)["updated"]).toBe(Date.parse("2026-05-31T12:00:00+00:00"));
  });

  test("tolerates a non-array / non-string tags value", () => {
    const a = mapPrefectDeploymentToItem(makeDeployment({ tags: "nope" }), ctx());
    if (a === null) throw new Error("expected mapping to succeed");
    expect(meta(a)["tags"]).toEqual([]);

    const b = mapPrefectDeploymentToItem(makeDeployment({ tags: [null, 7, "ok"] }), ctx());
    if (b === null) throw new Error("expected mapping to succeed");
    expect(meta(b)["tags"]).toEqual(["ok"]);
  });

  test("modifiedAt prefers updated, then created, then syncedAt", () => {
    const row = mapPrefectDeploymentToItem(makeDeployment(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(Date.parse("2026-05-31T12:00:00+00:00"));

    const noUpdated = mapPrefectDeploymentToItem(makeDeployment({ updated: undefined }), ctx());
    if (noUpdated === null) throw new Error("expected mapping to succeed");
    expect(noUpdated.modifiedAt).toBe(Date.parse("2026-05-30T12:00:00+00:00"));

    const none = mapPrefectDeploymentToItem(
      makeDeployment({ created: undefined, updated: undefined }),
      ctx(),
    );
    if (none === null) throw new Error("expected mapping to succeed");
    expect(none.modifiedAt).toBe(NOW);
  });

  test("syncedAt propagates", () => {
    const row = mapPrefectDeploymentToItem(makeDeployment(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });

  test("long name + description title is truncated with an ellipsis", () => {
    const longDesc = "x".repeat(300);
    const row = mapPrefectDeploymentToItem(makeDeployment({ description: longDesc }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title.endsWith("…")).toBe(true);
    expect(row.title).toHaveLength(201);
  });
});

describe("parseIsoMs", () => {
  test("parses an ISO string", () => {
    expect(parseIsoMs("2026-05-31T12:00:00+00:00")).toBe(Date.parse("2026-05-31T12:00:00+00:00"));
  });

  test("returns null for non-strings, empty, and unparseable values", () => {
    expect(parseIsoMs(undefined)).toBeNull();
    expect(parseIsoMs(null)).toBeNull();
    expect(parseIsoMs(123)).toBeNull();
    expect(parseIsoMs("")).toBeNull();
    expect(parseIsoMs("not a date")).toBeNull();
  });
});
