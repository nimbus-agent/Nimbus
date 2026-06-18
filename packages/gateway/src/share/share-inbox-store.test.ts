// packages/gateway/src/share/share-inbox-store.test.ts

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SHARE_INBOX_V43_SQL } from "../index/share-inbox-v43-sql.ts";
import type { ShareFile } from "./share-format.ts";
import {
  drainPending,
  insertPendingForward,
  insertReceivedShare,
  listReceivedShares,
  markDelivered,
} from "./share-inbox-store.ts";

function db(): Database {
  const d = new Database(":memory:");
  d.exec(SHARE_INBOX_V43_SQL);
  return d;
}

function share(hash: string, originLabel: string, hops: number): ShareFile {
  return {
    format: "nimbus-share/v1",
    contentHash: hash,
    body: {
      kind: "recipe",
      sessionId: "s1",
      createdAt: 1,
      expiresAt: null,
      redactionSet: [],
      origin: { label: originLabel, pubkey: "ORIGIN" },
    },
    sig: { alg: "ed25519", pubkey: "ORIGIN", signature: "S" },
    forwarding: { hops, chain: [] },
  };
}

describe("share-inbox-store", () => {
  test("received share round-trips with attribution; idempotent", () => {
    const d = db();
    insertReceivedShare(d, { share: share("h1", "alice", 2), now: 100 });
    insertReceivedShare(d, { share: share("h1", "alice", 2), now: 100 }); // dedup
    const rows = listReceivedShares(d, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.originLabel).toBe("alice");
    expect(rows[0]?.hops).toBe(2);
    expect(rows[0]?.share.contentHash).toBe("h1");
    expect(rows[0]?.direction).toBe("received");
  });

  test("pending forwards are keyed by recipient + drained per recipient", () => {
    const d = db();
    insertPendingForward(d, { recipientPubkey: "BOB", share: share("h1", "alice", 1), now: 10 });
    insertPendingForward(d, { recipientPubkey: "BOB", share: share("h2", "alice", 1), now: 11 });
    insertPendingForward(d, { recipientPubkey: "CAROL", share: share("h3", "alice", 1), now: 12 });
    const bob = drainPending(d, "BOB");
    expect(bob.map((r) => r.contentHash).sort()).toEqual(["h1", "h2"]);
    expect(drainPending(d, "CAROL").map((r) => r.contentHash)).toEqual(["h3"]);
    markDelivered(d, bob[0]!.id);
    // delivered rows are not re-drained
    expect(drainPending(d, "BOB").map((r) => r.contentHash)).toEqual(["h2"]);
  });
});
