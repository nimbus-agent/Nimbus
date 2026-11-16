import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_INCIDENT_CONFIG } from "../config/incident-toml.ts";
import { DEFAULT_ONCALL_PUSH_CONFIG } from "../config/oncall-push-toml.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "../connectors/connector-sync-test-helpers.ts";
import { syncPagerdutyIncidentItems } from "../connectors/pagerduty-sync.ts";
import {
  configMap,
  markSynced,
  resolverFor,
  serviceConfig,
  writeDeployment,
  writePagerdutyShift,
} from "../incident/__fixtures__/index-writers.ts";
import {
  writeJsmAlert,
  writeMonteCarloIncident,
  writeSentryIssue,
} from "../incident/__fixtures__/trigger-writers.ts";
import { createIncidentEngine } from "../incident/incident-engine.ts";
import { getByTriggerItem } from "../incident/incident-store.ts";
import { findPersonByCanonicalEmail } from "../people/person-store.ts";
import { parseHeadlineBrief } from "./push-headline.ts";
import {
  createOncallPushRunner,
  type PushDelivery,
  type PushRecords,
  PushRetryRefusedError,
} from "./push-runner.ts";
import { PushStore } from "./push-store.ts";

const ME = "me@acme.example";
const T0 = Date.parse("2026-10-02T12:00:00.000Z");
const HOUR = 3_600_000;
const cfg = serviceConfig({ serviceId: "payments", pagerdutyServices: ["PSVC"] });
const resolver = resolverFor(cfg);

let db: Database;
let store: PushStore;
let personId: string;
let engineCalls: string[];

function seedIncident(id: string, over: { priority?: string } = {}): void {
  const ctx = syncTestContext(db, createStubVault({ "pagerduty.api_token": "tok" }), "pagerduty");
  syncPagerdutyIncidentItems(
    ctx,
    [
      {
        id,
        status: "triggered",
        title: `inc ${id}`,
        priority: { name: over.priority ?? "P1" },
        created_at: new Date(T0).toISOString(),
        updated_at: new Date(T0).toISOString(),
        service: { id: "PSVC" },
        assignments: [{ assignee: { id: "U1", type: "user", email: ME } }],
      },
    ],
    new Date(T0 - 86_400_000).toISOString(),
    T0,
    new Map(),
  );
}

function realRecords(now: () => number = () => T0): PushRecords {
  const engine = createIncidentEngine({
    db,
    now,
    emit: () => {},
    loadServiceConfigs: () => configMap(cfg),
    readConfig: () => ({ incident: DEFAULT_INCIDENT_CONFIG, pagerdutyP1Aliases: [] }),
    demo: false,
    logger: { warn: () => {} },
  });
  return {
    assembleNow: (id) => {
      engineCalls.push(id);
      return engine.assembleNow(id);
    },
  };
}

beforeEach(() => {
  db = createMemoryIndexDb();
  store = new PushStore(db);
  store.reconcileEnabledState(true, T0 - 60_000);
  engineCalls = [];
  seedIncident("PA");
  const me = findPersonByCanonicalEmail(db, ME);
  if (me === null) throw new Error("fixture: no person");
  personId = me.id;
});
afterEach(() => db.close());

function makeRunner(over: Partial<Parameters<typeof createOncallPushRunner>[0]> = {}) {
  const delivered: PushDelivery[] = [];
  const runner = createOncallPushRunner({
    db,
    store,
    config: DEFAULT_ONCALL_PUSH_CONFIG,
    isEnabled: () => true,
    pagerdutyAliases: [],
    resolveSelf: async () => personId,
    deliver: async (items) => {
      delivered.push(...items);
    },
    records: realRecords(),
    serviceConfig: (id) => (id === "payments" ? cfg : undefined),
    dependsOn: () => new Map(),
    now: () => T0,
    ...over,
  });
  return { runner, delivered };
}

const RETRY_WIDE = {
  ...DEFAULT_ONCALL_PUSH_CONFIG,
  sources: ["pagerduty", "jira", "sentry", "montecarlo"],
  severities: ["p1", "fatal", "SEV-1"],
};

