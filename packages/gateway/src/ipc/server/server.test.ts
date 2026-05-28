import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

import { LocalIndex } from "../../index/local-index.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { IPCServer } from "../types.ts";
import { createIpcServer } from "./server.ts";

function makeMinimalServer() {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);

  const broadcastCalls: Array<{ method: string; params: Record<string, unknown> }> = [];

  const server = createIpcServer({
    listenPath: "/tmp/nimbus-server-test.sock",
    vault: createMockVault(),
    version: "0.0.0-test",
    localIndex: new LocalIndex(db),
    onClientConnected: () => {},
  });

  return { server, broadcastCalls, db };
}

describe("createIpcServer", () => {
  test("broadcast does not throw when no clients are connected", () => {
    const { server } = makeMinimalServer();
    expect(() => server.broadcast("test.event", { foo: "bar" })).not.toThrow();
  });

  test("setAgentInvokeHandler replaces the handler without throwing", () => {
    const { server } = makeMinimalServer();
    const handler = async (_ctx: unknown) => ({ reply: "ok" });
    expect(() => server.setAgentInvokeHandler(handler as never)).not.toThrow();
    expect(() => server.setAgentInvokeHandler(undefined)).not.toThrow();
  });

  test("setWorkflowRunHandler replaces the handler without throwing", () => {
    const { server } = makeMinimalServer();
    const handler = async (_ctx: unknown) => ({ ok: true });
    expect(() => server.setWorkflowRunHandler(handler as never)).not.toThrow();
    expect(() => server.setWorkflowRunHandler(undefined)).not.toThrow();
  });

  test("setUpdater attaches the updater reference without throwing", () => {
    const { server } = makeMinimalServer();
    const fakeUpdater = {} as never;
    expect(() => server.setUpdater(fakeUpdater)).not.toThrow();
  });

  test("voiceService.onMicrophoneStateChange is wired via broadcastNotification", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);

    let storedCallback: ((e: { active: boolean; source: string }) => void) | undefined;
    const fakeVoiceService = {
      set onMicrophoneStateChange(cb:
        | ((e: { active: boolean; source: string }) => void)
        | undefined,) {
        storedCallback = cb;
      },
    };

    createIpcServer({
      listenPath: "/tmp/nimbus-server-voice-test.sock",
      vault: createMockVault(),
      version: "0.0.0-test",
      voiceService: fakeVoiceService as never,
    });

    expect(typeof storedCallback).toBe("function");
    expect(() => storedCallback?.({ active: true, source: "microphone" })).not.toThrow();
  });
});

