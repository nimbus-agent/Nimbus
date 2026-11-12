/**
 * The v1 LAN wire: a plaintext JSON `pair`/`hello` handshake, then frames sealed with the STATIC
 * `nacl.box` shared secret of the two identity keys (`lan-crypto.ts`). It is kept byte-for-byte for
 * peers that have not upgraded (owner ruling OR-FS-1, the compatibility window) and is the ONLY
 * module that may call `sealBoxFrame` / `openBoxFrame` (static rule D47). It is deleted, with its
 * tests, once the window closes (slice FS3).
 *
 * Forward secrecy does not exist here: a later holder of either static secret decrypts every
 * recorded v1 session. `legacyAllowedFor` is the invariant I56 downgrade check: this path is never
 * taken for a peer whose recorded protocol is 2, and never under `[lan] min_protocol = 2`.
 */
import type { BoxKeypair } from "./lan-crypto.ts";
import { openBoxFrame, sealBoxFrame } from "./lan-crypto.ts";
import { checkLanMethodAllowed, LanError } from "./lan-rpc.ts";
import {
  DEFAULT_TIMEOUT_MS,
  flushWriter,
  type LanPeerMatch,
  MAX_ENCRYPTED_FRAME,
  makeFrameReader,
  makeSettler,
  type PairingService,
  type RateLimiterService,
  replyKindForMessage,
  writeFrame,
  writeFramedBytes,
} from "./lan-wire.ts";
import type { QueuedSocketWriter } from "./server/queued-socket-writer.ts";

/** The per-connection state the legacy server path reads and sets (a subset of `SessionState`). */
export interface LegacySession {
  peerPubkey?: Uint8Array;
  peerMatch?: LanPeerMatch;
  peerIp: string;
  writer: QueuedSocketWriter;
}

/** What the legacy server path needs from `LanServerOptions`. */
export interface LegacyServerContext {
  hostKeypair: BoxKeypair;
  onMessage: (method: string, params: unknown, peer: LanPeerMatch) => Promise<unknown>;
  isKnownPeer: (pubkey: Uint8Array) => LanPeerMatch | null;
  registerPeer: (pubkey: Uint8Array, peerIp: string) => string;
  rateLimit: RateLimiterService;
  pairing: PairingService;
  /** `[lan] min_protocol`: 2 refuses the whole v1 wire. */
  minProtocol: 1 | 2;
}

/**
 * Invariant I56, the ONE downgrade check (D-FS-13): may a v1 first frame (`pair` or `hello`) proceed
 * for a peer whose recorded protocol is `recorded` (`undefined` when its key is not known)?
 * Never under `min_protocol = 2`, and never for a peer that has completed a v2 session.
 */
export function legacyAllowedFor(recorded: 1 | 2 | undefined, minProtocol: 1 | 2): boolean {
  return minProtocol === 1 && recorded !== 2;
}

function writeText(session: LegacySession, text: string): void {
  writeFramedBytes(session.writer, new TextEncoder().encode(text));
}

/** A refused v1 first frame: closed with no reply, counted. */
function refuseLegacy(session: LegacySession, ctx: LegacyServerContext, ip: string): void {
  ctx.rateLimit.recordFailure(ip);
  session.writer.end();
}

