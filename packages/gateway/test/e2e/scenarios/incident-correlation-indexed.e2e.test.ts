import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { mapBigeyeIssueToItem } from "../../../src/connectors/bigeye-dq-mapping.ts";
import {
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "../../../src/connectors/connector-sync-test-helpers.ts";
import { githubActionsRunMetadata } from "../../../src/connectors/github-actions-sync.ts";
import { extractPrMetadataForIndex } from "../../../src/connectors/github-sync.ts";
import { mapJsmAlertToItem } from "../../../src/connectors/jsm-alert-mapping.ts";
import { mapMonteCarloIncidentToItem } from "../../../src/connectors/monte-carlo-dq-mapping.ts";
import { syncPagerdutyIncidentItems } from "../../../src/connectors/pagerduty-sync.ts";
import { mapSentryIssueToItem } from "../../../src/connectors/sentry-issue-mapping.ts";
import { annotateDeployment } from "../../../src/deployment/annotate.ts";
import { graphAnnotatedDeployment } from "../../../src/deployment/graph-annotated.ts";
import { runPendingRegraph } from "../../../src/graph/regraph-once.ts";
import { traverseGraph } from "../../../src/graph/relationship-graph.ts";
import { upsertIndexedItem } from "../../../src/index/item-store.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { NO_INCIDENT_BINDINGS, type ServiceConfig } from "../../../src/metrics/dora-config.ts";
import { buildServiceIdentityResolver } from "../../../src/metrics/service-identity.ts";

const HOUR = 3_600_000;
const T = Date.parse("2026-11-10T12:00:00.000Z");
const OPEN = T + HOUR;
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

const CONFIGS = new Map<string, ServiceConfig>([
  [
    "payment-service",
    {
      serviceId: "payment-service",
      repos: [{ provider: "github", providerId: "acme/payment-service" }],
      pagerdutyServices: ["PSVC1"],
      deployWorkflowPattern: /^Deploy/,
      incidentWindowMinutes: 60,
      excludePrLabels: [],
      deployEnvironments: ["prod"],
      severityP1Aliases: [],
      ...NO_INCIDENT_BINDINGS,
      jsmAlertTags: ["payments"],
      sentryProjects: ["payments-api"],
      dataModels: ["analytics.payments.*"],
    },
  ],
  [
    "checkout",
    {
      serviceId: "checkout",
      repos: [{ provider: "github", providerId: "acme/checkout" }],
      pagerdutyServices: [],
      deployWorkflowPattern: /^Deploy/,
      incidentWindowMinutes: 60,
      excludePrLabels: [],
      deployEnvironments: ["prod"],
      severityP1Aliases: [],
      ...NO_INCIDENT_BINDINGS,
      dependsOn: ["payment-service"],
    },
  ],
]);
const resolver = buildServiceIdentityResolver(CONFIGS);

type Writer = (db: Database) => void;

const ctx = (
  db: Database,
  service: "pagerduty" | "jira" | "sentry" | "montecarlo" | "bigeye" | "slack",
): ReturnType<typeof syncTestContext> =>
  syncTestContext(db, EMPTY_NIMBUS_VAULT, service, "full", resolver);

const WRITERS: Record<string, Writer> = {
  deployment: (db) => {
    const r = annotateDeployment(
      db,
      {
        service: "payment-service",
        provider: "github-actions",
        environment: "prod",
        sha: SHA,
        ref: "main",
        status: "success",
        started_at_ms: T,
        run_id: "7412",
      },
      T,
    );
    graphAnnotatedDeployment(db, `deployment:${r.external_id}`, resolver);
  },
  pr: (db) => {
    upsertIndexedItem(
      db,
      {
        service: "github",
        type: "pr",
        externalId: "acme/payment-service#501",
        title: "Mitigate payment latency",
        bodyPreview: "",
        modifiedAt: T,
        syncedAt: T,
        metadata: extractPrMetadataForIndex(
          "acme/payment-service",
          {
            number: 501,
            state: "closed",
            merged: true,
            merged_at: new Date(T).toISOString(),
            merge_commit_sha: SHA,
          },
          T,
        ),
      },
      resolver,
    );
  },
  ciRun: (db) => {
    upsertIndexedItem(
      db,
      {
        service: "github_actions",
        type: "ci_run",
        externalId: "acme/payment-service#run-7412",
        title: "Deploy run",
        bodyPreview: "",
        modifiedAt: T,
        syncedAt: T,
        metadata: githubActionsRunMetadata(
          "acme/payment-service",
          { id: 7412, name: "Deploy", status: "completed", conclusion: "success", head_sha: SHA },
          T,
        ),
      },
      resolver,
    );
  },
  pagerduty: (db) => {
    syncPagerdutyIncidentItems(
      ctx(db, "pagerduty"),
      [
        {
          id: "PD1",
          title: "payment-service incident: elevated 5xx",
          status: "triggered",
          created_at: new Date(OPEN).toISOString(),
          updated_at: new Date(OPEN + 4 * HOUR).toISOString(),
          service: { id: "PSVC1" },
        },
      ],
      "",
      OPEN,
      new Map(),
    );
  },
  jsmAlert: (db) => {
    const row = mapJsmAlertToItem(
      {
        id: "AL1",
        message: "payment-service incident alert",
        status: "open",
        createdAt: new Date(OPEN).toISOString(),
        updatedAt: new Date(OPEN).toISOString(),
        tags: ["payments"],
      },
      { syncedAt: OPEN },
    );
    if (row === null) throw new Error("alert");
    ctx(db, "jira").upsertItem(row);
  },
  sentry: (db) => {
    const row = mapSentryIssueToItem(
      {
        id: "SN1",
        title: "payment-service incident TypeError",
        status: "unresolved",
        firstSeen: new Date(OPEN).toISOString(),
        lastSeen: new Date(OPEN + 6 * HOUR).toISOString(),
        project: { slug: "payments-api" },
      },
      { org: "acme", syncedAt: OPEN },
    );
    if (row === null) throw new Error("sentry");
    ctx(db, "sentry").upsertItem(row);
  },
  montecarlo: (db) => {
    const row = mapMonteCarloIncidentToItem(
      {
        incidentId: "MC1",
        status: "open",
        monitoredTable: "analytics.payments.orders",
        firstSeenAt: new Date(OPEN).toISOString(),
      },
      { syncedAt: OPEN + 2 * HOUR },
    );
    if (row === null) throw new Error("mc");
    ctx(db, "montecarlo").upsertItem(row);
  },
  bigeye: (db) => {
    const row = mapBigeyeIssueToItem(
      {
        issueId: "BE1",
        slaStatus: "ok",
        anomaly: "a",
        monitoredTable: "analytics.payments.orders",
      },
      { syncedAt: OPEN },
    );
    if (row === null) throw new Error("bigeye");
    ctx(db, "bigeye").upsertItem(row);
  },
  unboundAlert: (db) => {
    const row = mapJsmAlertToItem(
      {
        id: "AL9",
        message: "unrelated",
        status: "open",
        createdAt: new Date(OPEN).toISOString(),
        updatedAt: new Date(OPEN).toISOString(),
        tags: ["something-else"],
      },
      { syncedAt: OPEN },
    );
    if (row === null) throw new Error("alert");
    ctx(db, "jira").upsertItem(row);
  },
  stagingDeployment: (db) => {
    const r = annotateDeployment(
      db,
      {
        service: "payment-service",
        provider: "github-actions",
        environment: "staging",
        sha: SHA,
        ref: "main",
        status: "success",
        started_at_ms: T,
        run_id: "7500",
      },
      T,
    );
    graphAnnotatedDeployment(db, `deployment:${r.external_id}`, resolver);
  },
};

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

type Edge = { type: string; from: string; to: string };

function edgeSet(db: Database): string[] {
  const rows = db
    .query(
      `SELECT r.type AS type, f.type || ':' || f.external_id AS "from", t.type || ':' || t.external_id AS "to"
         FROM graph_relation r
         JOIN graph_entity f ON f.id = r.from_id
         JOIN graph_entity t ON t.id = r.to_id
        WHERE r.type IN ('correlates_with', 'deployed', 'built_by', 'merged_as')`,
    )
    .all() as Edge[];
  return rows.map((e) => `${e.type} ${e.from} -> ${e.to}`).sort();
}

const MAIN = [
  "deployment",
  "pr",
  "ciRun",
  "pagerduty",
  "jsmAlert",
  "sentry",
  "montecarlo",
  "bigeye",
] as const;

function writeAll(db: Database, order: readonly string[]): void {
  for (const k of order) (WRITERS[k] as Writer)(db);
}

describe("incident correlation, driven by the real writers (Phase 10 IC2)", () => {
  test("every trigger kind correlates with the deployment, which is linked to its commit, PR and CI run", () => {
    const db = freshDb();
    writeAll(db, [...MAIN, "unboundAlert", "stagingDeployment"]);
    const edges = edgeSet(db);
    const dep = (
      db
        .query(
          "SELECT external_id AS e FROM graph_entity WHERE type='deployment' AND external_id LIKE '%run-7412'",
        )
        .get() as { e: string }
    ).e;
    for (const trigger of [
      "incident:pagerduty:PD1",
      "alert:jira:AL1",
      "error_issue:sentry:SN1",
      "data_quality_test:montecarlo:MC1",
      "data_quality_test:bigeye:BE1",
    ]) {
      expect(edges, trigger).toContain(`correlates_with deployment:${dep} -> ${trigger}`);
    }
    expect(edges).toContain(`deployed deployment:${dep} -> commit:github:${SHA}`);
    expect(edges).toContain(
      `built_by deployment:${dep} -> ci_run:github_actions:acme/payment-service#run-7412`,
    );
    expect(edges).toContain(`merged_as pr:github:acme/payment-service#501 -> commit:github:${SHA}`);
    // The unbound alert and the staging deployment correlate with nothing.
    expect(edges.some((e) => e.includes("alert:jira:AL9"))).toBe(false);
    expect(edges.some((e) => e.startsWith("correlates_with") && e.includes("run-7500"))).toBe(
      false,
    );
  });

  test("traverseGraph from the PagerDuty incident reaches the deployment, PR and CI run", () => {
    const db = freshDb();
    writeAll(db, MAIN);
    const sub = traverseGraph(db, "pagerduty:PD1", { depth: 4, maxNodes: 80 });
    expect(sub).not.toHaveProperty("error");
    if ("error" in sub) return;
    const ext = new Set(sub.entities.map((e) => e.external_id));
    expect(ext.has("github:acme/payment-service#501")).toBe(true);
    expect(ext.has("github_actions:acme/payment-service#run-7412")).toBe(true);
    expect([...ext].some((e) => e.endsWith("run-7412") && e.startsWith("deployment:"))).toBe(true);
  });

  test("writing everything in reverse order yields the identical edge set", () => {
    const forward = freshDb();
    writeAll(forward, MAIN);
    const reverse = freshDb();
    writeAll(reverse, [...MAIN].reverse());
    expect(edgeSet(reverse)).toEqual(edgeSet(forward));
    expect(edgeSet(forward).length).toBeGreaterThanOrEqual(8);
  });

  test("the one-shot re-graph restores the same edges on a database with the pre-IC2 shape", async () => {
    const reference = freshDb();
    writeAll(reference, MAIN);
    const db = freshDb();
    writeAll(db, MAIN);
    db.run(
      "DELETE FROM graph_entity WHERE type IN ('deployment','incident','error_issue','data_quality_test','alert')",
    );
    expect(edgeSet(db).filter((e) => e.startsWith("correlates_with"))).toEqual([]);
    db.run("INSERT OR IGNORE INTO _meta (key, value) VALUES ('regraph_pending_ic2', '1')");
    const out = await runPendingRegraph(db, { buildResolver: () => resolver });
    expect(out).toEqual({ ran: true, cleared: true });
    // The alert is not in the IC2 slice list (it is new in IC2 and was never graphed before), so it is
    // compared without its edge.
    const strip = (xs: string[]): string[] => xs.filter((e) => !e.includes("alert:jira"));
    expect(strip(edgeSet(db))).toEqual(strip(edgeSet(reference)));
  });

  test("the search still finds the rows the real writers produced across services", () => {
    const db = freshDb();
    writeAll(db, MAIN);
    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: "C09INCIDENT:1700000000.000100",
      title: "payment-service incident war room",
      bodyPreview: "payment-service incident thread",
      modifiedAt: OPEN,
      syncedAt: OPEN,
      metadata: { channel: "C09INCIDENT" },
    });
    const idx = new LocalIndex(db);
    const ranked = idx.searchRanked({ name: "payment-service incident", limit: 40 }, {});
    const svc = new Set(ranked.map((r) => r.service));
    for (const s of ["pagerduty", "jira", "sentry", "slack"]) expect(svc.has(s), s).toBe(true);
    idx.close();
  });
});
