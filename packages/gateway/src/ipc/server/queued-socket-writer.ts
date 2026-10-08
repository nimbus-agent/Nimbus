/**
 * A write path for a `Bun.listen` socket that never drops bytes.
 *
 * Bun's raw socket `write()` is NOT buffered: it returns how many bytes the kernel accepted right
 * now, and whatever it did not accept is simply not sent. A caller that ignores the return value
 * loses the tail of every write larger than the free space in the socket's send buffer. That was
 * the IPC server's behaviour, and it went unnoticed because Linux gives a Unix socket a send buffer
 * of a few hundred KiB while macOS gives it 8 KiB: on macOS a large reply (`diag.snapshot`, the one
 * `nimbus doctor` reads) arrived truncated, without its terminating newline, so the client waited
 * out its whole timeout for a response the gateway believed it had sent.
 *
 * This queues what was not accepted and finishes it from the socket's `drain` handler, in order.
 * Lines are encoded to bytes BEFORE writing, because the count `write()` returns is in bytes and
 * slicing the original string by it would cut through a multi-byte character.
 */
export type RawWritableSocket = {
  /** Bytes accepted, or a negative number when the socket is closed. */
  write(data: Uint8Array): number;
};

export type QueuedSocketWriter = {
  /** Sends `line` in full, now or on a later `flush()`. */
  write(line: string): void;
  /** Call from the socket's `drain` handler. */
  flush(): void;
  /** Bytes accepted by `write()` but not yet taken by the socket. */
  pendingBytes(): number;
};

const encoder = new TextEncoder();

export function createQueuedSocketWriter(socket: RawWritableSocket): QueuedSocketWriter {
  const queue: Uint8Array[] = [];
  let closed = false;

  /** Writes from the head of the queue until it is empty or the socket stops accepting. */
  const drainQueue = (): void => {
    while (!closed && queue.length > 0) {
      const head = queue[0] as Uint8Array;
      const n = socket.write(head);
      if (n < 0) {
        // The peer is gone; nothing queued can ever be delivered.
        closed = true;
        queue.length = 0;
        return;
      }
      if (n < head.byteLength) {
        queue[0] = head.subarray(n);
        return;
      }
      queue.shift();
    }
  };

  return {
    write(line: string): void {
      if (closed) return;
      queue.push(encoder.encode(line));
      // Only the head may be written: a later line written past a stalled one would interleave.
      if (queue.length === 1) drainQueue();
    },
    flush: drainQueue,
    pendingBytes(): number {
      let total = 0;
      for (const chunk of queue) total += chunk.byteLength;
      return total;
    },
  };
}
