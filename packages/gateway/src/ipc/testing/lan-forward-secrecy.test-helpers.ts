/**
 * Test-only scenarios for the LAN forward-secrecy acceptance criteria (FS-A1 to FS-A3), shared by
 * `lan-forward-secrecy.test.ts` and the invariant block in `security-invariants.test.ts` so the two
 * run the SAME code, not copies of it.
 */
import { Database } from "bun:sqlite";
import { createDecipheriv, createHmac } from "node:crypto";
import nacl from "tweetnacl";
import { buildFederationLanServer } from "../../federation/federation-server.ts";
import { lanLinkFor } from "../../federation/lan-link.ts";
import { type LanPeerRow, LocalIndex } from "../../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { sendFederatedOverWire } from "../lan-client.ts";
import { type BoxKeypair, generateBoxKeypair, openBoxFrame } from "../lan-crypto.ts";
import { x25519PublicKey } from "../lan-noise.ts";
import { LanServer } from "../lan-server.ts";
import { createInitiatorHandshake } from "../lan-session.ts";
import { makeFrameReader } from "../lan-wire.ts";
import { connectRaw, readV2Reply, sendV2Request } from "./lan-v2.test-helpers.ts";

export interface RecordedConnection {
  /** Whole frame bodies, client to server, in order. */
  c2s: Uint8Array[];
  /** Whole frame bodies, server to client, in order. */
  s2c: Uint8Array[];
}

export interface RecordingProxy {
  port: number;
  connections: RecordedConnection[];
  stop(): void;
}

/** A loopback TCP relay that stores every frame of both directions per connection (127.0.0.1 only, I6). */
export function startRecordingProxy(targetPort: number): RecordingProxy {
  const connections: RecordedConnection[] = [];
  interface Pipe {
    rec: RecordedConnection;
    c2sReader: ReturnType<typeof makeFrameReader>;
    s2cReader: ReturnType<typeof makeFrameReader>;
    upstream?: { write(b: Uint8Array): number; end(): void };
    pending: Uint8Array[];
    clientEnded: boolean;
  }
  const listener = Bun.listen<Pipe>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(client) {
        const rec: RecordedConnection = { c2s: [], s2c: [] };
        connections.push(rec);
        const pipe: Pipe = {
          rec,
          c2sReader: makeFrameReader(8 * 1024 * 1024),
          s2cReader: makeFrameReader(8 * 1024 * 1024),
          pending: [],
          clientEnded: false,
        };
        client.data = pipe;
        void Bun.connect({
          hostname: "127.0.0.1",
          port: targetPort,
          socket: {
            open(up) {
              pipe.upstream = up;
              for (const chunk of pipe.pending.splice(0)) up.write(chunk);
              if (pipe.clientEnded) up.end();
            },
            data(_up, chunk) {
              pipe.s2cReader.push(chunk);
              for (let f = pipe.s2cReader.next(); f !== undefined; f = pipe.s2cReader.next()) {
                rec.s2c.push(f);
              }
              client.write(chunk);
            },
            close() {
              client.end();
            },
            error() {
              client.end();
            },
          },
        });
      },
      data(client, chunk) {
        const pipe = client.data;
        pipe.c2sReader.push(chunk);
        for (let f = pipe.c2sReader.next(); f !== undefined; f = pipe.c2sReader.next()) {
          pipe.rec.c2s.push(f);
        }
        if (pipe.upstream) pipe.upstream.write(chunk);
        else pipe.pending.push(chunk.slice());
      },
      close(client) {
        client.data.clientEnded = true;
        client.data.upstream?.end();
      },
    },
  });
  return { port: listener.port, connections, stop: () => listener.stop(true) };
}

// ---------------------------------------------------------------------------------------------
// The attacker: holds BOTH static secret keys and the whole transcript, and nothing else.
// ---------------------------------------------------------------------------------------------

function hmac(key: Uint8Array, ...parts: Uint8Array[]): Uint8Array {
  const h = createHmac("sha256", key);
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

/** Noise HKDF, two outputs (Noise section 4.3), re-implemented here independently of lan-noise.ts. */
function hkdf2(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmac(ck, ikm);
  const o1 = hmac(temp, new Uint8Array([1]));
  const o2 = hmac(temp, o1, new Uint8Array([2]));
  return [o1, o2];
}

function aesGcmOpens(key: Uint8Array, n: number, sealed: Uint8Array): boolean {
  if (sealed.length < 16) return false;
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(n), false);
  try {
    const d = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    d.setAAD(new Uint8Array(0));
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    d.update(sealed.subarray(0, sealed.length - 16));
    d.final();
    return true;
  } catch {
    return false;
  }
}

