/**
 * `ClientSession` arms `session.test.ts` does not reach deterministically:
 *  - the end-of-stream flush itself overflowing the line limit (not the push before it),
 *  - a chunk the decoder cannot read at all, and
 *  - the error path when reporting a failed request ALSO fails because the write channel is gone.
 *
 * No sleeps: the first two are synchronous, and the third yields ONE zero-delay macrotask, which is
 * enough because the whole dispatch it waits on (handler rejection -> failed error reply -> dispose)
 * settles on microtasks.
 */
import { describe, expect, test } from "bun:test";

import { IPC_MAX_LINE_BYTES } from "./jsonrpc.ts";
import { ClientSession } from "./session.ts";

type ErrorLine = { jsonrpc: string; id: null; error: { code: number; message: string } };

function collectingSession(): { session: ClientSession; written: string[]; disposed: string[] } {
  const written: string[] = [];
  const disposed: string[] = [];
  const session = new ClientSession(
    "client-cov",
    (line) => written.push(line),
    () => {},
    (id) => disposed.push(id),
  );
  return { session, written, disposed };
}

describe("ClientSession.endInput — the final flush overflows the line limit", () => {
  test("a buffer exactly AT the limit plus a split UTF-8 sequence overflows only at end-of-input", () => {
    const { session, written, disposed } = collectingSession();
    // `push` measures what it has DECODED: exactly IPC_MAX_LINE_BYTES of ASCII is allowed, and the
    // first two bytes of the three-byte "€" (E2 82 AC) stay inside the streaming decoder, counted
    // nowhere. Only the end-of-input flush turns them into U+FFFD (three more bytes) — so the
    // overflow is raised by `flush()`, which is the arm under test, not by the push before it.
    const ascii = new TextEncoder().encode("x".repeat(IPC_MAX_LINE_BYTES));
    const chunk = new Uint8Array(ascii.length + 2);
    chunk.set(ascii);
    chunk.set([0xe2, 0x82], ascii.length);

    session.push(chunk);
    expect(written).toEqual([]);
    expect(disposed).toEqual([]);

    session.endInput();
    expect(written).toHaveLength(1);
    const reply = JSON.parse(written[0] ?? "") as ErrorLine;
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Message exceeds 1MB line limit" },
    });
    expect(disposed).toEqual(["client-cov"]);

    // Terminal: the disposed session neither reads nor answers anything further.
    session.push(new TextEncoder().encode('{"jsonrpc":"2.0","method":"late","id":9}\n'));
    session.endInput();
    expect(written).toHaveLength(1);
    expect(disposed).toEqual(["client-cov"]);
  });
});

describe("ClientSession.push — a chunk the decoder cannot read", () => {
  test("answers a generic -32700 'Parse error' and disposes, rather than throwing into the socket handler", () => {
    const { session, written, disposed } = collectingSession();
    // Not a BufferSource at all. The socket layer only ever hands over bytes, but `push` runs inside
    // a data callback where an escaping throw would take the listener down with it.
    expect(() => session.push("not-bytes" as unknown as Uint8Array)).not.toThrow();
    expect(written).toHaveLength(1);
    const reply = JSON.parse(written[0] ?? "") as ErrorLine;
    // The generic text, NOT a line-limit message: this was never a JsonRpcParseError.
    expect(reply.error).toEqual({ code: -32700, message: "Parse error" });
    expect(reply.error.message).not.toContain("1MB");
    expect(disposed).toEqual(["client-cov"]);
  });
});

describe("ClientSession — a handler error whose error reply cannot be written", () => {
  test("disposes the session instead of letting the write failure escape as an unhandled rejection", async () => {
    let writes = 0;
    const disposals: string[] = [];
    const session = new ClientSession(
      "client-broken-pipe",
      () => {
        writes += 1;
        throw new Error("EPIPE: the client went away");
      },
      async () => {
        throw new Error("handler failed");
      },
      (id) => disposals.push(id),
    );

    session.push(new TextEncoder().encode('{"jsonrpc":"2.0","method":"tool.run","id":1}\n'));
    // The whole dispatch (handler rejection -> failed error reply -> dispose) runs on microtasks,
    // so one zero-delay macrotask is enough for it to have settled either way.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // Exactly one attempt to report the handler failure, and exactly one disposal.
    expect(writes).toBe(1);
    expect(disposals).toEqual(["client-broken-pipe"]);

    // Disposed sessions write nothing further (the write channel is not even attempted again).
    session.writeNotification({ jsonrpc: "2.0", method: "engine.streamToken" });
    expect(writes).toBe(1);
  });
});
