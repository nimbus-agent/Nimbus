import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IPCClient, idKey, jsonRpcErrorMessage, tryParseJsonRecord } from "../src/ipc-transport.ts";

const isWin = process.platform === "win32";

// Socket-free internal tests never connect, so this path is only a constructor argument; build it
// cross-platform via tmpdir() rather than a hardcoded POSIX literal.
const INTERNAL_FAKE_PATH = join(tmpdir(), "nimbus-ipc-internal.sock");

let tmp: string;
let socketPath: string;
let server: ReturnType<typeof Bun.listen> | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-ipc-"));
  socketPath = join(tmp, "gw.sock");
});
afterEach(() => {
  server?.stop(true);
  server = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

function startServer(respond: (line: string, write: (s: string) => void) => void): void {
  server = Bun.listen({
    unix: socketPath,
    socket: {
      data(sock, chunk) {
        const write = (s: string): void => {
          (sock as unknown as { write: (s: string) => void }).write(s);
        };
        for (const line of new TextDecoder().decode(chunk).split("\n")) {
          if (line.trim().length > 0) respond(line, write);
        }
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Pure helper: idKey
// ---------------------------------------------------------------------------

describe("idKey", () => {
  test("number id returns n: prefix", () => {
    expect(idKey(42)).toBe("n:42");
  });

  test("string id returns s: prefix", () => {
    expect(idKey("abc-123")).toBe("s:abc-123");
  });
});

// ---------------------------------------------------------------------------
// Pure helper: jsonRpcErrorMessage
// ---------------------------------------------------------------------------

describe("jsonRpcErrorMessage", () => {
  test("returns default for a primitive (number)", () => {
    expect(jsonRpcErrorMessage(404)).toBe("JSON-RPC error");
  });

  test("returns default for null", () => {
    expect(jsonRpcErrorMessage(null)).toBe("JSON-RPC error");
  });

  test("returns default for a string primitive", () => {
    expect(jsonRpcErrorMessage("raw string")).toBe("JSON-RPC error");
  });

  test("returns default for object without message key", () => {
    expect(jsonRpcErrorMessage({ code: -32600 })).toBe("JSON-RPC error");
  });

  test("returns default when message is a non-string (number)", () => {
    expect(jsonRpcErrorMessage({ message: 99 })).toBe("JSON-RPC error");
  });

  test("returns default when message is null", () => {
    expect(jsonRpcErrorMessage({ message: null })).toBe("JSON-RPC error");
  });

  test("returns the message string when present", () => {
    expect(jsonRpcErrorMessage({ message: "something went wrong" })).toBe("something went wrong");
  });
});

// ---------------------------------------------------------------------------
// Pure helper: tryParseJsonRecord
// ---------------------------------------------------------------------------

describe("tryParseJsonRecord", () => {
  test("returns parsed object for valid JSON", () => {
    expect(tryParseJsonRecord('{"key":"val"}')).toEqual({ key: "val" });
  });

  test("returns undefined for invalid JSON (catch arm)", () => {
    expect(tryParseJsonRecord("{not valid json!")).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(tryParseJsonRecord("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// IPCClient — existing socket-free tests
// ---------------------------------------------------------------------------

describe("IPCClient", () => {
  test("call() throws when not connected", async () => {
    const c = new IPCClient(socketPath);
    await expect(c.call("x", {})).rejects.toThrow(/not connected/);
  });

  test.skipIf(isWin)("resolves a matching JSON-RPC response", async () => {
    startServer((line, write) => {
      const req = JSON.parse(line) as { id: string; method: string };
      write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { echoed: req.method } })}\n`);
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    expect(await c.call("ping", { a: 1 })).toEqual({ echoed: "ping" });
    await c.disconnect();
  });

  test.skipIf(isWin)("resolves with undefined result when response has no result key", async () => {
    startServer((line, write) => {
      const req = JSON.parse(line) as { id: string };
      // Deliberately omit "result" — exercises the `hasOwn(o, "result") ? o.result : undefined` branch
      write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id })}\n`);
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    const result = await c.call<unknown>("no-result", {});
    expect(result).toBeUndefined();
    await c.disconnect();
  });

  test.skipIf(isWin)("rejects on a JSON-RPC error response", async () => {
    startServer((line, write) => {
      const req = JSON.parse(line) as { id: string };
      write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { message: "boom" } })}\n`);
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    await expect(c.call("x", {})).rejects.toThrow("boom");
    await c.disconnect();
  });

  test.skipIf(isWin)("rejects with default message when error has no message field", async () => {
    startServer((line, write) => {
      const req = JSON.parse(line) as { id: string };
      // error object without a `message` key → falls through to "JSON-RPC error"
      write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32600 } })}\n`);
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    await expect(c.call("bad-err", {})).rejects.toThrow("JSON-RPC error");
    await c.disconnect();
  });

  test.skipIf(isWin)("dispatches notifications to onNotification handlers", async () => {
    startServer((line, write) => {
      const req = JSON.parse(line) as { id: string };
      write(`${JSON.stringify({ jsonrpc: "2.0", method: "evt.ping", params: { n: 1 } })}\n`);
      write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: null })}\n`);
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    const seen: unknown[] = [];
    c.onNotification("evt.ping", (p) => seen.push(p));
    await c.call("trigger", {});
    expect(seen).toEqual([{ n: 1 }]);
    await c.disconnect();
  });

  test.skipIf(isWin)("dispatches notifications without params (no params key)", async () => {
    startServer((line, write) => {
      const req = JSON.parse(line) as { id: string };
      // notification without params key
      write(`${JSON.stringify({ jsonrpc: "2.0", method: "evt.noparams" })}\n`);
      write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: null })}\n`);
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    const seen: unknown[] = [];
    c.onNotification("evt.noparams", (p) => seen.push(p));
    await c.call("trigger", {});
    expect(seen).toEqual([undefined]);
    await c.disconnect();
  });

  test.skipIf(isWin)(
    "second onNotification handler on same method is added to existing set",
    async () => {
      startServer((line, write) => {
        const req = JSON.parse(line) as { id: string };
        write(`${JSON.stringify({ jsonrpc: "2.0", method: "evt.multi", params: { v: 42 } })}\n`);
        write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: null })}\n`);
      });
      const c = new IPCClient(socketPath);
      await c.connect();
      const a: unknown[] = [];
      const b: unknown[] = [];
      c.onNotification("evt.multi", (p) => a.push(p));
      // Second registration on same method — hits the "set already exists" branch
      c.onNotification("evt.multi", (p) => b.push(p));
      await c.call("trigger", {});
      expect(a).toEqual([{ v: 42 }]);
      expect(b).toEqual([{ v: 42 }]);
      await c.disconnect();
    },
  );

  test.skipIf(isWin)("notification for unknown method is silently dropped", async () => {
    startServer((line, write) => {
      const req = JSON.parse(line) as { id: string };
      // Send a notification for a method that has no handler registered
      write(`${JSON.stringify({ jsonrpc: "2.0", method: "unregistered.event", params: {} })}\n`);
      write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "ok" })}\n`);
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    const result = await c.call<unknown>("trigger", {});
    // The unhandled notification must not throw — result should resolve normally
    expect(result).toBe("ok");
    await c.disconnect();
  });

  test.skipIf(isWin)("ignores lines with non-2.0 jsonrpc version", async () => {
    startServer((line, write) => {
      const req = JSON.parse(line) as { id: string };
      // Send a malformed version first, then the real reply
      write(`${JSON.stringify({ jsonrpc: "1.0", id: req.id, result: "bad" })}\n`);
      write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "good" })}\n`);
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    const result = await c.call<unknown>("test", {});
    expect(result).toBe("good");
    await c.disconnect();
  });

  test.skipIf(isWin)("ignores lines that are invalid JSON", async () => {
    startServer((line, write) => {
      const req = JSON.parse(line) as { id: string };
      write("not valid json at all\n");
      write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "after-junk" })}\n`);
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    const result = await c.call<unknown>("test", {});
    expect(result).toBe("after-junk");
    await c.disconnect();
  });

  test.skipIf(isWin)("ignores RPC response with wrong id (id mismatch)", async () => {
    startServer((line, write) => {
      const req = JSON.parse(line) as { id: string };
      // First send a reply for a different id (should be ignored), then the correct one
      write(`${JSON.stringify({ jsonrpc: "2.0", id: "wrong-id-99", result: "wrong" })}\n`);
      write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "correct" })}\n`);
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    const result = await c.call<unknown>("test", {});
    expect(result).toBe("correct");
    await c.disconnect();
  });

  test.skipIf(isWin)("ignores RPC response whose id is not a string or number", async () => {
    startServer((line, write) => {
      const req = JSON.parse(line) as { id: string };
      // id is null — not string/number, should be silently dropped
      write(`${JSON.stringify({ jsonrpc: "2.0", id: null, result: "nope" })}\n`);
      write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "yes" })}\n`);
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    const result = await c.call<unknown>("test", {});
    expect(result).toBe("yes");
    await c.disconnect();
  });

  test.skipIf(isWin)("ignores notification with non-string method", async () => {
    startServer((line, write) => {
      const req = JSON.parse(line) as { id: string };
      // notification where method is a number — should be ignored
      write(`${JSON.stringify({ jsonrpc: "2.0", method: 42, params: {} })}\n`);
      write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "fine" })}\n`);
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    const result = await c.call<unknown>("test", {});
    expect(result).toBe("fine");
    await c.disconnect();
  });

  test.skipIf(isWin)("connect() is idempotent (second call is a no-op)", async () => {
    startServer((_line, _write) => {
      /* no response needed */
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    // Second connect should return immediately without error (already connected)
    await c.connect();
    await c.disconnect();
  });

  test.skipIf(isWin)("call() without params omits params key from the request", async () => {
    let receivedNoParams = false;
    startServer((line, write) => {
      const req = JSON.parse(line) as { id: string; params?: unknown };
      receivedNoParams = !Object.hasOwn(req, "params");
      write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "ok" })}\n`);
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    await c.call("no-params");
    expect(receivedNoParams).toBe(true);
    await c.disconnect();
  });

  test.skipIf(isWin)("disconnect() rejects in-flight calls", async () => {
    startServer(() => {
      /* never responds */
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    const pending = c.call("hang", {});
    await c.disconnect();
    await expect(pending).rejects.toThrow(/disconnected/);
  });

  test.skipIf(isWin)("disconnect() on already-disconnected client does not throw", async () => {
    startServer(() => {
      /* never responds */
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    await c.disconnect();
    // Second disconnect: no pending, no socket — should be a no-op
    await c.disconnect();
  });

  test.skipIf(isWin)(
    "socket close rejects in-flight calls with connection-closed error",
    async () => {
      startServer((line, write) => {
        const req = JSON.parse(line) as { id: string };
        // Send a reply so we know the server got the call
        void req;
        void write;
        // Intentionally don't write — the server will be stopped forcefully
      });
      const c = new IPCClient(socketPath);
      await c.connect();
      const pendingCall = c.call<unknown>("test", {});
      // Stop the server forcefully — this will close the socket
      server?.stop(true);
      server = undefined;
      await expect(pendingCall).rejects.toThrow();
    },
  );

  test.skipIf(isWin)("number id in RPC response is dispatched correctly", async () => {
    // Use a custom server that replies with a numeric id
    startServer((line, write) => {
      const req = JSON.parse(line) as { id: string };
      void req;
      // Reply with a numeric id — exercises the number arm of idKey in dispatchRpcLine
      // We send the numeric reply BEFORE the real one to exercise the number branch path
      // (the numeric id won't match the UUID-based pending — it will hit the "pend undefined" branch)
      write(`${JSON.stringify({ jsonrpc: "2.0", id: 12345, result: "numeric" })}\n`);
      write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "matched" })}\n`);
    });
    const c = new IPCClient(socketPath);
    await c.connect();
    const result = await c.call<unknown>("test", {});
    // The numeric id should be silently dropped (no matching pending), and the UUID reply matches
    expect(result).toBe("matched");
    await c.disconnect();
  });
});

// ---------------------------------------------------------------------------
// IPCClient — socket-free dispatch tests via private method casting
// These cover branches that cannot be reached from the socket path cross-platform.
// ---------------------------------------------------------------------------

describe("IPCClient dispatch internals (no socket)", () => {
  // Helper to access private methods
  type InternalClient = {
    onTransportData: (chunk: Uint8Array) => void;
    dispatchLine: (line: string) => void;
    dispatchRpcLine: (o: Record<string, unknown>) => void;
    dispatchNotificationLine: (o: Record<string, unknown>) => void;
    failAll: (reason: unknown) => void;
    rawWrite: (s: string) => void;
    endWindowsTransport: () => void;
    endUnixTransport: () => void;
    connected: boolean;
    netSocket: { write: (s: string) => void; end: () => void } | null;
    bunSocket: { write: (s: string) => void; end: () => void } | null;
    pending: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  };

  function internal(c: IPCClient): InternalClient {
    return c as unknown as InternalClient;
  }

  function toChunk(s: string): Uint8Array {
    return new TextEncoder().encode(s);
  }

  test("failAll with empty pending map returns early without iterating", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    // No pending entries — should return without throwing
    expect(ic.pending.size).toBe(0);
    ic.failAll(new Error("should not matter"));
    expect(ic.pending.size).toBe(0);
  });

  test("failAll with non-Error reason wraps it in an Error", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    // Add a pending entry manually
    let rejectedWith: Error | undefined;
    ic.pending.set("s:test-id", {
      resolve: (_v: unknown) => {
        /* noop */
      },
      reject: (e: Error) => {
        rejectedWith = e;
      },
    });
    // Pass a non-Error string as reason — should wrap it
    ic.failAll("string failure reason");
    expect(rejectedWith).toBeInstanceOf(Error);
    expect(rejectedWith?.message).toBe("string failure reason");
    expect(ic.pending.size).toBe(0);
  });

  test("failAll with non-Error non-string reason wraps via String()", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    let rejectedWith: Error | undefined;
    ic.pending.set("s:test-id", {
      resolve: (_v: unknown) => {
        /* noop */
      },
      reject: (e: Error) => {
        rejectedWith = e;
      },
    });
    ic.failAll(42);
    expect(rejectedWith?.message).toBe("42");
  });

  test("onTransportData calls failAll when ingest throws (NdjsonLineReader too-large line)", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    let rejectedWith: Error | undefined;
    ic.pending.set("s:sentinel", {
      resolve: (_v: unknown) => {
        /* noop */
      },
      reject: (e: Error) => {
        rejectedWith = e;
      },
    });
    // Push a 2MB line (exceeds 1MB limit) — will cause NdjsonLineReader to throw
    const bigLine = `${"x".repeat(2 * 1024 * 1024)}\n`;
    ic.onTransportData(toChunk(bigLine));
    expect(rejectedWith).toBeInstanceOf(Error);
    expect(rejectedWith?.message).toMatch(/1MB/);
  });

  test("dispatchLine silently drops invalid JSON", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    // Should not throw
    ic.dispatchLine("this is not json");
    expect(ic.pending.size).toBe(0);
  });

  test("dispatchLine silently drops line without jsonrpc 2.0", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    ic.dispatchLine(JSON.stringify({ jsonrpc: "1.0", id: "x", result: "bad" }));
    expect(ic.pending.size).toBe(0);
  });

  test("dispatchLine routes message with id to dispatchRpcLine", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    let resolved: unknown;
    ic.pending.set("s:my-id", {
      resolve: (v: unknown) => {
        resolved = v;
      },
      reject: (_e: Error) => {
        /* noop */
      },
    });
    ic.dispatchLine(JSON.stringify({ jsonrpc: "2.0", id: "my-id", result: "dispatched" }));
    expect(resolved).toBe("dispatched");
  });

  test("dispatchLine routes message without id to dispatchNotificationLine", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const notifsSeen: unknown[] = [];
    c.onNotification("test.event", (p) => notifsSeen.push(p));
    const ic = internal(c);
    ic.dispatchLine(JSON.stringify({ jsonrpc: "2.0", method: "test.event", params: { x: 1 } }));
    expect(notifsSeen).toEqual([{ x: 1 }]);
  });

  test("dispatchRpcLine drops message when id is not string or number", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    // Boolean id — should be silently dropped
    ic.dispatchRpcLine({ jsonrpc: "2.0", id: true, result: "ignored" });
    expect(ic.pending.size).toBe(0);
  });

  test("dispatchRpcLine drops message when no pending entry matches id", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    // No pending registered, but valid id type — should silently return
    ic.dispatchRpcLine({ jsonrpc: "2.0", id: "nonexistent-id", result: "dropped" });
    expect(ic.pending.size).toBe(0);
  });

  test("dispatchRpcLine resolves with undefined when no result key in response", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    let resolved: unknown = "sentinel";
    ic.pending.set("s:x", {
      resolve: (v: unknown) => {
        resolved = v;
      },
      reject: (_e: Error) => {
        /* noop */
      },
    });
    // No "result" key — should resolve with undefined
    ic.dispatchRpcLine({ jsonrpc: "2.0", id: "x" });
    expect(resolved).toBeUndefined();
  });

  test("dispatchRpcLine rejects with jsonRpcErrorMessage when error key present", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    let rejectedWith: Error | undefined;
    ic.pending.set("s:err-id", {
      resolve: (_v: unknown) => {
        /* noop */
      },
      reject: (e: Error) => {
        rejectedWith = e;
      },
    });
    ic.dispatchRpcLine({ jsonrpc: "2.0", id: "err-id", error: { message: "internal error" } });
    expect(rejectedWith?.message).toBe("internal error");
  });

  test("dispatchRpcLine rejects with default message when error has no message key", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    let rejectedWith: Error | undefined;
    ic.pending.set("s:err-id2", {
      resolve: (_v: unknown) => {
        /* noop */
      },
      reject: (e: Error) => {
        rejectedWith = e;
      },
    });
    ic.dispatchRpcLine({ jsonrpc: "2.0", id: "err-id2", error: {} });
    expect(rejectedWith?.message).toBe("JSON-RPC error");
  });

  test("dispatchNotificationLine drops message with non-string method", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    // Should not throw — method is a number, not a string
    ic.dispatchNotificationLine({ jsonrpc: "2.0", method: 123, params: {} });
  });

  test("dispatchNotificationLine drops message with no registered handlers", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    // method string but no handler registered — should not throw
    ic.dispatchNotificationLine({ jsonrpc: "2.0", method: "unregistered", params: {} });
  });

  test("dispatchNotificationLine delivers params=undefined when params key absent", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    const seen: unknown[] = [];
    c.onNotification("my.event", (p) => seen.push(p));
    ic.dispatchNotificationLine({ jsonrpc: "2.0", method: "my.event" });
    expect(seen).toEqual([undefined]);
  });

  test("rawWrite is a no-op when both netSocket and bunSocket are null", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    expect(ic.netSocket).toBeNull();
    expect(ic.bunSocket).toBeNull();
    // Should not throw
    ic.rawWrite("test message\n");
  });

  test("rawWrite writes to netSocket when netSocket is not null", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    const written: string[] = [];
    ic.netSocket = {
      write: (s: string) => {
        written.push(s);
      },
      end: () => {
        /* noop */
      },
    };
    ic.rawWrite("hello\n");
    expect(written).toEqual(["hello\n"]);
  });

  test("rawWrite writes to bunSocket when netSocket is null and bunSocket is not null", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    const written: string[] = [];
    ic.bunSocket = {
      write: (s: string) => {
        written.push(s);
      },
      end: () => {
        /* noop */
      },
    };
    ic.rawWrite("world\n");
    expect(written).toEqual(["world\n"]);
  });

  test("endWindowsTransport returns early when netSocket is null", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    expect(ic.netSocket).toBeNull();
    // Should not throw
    ic.endWindowsTransport();
    expect(ic.netSocket).toBeNull();
  });

  test("endWindowsTransport calls end() and nullifies netSocket when not null", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    let ended = false;
    ic.netSocket = {
      write: (_s: string) => {
        /* noop */
      },
      end: () => {
        ended = true;
      },
    };
    ic.endWindowsTransport();
    expect(ended).toBe(true);
    expect(ic.netSocket).toBeNull();
  });

  test("endUnixTransport returns early when bunSocket is null", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    expect(ic.bunSocket).toBeNull();
    // Should not throw
    ic.endUnixTransport();
    expect(ic.bunSocket).toBeNull();
  });

  test("endUnixTransport calls end() and nullifies bunSocket when not null", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    let ended = false;
    ic.bunSocket = {
      write: (_s: string) => {
        /* noop */
      },
      end: () => {
        ended = true;
      },
    };
    ic.endUnixTransport();
    expect(ended).toBe(true);
    expect(ic.bunSocket).toBeNull();
  });

  test("dispatchRpcLine resolves with numeric id from pending (number id key path)", () => {
    const c = new IPCClient(INTERNAL_FAKE_PATH);
    const ic = internal(c);
    let resolvedValue: unknown = "unset";
    // Register pending with numeric id key
    ic.pending.set("n:7", {
      resolve: (v: unknown) => {
        resolvedValue = v;
      },
      reject: (_e: Error) => {
        /* noop */
      },
    });
    // Dispatch a response with numeric id 7 — exercises the number path in idKey
    ic.dispatchRpcLine({ jsonrpc: "2.0", id: 7, result: "numeric-resolved" });
    expect(resolvedValue).toBe("numeric-resolved");
    expect(ic.pending.size).toBe(0);
  });
});
