import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { NO_INCIDENT_BINDINGS, type ServiceConfig } from "../../metrics/dora-config.ts";
import { selectCostChangeContext } from "./cost-why-query.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const FROM = Date.UTC(2026, 10, 13);
const TO = Date.UTC(2026, 10, 27); // exclusive: the end of 2026-11-26
const SPIKE = Date.UTC(2026, 10, 23);

function svc(serviceId: string, repos: ServiceConfig["repos"]): ServiceConfig {
  return {
    serviceId,
    repos,
    pagerdutyServices: [],
    deployWorkflowPattern: /^Deploy/,
    incidentWindowMinutes: 60,
    excludePrLabels: [],
    deployEnvironments: ["prod"],
    severityP1Aliases: [],
    ...NO_INCIDENT_BINDINGS,
  };
}

const SERVICES = new Map<string, ServiceConfig>([
  [
    "payment-service",
    svc("payment-service", [{ provider: "github", providerId: "acme/payments" }]),
  ],
  ["norepo-service", svc("norepo-service", [])],
]);

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => db.close());

function item(row: {
  id: string;
  type: string;
  service: string;
  externalId?: string;
  title?: string;
  url?: string | null;
  authorId?: string | null;
  meta?: unknown;
}): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body, url, modified_at, author_id, metadata, synced_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.service,
      row.type,
      row.externalId ?? row.id,
      row.title ?? row.id,
      row.url ?? null,
      FROM,
      row.authorId ?? null,
      row.meta === undefined ? null : JSON.stringify(row.meta),
      FROM,
    ],
  );
}

function deploy(
  id: string,
  serviceId: string,
  sha: string,
  startedAtMs: number,
  finishedAtMs: number | null,
): void {
  item({ id, type: "deployment", service: "github_actions", title: `Deploy ${id}` });
  db.run(
    `INSERT INTO deployment_items
       (id, provider, nimbus_service_id, environment, sha, ref, started_at_ms, finished_at_ms,
        conclusion, workflow_url, ci_run_external_id, created_at)
     VALUES (?, 'github-actions', ?, 'prod', ?, 'refs/heads/main', ?, ?, 'success', ?, NULL, ?)`,
    [id, serviceId, sha, startedAtMs, finishedAtMs, `https://ci.example/${id}`, FROM],
  );
}

function owners(serviceId: string, people: [string, number][]): void {
  const sid = `svc:${serviceId}`;
  db.run("INSERT INTO graph_entity (id, type, external_id, label) VALUES (?, 'service', ?, ?)", [
    sid,
    `service:${serviceId}`,
    serviceId,
  ]);
  db.run("INSERT OR IGNORE INTO graph_relation_type (name, directed) VALUES ('owns', 1)");
  for (const [label, weight] of people) {
    const pid = `p:${label}`;
    db.run("INSERT INTO graph_entity (id, type, external_id, label) VALUES (?, 'person', ?, ?)", [
      pid,
      `email:${label}`,
      label,
    ]);
    db.run(
      "INSERT INTO graph_relation (from_id, to_id, type, created_at, weight) VALUES (?, ?, 'owns', ?, ?)",
      [pid, sid, FROM, weight],
    );
  }
}

const baseInput = {
  services: SERVICES,
  fromMs: FROM,
  toMs: TO,
  spikeDayMs: SPIKE,
};

