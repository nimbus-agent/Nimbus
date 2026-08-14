import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { EMPTY_NIMBUS_VAULT, syncTestContext } from "../connectors/connector-sync-test-helpers.ts";
import { syncPagerdutyIncidentItems } from "../connectors/pagerduty-sync.ts";
import { mapVercelDeploymentToItem } from "../connectors/vercel-deployment-mapping.ts";
import { upsertIndexedItem, upsertIndexedItemForSync } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import { buildServiceIdentityResolver } from "../metrics/service-identity.ts";
import type { SyncContext } from "../sync/types.ts";
import { syncGraphFromIndexedItem } from "./graph-populator.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function entityTypes(db: Database): string[] {
  const rows = db.query("SELECT DISTINCT type FROM graph_entity ORDER BY type").all() as Array<{
    type: string;
  }>;
  return rows.map((r) => r.type);
}

test("an indexed incident becomes an incident graph entity", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-1",
    title: "Checkout 500s",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { service: "checkout" },
  });

  expect(entityTypes(db)).toContain("incident");
  const row = db
    .query("SELECT external_id, service, label FROM graph_entity WHERE type = 'incident'")
    .get() as { external_id: string; service: string; label: string };
  expect(row.external_id).toBe("pagerduty:PD-1");
  expect(row.service).toBe("pagerduty");
  expect(row.label).toBe("Checkout 500s");
});

test("an indexed deployment becomes a deployment graph entity", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "github",
    type: "deployment",
    externalId: "deploy-9",
    title: "Deploy checkout v2",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { service: "checkout" },
  });

  expect(entityTypes(db)).toContain("deployment");
  const row = db
    .query("SELECT external_id, service FROM graph_entity WHERE type = 'deployment'")
    .get() as { external_id: string; service: string };
  expect(row.external_id).toBe("github:deploy-9");
  expect(row.service).toBe("github");
});

test("an incident with no metadata.service still gets a graph entity with affectedService null", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-2",
    title: "Payments latency spike",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: {},
  });

  const row = db
    .query("SELECT metadata FROM graph_entity WHERE type = 'incident' AND external_id = ?")
    .get("pagerduty:PD-2") as { metadata: string };
  const parsed = JSON.parse(row.metadata) as { affectedService: unknown };
  expect(parsed.affectedService).toBeNull();
});

test("occurredAtForItem throws when the populator is called without a backing item row", () => {
  const db = freshDb();
  expect(() =>
    syncGraphFromIndexedItem(db, {
      id: "pagerduty:PD-missing",
      service: "pagerduty",
      type: "incident",
      title: "No backing item row",
      bodyPreview: null,
      authorId: null,
      metadata: {},
    }),
  ).toThrow(/no item row/);
});

test("re-syncing an incident twice does not accumulate duplicate or stale relations", () => {
  const db = freshDb();
  const now = Date.now();
  const item = {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-3",
    title: "Checkout 500s",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { service: "checkout" },
  };

  upsertIndexedItem(db, item);
  upsertIndexedItem(db, item);

  const entity = db
    .query("SELECT id FROM graph_entity WHERE type = 'incident' AND external_id = ?")
    .get("pagerduty:PD-3") as { id: string };
  const relationCount = db
    .query("SELECT COUNT(*) AS n FROM graph_relation WHERE from_id = ? OR to_id = ?")
    .get(entity.id, entity.id) as { n: number };
  expect(relationCount.n).toBe(0);
});

const HOUR = 60 * 60 * 1000;

function correlations(db: Database): Array<{ from: string; to: string }> {
  return db
    .query(
      `SELECT f.type || ':' || f.external_id AS "from",
              t.type || ':' || t.external_id AS "to"
         FROM graph_relation r
         JOIN graph_entity f ON f.id = r.from_id
         JOIN graph_entity t ON t.id = r.to_id
        WHERE r.type = 'correlates_with'
        ORDER BY "from", "to"`,
    )
    .all() as Array<{ from: string; to: string }>;
}

function seedDeploy(db: Database, at: number, service: string): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "deployment",
    externalId: "deploy-9",
    title: "Deploy checkout v2",
    bodyPreview: "",
    modifiedAt: at,
    syncedAt: at,
    metadata: { service },
  });
}

