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
  /** Half-closes the socket. Needed only by callers that use the writer's `end()`. */
  end?(): void;
};

export type QueuedSocketWriter = {
  /** Sends `line` (UTF-8) in full, now or on a later `flush()`. */
  write(line: string): void;
  /** Sends `bytes` in full, now or on a later `flush()`. The caller must not mutate them afterwards. */
  writeBytes(bytes: Uint8Array): void;
  /**
   * Ends the socket once everything queued has been sent. Calling `socket.end()` directly after a
   * write would discard whatever is still queued; this defers the end to the flush that empties it.
   */
  end(): void;
  /**
   * True once `end()` was called or the peer is gone. A reader that keeps parsing after a terminal
   * decision must check this: the socket stays open until the queue drains, so input can still arrive.
   */
  isEnding(): boolean;
  /** Call from the socket's `drain` handler. */
  flush(): void;
  /** Bytes accepted by a write but not yet taken by the socket. */
  pendingBytes(): number;
};

const encoder = new TextEncoder();

export function createQueuedSocketWriter(socket: RawWritableSocket): QueuedSocketWriter {
  const queue: Uint8Array[] = [];
  let closed = false;
  let endRequested = false;

  const endNow = (): void => {
    closed = true;
    socket.end?.();
  };

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
    if (!closed && endRequested) endNow();
  };

  const enqueue = (bytes: Uint8Array): void => {
    if (closed || endRequested || bytes.byteLength === 0) return;
    queue.push(bytes);
    // Only the head may be written: later bytes written past a stalled chunk would interleave.
    if (queue.length === 1) drainQueue();
  };

  return {
    write(line: string): void {
      enqueue(encoder.encode(line));
    },
    writeBytes: enqueue,
    end(): void {
      if (closed || endRequested) return;
      endRequested = true;
      if (queue.length === 0) endNow();
    },
    isEnding(): boolean {
      return closed || endRequested;
    },
    flush: drainQueue,
    pendingBytes(): number {
      let total = 0;
      for (const chunk of queue) total += chunk.byteLength;
      return total;
    },
  };
}
