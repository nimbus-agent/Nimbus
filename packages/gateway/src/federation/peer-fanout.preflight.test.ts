import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { fanOutPreflight, type PeerFanoutDeps } from "./peer-fanout.ts";

const SELF: BoxKeypair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };

function deps(send: NonNullable<PeerFanoutDeps["sendOverWire"]>): PeerFanoutDeps {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const index = new LocalIndex(db);
  index.addLanPeer({
    peerId: "peer:aa",
    peerPubkey: new Uint8Array(32).fill(1),
    direction: "outbound",
    hostIp: "127.0.0.1",
    hostPort: 7401,
    displayName: "Alice",
  });
  return { index, selfIdentity: SELF, store: new KnownNamespaceStore(db), sendOverWire: send };
}

const req = { namespace: "n", ref: "HEAD", changedSurface: [], purpose: "x" };

describe("fanOutPreflight", () => {
  it("maps ok → pass/fail", async () => {
    const pass = await fanOutPreflight(
      deps(async () => ({ kind: "ok", passed: true, summary: "42 passed" })),
      req,
    );
    expect(pass.perPeer[0]).toEqual({
      peerId: "peer:aa",
      displayName: "Alice",
      status: "pass",
      summary: "42 passed",
    });
    const fail = await fanOutPreflight(
      deps(async () => ({ kind: "ok", passed: false, summary: "3 failed" })),
      req,
    );
    expect(fail.perPeer[0]?.status).toBe("fail");
  });

  it("maps error envelopes → declined / not_configured", async () => {
    const declined = await fanOutPreflight(
      deps(async () => ({ kind: "error", error: "denied" })),
      req,
    );
    expect(declined.perPeer[0]?.status).toBe("declined");
    const notcfg = await fanOutPreflight(
      deps(async () => ({ kind: "error", error: "not_configured" })),
      req,
    );
    expect(notcfg.perPeer[0]?.status).toBe("not_configured");
  });

  it("transport error → gap (never 'pass')", async () => {
    const out = await fanOutPreflight(
      deps(async () => {
        throw new Error("down");
      }),
      req,
    );
    expect(out.perPeer).toEqual([]);
    expect(out.gaps).toHaveLength(1);
  });
});
