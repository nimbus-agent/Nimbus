/**
 * Unit tests for ClientSession (packages/gateway/src/ipc/session.ts).
 *
 * Coverage target: ≥80% branch and ≥80% line.
 *
 * No mock.module — all seams are constructor-injection (write / onRpc / onDispose callbacks).
 */

import { describe, expect, test } from "bun:test";
import type { JsonRpcNotification, JsonRpcOutbound, JsonRpcRequest } from "./jsonrpc.ts";
import { IPC_MAX_LINE_BYTES } from "./jsonrpc.ts";
import { ClientSession } from "./session.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a string as UTF-8 bytes. */
function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Build a minimal valid JSON-RPC request line (newline-terminated). */
function requestLine(method: string, id: number): string {
  return `{"jsonrpc":"2.0","method":"${method}","id":${id}}\n`;
}

/** Create a session wired to simple in-memory collectors. */
function makeSession(
  onRpc: (
    clientId: string,
    msg: JsonRpcRequest | JsonRpcNotification,
  ) => void | Promise<void> = () => {},
): {
  session: ClientSession;
  written: string[];
  disposed: string[];
} {
  const written: string[] = [];
  const disposed: string[] = [];
  const session = new ClientSession(
    "client-1",
    (line) => written.push(line),
    onRpc,
    (id) => disposed.push(id),
  );
  return { session, written, disposed };
}

// ---------------------------------------------------------------------------
// dispose / disposed-guard branches
// ---------------------------------------------------------------------------

