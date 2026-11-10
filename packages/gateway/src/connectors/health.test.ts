import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { setGatewayEventBroadcast } from "../ipc/gateway-events.ts";
import { createMemoryIndexDb } from "./connector-sync-test-helpers.ts";
import {
  deleteConnectorHealthRow,
  getAllConnectorHealth,
  getConnectorHealth,
  getConnectorHealthHistory,
  pruneConnectorHealthHistory,
  transitionHealth,
} from "./health.ts";

afterEach(() => setGatewayEventBroadcast(undefined));

function fresh(): Database {
  return createMemoryIndexDb();
}

describe("transitionHealth: remaining event shapes", () => {
  test("a pause with a reason lands in lastError (truncated), one without clears it", () => {
    const db = fresh();
    const long = "x".repeat(600);
    const withReason = transitionHealth(db, "ext_a", { type: "paused", reason: long });
    expect(withReason.state).toBe("paused");
    expect(withReason.lastError).toHaveLength(512);
    expect(withReason.lastError?.endsWith("...")).toBe(true);
    const bare = transitionHealth(db, "ext_a", { type: "paused" });
    expect(bare.lastError).toBeUndefined();
    const hist = getConnectorHealthHistory(db, "ext_a");
    expect(hist[0]?.reason).toBe("connector paused");
    expect(hist[1]?.reason?.startsWith("connector paused: ")).toBe(true);
    expect(hist[1]?.reason).toHaveLength(512);
  });

  test("a transient error backs off, then reaching max attempts is an error; success resets", () => {
    const db = fresh();
    const first = transitionHealth(db, "svc", { type: "transient_error", error: "e", attempt: 1 });
    expect(first.state).toBe("degraded");
    expect(first.backoffAttempt).toBe(1);
    expect(first.backoffUntil).toBeInstanceOf(Date);
    const last = transitionHealth(
      db,
      "svc",
      { type: "transient_error", error: "e", attempt: 2 },
      2,
    );
    expect(last.state).toBe("error");
    const ok = transitionHealth(db, "svc", { type: "sync_success" });
    expect(ok.state).toBe("healthy");
    expect(ok.backoffAttempt).toBe(0);
    expect(ok.backoffUntil).toBeUndefined();
    expect(ok.lastError).toBeUndefined();
  });

  test("a huge attempt number caps the backoff instead of overflowing", () => {
    const db = fresh();
    const before = Date.now();
    const snap = transitionHealth(db, "svc", {
      type: "transient_error",
      error: "e",
      attempt: 500,
    });
    const until = snap.backoffUntil?.getTime() ?? 0;
    expect(until).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(until).toBeLessThan(Date.now() + 3_600_000 + 1_000);
  });

  test("rate limiting records retryAfter; unauthenticated records the 401 text", () => {
    const db = fresh();
    const at = new Date("2030-01-02T03:04:05.000Z");
    const rl = transitionHealth(db, "svc", { type: "rate_limited", retryAfter: at });
    expect(rl.state).toBe("rate_limited");
    expect(rl.retryAfter?.toISOString()).toBe(at.toISOString());
    const un = transitionHealth(db, "svc", { type: "unauthenticated" });
    expect(un.state).toBe("unauthenticated");
    expect(un.lastError).toContain("401/403");
    const re = transitionHealth(db, "svc", { type: "reauthenticated" });
    expect(re.state).toBe("healthy");
    expect(re.lastError).toBeUndefined();
    expect(getConnectorHealthHistory(db, "svc")[0]?.reason).toBe("credential re-verified");
  });

  test("persistent error truncates; resumed clears", () => {
    const db = fresh();
    const err = transitionHealth(db, "svc", { type: "persistent_error", error: "y".repeat(700) });
    expect(err.state).toBe("error");
    expect(err.lastError).toHaveLength(512);
    const resumed = transitionHealth(db, "svc", { type: "resumed" });
    expect(resumed.state).toBe("healthy");
    expect(resumed.lastError).toBeUndefined();
  });

  test("skipped_offline records history only, on a row or on none", () => {
    const db = fresh();
    const seen: unknown[] = [];
    setGatewayEventBroadcast((m) => seen.push(m));
    expect(transitionHealth(db, "svc", { type: "skipped_offline" }).state).toBe("not_configured");
    transitionHealth(db, "svc", { type: "sync_success" });
    seen.length = 0;
    expect(transitionHealth(db, "svc", { type: "skipped_offline" }).state).toBe("healthy");
    expect(seen).toEqual([]);
    const reasons = getConnectorHealthHistory(db, "svc").map((h) => h.reason);
    expect(reasons.filter((r) => r === "skipped (offline)")).toHaveLength(2);
    expect(getConnectorHealthHistory(db, "svc")[1]?.fromState).toBeNull();
  });
});

describe("health reads and housekeeping", () => {
  test("getConnectorHealth of a connector never observed is not_configured", () => {
    expect(getConnectorHealth(fresh(), "nobody")).toEqual({
      connectorId: "nobody",
      state: "not_configured",
      backoffAttempt: 0,
    });
  });

  test("getAllConnectorHealth lists every row, with last sync time when recorded", () => {
    const db = fresh();
    transitionHealth(db, "a", { type: "sync_success" });
    transitionHealth(db, "b", { type: "persistent_error", error: "boom" });
    db.query("UPDATE sync_state SET last_sync_at = ? WHERE connector_id = 'a'").run(
      1_700_000_000_000,
    );
    const all = Object.fromEntries(getAllConnectorHealth(db).map((s) => [s.connectorId, s]));
    expect(all["a"]?.state).toBe("healthy");
    expect(all["a"]?.lastSuccessfulSync?.getTime()).toBe(1_700_000_000_000);
    expect(all["b"]?.state).toBe("error");
    expect(all["b"]?.lastError).toBe("boom");
  });

  test("history is newest first and honours the limit", () => {
    const db = fresh();
    transitionHealth(db, "svc", { type: "sync_success" });
    transitionHealth(db, "svc", { type: "persistent_error", error: "e" });
    transitionHealth(db, "svc", { type: "resumed" });
    const two = getConnectorHealthHistory(db, "svc", 2);
    expect(two).toHaveLength(2);
    expect(two[0]?.toState).toBe("healthy");
    expect(two[0]?.fromState).toBe("error");
    expect(two[1]?.toState).toBe("error");
  });

  test("pruning deletes only history older than the cutoff", () => {
    const db = fresh();
    transitionHealth(db, "svc", { type: "sync_success" });
    transitionHealth(db, "svc", { type: "resumed" });
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    db.query(
      "UPDATE connector_health_history SET occurred_at = ? WHERE id = (SELECT MIN(id) FROM connector_health_history)",
    ).run(old);
    expect(pruneConnectorHealthHistory(db, 30)).toBe(1);
    expect(getConnectorHealthHistory(db, "svc")).toHaveLength(1);
    expect(pruneConnectorHealthHistory(db, 30)).toBe(0);
  });

  test("deleting the health row leaves history and resets the state", () => {
    const db = fresh();
    transitionHealth(db, "svc", { type: "sync_success" });
    deleteConnectorHealthRow(db, "svc");
    expect(getConnectorHealth(db, "svc").state).toBe("not_configured");
    expect(getConnectorHealthHistory(db, "svc")).toHaveLength(1);
  });
});
