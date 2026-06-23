import { describe, expect, test } from "bun:test";

import {
  dagUrl,
  mapAirflowDagToItem,
  parseIsoMs,
} from "../../../src/connectors/airflow-dag-mapping.ts";

const NOW = 1_700_009_999_999;
const BASE_URL = "https://airflow.example.com";

function makeDag(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dag_id: "nightly_etl",
    is_paused: false,
    is_active: true,
    is_subdag: false,
    owners: ["data-eng", "platform"],
    description: "Nightly extract-transform-load pipeline",
    schedule_interval: { __type: "CronExpression", value: "0 2 * * *" },
    tags: [{ name: "etl" }, { name: "tier-1" }],
    fileloc: "/opt/airflow/dags/nightly_etl.py",
    next_dagrun: "2026-06-01T02:00:00+00:00",
    last_parsed_time: "2026-05-31T12:00:00+00:00",
    ...over,
  };
}

function ctx(over: Partial<Parameters<typeof mapAirflowDagToItem>[1]> = {}) {
  return { baseUrl: BASE_URL, syncedAt: NOW, ...over };
}

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapAirflowDagToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapAirflowDagToItem(null, ctx())).toBeNull();
    expect(mapAirflowDagToItem("nope", ctx())).toBeNull();
    expect(mapAirflowDagToItem(42, ctx())).toBeNull();
  });

  test("returns null when dag_id is missing or empty", () => {
    const noId = makeDag();
    delete noId["dag_id"];
    expect(mapAirflowDagToItem(noId, ctx())).toBeNull();
    expect(mapAirflowDagToItem(makeDag({ dag_id: "" }), ctx())).toBeNull();
    expect(mapAirflowDagToItem(makeDag({ dag_id: 123 }), ctx())).toBeNull();
  });

  test("service/type fixed; externalId is the dag_id", () => {
    const row = mapAirflowDagToItem(makeDag(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("airflow");
    expect(row.type).toBe("dag");
    expect(row.externalId).toBe("nightly_etl");
  });

  test("title includes dag_id + description; url === canonicalUrl (grid page)", () => {
    const row = mapAirflowDagToItem(makeDag(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("nightly_etl — Nightly extract-transform-load pipeline");
    expect(row.url).toBe(row.canonicalUrl);
    expect(row.canonicalUrl).toBe("https://airflow.example.com/dags/nightly_etl/grid");
    expect(meta(row)["canonical_url"]).toBe(row.canonicalUrl);
  });

  test("title is just the dag_id when description absent", () => {
    const row = mapAirflowDagToItem(makeDag({ description: undefined }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("nightly_etl");
    expect(meta(row)["description"]).toBeNull();
  });

  test("extracts flat fields into metadata", () => {
    const row = mapAirflowDagToItem(makeDag(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["dag_id"]).toBe("nightly_etl");
    expect(m["is_paused"]).toBe(false);
    expect(m["is_active"]).toBe(true);
    expect(m["owners"]).toEqual(["data-eng", "platform"]);
    expect(m["description"]).toBe("Nightly extract-transform-load pipeline");
    expect(m["schedule_interval"]).toBe("0 2 * * *");
    expect(m["tags"]).toEqual(["etl", "tier-1"]);
    expect(m["fileloc"]).toBe("/opt/airflow/dags/nightly_etl.py");
  });

  test("is_paused / is_active true only when literally true", () => {
    const row = mapAirflowDagToItem(makeDag({ is_paused: "yes", is_active: 1 }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["is_paused"]).toBe(false);
    expect(meta(row)["is_active"]).toBe(false);
  });

  test("schedule_interval falls back to null when shape is unexpected", () => {
    const a = mapAirflowDagToItem(makeDag({ schedule_interval: "@daily" }), ctx());
    if (a === null) throw new Error("expected mapping to succeed");
    expect(meta(a)["schedule_interval"]).toBeNull();

    const b = mapAirflowDagToItem(makeDag({ schedule_interval: { __type: "None" } }), ctx());
    if (b === null) throw new Error("expected mapping to succeed");
    expect(meta(b)["schedule_interval"]).toBeNull();
  });

  test("parses next_dagrun and last_parsed_time into ms", () => {
    const row = mapAirflowDagToItem(makeDag(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["next_dagrun"]).toBe(Date.parse("2026-06-01T02:00:00+00:00"));
    expect(meta(row)["last_parsed_time"]).toBe(Date.parse("2026-05-31T12:00:00+00:00"));
  });

  test("tolerates non-array / non-string owners and non-object tags", () => {
    const a = mapAirflowDagToItem(makeDag({ owners: "nope", tags: "nope" }), ctx());
    if (a === null) throw new Error("expected mapping to succeed");
    expect(meta(a)["owners"]).toEqual([]);
    expect(meta(a)["tags"]).toEqual([]);

    const b = mapAirflowDagToItem(
      makeDag({ owners: [null, 7, "ok"], tags: [null, 7, { foo: "bar" }, { name: "ok-tag" }] }),
      ctx(),
    );
    if (b === null) throw new Error("expected mapping to succeed");
    expect(meta(b)["owners"]).toEqual(["ok"]);
    expect(meta(b)["tags"]).toEqual(["ok-tag"]);
  });

  test("modifiedAt prefers last_parsed_time, falls back to syncedAt", () => {
    const row = mapAirflowDagToItem(makeDag(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(Date.parse("2026-05-31T12:00:00+00:00"));

    const noParse = mapAirflowDagToItem(makeDag({ last_parsed_time: undefined }), ctx());
    if (noParse === null) throw new Error("expected mapping to succeed");
    expect(meta(noParse)["last_parsed_time"]).toBeNull();
    expect(noParse.modifiedAt).toBe(NOW);
  });

  test("syncedAt propagates", () => {
    const row = mapAirflowDagToItem(makeDag(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });

  test("long dag_id + description title is truncated with an ellipsis", () => {
    const longDesc = "x".repeat(300);
    const row = mapAirflowDagToItem(makeDag({ description: longDesc }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title.endsWith("…")).toBe(true);
    expect(row.title).toHaveLength(201);
  });
});

describe("dagUrl", () => {
  test("builds the grid page URL from the base", () => {
    expect(dagUrl("https://airflow.example.com", "my_dag")).toBe(
      "https://airflow.example.com/dags/my_dag/grid",
    );
  });

  test("trims a trailing slash off the base", () => {
    expect(dagUrl("https://airflow.example.com/", "my_dag")).toBe(
      "https://airflow.example.com/dags/my_dag/grid",
    );
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