function seedIncident(db: Database, at: number, service: string): void {
  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-1",
    title: "Checkout 500s",
    bodyPreview: "",
    modifiedAt: at,
    syncedAt: at,
    metadata: { service },
  });
}

test("an incident shortly after a deploy of the same service correlates", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t + HOUR, "checkout");

  expect(correlations(db)).toEqual([
    { from: "deployment:github:deploy-9", to: "incident:pagerduty:PD-1" },
  ]);
});

test("correlation is emitted regardless of which side syncs last", () => {
  const db = freshDb();
  const t = Date.now();
  seedIncident(db, t + HOUR, "checkout");
  seedDeploy(db, t, "checkout");

  expect(correlations(db)).toEqual([
    { from: "deployment:github:deploy-9", to: "incident:pagerduty:PD-1" },
  ]);
});

test("an incident outside the window does not correlate", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t + 5 * HOUR, "checkout");

  expect(correlations(db)).toEqual([]);
});

test("an incident before the deploy does not correlate", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t - HOUR, "checkout");

  expect(correlations(db)).toEqual([]);
});

test("a different service does not correlate", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t + HOUR, "search");

  expect(correlations(db)).toEqual([]);
});

test("re-syncing an incident to a different service retires the stale correlation", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t + HOUR, "checkout");
  expect(correlations(db)).toHaveLength(1);

  // The incident is re-classified against a different service.
  seedIncident(db, t + HOUR, "search");

  expect(correlations(db)).toEqual([]);
});

test("re-syncing an incident out of the window retires the stale correlation", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t + HOUR, "checkout");
  expect(correlations(db)).toHaveLength(1);

  // The incident's true start time turns out to be much later.
  seedIncident(db, t + 5 * HOUR, "checkout");

  expect(correlations(db)).toEqual([]);
});

test("re-syncing a deployment without a service retires the correlation it emitted", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t + HOUR, "checkout");
  expect(correlations(db)).toHaveLength(1);

  // The deployment's service classification is retracted.
  upsertIndexedItem(db, {
    service: "github",
    type: "deployment",
    externalId: "deploy-9",
    title: "Deploy checkout v2",
    bodyPreview: "",
    modifiedAt: t,
    syncedAt: t,
    metadata: {},
  });

  expect(correlations(db)).toEqual([]);
});

test("re-syncing an incident without a service retires the correlation pointing at it", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t + HOUR, "checkout");
  expect(correlations(db)).toHaveLength(1);

  // The incident's service classification is retracted.
  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-1",
    title: "Checkout 500s",
    bodyPreview: "",
    modifiedAt: t + HOUR,
    syncedAt: t + HOUR,
    metadata: {},
  });

  expect(correlations(db)).toEqual([]);
});

test("re-syncing a deployment far outside the window retires the correlation it emitted", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t + HOUR, "checkout");
  expect(correlations(db)).toHaveLength(1);

  // The deployment's true time turns out to be much earlier, well outside
  // the incident's backward-looking window.
  seedDeploy(db, t - 10 * HOUR, "checkout");

  expect(correlations(db)).toEqual([]);
});

test("a deployment fans out to every incident of the same service in its window", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");

  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-1",
    title: "Checkout 500s",
    bodyPreview: "",
    modifiedAt: t + 30 * 60 * 1000,
    syncedAt: t + 30 * 60 * 1000,
    metadata: { service: "checkout" },
  });
  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-2",
    title: "Checkout 500s again",
    bodyPreview: "",
    modifiedAt: t + 90 * 60 * 1000,
    syncedAt: t + 90 * 60 * 1000,
    metadata: { service: "checkout" },
  });

  expect(correlations(db)).toEqual([
    { from: "deployment:github:deploy-9", to: "incident:pagerduty:PD-1" },
    { from: "deployment:github:deploy-9", to: "incident:pagerduty:PD-2" },
  ]);
});

