import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "../connectors/connector-sync-test-helpers.ts";
import { mapJsmAlertToItem } from "../connectors/jsm-alert-mapping.ts";
import { upsertOncallShift } from "../connectors/oncall-shift-items.ts";
import { syncPagerdutyIncidentItems } from "../connectors/pagerduty-sync.ts";
import { NO_INCIDENT_BINDINGS, type ServiceConfig } from "../metrics/dora-config.ts";
import {
  buildStatuspageModel,
  STATUSPAGE_MAX_INCIDENTS,
  scrubPublicText,
} from "./statuspage-model.ts";

const NOW = Date.UTC(2026, 10, 16, 9, 0);
const HOUR = 3_600_000;
const DAY = 86_400_000;

let db: Database;
beforeEach(() => {
  db = createMemoryIndexDb();
});
afterEach(() => db.close());

function config(serviceId: string, over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    serviceId,
    repos: [],
    pagerdutyServices: [],
    deployWorkflowPattern: /^Deploy/,
    incidentWindowMinutes: 60,
    excludePrLabels: [],
    deployEnvironments: ["prod"],
    severityP1Aliases: [],
    ...NO_INCIDENT_BINDINGS,
    ...over,
  };
}

function configs(...c: ServiceConfig[]): ReadonlyMap<string, ServiceConfig> {
  return new Map(c.map((x) => [x.serviceId, x]));
}

function pdIncident(
  id: string,
  over: { status?: string; service?: string; title?: string; createdMs?: number } = {},
): Record<string, unknown> {
  const created = new Date(over.createdMs ?? NOW - 2 * HOUR).toISOString();
  return {
    id,
    title: over.title ?? "Checkout is down",
    status: over.status ?? "triggered",
    urgency: "high",
    created_at: created,
    updated_at: created,
    last_status_change_at: created,
    html_url: `https://acme.pagerduty.com/incidents/${id}`,
    service: { id: over.service ?? "PSVC1" },
    priority: { name: "P1" },
    assignments: [{ assignee: { id: "U1", email: "alice@example.com", summary: "Alice" } }],
  };
}

function seedPagerduty(rows: Record<string, unknown>[]): void {
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "pagerduty");
  syncPagerdutyIncidentItems(ctx, rows, "", NOW, new Map());
  db.run("INSERT OR REPLACE INTO sync_state (connector_id, last_sync_at) VALUES (?, ?)", [
    "pagerduty",
    NOW - 10 * 60_000,
  ]);
}

function seedAlert(raw: Record<string, unknown>): void {
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "jira");
  const row = mapJsmAlertToItem(raw, { syncedAt: NOW });
  if (row === null) throw new Error("alert fixture did not map");
  ctx.upsertItem(row);
}

function seedShift(name: string, email: string | null): void {
  upsertOncallShift(
    syncTestContext(db, EMPTY_NIMBUS_VAULT, "pagerduty"),
    {
      source: "pagerduty",
      userId: `U-${name}`,
      userName: name,
      userEmail: email,
      policyId: "EP1",
      policyName: "Payments policy",
      level: 1,
      scheduleId: "S1",
      scheduleName: "Payments primary",
      startMs: NOW - HOUR,
      endMs: NOW + HOUR,
      serviceIds: ["PSVC1"],
      serviceNames: ["payments"],
      serviceMapComplete: true,
      isMe: true,
      url: null,
    },
    NOW,
  );
}