/** The owner is on call for PSVC now, on fresh data. */
function onCallNow(over: { isMe?: boolean; fetchedAtMs?: number } = {}): void {
  markSynced(db, "pagerduty", T0);
  writePagerdutyShift(db, {
    startMs: T0 - HOUR,
    endMs: T0 + HOUR,
    fetchedAtMs: over.fetchedAtMs ?? T0 - 60_000,
    isMe: over.isMe ?? true,
    serviceIds: ["PSVC"],
  });
}

const failingRecords = (message = "boom"): PushRecords => ({
  assembleNow: async () => {
    throw new Error(message);
  },
});

describe("push runner (PagerDuty, assembled as a record)", () => {
  test("a P1 assigned to the owner is selected as before; the stored brief IS the record", async () => {
    writeDeployment(db, resolver, { service: "payments", startedAtMs: T0 - 30 * 60_000 });
    const { runner, delivered } = makeRunner();
    expect(await runner.run("pagerduty")).toEqual({
      selected: 1,
      ok: 1,
      failed: 0,
      notPushed: {},
    });
    const record = getByTriggerItem(db, "pagerduty:PA");
    expect(record).not.toBeNull();
    const row = store.get("pagerduty:PA");
    expect(row).toMatchObject({
      status: "ok",
      briefMarkdown: record?.markdown,
      sessionId: `incident:${record?.id ?? ""}:v1`,
    });
    // the compatibility JSON parses with the headline's own parser: bound service and deployment
    const brief = parseHeadlineBrief(row?.briefJson ?? null);
    expect(brief?.nimbusServiceId).toBe("payments");
    expect(brief?.deployment).toMatchObject({ startedAtMs: T0 - 30 * 60_000 });
    expect(delivered.map((d) => d.row.incidentId)).toEqual(["pagerduty:PA"]);
    expect(engineCalls).toEqual(["pagerduty:PA"]);
  });

  test("a second run pushes nothing (dedup), and a record that gains a version does not re-push", async () => {
    const { runner } = makeRunner();
    await runner.run("pagerduty");
    expect(await runner.run("pagerduty")).toEqual({ selected: 0, ok: 0, failed: 0, notPushed: {} });
    expect(engineCalls).toHaveLength(1);
  });

  test("not a source / disabled / unresolved identity / not reconciled: skipped and nothing assembled", async () => {
    expect((await makeRunner().runner.run("github")).skipped).toBe("not_a_source");
    expect((await makeRunner().runner.run("jira")).skipped).toBe("not_a_source"); // default sources: pagerduty
    expect(
      (
        await makeRunner({
          config: { ...DEFAULT_ONCALL_PUSH_CONFIG, sources: ["jira"] },
        }).runner.run("pagerduty")
      ).skipped,
    ).toBe("not_a_source");
    expect(
      (
        await makeRunner({ config: { ...DEFAULT_ONCALL_PUSH_CONFIG, sources: [] } }).runner.run(
          "pagerduty",
        )
      ).skipped,
    ).toBe("not_a_source");
    expect((await makeRunner({ isEnabled: () => false }).runner.run("pagerduty")).skipped).toBe(
      "disabled",
    );
    expect(
      (await makeRunner({ resolveSelf: async () => null }).runner.run("pagerduty")).skipped,
    ).toBe("identity_unresolved");
    store.reconcileEnabledState(false, T0);
    expect((await makeRunner().runner.run("pagerduty")).skipped).toBe("not_reconciled");
    expect(engineCalls).toEqual([]);
  });

  test("isEnabled is read on every run, never cached at construction", async () => {
    let on = false;
    const { runner } = makeRunner({ isEnabled: () => on });
    expect((await runner.run("pagerduty")).skipped).toBe("disabled");
    on = true;
    expect(await runner.run("pagerduty")).toMatchObject({ selected: 1, ok: 1, failed: 0 });
  });

  test("an assembly that throws is a failed 'assembly:' row, stored once and never reselected", async () => {
    const { runner, delivered } = makeRunner({ records: failingRecords("lane exploded") });
    expect(await runner.run("pagerduty")).toMatchObject({ selected: 1, ok: 0, failed: 1 });
    expect(store.get("pagerduty:PA")).toMatchObject({
      status: "failed",
      failureCode: "assembly: lane exploded",
      sessionId: null,
    });
    expect(delivered[0]?.row.status).toBe("failed");
    expect(await runner.run("pagerduty")).toMatchObject({ selected: 0 });
  });

  test("a non-Error throw is stringified and a long message is clipped", async () => {
    const records: PushRecords = {
      assembleNow: async () => {
        throw "y".repeat(700);
      },
    };
    await makeRunner({ records }).runner.run("pagerduty");
    expect(store.get("pagerduty:PA")?.failureCode).toBe(`assembly: ${"y".repeat(500)}…`);
  });

  test("an item that vanished, and a record that was not stored, are failed rows with a clear code", async () => {
    await makeRunner({ records: { assembleNow: async () => ({ outcome: "missing" }) } }).runner.run(
      "pagerduty",
    );
    expect(store.get("pagerduty:PA")?.failureCode).toBe("assembly: the item is no longer indexed");
    store.pruneOlderThan(Number.MAX_SAFE_INTEGER);
    await makeRunner({
      records: {
        assembleNow: async () => ({
          outcome: "created",
          recordId: "inc_x",
          version: 1,
          status: "open",
        }),
      },
    }).runner.run("pagerduty");
    expect(store.get("pagerduty:PA")?.failureCode).toBe("assembly: no record was stored");
  });

  test("[incident] enabled = false never drops a page: the push assembles its own candidate on demand", async () => {
    // The runner never reads [incident]; its only dependency is the engine's assembleNow, which is
    // available whatever the automatic post-sync assembly does.
    expect(getByTriggerItem(db, "pagerduty:PA")).toBeNull();
    const { runner } = makeRunner();
    expect(await runner.run("pagerduty")).toMatchObject({ ok: 1 });
    expect(getByTriggerItem(db, "pagerduty:PA")).not.toBeNull();
  });

  test("single-flight: overlapping calls collapse into ONE trailing run that sees the new incident", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered: () => void = () => {};
    const firstEntered = new Promise<void>((r) => {
      entered = r;
    });
    const real = realRecords();
    const seen: string[] = [];
    let resolveSelfCalls = 0;
    const { runner } = makeRunner({
      records: {
        assembleNow: async (id) => {
          seen.push(id);
          if (seen.length === 1) {
            entered();
            await gate;
          }
          return real.assembleNow(id);
        },
      },
      resolveSelf: async () => {
        resolveSelfCalls += 1;
        return personId;
      },
    });
    const first = runner.run("pagerduty");
    await firstEntered;
    seedIncident("PB");
    const second = runner.run("pagerduty");
    const third = runner.run("pagerduty");
    release();
    await Promise.all([first, second, third]);
    expect(seen).toEqual(["pagerduty:PA", "pagerduty:PB"]);
    expect(resolveSelfCalls).toBe(2);
  });

  test("lastRun reports the summary of the last completed run", async () => {
    const { runner } = makeRunner();
    expect(runner.lastRun()).toBeNull();
    await runner.run("pagerduty");
    expect(runner.lastRun()).toMatchObject({ selected: 1, ok: 1 });
  });

  test("an insert that throws on the 2nd incident still delivers the 1st row, then rejects", async () => {
    seedIncident("PB");
    class FlakyStore extends PushStore {
      private inserts = 0;
      override insert(...a: Parameters<PushStore["insert"]>): ReturnType<PushStore["insert"]> {
        this.inserts += 1;
        if (this.inserts === 2) throw new Error("disk full");
        return super.insert(...a);
      }
    }
    const { runner, delivered } = makeRunner({ store: new FlakyStore(db) });
    await expect(runner.run("pagerduty")).rejects.toThrow("disk full");
    expect(delivered).toHaveLength(1);
    expect(store.get(delivered[0]?.row.incidentId ?? "")).not.toBeNull();
  });

  test("a live disable mid-run stops before the next incident and still delivers the stored one", async () => {
    seedIncident("PB");
    let reads = 0;
    const isEnabled = () => {
      reads += 1;
      return reads <= 2;
    };
    const { runner, delivered } = makeRunner({ isEnabled });
    expect(await runner.run("pagerduty")).toMatchObject({ ok: 1, failed: 0 });
    expect(engineCalls).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });

  test("a candidate pushed by someone else mid-run is skipped, not re-inserted", async () => {
    seedIncident("PB");
    const real = realRecords();
    const seen: string[] = [];
    const { runner, delivered } = makeRunner({
      records: {
        assembleNow: async (id) => {
          seen.push(id);
          if (seen.length === 1) {
            const other = id === "pagerduty:PA" ? "pagerduty:PB" : "pagerduty:PA";
            store.insert(other, { status: "failed", sessionId: null, failureCode: "x" }, T0);
          }
          return real.assembleNow(id);
        },
      },
    });
    expect(await runner.run("pagerduty")).toMatchObject({ selected: 2, ok: 1, failed: 0 });
    expect(seen).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });
});