export interface AttackSecrets {
  initiator: BoxKeypair;
  responder: BoxKeypair;
  /** Candidate values for the `ee` DH output. The real attacker does not have it. */
  eeCandidates: Uint8Array[];
}

/**
 * Tries to open every transport record of `conn`, and returns how many opened. It re-derives the
 * Noise IK key schedule (`Noise_IK_25519_AESGCM_SHA256`) from the two static secrets and the public
 * ephemerals in the transcript: it can compute `es`, `ss` and `se`, but `ee` needs an ephemeral
 * SECRET, so for `ee` it tries each candidate in `secrets.eeCandidates`.
 */
export function attackTransport(conn: RecordedConnection, secrets: AttackSecrets): number {
  const msg1 = (conn.c2s[0] as Uint8Array).subarray(4); // after the 4-byte header
  const msg2 = conn.s2c[0] as Uint8Array;
  const eI = msg1.slice(0, 32);
  const eR = msg2.slice(0, 32);
  const name = new TextEncoder().encode("Noise_IK_25519_AESGCM_SHA256");
  const ck0 = new Uint8Array(32);
  ck0.set(name, 0);
  const es = nacl.scalarMult(secrets.responder.secretKey, eI);
  const ss = nacl.scalarMult(secrets.initiator.secretKey, secrets.responder.publicKey);
  const se = nacl.scalarMult(secrets.initiator.secretKey, eR);
  const records = [...conn.c2s.slice(1), ...conn.s2c.slice(1)];
  let opened = 0;
  for (const ee of secrets.eeCandidates) {
    let ck = hkdf2(ck0, es)[0];
    ck = hkdf2(ck, ss)[0];
    ck = hkdf2(ck, ee)[0];
    ck = hkdf2(ck, se)[0];
    const [k1, k2] = hkdf2(ck, new Uint8Array(0));
    for (const key of [k1, k2]) {
      for (const record of records) {
        for (let n = 0; n < 4; n++) if (aesGcmOpens(key, n, record)) opened += 1;
      }
    }
  }
  return opened;
}

