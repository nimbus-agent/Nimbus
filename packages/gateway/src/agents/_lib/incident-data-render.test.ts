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
      "## dbt tests",
      "## Merged before the alert",
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
          totals: { lineage: 0, orchestration: 0, prs: 0 },
        }),
      }),
    );
    expect(md).toContain("_No monitored table._");
    expect(md).toContain("_No upstream model recorded for the monitored table._");
    expect(md).toContain("_No orchestration job matched by name._");
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