describe("buildStatuspageModel: incidents", () => {
  test("an empty index says NO DATA, which is not 'no open incidents'", () => {
    const m = buildStatuspageModel(db, { nowMs: NOW, serviceConfigs: configs() });
    expect(m.incidents.status).toBe("no_data");
    expect(m.incidents.items).toEqual([]);
    expect(m.gaps.join("\n")).toContain("No PagerDuty incident data is indexed");
    expect(m.gaps.join("\n")).toContain("No Jira Service Management alert data is indexed");
    expect(m.onCall.status).toBe("no_data");
    expect(m.dora.status).toBe("no_services");
  });

  test("a synced source with every incident resolved is 'none_open'", () => {
    seedPagerduty([pdIncident("PRES1", { status: "resolved" })]);
    const m = buildStatuspageModel(db, { nowMs: NOW, serviceConfigs: configs() });
    expect(m.incidents.status).toBe("none_open");
    expect(m.incidents.sources.find((s) => s.source === "pagerduty")?.indexed).toBe(true);
    expect(m.incidents.sources.find((s) => s.source === "jsm")?.indexed).toBe(false);
  });

  test("open PagerDuty incidents and open JSM alerts are listed, newest first, closed alerts dropped", () => {
    seedPagerduty([pdIncident("PA1", { createdMs: NOW - 3 * HOUR }), pdIncident("PB2")]);
    seedAlert({
      id: "11111111-aaaa-bbbb-cccc-222222222222",
      message: "Disk full",
      status: "open",
      priority: "P2",
      createdAt: new Date(NOW - HOUR).toISOString(),
      updatedAt: new Date(NOW - HOUR).toISOString(),
      tags: ["payments"],
    });
    seedAlert({
      id: "99999999-aaaa-bbbb-cccc-222222222222",
      message: "Old",
      status: "closed",
      createdAt: new Date(NOW - 2 * DAY).toISOString(),
    });
    const m = buildStatuspageModel(db, { nowMs: NOW, serviceConfigs: configs() });
    expect(m.incidents.status).toBe("open");
    expect(m.incidents.items.map((i) => i.ref)).toEqual(["11111111-aaaa-bb", "PB2", "PA1"]);
    expect(m.incidents.items[0]).toMatchObject({
      kind: "jsm_alert",
      severity: "P2",
      status: "open",
    });
    expect(m.incidents.items[1]).toMatchObject({
      kind: "pagerduty_incident",
      severity: "P1",
      urgency: "high",
      status: "triggered",
    });
  });

  test("LEAK RULES: no title, link, e-mail or assignee by default", () => {
    seedPagerduty([pdIncident("PA1", { title: "Mail bob@corp.example failing" })]);
    const m = buildStatuspageModel(db, { nowMs: NOW, serviceConfigs: configs() });
    const json = JSON.stringify(m);
    expect(json).not.toContain("Mail bob");
    expect(json).not.toContain("pagerduty.com");
    expect(json).not.toContain("alice");
    expect(json).not.toContain("@");
    expect(m.incidents.items[0]).not.toHaveProperty("title");
    expect(m.incidents.items[0]).not.toHaveProperty("url");
  });

  test("--titles adds a scrubbed title; --links adds the http(s) URL", () => {
    seedPagerduty([
      pdIncident("PA1", { title: "Mail bob@corp.example failing at https://x.test/y" }),
    ]);
    const t = buildStatuspageModel(db, { nowMs: NOW, serviceConfigs: configs(), titles: true });
    expect(t.incidents.items[0]?.title).toBe("Mail [redacted] failing at [link removed]");
    expect(t.incidents.items[0]).not.toHaveProperty("url");
    const l = buildStatuspageModel(db, {
      nowMs: NOW,
      serviceConfigs: configs(),
      titles: true,
      links: true,
    });
    expect(l.incidents.items[0]?.url).toBe("https://acme.pagerduty.com/incidents/PA1");
    expect(l.incidents.items[0]?.title).toContain("https://x.test/y");
    expect(JSON.stringify(l)).not.toContain("bob@");
  });

  test("a service binds through [ci.service] pagerduty ids and JSM alert tags; --service filters", () => {
    seedPagerduty([
      pdIncident("PA1", { service: "PSVC1" }),
      pdIncident("PB2", { service: "OTHER" }),
    ]);
    seedAlert({
      id: "a1a1a1a1-0000-0000-0000-000000000000",
      message: "x",
      status: "open",
      createdAt: new Date(NOW - HOUR).toISOString(),
      tags: ["Payments"],
    });
    const cfg = configs(
      config("payments", { pagerdutyServices: ["PSVC1"], jsmAlertTags: ["payments"] }),
    );
    const all = buildStatuspageModel(db, { nowMs: NOW, serviceConfigs: cfg });
    expect(all.incidents.items.map((i) => [i.ref, i.service])).toEqual(
      expect.arrayContaining([
        ["PA1", "payments"],
        ["PB2", null],
        ["a1a1a1a1-0000-00", "payments"],
      ]),
    );
    const only = buildStatuspageModel(db, {
      nowMs: NOW,
      serviceConfigs: cfg,
      services: ["PAYMENTS"],
    });
    expect(only.incidents.items.map((i) => i.ref).sort()).toEqual(["PA1", "a1a1a1a1-0000-00"]);
    expect(only.options.services).toEqual(["payments"]);
  });

  test("an unknown --service is reported as a gap and filters everything out", () => {
    seedPagerduty([pdIncident("PA1")]);
    const m = buildStatuspageModel(db, {
      nowMs: NOW,
      serviceConfigs: configs(config("payments")),
      services: ["nope"],
    });
    expect(m.gaps.join("\n")).toContain('Service "nope" is not configured');
    expect(m.incidents.items).toEqual([]);
    expect(m.onCall.status).toBe("no_match");
  });

  test("the list is capped and says so", () => {
    seedPagerduty(
      Array.from({ length: STATUSPAGE_MAX_INCIDENTS + 5 }, (_, i) =>
        pdIncident(`P${String(i).padStart(4, "0")}`),
      ),
    );
    const m = buildStatuspageModel(db, { nowMs: NOW, serviceConfigs: configs() });
    expect(m.incidents.items).toHaveLength(STATUSPAGE_MAX_INCIDENTS);
    expect(m.incidents.total).toBe(STATUSPAGE_MAX_INCIDENTS + 5);
    expect(m.gaps.join("\n")).toContain("Only the newest 100 of 105");
  });

  test("a source last synced over six hours ago is called out", () => {
    seedPagerduty([pdIncident("PA1")]);
    db.run("UPDATE sync_state SET last_sync_at = ? WHERE connector_id = 'pagerduty'", [
      NOW - 7 * HOUR,
    ]);
    const m = buildStatuspageModel(db, { nowMs: NOW, serviceConfigs: configs() });
    expect(m.incidents.sources[0]?.stale).toBe(true);
    expect(m.gaps.join("\n")).toContain("PagerDuty data was last synced more than 6 hours");
  });
});