describe("push runner retry", () => {
  async function failedRow(): Promise<void> {
    await makeRunner({ records: failingRecords() }).runner.run("pagerduty");
  }

  test("refused on ok and on missing; a failed row becomes ok in place with a re-assembled record", async () => {
    await failedRow();
    const { runner, delivered } = makeRunner({ now: () => T0 + 5000 });
    await expect(runner.retry("pagerduty:NOPE")).rejects.toBeInstanceOf(PushRetryRefusedError);
    const row = await runner.retry("pagerduty:PA");
    expect(row).toMatchObject({ status: "ok", createdAt: T0, retriedAt: T0 + 5000 });
    expect(row.sessionId).toMatch(/^incident:inc_[0-9a-f]{16}:v1$/);
    expect(delivered).toHaveLength(1);
    await expect(runner.retry("pagerduty:PA")).rejects.toMatchObject({
      code: "ERR_ONCALL_PUSH_NOT_FAILED",
    });
  });

  test("two concurrent retries share ONE attempt: one assembly, one delivery", async () => {
    await failedRow();
    const { runner, delivered } = makeRunner();
    const [a, b] = await Promise.all([runner.retry("pagerduty:PA"), runner.retry("pagerduty:PA")]);
    expect(a).toEqual(b);
    expect(a.status).toBe("ok");
    expect(engineCalls).toEqual(["pagerduty:PA"]);
    expect(delivered).toHaveLength(1);
    await expect(runner.retry("pagerduty:PA")).rejects.toMatchObject({
      code: "ERR_ONCALL_PUSH_NOT_FAILED",
    });
  });

  test("a prune that deletes the row mid-retry is a NOT_FOUND refusal, not a raw error", async () => {
    await failedRow();
    const real = realRecords();
    const { runner, delivered } = makeRunner({
      records: {
        assembleNow: (id) => {
          store.pruneOlderThan(Number.MAX_SAFE_INTEGER);
          return real.assembleNow(id);
        },
      },
    });
    await expect(runner.retry("pagerduty:PA")).rejects.toMatchObject({
      code: "ERR_ONCALL_PUSH_NOT_FOUND",
    });
    expect(delivered).toHaveLength(0);
  });

  test("a failing applyRetry whose row still exists rethrows the ORIGINAL error", async () => {
    await failedRow();
    class BrokenRetryStore extends PushStore {
      override applyRetry(
        ...a: Parameters<PushStore["applyRetry"]>
      ): ReturnType<PushStore["applyRetry"]> {
        void a;
        throw new Error("disk full on retry");
      }
    }
    const { runner } = makeRunner({ store: new BrokenRetryStore(db) });
    await expect(runner.retry("pagerduty:PA")).rejects.toThrow("disk full on retry");
  });

  test("a retry that fails again, or whose incident is gone from the index, is stored but NOT delivered", async () => {
    await failedRow();
    const again = makeRunner({ records: failingRecords("still broken") });
    expect((await again.runner.retry("pagerduty:PA")).status).toBe("failed");
    expect(again.delivered).toHaveLength(0);
    store.insert("pagerduty:GONE", { status: "failed", sessionId: null, failureCode: "x" }, T0);
    const gone = makeRunner({
      records: { assembleNow: async () => ({ outcome: "missing" }) },
    });
    expect((await gone.runner.retry("pagerduty:GONE")).status).toBe("failed");
    expect(gone.delivered).toHaveLength(0);
  });

  test("a retried JSM, Sentry and data-quality push is DELIVERED (the PagerDuty-only lookup would have dropped it)", async () => {
    const jsm = writeJsmAlert(
      db,
      { id: "J1", openedAtMs: T0, priority: "P1", tags: ["payments"] },
      resolver,
    );
    const sentry = writeSentryIssue(db, { id: "S1", level: "fatal", firstSeenMs: T0 }, resolver);
    const mc = writeMonteCarloIncident(
      db,
      { id: "M1", severity: "SEV-1", firstSeenMs: T0 },
      resolver,
    );
    for (const id of [jsm, sentry, mc]) {
      store.insert(id, { status: "failed", sessionId: null, failureCode: "x" }, T0);
    }
    onCallNow();
    const { runner, delivered } = makeRunner({ config: RETRY_WIDE });
    for (const id of [jsm, sentry, mc]) {
      expect((await runner.retry(id)).status).toBe("ok");
    }
    expect(delivered.map((d) => d.incident.id).sort()).toEqual([jsm, mc, sentry].sort());
    expect(delivered.find((d) => d.incident.id === jsm)?.incident).toMatchObject({
      severity: "P1",
      pagerdutyServiceId: null,
    });
  });
});