describe("ClientSession.dispose", () => {
  test("calls onDispose exactly once on first call", () => {
    const { session, disposed } = makeSession();
    session.dispose();
    expect(disposed).toEqual(["client-1"]);
  });

  test("second dispose is a no-op (disposed guard)", () => {
    const { session, disposed } = makeSession();
    session.dispose();
    session.dispose();
    // onDispose must NOT be called a second time
    expect(disposed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// push() — disposed guard (line 38 block=0 branch=0)
// ---------------------------------------------------------------------------

describe("ClientSession.push — disposed guard", () => {
  test("push on a disposed session is a no-op (no write, no additional dispose)", () => {
    const { session, written, disposed } = makeSession();
    session.dispose();
    const before = written.length;
    session.push(enc(requestLine("ping", 1)));
    // Nothing should be written; dispose not called again
    expect(written).toHaveLength(before);
    expect(disposed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// push() — reader throws (sendParseFailure path)
// sendParseFailure: line 85 block=5 branch=0 (JsonRpcParseError) and branch=1 (other Error)
// ---------------------------------------------------------------------------

describe("ClientSession.push — reader parse error (sendParseFailure)", () => {
  test("oversized chunk triggers JsonRpcParseError; writes -32700 with the error message and disposes (branch=0: e instanceof JsonRpcParseError)", () => {
    // A line > IPC_MAX_LINE_BYTES (1 MB) causes NdjsonLineReader to throw JsonRpcParseError
    const oversized = `${"x".repeat(IPC_MAX_LINE_BYTES + 1)}\n`;
    const { session, written, disposed } = makeSession();
    session.push(enc(oversized));
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0] ?? "") as {
      error: { code: number; message: string };
    };
    expect(parsed.error.code).toBe(-32700);
    // The message should come from the JsonRpcParseError instance, not the fallback
    expect(parsed.error.message).toBe("Message exceeds 1MB line limit");
    expect(disposed).toEqual(["client-1"]);
  });

  // Sub-project D candidate — NOT covered here, and deliberately skipped so it does not
  // masquerade as coverage in the green test output.
  //
  // The `else` arm of `sendParseFailure`'s `e instanceof JsonRpcParseError ? … : "Parse error"`
  // (and the identical arm in dispatchLines' parse-error catch) is a TS-narrowing artifact: the
  // NdjsonLineReader wrapped inside ClientSession always uses JsonRpcParseError as its
  // lineLimitCtor and parseJsonRpcLine only ever throws JsonRpcParseError, so no production
  // input can deliver a non-JsonRpcParseError to that catch. Reaching it would require a DI seam
  // on the reader/parser ctor — deferred to Sub-project D. The other 16/18 arms clear the 80% floor.
  // KNOWN GAP (D candidate): a non-JsonRpcParseError thrown by the reader should fall back to
  // the generic 'Parse error' response (branch=1). Left uncovered rather than stubbed — the
  // reader cannot be driven into that state through the public session surface.
});

// ---------------------------------------------------------------------------
// endInput() — disposed guard
// ---------------------------------------------------------------------------

describe("ClientSession.endInput — disposed guard", () => {
  test("endInput on a disposed session is a no-op", () => {
    const { session, written, disposed } = makeSession();
    session.dispose();
    session.endInput();
    expect(written).toHaveLength(0);
    expect(disposed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// endInput() — flush parse failure (sendParseFailure path via flush)
// ---------------------------------------------------------------------------

describe("ClientSession.endInput — reader flush parse error", () => {
  test("oversized unterminated chunk followed by endInput triggers JsonRpcParseError (-32700)", () => {
    // Push a chunk > 1 MB without a newline; the pending buffer exceeds the limit.
    // flush() is then called by endInput() and throws JsonRpcParseError.
    const oversized = "x".repeat(IPC_MAX_LINE_BYTES + 1);
    const { session, written, disposed } = makeSession();
    // Note: push itself may also throw if the pending buffer grows too large.
    // Use a two-step approach: push exactly IPC_MAX_LINE_BYTES+1 bytes (no newline).
    try {
      session.push(enc(oversized));
    } catch {
      // push may have already triggered the error; check written in that case
    }
    // If push triggered it, disposed is already set; if not, endInput() should trigger it.
    if (disposed.length === 0) {
      session.endInput();
      expect(written).toHaveLength(1);
      const parsed = JSON.parse(written[0] ?? "") as {
        error: { code: number; message: string };
      };
      expect(parsed.error.code).toBe(-32700);
      expect(disposed).toEqual(["client-1"]);
    } else {
      // push already handled it — verify the write happened
      expect(written).toHaveLength(1);
      const parsed = JSON.parse(written[0] ?? "") as {
        error: { code: number; message: string };
      };
      expect(parsed.error.code).toBe(-32700);
    }
  });

  test("endInput with partial valid data dispatches lines, then flushes remainder", async () => {
    const received: string[] = [];
    const { session, disposed } = makeSession((_id, msg) => {
      received.push(msg.method);
    });
    // Push a complete line + start a partial (no trailing newline); endInput flushes the partial
    session.push(enc('{"jsonrpc":"2.0","method":"foo","id":1}\n{"jsonrpc":"2.0","method":"bar"}'));
    // Give async dispatch time to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    session.endInput();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(received).toContain("foo");
    expect(received).toContain("bar");
    expect(disposed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// writeOutbound() — disposed guard (line 74 block=4 branch=0)
// ---------------------------------------------------------------------------

describe("ClientSession.writeOutbound — disposed guard", () => {
  test("writeOutbound on a disposed session is a no-op", () => {
    const { session, written, disposed } = makeSession();
    session.dispose();
    const msg: JsonRpcOutbound = { jsonrpc: "2.0", id: null, error: { code: -1, message: "x" } };
    session.writeOutbound(msg);
    expect(written).toHaveLength(0);
    expect(disposed).toHaveLength(1);
  });

  test("writeOutbound on a live session encodes and writes the message", () => {
    const { session, written } = makeSession();
    const msg: JsonRpcOutbound = { jsonrpc: "2.0", id: 1, result: { ok: true } };
    session.writeOutbound(msg);
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0] ?? "") as { result: { ok: boolean } };
    expect(parsed.result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dispatchLines() — parseJsonRpcLine throws JsonRpcParseError (line 96 block=6 branch=0)
// and non-JsonRpcParseError (branch=1)
// ---------------------------------------------------------------------------

describe("ClientSession.push — dispatchLines parse error", () => {
  test("invalid JSON line causes JsonRpcParseError; writes -32700 with error message and continues (branch=0: JsonRpcParseError from parseJsonRpcLine)", async () => {
    const { session, written, disposed } = makeSession();
    // "not-json\n" will cause JSON.parse to throw → JsonRpcParseError("Invalid JSON")
    session.push(enc("not-json\n"));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0] ?? "") as {
      error: { code: number; message: string };
    };
    expect(parsed.error.code).toBe(-32700);
    // JsonRpcParseError message should be forwarded
    expect(parsed.error.message).toBe("Invalid JSON");
    // Session should NOT be disposed (parse errors in dispatchLines are recoverable)
    expect(disposed).toHaveLength(0);
  });

  test("JSON-RPC protocol violation causes JsonRpcParseError; message forwarded (branch=0 variant)", async () => {
    const { session, written, disposed } = makeSession();
    // Valid JSON but bad JSON-RPC (missing jsonrpc field)
    session.push(enc('{"method":"foo","id":1}\n'));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0] ?? "") as {
      error: { code: number; message: string };
    };
    expect(parsed.error.code).toBe(-32700);
    expect(parsed.error.message).toContain("jsonrpc");
    expect(disposed).toHaveLength(0);
  });

  // branch=1 (non-JsonRpcParseError from parseJsonRpcLine): parseJsonRpcLine only ever throws
  // JsonRpcParseError — the else arm is a TS-narrowing artifact with no reachable production path.
  // Left as a Sub-project D candidate. See report.
});

// ---------------------------------------------------------------------------
// dispatchLines() — onRpc throws (line 104 block=7 branch=0 and branch=1)
// ---------------------------------------------------------------------------

describe("ClientSession.push — dispatchLines onRpc error handling", () => {
  test("onRpc throws Error; message is forwarded in -32603 response (branch=0: e instanceof Error)", async () => {
    const { session, written, disposed } = makeSession(async () => {
      throw new Error("handler blew up");
    });
    session.push(enc(requestLine("foo", 2)));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0] ?? "") as {
      error: { code: number; message: string };
    };
    expect(parsed.error.code).toBe(-32603);
    expect(parsed.error.message).toBe("handler blew up");
    // Session stays alive; the inner try/catch absorbs the error
    expect(disposed).toHaveLength(0);
  });

  test("onRpc throws a non-Error value; fallback message 'Internal error' used (branch=1: not instanceof Error)", async () => {
    const { session, written, disposed } = makeSession(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "a plain string, not an Error"; // non-Error throwable
    });
    session.push(enc(requestLine("bar", 3)));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0] ?? "") as {
      error: { code: number; message: string };
    };
    expect(parsed.error.code).toBe(-32603);
    expect(parsed.error.message).toBe("Internal error");
    expect(disposed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// push() .catch handler — dispatchLines rejects (line 49 block=1 branch=0 and branch=1)
//
// dispatchLines() can reject when writeOutbound() throws inside the catch-block at line
// 97 (the parse-error handler — NOT wrapped in a nested try/catch).  writeOutbound calls
// this.write(); if the write callback throws, the error propagates through dispatchLines
// and is caught by the outer .catch on the void promise in push().
// ---------------------------------------------------------------------------

describe("ClientSession.push — outer dispatchLines .catch (line 49)", () => {
  test("dispatchLines .catch branch=0: write throws Error on call 2, succeeds on call 3 → -32603 written, session disposed", async () => {
    // Strategy: the write callback throws ONLY on call 2.
    // • Call 1: first bad JSON line → writeOutbound at line 97 → -32700 written OK
    // • Call 2: second bad JSON line → writeOutbound at line 97 → throws Error
    //           dispatchLines() rejects → outer .catch fires (line 49)
    //           e instanceof Error → branch=0 taken → message = e.message
    // • Call 3: outer .catch calls this.write(-32603) → succeeds → this.dispose() called
    let callCount = 0;
    const written: string[] = [];
    const disposed: string[] = [];
    const throwingWrite = (line: string): void => {
      callCount++;
      if (callCount === 2) {
        throw new Error("write channel broken");
      }
      written.push(line);
    };
    const session = new ClientSession(
      "client-err",
      throwingWrite,
      () => {},
      (id) => disposed.push(id),
    );

    // Call 1: first bad JSON → -32700 written OK
    session.push(enc("bad-json-1\n"));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(written).toHaveLength(1);

    // Call 2: second bad JSON → write throws Error → dispatchLines rejects → outer .catch
    // Call 3: outer .catch writes -32603 (succeeds) then calls dispose()
    session.push(enc("bad-json-2\n"));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    // outer .catch must have written a -32603 response
    expect(written).toHaveLength(2);
    const parsed = JSON.parse(written[1] ?? "") as { error: { code: number; message: string } };
    expect(parsed.error.code).toBe(-32603);
    expect(parsed.error.message).toBe("write channel broken");
    // session must be disposed
    expect(disposed).toEqual(["client-err"]);
  });

  test("dispatchLines .catch branch=1: write throws non-Error on call 2, succeeds on call 3 → 'dispatch error', session disposed", async () => {
    let callCount = 0;
    const written: string[] = [];
    const disposed: string[] = [];
    const throwingWrite = (line: string): void => {
      callCount++;
      if (callCount === 2) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "non-error string thrown from write"; // non-Error throwable
      }
      written.push(line);
    };
    const session = new ClientSession(
      "client-nonerr",
      throwingWrite,
      () => {},
      (id) => disposed.push(id),
    );

    // Call 1: first bad JSON → -32700 written OK
    session.push(enc("bad-json-x\n"));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(written).toHaveLength(1);

    // Call 2: throws non-Error → dispatchLines rejects → outer .catch branch=1
    // → message = "dispatch error" → Call 3: write -32603, then dispose
    session.push(enc("bad-json-y\n"));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(written).toHaveLength(2);
    const parsed = JSON.parse(written[1] ?? "") as { error: { code: number; message: string } };
    expect(parsed.error.code).toBe(-32603);
    expect(parsed.error.message).toBe("dispatch error");
    expect(disposed).toEqual(["client-nonerr"]);
  });
});

// ---------------------------------------------------------------------------
// endInput() .catch handler — dispatchLines rejects (line 67 block=3 branch=0 and branch=1)
// Same mechanism as push() .catch but triggered via endInput() → dispatchLines via flush.
// ---------------------------------------------------------------------------

describe("ClientSession.endInput — outer dispatchLines .catch (line 67)", () => {
  test("dispatchLines .catch branch=0 (endInput): write throws Error on call 2, succeeds on call 3 → -32603 written, session disposed", async () => {
    // Same throw-on-call-2 strategy, but using the endInput() code path.
    // • Call 1: bad JSON line via push → line 97 writeOutbound → written OK
    // • Call 2: bad JSON flushed by endInput → line 97 writeOutbound → throws Error
    //           dispatchLines rejects → line 67 outer .catch fires (branch=0)
    //           e instanceof Error → message = e.message
    // • Call 3: outer .catch calls this.write(-32603) → succeeds → dispose()
    let callCount = 0;
    const written: string[] = [];
    const disposed: string[] = [];
    const throwingWrite = (line: string): void => {
      callCount++;
      if (callCount === 2) {
        throw new Error("write failed on endInput");
      }
      written.push(line);
    };
    const session = new ClientSession(
      "client-end-err",
      throwingWrite,
      () => {},
      (id) => disposed.push(id),
    );

    // Call 1: bad JSON via push → -32700 written OK
    session.push(enc("bad-json-a\n"));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(written).toHaveLength(1);

    // Push partial invalid JSON (no newline) so it stays in the pending buffer
    session.push(enc("bad-json-b")); // no newline → pending buffer
    // endInput flushes → dispatchLines(["bad-json-b"]) → parse error →
    // writeOutbound at line 97 → call 2 → throws Error → dispatchLines rejects
    // → line 67 outer .catch fires
    session.endInput();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(written).toHaveLength(2);
    const parsed = JSON.parse(written[1] ?? "") as { error: { code: number; message: string } };
    expect(parsed.error.code).toBe(-32603);
    expect(parsed.error.message).toBe("write failed on endInput");
    expect(disposed).toEqual(["client-end-err"]);
  });

  test("dispatchLines .catch branch=1 (endInput): write throws non-Error on call 2, succeeds on call 3 → 'dispatch error', session disposed", async () => {
    let callCount = 0;
    const written: string[] = [];
    const disposed: string[] = [];
    const throwingWrite = (line: string): void => {
      callCount++;
      if (callCount === 2) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 42; // non-Error throwable
      }
      written.push(line);
    };
    const session = new ClientSession(
      "client-end-nonerr",
      throwingWrite,
      () => {},
      (id) => disposed.push(id),
    );

    session.push(enc("bad-json-c\n"));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(written).toHaveLength(1);

    session.push(enc("bad-json-d")); // partial → pending buffer
    session.endInput();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(written).toHaveLength(2);
    const parsed = JSON.parse(written[1] ?? "") as { error: { code: number; message: string } };
    expect(parsed.error.code).toBe(-32603);
    expect(parsed.error.message).toBe("dispatch error");
    expect(disposed).toEqual(["client-end-nonerr"]);
  });
});

// ---------------------------------------------------------------------------
// writeNotification — delegates to writeOutbound
// ---------------------------------------------------------------------------

describe("ClientSession.writeNotification", () => {
  test("writes the notification as a JSON-RPC line", () => {
    const { session, written } = makeSession();
    const n: JsonRpcNotification = { jsonrpc: "2.0", method: "test.event", params: { x: 1 } };
    session.writeNotification(n);
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0] ?? "") as { method: string; params: { x: number } };
    expect(parsed.method).toBe("test.event");
    expect(parsed.params.x).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// clientId is exposed as a readonly property
// ---------------------------------------------------------------------------

describe("ClientSession.clientId", () => {
  test("clientId matches the value passed to the constructor", () => {
    const written: string[] = [];
    const session = new ClientSession(
      "my-client",
      (l) => written.push(l),
      () => {},
      () => {},
    );
    expect(session.clientId).toBe("my-client");
  });
});