/** The v1 attack: `openBoxFrame` on every frame body of both directions with all four key orders. */
export function attackLegacyBox(conn: RecordedConnection, a: BoxKeypair, b: BoxKeypair): number {
  let opened = 0;
  const pubs = [a.publicKey, b.publicKey];
  const secs = [a.secretKey, b.secretKey];
  for (const frame of [...conn.c2s, ...conn.s2c]) {
    for (const pub of pubs) {
      for (const sec of secs) {
        try {
          openBoxFrame(frame, pub, sec);
          opened += 1;
        } catch {
          /* does not open */
        }
      }
    }
  }
  return opened;
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

export const SECRET_REQUEST = "the-recorded-secret-request-body";
export const SECRET_REPLY = "the-recorded-secret-reply-body";

const noopRate = { checkAllowed: () => true, recordFailure: () => {}, recordSuccess: () => {} };
const noopPairing = {
  isOpen: () => false,
  consume: () => false,
  open: () => {},
  close: () => {},
  getExpiresAt: () => undefined,
};

export interface RecordedSession {
  conn: RecordedConnection;
  initiator: BoxKeypair;
  responder: BoxKeypair;
  /** Set only when the test chose the initiator's ephemeral (the positive control). */
  knownEphemeralSecret?: Uint8Array;
  /** `ee` as the positive control computes it from the injected ephemeral. */
  controlEe?: Uint8Array;
  stop(): Promise<void>;
}

async function startServer(responder: BoxKeypair, initiator: BoxKeypair, calls: string[]) {
  const server = new LanServer({
    bind: "127.0.0.1",
    port: 0,
    hostKeypair: responder,
    onMessage: async (method) => {
      calls.push(method);
      return { secret: SECRET_REPLY };
    },
    isKnownPeer: (pk) =>
      Buffer.compare(Buffer.from(pk), Buffer.from(initiator.publicKey)) === 0
        ? { peerId: "peer:c", writeAllowed: false, protoVersion: 1 }
        : null,
    registerPeer: () => "peer:c",
    rateLimit: noopRate,
    pairing: noopPairing,
  });
  await server.start();
  return { server, port: (server.listenAddr() as { port: number }).port };
}

/**
 * FS-A1 setup: a real `LanServer` and a client, through the recording proxy. With
 * `knownEphemeral`, the client is the test's own v2 initiator with an injected ephemeral (the
 * positive control); otherwise it is the production `sendFederatedOverWire`.
 */
export async function recordSession(knownEphemeral: boolean): Promise<RecordedSession> {
  const responder = generateBoxKeypair();
  const initiator = generateBoxKeypair();
  const calls: string[] = [];
  const { server, port } = await startServer(responder, initiator, calls);
  const proxy = startRecordingProxy(port);
  const stop = async (): Promise<void> => {
    proxy.stop();
    await server.stop();
  };
  if (!knownEphemeral) {
    await sendFederatedOverWire(
      "127.0.0.1",
      proxy.port,
      initiator,
      responder.publicKey,
      "federation.ping",
      { secret: SECRET_REQUEST },
      3000,
      { known: 2, minProtocol: 1 },
    );
    return { conn: proxy.connections[0] as RecordedConnection, initiator, responder, stop };
  }
  const ephemeralSecret = new Uint8Array(32);
  crypto.getRandomValues(ephemeralSecret);
  const handshake = createInitiatorHandshake({
    s: initiator,
    rs: responder.publicKey,
    generateEphemeral: () => ({
      publicKey: x25519PublicKey(ephemeralSecret),
      secretKey: ephemeralSecret.slice(),
    }),
  });
  const conn = await connectRaw(proxy.port);
  conn.writeFrame(handshake.firstFrameBody);
  const message2 = (await conn.nextFrame()) as Uint8Array;
  const session = handshake.finish(message2);
  const x = { conn, session, firstFrameBody: handshake.firstFrameBody, message2 };
  sendV2Request(x, { id: 1, method: "federation.ping", params: { secret: SECRET_REQUEST } });
  await readV2Reply(x);
  conn.close();
  await new Promise((r) => setTimeout(r, 50));
  const eR = message2.slice(0, 32);
  return {
    conn: proxy.connections[0] as RecordedConnection,
    initiator,
    responder,
    knownEphemeralSecret: ephemeralSecret,
    controlEe: new Uint8Array(nacl.scalarMult(ephemeralSecret, eR)),
    stop,
  };
}

/** The candidates the real attacker has for `ee`: everything it can compute, plus guesses. */
export function attackerEeCandidates(s: RecordedSession): Uint8Array[] {
  const msg1 = (s.conn.c2s[0] as Uint8Array).subarray(4);
  const eI = msg1.slice(0, 32);
  const msg2 = s.conn.s2c[0] as Uint8Array;
  const eR = msg2.slice(0, 32);
  return [
    new Uint8Array(32),
    new Uint8Array(nacl.scalarMult(s.responder.secretKey, eI)), // es
    new Uint8Array(nacl.scalarMult(s.initiator.secretKey, s.responder.publicKey)), // ss
    new Uint8Array(nacl.scalarMult(s.initiator.secretKey, eR)), // se
    new Uint8Array(nacl.scalarMult(s.responder.secretKey, eR)), // a wrong-party guess
  ];
}

/** True when the transcript contains `needle` anywhere (a sanity check that nothing is in the clear). */
export function transcriptContains(conn: RecordedConnection, needle: string): boolean {
  const n = Buffer.from(needle);
  return [...conn.c2s, ...conn.s2c].some((f) => Buffer.from(f).includes(n));
}

export interface ReplayOutcome {
  /** `onMessage` call count after the replay (must equal the count before it). */
  executedBefore: number;
  executedAfter: number;
  /** Bytes the server sent after message 2 on the replay connection. */
  bytesAfterMessage2: number;
  closed: boolean;
  /** Rate-limit failures recorded for the replay connection. */
  failures: number;
  messageTwoDiffers: boolean;
}

/** FS-A2 (server half): record a session, replay message 1 then the recorded request record. */
export async function replayRecordedRequest(): Promise<ReplayOutcome> {
  const responder = generateBoxKeypair();
  const initiator = generateBoxKeypair();
  const calls: string[] = [];
  const failures: string[] = [];
  const server = new LanServer({
    bind: "127.0.0.1",
    port: 0,
    hostKeypair: responder,
    onMessage: async (method) => {
      calls.push(method);
      return { ok: true };
    },
    isKnownPeer: (pk) =>
      Buffer.compare(Buffer.from(pk), Buffer.from(initiator.publicKey)) === 0
        ? { peerId: "peer:c", writeAllowed: false, protoVersion: 2 }
        : null,
    registerPeer: () => "peer:c",
    rateLimit: { ...noopRate, recordFailure: (ip) => failures.push(ip) },
    pairing: noopPairing,
  });
  await server.start();
  const port = (server.listenAddr() as { port: number }).port;
  try {
    const handshake = createInitiatorHandshake({ s: initiator, rs: responder.publicKey });
    const first = await connectRaw(port);
    first.writeFrame(handshake.firstFrameBody);
    const message2 = (await first.nextFrame()) as Uint8Array;
    const session = handshake.finish(message2);
    const x = { conn: first, session, firstFrameBody: handshake.firstFrameBody, message2 };
    const records = sendV2Request(x, { id: 1, method: "federation.ping" });
    await readV2Reply(x);
    first.close();
    const executedBefore = calls.length;
    const failuresBefore = failures.length;

    const replay = await connectRaw(port);
    replay.writeFrame(handshake.firstFrameBody);
    const replayMessage2 = (await replay.nextFrame()) as Uint8Array;
    for (const r of records) replay.writeFrame(r);
    const closed = await replay.closed();
    return {
      executedBefore,
      executedAfter: calls.length,
      bytesAfterMessage2: replay.received().length - (4 + replayMessage2.length),
      closed,
      failures: failures.length - failuresBefore,
      messageTwoDiffers: !Buffer.from(replayMessage2).equals(Buffer.from(message2)),
    };
  } finally {
    await server.stop();
  }
}

export { startServer };

export interface RatchetOutcome {
  hostRowBefore: number | undefined;
  hostRowAfter: number | undefined;
  askerRowAfter: number | undefined;
  /** What a legacy hello for the now-ratcheted pubkey received: bytes and whether the socket closed. */
  legacyHelloBytes: number;
  legacyHelloClosed: boolean;
}

/**
 * FS-A3 end to end with real SQLite on both sides: a peer made over the old wire is at 1; one v2
 * session through `lanLinkFor` raises BOTH rows to 2; a legacy hello for that pubkey then gets no
 * reply at all.
 */
export async function ratchetScenario(): Promise<RatchetOutcome> {
  const hostDb = new Database(":memory:");
  runIndexedSchemaMigrations(hostDb, LocalIndex.SCHEMA_VERSION);
  const hostIndex = new LocalIndex(hostDb);
  const hostKp = generateBoxKeypair();
  const askerKp = generateBoxKeypair();
  const built = buildFederationLanServer({
    db: hostDb,
    index: hostIndex,
    identity: hostKp,
    lan: {
      bind: "127.0.0.1",
      port: 0,
      pairingWindowSeconds: 60,
      maxFailedAttempts: 9,
      lockoutSeconds: 60,
    },
    consentTimeoutMs: 1000,
    notify: () => {},
  });
  await built.lanServer.start();
  const port = (built.lanServer.listenAddr() as { port: number }).port;
  try {
    hostIndex.addLanPeer({
      peerId: "peer:asker",
      peerPubkey: askerKp.publicKey,
      direction: "inbound",
    });
    const askerDb = new Database(":memory:");
    runIndexedSchemaMigrations(askerDb, LocalIndex.SCHEMA_VERSION);
    const askerIndex = new LocalIndex(askerDb);
    askerIndex.addLanPeer({
      peerId: "peer:host",
      peerPubkey: hostKp.publicKey,
      direction: "outbound",
      hostIp: "127.0.0.1",
      hostPort: port,
    });
    const row = () => askerIndex.getLanPeerByPubkey(hostKp.publicKey) as LanPeerRow;
    const hostRowBefore = hostIndex.getLanPeerByPubkey(askerKp.publicKey)?.proto_version;
    await sendFederatedOverWire(
      "127.0.0.1",
      port,
      askerKp,
      hostKp.publicKey,
      "federation.query",
      { namespace: "none", purpose: "fs" },
      3000,
      lanLinkFor(row(), askerIndex),
    );
    const hello = await connectRaw(port);
    hello.writeFrame(
      new TextEncoder().encode(
        JSON.stringify({
          kind: "hello",
          client_pubkey: Buffer.from(askerKp.publicKey).toString("base64"),
        }),
      ),
    );
    const legacyHelloClosed = await hello.closed();
    return {
      hostRowBefore,
      hostRowAfter: hostIndex.getLanPeerByPubkey(askerKp.publicKey)?.proto_version,
      askerRowAfter: row().proto_version,
      legacyHelloBytes: hello.received().length,
      legacyHelloClosed,
    };
  } finally {
    await built.lanServer.stop();
  }
}
