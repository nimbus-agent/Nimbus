import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { dispatchDeploymentRpc } from "../ipc/deployment-rpc.ts";
import { NO_INCIDENT_BINDINGS, type ServiceConfig } from "../metrics/dora-config.ts";
import { buildServiceIdentityResolver } from "../metrics/service-identity.ts";
import { annotateDeployment } from "./annotate.ts";
import { graphAnnotatedDeployment } from "./graph-annotated.ts";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const CFG: ServiceConfig = {
  serviceId: "payments",
  repos: [{ provider: "github", providerId: "acme/payments" }],
  pagerdutyServices: [],
  deployWorkflowPattern: /^Deploy/,
  incidentWindowMinutes: 60,
  excludePrLabels: [],
  deployEnvironments: ["prod"],
  severityP1Aliases: [],
  ...NO_INCIDENT_BINDINGS,
};
const resolver = buildServiceIdentityResolver(new Map([["payments", CFG]]));

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

const INPUT = {
  service: "payments",
  provider: "github-actions",
  environment: "prod",
  sha: "abcdef1234567",
  ref: "main",
  status: "success",
  started_at_ms: NOW,
  run_id: "9",
} as const;

function entity(db: Database): { metadata: string } | null {
  return db.query("SELECT metadata FROM graph_entity WHERE type = 'deployment'").get() as {
    metadata: string;
  } | null;
}

describe("graphAnnotatedDeployment", () => {
  test("creates a deployment entity bound through nimbus_service_id; idempotent on re-annotation", () => {
    const db = freshDb();
    const r = annotateDeployment(db, INPUT, NOW);
    graphAnnotatedDeployment(db, `deployment:${r.external_id}`, resolver);
    graphAnnotatedDeployment(db, `deployment:${r.external_id}`, resolver);
    expect(
      db.query("SELECT COUNT(*) AS n FROM graph_entity WHERE type='deployment'").get(),
    ).toEqual({ n: 1 });
    expect(JSON.parse(entity(db)?.metadata ?? "{}")).toMatchObject({ affectedService: "payments" });
  });

  test("an excluded (preview) environment binds nothing", () => {
    const db = freshDb();
    const r = annotateDeployment(db, { ...INPUT, environment: "preview" }, NOW);
    graphAnnotatedDeployment(db, `deployment:${r.external_id}`, resolver);
    expect(JSON.parse(entity(db)?.metadata ?? "{}")).toMatchObject({ affectedService: null });
  });

  test("without a resolver the entity exists with a null service; a missing item is a no-op", () => {
    const db = freshDb();
    const r = annotateDeployment(db, INPUT, NOW);
    graphAnnotatedDeployment(db, `deployment:${r.external_id}`);
    expect(JSON.parse(entity(db)?.metadata ?? "{}")).toMatchObject({ affectedService: null });
    expect(() => graphAnnotatedDeployment(db, "deployment:nope", resolver)).not.toThrow();
  });

  test("unparseable stored metadata still graphs (falls back to an empty record)", () => {
    const db = freshDb();
    const r = annotateDeployment(db, INPUT, NOW);
    db.run("UPDATE item SET metadata = '[1]' WHERE id = ?", [`deployment:${r.external_id}`]);
    graphAnnotatedDeployment(db, `deployment:${r.external_id}`, resolver);
    expect(entity(db)).not.toBeNull();
    db.run("UPDATE item SET metadata = 'x{' WHERE id = ?", [`deployment:${r.external_id}`]);
    expect(() =>
      graphAnnotatedDeployment(db, `deployment:${r.external_id}`, resolver),
    ).not.toThrow();
  });
});

describe("the RPC seam", () => {
  test("a throwing graph seam is swallowed and the annotation answer is unchanged", async () => {
    const db = freshDb();
    const out = await dispatchDeploymentRpc("deployment.annotate", INPUT, {
      db,
      nowMs: () => NOW,
      graphDeployment: () => {
        throw new Error("graph down");
      },
    });
    expect(out.kind).toBe("hit");
    expect(db.query("SELECT COUNT(*) AS n FROM deployment_items").get()).toEqual({ n: 1 });
  });
});
