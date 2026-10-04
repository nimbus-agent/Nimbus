/**
 * catchup.coverage.test.ts — the arms of agents/catchup.ts the main suite leaves open: incident
 * involvement in scoring, ordering by score rather than recency, a failing sub-agent (a gap, not a
 * failed brief), the default window, the per-service quota, the involvement-present case, and
 * `emitCatchupBrief` with and without a synthesis runner.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { dbExec, dbRun } from "../db/write.ts";
import { upsertGraphRelation } from "../graph/relationship-graph.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";
import {
  type CatchupContext,
  emitCatchupBrief,
  runCatchup,
  scoreAndGroup,
  type WindowItem,
} from "./catchup.ts";

const DAY = 86_400_000;

const openDbs: Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  openDbs.push(db);
  return db;
}

function ctxFor(db: Database): CatchupContext {
  return { db, notify: () => {}, sessionId: "catchup-cov" };
}

function seedItem(
  db: Database,
  i: {
    id: string;
    service: string;
    type: string;
    externalId: string;
    title: string;
    modifiedAt: number;
    authorId?: string;
  },
): void {
  dbRun(
    db,
    "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, author_id) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      i.id,
      i.service,
      i.type,
      i.externalId,
      i.title,
      i.modifiedAt,
      i.modifiedAt,
      i.authorId ?? null,
    ],
  );
}

describe("scoreAndGroup", () => {
  test("incident involvement scores an item, and items order by score before recency", () => {
    const items: WindowItem[] = [
      {
        id: "pd:1",
        service: "pagerduty",
        title: "Checkout down",
        modifiedAt: 300,
        repoLabel: null,
        authorPersonId: null,
      },
      {
        id: "pd:2",
        service: "pagerduty",
        title: "Queue lag",
        modifiedAt: 200,
        repoLabel: null,
        authorPersonId: "person:bob",
      },
    ];
    const [section] = scoreAndGroup(items, {
      ownedServices: [],
      activeRepos: [],
      incidentServices: ["pagerduty"],
      collaboratorPersonIds: ["person:bob"],
    });
    // pd:1 is newer, but pd:2 scores higher (incident + collaborator), so it comes first.
    expect(section?.items.map((i) => i.itemId)).toEqual(["pd:2", "pd:1"]);
    expect(section?.items[0]?.relevanceScore).toBe(1);
    expect(section?.items[0]?.relevanceReasons).toEqual([
      "incident_service:pagerduty",
      "collaborator:person:bob",
    ]);
    expect(section?.items[1]?.relevanceScore).toBe(0.7);
    expect(section?.items[1]?.relevanceReasons).toEqual(["incident_service:pagerduty"]);
  });
});

describe("runCatchup", () => {
  test("a failing sub-agent becomes a gap naming it, and the brief still renders", async () => {
    const db = freshDb();
    seedItem(db, {
      id: "github:acme/app#1",
      service: "github",
      type: "pr",
      externalId: "acme/app#1",
      title: "Fix retries",
      modifiedAt: Date.now(),
      authorId: "person:me",
    });
    // The incidents sub-agent (#2) walks the graph; without it that one sub-agent rejects.
    dbExec(db, "DROP TABLE graph_relation");

    const brief = await runCatchup({ mePersonIdOverride: "person:me" }, ctxFor(db));

    const failed = brief.gaps.filter((g) => g.detail.startsWith("catchup sub-agent #"));
    expect(failed).toHaveLength(1);
    expect(failed[0]?.category).toBe("missing_connector");
    expect(failed[0]?.detail).toMatch(/^catchup sub-agent #2 failed: .+/);
    expect(brief.involvement.activeRepos).toEqual(["acme/app"]);
    expect(brief.sections.map((s) => s.serviceId)).toEqual(["github"]);
  });

  test("with no window given it looks back three days; involvement found means no identity note", async () => {
    const db = freshDb();
    const now = Date.now();
    seedItem(db, {
      id: "github:acme/app#7",
      service: "github",
      type: "pr",
      externalId: "acme/app#7",
      title: "Mine",
      modifiedAt: now,
      authorId: "person:me",
    });
    seedItem(db, {
      id: "slack:C1/1",
      service: "slack",
      type: "message",
      externalId: "C1/1",
      title: "too old for the default window",
      modifiedAt: now - 4 * DAY,
    });

    const brief = await runCatchup({ mePersonIdOverride: "person:me" }, ctxFor(db));

    expect(brief.query.sinceMs).toBe(3 * DAY);
    expect(brief.sections.map((s) => s.serviceId)).toEqual(["github"]);
    const pr = brief.sections[0]?.items[0];
    expect(pr?.relevanceReasons).toEqual(["active_repo:acme/app"]);
    expect(brief.gaps.some((g) => g.detail.startsWith("No involvement signal"))).toBe(false);
  });

  test("every involvement axis is read from the index: owned, repos, incidents, collaborators", async () => {
    const db = freshDb();
    const now = Date.now();
    // Five authored PRs in one repo: `github` is an OWNED service and `acme/app` an ACTIVE repo.
    for (let n = 1; n <= 5; n++) {
      seedItem(db, {
        id: `github:acme/app#${String(n)}`,
        service: "github",
        type: "pr",
        externalId: `acme/app#${String(n)}`,
        title: `Mine ${String(n)}`,
        modifiedAt: now - n * 1000,
        authorId: "person:me",
      });
    }
    // Three items by bob in the same repo: bob is a COLLABORATOR.
    for (let n = 10; n < 13; n++) {
      seedItem(db, {
        id: `github:acme/app#${String(n)}`,
        service: "github",
        type: "pr",
        externalId: `acme/app#${String(n)}`,
        title: `Bob's ${String(n)}`,
        modifiedAt: now - n * 1000,
        authorId: "person:bob",
      });
    }
    // An incident I resolved: `pagerduty` is an INCIDENT service.
    seedItem(db, {
      id: "pagerduty:PD1",
      service: "pagerduty",
      type: "incident",
      externalId: "PD1",
      title: "Checkout 500s",
      modifiedAt: now,
    });
    dbRun(
      db,
      "INSERT INTO graph_entity (id, type, external_id, label) VALUES (?, 'person', ?, 'Me'), (?, 'incident', ?, 'Checkout 500s')",
      ["ge:me", "person:me", "ge:pd1", "pagerduty:PD1"],
    );
    upsertGraphRelation(db, "ge:me", "ge:pd1", "resolves", now);

    const brief = await runCatchup({ sinceMs: DAY, mePersonIdOverride: "person:me" }, ctxFor(db));

    expect(brief.involvement).toEqual({
      ownedServices: ["github"],
      activeRepos: ["acme/app"],
      incidentServices: ["pagerduty"],
      collaboratorPersonIds: ["person:bob"],
    });
    const incident = brief.sections
      .find((s) => s.serviceId === "pagerduty")
      ?.items.find((i) => i.itemId === "pagerduty:PD1");
    expect(incident?.relevanceReasons).toEqual(["incident_service:pagerduty"]);
  });

  test("a service with more items than the quota contributes exactly the quota", async () => {
    const db = freshDb();
    const now = Date.now();
    for (let i = 0; i < 52; i++) {
      seedItem(db, {
        id: `slack:C1/${String(i)}`,
        service: "slack",
        type: "message",
        externalId: `C1/${String(i)}`,
        title: `message ${String(i)}`,
        modifiedAt: now - i * 1000,
      });
    }

    const brief = await runCatchup({ sinceMs: DAY, mePersonIdOverride: "person:me" }, ctxFor(db));

    const slack = brief.sections.find((s) => s.serviceId === "slack");
    expect(slack?.totalItemsInWindow).toBe(50);
    expect(slack?.items).toHaveLength(50);
    // The quota keeps the NEWEST: the two oldest messages are the ones dropped.
    expect(slack?.items.some((i) => i.itemId === "slack:C1/51")).toBe(false);
    expect(slack?.items.some((i) => i.itemId === "slack:C1/0")).toBe(true);
  });
});

/**
 * Emits a catchup brief and returns what the call itself returned plus the `catchup.briefReady`
 * payload the fire-and-forget work notifies; any other notification rejects.
 */