describe("selectCostChangeContext", () => {
  test("deploys in the window, near-spike first, with the PR joined by sha and the owners", () => {
    db.run("INSERT INTO person (id, display_name) VALUES ('p-dana', 'Dana Diaz')");
    deploy("d-old", "payment-service", "sha-old", SPIKE - 6 * DAY, SPIKE - 6 * DAY + HOUR);
    // Starts the day before toDay ends and finishes later on toDay than midnight: inside.
    deploy("d-late", "payment-service", "sha-late", TO - 2 * HOUR, TO - HOUR);
    // 37 h after the spike day's midnight: near the spike.
    deploy("d-near", "payment-service", "sha-412", SPIKE + 37 * HOUR, SPIKE + 37 * HOUR + 600_000);
    deploy("d-before", "payment-service", "sha-x", FROM - HOUR, FROM - 1);
    deploy("d-after", "payment-service", "sha-y", TO, TO + HOUR);
    item({
      id: "pr-412",
      type: "pr",
      service: "github",
      externalId: "acme/payments#412",
      title: "Raise the payment worker pool",
      url: "https://github.example/acme/payments/pull/412",
      authorId: "p-dana",
      meta: { merge_commit_sha: "sha-412", repo: "acme/payments", number: 412 },
    });
    item({
      id: "pr-9",
      type: "pr",
      service: "github",
      externalId: "acme/payments#9",
      title: "Old change",
      meta: { merge_commit_sha: "sha-old", user: "sam" },
    });
    owners("payment-service", [
      ["Dana Diaz", 0.6],
      ["Sam Lee", 0.3],
      ["Ari Kim", 0.07],
      ["Lou Ng", 0.03],
    ]);

    const [ctx] = selectCostChangeContext(db, { ...baseInput, serviceIds: ["payment-service"] });
    expect(ctx?.serviceId).toBe("payment-service");
    expect(ctx?.configured).toBe(true);
    expect(ctx?.deploys.map((d) => d.sha)).toEqual(["sha-412", "sha-late", "sha-old"]);
    expect(ctx?.deploys.map((d) => d.nearSpike)).toEqual([true, false, false]);
    expect(ctx?.deploys[0]?.pr).toEqual({
      repo: "acme/payments",
      number: 412,
      title: "Raise the payment worker pool",
      url: "https://github.example/acme/payments/pull/412",
      author: "Dana Diaz",
    });
    expect(ctx?.deploys[0]?.url).toBe("https://ci.example/d-near");
    // Repo and number fall back to the external id; the author to `metadata.user`.
    expect(ctx?.deploys[2]?.pr).toMatchObject({ repo: "acme/payments", number: 9, author: "sam" });
    expect(ctx?.deploys[1]?.pr).toBeNull();
    expect(ctx?.owners.map((o) => o.label)).toEqual(["Dana Diaz", "Sam Lee", "Ari Kim"]);
    expect(ctx?.deploysTruncated).toBe(0);
    expect(ctx?.gaps).toEqual([]);
  });

  test("an unconfigured service runs no query and names the gap", () => {
    deploy("d1", "ghost-service", "sha-1", SPIKE, SPIKE + HOUR);
    const [ctx] = selectCostChangeContext(db, { ...baseInput, serviceIds: ["ghost-service"] });
    expect(ctx).toEqual({
      serviceId: "ghost-service",
      configured: false,
      deploys: [],
      deploysTruncated: 0,
      owners: [],
      gaps: ["service ghost-service is not configured ([ci.service.ghost-service])"],
    });
  });

  test("a service with no repo and no owners names both gaps", () => {
    deploy("d1", "norepo-service", "sha-1", SPIKE, SPIKE + HOUR);
    const [ctx] = selectCostChangeContext(db, { ...baseInput, serviceIds: ["norepo-service"] });
    expect(ctx?.deploys).toHaveLength(1);
    expect(ctx?.deploys[0]?.pr).toBeNull();
    expect(ctx?.gaps).toEqual([
      "service norepo-service has no repo configured, so no pull request is joined",
      "service norepo-service has no ownership entry (nimbus owners --refresh derives one for a bound repo root)",
    ]);
  });

  test("the deploy cap keeps near-spike deploys and counts the rest", () => {
    for (let i = 0; i < 6; i++)
      deploy(`far-${String(i)}`, "payment-service", `f${String(i)}`, FROM + i * HOUR, null);
    deploy("near", "payment-service", "n1", SPIKE + HOUR, SPIKE + 2 * HOUR);
    const [ctx] = selectCostChangeContext(db, {
      ...baseInput,
      serviceIds: ["payment-service"],
      maxDeploys: 3,
    });
    expect(ctx?.deploys.map((d) => d.sha)).toEqual(["n1", "f5", "f4"]);
    expect(ctx?.deploysTruncated).toBe(4);
    // A deploy with no finish time is placed by its start.
    expect(ctx?.deploys[1]?.finishedAtMs).toBeNull();
  });

  test("no spike day means no deploy is near it", () => {
    deploy("d1", "payment-service", "sha-1", SPIKE, SPIKE + HOUR);
    const [ctx] = selectCostChangeContext(db, {
      ...baseInput,
      spikeDayMs: null,
      serviceIds: ["payment-service"],
    });
    expect(ctx?.deploys[0]?.nearSpike).toBe(false);
  });
});