test("an incident fans in from every deployment of the same service in its window", () => {
  const db = freshDb();
  const t = Date.now();

  upsertIndexedItem(db, {
    service: "github",
    type: "deployment",
    externalId: "deploy-1",
    title: "Deploy checkout v1",
    bodyPreview: "",
    modifiedAt: t,
    syncedAt: t,
    metadata: { service: "checkout" },
  });
  upsertIndexedItem(db, {
    service: "github",
    type: "deployment",
    externalId: "deploy-2",
    title: "Deploy checkout v2",
    bodyPreview: "",
    modifiedAt: t + 30 * 60 * 1000,
    syncedAt: t + 30 * 60 * 1000,
    metadata: { service: "checkout" },
  });

  seedIncident(db, t + HOUR, "checkout");

  expect(correlations(db)).toEqual([
    { from: "deployment:github:deploy-1", to: "incident:pagerduty:PD-1" },
    { from: "deployment:github:deploy-2", to: "incident:pagerduty:PD-1" },
  ]);
});

test("an incident with more than 20 deployments in its window correlates with all of them, nearest included", () => {
  const db = freshDb();
  const t = Date.now();

  // 25 deployments of the same service, spread across the two hours before
  // the incident. d24 is nearest (4 minutes before); d00 is farthest (100
  // minutes before) but still inside the window. There is no row cap: the
  // 2-hour window is the only bound, so every one of the 25 must correlate.
  for (let i = 0; i < 25; i++) {
    const minutesBefore = 4 + 4 * (24 - i);
    const at = t - minutesBefore * 60 * 1000;
    upsertIndexedItem(db, {
      service: "github",
      type: "deployment",
      externalId: `d${String(i).padStart(2, "0")}`,
      title: `Deploy ${i}`,
      bodyPreview: "",
      modifiedAt: at,
      syncedAt: at,
      metadata: { service: "checkout" },
    });
  }

  seedIncident(db, t, "checkout");

  const rels = correlations(db);
  expect(rels).toHaveLength(25);
  // The nearest deploy (most plausibly causal) and the farthest-but-still-
  // in-window deploy are both present — nothing is truncated.
  expect(rels.map((r) => r.from)).toContain("deployment:github:d24");
  expect(rels.map((r) => r.from)).toContain("deployment:github:d00");
});

test("re-syncing the deployment after 30 incidents in its window preserves every correlation", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");

  for (let i = 0; i < 30; i++) {
    const at = t + (i + 1) * 60 * 1000;
    upsertIndexedItem(db, {
      service: "pagerduty",
      type: "incident",
      externalId: `PD-${i}`,
      title: `Checkout 500s ${i}`,
      bodyPreview: "",
      modifiedAt: at,
      syncedAt: at,
      metadata: { service: "checkout" },
    });
  }

  expect(correlations(db)).toHaveLength(30);

  // Re-syncing the deployment clears its ENTIRE outgoing direction (every
  // `correlates_with` edge from this deployment) and re-emits from scratch.
  // A cap on the re-emit side would destroy the surplus edges the incident
  // side legitimately created.
  seedDeploy(db, t, "checkout");

  expect(correlations(db)).toHaveLength(30);
});

test("re-syncing the incident after 30 deployments in its window preserves every correlation", () => {
  const db = freshDb();
  const t = Date.now();

  for (let i = 0; i < 30; i++) {
    const at = t - (i + 1) * 60 * 1000;
    upsertIndexedItem(db, {
      service: "github",
      type: "deployment",
      externalId: `deploy-${i}`,
      title: `Deploy checkout v${i}`,
      bodyPreview: "",
      modifiedAt: at,
      syncedAt: at,
      metadata: { service: "checkout" },
    });
  }

  seedIncident(db, t, "checkout");
  expect(correlations(db)).toHaveLength(30);

  // Re-syncing the incident clears its ENTIRE incoming direction (every
  // `correlates_with` edge into this incident) and re-emits from scratch.
  // A cap on the re-emit side would destroy the surplus edges the
  // deployment side legitimately created.
  seedIncident(db, t, "checkout");

  expect(correlations(db)).toHaveLength(30);
});

// ---------------------------------------------------------------------------
// Service-identity binding (SyncContext.resolveServiceId): the real-world
// case neither PagerDuty nor Vercel writes a plain `metadata.service` key,
// so correlation only fires when the [metrics.dora.<id>]/[ci.service.<id>]
// binding resolves both sides to the same nimbus service id.
// ---------------------------------------------------------------------------