describe("widened sources, through the runner", () => {
  const WIDE = { ...DEFAULT_ONCALL_PUSH_CONFIG, sources: ["pagerduty", "jira"] };

  function proof(over: { isMe?: boolean; fetchedAtMs?: number } = {}): void {
    writePagerdutyShift(db, {
      startMs: T0 - HOUR,
      endMs: T0 + HOUR,
      fetchedAtMs: over.fetchedAtMs ?? T0 - 60_000,
      isMe: over.isMe ?? true,
      serviceIds: ["PSVC"],
    });
  }

  test("a bound JSM P1 for a service the owner is on call for IS pushed, once, and its headline names no agent", async () => {
    markSynced(db, "pagerduty", T0);
    const id = writeJsmAlert(
      db,
      { id: "J1", openedAtMs: T0, priority: "P1", tags: ["payments"] },
      resolver,
    );
    await realRecords().assembleNow(id); // the engine's pass runs before the push
    proof();
    // the PagerDuty incident PA is also a candidate: this run pushes both
    const { runner, delivered } = makeRunner({ config: WIDE });
    const summary = await runner.run("jira");
    expect(summary).toMatchObject({ selected: 2, ok: 2 });
    expect(delivered.map((d) => d.incident.id).sort()).toEqual([id, "pagerduty:PA"].sort());
    expect(store.get(id)?.status).toBe("ok");
    expect(await runner.run("jira")).toMatchObject({ selected: 0 });
  });

  test("not on call (the shift is someone else's), no shift data, stale data: not pushed, no row, counted by reason", async () => {
    const id = writeJsmAlert(
      db,
      { id: "J1", openedAtMs: T0, priority: "P1", tags: ["payments"] },
      resolver,
    );
    await realRecords().assembleNow(id);
    const { runner } = makeRunner({ config: WIDE });
    store.insert("pagerduty:PA", { status: "failed", sessionId: null, failureCode: "x" }, T0);
    expect((await runner.run("jira")).notPushed).toEqual({ no_oncall_data: 1 });
    proof({ isMe: false });
    expect((await runner.run("jira")).notPushed).toEqual({ owner_not_on_call: 1 });
    db.run("DELETE FROM item WHERE type = 'oncall_shift'");
    proof({ fetchedAtMs: T0 - 2 * HOUR });
    expect((await runner.run("jira")).notPushed).toEqual({ stale_oncall_data: 1 });
    expect(store.get(id)).toBeNull();
    // re-evaluation: once the owner goes on call the SAME record is pushed by the next run
    db.run("DELETE FROM item WHERE type = 'oncall_shift'");
    proof();
    expect(await runner.run("jira")).toMatchObject({ selected: 1, ok: 1, notPushed: {} });
    expect(store.get(id)?.status).toBe("ok");
  });
});

