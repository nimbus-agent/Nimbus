/**
 * Test-only: a raw TCP client for the LAN wire that can speak v2 byte by byte, so a test can record,
 * replay, truncate or tamper with any frame. Production clients go through `lan-client.ts`.
 */
import type { BoxKeypair } from "./lan-crypto.ts";
import { createInitiatorHandshake, type InitiatorOptions, type Session } from "./lan-session.ts";
import { buildFrame, makeFrameReader } from "./lan-wire.ts";
import { createQueuedSocketWriter } from "./server/queued-socket-writer.ts";

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
