import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSchedulerHarness,
  type SchedulerHarness,
} from "../../../test/helpers/scheduler-mesh-harness.ts";
import { insertWatcher } from "../../automation/watcher-store.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import type { Syncable } from "../../sync/types.ts";

let h: SchedulerHarness | undefined;
const rootsToRemove: string[] = [];

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  for (const d of rootsToRemove.splice(0)) rmSync(d, { recursive: true, force: true });
});

function probe(serviceId: string, itemsUpserted = 3): Syncable {
  return {
    serviceId,
    defaultIntervalMs: 3_600_000,
    initialSyncDepthDays: 1,
    sync: (_ctx, cursor) =>
      Promise.resolve({ cursor, itemsUpserted, itemsDeleted: 1, hasMore: false, durationMs: 5 }),
  };
}

describe("createSchedulerWithMesh: what gets built", () => {
  it("builds the four refreshers, the push runtime and the incident engine by default", async () => {
    h = await buildSchedulerHarness();
    const o = h.out;
    expect(o.glossaryRefresher.status()).toBe("idle");
    expect(o.decisionsRefresher).toBeDefined();
    expect(o.ownershipRefresher).toBeDefined();
    expect(o.premortemRefresher).toBeDefined();
    expect(typeof o.oncallPush.trigger).toBe("function");
    expect(typeof o.incidentEngine.trigger).toBe("function");
    expect(o.watcherChat).toBeUndefined();
    expect(o.watcherPinnedChannel).toBeUndefined();
  });

  it("leaves a pass unset when its config section disables it, and disables the glossary in place", async () => {
    h = await buildSchedulerHarness({
      toml: [
        "[glossary]",
        "enabled = false",
        "[decisions]",
        "enabled = false",
        "[ownership]",
        "enabled = false",
        "[premortem]",
        "enabled = false",
      ].join("\n"),
    });
    expect(h.out.decisionsRefresher).toBeUndefined();
    expect(h.out.ownershipRefresher).toBeUndefined();
    expect(h.out.premortemRefresher).toBeUndefined();
    // The glossary is always constructed and gates internally, so it reports `disabled`.
    expect(h.out.glossaryRefresher.status()).toBe("disabled");
  });

  it("builds the watcher notice and surfaces an owner-pinned channel when [watcher.chatops] names one", async () => {
    h = await buildSchedulerHarness({
      toml: ["[watcher.chatops]", "enabled = true", 'channel = "C0123456789"'].join("\n"),
    });
    expect(h.out.watcherChat).toBeDefined();
    expect(h.out.watcherPinnedChannel).toBe("C0123456789");
  });

  it("builds a notice but no pinned channel when the destination is a namespace", async () => {
    h = await buildSchedulerHarness({
      toml: ["[watcher.chatops]", "enabled = true", 'namespace = "team-a"'].join("\n"),
    });
    expect(h.out.watcherChat).toBeDefined();
    expect(h.out.watcherPinnedChannel).toBeUndefined();
  });

  it("a demo gateway has no watcher notice even when the config opts in (I41)", async () => {
    h = await buildSchedulerHarness({
      demo: true,
      toml: ["[watcher.chatops]", "enabled = true", 'channel = "C0123456789"'].join("\n"),
    });
    expect(h.out.watcherChat).toBeUndefined();
    expect(h.out.watcherPinnedChannel).toBeUndefined();
  });

  it("accepts the optional spawn gate, user-MCP confinement and the extension runtime", async () => {
    h = await buildSchedulerHarness({
      withSpawnGate: true,
      withUserMcpCanConfine: true,
      extensionRuntimeEnabled: true,
    });
    expect(h.out.connectorMesh).toBeDefined();
    expect(h.out.syncScheduler).toBeDefined();
  });
});

describe("createSchedulerWithMesh: registration and the I22 connector allowlist", () => {
  it("the filtered registrar registers an allowed connector and drops a blocked one", async () => {
    h = await buildSchedulerHarness({ isConnectorAllowed: (id) => id !== "blocked-probe" });
    h.out.policyFilteredRegistrar.register(probe("allowed-probe"));
    h.out.policyFilteredRegistrar.register(probe("blocked-probe"));
    expect(h.out.syncScheduler.syncableFor("allowed-probe")).toBeDefined();
    expect(h.out.syncScheduler.syncableFor("blocked-probe")).toBeUndefined();
  });

  it("registers the cloud connectors with the scheduler on a normal gateway", async () => {
    h = await buildSchedulerHarness();
    expect(h.out.syncScheduler.syncableFor("github")).toBeDefined();
  });

  it("never registers a blocked connector's syncable at boot", async () => {
    h = await buildSchedulerHarness({ isConnectorAllowed: (id) => id !== "github" });
    expect(h.out.syncScheduler.syncableFor("github")).toBeUndefined();
    expect(h.out.syncScheduler.syncableFor("slack")).toBeDefined();
  });

  it("registers the filesystem-root syncables only for a non-demo gateway with roots", async () => {
    const roots = (root: string): string =>
      ["[[filesystem.roots]]", `path = ${JSON.stringify(root)}`].join("\n");
    const dir = mkdtempSync(join(tmpdir(), "nimbus-sched-root-"));
    rootsToRemove.push(dir);
    h = await buildSchedulerHarness({ toml: roots(dir) });
    expect(h.localIndex.persistedConnectorStatuses("filesystem")).toHaveLength(1);
    await h.cleanup();
    h = await buildSchedulerHarness({ demo: true, toml: roots(dir) });
    expect(h.localIndex.persistedConnectorStatuses("filesystem")).toHaveLength(0);
  });

  it("a demo gateway registers no connector and never starts the scheduler (I41)", async () => {
    h = await buildSchedulerHarness({ demo: true });
    expect(h.out.syncScheduler.syncableFor("github")).toBeUndefined();
    expect(h.localIndex.persistedConnectorStatuses("github")).toHaveLength(0);
  });
});

