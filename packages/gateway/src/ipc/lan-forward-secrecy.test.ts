import { afterEach, describe, expect, test } from "bun:test";
import { sendFederatedOverWire } from "./lan-client.ts";
import { generateBoxKeypair } from "./lan-crypto.ts";
import { NOISE_OPEN_FAILED } from "./lan-noise.ts";
import { LanServer } from "./lan-server.ts";
import {
  attackerEeCandidates,
  attackLegacyBox,
  attackTransport,
  ratchetScenario,
  recordSession,
  replayRecordedRequest,
  SECRET_REPLY,
  SECRET_REQUEST,
  transcriptContains,
} from "./testing/lan-forward-secrecy.test-helpers.ts";
import { connectRaw, startOldWireServer, startStub } from "./testing/lan-v2.test-helpers.ts";
import { fakePairing } from "./testing/pairing-fakes.ts";

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
        { known: 2 },
      );
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe(NOISE_OPEN_FAILED);
  });
});

describe("FS-A3 - the downgrade ratchet", () => {
  test("one v2 session ratchets both rows to 2, and an old-wire hello for that pubkey gets no reply", async () => {
    const out = await ratchetScenario();
    expect(out.hostRowBefore).toBe(1);
    expect(out.hostRowAfter).toBe(2);
    expect(out.askerRowAfter).toBe(2);
    expect(out.legacyHelloClosed).toBe(true);
    expect(out.legacyHelloBytes).toBe(0);
  });
});

describe("FS3 - the old wire is gone: a peer from before LAN forward secrecy is refused both ways", () => {
  test("new client -> old server: ONE connection, no retry on any other wire, and the error says to upgrade", async () => {
    const a = generateBoxKeypair();
    const b = generateBoxKeypair();
    for (const known of [1, 2] as const) {
      const old = startOldWireServer();
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
          {
            known,
          },
        );
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("upgrade that peer");
      expect(old.connections()).toBe(1);
    }
  });

  test("old client -> new server: a v1 JSON hello gets no reply, is a counted failure, and names the address", async () => {
    const responder = generateBoxKeypair();
    const initiator = generateBoxKeypair();
    const refused: string[] = [];
    const failures: string[] = [];
    const server = new LanServer({
      bind: "127.0.0.1",
      port: 0,
      hostKeypair: responder,
      onMessage: async () => ({ never: true }),
      isKnownPeer: () => ({ peerId: "p", writeAllowed: false, protoVersion: 1 }),
      registerPeer: () => "p",
      rateLimit: {
        checkAllowed: () => true,
        recordFailure: (ip) => failures.push(ip),
        recordSuccess: () => {},
      },
      pairing: fakePairing(),
      onOldWireRefused: (ip) => refused.push(ip),
    });
    await server.start();
    stops.push(() => server.stop());
    const port = (server.listenAddr() as { port: number }).port;
    for (const kind of ["hello", "pair"]) {
      const conn = await connectRaw(port);
      conn.writeFrame(
        new TextEncoder().encode(
          JSON.stringify({
            kind,
            client_pubkey: Buffer.from(initiator.publicKey).toString("base64"),
            pairing_code: "x",
          }),
        ),
      );
      expect(await conn.closed()).toBe(true);
      expect(conn.received().length).toBe(0);
    }
    expect(refused).toEqual(["127.0.0.1", "127.0.0.1"]);
    expect(failures).toEqual(["127.0.0.1", "127.0.0.1"]);
  });
});
