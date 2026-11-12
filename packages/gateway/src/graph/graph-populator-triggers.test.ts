import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { mapBigeyeIssueToItem } from "../connectors/bigeye-dq-mapping.ts";
import { EMPTY_NIMBUS_VAULT, syncTestContext } from "../connectors/connector-sync-test-helpers.ts";
import { mapJsmAlertToItem } from "../connectors/jsm-alert-mapping.ts";
import { mapMonteCarloIncidentToItem } from "../connectors/monte-carlo-dq-mapping.ts";
import { syncPagerdutyIncidentItems } from "../connectors/pagerduty-sync.ts";
import { mapSentryIssueToItem } from "../connectors/sentry-issue-mapping.ts";
import { specFor } from "../index/item-history-keys.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { NO_INCIDENT_BINDINGS, type ServiceConfig } from "../metrics/dora-config.ts";
import { buildServiceIdentityResolver } from "../metrics/service-identity.ts";
import type { SyncContext } from "../sync/types.ts";
import { CORRELATION_WINDOW_MS, syncGraphFromIndexedItem } from "./graph-populator.ts";
import { regraphAllItems } from "./regraph.ts";

const HOUR = 3_600_000;
const T = Date.parse("2026-11-10T12:00:00.000Z");

const PAYMENTS: ServiceConfig = {
  serviceId: "payments",
  repos: [{ provider: "github", providerId: "acme/payments" }],
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
};

const resolver = buildServiceIdentityResolver(new Map([["payments", PAYMENTS]]));

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function ctxFor(
  db: Database,
  service: "pagerduty" | "jira" | "sentry" | "montecarlo" | "bigeye",
): SyncContext {
  return syncTestContext(db, EMPTY_NIMBUS_VAULT, service, "full", resolver);
}

function deploy(db: Database, at: number, env = "prod", externalId = "dep-1"): void {
  upsertIndexedItem(
    db,
    {
      service: "deploy-annotate",
      type: "deployment",
      externalId,
      title: "Deploy payments",
      bodyPreview: "",
      modifiedAt: at,
      syncedAt: at,
      metadata: { nimbus_service_id: "payments", environment: env, sha: "abc1234" },
    },
    resolver,
  );
}

function pdIncident(db: Database, openedAt: number, updatedAt: number, service = "PSVC1"): void {
  syncPagerdutyIncidentItems(
    ctxFor(db, "pagerduty"),
    [
      {
        id: "PD1",
        title: "Payments 5xx",
        status: "triggered",
        created_at: new Date(openedAt).toISOString(),
        updated_at: new Date(updatedAt).toISOString(),
        service: { id: service },
      },
    ],
    "",
    updatedAt,
    new Map(),
  );
}

function alert(db: Database, openedAt: number, tags: string[] = ["payments"]): void {
  const row = mapJsmAlertToItem(
    {
      id: "AL1",
      message: "Payments alert",
      status: "open",
      createdAt: new Date(openedAt).toISOString(),
      updatedAt: new Date(openedAt + 5 * HOUR).toISOString(),
      tags,
    },
    { syncedAt: openedAt },
  );
  if (row === null) throw new Error("alert did not map");
  ctxFor(db, "jira").upsertItem(row);
}

function sentry(db: Database, firstSeen: number, lastSeen: number, project = "payments-api"): void {
  const row = mapSentryIssueToItem(
    {
      id: "SN1",
      title: "TypeError",
      status: "unresolved",
      level: "error",
      firstSeen: new Date(firstSeen).toISOString(),
      lastSeen: new Date(lastSeen).toISOString(),
      project: { slug: project },
      assignedTo: { type: "user", email: "dev@example.com", id: "u1", name: "Dev" },
    },
    { org: "acme", syncedAt: lastSeen },
  );
  if (row === null) throw new Error("sentry did not map");
  ctxFor(db, "sentry").upsertItem(row);
}

