import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { type PurgeDeps, startPurge } from "./gdpr-purge.ts";
import { GdprPurgeStore } from "./gdpr-purge-store.ts";

describe("startPurge", () => {
  test("revokes grants, deletes local contributions, opens a durable job with one request per peer", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 37);
    const revoked: string[] = [];
    const deps: PurgeDeps = {
      store: new GdprPurgeStore(db),
      resolvePeer: () => "peer:alice",
      revokeAllGrants: (pid) => {
        revoked.push(pid);
      },
      deleteLocalContributions: () => 3,
      knownPeers: () => ["peer:aa", "peer:bb"],
      newJobId: () => "job-1",
      nowMs: () => 1000,
    };
    const r = await startPurge(deps, "alice");
    expect(r.jobId).toBe("job-1");
    expect(revoked).toEqual(["peer:alice"]);
    expect(r.localDeleted).toBe(3);
    expect(
      deps.store
        .pendingRequests("job-1")
        .map((p) => p.peerId)
        .sort(),
    ).toEqual(["peer:aa", "peer:bb"]);
  });

  test("throws for an unknown user (resolvePeer undefined)", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 37);
    const deps: PurgeDeps = {
      store: new GdprPurgeStore(db),
      resolvePeer: () => undefined,
      revokeAllGrants: () => {},
      deleteLocalContributions: () => 0,
      knownPeers: () => [],
      newJobId: () => "j",
      nowMs: () => 1,
    };
    await expect(startPurge(deps, "ghost")).rejects.toThrow();
  });
});
