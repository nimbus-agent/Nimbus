import { describe, expect, test } from "bun:test";

import { filterAirflowDags } from "../src/search-filter.ts";

function dag(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dag_id: "nightly_etl",
    is_paused: false,
    is_active: true,
    owners: ["data-eng", "platform"],
    description: "Nightly extract-transform-load pipeline",
    schedule_interval: { __type: "CronExpression", value: "0 2 * * *" },
    tags: [{ name: "etl" }, { name: "tier-1" }],
    fileloc: "/opt/airflow/dags/nightly_etl.py",
    ...over,
  };
}

describe("filterAirflowDags", () => {
  test("matches against the dag_id (case-insensitive)", () => {
    expect(filterAirflowDags([dag()], { query: "NIGHTLY" })).toHaveLength(1);
  });

  test("matches against description, owners, and tag names", () => {
    expect(filterAirflowDags([dag()], { query: "extract-transform" })).toHaveLength(1);
    expect(filterAirflowDags([dag()], { query: "platform" })).toHaveLength(1);
    expect(filterAirflowDags([dag()], { query: "etl" })).toHaveLength(1);
    expect(filterAirflowDags([dag()], { query: "tier-1" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterAirflowDags([dag()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips entries that are not objectish", () => {
    expect(filterAirflowDags([null, 42, "x", dag()], { query: "nightly" })).toHaveLength(1);
  });

  test("tolerates missing string fields and a non-array owners/tags value", () => {
    const sparse = dag({ description: undefined, owners: "nope", tags: "nope" });
    expect(filterAirflowDags([sparse], { query: "nightly" })).toHaveLength(1);
    expect(filterAirflowDags([sparse], { query: "tier-1" })).toHaveLength(0);
  });

  test("tolerates non-string owner entries and non-object tag entries", () => {
    const odd = dag({
      owners: [null, 7, "ok-owner"],
      tags: [null, 7, { foo: "bar" }, { name: "zzqtag" }],
    });
    expect(filterAirflowDags([odd], { query: "ok-owner" })).toHaveLength(1);
    expect(filterAirflowDags([odd], { query: "zzqtag" })).toHaveLength(1);
    expect(filterAirflowDags([odd], { query: "bar" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => dag({ dag_id: `nightly_etl_${String(i)}` }));
    expect(filterAirflowDags(many, { query: "nightly", limit: 3 })).toHaveLength(3);
  });
});
