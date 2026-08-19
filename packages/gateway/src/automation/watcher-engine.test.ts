import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ServiceIdentityResolver } from "../metrics/service-identity.ts";
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
    const personId = upsertGraphEntity<string>(db, {
      type: "person",
      externalId: "gh:7",
      label: "Dev",
      service: "github",
    });
    const alertId = upsertGraphEntity<string>(db, {
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
      metadata: { status: "triggered" },
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
      metadata: { status: "triggered" },
    });

    let calls = 0;
    evaluateWatchersStartupCatchUp(db, t0 + 2000, () => {
      calls += 1;
    });

    expect(calls).toBe(0);
  });

  test("incident_opened fires on a triggered incident but not on a resolved one", () => {
    // pagerduty-sync fetches /incidents unfiltered and sets modifiedAt from `updated_at`, so a
    // resolution re-indexes the incident with a fresh modified_at. Only the status distinguishes
    // an opening from a resolution.
    const db = makeDb();
    const t0 = 5_600_000_000_000;
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
      externalId: "INC-RESOLVED",
      title: "checkout latency (resolved)",
      modifiedAt: t0 + 1000,
      syncedAt: t0 + 1000,
      metadata: { status: "resolved" },
    });

    const bodies: string[] = [];
    evaluateWatchersAfterSync(db, "pagerduty", t0 + 2000, (_title, body) => {
      bodies.push(body);
    });
    expect(bodies).toHaveLength(0);

    upsertIndexedItem(db, {
      service: "pagerduty",
      type: "incident",
      externalId: "INC-TRIGGERED",
      title: "checkout 500s",
      modifiedAt: t0 + 3000,
      syncedAt: t0 + 3000,
      metadata: { status: "triggered" },
    });

    evaluateWatchersAfterSync(db, "pagerduty", t0 + 4000, (_title, body) => {
      bodies.push(body);
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("checkout 500s");
  });

  test("a row with non-JSON metadata does not break incident_opened evaluation", () => {
    const db = makeDb();
    const t0 = 5_700_000_000_000;
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
      externalId: "INC-LEGACY",
      title: "legacy row",
      modifiedAt: t0 + 1000,
      syncedAt: t0 + 1000,
    });
    upsertIndexedItem(db, {
      service: "pagerduty",
      type: "incident",
      externalId: "INC-NEW",
      title: "payments down",
      modifiedAt: t0 + 2000,
      syncedAt: t0 + 2000,
      metadata: { status: "triggered" },
    });
    // Forced directly: no production writer emits non-JSON metadata. Without json_valid() the
    // json_extract below raises and the exception escapes the whole evaluation loop.
    db.run("UPDATE item SET metadata = 'not json' WHERE external_id = ?", ["INC-LEGACY"]);

    const bodies: string[] = [];
    evaluateWatchersAfterSync(db, "pagerduty", t0 + 3000, (_title, body) => {
      bodies.push(body);
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("payments down");
  });

  test("deploy_failed fires only on a failed deployment, not a successful one", () => {
    const db = makeDb();
    const t0 = 1_700_000_000_000;
    insertWatcher(db, {
      name: "deploys",
      enabled: 1,
      condition_type: "deploy_failed",
      condition_json: JSON.stringify({ filter: { service: "github-actions" } }),
      action_type: "notify",
      action_json: "{}",
      created_at: t0,
    });
    upsertIndexedItem(db, {
      service: "github-actions",
      type: "deployment",
      externalId: "deploy-ok",
      title: "checkout v2.1.0",
      modifiedAt: t0 + 1000,
      syncedAt: t0 + 1000,
      metadata: { conclusion: "success" },
    });
    upsertIndexedItem(db, {
      service: "github-actions",
      type: "deployment",
      externalId: "deploy-bad",
      title: "checkout v2.1.1",
      modifiedAt: t0 + 2000,
      syncedAt: t0 + 2000,
      metadata: { conclusion: "failure" },
    });

    const bodies: string[] = [];
    evaluateWatchersAfterSync(db, "github-actions", t0 + 3000, (_title, body) => {
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
      condition_json: JSON.stringify({ filter: { service: "github-actions" } }),
      action_type: "notify",
      action_json: "{}",
      created_at: t0,
    });
    upsertIndexedItem(db, {
      service: "github-actions",
      type: "deployment",
      externalId: "deploy-legacy",
      title: "legacy row",
      modifiedAt: t0 + 1000,
      syncedAt: t0 + 1000,
    });
    upsertIndexedItem(db, {
      service: "github-actions",
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
    evaluateWatchersAfterSync(db, "github-actions", t0 + 3000, (_title, body) => {
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
      // `status: "triggered"` so the row genuinely reaches the predicate: without it the query
      // returns nothing and the assertion below would hold for the wrong reason.
      metadata: { status: "triggered" },
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
  describe("filter.affectedService", () => {
    const T0 = 5_300_000_000_000;

    /** One `[ci.service.billing]` block claiming both the repo and the PagerDuty service. */
    const resolver: ServiceIdentityResolver = (item) =>
      item.metadata["pagerduty_service_id"] === "PBILLING"
        ? { kind: "bound", serviceId: "billing" }
        : { kind: "unknown" };

    function insertAffectedServiceWatcher(
      db: Database,
      conditionType: string,
      affectedService: string,
    ): string {
      return insertWatcher(db, {
        name: `${conditionType}-on-${affectedService}`,
        enabled: 1,
        condition_type: conditionType,
        condition_json: JSON.stringify({ filter: { affectedService } }),
        action_type: "notify",
        action_json: "{}",
        created_at: T0,
      });
    }

    /**
     * Written through the PRODUCTION path so `graph-populator.ts` creates the incident entity
     * and resolves its `affectedService` — never a hand-seeded graph entity, which would keep
     * passing if the populator stopped writing the field.
     */
    function insertTriggeredIncident(
      db: Database,
      externalId: string,
      pagerdutyServiceId: string,
    ): void {
      upsertIndexedItem(
        db,
        {
          service: "pagerduty",
          type: "incident",
          externalId,
          title: `incident ${externalId}`,
          modifiedAt: T0 + 1000,
          syncedAt: T0 + 1000,
          metadata: { status: "triggered", pagerduty_service_id: pagerdutyServiceId },
        },
        resolver,
      );
    }

    function fireBodies(db: Database): string[] {
      const bodies: string[] = [];
      evaluateWatchersAfterSync(db, "pagerduty", T0 + 2000, (_title, body) => {
        bodies.push(body);
      });
      return bodies;
    }

    test("fires when the incident entity names the same affected service", () => {
      const db = makeDb();
      insertAffectedServiceWatcher(db, "incident_opened", "billing");
      insertTriggeredIncident(db, "INC-A", "PBILLING");
      expect(fireBodies(db)).toHaveLength(1);
    });

    test("does not fire when the incident entity names a different affected service", () => {
      const db = makeDb();
      insertAffectedServiceWatcher(db, "incident_opened", "payments");
      insertTriggeredIncident(db, "INC-B", "PBILLING");
      expect(fireBodies(db)).toEqual([]);
    });

    test("does not fire on the raw connector id — filter.service and filter.affectedService are different axes", () => {
      // The bug this filter exists to fix, pinned in reverse: `pagerduty` is what
      // `item.service` holds, and it is NOT an affected service.
      const db = makeDb();
      insertAffectedServiceWatcher(db, "incident_opened", "pagerduty");
      insertTriggeredIncident(db, "INC-C", "PBILLING");
      expect(fireBodies(db)).toEqual([]);
    });

    test("an unfiltered watcher still fires on the same incident", () => {
      // Proves the two tests above fail on the FILTER, not on a broken fixture.
      const db = makeDb();
      insertWatcher(db, {
        name: "any-incident",
        enabled: 1,
        condition_type: "incident_opened",
        condition_json: JSON.stringify({ filter: {} }),
        action_type: "notify",
        action_json: "{}",
        created_at: T0,
      });
      insertTriggeredIncident(db, "INC-D", "PBILLING");
      expect(fireBodies(db)).toHaveLength(1);
    });

    test("fails CLOSED on a condition kind with no timeline entity", () => {
      // `alert_fired` has no graph entity carrying an affectedService. Ignoring the filter would
      // WIDEN the watcher to every alert — the opposite of what the author asked for.
      const db = makeDb();
      insertAffectedServiceWatcher(db, "alert_fired", "billing");
      insertSentryAlert(db, "A-1", "some alert", T0);
      const bodies: string[] = [];
      evaluateWatchersAfterSync(db, "sentry", T0 + 2000, (_t, b) => {
        bodies.push(b);
      });
      expect(bodies).toEqual([]);
    });

    test("the same alert_fired watcher without the filter DOES fire", () => {
      // Discriminates the fail-closed test above from a fixture that never matched anyway.
      const db = makeDb();
      insertAlertFiredWatcher(db, "any-alert", JSON.stringify({ filter: {} }), T0);
      insertSentryAlert(db, "A-2", "some alert", T0);
      const bodies: string[] = [];
      evaluateWatchersAfterSync(db, "sentry", T0 + 2000, (_t, b) => {
        bodies.push(b);
      });
      expect(bodies).toHaveLength(1);
    });

    test("a non-JSON graph_entity.metadata does not take down the evaluation loop", () => {
      // json_extract RAISES "malformed JSON" on non-JSON TEXT, and the exception would escape
      // evaluateOneWatcher and kill EVERY watcher in the loop, not just this one. No production
      // writer can produce this today, so it is forced directly — same shape as the item-level
      // json_valid test above.
      const db = makeDb();
      insertAffectedServiceWatcher(db, "incident_opened", "billing");
      insertTriggeredIncident(db, "INC-POISON", "PBILLING");
      insertTriggeredIncident(db, "INC-GOOD", "PBILLING");
      db.run("UPDATE graph_entity SET metadata = 'not json' WHERE external_id = ?", [
        "pagerduty:INC-POISON",
      ]);

      const bodies = fireBodies(db);

      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain("INC-GOOD");
    });

    test("filter.service and filter.affectedService compose — both must match", () => {
      const db = makeDb();
      insertWatcher(db, {
        name: "both",
        enabled: 1,
        condition_type: "incident_opened",
        condition_json: JSON.stringify({
          filter: { service: "pagerduty", affectedService: "billing" },
        }),
        action_type: "notify",
        action_json: "{}",
        created_at: T0,
      });
      insertTriggeredIncident(db, "INC-E", "PBILLING");
      expect(fireBodies(db)).toHaveLength(1);

      const db2 = makeDb();
      insertWatcher(db2, {
        name: "both-wrong-connector",
        enabled: 1,
        condition_type: "incident_opened",
        condition_json: JSON.stringify({
          filter: { service: "opsgenie", affectedService: "billing" },
        }),
        action_type: "notify",
        action_json: "{}",
        created_at: T0,
      });
      insertTriggeredIncident(db2, "INC-F", "PBILLING");
      expect(fireBodies(db2)).toEqual([]);
    });
  });
});
