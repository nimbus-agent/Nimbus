import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { type RetryDeps, retryPendingPurges } from "./gdpr-purge-retry.ts";
import { GdprPurgeStore } from "./gdpr-purge-store.ts";

describe("retryPendingPurges", () => {
  test("offline peer stays pending; a returning peer completes and closes the job", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 37);
    const store = new GdprPurgeStore(db);
    store.openJob({
      jobId: "j1",
      externalId: "alice",
      peers: ["peer:on", "peer:off"],
      openedAt: 1,
    });

    const deps: RetryDeps = {
      store,
      requestPurge: async (peerId) => (peerId === "peer:on" ? "SIGREC" : null),
      signCompletion: () => "AGGSIG",
      nowMs: () => 10,
    };
    await retryPendingPurges(deps); // round 1: on done, off pending
    expect(store.pendingRequests("j1").map((p) => p.peerId)).toEqual(["peer:off"]);
    expect(store.allDone("j1")).toBe(false);

    await retryPendingPurges({ ...deps, requestPurge: async () => "SIGREC2" }); // off returns
    expect(store.allDone("j1")).toBe(true);
  });

  test("attempts increment on each tick for a still-offline peer", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 37);
    const store = new GdprPurgeStore(db);
    store.openJob({ jobId: "j2", externalId: "bob", peers: ["peer:off"], openedAt: 1 });
    const deps: RetryDeps = {
      store,
      requestPurge: async () => null,
      signCompletion: () => "S",
      nowMs: () => 1,
    };
    await retryPendingPurges(deps);
    await retryPendingPurges(deps);
    expect(store.pendingRequests("j2")[0]?.attempts).toBe(2);
  });
});
