import { describe, expect, test } from "bun:test";

import { indexDbtManifest, mapDbtTestResultToItem, runUrl } from "./dbt-test-mapping.ts";

const SENTINEL = "ROW-VALUE-SENTINEL-4412";
const UID = "test.shop.not_null_orders_id.abc123";
const run = { runId: 90, jobId: 3, projectId: 5, finishedAtMs: 1_700_000_000_000 };

function ctx(nodes = new Map<string, { name: string | null; modelKeys: string[] }>()) {
  return { apiBase: "https://cloud.getdbt.com/", accountId: 1, run, nodes, syncedAt: 5 };
}

describe("mapDbtTestResultToItem", () => {
  test("maps a failing test to status and counts, keyed by account, run and test", () => {
    const row = mapDbtTestResultToItem(
      { unique_id: UID, status: "fail", failures: 7, execution_time: 1.5 },
      ctx(new Map([[UID, { name: "not_null_orders_id", modelKeys: ["db.sales.orders"] }]])),
    );
    expect(row).not.toBeNull();
    expect(row?.service).toBe("dbt");
    expect(row?.type).toBe("data_quality_test");
    expect(row?.externalId).toBe(`1:90:${UID}`);
    expect(row?.modifiedAt).toBe(run.finishedAtMs);
    expect(row?.url).toBe("https://cloud.getdbt.com/deploy/1/projects/5/runs/90");
    expect(row?.metadata).toEqual({
      monitoredDataModelKeys: ["db.sales.orders"],
      test_unique_id: UID,
      test_name: "not_null_orders_id",
      status: "fail",
      failures: 7,
      execution_time_s: 1.5,
      run_id: 90,
      job_id: 3,
      project_id: 5,
      account_id: 1,
      finished_at: run.finishedAtMs,
    });
  });

  test("without a manifest the name comes from the unique id and no model is claimed", () => {
    const row = mapDbtTestResultToItem({ unique_id: UID, status: "warn" }, ctx());
    expect(row?.metadata["test_name"]).toBe("not_null_orders_id");
    expect(row?.metadata["monitoredDataModelKeys"]).toEqual([]);
    expect(row?.metadata["failures"]).toBeNull();
  });

  test("passes, skips, non-test nodes and malformed entries are not indexed", () => {
    expect(mapDbtTestResultToItem({ unique_id: UID, status: "pass" }, ctx())).toBeNull();
    expect(mapDbtTestResultToItem({ unique_id: UID, status: "skipped" }, ctx())).toBeNull();
    expect(
      mapDbtTestResultToItem({ unique_id: "model.shop.orders", status: "error" }, ctx()),
    ).toBeNull();
    expect(mapDbtTestResultToItem({ status: "fail" }, ctx())).toBeNull();
    expect(mapDbtTestResultToItem("x", ctx())).toBeNull();
  });

  test("no cell values: message, compiled SQL, adapter response and failing rows never reach the item", () => {
    const row = mapDbtTestResultToItem(
      {
        unique_id: UID,
        status: "fail",
        failures: 2,
        message: `Got 2 results, configured to fail if != 0 (${SENTINEL})`,
        compiled_code: `select * from t where email = '${SENTINEL}'`,
        compiled: true,
        adapter_response: { query_id: SENTINEL },
        relation_name: SENTINEL,
        failing_rows: [{ email: SENTINEL }],
      },
      ctx(),
    );
    expect(JSON.stringify(row)).not.toContain(SENTINEL);
  });

  test("a run without a project links to the account page", () => {
    expect(runUrl("https://x.example", 4, { ...run, projectId: null })).toBe(
      "https://x.example/deploy/4",
    );
  });
});

describe("indexDbtManifest", () => {
  const manifest = {
    nodes: {
      [UID]: {
        name: "not_null_orders_id",
        resource_type: "test",
        depends_on: {
          nodes: ["model.shop.orders", "source.shop.raw.orders", "macro.shop.m", "model.shop.nope"],
        },
        compiled_code: SENTINEL,
      },
      "model.shop.orders": {
        resource_type: "model",
        name: "orders",
        database: "ANALYTICS",
        schema: "Sales",
        alias: "orders_v2",
      },
    },
    sources: {
      "source.shop.raw.orders": {
        resource_type: "source",
        database: "RAW",
        schema: "shop",
        identifier: "orders_raw",
        name: "orders",
      },
    },
  };

  test("resolves each parent to a normalised warehouse key; macros and unknown nodes are skipped", () => {
    const out = indexDbtManifest(manifest, new Set([UID, "test.shop.absent.zz"]));
    expect(out.get(UID)).toEqual({
      name: "not_null_orders_id",
      modelKeys: ["analytics.sales.orders_v2", "raw.shop.orders_raw"],
    });
    expect(out.has("test.shop.absent.zz")).toBe(false);
    expect(JSON.stringify([...out])).not.toContain(SENTINEL);
  });

  test("a manifest with no nodes gives nothing, and relation_name is the fallback", () => {
    expect(indexDbtManifest({}, new Set([UID])).size).toBe(0);
    const out = indexDbtManifest(
      {
        nodes: {
          [UID]: { name: "t", depends_on: { nodes: ["seed.shop.s"] } },
          "seed.shop.s": { resource_type: "seed", relation_name: '"DB"."PUB"."S"' },
        },
      },
      new Set([UID]),
    );
    expect(out.get(UID)?.modelKeys).toEqual(["db.pub.s"]);
  });
});
