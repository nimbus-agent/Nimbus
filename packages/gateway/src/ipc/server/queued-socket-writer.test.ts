import { describe, expect, test } from "bun:test";

import { createQueuedSocketWriter, type RawWritableSocket } from "./queued-socket-writer.ts";

/** A socket that accepts at most `capacity` bytes per `write`, like a full kernel send buffer. */
function partialSocket(
  capacity: number,
): RawWritableSocket & { received: number[]; closed: boolean } {
  const received: number[] = [];
  const sock = {
    received,
    closed: false,
    write(data: Uint8Array): number {
      if (sock.closed) return -1;
      const n = Math.min(capacity, data.byteLength);
      for (let i = 0; i < n; i++) received.push(data[i] as number);
      return n;
    },
  };
  return sock;
}

const decode = (bytes: number[]): string => new TextDecoder().decode(new Uint8Array(bytes));

describe("createQueuedSocketWriter", () => {
  test("a write larger than the socket accepts is finished by flush, not dropped", () => {
    const sock = partialSocket(8);
    const w = createQueuedSocketWriter(sock);
    const line = `${"x".repeat(50)}\n`;
    w.write(line);
    expect(sock.received.length).toBe(8);
    expect(w.pendingBytes()).toBe(43);
    while (w.pendingBytes() > 0) w.flush();
    expect(decode(sock.received)).toBe(line);
  });

  test("lines stay in order: a later line never overtakes a stalled one", () => {
    const sock = partialSocket(5);
    const w = createQueuedSocketWriter(sock);
    w.write("first-line\n");
    w.write("second\n");
    // The second write must not have reached the socket while the first is unfinished.
    expect(decode(sock.received)).toBe("first");
    while (w.pendingBytes() > 0) w.flush();
    expect(decode(sock.received)).toBe("first-line\nsecond\n");
  });

  test("slices by BYTES, so a multi-byte character split across writes arrives intact", () => {
    const sock = partialSocket(3);
    const w = createQueuedSocketWriter(sock);
    const line = "héllo — ✓ 日本\n";
    w.write(line);
    while (w.pendingBytes() > 0) w.flush();
    expect(decode(sock.received)).toBe(line);
  });

  test("a closed socket drops the queue and later writes are no-ops", () => {
    const sock = partialSocket(4);
    const w = createQueuedSocketWriter(sock);
    w.write("abcdefgh");
    sock.closed = true;
    w.flush();
    expect(w.pendingBytes()).toBe(0);
    w.write("more");
    expect(w.pendingBytes()).toBe(0);
    expect(decode(sock.received)).toBe("abcd");
  });

  test("a socket that accepts everything leaves nothing pending", () => {
    const sock = partialSocket(1 << 20);
    const w = createQueuedSocketWriter(sock);
    w.write("small\n");
    expect(w.pendingBytes()).toBe(0);
    expect(decode(sock.received)).toBe("small\n");
  });
});