function monteCarlo(db: Database, firstSeen: number, table = "Analytics.Payments.Orders"): void {
  const row = mapMonteCarloIncidentToItem(
    {
      incidentId: "MC1",
      status: "open",
      severity: "SEV2",
      monitoredTable: table,
      firstSeenAt: new Date(firstSeen).toISOString(),
    },
    { syncedAt: firstSeen + 3 * HOUR },
  );
  if (row === null) throw new Error("mc did not map");
  ctxFor(db, "montecarlo").upsertItem(row);
}

function bigeye(db: Database, syncedAt: number, table = "analytics.payments.orders"): void {
  const row = mapBigeyeIssueToItem(
    { issueId: "BE1", slaStatus: "ok", anomaly: "a", monitoredTable: table },
    { syncedAt },
  );
  if (row === null) throw new Error("bigeye did not map");
  ctxFor(db, "bigeye").upsertItem(row);
}

type Edge = { from: string; to: string };

function correlations(db: Database): Edge[] {
  return db
    .query(
      `SELECT f.type || ':' || f.external_id AS "from", t.type || ':' || t.external_id AS "to"
         FROM graph_relation r
         JOIN graph_entity f ON f.id = r.from_id
         JOIN graph_entity t ON t.id = r.to_id
        WHERE r.type = 'correlates_with'
        ORDER BY "from", "to"`,
    )
    .all() as Edge[];
}

function entityMeta(db: Database, type: string): Record<string, unknown> {
  const row = db.query("SELECT metadata FROM graph_entity WHERE type = ?").get(type) as {
    metadata: string;
  } | null;
  if (row === null) throw new Error(`no ${type} entity`);
  return JSON.parse(row.metadata) as Record<string, unknown>;
}

function relationCount(db: Database, type: string): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = ?").get(type) as { n: number }
  ).n;
}

const OPEN = T + HOUR;

type Trigger = { kind: string; entity: string; write: (db: Database, at: number) => void };

const TRIGGERS: Trigger[] = [
  {
    kind: "incident",
    entity: "incident:pagerduty:PD1",
    write: (db, at) => pdIncident(db, at, at + 9 * HOUR),
  },
  { kind: "alert", entity: "alert:jira:AL1", write: (db, at) => alert(db, at) },
  {
    kind: "error_issue",
    entity: "error_issue:sentry:SN1",
    write: (db, at) => sentry(db, at, at + 9 * HOUR),
  },
  {
    kind: "data_quality_test",
    entity: "data_quality_test:montecarlo:MC1",
    write: (db, at) => monteCarlo(db, at),
  },
];

