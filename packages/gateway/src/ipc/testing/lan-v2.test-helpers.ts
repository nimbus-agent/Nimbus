/**
 * Test-only: a raw TCP client for the LAN wire that can speak v2 byte by byte, so a test can record,
 * replay, truncate or tamper with any frame. Production clients go through `lan-client.ts`.
 */
import type { BoxKeypair } from "../lan-crypto.ts";
import {
  type LegacyServerContext,
  type LegacySession,
  legacyHandleEncrypted,
  legacyHandleHandshake,
} from "../lan-legacy.ts";
import { HandshakeState, PATTERN_IK } from "../lan-noise.ts";
import {
  createInitiatorHandshake,
  decodeFirstFrame,
  type InitiatorOptions,
  SESSION_PROLOGUE,
  type Session,
} from "../lan-session.ts";
import { buildFrame, makeFrameReader } from "../lan-wire.ts";
import { createQueuedSocketWriter } from "../server/queued-socket-writer.ts";

export interface RawConn {
  /** Every byte received so far, in order (the transcript of the server direction). */
  received(): Uint8Array;
  /** Writes bytes exactly as given (no framing added). */
  write(bytes: Uint8Array): void;
  /** Writes `buildFrame(body)`. */
  writeFrame(body: Uint8Array): void;
  /** Resolves with the next whole frame body, or `undefined` if the socket closes first. */
  nextFrame(timeoutMs?: number): Promise<Uint8Array | undefined>;
  /** Resolves true once the server closed the socket (false after `timeoutMs`). */
  closed(timeoutMs?: number): Promise<boolean>;
  close(): void;
}

export async function connectRaw(port: number): Promise<RawConn> {
  const reader = makeFrameReader(8 * 1024 * 1024);
  let all = new Uint8Array(0);
  let isClosed = false;
  const waiters: Array<() => void> = [];
  const wake = (): void => {
    for (const w of waiters.splice(0)) w();
  };
  let writer: ReturnType<typeof createQueuedSocketWriter> | undefined;
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      drain() {
        writer?.flush();
      },
      data(_s, chunk) {
        const merged = new Uint8Array(all.length + chunk.length);
        merged.set(all, 0);
        merged.set(chunk, all.length);
        all = merged;
        reader.push(chunk);
        wake();
      },
      close() {
        isClosed = true;
        wake();
      },
      error() {
        isClosed = true;
        wake();
      },
    },
  });
  // Bun raw write() drops what the kernel does not take: a multi-record request needs the queue.
  writer = createQueuedSocketWriter(socket);
  const waitForChange = (timeoutMs: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  return {
    received: () => all,
    write: (bytes) => {
      writer?.writeBytes(bytes);
    },
    writeFrame: (body) => {
      writer?.writeBytes(buildFrame(body));
    },
    async nextFrame(timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const frame = reader.next();
        if (frame !== undefined) return frame;
        if (isClosed || Date.now() >= deadline) return undefined;
        await waitForChange(deadline - Date.now());
      }
    },
    async closed(timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!isClosed && Date.now() < deadline) await waitForChange(deadline - Date.now());
      return isClosed;
    },
    close: () => {
      socket.end();
    },
  };
}

export interface V2Exchange {
  conn: RawConn;
  session: Session;
  /** The first frame body that was sent (header and message 1). */
  firstFrameBody: Uint8Array;
  /** The message 2 body that was received. */
  message2: Uint8Array;
}

/** Connects and completes the v2 handshake as `self` towards a server whose static key is `rs`. */
export async function connectV2(
  port: number,
  self: BoxKeypair,
  rs: Uint8Array,
  extra: Partial<Pick<InitiatorOptions, "generateEphemeral">> = {},
): Promise<V2Exchange> {
  const conn = await connectRaw(port);
  const handshake = createInitiatorHandshake({ s: self, rs, ...extra });
  conn.writeFrame(handshake.firstFrameBody);
  const message2 = await conn.nextFrame();
  if (message2 === undefined) throw new Error("test client: no message 2");
  return {
    conn,
    session: handshake.finish(message2),
    firstFrameBody: handshake.firstFrameBody,
    message2,
  };
}

