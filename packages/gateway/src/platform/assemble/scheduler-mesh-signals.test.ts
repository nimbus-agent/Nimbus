import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import {
  buildSchedulerHarness,
  type SchedulerHarness,
} from "../../../test/helpers/scheduler-mesh-harness.ts";
import { writePagerdutyIncident } from "../../incident/__fixtures__/trigger-writers.ts";
import { insertSyncTelemetry } from "../../sync/scheduler-store.ts";
import type { Syncable } from "../../sync/types.ts";

let h: SchedulerHarness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(10);
}

function seedFlatTelemetry(h2: SchedulerHarness["db"], service: string): void {
  // Five identical, successful runs: zero variance, so any different value scores far above the floor.
  for (let i = 0; i < 5; i++) {
    insertSyncTelemetry(h2, {
      service,
      startedAt: Date.now() - 10_000 + i,
      durationMs: 5,
      itemsUpserted: 1,
      itemsDeleted: 0,
      bytesTransferred: null,
      hadMore: false,
      errorMsg: null,
      itemsDropped: 0,
    });
  }
}

function spike(serviceId: string): Syncable {
  return {
    serviceId,
    defaultIntervalMs: 3_600_000,
    initialSyncDepthDays: 1,
    sync: (_ctx, cursor) =>
      Promise.resolve({
        cursor,
        itemsUpserted: 900,
        itemsDeleted: 0,
        hasMore: false,
        durationMs: 1,
      }),
  };
}

describe("createSchedulerWithMesh: the sync anomaly detector", () => {
  it("scores a spike against the persisted history, logs it and opens a finding; no toast by default", async () => {
    h = await buildSchedulerHarness({ seed: (db) => seedFlatTelemetry(db, "anom-probe") });
    const warn = spyOn(h.logger, "warn");
    h.out.syncScheduler.register(spike("anom-probe"));
    await h.out.syncScheduler.forceSync("anom-probe");
    const logged = warn.mock.calls.find(
      (c) =>
        String(c[1]).startsWith("sync telemetry anomaly") &&
        (c[0] as { seriesId?: string }).seriesId === "sync:items_upserted:anom-probe",
    );
    expect(logged?.[0]).toMatchObject({ seriesId: "sync:items_upserted:anom-probe", value: 900 });
    const finding = h.db
      .query("SELECT kind, service FROM incident_finding WHERE service = ?")
      .get("anom-probe");
    expect(finding).toMatchObject({ kind: "anomaly", service: "anom-probe" });
    expect(h.toasts.filter((t) => t.body.includes("anom-probe"))).toHaveLength(0);
  });

  it("raises one local notification when [watcher.anomaly] notify is on", async () => {
    h = await buildSchedulerHarness({
      toml: ["[watcher.anomaly]", "notify = true"].join("\n"),
      seed: (db) => seedFlatTelemetry(db, "anom-toast"),
    });
    h.out.syncScheduler.register(spike("anom-toast"));
    await h.out.syncScheduler.forceSync("anom-toast");
    await until(() => h?.toasts.some((t) => t.body.includes("anom-toast")) === true);
    expect(h.toasts.filter((t) => t.body.includes("anom-toast"))).toHaveLength(1);
  });

  it("a demo gateway never notifies, whatever the config says (I41)", async () => {
    h = await buildSchedulerHarness({
      demo: true,
      toml: ["[watcher.anomaly]", "notify = true"].join("\n"),
    });
    expect(h.toasts).toHaveLength(0);
  });
});

describe("createSchedulerWithMesh: the watcher chat notice", () => {
  it("warns once at boot when the destination is ambiguous, and builds no notice", async () => {
    const logger = pino({ level: "silent" });
    const warn = spyOn(logger, "warn");
    h = await buildSchedulerHarness({
      logger,
      toml: [
        "[watcher.chatops]",
        "enabled = true",
        'namespace = "team-a"',
        'channel = "C0123456789"',
      ].join("\n"),
    });
    // Namespace AND channel named is a config error: nothing may post, so nothing is built.
    expect(h.out.watcherChat).toBeUndefined();
    expect(h.out.watcherPinnedChannel).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toContain("namespace");
  });
});