describe("buildStatuspageModel: on call", () => {
  test("shows a display name and never an e-mail", () => {
    seedShift("Alice Ng", "alice@example.com");
    const m = buildStatuspageModel(db, { nowMs: NOW, serviceConfigs: configs() });
    expect(m.onCall.status).toBe("ok");
    expect(m.onCall.shifts[0]).toMatchObject({ name: "Alice Ng", schedule: "Payments primary" });
    expect(JSON.stringify(m)).not.toContain("alice@");
    expect(JSON.stringify(m)).not.toContain("isMe");
  });

  test("a person known only by e-mail has no name", () => {
    seedShift("alice@example.com", "alice@example.com");
    const m = buildStatuspageModel(db, { nowMs: NOW, serviceConfigs: configs() });
    expect(m.onCall.shifts[0]?.name).toBeNull();
    expect(JSON.stringify(m)).not.toContain("alice");
  });

  test("--service resolves through the binding", () => {
    seedShift("Alice Ng", null);
    const cfg = configs(config("payments", { pagerdutyServices: ["PSVC1"] }), config("other"));
    const m = buildStatuspageModel(db, {
      nowMs: NOW,
      serviceConfigs: cfg,
      services: ["payments", "other"],
    });
    expect(m.onCall.shifts).toHaveLength(1);
    expect(m.gaps.join("\n")).toContain('No on-call schedule is mapped to service "other"');
  });
});