const CHECKOUT_SERVICE_CONFIG: ServiceConfig = {
  serviceId: "checkout",
  repos: [{ provider: "github", providerId: "acme/checkout" }],
  pagerdutyServices: ["PSVC1"],
  deployWorkflowPattern: /^Deploy/,
  incidentWindowMinutes: 60,
  excludePrLabels: [],
  deployEnvironments: ["prod"],
  severityP1Aliases: ["P1"],
};

function ctxWithResolver(db: Database, configs: Map<string, ServiceConfig>): SyncContext {
  return {
    ...syncTestContext(db, EMPTY_NIMBUS_VAULT),
    resolveServiceId: buildServiceIdentityResolver(configs),
  };
}

test("a PagerDuty incident (pagerduty_service_id) and a Vercel deployment (repo) bind to the same nimbus service via resolveServiceId and correlate", () => {
  const db = freshDb();
  const t = Date.now();
  const configs = new Map([["checkout", CHECKOUT_SERVICE_CONFIG]]);
  const ctx = ctxWithResolver(db, configs);

  // Real `buildPagerdutyMetadata`-shaped raw incident payload: carries
  // `pagerduty_service_id`, never a plain `service` key.
  const incidentRaw = {
    id: "PD-1",
    title: "Checkout 500s",
    status: "triggered",
    html_url: "https://acme.pagerduty.com/incidents/PD-1",
    created_at: new Date(t + HOUR).toISOString(),
    updated_at: new Date(t + HOUR).toISOString(),
    service: { id: "PSVC1" },
    priority: { name: "P1" },
    urgency: "high",
  };
  syncPagerdutyIncidentItems(ctx, [incidentRaw], "1970-01-01T00:00:00Z", t + HOUR, new Map());

  // Real `mapVercelDeploymentToItem`-shaped raw deployment payload: the
  // git-integrated `meta` block carries the owning GitHub repo, never a
  // plain `service` key.
  const deploymentRaw = {
    uid: "dpl_123",
    name: "checkout-web",
    readyState: "READY",
    target: "production",
    url: "checkout-web.vercel.app",
    inspectorUrl: "https://vercel.com/acme/checkout-web/dpl_123",
    created: t,
    meta: {
      githubCommitSha: "abc123def456",
      githubCommitMessage: "Fix checkout bug",
      githubCommitRef: "main",
      githubOrg: "acme",
      githubRepo: "checkout",
    },
    creator: { username: "alice" },
  };
  const mapped = mapVercelDeploymentToItem(deploymentRaw, { syncedAt: t });
  if (mapped === null) throw new Error("mapVercelDeploymentToItem returned null");
  upsertIndexedItemForSync(ctx, mapped);

  expect(correlations(db)).toEqual([
    { from: "deployment:vercel:dpl_123", to: "incident:pagerduty:PD-1" },
  ]);
});

test("without resolveServiceId wired, the same PagerDuty/Vercel pair emits no correlation (proves the fix is load-bearing)", () => {
  const db = freshDb();
  const t = Date.now();
  // No `resolveServiceId` on the context: exercises the pre-fix production
  // shape, `syncTestContext` builds a SyncContext with the field absent.
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);

  const incidentRaw = {
    id: "PD-1",
    title: "Checkout 500s",
    status: "triggered",
    created_at: new Date(t + HOUR).toISOString(),
    updated_at: new Date(t + HOUR).toISOString(),
    service: { id: "PSVC1" },
    priority: { name: "P1" },
    urgency: "high",
  };
  syncPagerdutyIncidentItems(ctx, [incidentRaw], "1970-01-01T00:00:00Z", t + HOUR, new Map());

  const deploymentRaw = {
    uid: "dpl_123",
    name: "checkout-web",
    readyState: "READY",
    created: t,
    meta: { githubOrg: "acme", githubRepo: "checkout" },
  };
  const mapped = mapVercelDeploymentToItem(deploymentRaw, { syncedAt: t });
  if (mapped === null) throw new Error("mapVercelDeploymentToItem returned null");
  upsertIndexedItemForSync(ctx, mapped);

  expect(correlations(db)).toEqual([]);
});

