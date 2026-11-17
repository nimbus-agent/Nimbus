import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { DEFAULT_INCIDENT_CONFIG } from "../../../src/config/incident-toml.ts";
import { DEFAULT_ONCALL_PUSH_CONFIG } from "../../../src/config/oncall-push-toml.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "../../../src/connectors/connector-sync-test-helpers.ts";
import { syncPagerdutyIncidentItems } from "../../../src/connectors/pagerduty-sync.ts";
import {
  configMap,
  HOUR,
  markSynced,
  resolverFor,
  serviceConfig,
  T0,
  writePagerdutyShift,
} from "../../../src/incident/__fixtures__/index-writers.ts";
import {
  writeJsmAlert,
  writeSentryIssue,
} from "../../../src/incident/__fixtures__/trigger-writers.ts";
import { createIncidentEngine } from "../../../src/incident/incident-engine.ts";
import { createOncallPushRunner } from "../../../src/oncall-push/push-runner.ts";
import { PushStore } from "../../../src/oncall-push/push-store.ts";
import { findPersonByCanonicalEmail } from "../../../src/people/person-store.ts";

/**
 * The Phase 17 P17 cascade criterion (spec § 1), IC4: with three alerts across `web`, `api` and `db`
 * (`web` and `api` declare `depends_on = ["db"]`), the pushed brief of the last record names `db` as the
 * root and the other two as downstream with the declared dependency, within 15 seconds of the last trigger
 * item being indexed, with no query by the owner and no egress row. Real SQLite, the real connector writers and
 * mappers (no hand-seeded edges), the real incident engine and the real push runner.
 */
const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const ME = "me@acme.example";
const MIN = 60_000;
const api = serviceConfig({
  serviceId: "api",
  pagerdutyServices: ["PSVC_API"],
  jsmAlertTags: [],
  sentryProjects: [],
  dataModels: [],
});
const web = serviceConfig({
  serviceId: "web",
  pagerdutyServices: ["PSVC_WEB"],
  jsmAlertTags: [],
  sentryProjects: ["web-app"],
  dataModels: [],
});
const dbSvc = serviceConfig({
  serviceId: "db",
  pagerdutyServices: ["PSVC_DB"],
  jsmAlertTags: ["db"],
  sentryProjects: [],
  dataModels: [],
});
const resolver = resolverFor(api, web, dbSvc);
const DEPENDS = new Map<string, readonly string[]>([
  ["web", ["db"]],
  ["api", ["db"]],
  ["db", []],
]);
const PUSH_CONFIG = {
  ...DEFAULT_ONCALL_PUSH_CONFIG,
  sources: ["pagerduty", "jira", "sentry"],
  severities: ["p1", "fatal", "SEV-1"],
};

type Order = ("api" | "db" | "web")[];