export function legacyHandleHandshake(
  session: LegacySession,
  ctx: LegacyServerContext,
  payload: Uint8Array,
): void {
  let msg: { kind?: string; client_pubkey?: string; pairing_code?: string };
  try {
    msg = JSON.parse(new TextDecoder().decode(payload)) as {
      kind?: string;
      client_pubkey?: string;
      pairing_code?: string;
    };
  } catch {
    session.writer.end();
    return;
  }
  if (msg.kind !== "pair" && msg.kind !== "hello") {
    session.writer.end();
    return;
  }
  if (typeof msg.client_pubkey !== "string") {
    session.writer.end();
    return;
  }
  const clientPubkey = new Uint8Array(Buffer.from(msg.client_pubkey, "base64"));
  if (clientPubkey.length !== 32) {
    session.writer.end();
    return;
  }

  const ip = session.peerIp;
  if (!ctx.rateLimit.checkAllowed(ip)) {
    writeText(session, JSON.stringify({ kind: msg.kind === "hello" ? "hello_err" : "pair_err" }));
    session.writer.end();
    return;
  }

  // I56: the downgrade check. A refused v1 first frame gets NO reply (a reply would tell a downgrader
  // which side said no) and is a counted failure. Under min_protocol = 2 it is refused here, before
  // anything about the sender is looked up; a peer already at protocol 2 is refused where its record
  // is read (the hello below, the pair after the window check).
  if (!legacyAllowedFor(undefined, ctx.minProtocol)) {
    refuseLegacy(session, ctx, ip);
    return;
  }

  if (msg.kind === "pair") {
    if (typeof msg.pairing_code !== "string" || !ctx.pairing.isOpen()) {
      ctx.rateLimit.recordFailure(ip);
      writeText(session, JSON.stringify({ kind: "pair_err" }));
      session.writer.end();
      return;
    }
    // A v1 pair for a key already at protocol 2 would replace its stored address and direction using
    // the plaintext code (a downgrade of pairing): refused before the code is consumed.
    if (!legacyAllowedFor(ctx.isKnownPeer(clientPubkey)?.protoVersion, ctx.minProtocol)) {
      refuseLegacy(session, ctx, ip);
      return;
    }
    const ok = ctx.pairing.consume(msg.pairing_code);
    if (!ok) {
      ctx.rateLimit.recordFailure(ip);
      writeText(session, JSON.stringify({ kind: "pair_err" }));
      session.writer.end();
      return;
    }
    const peerId = ctx.registerPeer(clientPubkey, ip);
    session.peerPubkey = clientPubkey;
    session.peerMatch = { peerId, writeAllowed: false, protoVersion: 1 };
    ctx.rateLimit.recordSuccess(ip);
    writeText(
      session,
      JSON.stringify({
        kind: "pair_ok",
        host_pubkey: Buffer.from(ctx.hostKeypair.publicKey).toString("base64"),
        peer_id: peerId,
      }),
    );
    return;
  }

  const match = ctx.isKnownPeer(clientPubkey);
  if (!match) {
    ctx.rateLimit.recordFailure(ip);
    writeText(session, JSON.stringify({ kind: "hello_err" }));
    session.writer.end();
    return;
  }
  if (!legacyAllowedFor(match.protoVersion, ctx.minProtocol)) {
    refuseLegacy(session, ctx, ip);
    return;
  }
  session.peerPubkey = clientPubkey;
  session.peerMatch = match;
  writeText(
    session,
    JSON.stringify({
      kind: "hello_ok",
      host_pubkey: Buffer.from(ctx.hostKeypair.publicKey).toString("base64"),
    }),
  );
}

export async function legacyHandleEncrypted(
  session: LegacySession,
  ctx: LegacyServerContext,
  frame: Uint8Array,
): Promise<void> {
  if (!session.peerPubkey || !session.peerMatch) {
    session.writer.end();
    return;
  }
  // I56: this connection was admitted at its handshake, but the peer may have completed a v2 session
  // since (on another connection). The record is read again for every request.
  if (!legacyAllowedFor(ctx.isKnownPeer(session.peerPubkey)?.protoVersion, ctx.minProtocol)) {
    session.writer.end();
    return;
  }
  let plain: Uint8Array;
  try {
    plain = openBoxFrame(frame, session.peerPubkey, ctx.hostKeypair.secretKey);
  } catch {
    session.writer.end();
    return;
  }
  let msg: { id?: string | number; method?: string; params?: unknown };
  try {
    msg = JSON.parse(new TextDecoder().decode(plain)) as {
      id?: string | number;
      method?: string;
      params?: unknown;
    };
  } catch {
    session.writer.end();
    return;
  }
  // `JSON.parse("null")` is null: reading `.method` of it would throw outside the try.
  if (typeof msg !== "object" || msg === null || typeof msg.method !== "string") {
    session.writer.end();
    return;
  }
  let result: unknown;
  let error: { code: string; message: string } | undefined;
  try {
    checkLanMethodAllowed(msg.method, session.peerMatch);
    result = await ctx.onMessage(msg.method, msg.params, session.peerMatch);
  } catch (err) {
    if (err instanceof LanError) {
      error = { code: `ERR_${String(err.rpcCode)}`, message: err.message };
    } else {
      const e = err as { code?: string; message?: string };
      error = { code: e.code ?? "ERR_INTERNAL", message: e.message ?? String(err) };
    }
  }
  const response = error ? { id: msg.id, error } : { id: msg.id, result };
  const replyFrame = sealBoxFrame(
    new TextEncoder().encode(JSON.stringify(response)),
    session.peerPubkey,
    ctx.hostKeypair.secretKey,
  );
  writeFramedBytes(session.writer, replyFrame);
}

