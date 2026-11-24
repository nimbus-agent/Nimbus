import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { LocalIndex } from "../../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { generateBoxKeypair } from "../lan-crypto.ts";
import type { ServerCtx } from "./context.ts";
import { tryDispatchLanRpc } from "./dispatchers.ts";

function ctxWith(options: Record<string, unknown>): ServerCtx {
  return { options } as unknown as ServerCtx;
}

test("lan.getStatus lists each peer's protocol and counts the v1 peers (FS2)", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, LocalIndex.SCHEMA_VERSION);
  const index = new LocalIndex(db);
  const a = generateBoxKeypair().publicKey;
  const b = generateBoxKeypair().publicKey;
  index.addLanPeer({ peerId: "peer:aaaa", peerPubkey: a, direction: "inbound", protoVersion: 2 });
  index.addLanPeer({ peerId: "peer:bbbb", peerPubkey: b, direction: "outbound" });
  const out = (await tryDispatchLanRpc(ctxWith({ localIndex: index }), "lan.getStatus", {})) as {
    peers: Array<{ peerId: string; direction: string; protoVersion: number }>;
    peersByProtocol: { v1: number; v2: number };
  };
  expect(out.peersByProtocol).toEqual({ v1: 1, v2: 1 });
  expect(out.peers).toEqual([
    { peerId: "peer:aaaa", direction: "inbound", protoVersion: 2 },
    { peerId: "peer:bbbb", direction: "outbound", protoVersion: 1 },
  ]);
  // never a key
  expect(JSON.stringify(out)).not.toContain(Buffer.from(a).toString("base64"));
  index.close();
});

test("lan.getStatus without an index reports no peers and no floor (FS3)", async () => {
  const out = (await tryDispatchLanRpc(ctxWith({}), "lan.getStatus", {})) as Record<
    string,
    unknown
  >;
  expect(out["peers"]).toEqual([]);
  expect(out["peersByProtocol"]).toEqual({ v1: 0, v2: 0 });
  expect("minProtocol" in out).toBe(false);
});