describe("the open-time anchor", () => {
  test("a PagerDuty incident anchors on opened_at_ms, not on updated_at", () => {
    const db = freshDb();
    pdIncident(db, OPEN, OPEN + 7 * HOUR);
    expect(entityMeta(db, "incident")["occurredAt"]).toBe(OPEN);
  });

  test("a Sentry issue anchors on firstSeen and a later lastSeen re-sync does not move it", () => {
    const db = freshDb();
    sentry(db, OPEN, OPEN + HOUR);
    expect(entityMeta(db, "error_issue")["occurredAt"]).toBe(OPEN);
    sentry(db, OPEN, OPEN + 30 * HOUR);
    expect(entityMeta(db, "error_issue")["occurredAt"]).toBe(OPEN);
  });

  test("a Monte Carlo test anchors on firstSeenAt", () => {
    const db = freshDb();
    monteCarlo(db, OPEN);
    expect(entityMeta(db, "data_quality_test")["occurredAt"]).toBe(OPEN);
  });

  test("a Bigeye test uses modified_at the first time and keeps that anchor across re-syncs", () => {
    const db = freshDb();
    bigeye(db, OPEN);
    expect(entityMeta(db, "data_quality_test")["occurredAt"]).toBe(OPEN);
    bigeye(db, OPEN + 20 * HOUR);
    expect(entityMeta(db, "data_quality_test")["occurredAt"]).toBe(OPEN);
  });

  test("a jira:alert anchors on opened_at_ms", () => {
    const db = freshDb();
    alert(db, OPEN);
    expect(entityMeta(db, "alert")["occurredAt"]).toBe(OPEN);
  });

  test("a malformed or absent open time falls to the next rule and never throws", () => {
    const db = freshDb();
    for (const [i, bad] of [undefined, "soon", Number.NaN, null].entries()) {
      upsertIndexedItem(
        db,
        {
          service: "pagerduty",
          type: "incident",
          externalId: `bad-${String(i)}`,
          title: "t",
          bodyPreview: "",
          modifiedAt: OPEN,
          syncedAt: OPEN,
          metadata: {
            pagerduty_service_id: "PSVC1",
            ...(bad === undefined ? {} : { opened_at_ms: bad }),
          },
        },
        resolver,
      );
    }
    const rows = db.query("SELECT metadata FROM graph_entity WHERE type = 'incident'").all() as {
      metadata: string;
    }[];
    expect(rows).toHaveLength(4);
    for (const r of rows)
      expect((JSON.parse(r.metadata) as { occurredAt: number }).occurredAt).toBe(OPEN);
  });

  test("regraph reads the anchor from parsed metadata and survives unparseable metadata", () => {
    const db = freshDb();
    pdIncident(db, OPEN, OPEN + 7 * HOUR);
    db.run("UPDATE item SET metadata = '{not json' WHERE type = 'incident'");
    const out = regraphAllItems(db, { resolveServiceId: resolver });
    expect(out.skipped).toBe(0);
    // Unparseable metadata falls back to modified_at.
    expect(entityMeta(db, "incident")["occurredAt"]).toBe(OPEN + 7 * HOUR);
  });

  test("the graph anchor and IC1's born definition are the same for the four tracked trigger types", () => {
    const born = (s: string, t: string): string | undefined => specFor(s, t)?.born?.key;
    expect(born("pagerduty", "incident")).toBe("opened_at_ms");
    expect(born("jira", "alert")).toBe("opened_at_ms");
    expect(born("sentry", "error_issue")).toBe("firstSeen");
    expect(born("montecarlo", "data_quality_test")).toBe("firstSeenAt");
    expect(specFor("bigeye", "data_quality_test")?.born).toBeNull();
  });
});

describe("correlation of the four trigger kinds with deployments", () => {
  for (const trigger of TRIGGERS) {
    test(`${trigger.kind}: a deployment of the same service inside [open - 2h, open] correlates`, () => {
      const db = freshDb();
      deploy(db, OPEN - HOUR);
      trigger.write(db, OPEN);
      expect(correlations(db)).toEqual([
        { from: "deployment:deploy-annotate:dep-1", to: trigger.entity },
      ]);
    });

    test(`${trigger.kind}: outside the window, or before the deployment, it does not`, () => {
      const db = freshDb();
      deploy(db, OPEN - CORRELATION_WINDOW_MS - HOUR);
      trigger.write(db, OPEN);
      expect(correlations(db)).toEqual([]);
      const later = freshDb();
      deploy(later, OPEN + HOUR);
      trigger.write(later, OPEN);
      expect(correlations(later)).toEqual([]);
    });

    test(`${trigger.kind}: the edge is the same whichever side syncs last`, () => {
      const a = freshDb();
      deploy(a, OPEN - HOUR);
      trigger.write(a, OPEN);
      const b = freshDb();
      trigger.write(b, OPEN);
      deploy(b, OPEN - HOUR);
      expect(correlations(b)).toEqual(correlations(a));
      expect(correlations(b)).toHaveLength(1);
    });
  }

  test("an unbound trigger produces no edge and keeps affectedService null", () => {
    const db = freshDb();
    deploy(db, OPEN - HOUR);
    alert(db, OPEN, ["unclaimed"]);
    expect(correlations(db)).toEqual([]);
    expect(entityMeta(db, "alert")["affectedService"]).toBeNull();
  });

  test("a gate-excluded (preview) deployment binds nothing", () => {
    const db = freshDb();
    deploy(db, OPEN - HOUR, "preview");
    alert(db, OPEN);
    expect(correlations(db)).toEqual([]);
  });

  test("re-syncing a trigger with a different service retires the old incoming edge", () => {
    const db = freshDb();
    deploy(db, OPEN - HOUR);
    alert(db, OPEN);
    expect(correlations(db)).toHaveLength(1);
    alert(db, OPEN, ["unclaimed"]);
    expect(correlations(db)).toEqual([]);
  });

  test("a deployment correlates with every trigger kind in its window", () => {
    const db = freshDb();
    deploy(db, OPEN - HOUR);
    for (const t of TRIGGERS) t.write(db, OPEN);
    expect(correlations(db).map((e) => e.to)).toEqual(TRIGGERS.map((t) => t.entity).sort());
  });
});