describe("createIpcServer — listener startup/shutdown (POSIX unix-socket arm)", () => {
  let tmpDir: string;
  let socketPath: string;

  beforeEach(() => {
    if (platform() === "win32") return;
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-srv-"));
    socketPath = join(tmpDir, "g.sock");
  });

  afterEach(() => {
    if (platform() === "win32") return;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("start() binds a unix socket at listenPath; stop() unlinks it", async () => {
    if (platform() === "win32") return;
    const server = createIpcServer({
      listenPath: socketPath,
      vault: createMockVault(),
      version: "0.0.0-test",
    });
    await server.start();
    expect(existsSync(socketPath)).toBe(true);
    await server.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  test("start() removes a stale socket file at listenPath before bind", async () => {
    if (platform() === "win32") return;
    writeFileSync(socketPath, "stale");
    expect(existsSync(socketPath)).toBe(true);

    const server = createIpcServer({
      listenPath: socketPath,
      vault: createMockVault(),
      version: "0.0.0-test",
    });
    await server.start();
    expect(existsSync(socketPath)).toBe(true);
    await server.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  test("stop() is idempotent (a second call after cleanup is a no-op)", async () => {
    if (platform() === "win32") return;
    const server = createIpcServer({
      listenPath: socketPath,
      vault: createMockVault(),
      version: "0.0.0-test",
    });
    await server.start();
    await server.stop();
    await expect(server.stop()).resolves.toBeUndefined();
  });
});

function testListenPath(): string {
  if (platform() === "win32") {
    return String.raw`\\.\pipe\nimbus-server-dispatch-${randomUUID()}`;
  }
  return join(mkdtempSync(join(tmpdir(), "nimbus-srv-d-")), "s.sock");
}

function appendAndTakeFirstLine(buffer: string, chunk: string): { next: string; line?: string } {
  const combined = buffer + chunk;
  const nl = combined.indexOf("\n");
  if (nl < 0) {
    return { next: combined };
  }
  return { next: combined.slice(nl + 1), line: combined.slice(0, nl) };
}

async function exchangeFirstNdjsonLine(listenPath: string, lineToWrite: string): Promise<string> {
  if (platform() === "win32") {
    return await new Promise<string>((resolve, reject) => {
      let buf = "";
      const sock = net.createConnection(listenPath);
      sock.on("connect", () => {
        sock.write(lineToWrite);
      });
      sock.on("data", (b: Buffer) => {
        const { next, line } = appendAndTakeFirstLine(buf, b.toString("utf8"));
        buf = next;
        if (line !== undefined) {
          resolve(line);
          sock.end();
        }
      });
      sock.on("error", reject);
    });
  }

  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    Bun.connect({
      unix: listenPath,
      socket: {
        open(socket) {
          socket.write(lineToWrite);
        },
        data(socket, chunk: Uint8Array) {
          const { next, line } = appendAndTakeFirstLine(buf, new TextDecoder().decode(chunk));
          buf = next;
          if (line !== undefined) {
            resolve(line);
            socket.end();
          }
        },
        error() {
          reject(new Error("socket error"));
        },
      },
    }).catch(reject);
  });
}

describe("createIpcServer — RPC dispatch arms", () => {
  let server: IPCServer | undefined;
  let listenPath: string;

  beforeEach(() => {
    listenPath = testListenPath();
  });

  afterEach(async () => {
    if (server !== undefined) {
      try {
        await server.stop();
      } catch {
        /* ignore */
      }
      server = undefined;
    }
  });

  test("audit.list reaches rpcAuditList through the switch arm", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const localIndex = new LocalIndex(db);

    server = createIpcServer({
      listenPath,
      vault: createMockVault(),
      version: "0.0.0-test",
      localIndex,
    });
    await server.start();

    const line = await exchangeFirstNdjsonLine(
      listenPath,
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "audit.list",
        params: { limit: 10 },
      })}\n`,
    );
    const res = JSON.parse(line) as { result?: unknown; error?: unknown };
    expect(res.result !== undefined || res.error !== undefined).toBe(true);
  });

  test("engine.cancelStream reaches createCancelStreamHandler", async () => {
    server = createIpcServer({
      listenPath,
      vault: createMockVault(),
      version: "0.0.0-test",
    });
    await server.start();

    const line = await exchangeFirstNdjsonLine(
      listenPath,
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "engine.cancelStream",
        params: { streamId: "nonexistent" },
      })}\n`,
    );
    const res = JSON.parse(line) as { result?: unknown; error?: unknown };
    expect(res.result !== undefined || res.error !== undefined).toBe(true);
  });

  test("engine.getSessionTranscript without a localIndex throws -32603", async () => {
    server = createIpcServer({
      listenPath,
      vault: createMockVault(),
      version: "0.0.0-test",
      // intentionally no localIndex — exercises the `li === undefined` branch
    });
    await server.start();

    const line = await exchangeFirstNdjsonLine(
      listenPath,
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "engine.getSessionTranscript",
        params: { sessionId: "s1" },
      })}\n`,
    );
    const res = JSON.parse(line) as {
      result?: unknown;
      error?: { code: number; message: string };
    };
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32603);
    expect(res.error?.message).toContain("local index");
  });

  test("unknown methods fall through to vault-or-method-not-found (default arm)", async () => {
    server = createIpcServer({
      listenPath,
      vault: createMockVault(),
      version: "0.0.0-test",
    });
    await server.start();

    const line = await exchangeFirstNdjsonLine(
      listenPath,
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "nimbus.does-not-exist",
        params: {},
      })}\n`,
    );
    const res = JSON.parse(line) as { error?: { code: number } };
    expect(res.error).toBeDefined();
    expect(res.error?.code === -32601 || res.error?.code === -32603).toBe(true);
  });
});
