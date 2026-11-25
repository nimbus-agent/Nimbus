import { describe, expect, test } from "bun:test";

import { buildDataLane } from "./__fixtures__/data-brief.ts";
import { buildRecord } from "./__fixtures__/record-builder.ts";
import { citedServicesOf } from "./assemble.ts";

describe("citedServicesOf and the dbt tests", () => {
  const base = buildDataLane();

  test("a record that lists dbt tests cites dbt", () => {
    expect(citedServicesOf({ ...buildRecord(), data: base })).toContain("dbt");
  });

  test("a size cut that emptied the list but kept a positive total still cites dbt (erasure must find it)", () => {
    const cut = {
      ...base,
      orchestration: [],
      prs: [],
      dbtTests: [],
      totals: { ...base.totals, dbtTests: 3 },
    };
    expect(citedServicesOf({ ...buildRecord(), data: cut })).toContain("dbt");
  });

  test("a recorded zero total and a record with no dbt field do not cite dbt", () => {
    const none = {
      ...base,
      orchestration: [],
      prs: [],
      dbtTests: [],
      totals: { ...base.totals, dbtTests: 0 },
    };
    expect(citedServicesOf({ ...buildRecord(), data: none })).not.toContain("dbt");
    const { dbtTests: _d, ...old } = none;
    const { dbtTests: _t, ...totals } = old.totals;
    expect(citedServicesOf({ ...buildRecord(), data: { ...old, totals } })).not.toContain("dbt");
  });
});
