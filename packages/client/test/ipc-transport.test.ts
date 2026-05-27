import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IPCClient } from "../src/ipc-transport.ts";

const isWin = process.platform === "win32";

let tmp: string;
let socketPath: string;
let server: ReturnType<typeof Bun.listen> | undefined;
const sockets = new Set<{ write: (s: string) => void; end: () => void }>();

beforeEach(() => {
  // Canonical mkdtempSync sanitizer (CodeQL js/file-system-race).
  tmp = mkdtempSync(join(tmpdir(), "nimbus-ipc-"));
  socketPath = join(tmp, "gw.sock");
});
afterEach(() => {
  server?.stop(true);
  server = undefined;
  sockets.clear();
  rmSync(tmp, { recursive: true, force: true });
});

/** Start a unix-socket echo server that replies to each line via `respond`. */
function startServer(respond: (line: string, write: (s: string) => void) => void): void {
  server = Bun.listen({
    unix: socketPath,
    socket: {
      open(sock) {
        sockets.add(sock as unknown as { write: (s: string) => void; end: () => void });
      },
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

  test.skipIf(isWin)("dispatches notifications to onNotification handlers", async () => {
    startServer((line, write) => {
      const req = JSON.parse(line) as { id: string };
      // emit a notification, then answer the request
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
});
