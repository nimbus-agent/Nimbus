import { afterEach, describe, expect, test } from "bun:test";
import { sendFederatedOverWire } from "./lan-client.ts";
import { generateBoxKeypair } from "./lan-crypto.ts";
import { sendFederatedLegacy } from "./lan-legacy.ts";
import { NOISE_OPEN_FAILED } from "./lan-noise.ts";
import {
  attackerEeCandidates,
  attackLegacyBox,
  attackTransport,
  ratchetScenario,
  recordSession,
  replayRecordedRequest,
  SECRET_REPLY,
  SECRET_REQUEST,
  startServer,
  transcriptContains,
} from "./testing/lan-forward-secrecy.test-helpers.ts";
import { startLegacyOnlyServer, startStub } from "./testing/lan-v2.test-helpers.ts";

const stops: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

describe("FS-A1 - a recorded session cannot be opened with the pairing keys alone", () => {
  test("given BOTH static secrets and the whole transcript, no v2 record opens and no v1 attack works", async () => {
    const s = await recordSession(false);
    stops.push(() => s.stop());
    // Sanity: the exchange really happened and nothing sensitive is in the clear.
    expect(s.conn.c2s.length).toBeGreaterThanOrEqual(2);
    expect(s.conn.s2c.length).toBeGreaterThanOrEqual(2);
    expect(transcriptContains(s.conn, SECRET_REQUEST)).toBe(false);
    expect(transcriptContains(s.conn, SECRET_REPLY)).toBe(false);

    const opened = attackTransport(s.conn, {
      initiator: s.initiator,
      responder: s.responder,
      eeCandidates: attackerEeCandidates(s),
    });
    expect(opened).toBe(0);
    expect(attackLegacyBox(s.conn, s.initiator, s.responder)).toBe(0);
  });

  test("positive control: the SAME routine, given the initiator's ephemeral secret, opens the records", async () => {
    const s = await recordSession(true);
    stops.push(() => s.stop());
    expect(s.controlEe).toBeDefined();
    const withEe = attackTransport(s.conn, {
      initiator: s.initiator,
      responder: s.responder,
      eeCandidates: [s.controlEe as Uint8Array],
    });
    // At least the request record (client key) and the reply record (server key) open.
    expect(withEe).toBeGreaterThanOrEqual(2);
    // And without it (the same transcript, same static keys), nothing does.
    expect(
      attackTransport(s.conn, {
        initiator: s.initiator,
        responder: s.responder,
        eeCandidates: attackerEeCandidates(s),
      }),
    ).toBe(0);
  });
});

describe("FS-A2 - replay", () => {
  test("server half: a replayed message 1 draws a fresh message 2, the recorded request never executes, one failure is counted", async () => {
    const out = await replayRecordedRequest();
    expect(out.messageTwoDiffers).toBe(true);
    expect(out.closed).toBe(true);
    expect(out.bytesAfterMessage2).toBe(0);
    expect(out.executedAfter).toBe(out.executedBefore);
    expect(out.failures).toBe(1);
  });

  test("client half: a recorded message 2 and reply replayed to a NEW client session do not open", async () => {
    const s = await recordSession(false);
    stops.push(() => s.stop());
    const recordedMessage2 = s.conn.s2c[0] as Uint8Array;
    const recordedReplies = s.conn.s2c.slice(1);
    const replayer = startStub((_frame, socket, n) => {
      void n;
      socket.write(recordedMessage2);
      for (const r of recordedReplies) socket.write(r);
    });
    stops.push(() => replayer.stop());
    let message = "";
    try {
      await sendFederatedOverWire(
        "127.0.0.1",
        replayer.port,
        s.initiator,
        s.responder.publicKey,
        "federation.ping",
        { secret: SECRET_REQUEST },
        1500,
        { known: 2, minProtocol: 1 },
      );
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe(NOISE_OPEN_FAILED);
  });
});

describe("FS-A3 - the downgrade ratchet", () => {
  test("one v2 session ratchets both rows to 2, and a legacy hello for that pubkey gets no reply", async () => {
    const out = await ratchetScenario();
    expect(out.hostRowBefore).toBe(1);
    expect(out.hostRowAfter).toBe(2);
    expect(out.askerRowAfter).toBe(2);
    expect(out.legacyHelloClosed).toBe(true);
    expect(out.legacyHelloBytes).toBe(0);
  });

  test("a client recorded at 2 never falls back to the old wire against an old server", async () => {
    const a = generateBoxKeypair();
    const b = generateBoxKeypair();
    const old = startLegacyOnlyServer({
      hostKeypair: b,
      onMessage: async () => ({ legacy: true }),
      isKnownPeer: () => ({ peerId: "p", writeAllowed: false, protoVersion: 1 }),
      registerPeer: () => "p",
      rateLimit: { checkAllowed: () => true, recordFailure: () => {}, recordSuccess: () => {} },
      pairing: {
        isOpen: () => false,
        consume: () => false,
        open: () => {},
        close: () => {},
        getExpiresAt: () => undefined,
      },
      minProtocol: 1,
    });
    stops.push(() => old.stop());
    let message = "";
    try {
      await sendFederatedOverWire(
        "127.0.0.1",
        old.port,
        a,
        b.publicKey,
        "federation.ping",
        {},
        1500,
        { known: 2, minProtocol: 1 },
      );
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("no reply");
    expect(old.connections()).toBe(1);
  });
});

describe("FS-A4 - old and new peers interoperate during the compatibility window", () => {
  test("a new client reaches an old server (one v1 retry) and an old client reaches a new server", async () => {
    const calls: string[] = [];
    const responder = generateBoxKeypair();
    const initiator = generateBoxKeypair();
    const ctx = {
      hostKeypair: responder,
      onMessage: async (m: string) => {
        calls.push(m);
        return { served: m };
      },
      isKnownPeer: (pk: Uint8Array) =>
        Buffer.compare(Buffer.from(pk), Buffer.from(initiator.publicKey)) === 0
          ? { peerId: "p", writeAllowed: false, protoVersion: 1 as const }
          : null,
      registerPeer: () => "p",
      rateLimit: { checkAllowed: () => true, recordFailure: () => {}, recordSuccess: () => {} },
      pairing: {
        isOpen: () => false,
        consume: () => false,
        open: () => {},
        close: () => {},
        getExpiresAt: () => undefined,
      },
      minProtocol: 1 as const,
    };
    // new client -> old server
    const old = startLegacyOnlyServer(ctx);
    stops.push(() => old.stop());
    const viaNewClient = await sendFederatedOverWire(
      "127.0.0.1",
      old.port,
      initiator,
      responder.publicKey,
      "federation.ping",
      {},
      2000,
      { known: 1, minProtocol: 1 },
    );
    expect(viaNewClient).toEqual({ served: "federation.ping" });

    // old client -> new server
    const { server, port } = await startServer(responder, initiator, calls);
    stops.push(() => server.stop());
    const viaOldClient = await sendFederatedLegacy(
      "127.0.0.1",
      port,
      initiator,
      responder.publicKey,
      "federation.ping",
      {},
      2000,
    );
    expect(viaOldClient).toEqual({ secret: SECRET_REPLY });
  });
});
