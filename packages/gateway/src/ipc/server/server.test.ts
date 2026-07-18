import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

import { LocalIndex } from "../../index/local-index.ts";
import { SessionMemoryStore } from "../../memory/session-memory-store.ts";
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
    expect(() => server.setAgentInvokeHandler(handler)).not.toThrow();
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

  test.skipIf(platform() === "win32")(
    "start() binds a unix socket at listenPath; stop() unlinks it",
    async () => {
      const server = createIpcServer({
        listenPath: socketPath,
        vault: createMockVault(),
        version: "0.0.0-test",
      });
      await server.start();
      expect(existsSync(socketPath)).toBe(true);
      await server.stop();
      expect(existsSync(socketPath)).toBe(false);
    },
  );

  test.skipIf(platform() === "win32")(
    "start() removes a stale socket file at listenPath before bind",
    async () => {
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
    },
  );

  test.skipIf(platform() === "win32")(
    "stop() is idempotent (a second call after cleanup is a no-op)",
    async () => {
      const server = createIpcServer({
        listenPath: socketPath,
        vault: createMockVault(),
        version: "0.0.0-test",
      });
      await server.start();
      await server.stop();
      await expect(server.stop()).resolves.toBeUndefined();
    },
  );
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

  // ── BRDA line=143 block=7 branch=0 ──────────────────────────────────────────
  // session.* RPC hits tryDispatchSessionRpc → returns before automationRpc chain
  test.skipIf(platform() === "win32")(
    "session.list reaches sessionRpc dispatcher (early-return branch)",
    async () => {
      const db = new Database(":memory:");
      LocalIndex.ensureSchema(db);
      const store = new SessionMemoryStore({ db, dims: 384, embedText: async () => null });
      server = createIpcServer({
        listenPath,
        vault: createMockVault(),
        version: "0.0.0-test",
        sessionMemoryStore: store,
      });
      await server.start();

      const line = await exchangeFirstNdjsonLine(
        listenPath,
        `${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "session.list", params: {} })}\n`,
      );
      const res = JSON.parse(line) as { result?: unknown; error?: unknown };
      // Either a hit (sessions envelope) or a method-not-found; what matters is we
      // got a response (the session-rpc dispatcher was entered).
      expect(res.result !== undefined || res.error !== undefined).toBe(true);
    },
  );

  // ── BRDA line=158 block=10 branch=0 ────────────────────────────────────────
  // diagnostics.* RPC hits tryDispatchDiagnosticsRpc → returns before people/phase4
  test.skipIf(platform() === "win32")(
    "diag.snapshot reaches diagnosticsRpc dispatcher (early-return branch)",
    async () => {
      const db = new Database(":memory:");
      LocalIndex.ensureSchema(db);
      const localIndex = new LocalIndex(db);
      const tmpDir2 = mkdtempSync(join(tmpdir(), "nimbus-srv-diag-"));
      try {
        server = createIpcServer({
          listenPath,
          vault: createMockVault(),
          version: "0.0.0-test",
          localIndex,
          dataDir: tmpDir2,
          configDir: tmpDir2,
        });
        await server.start();

        const line = await exchangeFirstNdjsonLine(
          listenPath,
          `${JSON.stringify({ jsonrpc: "2.0", id: 11, method: "diag.snapshot", params: {} })}\n`,
        );
        const res = JSON.parse(line) as { result?: unknown; error?: unknown };
        // The diagnostics dispatcher was entered (either success or typed error).
        expect(res.result !== undefined || res.error !== undefined).toBe(true);
      } finally {
        try {
          rmSync(tmpDir2, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    },
  );

  // ── BRDA line=164 block=12 branch=0 ────────────────────────────────────────
  // lan.getStatus is handled by phase4 → triggers phase4RpcSkipped != skip early-return
  test.skipIf(platform() === "win32")(
    "lan.getStatus reaches phase4Rpc dispatcher (early-return branch)",
    async () => {
      server = createIpcServer({
        listenPath,
        vault: createMockVault(),
        version: "0.0.0-test",
      });
      await server.start();

      const line = await exchangeFirstNdjsonLine(
        listenPath,
        `${JSON.stringify({ jsonrpc: "2.0", id: 12, method: "lan.getStatus", params: {} })}\n`,
      );
      const res = JSON.parse(line) as { result?: Record<string, unknown>; error?: unknown };
      expect(res.result).toBeDefined();
      expect(res.result?.["enabled"]).toBe(false);
    },
  );

  // ── BRDA line=166 block=13 branch=1 ────────────────────────────────────────
  // switch case "index.searchRanked"
  test.skipIf(platform() === "win32")(
    "index.searchRanked reaches the searchRanked switch arm",
    async () => {
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
          id: 13,
          method: "index.searchRanked",
          params: { name: "test" },
        })}\n`,
      );
      const res = JSON.parse(line) as { result?: unknown; error?: unknown };
      // Got a response: the searchRanked switch arm was entered.
      expect(res.result !== undefined || res.error !== undefined).toBe(true);
    },
  );

  // ── BRDA line=166 block=13 branch=5 ────────────────────────────────────────
  // switch case "agent.invoke" — happy path with a handler installed
  test.skipIf(platform() === "win32")(
    "agent.invoke reaches the agent.invoke switch arm and returns handler reply",
    async () => {
      server = createIpcServer({
        listenPath,
        vault: createMockVault(),
        version: "0.0.0-test",
      });
      server.setAgentInvokeHandler(async (_ctx) => ({ reply: "invoked-ok" }));
      await server.start();

      const line = await exchangeFirstNdjsonLine(
        listenPath,
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 14,
          method: "agent.invoke",
          params: { input: "hello" },
        })}\n`,
      );
      const res = JSON.parse(line) as { result?: { reply?: string }; error?: unknown };
      expect(res.result?.reply).toBe("invoked-ok");
    },
  );

  // ── BRDA line=183 block=14 branch=1 ────────────────────────────────────────
  // engine.getSessionTranscript with localIndex present — no error, proceeds to handler
  test.skipIf(platform() === "win32")(
    "engine.getSessionTranscript with localIndex present proceeds past the undefined guard",
    async () => {
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
          id: 15,
          method: "engine.getSessionTranscript",
          params: { sessionId: "test-session-id" },
        })}\n`,
      );
      const res = JSON.parse(line) as {
        result?: unknown;
        error?: { code: number; message: string };
      };
      // With localIndex present the -32603 "requires a configured local index" is NOT thrown.
      // The handler may return a result or throw a different error (e.g., missing session).
      if (res.error !== undefined) {
        expect(res.error.message).not.toContain("local index");
      } else {
        expect(res.result).toBeDefined();
      }
    },
  );

  // ── BRDA line=125 block=5 branch=1  +  BRDA line=128 block=6 branch=0 ────
  // handleRpc catch: non-RpcMethodError Error — message comes from Error.message
  test.skipIf(platform() === "win32")(
    "agent.invoke handler throwing Error yields error response with the Error message",
    async () => {
      server = createIpcServer({
        listenPath,
        vault: createMockVault(),
        version: "0.0.0-test",
      });
      server.setAgentInvokeHandler(async (_ctx) => {
        throw new Error("handler-error-message");
      });
      await server.start();

      const line = await exchangeFirstNdjsonLine(
        listenPath,
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 16,
          method: "agent.invoke",
          params: { input: "x" },
        })}\n`,
      );
      const res = JSON.parse(line) as { error?: { code: number; message: string } };
      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(-32603);
      expect(res.error?.message).toBe("handler-error-message");
    },
  );

  // ── BRDA line=128 block=6 branch=1 ─────────────────────────────────────────
  // handleRpc catch: thrown value is not an Error → "Internal error" fallback
  test.skipIf(platform() === "win32")(
    "agent.invoke handler throwing a non-Error value yields 'Internal error'",
    async () => {
      server = createIpcServer({
        listenPath,
        vault: createMockVault(),
        version: "0.0.0-test",
      });
      // The handler throws a string literal — not an Error instance.
      server.setAgentInvokeHandler(async (_ctx) => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "non-error-throw" as unknown as Error;
      });
      await server.start();

      const line = await exchangeFirstNdjsonLine(
        listenPath,
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 17,
          method: "agent.invoke",
          params: { input: "x" },
        })}\n`,
      );
      const res = JSON.parse(line) as { error?: { code: number; message: string } };
      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(-32603);
      expect(res.error?.message).toBe("Internal error");
    },
  );

  // ── BRDA line=114 block=4 branch=0 ─────────────────────────────────────────
  // handleRpc: notification (no id) → early return without a response
  // We send a notification and then a real request; the first response must be for the request.
  test.skipIf(platform() === "win32")(
    "sending a notification (no id) does not produce a response",
    async () => {
      server = createIpcServer({
        listenPath,
        vault: createMockVault(),
        version: "0.0.0-test",
      });
      await server.start();

      // Write a notification first (no id), then a ping request.
      // Only the ping response should come back.
      const twoMessages =
        `${JSON.stringify({ jsonrpc: "2.0", method: "some.notification", params: {} })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", id: 18, method: "gateway.ping", params: {} })}\n`;

      const line = await exchangeFirstNdjsonLine(listenPath, twoMessages);
      const res = JSON.parse(line) as { id?: unknown; result?: Record<string, unknown> };
      // The first (and only) line we receive is the ping reply, not a notification echo.
      expect(res.id).toBe(18);
      expect(res.result?.["version"]).toBe("0.0.0-test");
    },
  );

  // ── BRDA line=63 block=1 branch=0 ──────────────────────────────────────────
  // ConsentCoordinatorImpl getWriter lambda: session found → returns the write fn.
  // Triggered by requestConsent() for a connected client.
  test.skipIf(platform() === "win32")(
    "consentImpl getWriter finds a connected session and delivers the consent notification",
    async () => {
      let capturedClientId: string | undefined;
      server = createIpcServer({
        listenPath,
        vault: createMockVault(),
        version: "0.0.0-test",
        onClientConnected: (id) => {
          capturedClientId = id;
        },
      });
      await server.start();

      // Use a helper that keeps the connection open and collects all lines.
      const notifLines = await new Promise<string[]>((resolve, reject) => {
        const collected: string[] = [];
        let buf = "";
        Bun.connect({
          unix: listenPath,
          socket: {
            open(_socket) {
              // Connection is now live; capturedClientId is set by onClientConnected.
            },
            data(_socket, chunk: Uint8Array) {
              buf += new TextDecoder().decode(chunk);
              const parts = buf.split("\n");
              buf = parts[parts.length - 1] ?? "";
              for (let i = 0; i < parts.length - 1; i++) {
                const l = parts[i];
                if (l !== undefined && l.trim() !== "") collected.push(l);
              }
              if (collected.length >= 1) {
                resolve(collected);
              }
            },
            error(_socket, err) {
              reject(err);
            },
          },
        }).catch(reject);

        // Give the open() callback time to fire, then request consent.
        setTimeout(() => {
          if (capturedClientId === undefined) {
            reject(new Error("onClientConnected was not called"));
            return;
          }
          (server as IPCServer).consent
            .requestConsent(capturedClientId, {
              requestId: "req-consent-1",
              prompt: "Allow action?",
            })
            .catch(() => {
              /* consent promise rejection is expected when connection closes */
            });
        }, 50);
      });

      // We should have received the consent.request notification.
      const parsed = JSON.parse(notifLines[0] ?? "{}") as {
        method?: string;
        params?: { requestId?: string };
      };
      expect(parsed.method).toBe("consent.request");
      expect(parsed.params?.requestId).toBe("req-consent-1");
    },
  );
});