async function emitAndCapture(
  db: Database,
  runner?: SynthesisRunner,
): Promise<{ returned: { sessionId: string }; ready: Record<string, unknown> }> {
  const ready = Promise.withResolvers<Record<string, unknown>>();
  const ctx: CatchupContext = {
    db,
    sessionId: "catchup-emit",
    notify: (method, params) => {
      if (method === "catchup.briefReady") ready.resolve(params as Record<string, unknown>);
      else ready.reject(new Error(`unexpected notification ${method}`));
    },
    ...(runner === undefined ? {} : { runner }),
  };
  const returned = await emitCatchupBrief({ mePersonIdOverride: "person:me" }, ctx);
  return { returned, ready: await ready.promise };
}

describe("emitCatchupBrief", () => {
  test("with no runner the brief is rendered deterministically", async () => {
    const db = freshDb();
    const { returned, ready } = await emitAndCapture(db);
    expect(returned).toEqual({ sessionId: "catchup-emit" });
    expect(ready["sessionId"]).toBe("catchup-emit");
    expect(String(ready["brief"])).toContain("# Catchup");
    expect(ready["synthesis"]).toEqual({ attempted: false, reason: "disabled" });
  });

  test("a supplied runner is used for the synthesis", async () => {
    const db = freshDb();
    let calls = 0;
    const runner: SynthesisRunner = {
      run: () => {
        calls += 1;
        return Promise.resolve({ ok: false, reason: "no_eligible_provider" });
      },
    };
    const { ready } = await emitAndCapture(db, runner);
    expect(calls).toBe(1);
    expect(ready["synthesis"]).toEqual({ attempted: false, reason: "no_eligible_provider" });
  });
});