test("fallback preserved: with no resolver supplied, metadata.service still correlates exactly as before", () => {
  const db = freshDb();
  const t = Date.now();
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);
  expect(ctx.resolveServiceId).toBeUndefined();

  upsertIndexedItemForSync(ctx, {
    service: "github",
    type: "deployment",
    externalId: "deploy-fallback",
    title: "Deploy checkout v3",
    bodyPreview: "",
    modifiedAt: t,
    syncedAt: t,
    metadata: { service: "checkout" },
  });
  upsertIndexedItemForSync(ctx, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-fallback",
    title: "Checkout 500s",
    bodyPreview: "",
    modifiedAt: t + HOUR,
    syncedAt: t + HOUR,
    metadata: { service: "checkout" },
  });

  expect(correlations(db)).toEqual([
    { from: "deployment:github:deploy-fallback", to: "incident:pagerduty:PD-fallback" },
  ]);
});

// ---------------------------------------------------------------------------
// I-1: a Vercel preview deployment must not correlate — a git-integrated
// Vercel project creates a preview deployment on every push, so left
// unfiltered they numerically dominate and drown out real prod correlations.
// ---------------------------------------------------------------------------

test("I-1: a Vercel preview deployment does not correlate, but a production deployment of the same repo does", () => {
  const db = freshDb();
  const t = Date.now();
  const configs = new Map([["checkout", CHECKOUT_SERVICE_CONFIG]]);
  const ctx = ctxWithResolver(db, configs);

  const incidentRaw = {
    id: "PD-1",
    title: "Checkout 500s",
    status: "triggered",
    created_at: new Date(t + HOUR).toISOString(),
    updated_at: new Date(t + HOUR).toISOString(),
    service: { id: "PSVC1" },
    priority: { name: "P1" },
    urgency: "high",
  };
  syncPagerdutyIncidentItems(ctx, [incidentRaw], "1970-01-01T00:00:00Z", t + HOUR, new Map());

  const previewRaw = {
    uid: "dpl_preview",
    name: "checkout-web",
    readyState: "READY",
    target: "preview",
    created: t,
    meta: { githubOrg: "acme", githubRepo: "checkout" },
  };
  const previewMapped = mapVercelDeploymentToItem(previewRaw, { syncedAt: t });
  if (previewMapped === null) throw new Error("mapVercelDeploymentToItem returned null");
  upsertIndexedItemForSync(ctx, previewMapped);

  const prodRaw = {
    uid: "dpl_prod",
    name: "checkout-web",
    readyState: "READY",
    target: "production",
    created: t,
    meta: { githubOrg: "acme", githubRepo: "checkout" },
  };
  const prodMapped = mapVercelDeploymentToItem(prodRaw, { syncedAt: t });
  if (prodMapped === null) throw new Error("mapVercelDeploymentToItem returned null");
  upsertIndexedItemForSync(ctx, prodMapped);

  expect(correlations(db)).toEqual([
    { from: "deployment:vercel:dpl_prod", to: "incident:pagerduty:PD-1" },
  ]);
});

// F2: a deployment with no environment signal at all now resolves EXCLUDED
// (fail CLOSED), not bound. Was "fail-open decision" before F2 — see
// service-identity.ts's F2 doc comment for why the "Vercel always writes
// target" assumption this used to rely on is not trustworthy.
test("F2: a deployment with no environment signal at all does not correlate (fails closed)", () => {
  const db = freshDb();
  const t = Date.now();
  const configs = new Map([["checkout", CHECKOUT_SERVICE_CONFIG]]);
  const ctx = ctxWithResolver(db, configs);

  upsertIndexedItemForSync(ctx, {
    service: "github",
    type: "deployment",
    externalId: "deploy-no-env-signal",
    title: "Deploy checkout",
    bodyPreview: "",
    modifiedAt: t,
    syncedAt: t,
    metadata: { repo: "acme/checkout" },
  });
  upsertIndexedItemForSync(ctx, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-no-env-signal",
    title: "Checkout 500s",
    bodyPreview: "",
    modifiedAt: t + HOUR,
    syncedAt: t + HOUR,
    metadata: { pagerduty_service_id: "PSVC1" },
  });

  expect(correlations(db)).toEqual([]);
});

