import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { evaluateWatchersAfterSync, evaluateWatchersStartupCatchUp } from "./watcher-engine.ts";
import { insertWatcher, listWatchers } from "./watcher-store.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function insertAlertFiredWatcher(
  db: Database,
  name: string,
  conditionJson: string,
  createdAt: number,
): string {
  return insertWatcher(db, {
    name,
    enabled: 1,
    condition_type: "alert_fired",
    condition_json: conditionJson,
    action_type: "notify",
    action_json: "{}",
    created_at: createdAt,
  });
}

function insertSentryAlert(db: Database, externalId: string, title: string, t0: number): void {
  upsertIndexedItem(db, {
    service: "sentry",
    type: "alert",
    externalId,
    title,
    modifiedAt: t0 + 1000,
    syncedAt: t0 + 1000,
  });
}

function insertGraphPredicateWatcher(
  db: Database,
  name: string,
  graphPredicateJson: string,
  createdAt: number,
): string {
  return insertWatcher(db, {
    name,
    enabled: 1,
    condition_type: "alert_fired",
    condition_json: JSON.stringify({ filter: { service: "sentry" } }),
    action_type: "notify",
    action_json: "{}",
    created_at: createdAt,
    graph_predicate_json: graphPredicateJson,
  });
}

describe("watcher-engine", () => {
  test("evaluateWatchersAfterSync no-op when schema below v8", () => {
    const db = new Database(":memory:");
    let calls = 0;
    evaluateWatchersAfterSync(db, "pagerduty", Date.now(), () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  test("non-alert_fired condition does not notify", () => {
    const db = makeDb();
    const t0 = 1_700_000_000_000;
    insertWatcher(db, {
      name: "other",
      enabled: 1,
      condition_type: "custom",
      condition_json: "{}",
      action_type: "notify",
      action_json: "{}",
      created_at: t0,
    });
    let calls = 0;
    evaluateWatchersAfterSync(db, "pagerduty", t0 + 1, () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  test("invalid condition_json does not notify", () => {
    const db = makeDb();
    const t0 = 1_700_000_000_000;
    insertAlertFiredWatcher(db, "bad-json", "not-json", t0);
    let calls = 0;
    evaluateWatchersAfterSync(db, "pagerduty", t0 + 1, () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  test("service filter mismatch does not notify", () => {
    const db = makeDb();
    const t0 = 1_700_000_000_000;
    insertAlertFiredWatcher(
      db,
      "pd-only",
      JSON.stringify({ filter: { service: "pagerduty" } }),
      t0,
    );
    upsertIndexedItem(db, {
      service: "pagerduty",
      type: "alert",
      externalId: "a1",
      title: "cpu",
      modifiedAt: t0 + 5000,
      syncedAt: t0 + 5000,
    });
    let calls = 0;
    evaluateWatchersAfterSync(db, "datadog", t0 + 6000, () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  test("fires on new alert for synced service and updates watcher timestamps", () => {
    const db = makeDb();
    const t0 = 1_700_000_000_000;
    const wid = insertAlertFiredWatcher(
      db,
      "pd-alerts",
      JSON.stringify({ filter: { service: "pagerduty" } }),
      t0,
    );
    upsertIndexedItem(db, {
      service: "pagerduty",
      type: "alert",
      externalId: "inc-42",
      title: "High CPU",
      modifiedAt: t0 + 8000,
      syncedAt: t0 + 8000,
    });
    const bodies: string[] = [];
    const evalAt = t0 + 9000;
    evaluateWatchersAfterSync(db, "pagerduty", evalAt, (_title, body) => {
      const evDuring = db
        .query(`SELECT COUNT(*) as c FROM watcher_event WHERE watcher_id = ?`)
        .get(wid) as { c: number };
      expect(evDuring.c).toBe(1);
      bodies.push(body);
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("High CPU");
    expect(bodies[0]).toContain("pagerduty");

    const w = listWatchers(db).find((x) => x.id === wid);
    expect(w?.last_checked_at).toBe(evalAt);
    expect(w?.last_fired_at).toBe(evalAt);

    const evCount = db
      .query(`SELECT COUNT(*) as c FROM watcher_event WHERE watcher_id = ?`)
      .get(wid) as {
      c: number;
    };
    expect(evCount.c).toBe(1);
  });

  test("omitted filter service matches any synced service", () => {
    const db = makeDb();
    const t0 = 2_700_000_000_000;
    insertAlertFiredWatcher(db, "any-svc", JSON.stringify({ filter: {} }), t0);
    upsertIndexedItem(db, {
      service: "sentry",
      type: "alert",
      externalId: "e1",
      title: "Error spike",
      modifiedAt: t0 + 1000,
      syncedAt: t0 + 1000,
    });
    const bodies: string[] = [];
    evaluateWatchersAfterSync(db, "sentry", t0 + 2000, (_t, b) => {
      bodies.push(b);
    });
    expect(bodies).toHaveLength(1);
  });

  test("startup catch-up evaluates without a prior sync event", () => {
    const db = makeDb();
    const t0 = 3_800_000_000_000;
    insertAlertFiredWatcher(db, "catch-up", JSON.stringify({ filter: { service: "sentry" } }), t0);
    upsertIndexedItem(db, {
      service: "sentry",
      type: "alert",
      externalId: "su-1",
      title: "Regression detected",
      modifiedAt: t0 + 4000,
      syncedAt: t0 + 4000,
    });
    const bodies: string[] = [];
    evaluateWatchersStartupCatchUp(db, t0 + 5000, (_t, b) => {
      bodies.push(b);
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("Regression");
  });

  test("null filter in condition_json does not notify", () => {
    const db = makeDb();
    const t0 = 3_900_000_000_000;
    insertAlertFiredWatcher(db, "null-filter", JSON.stringify({ filter: null }), t0);
    insertSentryAlert(db, "nf-1", "null filter alert", t0);
    let calls = 0;
    evaluateWatchersAfterSync(db, "sentry", t0 + 2000, () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  test("array filter in condition_json does not notify", () => {
    const db = makeDb();
    const t0 = 3_950_000_000_000;
    insertAlertFiredWatcher(db, "array-filter", JSON.stringify({ filter: ["sentry"] }), t0);
    insertSentryAlert(db, "af-1", "array filter alert", t0);
    let calls = 0;
    evaluateWatchersAfterSync(db, "sentry", t0 + 2000, () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  test("invalid graph_predicate_json shape suppresses notify (fail-closed)", () => {
    const db = makeDb();
    const t0 = 3_970_000_000_000;
    insertGraphPredicateWatcher(
      db,
      "bad-predicate",
      JSON.stringify({
        relation: "not_a_real_relation",
        target: { type: "person", externalId: "gh:1" },
      }),
      t0,
    );
    insertSentryAlert(db, "bp-1", "bad predicate alert", t0);
    let calls = 0;
    evaluateWatchersAfterSync(
      db,
      "sentry",
      t0 + 2000,
      () => {
        calls += 1;
      },
      { graphConditionsEnabled: true },
    );
    expect(calls).toBe(0);
  });

  test("graph predicate filters alert matches — no match suppresses notify", () => {
    const db = makeDb();
    const t0 = 4_000_000_000_000;
    insertGraphPredicateWatcher(
      db,
      "graph-filtered",
      JSON.stringify({ relation: "owned_by", target: { type: "person", externalId: "gh:absent" } }),
      t0,
    );
    insertSentryAlert(db, "a1", "cpu", t0);
    let calls = 0;
    evaluateWatchersAfterSync(
      db,
      "sentry",
      t0 + 2000,
      () => {
        calls += 1;
      },
      { graphConditionsEnabled: true },
    );
    expect(calls).toBe(0);
  });

  test("graph predicate filters alert matches — matching edge fires notify", () => {
    const db = makeDb();
    const t0 = 4_100_000_000_000;
    insertGraphPredicateWatcher(
      db,
      "graph-matched",
      JSON.stringify({ relation: "owned_by", target: { type: "person", externalId: "gh:7" } }),
      t0,
    );
    insertSentryAlert(db, "a2", "oom", t0);
    const personId = upsertGraphEntity(db, {
      type: "person",
      externalId: "gh:7",
      label: "Dev",
      service: "github",
    });
    const alertId = upsertGraphEntity(db, {
      type: "alert",
      externalId: "a2",
      label: "oom",
      service: "sentry",
    });
    upsertGraphRelation(db, personId, alertId, "authored", t0);

    let calls = 0;
    evaluateWatchersAfterSync(
      db,
      "sentry",
      t0 + 2000,
      () => {
        calls += 1;
      },
      { graphConditionsEnabled: true },
    );
    expect(calls).toBe(1);
  });

  test("graph predicate is ignored when graphConditionsEnabled = false", () => {
    const db = makeDb();
    const t0 = 4_200_000_000_000;
    insertGraphPredicateWatcher(
      db,
      "graph-disabled",
      JSON.stringify({ relation: "owned_by", target: { type: "person", externalId: "gh:absent" } }),
      t0,
    );
    insertSentryAlert(db, "a3", "disk", t0);
    let calls = 0;
    evaluateWatchersAfterSync(
      db,
      "sentry",
      t0 + 2000,
      () => {
        calls += 1;
      },
      { graphConditionsEnabled: false },
    );
    expect(calls).toBe(1);
  });

  test("incident_opened fires on an indexed incident", () => {
    const db = makeDb();
    const t0 = 1_700_000_000_000;
    insertWatcher(db, {
      name: "incidents",
      enabled: 1,
      condition_type: "incident_opened",
      condition_json: JSON.stringify({ filter: { service: "pagerduty" } }),
      action_type: "notify",
      action_json: "{}",
      created_at: t0,
    });
    upsertIndexedItem(db, {
      service: "pagerduty",
      type: "incident",
      externalId: "INC-1",
      title: "api-gateway 500s",
      modifiedAt: t0 + 1000,
      syncedAt: t0 + 1000,
    });

    const bodies: string[] = [];
    evaluateWatchersAfterSync(db, "pagerduty", t0 + 2000, (_title, body) => {
      bodies.push(body);
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("api-gateway 500s");
  });

  test("incident_opened respects the service filter", () => {
    const db = makeDb();
    const t0 = 1_700_000_000_000;
    insertWatcher(db, {
      name: "incidents",
      enabled: 1,
      condition_type: "incident_opened",
      condition_json: JSON.stringify({ filter: { service: "pagerduty" } }),
      action_type: "notify",
      action_json: "{}",
      created_at: t0,
    });
    upsertIndexedItem(db, {
      service: "opsgenie",
      type: "incident",
      externalId: "OG-1",
      title: "other tracker",
      modifiedAt: t0 + 1000,
      syncedAt: t0 + 1000,
    });

    let calls = 0;
    evaluateWatchersStartupCatchUp(db, t0 + 2000, () => {
      calls += 1;
    });

    expect(calls).toBe(0);
  });

  test("deploy_failed fires only on a failed deployment, not a successful one", () => {
    const db = makeDb();
    const t0 = 1_700_000_000_000;
    insertWatcher(db, {
      name: "deploys",
      enabled: 1,
      condition_type: "deploy_failed",
      condition_json: JSON.stringify({ filter: { service: "github_actions" } }),
      action_type: "notify",
      action_json: "{}",
      created_at: t0,
    });
    upsertIndexedItem(db, {
      service: "github_actions",
      type: "deployment",
      externalId: "deploy-ok",
      title: "checkout v2.1.0",
      modifiedAt: t0 + 1000,
      syncedAt: t0 + 1000,
      metadata: { conclusion: "success" },
    });
    upsertIndexedItem(db, {
      service: "github_actions",
      type: "deployment",
      externalId: "deploy-bad",
      title: "checkout v2.1.1",
      modifiedAt: t0 + 2000,
      syncedAt: t0 + 2000,
      metadata: { conclusion: "failure" },
    });

    const bodies: string[] = [];
    evaluateWatchersAfterSync(db, "github_actions", t0 + 3000, (_title, body) => {
      bodies.push(body);
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("checkout v2.1.1");
    expect(bodies[0]).not.toContain("v2.1.0");
  });

  test("deploy_failed does not match a Vercel-shaped deployment, whose outcome is in metadata.state", () => {
    const db = makeDb();
    const t0 = 1_700_000_000_000;
    insertWatcher(db, {
      name: "deploys",
      enabled: 1,
      condition_type: "deploy_failed",
      condition_json: JSON.stringify({ filter: { service: "vercel" } }),
      action_type: "notify",
      action_json: "{}",
      created_at: t0,
    });
    upsertIndexedItem(db, {
      service: "vercel",
      type: "deployment",
      externalId: "dpl_1",
      title: "marketing-site",
      modifiedAt: t0 + 1000,
      syncedAt: t0 + 1000,
      metadata: { state: "ERROR", target: "production" },
    });

    let calls = 0;
    evaluateWatchersAfterSync(db, "vercel", t0 + 2000, () => {
      calls += 1;
    });

    expect(calls).toBe(0);
  });

  test("a row with non-JSON metadata does not break deploy_failed evaluation", () => {
    const db = makeDb();
    const t0 = 5_400_000_000_000;
    insertWatcher(db, {
      name: "deploys",
      enabled: 1,
      condition_type: "deploy_failed",
      condition_json: JSON.stringify({ filter: { service: "github_actions" } }),
      action_type: "notify",
      action_json: "{}",
      created_at: t0,
    });
    upsertIndexedItem(db, {
      service: "github_actions",
      type: "deployment",
      externalId: "deploy-legacy",
      title: "legacy row",
      modifiedAt: t0 + 1000,
      syncedAt: t0 + 1000,
    });
    upsertIndexedItem(db, {
      service: "github_actions",
      type: "deployment",
      externalId: "deploy-bad",
      title: "checkout v3.0.0",
      modifiedAt: t0 + 2000,
      syncedAt: t0 + 2000,
      metadata: { conclusion: "failure" },
    });
    // No production writer can produce this today — both item.metadata writers stringify — so it
    // is forced directly. Without json_valid() in the predicate, json_extract raises
    // "malformed JSON" here and the exception escapes the whole evaluation loop.
    db.run("UPDATE item SET metadata = 'not json' WHERE external_id = ?", ["deploy-legacy"]);

    const bodies: string[] = [];
    evaluateWatchersAfterSync(db, "github_actions", t0 + 3000, (_title, body) => {
      bodies.push(body);
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("checkout v3.0.0");
  });

  test("a graph predicate still narrows a new condition kind", () => {
    const db = makeDb();
    const t0 = 5_200_000_000_000;
    insertWatcher(db, {
      name: "incidents-owned",
      enabled: 1,
      condition_type: "incident_opened",
      condition_json: JSON.stringify({ filter: { service: "pagerduty" } }),
      action_type: "notify",
      action_json: "{}",
      created_at: t0,
      graph_predicate_json: JSON.stringify({
        relation: "owned_by",
        target: { type: "person", externalId: "gh:absent" },
      }),
    });
    upsertIndexedItem(db, {
      service: "pagerduty",
      type: "incident",
      externalId: "INC-9",
      title: "unowned incident",
      modifiedAt: t0 + 1000,
      syncedAt: t0 + 1000,
    });

    let calls = 0;
    evaluateWatchersAfterSync(
      db,
      "pagerduty",
      t0 + 2000,
      () => {
        calls += 1;
      },
      { graphConditionsEnabled: true },
    );

    expect(calls).toBe(0);
  });
});