describe("createSchedulerWithMesh: the post-sync hook", () => {
  it("a completed sync emits sync.completed with the run's counts", async () => {
    h = await buildSchedulerHarness();
    h.out.syncScheduler.register(probe("hook-probe", 7));
    await h.out.syncScheduler.forceSync("hook-probe");
    const done = h.events.filter(
      (e) => e.method === "sync.completed" && e.params["serviceId"] === "hook-probe",
    );
    expect(done).toHaveLength(1);
    expect(done[0]?.params).toMatchObject({
      serviceId: "hook-probe",
      itemsUpserted: 7,
      itemsDeleted: 1,
      hasMore: false,
    });
  });

  it("a completed sync ledgers one sync row before the connector runs (I29)", async () => {
    h = await buildSchedulerHarness();
    h.out.syncScheduler.register(probe("ledger-probe"));
    await h.out.syncScheduler.forceSync("ledger-probe");
    const rows = h.db
      .query(
        "SELECT method, result_status FROM egress_ledger WHERE source_type = 'sync' AND destination = ?",
      )
      .all("ledger-probe");
    expect(rows).toEqual([{ method: "sync.run", result_status: "authorized" }]);
  });

  it("a completed sync evaluates watchers: a matching alert toasts and emits watcher.fired", async () => {
    h = await buildSchedulerHarness();
    const t0 = Date.now() - 60_000;
    insertWatcher(h.db, {
      name: "probe-alerts",
      enabled: 1,
      condition_type: "alert_fired",
      condition_json: JSON.stringify({ filter: { service: "watch-probe" } }),
      action_type: "notify",
      action_json: "{}",
      created_at: t0,
    });
    upsertIndexedItem(h.db, {
      service: "watch-probe",
      type: "alert",
      externalId: "a1",
      title: "Disk full",
      // In the future so a concurrent boot-time sync of another connector, which stamps every
      // watcher as checked, cannot move this watcher past the item before the probe syncs.
      modifiedAt: Date.now() + 60_000,
      syncedAt: Date.now() + 60_000,
    });
    h.out.syncScheduler.register(probe("watch-probe"));
    await h.out.syncScheduler.forceSync("watch-probe");
    expect(h.toasts.some((t) => t.body.includes("Disk full"))).toBe(true);
    const fired = h.events.filter(
      (e) => e.method === "watcher.fired" && e.params["watcherId"] !== undefined,
    );
    expect(fired).toHaveLength(1);
  });

  it("a sync failure does not emit sync.completed", async () => {
    h = await buildSchedulerHarness();
    h.out.syncScheduler.register({
      ...probe("fail-probe"),
      sync: () => Promise.reject(new Error("boom")),
    });
    await h.out.syncScheduler.forceSync("fail-probe").catch(() => undefined);
    expect(
      h.events.filter(
        (e) => e.method === "sync.completed" && e.params["serviceId"] === "fail-probe",
      ),
    ).toHaveLength(0);
  });
});

describe("createSchedulerWithMesh: the startup watcher catch-up", () => {
  it("fires a watcher whose alert arrived while the gateway was down", async () => {
    const t0 = Date.now() - 120_000;
    h = await buildSchedulerHarness({
      seed: (db) => {
        insertWatcher(db, {
          name: "missed",
          enabled: 1,
          condition_type: "alert_fired",
          condition_json: JSON.stringify({ filter: { service: "pagerduty" } }),
          action_type: "notify",
          action_json: "{}",
          created_at: t0,
        });
        upsertIndexedItem(db, {
          service: "pagerduty",
          type: "alert",
          externalId: "a-miss",
          title: "Missed page",
          modifiedAt: t0 + 5_000,
          syncedAt: t0 + 5_000,
        });
      },
    });
    expect(h.toasts.some((t) => t.body.includes("Missed page"))).toBe(true);
  });
});
