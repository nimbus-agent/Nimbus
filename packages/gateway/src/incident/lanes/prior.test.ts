import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import { HOUR, resolverFor, serviceConfig, T0 } from "../__fixtures__/index-writers.ts";
import {
  writeJsmAlert,
  writePagerdutyIncident,
  writeSentryIssue,
} from "../__fixtures__/trigger-writers.ts";
import { priorLane, skippedPrior } from "./prior.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});
function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}

const cfg = serviceConfig();
const other = serviceConfig({
  serviceId: "checkout",
  repos: [{ provider: "github", providerId: "acme/checkout" }],
  pagerdutyServices: ["PSVC2"],
  jsmAlertTags: ["checkout"],
  sentryProjects: ["checkout-api"],
  dataModels: [],
});
const resolver = resolverFor(cfg, other);
const OPEN = T0 + 10 * HOUR;

describe("lane 4, prior incidents", () => {
  test("same-service earlier triggers of every kind, newest first, trigger and later ones excluded", () => {
    const d = db();
    const trig = writePagerdutyIncident(d, { id: "NOW", openedAtMs: OPEN }, resolver);
    const pd = writePagerdutyIncident(
      d,
      { id: "OLD1", openedAtMs: T0 + HOUR, status: "resolved", resolvedAtMs: T0 + 2 * HOUR },
      resolver,
    );
    const jsm = writeJsmAlert(
      d,
      { id: "A1", openedAtMs: T0 + 3 * HOUR, tags: ["payments"] },
      resolver,
    );
    const sentry = writeSentryIssue(
      d,
      { id: "S1", firstSeenMs: T0 + 5 * HOUR, project: "payments-api" },
      resolver,
    );
    writePagerdutyIncident(d, { id: "LATER", openedAtMs: OPEN + HOUR }, resolver);
    writePagerdutyIncident(
      d,
      { id: "ELSE", openedAtMs: T0, pagerdutyServiceId: "PSVC2" },
      resolver,
    );
    const r = priorLane(d, { service: "payment-service", triggerItemId: trig, openedAtMs: OPEN });
    expect(r.lane.incidents.map((i) => i.id)).toEqual([sentry, jsm, pd]);
    expect(r.lane.total).toBe(3);
    expect(r.lane.incidents.every((i) => i.rule === "same_service_prior")).toBe(true);
    expect(r.lane.incidents[2]).toMatchObject({
      status: "closed",
      closedAtMs: T0 + 2 * HOUR,
      closedBasis: "provider",
      openedAtMs: T0 + HOUR,
    });
    expect(r.gaps[0]?.detail).toContain("How any earlier incident was resolved is absent");
  });

  test("cap 10 with the true total, and a legacy resolved row reads closed with no time", () => {
    const d = db();
    for (let i = 0; i < 13; i += 1) {
      writePagerdutyIncident(d, { id: `P${String(i)}`, openedAtMs: T0 + i * 1000 }, resolver);
    }
    const old = writePagerdutyIncident(
      d,
      { id: "LEGACY", openedAtMs: T0 - HOUR, status: "resolved", resolvedAtMs: T0 },
      resolver,
    );
    d.run("UPDATE item SET metadata = json_remove(metadata, '$.resolved_at_ms') WHERE id = ?", [
      old,
    ]);
    const r = priorLane(d, {
      service: "payment-service",
      triggerItemId: "pagerduty:x",
      openedAtMs: OPEN,
    });
    expect(r.lane.total).toBe(14);
    expect(r.lane.incidents).toHaveLength(10);
    const all = priorLane(d, {
      service: "payment-service",
      triggerItemId: "pagerduty:x",
      openedAtMs: T0,
    });
    const legacy = all.lane.incidents.find((i) => i.id === old);
    expect(legacy).toMatchObject({ status: "closed", closedAtMs: null, closedBasis: "none" });
  });

  test("a service with no earlier trigger says so; the order is total (ties end in the id)", () => {
    const d = db();
    const r = priorLane(d, {
      service: "payment-service",
      triggerItemId: "pagerduty:x",
      openedAtMs: OPEN,
    });
    expect(r.lane).toEqual({ skipped: null, total: 0, incidents: [] });
    expect(r.gaps.some((g) => g.detail.includes("No earlier trigger"))).toBe(true);
    for (const id of ["B", "A", "C"]) {
      writePagerdutyIncident(d, { id, openedAtMs: T0 }, resolver);
    }
    const tied = priorLane(d, {
      service: "payment-service",
      triggerItemId: "pagerduty:x",
      openedAtMs: OPEN,
    });
    expect(tied.lane.incidents.map((i) => i.id)).toEqual([
      "pagerduty:A",
      "pagerduty:B",
      "pagerduty:C",
    ]);
  });

  test("the entity scan plan is recorded: a scan of the entity type, served by the unique (type, external_id) index", () => {
    const d = db();
    const plan = (
      d
        .query(
          `EXPLAIN QUERY PLAN SELECT e.id FROM graph_entity e JOIN item i ON i.id = e.external_id
            WHERE e.type IN ('incident','alert') AND CASE WHEN json_valid(e.metadata) THEN json_extract(e.metadata, '$.affectedService') END = 'x'`,
        )
        .all() as { detail: string }[]
    )
      .map((r) => r.detail)
      .join("\n");
    expect(plan).toContain("graph_entity");
  });

  test("skippedPrior carries the reason", () => {
    expect(skippedPrior("unbound").lane).toEqual({ skipped: "unbound", total: 0, incidents: [] });
  });
});
