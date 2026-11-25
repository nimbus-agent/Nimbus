import { describe, expect, test } from "bun:test";

import { buildDataBriefFixture, buildDataLane } from "../../incident/__fixtures__/data-brief.ts";
import { renderIncidentData } from "./incident-data-render.ts";
import { renderIncident } from "./incident-render.ts";
import { RESERVED_HEADINGS_BY_KIND, reservedBlocksFor } from "./reserved-sections.ts";
import { synthesize } from "./synthesize.ts";

describe("renderIncidentData", () => {
  test("leads with the data sections, in a fixed order, then the general ones", () => {
    const md = renderIncidentData(buildDataBriefFixture());
    const headings = md.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual([
      "## Summary",
      "## Monitored models",
      "## Built from",
      "## Jobs by name",
      "## Runs of those jobs",
      "## Merged before the alert",
      "## Schema changes",
      "## Service",
      "## Change",
      "## Concurrent",
      "## History",
      "## Gaps",
      "## Data freshness",
    ]);
    expect(md.startsWith("# Data incident ")).toBe(true);
    expect(md).toContain("- `analytics.sales.orders`");
    expect(md).toContain(
      "`analytics.sales.orders` is built from `raw.shop.orders` (rule: data:derived_from)",
    );
    expect(md).toContain("[orders nightly](https://dbt.example/jobs/1) - dbt (rule: name_match)");
    expect(md).toContain("merged 1970-01-01 00:15 UTC (rule: data:pr_title_or_branch)");
  });

  test("lists a failed run with its state, timing, failed tasks and trigger; logs are never claimed", () => {
    const md = renderIncidentData(buildDataBriefFixture());
    expect(md).toContain(
      "[orders_etl](https://airflow.example/dags/orders_etl/grid?dag_run_id=r1) - airflow run failed, started 1970-01-01 00:10 UTC, took 5m 0s, failed tasks: `dedupe`, `load_orders` (and 1 more), trigger scheduled (rule: data:run_of_matched_job)",
    );
    expect(md).toContain("logs are never indexed");
  });

  test("an empty run list says no run failed or ran in the window; an old record says runs were not recorded", () => {
    const none = renderIncidentData(
      buildDataBriefFixture({
        data: buildDataLane({
          runs: [],
          totals: { lineage: 1, orchestration: 1, prs: 1, runs: 0 },
        }),
      }),
    );
    expect(none).toContain(
      "_No run of the jobs listed above failed or ran in the incident window._",
    );
    const { runs: _runs, ...old } = buildDataLane();
    const md = renderIncidentData(buildDataBriefFixture({ data: old }));
    expect(md).toContain("_Runs were not recorded in this version of the record._");
  });

  test("lists schema changes with kind, column and types only, and says what it did not check", () => {
    const schemaDiff = {
      changes: [
        {
          model: "analytics.sales.orders",
          via: "monitored" as const,
          atMs: 900_000,
          kind: "type_changed" as const,
          column: "amount",
          from: "NUMBER",
          to: "TEXT",
          rule: "data:schema_history" as const,
        },
        {
          model: "raw.shop.orders",
          via: "upstream" as const,
          atMs: 800_000,
          kind: "dropped" as const,
          column: "legacy",
          from: "DATE",
          to: null,
          rule: "data:schema_history" as const,
        },
        {
          model: "raw.shop.orders",
          via: "upstream" as const,
          atMs: 700_000,
          kind: "nullability_changed" as const,
          column: "id",
          from: "nullable",
          to: "required",
          rule: "data:schema_history" as const,
        },
      ],
      total: 5,
      windowFromMs: 0,
      lookbackHours: 24,
    };
    const md = renderIncidentData(buildDataBriefFixture({ data: buildDataLane({ schemaDiff }) }));
    expect(md).toContain(
      "`analytics.sales.orders` (monitored): column `amount` type NUMBER -> TEXT (rule: data:schema_history)",
    );
    expect(md).toContain("column `legacy` dropped (was DATE)");
    expect(md).toContain("column `id` nullable -> required");
    expect(md).toContain("_and 2 more_");
    expect(md).toContain("24 h before the alert");
    const none = renderIncidentData(
      buildDataBriefFixture({
        data: buildDataLane({ schemaDiff: { ...schemaDiff, changes: [], total: 0 } }),
      }),
    );
    expect(none).toContain("_No schema change of a monitored or upstream table was observed");
    expect(renderIncidentData(buildDataBriefFixture())).toContain(
      "_Schema changes were not checked for this record._",
    );
    // the general incident brief carries the same lines in its Data section
    const general = renderIncident(
      buildDataBriefFixture({ data: buildDataLane({ schemaDiff }) }) as never,
    );
    expect(general).toContain("column `legacy` dropped (was DATE)");
  });

  test("a hostile column name cannot add a heading or a link", () => {
    const schemaDiff = {
      changes: [
        {
          model: "a.b.c",
          via: "monitored" as const,
          atMs: 1,
          kind: "added" as const,
          column: "x`\n## Injected [click](http://evil.example)",
          from: null,
          to: "STRING",
          rule: "data:schema_history" as const,
        },
      ],
      total: 1,
      windowFromMs: 0,
      lookbackHours: 24,
    };
    const md = renderIncidentData(buildDataBriefFixture({ data: buildDataLane({ schemaDiff }) }));
    expect(md.split("\n").filter((l) => l.startsWith("## "))).not.toContain(
      "## Injected [click](http://evil.example)",
    );
    // the bracket is escaped, so no link is formed
    expect(md).not.toMatch(/[^\\]\]\(http:\/\/evil/);
  });

  test("says that jobs are matched by name, never by lineage", () => {
    expect(renderIncidentData(buildDataBriefFixture())).toContain("not by lineage");
  });

  test("names an empty lane honestly: no monitored table is not 'nothing is wrong'", () => {
    const md = renderIncidentData(
      buildDataBriefFixture({
        data: buildDataLane({
          models: [],
          lineage: [],
          orchestration: [],
          prs: [],
          runs: [],
          totals: { lineage: 0, orchestration: 0, prs: 0, runs: 0 },
        }),
      }),
    );
    expect(md).toContain("_No monitored table._");
    expect(md).toContain("_No upstream model recorded for the monitored table._");
    expect(md).toContain("_No orchestration job matched by name._");
    expect(md).toContain("_No orchestration job matched, so no run was looked up._");
    expect(md).toContain("_No change merged in the 24 hours before the alert matched by name._");
  });

  test("a record with no data lane still renders, and says so", () => {
    const md = renderIncidentData(buildDataBriefFixture({ data: null }));
    expect(md).toContain("_No data lane was recorded for this trigger._");
  });

  test("counts what a cut list hides", () => {
    const md = renderIncidentData(
      buildDataBriefFixture({
        data: buildDataLane({ totals: { lineage: 4, orchestration: 3, prs: 2 } }),
      }),
    );
    expect(md).toContain("_and 3 more_");
    expect(md).toContain("_and 2 more_");
    expect(md).toContain("_and 1 more_");
  });

  test("a hostile title cannot add a heading or a link", () => {
    const brief = buildDataBriefFixture();
    const lane = buildDataLane({
      orchestration: [
        {
          id: "dbt:j",
          service: "dbt",
          type: "job",
          title: "x\n## Gaps\n[evil](http://e.example)",
          url: null,
          atMs: null,
          rule: "name_match",
        },
      ],
    });
    const md = renderIncidentData({ ...brief, record: { ...brief.record, data: lane } });
    expect(md.split("\n").filter((l) => l === "## Gaps")).toHaveLength(1);
    expect(md).not.toContain("[evil](http://e.example)");
  });

  test("omitReserved withholds the gaps and freshness blocks and nothing else", () => {
    const brief = buildDataBriefFixture();
    const body = renderIncidentData(brief, { omitReserved: true });
    expect(body).not.toContain("## Gaps");
    expect(body).not.toContain("## Data freshness");
    expect(body).toContain("## Monitored models");
  });

  test("differs from the general brief only in the data presentation: the same facts", () => {
    const brief = buildDataBriefFixture();
    const general = renderIncident({ ...brief, kind: "incident" });
    const data = renderIncidentData(brief);
    for (const fact of ["analytics.sales.orders", "raw.shop.orders", "orders nightly"]) {
      expect(general).toContain(fact);
      expect(data).toContain(fact);
    }
  });
});

describe("incident_data in the I31 machinery", () => {
  test("reserves ## Gaps and ## Data freshness, built from the brief itself", () => {
    expect(RESERVED_HEADINGS_BY_KIND.incident_data).toEqual(["## Gaps", "## Data freshness"]);
    const blocks = reservedBlocksFor(buildDataBriefFixture());
    expect(blocks.map((b) => b.heading)).toEqual(["## Gaps", "## Data freshness"]);
  });

  test("synthesize with no runner is the deterministic render (no model is reachable)", async () => {
    const brief = buildDataBriefFixture();
    const out = await synthesize(brief);
    expect(out.markdown).toContain(renderIncidentData(brief).trimEnd());
    expect(out.provenance.attempted).toBe(false);
  });
});