describe("the trigger sync keeps the edges it already wrote", () => {
  test("a Monte Carlo test keeps its monitors edges after the correlation ran", () => {
    const db = freshDb();
    deploy(db, OPEN - HOUR);
    monteCarlo(db, OPEN);
    expect(correlations(db)).toHaveLength(1);
    expect(relationCount(db, "monitors")).toBe(1);
    expect(entityMeta(db, "data_quality_test")["affectedService"]).toBe("payments");
  });

  test("a Sentry issue keeps its belongs_to and assigned edges and its project metadata", () => {
    const db = freshDb();
    deploy(db, OPEN - HOUR);
    sentry(db, OPEN, OPEN + HOUR);
    expect(correlations(db)).toHaveLength(1);
    expect(relationCount(db, "belongs_to")).toBe(1);
    expect(relationCount(db, "assigned")).toBe(1);
    const meta = entityMeta(db, "error_issue");
    expect(meta["project"]).toBe("payments-api");
    expect(meta["occurredAt"]).toBe(OPEN);
    expect(meta["affectedService"]).toBe("payments");
  });

  test("an alert gets no person edges", () => {
    const db = freshDb();
    alert(db, OPEN);
    expect(relationCount(db, "assigned")).toBe(0);
    expect(relationCount(db, "resolves")).toBe(0);
  });
});

describe("the type table", () => {
  test("an alert row becomes an alert entity; a type named constructor is ignored", () => {
    const db = freshDb();
    alert(db, OPEN);
    expect(db.query("SELECT COUNT(*) AS n FROM graph_entity WHERE type = 'alert'").get()).toEqual({
      n: 1,
    });
    expect(() =>
      syncGraphFromIndexedItem(db, {
        id: "x:y",
        service: "x",
        type: "constructor",
        title: "t",
        bodyPreview: null,
        authorId: null,
        metadata: {},
      }),
    ).not.toThrow();
  });

  test("a data-quality or error-issue row with no backing item row and no open time does not throw", () => {
    const db = freshDb();
    expect(() =>
      syncGraphFromIndexedItem(db, {
        id: "bigeye:nope",
        service: "bigeye",
        type: "data_quality_test",
        title: "t",
        bodyPreview: null,
        authorId: null,
        metadata: { monitoredDataModelKeys: ["a.b.c"] },
      }),
    ).not.toThrow();
    expect(entityMeta(db, "data_quality_test")["occurredAt"]).toBeNull();
  });

  test("an alert row with no backing item row and no open time throws like an incident", () => {
    const db = freshDb();
    expect(() =>
      syncGraphFromIndexedItem(db, {
        id: "jira:AL9",
        service: "jira",
        type: "alert",
        title: "t",
        bodyPreview: null,
        authorId: null,
        metadata: {},
      }),
    ).toThrow(/no item row/);
  });
});
