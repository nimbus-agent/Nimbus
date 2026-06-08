import { describe, expect, it } from "bun:test";
import type { LanPeerRow, LocalIndex } from "../index/local-index.ts";
import type { sendFederatedOverWire as SendFederatedOverWireType } from "../ipc/lan-client.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { buildDelegatedRequestRemote } from "./delegated-request-remote.ts";
import type { DelegationStore } from "./delegation-store.ts";

// ---------------------------------------------------------------------------
// Minimal fakes — no real DB or network needed.
// ---------------------------------------------------------------------------

function fakeStore(delegate: string | undefined): Pick<DelegationStore, "activeDelegateePeer"> {
  return {
    activeDelegateePeer: (_at: string, _svc: string, _now: number) => delegate,
  } as Pick<DelegationStore, "activeDelegateePeer">;
}

function fakeIndex(peers: Partial<LanPeerRow>[]): Pick<LocalIndex, "listLanPeers"> {
  return {
    listLanPeers: () => peers as LanPeerRow[],
  } as Pick<LocalIndex, "listLanPeers">;
}

const selfIdentity: BoxKeypair = {
  publicKey: new Uint8Array(32),
  secretKey: new Uint8Array(32),
};

/** A peer row with a valid LAN address, used by the wire-path tests. */
const reachablePeer: Partial<LanPeerRow> = {
  peer_id: "peer:bob",
  peer_pubkey: new Uint8Array(32),
  direction: "inbound",
  host_ip: "192.168.1.5",
  host_port: 4242,
  display_name: null,
  write_allowed: 0,
  paired_at: "2026-01-01T00:00:00.000Z",
  last_seen_at: null,
};

/** Build a type-safe sendOverWire fake that resolves to the given value. */
function fakeSend(response: unknown): typeof SendFederatedOverWireType {
  return async (
    _host: string,
    _port: number,
    _selfKp: BoxKeypair,
    _peerPubkey: Uint8Array,
    _method: string,
    _params: unknown,
  ) => response;
}

/** Build a type-safe sendOverWire fake that throws. */
function fakeSendThrows(message: string): typeof SendFederatedOverWireType {
  return async (
    _host: string,
    _port: number,
    _selfKp: BoxKeypair,
    _peerPubkey: Uint8Array,
    _method: string,
    _params: unknown,
  ) => {
    throw new Error(message);
  };
}

// ---------------------------------------------------------------------------
// Line 27, block 1, branch 1 — defensive/unreachable — see true-coverage spec §5
// `actionType.split(".")[0]` always returns a non-undefined string; the `?? ""`
// null-coalescing arm can never fire at runtime.
// ---------------------------------------------------------------------------

describe("buildDelegatedRequestRemote (I20)", () => {
  it("returns timeout when no active delegate exists", async () => {
    const fn = buildDelegatedRequestRemote({
      store: fakeStore(undefined) as DelegationStore,
      index: fakeIndex([]) as unknown as LocalIndex,
      selfIdentity,
      now: () => 1000,
    });
    const result = await fn("email.send");
    expect(result).toEqual({ kind: "timeout" });
  });

  // Line 31, block 3, branch 0 — row found but host_ip is null.
  it("returns timeout when the peer row has a null host_ip (no LAN address yet)", async () => {
    const fn = buildDelegatedRequestRemote({
      store: fakeStore("peer:bob") as DelegationStore,
      index: fakeIndex([
        {
          peer_id: "peer:bob",
          peer_pubkey: new Uint8Array(32),
          direction: "inbound",
          host_ip: null,
          host_port: 4242,
          display_name: null,
          write_allowed: 0,
          paired_at: "2026-01-01T00:00:00.000Z",
          last_seen_at: null,
        },
      ]) as unknown as LocalIndex,
      selfIdentity,
      now: () => 1000,
    });
    const result = await fn("email.send");
    expect(result).toEqual({ kind: "timeout" });
  });

  // Line 31, block 3, branch 0 — also covers the host_port === null arm.
  it("returns timeout when the peer row has a null host_port", async () => {
    const fn = buildDelegatedRequestRemote({
      store: fakeStore("peer:bob") as DelegationStore,
      index: fakeIndex([
        {
          peer_id: "peer:bob",
          peer_pubkey: new Uint8Array(32),
          direction: "inbound",
          host_ip: "192.168.1.5",
          host_port: null,
          display_name: null,
          write_allowed: 0,
          paired_at: "2026-01-01T00:00:00.000Z",
          last_seen_at: null,
        },
      ]) as unknown as LocalIndex,
      selfIdentity,
      now: () => 1000,
    });
    const result = await fn("email.send");
    expect(result).toEqual({ kind: "timeout" });
  });

  // Line 44, block 5, branch 1 — wire returns a non-boolean approved value.
  it("returns timeout when the wire response has a non-boolean approved field", async () => {
    const fn = buildDelegatedRequestRemote({
      store: fakeStore("peer:bob") as DelegationStore,
      index: fakeIndex([reachablePeer]) as unknown as LocalIndex,
      selfIdentity,
      now: () => 1000,
      sendOverWire: fakeSend({ approved: "yes" }),
    });
    const result = await fn("email.send");
    expect(result).toEqual({ kind: "timeout" });
  });

  // Line 44, block 5, branch 0 — wire returns a proper boolean approval (happy path).
  it("returns answered with approved=true when the wire confirms approval", async () => {
    const fn = buildDelegatedRequestRemote({
      store: fakeStore("peer:bob") as DelegationStore,
      index: fakeIndex([reachablePeer]) as unknown as LocalIndex,
      selfIdentity,
      now: () => 1000,
      sendOverWire: fakeSend({ approved: true }),
    });
    const result = await fn("email.send");
    expect(result).toEqual({ kind: "answered", peerId: "peer:bob", approved: true });
  });

  // Catch branch — wire throws.
  it("returns timeout when the wire call throws", async () => {
    const fn = buildDelegatedRequestRemote({
      store: fakeStore("peer:bob") as DelegationStore,
      index: fakeIndex([reachablePeer]) as unknown as LocalIndex,
      selfIdentity,
      now: () => 1000,
      sendOverWire: fakeSendThrows("connection refused"),
    });
    const result = await fn("email.send");
    expect(result).toEqual({ kind: "timeout" });
  });
});