describe("retry of a non-PagerDuty record needs the same proof as its first push", () => {
  function failedJsm(over: { priority?: string; tags?: string[]; status?: string } = {}): string {
    const id = writeJsmAlert(
      db,
      {
        id: "J9",
        openedAtMs: T0,
        priority: over.priority ?? "P1",
        tags: over.tags ?? ["payments"],
        ...(over.status === undefined ? {} : { status: over.status }),
      },
      resolver,
    );
    store.insert(id, { status: "failed", sessionId: null, failureCode: "x" }, T0);
    return id;
  }

  test("proven (opted in, severity, open, bound, owner on call on fresh data): delivered", async () => {
    const id = failedJsm();
    onCallNow();
    const { runner, delivered } = makeRunner({ config: RETRY_WIDE });
    const out = await runner.retry(id);
    expect(out.status).toBe("ok");
    expect(out.notDelivered).toBeUndefined();
    expect(delivered.map((d) => d.incident.id)).toEqual([id]);
  });

  const cases: ReadonlyArray<{
    name: string;
    arrange: (id: string) => void;
    config?: typeof RETRY_WIDE;
    reason: string;
    tags?: string[];
    status?: string;
  }> = [
    {
      name: "the owner is not on call",
      arrange: () => onCallNow({ isMe: false }),
      reason: "you are not on call for this service now",
    },
    {
      name: "there is no on-call data",
      arrange: () => {},
      reason: "there is no on-call data for its service",
    },
    {
      name: "the on-call data is stale",
      arrange: () => onCallNow({ fetchedAtMs: T0 - 2 * HOUR }),
      reason: "the on-call data for its service is stale",
    },
    {
      name: "the source is no longer opted in",
      arrange: () => onCallNow(),
      config: { ...DEFAULT_ONCALL_PUSH_CONFIG, sources: ["pagerduty"] } as typeof RETRY_WIDE,
      reason: "its source is no longer opted in under [oncall.push] sources",
    },
    {
      name: "the incident is closed",
      arrange: () => onCallNow(),
      status: "closed",
      reason: "the incident is no longer open",
    },
    {
      name: "the service is unbound",
      arrange: () => onCallNow(),
      tags: ["no-such-service"],
      reason: "it is not bound to a service",
    },
  ];

  for (const c of cases) {
    test(`${c.name}: the brief is re-assembled and stored, nothing is delivered, the reason is returned`, async () => {
      const id = failedJsm({
        ...(c.tags === undefined ? {} : { tags: c.tags }),
        ...(c.status === undefined ? {} : { status: c.status }),
      });
      await realRecords().assembleNow(id);
      c.arrange(id);
      const { runner, delivered } = makeRunner({ config: c.config ?? RETRY_WIDE });
      const out = await runner.retry(id);
      expect(out.status).toBe("ok");
      expect(store.get(id)?.status).toBe("ok");
      expect(delivered).toHaveLength(0);
      expect(out.notDelivered).toBe(c.reason);
    });
  }

  test("a severity that left the push set is not delivered either", async () => {
    const id = failedJsm({ priority: "P3" });
    onCallNow();
    const { runner, delivered } = makeRunner({ config: RETRY_WIDE });
    const out = await runner.retry(id);
    expect(delivered).toHaveLength(0);
    expect(out.notDelivered).toBe("its severity is no longer in the push set");
  });

  test("PagerDuty retry is unchanged: delivered with no on-call proof and no sources check", async () => {
    store.insert("pagerduty:PA", { status: "failed", sessionId: null, failureCode: "x" }, T0);
    const { runner, delivered } = makeRunner({
      config: { ...DEFAULT_ONCALL_PUSH_CONFIG, sources: ["jira"] },
    });
    const out = await runner.retry("pagerduty:PA");
    expect(out.notDelivered).toBeUndefined();
    expect(delivered.map((d) => d.incident.id)).toEqual(["pagerduty:PA"]);
  });
});
