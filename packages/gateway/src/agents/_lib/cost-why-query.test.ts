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
  ["lab-service", svc("lab-service", [{ provider: "gitlab", providerId: "acme/lab" }])],
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
     VALUES (?, 'github-actions', ?, 'prod', ?, 'refs/heads/main', ?, ?, 'success', ?, ?, ?)`,
    [id, serviceId, sha, startedAtMs, finishedAtMs, `https://ci.example/${id}`, `run-${id}`, FROM],
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
    expect(ctx?.deploys[0]?.runId).toBe("run-d-near");
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
      flags: [],
      flagsTruncated: 0,
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

  test("an annotated deploy's run id comes from its item metadata", () => {
    item({ id: "ann-1", type: "deployment", service: "nimbus", meta: { run_id: "7412" } });
    db.run(
      `INSERT INTO deployment_items
         (id, provider, nimbus_service_id, environment, sha, ref, started_at_ms, finished_at_ms,
          conclusion, workflow_url, ci_run_external_id, created_at)
       VALUES ('ann-1', 'github-actions', 'payment-service', 'prod', 'sha-a', 'main', ?, ?, 'success', NULL, NULL, ?)`,
      [SPIKE, SPIKE + HOUR, FROM],
    );
    const [ctx] = selectCostChangeContext(db, { ...baseInput, serviceIds: ["payment-service"] });
    expect(ctx?.deploys[0]?.runId).toBe("7412");
  });

  test("a non-GitHub repo says that a pull request is joined by a merge commit only GitHub records", () => {
    deploy("d1", "lab-service", "sha-1", SPIKE, SPIKE + HOUR);
    const [ctx] = selectCostChangeContext(db, { ...baseInput, serviceIds: ["lab-service"] });
    expect(ctx?.gaps).toContain(
      "service lab-service: a deploy is matched to its pull request by merge commit, which only the GitHub connector records",
    );
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

  describe("feature flags (slice 14, D8)", () => {
    function flag(
      project: string,
      key: string,
      updatedAt: number | null,
      opts: { service?: string; envs?: string[]; modifiedAt?: number } = {},
    ): void {
      item({
        id: `ld-${project}-${key}`,
        type: "feature_flag",
        service: opts.service ?? "launchdarkly",
        externalId: `${project}:${key}`,
        title: `Flag ${key}`,
        meta: { key, environments: opts.envs ?? ["production", "test"], updated_at: updatedAt },
      });
      if (opts.modifiedAt !== undefined)
        db.run("UPDATE item SET modified_at = ? WHERE external_id = ?", [
          opts.modifiedAt,
          `${project}:${key}`,
        ]);
    }
    function withFlags(
      bindings: ServiceConfig["featureFlags"],
    ): ReadonlyMap<string, ServiceConfig> {
      return new Map([
        [
          "payment-service",
          { ...(SERVICES.get("payment-service") as ServiceConfig), featureFlags: bindings },
        ],
      ]);
    }
    const run = (bindings: ServiceConfig["featureFlags"], extra: { maxFlags?: number } = {}) =>
      selectCostChangeContext(db, {
        ...baseInput,
        ...extra,
        services: withFlags(bindings),
        serviceIds: ["payment-service"],
      })[0];

    test("no bindings: no flags, no flag gap, and nothing is queried", () => {
      flag("web", "a", SPIKE);
      const ctx = run([]);
      expect(ctx?.flags).toEqual([]);
      expect(ctx?.gaps.some((g) => g.includes("flag"))).toBe(false);
    });

    test("lists in-window flags newest first; out-of-window and null updated_at are never listed", () => {
      flag("web", "old", FROM - HOUR);
      flag("web", "end", TO); // exclusive
      flag("web", "a", SPIKE, { envs: ["production"] });
      flag("web", "b", SPIKE + HOUR);
      // A sync-time fallback in modified_at must never count as a change.
      flag("web", "nullchange", null, { modifiedAt: SPIKE });
      flag("other", "x", SPIKE);
      const ctx = run([{ service: "launchdarkly", project: "web", flag: null }]);
      expect(ctx?.flags.map((f) => f.key)).toEqual(["b", "a"]);
      expect(ctx?.flags[1]).toEqual({
        service: "launchdarkly",
        key: "a",
        name: "Flag a",
        changedAtMs: SPIKE,
        environments: ["production"],
      });
      expect(ctx?.gaps).toContain("only the latest change of each flag is known");
      expect(ctx?.gaps.some((g) => g.includes("per-environment"))).toBe(true);
    });

    test("a flag binding matches only that flag; a project binding does not match a prefix of another project", () => {
      flag("web", "a", SPIKE);
      flag("web", "b", SPIKE);
      flag("web2", "c", SPIKE);
      expect(
        run([{ service: "launchdarkly", project: "web", flag: "b" }])?.flags.map((f) => f.key),
      ).toEqual(["b"]);
      expect(
        run([{ service: "launchdarkly", project: "web", flag: null }])?.flags.map((f) => f.key),
      ).toEqual(["a", "b"]);
    });

    test("a project name with LIKE wildcards matches literally", () => {
      flag("we_b", "a", SPIKE);
      flag("webx", "z", SPIKE);
      expect(
        run([{ service: "launchdarkly", project: "we_b", flag: null }])?.flags.map((f) => f.key),
      ).toEqual(["a"]);
    });

    test("the cap keeps the newest and counts the rest", () => {
      for (let i = 0; i < 5; i++) flag("web", `f${String(i)}`, SPIKE + i * HOUR);
      const ctx = run([{ service: "launchdarkly", project: "web", flag: null }], { maxFlags: 2 });
      expect(ctx?.flags.map((f) => f.key)).toEqual(["f4", "f3"]);
      expect(ctx?.flagsTruncated).toBe(3);
    });

    test("non-LaunchDarkly bindings show a stated gap once per service and list nothing", () => {
      flag("web", "a", SPIKE, { service: "unleash" });
      const ctx = run([
        { service: "unleash", project: "web", flag: null },
        { service: "unleash", project: "web", flag: "a" },
        { service: "split", project: "ws", flag: null },
      ]);
      expect(ctx?.flags).toEqual([]);
      expect(ctx?.gaps).toContain(
        "flag changes are recorded for LaunchDarkly only; unleash bindings show no changes",
      );
      expect(ctx?.gaps).toContain(
        "flag changes are recorded for LaunchDarkly only; split bindings show no changes",
      );
      expect(ctx?.gaps.filter((g) => g.includes("unleash"))).toHaveLength(1);
      expect(ctx?.gaps).toContain("only the latest change of each flag is known");
    });
  });
});
