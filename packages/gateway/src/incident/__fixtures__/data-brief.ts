import type { IncidentDataBrief } from "../../agents/_lib/incident-types.ts";
import type { DataLane } from "../incident-record-types.ts";
import { buildInvestigationBriefFixture } from "./investigation-brief.ts";
import { buildPostmortemFixture } from "./postmortem-brief.ts";
import { buildRecord } from "./record-builder.ts";
import { buildUpdateBriefFixture } from "./update-brief.ts";

/** A data lane with one of everything, for the Data Incident Brief's render and reserved-section tests. */
export function buildDataLane(over: Partial<DataLane> = {}): DataLane {
  return {
    models: ["analytics.sales.orders"],
    lineage: [
      { model: "analytics.sales.orders", to: "raw.shop.orders", rule: "data:derived_from" },
    ],
    orchestration: [
      {
        id: "dbt:job1",
        service: "dbt",
        type: "job",
        title: "orders nightly",
        url: "https://dbt.example/jobs/1",
        atMs: null,
        rule: "name_match",
      },
    ],
    prs: [
      {
        id: "github:pr1",
        service: "github",
        type: "pull_request",
        title: "Rework orders model",
        url: "https://github.example/pr/1",
        atMs: 900_000,
        rule: "data:pr_title_or_branch",
      },
    ],
    runs: [
      {
        id: "airflow:orders_etl|r1",
        service: "airflow",
        type: "dag_run",
        job: "orders_etl",
        state: "failed",
        outcome: "failed",
        startMs: 600_000,
        endMs: 900_000,
        failedTasks: ["dedupe", "load_orders"],
        failedTaskCount: 3,
        trigger: "scheduled",
        url: "https://airflow.example/dags/orders_etl/grid?dag_run_id=r1",
        rule: "data:run_of_matched_job",
      },
    ],
    totals: { lineage: 1, orchestration: 1, prs: 1, runs: 1, dbtTests: 1 },
    dbtTests: [
      {
        id: "dbt:1:1:test.shop.not_null_orders_id.ab",
        title: "dbt test not_null_orders_id - fail",
        url: "https://dbt.example/runs/9",
        status: "fail",
        failures: 4,
        runId: 9,
        atMs: 950_000,
        model: "analytics.sales.orders",
        via: "monitored",
        rule: "data:dbt_test",
      },
    ],
    ...over,
  };
}

/** A valid Data Incident Brief over a Monte Carlo record. */
export function buildDataBriefFixture(
  over: { readonly data?: DataLane | null } = {},
): IncidentDataBrief {
  const record = buildRecord({
    service: "montecarlo",
    type: "data_quality_test",
    itemId: "montecarlo:t1",
  });
  return {
    kind: "incident_data",
    agentVersion: 1,
    generatedAt: 0,
    latencyMs: 0,
    gaps: [{ category: "missing_relation_emit", detail: "GAP-DETAIL-SENTINEL" }],
    record: {
      ...record,
      data: over.data === undefined ? buildDataLane() : over.data,
      freshness: {
        rows: [{ service: "montecarlo", connected: true, lastSyncMs: 1_000_000 }],
        chatToMs: null,
        onCallStale: null,
      },
    },
  };
}

/** The two record-derived brief kinds the all-kinds coverage table needs beyond `incident`. */
export function buildRecordKindFixtures() {
  return {
    incident_postmortem: buildPostmortemFixture(),
    incident_data: buildDataBriefFixture(),
    incident_investigation: buildInvestigationBriefFixture(),
    incident_update: buildUpdateBriefFixture(),
  } as const;
}
