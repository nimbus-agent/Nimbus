import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { GdprPurgeStore } from "./gdpr-purge-store.ts";

describe("GdprPurgeStore", () => {
  let db: Database;
  let store: GdprPurgeStore;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 37);
    store = new GdprPurgeStore(db);
  });

  test("opens a job with one pending request per peer", () => {
    store.openJob({ jobId: "j1", externalId: "alice", peers: ["peer:aa", "peer:bb"], openedAt: 1 });
    expect(
      store
        .pendingRequests("j1")
        .map((r) => r.peerId)
        .sort(),
    ).toEqual(["peer:aa", "peer:bb"]);
  });

  test("marking a request done removes it from pending; job closes when all done", () => {
    store.openJob({ jobId: "j1", externalId: "alice", peers: ["peer:aa"], openedAt: 1 });
    store.markDone("j1", "peer:aa", "SIGREC", 2);
    expect(store.pendingRequests("j1")).toHaveLength(0);
    expect(store.allDone("j1")).toBe(true);
  });

  test("incrementAttempt bumps the counter for retry backoff", () => {
    store.openJob({ jobId: "j1", externalId: "alice", peers: ["peer:aa"], openedAt: 1 });
    store.incrementAttempt("j1", "peer:aa", 5);
    expect(store.pendingRequests("j1")[0]?.attempts).toBe(1);
  });

  test("openJobIds lists jobs with pending requests; closeJob records completion sig", () => {
    store.openJob({ jobId: "j1", externalId: "alice", peers: ["peer:aa"], openedAt: 1 });
    expect(store.openJobIds()).toEqual(["j1"]);
    store.markDone("j1", "peer:aa", "REC", 2);
    store.closeJob("j1", "AGGSIG", 3);
    expect(store.openJobIds()).toEqual([]); // no pending requests remain
  });
});