/** Two-frame exchange: send req frame A (hello), read reply A, send req frame B (from reply A), read reply B. */
function exchangeHelloThenRpc(
  host: string,
  port: number,
  hello: Uint8Array,
  buildRpc: (helloReply: { host_pubkey?: string; kind?: string }) => Uint8Array,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = makeFrameReader(MAX_ENCRYPTED_FRAME);
    let phase: "hello" | "rpc" = "hello";
    const finish = makeSettler(
      resolve,
      reject,
      timeoutMs,
      "lan-client: rpc timeout",
      "lan-client: connection closed mid-exchange",
    );
    Bun.connect<undefined>({
      hostname: host,
      port,
      socket: {
        open(socket) {
          writeFrame(socket, hello);
        },
        data(socket, chunk) {
          reader.push(chunk);
          let body: Uint8Array | undefined;
          try {
            body = reader.next();
          } catch (e) {
            finish(undefined, e instanceof Error ? e : new Error(String(e)));
            socket.end();
            return;
          }
          if (body === undefined) return;
          if (phase === "hello") {
            let reply: { host_pubkey?: string; kind?: string };
            try {
              reply = JSON.parse(new TextDecoder().decode(body)) as typeof reply;
            } catch {
              finish(undefined, new Error("lan-client: bad hello reply"));
              socket.end();
              return;
            }
            if (reply.kind !== "hello_ok") {
              finish(
                undefined,
                new Error(`lan-client: hello rejected (${replyKindForMessage(reply.kind)})`),
              );
              socket.end();
              return;
            }
            phase = "rpc";
            try {
              writeFrame(socket, buildRpc(reply));
            } catch (e) {
              finish(undefined, e instanceof Error ? e : new Error(String(e)));
              socket.end();
            }
            return;
          }
          // phase === "rpc": resolve before socket.end() — Bun fires close() synchronously
          // inside socket.end(), so settling first prevents the close handler
          // from winning the race with an "undefined body" rejection.
          finish(body);
          socket.end();
        },
        drain(socket) {
          flushWriter(socket);
        },
        close() {
          finish(undefined);
        },
        error(_s, e) {
          finish(undefined, e instanceof Error ? e : new Error(String(e)));
        },
      },
    }).catch((e: unknown) => finish(undefined, e instanceof Error ? e : new Error(String(e))));
  });
}

/** Send one authenticated, encrypted federation RPC to a paired peer over the v1 wire and return its result. */
export async function sendFederatedLegacy(
  host: string,
  port: number,
  selfKp: BoxKeypair,
  peerPubkey: Uint8Array,
  method: string,
  params: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const hello = new TextEncoder().encode(
    JSON.stringify({
      kind: "hello",
      client_pubkey: Buffer.from(selfKp.publicKey).toString("base64"),
    }),
  );
  const replyFrame = await exchangeHelloThenRpc(
    host,
    port,
    hello,
    (reply) => {
      const hostPub = new Uint8Array(Buffer.from(reply.host_pubkey ?? "", "base64"));
      if (hostPub.length !== 32) {
        throw new Error("lan-client: responder sent invalid pubkey length");
      }
      if (Buffer.compare(Buffer.from(hostPub), Buffer.from(peerPubkey)) !== 0) {
        throw new Error("lan-client: responder pubkey does not match pinned peer key");
      }
      return sealBoxFrame(
        new TextEncoder().encode(JSON.stringify({ id: 1, method, params })),
        peerPubkey,
        selfKp.secretKey,
      );
    },
    timeoutMs,
  );
  const plain = openBoxFrame(replyFrame, peerPubkey, selfKp.secretKey);
  const resp = JSON.parse(new TextDecoder().decode(plain)) as {
    result?: unknown;
    error?: { code?: string; message?: string };
  };
  if (resp.error !== undefined) {
    throw new Error(
      `lan-client: peer error ${resp.error.code ?? ""} ${resp.error.message ?? ""}`.trim(),
    );
  }
  return resp.result;
}