// F2: keep proving the converse — a deployment WITH a production signal
// still correlates, so F2's fail-closed change didn't just silence
// everything.
test("F2: a deployment with an explicit production environment still correlates", () => {
  const db = freshDb();
  const t = Date.now();
  const configs = new Map([["checkout", CHECKOUT_SERVICE_CONFIG]]);
  const ctx = ctxWithResolver(db, configs);

  upsertIndexedItemForSync(ctx, {
    service: "github",
    type: "deployment",
    externalId: "deploy-with-env-signal",
    title: "Deploy checkout",
    bodyPreview: "",
    modifiedAt: t,
    syncedAt: t,
    metadata: { repo: "acme/checkout", environment: "prod" },
  });
  upsertIndexedItemForSync(ctx, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-with-env-signal",
    title: "Checkout 500s",
    bodyPreview: "",
    modifiedAt: t + HOUR,
    syncedAt: t + HOUR,
    metadata: { pagerduty_service_id: "PSVC1" },
  });

  expect(correlations(db)).toEqual([
    {
      from: "deployment:github:deploy-with-env-signal",
      to: "incident:pagerduty:PD-with-env-signal",
    },
  ]);
});

// ---------------------------------------------------------------------------
// F1: `resolveServiceId` returning "excluded" must bind nothing — the graph
// populator must NOT fall back to `metadata.service` in that case. A bare
// `undefined` couldn't tell "explicitly excluded" apart from "no binding
// known", and the `?? stringField(row.metadata, "service")` fallback
// silently re-bound a gate-excluded preview deployment from
// `metadata.service`, producing the exact false causal edge I-1 exists to
// prevent.
// ---------------------------------------------------------------------------

test("F1: a Vercel preview deployment carrying metadata.service does not correlate — the environment-gate exclusion is not bypassed by the metadata.service fallback", () => {
  const db = freshDb();
  const t = Date.now();
  const configs = new Map([["checkout", CHECKOUT_SERVICE_CONFIG]]);
  const ctx = ctxWithResolver(db, configs);

  upsertIndexedItemForSync(ctx, {
    service: "vercel",
    type: "deployment",
    externalId: "dpl_preview",
    title: "Deploy checkout (preview)",
    bodyPreview: "",
    modifiedAt: t,
    syncedAt: t,
    metadata: { repo: "acme/checkout", target: "preview", service: "checkout" },
  });
  upsertIndexedItemForSync(ctx, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-f1",
    title: "Checkout 500s",
    bodyPreview: "",
    modifiedAt: t + HOUR,
    syncedAt: t + HOUR,
    metadata: { pagerduty_service_id: "PSVC1" },
  });

  expect(correlations(db)).toEqual([]);
});

test("F1: a deployment resolveServiceId can't claim (unknown) still falls back to metadata.service, unchanged", () => {
  const db = freshDb();
  const t = Date.now();
  // No ServiceConfig binds "acme/other" or "PSVC-OTHER" — the resolver
  // returns `unknown` for this deployment, which must still fall back.
  const configs = new Map([["checkout", CHECKOUT_SERVICE_CONFIG]]);
  const ctx = ctxWithResolver(db, configs);

  upsertIndexedItemForSync(ctx, {
    service: "github",
    type: "deployment",
    externalId: "deploy-unknown-binding",
    title: "Deploy other",
    bodyPreview: "",
    modifiedAt: t,
    syncedAt: t,
    metadata: { service: "other-service" },
  });
  upsertIndexedItemForSync(ctx, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-unknown-binding",
    title: "Other 500s",
    bodyPreview: "",
    modifiedAt: t + HOUR,
    syncedAt: t + HOUR,
    metadata: { service: "other-service" },
  });

  expect(correlations(db)).toEqual([
    {
      from: "deployment:github:deploy-unknown-binding",
      to: "incident:pagerduty:PD-unknown-binding",
    },
  ]);
});
