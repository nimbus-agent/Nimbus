// packages/gateway/src/share/share-forward.test.ts
import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { buildShareFile, type ShareBody, type ShareFile } from "./share-format.ts";
import {
  type ForwardPeer,
  type ForwardShareDeps,
  forwardShare,
  type ReceiveShareDeps,
  receiveForwardedShare,
} from "./share-forward.ts";
import { verifyForwardingChain } from "./share-forwarding.ts";

function kp(b: number) {
  const seed = new Uint8Array(32).fill(b);
  const pair = nacl.sign.keyPair.fromSeed(seed);
  return {
    privkeyB64: Buffer.from(seed).toString("base64"),
    pubkeyB64: Buffer.from(pair.publicKey).toString("base64"),
  };
}
const ORIGIN = kp(1);
const SELF = kp(9);

function aliceShare(): ShareFile {
  const body: ShareBody = {
    kind: "recipe",
    sessionId: "s1",
    createdAt: 1,
    expiresAt: null,
    redactionSet: [],
    origin: { label: "alice", pubkey: ORIGIN.pubkeyB64 },
    recipe: {
      recipeVersion: 1,
      sourceSessionId: "s1",
      generatedAt: 1,
      steps: [],
      graphTraversals: [],
    },
  };
  return buildShareFile(body, ORIGIN.privkeyB64, ORIGIN.pubkeyB64);
}

function baseDeps(over: Partial<ForwardShareDeps>): ForwardShareDeps {
  const share = aliceShare();
  return {
    now: () => 100,
    label: "bob",
    loadShare: (h) => (h === share.contentHash ? share : undefined),
    shareKeypair: async () => SELF,
    requestApproval: async () => true,
    lookupPeer: () => undefined,
    deliver: async () => {},
    queuePending: () => {},
    recordAudit: () => {},
    ...over,
  };
}

describe("forwardShare", () => {
  test("approved + reachable peer → appends hop, delivers, audits approved", async () => {
    const share = aliceShare();
    const peer: ForwardPeer = { host: "1.2.3.4", port: 9, pubkey: "BOXPUB" };
    let deliveredShare: ShareFile | undefined;
    const audit: string[] = [];
    const out = await forwardShare(
      { contentHash: share.contentHash, recipientPubkey: "BOB" },
      baseDeps({
        lookupPeer: () => peer,
        deliver: async (s) => {
          deliveredShare = s;
        },
        recordAudit: (e) => audit.push(`${e.actionType}:${e.hitlStatus}`),
      }),
    );
    expect(out).toEqual({ status: "ok", delivered: true, contentHash: share.contentHash });
    expect(deliveredShare?.forwarding.hops).toBe(1);
    expect(deliveredShare?.body).toEqual(share.body); // inner body untouched
    expect(verifyForwardingChain(deliveredShare!).valid).toBe(true);
    expect(audit).toEqual(["share.publish:approved"]);
  });

  test("approved + NOT-paired recipient → queues pending (not delivered)", async () => {
    const share = aliceShare();
    let queued: ShareFile | undefined;
    let delivered = false;
    const out = await forwardShare(
      { contentHash: share.contentHash, recipientPubkey: "CAROL" },
      baseDeps({
        lookupPeer: () => undefined,
        queuePending: (_r, s) => {
          queued = s;
        },
        deliver: async () => {
          delivered = true;
        },
      }),
    );
    expect(out).toEqual({ status: "ok", delivered: false, contentHash: share.contentHash });
    expect(queued?.forwarding.hops).toBe(1);
    expect(delivered).toBe(false);
  });

  test("denied approval → fail-closed: no deliver, no queue, audits rejected", async () => {
    const share = aliceShare();
    let touched = false;
    const audit: string[] = [];
    const out = await forwardShare(
      { contentHash: share.contentHash, recipientPubkey: "BOB" },
      baseDeps({
        requestApproval: async () => false,
        lookupPeer: () => ({ host: "h", port: 1, pubkey: "P" }),
        deliver: async () => {
          touched = true;
        },
        queuePending: () => {
          touched = true;
        },
        recordAudit: (e) => audit.push(`${e.actionType}:${e.hitlStatus}`),
      }),
    );
    expect(out).toEqual({ status: "rejected" });
    expect(touched).toBe(false);
    expect(audit).toEqual(["share.publish:rejected"]);
  });

  test("unknown contentHash → rejected, no approval requested", async () => {
    let approvalAsked = false;
    const out = await forwardShare(
      { contentHash: "nope", recipientPubkey: "BOB" },
      baseDeps({
        requestApproval: async () => {
          approvalAsked = true;
          return true;
        },
      }),
    );
    expect(out).toEqual({ status: "rejected" });
    expect(approvalAsked).toBe(false);
  });

  test("forwarding own share (origin == self) → no hop appended (hops stays 0)", async () => {
    // Build a share whose origin IS this gateway's share key.
    const body: ShareBody = {
      kind: "recipe",
      sessionId: "s1",
      createdAt: 1,
      expiresAt: null,
      redactionSet: [],
      origin: { label: "bob", pubkey: SELF.pubkeyB64 },
      recipe: {
        recipeVersion: 1,
        sourceSessionId: "s1",
        generatedAt: 1,
        steps: [],
        graphTraversals: [],
      },
    };
    const own = buildShareFile(body, SELF.privkeyB64, SELF.pubkeyB64);
    let deliveredShare: ShareFile | undefined;
    await forwardShare(
      { contentHash: own.contentHash, recipientPubkey: "BOB" },
      baseDeps({
        loadShare: (h) => (h === own.contentHash ? own : undefined),
        lookupPeer: () => ({ host: "h", port: 1, pubkey: "P" }),
        deliver: async (s) => {
          deliveredShare = s;
        },
      }),
    );
    expect(deliveredShare?.forwarding.hops).toBe(0);
    expect(deliveredShare?.forwarding.chain).toHaveLength(0);
  });
});

describe("receiveForwardedShare — inert inbound", () => {
  test("valid signed share → stored inert (no execution dep exists to call)", async () => {
    const share = aliceShare();
    let stored: ShareFile | undefined;
    const deps: ReceiveShareDeps = {
      now: () => 1,
      storeReceived: (s) => {
        stored = s;
      },
    };
    const out = await receiveForwardedShare(share, deps);
    expect(out.ok).toBe(true);
    expect(stored?.contentHash).toBe(share.contentHash);
  });

  test("tampered body (bad content sig) → rejected, NOT stored", async () => {
    const share = aliceShare();
    const tampered = { ...share, body: { ...share.body, sessionId: "EVIL" } }; // sig no longer matches
    let stored = false;
    const out = await receiveForwardedShare(tampered, {
      now: () => 1,
      storeReceived: () => {
        stored = true;
      },
    });
    expect(out.ok).toBe(false);
    expect(stored).toBe(false);
  });

  test("non-object / malformed input → rejected (fail-safe)", async () => {
    let stored = false;
    const deps: ReceiveShareDeps = {
      now: () => 1,
      storeReceived: () => {
        stored = true;
      },
    };
    expect((await receiveForwardedShare(null, deps)).ok).toBe(false);
    expect((await receiveForwardedShare("nope", deps)).ok).toBe(false);
    expect(stored).toBe(false);
  });
});