describe("buildStatuspageModel: on call, merged scopes", () => {
  test("two services over the same schedule list the shift once and merge source ages", () => {
    seedShift("Alice Ng", null);
    const cfg = configs(
      config("a", { pagerdutyServices: ["PSVC1"] }),
      config("b", { pagerdutyServices: ["PSVC1"] }),
    );
    const m = buildStatuspageModel(db, { nowMs: NOW, serviceConfigs: cfg, services: ["a", "b"] });
    expect(m.onCall.shifts).toHaveLength(1);
    expect(m.onCall.sources).toHaveLength(1);
    expect(m.onCall.sources[0]).toMatchObject({ source: "pagerduty", oldestFetchedMs: NOW });
  });
});

describe("buildStatuspageModel: DORA", () => {
  test("a configured service with no data reports gaps, never a zero", () => {
    const m = buildStatuspageModel(db, {
      nowMs: NOW,
      serviceConfigs: configs(config("payments", { pagerdutyServices: ["PSVC1"] })),
    });
    expect(m.dora.status).toBe("ok");
    const row = m.dora.rows[0];
    expect(row?.service).toBe("payments");
    expect(row?.deployment_frequency.value).toBeNull();
    expect(row?.deployment_frequency.gap).toBe("no_repos");
    expect(row?.mttr.value).toBeNull();
  });

  test("MTTR is computed from resolved incidents written by the real PagerDuty writer", () => {
    const rows = [1, 2, 3].map((n) => {
      const created = NOW - n * DAY;
      return {
        ...pdIncident(`PR${String(n)}`, { status: "resolved" }),
        created_at: new Date(created).toISOString(),
        updated_at: new Date(created + HOUR).toISOString(),
        last_status_change_at: new Date(created + HOUR).toISOString(),
      };
    });
    seedPagerduty(rows);
    const m = buildStatuspageModel(db, {
      nowMs: NOW,
      serviceConfigs: configs(config("payments", { pagerdutyServices: ["PSVC1"] })),
    });
    expect(m.dora.rows[0]?.mttr).toMatchObject({ value: 3600, unit: "seconds_median", sample: 3 });
  });

  test("a config that could not be read is reported, not hidden", () => {
    const m = buildStatuspageModel(db, {
      nowMs: NOW,
      serviceConfigs: configs(),
      configError: true,
    });
    expect(m.dora.status).toBe("config_error");
    expect(m.gaps.join("\n")).toContain("could not be read");
  });

  test("no repository name appears anywhere in the model", () => {
    const m = buildStatuspageModel(db, {
      nowMs: NOW,
      serviceConfigs: configs(
        config("payments", { repos: [{ provider: "github", providerId: "acme/secret-repo" }] }),
      ),
    });
    expect(JSON.stringify(m)).not.toContain("secret-repo");
  });
});

describe("scrubPublicText", () => {
  test("removes e-mails, URLs and whitespace runs, and caps length", () => {
    expect(scrubPublicText("a  b\n c@d.io https://e.f/g", 100)).toBe(
      "a b [redacted] [link removed]",
    );
    expect(scrubPublicText("see https://e.f/g", 100, true)).toBe("see https://e.f/g");
    expect(scrubPublicText("x".repeat(50), 10)).toHaveLength(10);
  });

  test("an address is the whole run around an inner @, stopped by separators", () => {
    expect(scrubPublicText("<a@b@c>", 100)).toBe("<[redacted]>");
    expect(scrubPublicText("(x@@y), z", 100)).toBe("([redacted]), z");
    expect(scrubPublicText("pager:ops@corp.example;", 100)).toBe("pager:[redacted];");
  });

  test("an @ at either end of a run is not an address", () => {
    expect(scrubPublicText("@here and ab@ stay", 100)).toBe("@here and ab@ stay");
  });

  test("a long run with no address scans in linear time", () => {
    const long = `${"a".repeat(200_000)}@`;
    const started = performance.now();
    expect(scrubPublicText(long, 300_000)).toBe(long);
    // Quadratic backtracking over 200k characters takes many seconds; a linear scan takes milliseconds.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