async function scenario(order: Order): Promise<{
  briefOfLast: string;
  lastItem: string;
  elapsedMs: number;
  egressRows: number;
  statements: number;
}> {
  const db = createMemoryIndexDb();
  dbs.push(db);
  const now = T0 + HOUR;
  const nowFn = (): number => now;
  markSynced(db, "pagerduty", now);
  writePagerdutyShift(db, {
    startMs: now - HOUR,
    endMs: now + HOUR,
    fetchedAtMs: now - MIN,
    isMe: true,
    serviceIds: ["PSVC_API", "PSVC_WEB", "PSVC_DB"],
  });

  const seedApi = (openedAtMs: number): string => {
    syncPagerdutyIncidentItems(
      syncTestContext(
        db,
        createStubVault({ "pagerduty.api_token": "tok" }),
        "pagerduty",
        "full",
        resolver,
      ),
      [
        {
          id: "API1",
          status: "triggered",
          title: "api error rate",
          priority: { name: "P1" },
          created_at: new Date(openedAtMs).toISOString(),
          updated_at: new Date(openedAtMs).toISOString(),
          service: { id: "PSVC_API" },
          assignments: [{ assignee: { id: "U1", type: "user", email: ME } }],
        },
      ],
      new Date(openedAtMs - 86_400_000).toISOString(),
      openedAtMs,
      new Map(),
    );
    return "pagerduty:API1";
  };
  const seed = {
    api: (at: number) => ({ service: "pagerduty", item: seedApi(at) }),
    web: (at: number) => ({
      service: "sentry",
      item: writeSentryIssue(
        db,
        {
          id: "W1",
          title: "web checkout crashes",
          level: "fatal",
          firstSeenMs: at,
          project: "web-app",
        },
        resolver,
      ),
    }),
    db: (at: number) => ({
      service: "jira",
      item: writeJsmAlert(
        db,
        { id: "D1", message: "db primary is down", priority: "P1", openedAtMs: at, tags: ["db"] },
        resolver,
      ),
    }),
  } as const;

  const engine = createIncidentEngine({
    db,
    now: nowFn,
    emit: () => {},
    loadServiceConfigs: () => configMap(api, web, dbSvc),
    readConfig: () => ({ incident: DEFAULT_INCIDENT_CONFIG, pagerdutyP1Aliases: [] }),
    demo: false,
    logger: { warn: () => {} },
    yieldToEventLoop: async () => {},
  });
  const store = new PushStore(db);
  store.reconcileEnabledState(true, T0 - HOUR);
  let statements = 0;
  const counted = new Proxy(db, {
    get(target, prop) {
      if (prop === "query" || prop === "prepare" || prop === "run") statements += 1;
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const runner = createOncallPushRunner({
    db: counted,
    store,
    config: PUSH_CONFIG,
    isEnabled: () => true,
    pagerdutyAliases: [],
    // the assignee becomes a person when the first PagerDuty incident is indexed
    resolveSelf: async () => findPersonByCanonicalEmail(db, ME)?.id ?? null,
    deliver: async () => {},
    records: engine,
    serviceConfig: (id) => configMap(api, web, dbSvc).get(id),
    dependsOn: () => DEPENDS,
    now: nowFn,
  });

  const egressBefore = (db.query("SELECT count(*) AS n FROM egress_ledger").get() as { n: number })
    .n;
  let last = { service: "", item: "" };
  let started = 0;
  for (const [i, who] of order.entries()) {
    started = performance.now();
    last = seed[who](T0 + 10 * MIN + i * 20_000);
    await engine.trigger(last.service);
    statements = 0;
    await runner.run(last.service);
  }
  const elapsedMs = performance.now() - started;
  return {
    briefOfLast: store.get(last.item)?.briefMarkdown ?? "",
    lastItem: last.item,
    elapsedMs,
    egressRows:
      (db.query("SELECT count(*) AS n FROM egress_ledger").get() as { n: number }).n - egressBefore,
    statements,
  };
}

describe("P17 cascade root-cause ranking (IC4)", () => {
  test("db alerts last: its own pushed brief names it the root and lists api and web downstream by the declared dependency", async () => {
    const r = await scenario(["api", "web", "db"]);
    expect(r.briefOfLast).toContain("## Cascade");
    expect(r.briefOfLast).toContain("This record is the ranked root candidate of 3 open records");
    expect(r.briefOfLast).toContain("depends on the root through api -> db (declared depends_on)");
    expect(r.briefOfLast).toContain("depends on the root through web -> db (declared depends_on)");
    expect(r.briefOfLast).not.toMatch(/root cause|caused by/i);
  });

  test("the round-1 order (api alerts before db, web last): the last brief still names db the root, and web downstream of it", async () => {
    const r = await scenario(["api", "db", "web"]);
    expect(r.lastItem).toBe("sentry:W1");
    expect(r.briefOfLast).toContain(
      "This record is downstream of `db primary is down`, the ranked root candidate of 3 open records",
    );
    expect(r.briefOfLast).toContain("- Root candidate: db primary is down (jira, db");
    expect(r.briefOfLast).toContain("depends on the root through api -> db (declared depends_on)");
    expect(r.briefOfLast).toContain("depends on the root through web -> db (declared depends_on)");
  });

  test("it is ready in under 15 s from the last trigger item, with bounded work, no query by the owner and no egress row", async () => {
    const r = await scenario(["api", "db", "web"]);
    expect(r.elapsedMs).toBeLessThan(15_000);
    // the push of the last record: a bounded number of SQL statements, whatever the index holds
    expect(r.statements).toBeLessThan(50);
    expect(r.egressRows).toBe(0);
  });
});