describe("createSchedulerWithMesh: the incident engine", () => {
  it("assembles a record after a sync, emitting incident.assembled with its ids only", async () => {
    h = await buildSchedulerHarness();
    writePagerdutyIncident(h.db, { id: "INC1", openedAtMs: Date.now() - 60_000, priority: "P1" });
    await h.out.incidentEngine.trigger("pagerduty");
    const ev = h.events.filter((e) => e.method === "incident.assembled");
    expect(ev).toHaveLength(1);
    expect(Object.keys(ev[0]?.params ?? {}).sort()).toEqual(["recordId", "status", "version"]);
  });

  it("with [incident.scribe] on, queues one metadata draft and says so", async () => {
    h = await buildSchedulerHarness({ toml: ["[incident.scribe]", "enabled = true"].join("\n") });
    writePagerdutyIncident(h.db, { id: "INC2", openedAtMs: Date.now() - 60_000, priority: "P1" });
    await h.out.incidentEngine.trigger("pagerduty");
    await until(() => h?.events.some((e) => e.method === "incident.updateDrafted") === true);
    expect(h.events.filter((e) => e.method === "incident.updateDrafted")).toHaveLength(1);
    const dir = join(h.paths.dataDir, "incident-drafts");
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir).length).toBeGreaterThan(0);
  });

  it("with the scribe off, drafts nothing", async () => {
    h = await buildSchedulerHarness();
    writePagerdutyIncident(h.db, { id: "INC3", openedAtMs: Date.now() - 60_000, priority: "P1" });
    await h.out.incidentEngine.trigger("pagerduty");
    expect(h.events.filter((e) => e.method === "incident.updateDrafted")).toHaveLength(0);
    expect(existsSync(join(h.paths.dataDir, "incident-drafts"))).toBe(false);
  });

  it("a demo gateway builds no scribe even with it on (I41)", async () => {
    h = await buildSchedulerHarness({
      demo: true,
      toml: ["[incident.scribe]", "enabled = true"].join("\n"),
    });
    writePagerdutyIncident(h.db, { id: "INC4", openedAtMs: Date.now() - 60_000, priority: "P1" });
    await h.out.incidentEngine.trigger("pagerduty");
    expect(h.events.filter((e) => e.method === "incident.updateDrafted")).toHaveLength(0);
  });

  it("reads service bindings and config live: a service binding reaches the assembled record", async () => {
    h = await buildSchedulerHarness({
      toml: [
        "[ci.service.checkout]",
        'repos = ["github:acme/checkout"]',
        'pagerduty_services = ["PSVC1"]',
      ].join("\n"),
    });
    writePagerdutyIncident(h.db, { id: "INC5", openedAtMs: Date.now() - 60_000, priority: "P1" });
    await h.out.incidentEngine.trigger("pagerduty");
    const row = h.db.query("SELECT service FROM incident_record LIMIT 1").get() as {
      service: string | null;
    } | null;
    // Without the live config read the record would carry no service at all.
    expect(row?.service).toBe("checkout");
  });
});

describe("createSchedulerWithMesh: ownership with service bindings", () => {
  it("collects the repo URNs of each bound service without failing the pass", async () => {
    h = await buildSchedulerHarness({
      toml: ["[ci.service.checkout]", 'repos = ["github:acme/checkout"]'].join("\n"),
    });
    const warn = spyOn(h.logger, "warn");
    const out = await h.out.ownershipRefresher?.run();
    expect(out).toMatchObject({ rootsTotal: 0 });
    expect(warn.mock.calls.some((c) => String(c[1]).includes("service configs"))).toBe(false);
  });
});
