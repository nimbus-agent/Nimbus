import { mock } from "bun:test";

// Must be declared before dynamic import so Bun wires it up before the module loads.
// Controlled per-test via `wireResponse`.
let wireResponse: unknown = null;
mock.module("../ipc/lan-client.ts", () => ({
  sendFederatedOverWire: async () => wireResponse,
}));

import { describe, expect, it } from "bun:test";
import type { LanPeerRow, LocalIndex } from "../index/local-index.ts";
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
    wireResponse = { approved: "yes" }; // string, not boolean
    const fn = buildDelegatedRequestRemote({
      store: fakeStore("peer:bob") as DelegationStore,
      index: fakeIndex([
        {
          peer_id: "peer:bob",
          peer_pubkey: new Uint8Array(32),
          direction: "inbound",
          host_ip: "192.168.1.5",
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

  // Line 44, block 5, branch 0 — wire returns a proper boolean approval (happy path).
  it("returns answered with approved=true when the wire confirms approval", async () => {
    wireResponse = { approved: true };
    const fn = buildDelegatedRequestRemote({
      store: fakeStore("peer:bob") as DelegationStore,
      index: fakeIndex([
        {
          peer_id: "peer:bob",
          peer_pubkey: new Uint8Array(32),
          direction: "inbound",
          host_ip: "192.168.1.5",
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
    expect(result).toEqual({ kind: "answered", peerId: "peer:bob", approved: true });
  });

  // Catch branch — wire throws.
  it("returns timeout when the wire call throws", async () => {
    wireResponse = null; // reset
    mock.module("../ipc/lan-client.ts", () => ({
      sendFederatedOverWire: async () => {
        throw new Error("connection refused");
      },
    }));
    const { buildDelegatedRequestRemote: buildFn } = await import("./delegated-request-remote.ts");
    const fn = buildFn({
      store: fakeStore("peer:bob") as DelegationStore,
      index: fakeIndex([
        {
          peer_id: "peer:bob",
          peer_pubkey: new Uint8Array(32),
          direction: "inbound",
          host_ip: "192.168.1.5",
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
});
