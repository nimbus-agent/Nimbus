import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { retryPendingPurges } from "./gdpr-purge-retry.ts";
import {
  buildGdprPurgeRetryDeps,
  GDPR_PURGE_RETRY_INTERVAL_MS,
  type GdprPurgeRetryHandle,
  startGdprPurgeRetry,
} from "./gdpr-purge-retry-sidecar.ts";
import { GdprPurgeStore } from "./gdpr-purge-store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 37);
  return db;
}

function anchorPrivkeyB64(): string {
  return encodeBase64(generateEd25519Keypair().privkey);
}

function auditRows(db: Database, actionType: string): Array<{ action_json: string }> {
  return db
    .query("SELECT action_json FROM audit_log WHERE action_type = ?")
    .all(actionType) as Array<{ action_json: string }>;
}

describe("gdpr-purge-retry-sidecar", () => {
  let db: Database;
  const handles: GdprPurgeRetryHandle[] = [];

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    // Stop every started sidecar so no setInterval leaks past the test run.
    for (const h of handles.splice(0)) {
      h.stop();
    }
    db.close();
  });

  it("exposes the default interval constant", () => {
    expect(GDPR_PURGE_RETRY_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  describe("buildGdprPurgeRetryDeps", () => {
    it("returns the deps shape (store, requestPurge, signCompletion, nowMs)", () => {
      const deps = buildGdprPurgeRetryDeps(db, { anchorPrivkeyB64: anchorPrivkeyB64() });
      expect(deps.store).toBeInstanceOf(GdprPurgeStore);
      expect(typeof deps.requestPurge).toBe("function");
      expect(typeof deps.signCompletion).toBe("function");
      expect(typeof deps.nowMs).toBe("function");
    });

    it("defaults requestPurge to an always-null no-op", async () => {
      const deps = buildGdprPurgeRetryDeps(db, { anchorPrivkeyB64: anchorPrivkeyB64() });
      await expect(deps.requestPurge("peer-x")).resolves.toBeNull();
    });

    it("uses the injected clock for nowMs", () => {
      const deps = buildGdprPurgeRetryDeps(db, {
        anchorPrivkeyB64: anchorPrivkeyB64(),
        nowMs: () => 1234,
      });
      expect(deps.nowMs()).toBe(1234);
    });

    it("signCompletion produces a non-empty signature and appends a team.purge.completed audit entry", () => {
      const deps = buildGdprPurgeRetryDeps(db, {
        anchorPrivkeyB64: anchorPrivkeyB64(),
        nowMs: () => 9000,
      });
      const sig = deps.signCompletion("job-sign");
      expect(typeof sig).toBe("string");
      expect(sig.length).toBeGreaterThan(0);

      const rows = auditRows(db, "team.purge.completed");
      expect(rows).toHaveLength(1);
      const parsed = JSON.parse(rows[0]?.action_json ?? "{}") as {
        job_id: string;
        completion_sig: string;
      };
      expect(parsed.job_id).toBe("job-sign");
      expect(parsed.completion_sig).toBe(sig);
    });
  });

  describe("one retry tick via injected deps", () => {
    it("marks a reachable peer done, leaves an offline peer pending, and does not close a still-pending job", async () => {
      const store = new GdprPurgeStore(db);
      store.openJob({
        jobId: "job-1",
        externalId: "ext-1",
        peers: ["peer-online", "peer-offline"],
        openedAt: 1,
      });

      const deps = buildGdprPurgeRetryDeps(db, {
        anchorPrivkeyB64: anchorPrivkeyB64(),
        nowMs: () => 100,
        requestPurge: (peerId: string) =>
          Promise.resolve(peerId === "peer-online" ? "signed-record" : null),
      });

      await retryPendingPurges(deps);

      const pending = store.pendingRequests("job-1");
      expect(pending.map((r) => r.peerId)).toEqual(["peer-offline"]);
      // Job still open (one peer pending) => no completion audit entry yet.
      expect(auditRows(db, "team.purge.completed")).toHaveLength(0);
      expect(store.openJobIds()).toContain("job-1");
    });

    it("closes a job once all peers are done and appends the completion audit entry", async () => {
      const store = new GdprPurgeStore(db);
      store.openJob({
        jobId: "job-2",
        externalId: "ext-2",
        peers: ["peer-a", "peer-b"],
        openedAt: 1,
      });

      const deps = buildGdprPurgeRetryDeps(db, {
        anchorPrivkeyB64: anchorPrivkeyB64(),
        nowMs: () => 200,
        requestPurge: () => Promise.resolve("record"),
      });

      await retryPendingPurges(deps);

      expect(store.allDone("job-2")).toBe(true);
      expect(store.openJobIds()).not.toContain("job-2");
      const rows = auditRows(db, "team.purge.completed");
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]?.action_json ?? "{}").job_id).toBe("job-2");
    });

    it("keeps a request pending when requestPurge throws (failure isolation)", async () => {
      const store = new GdprPurgeStore(db);
      store.openJob({ jobId: "job-3", externalId: "ext-3", peers: ["peer-err"], openedAt: 1 });

      const deps = buildGdprPurgeRetryDeps(db, {
        anchorPrivkeyB64: anchorPrivkeyB64(),
        nowMs: () => 300,
        requestPurge: () => Promise.reject(new Error("unreachable")),
      });

      await retryPendingPurges(deps);

      expect(store.pendingRequests("job-3").map((r) => r.peerId)).toEqual(["peer-err"]);
      expect(auditRows(db, "team.purge.completed")).toHaveLength(0);
    });
  });

  describe("startGdprPurgeRetry", () => {
    it("runs an immediate tick, returns a stop handle, and stops cleanly", async () => {
      const store = new GdprPurgeStore(db);
      store.openJob({ jobId: "job-now", externalId: "ext-now", peers: ["peer-1"], openedAt: 1 });

      const handle = startGdprPurgeRetry(db, {
        anchorPrivkeyB64: anchorPrivkeyB64(),
        // Large interval so only the synchronous immediate tick runs during the test.
        intervalMs: 60_000,
        nowMs: () => 500,
        requestPurge: () => Promise.resolve("record"),
      });
      handles.push(handle);

      // The immediate tick is async; let its microtasks/IO settle.
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      expect(store.openJobIds()).not.toContain("job-now");
      expect(auditRows(db, "team.purge.completed")).toHaveLength(1);

      // Stop is idempotent and never throws.
      expect(() => {
        handle.stop();
      }).not.toThrow();
    });

    it("returns a stop handle even with default options (no requestPurge)", () => {
      const handle = startGdprPurgeRetry(db, {
        anchorPrivkeyB64: anchorPrivkeyB64(),
        intervalMs: 60_000,
      });
      handles.push(handle);
      expect(typeof handle.stop).toBe("function");
      handle.stop();
    });
  });
});