/** Seals and sends one JSON request on an established v2 exchange. Returns the records sent. */
export function sendV2Request(x: V2Exchange, request: object): Uint8Array[] {
  const records = x.session.sealMessage(new TextEncoder().encode(JSON.stringify(request)));
  for (const r of records) x.conn.writeFrame(r);
  return records;
}

/** Reads records until one whole reply message arrives; parses it. */
export async function readV2Reply(
  x: V2Exchange,
  timeoutMs = 3000,
): Promise<{ id?: unknown; result?: unknown; error?: { code?: string; message?: string } }> {
  for (;;) {
    const record = await x.conn.nextFrame(timeoutMs);
    if (record === undefined) throw new Error("test client: connection closed before a reply");
    const message = x.session.openRecord(record);
    if (message !== undefined) return JSON.parse(new TextDecoder().decode(message));
  }
}

export interface StubServer {
  port: number;
  /** Connections accepted so far. */
  connections(): number;
  /** Connections the CLIENT has closed so far. */
  closedByClient(): number;
  stop(): void;
}

/** A hand-rolled TCP server for failure-mode tests: `onFrame` sees every whole frame body. */
export function startStub(
  onFrame: (
    frame: Uint8Array,
    socket: { write(b: Uint8Array): void; end(): void },
    n: number,
  ) => void,
): StubServer {
  let n = 0;
  let closed = 0;
  const server = Bun.listen<{ reader: ReturnType<typeof makeFrameReader>; n: number }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        n += 1;
        socket.data = { reader: makeFrameReader(8 * 1024 * 1024), n };
      },
      close() {
        closed += 1;
      },
      data(socket, chunk) {
        socket.data.reader.push(chunk);
        for (let f = socket.data.reader.next(); f !== undefined; f = socket.data.reader.next()) {
          // A stub handler written for the first frame may choke on the records that follow it.
          try {
            onFrame(
              f,
              {
                write: (b) => {
                  socket.write(buildFrame(b));
                },
                end: () => {
                  socket.end();
                },
              },
              socket.data.n,
            );
          } catch {
            /* ignore */
          }
        }
      },
    },
  });
  return {
    port: server.port,
    connections: () => n,
    closedByClient: () => closed,
    stop: () => server.stop(true),
  };
}

/** An OLD server: only the v1 handlers, so a v2 first frame is non-JSON and closes without a reply. */
export function startLegacyOnlyServer(ctx: LegacyServerContext): StubServer {
  interface State extends LegacySession {
    reader: ReturnType<typeof makeFrameReader>;
    n: number;
  }
  let n = 0;
  const server = Bun.listen<State>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        n += 1;
        socket.data = {
          peerIp: socket.remoteAddress,
          writer: createQueuedSocketWriter(socket),
          reader: makeFrameReader(8 * 1024 * 1024),
          n,
        };
      },
      drain(socket) {
        socket.data.writer.flush();
      },
      async data(socket, chunk) {
        socket.data.reader.push(chunk);
        for (let f = socket.data.reader.next(); f !== undefined; f = socket.data.reader.next()) {
          if (socket.data.writer.isEnding()) return;
          if (socket.data.peerPubkey) await legacyHandleEncrypted(socket.data, ctx, f);
          else legacyHandleHandshake(socket.data, ctx, f);
        }
      },
    },
  });
  return {
    port: server.port,
    connections: () => n,
    closedByClient: () => 0,
    stop: () => server.stop(true),
  };
}

/**
 * The static public key an initiator presented in a v2 first frame, read by a test responder that
 * holds `responder`'s static key. It reads the key even when the handshake cannot COMPLETE (an
 * initiator whose identity is not a consistent key pair, or the all-zero fallback identity, fails the
 * `ss` step after the key was decrypted): that is exactly what an identity-presentation test needs.
 */
export function presentedStaticKey(
  firstFrameBody: Uint8Array,
  responder: BoxKeypair,
): Uint8Array | undefined {
  const message1 = decodeFirstFrame(firstFrameBody);
  if (message1 === undefined) return undefined;
  const hs = new HandshakeState({
    pattern: PATTERN_IK,
    initiator: false,
    prologue: SESSION_PROLOGUE,
    s: responder,
  });
  try {
    hs.readMessage(message1);
  } catch {
    /* a failed tail step still leaves the decrypted static key behind */
  }
  try {
    return hs.remoteStatic();
  } catch {
    return undefined;
  }
}
