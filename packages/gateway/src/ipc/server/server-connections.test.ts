/**
 * server-connections.test.ts
 *
 * The paths of `createIpcServer` that only a REAL connection can reach.
 *
 * What the server does with a request still in flight when its client goes away — three
 * properties, all fail-closed:
 *
 *  1. A HITL approval requested AFTER the requesting client disconnected cannot be granted — the
 *     consent coordinator finds no session to ask, the gate records a rejection, and the action
 *     (here: an extension auto-update) never runs. Approval is never inferred from silence.
 *  2. A request PIPELINED behind it on the same connection is dropped, not executed: by the time
 *     it is dispatched its session no longer exists, and an unattended mutation on behalf of a
 *     client that has already left is exactly what must not happen.
 *  3. A prompt ALREADY pending when its client disconnects is rejected at once by the session's
 *     disposal — the coordinator has no timeout of its own, so nothing else would ever settle it.
 *
 * Plus the connected counterpart (the approval prompt goes to the requesting client's OWN session,
 * and that client's denial is what the gate honours), and the `node:net` transport arm — the only
 * transport on Windows — driven on every OS through the `hostPlatform` seam, since the coverage
 * run is Linux-only. That arm's post-listen fault log is proven by faulting the server it created
 * (captured through a `node:net` spy, restored in `finally`) and reading the line it writes to
 * stderr.
 *
 * The server is driven over its real transport — a unix socket on POSIX, a named pipe on Windows —
 * by a `node:net` client, which speaks both. No sleeps: every wait is on an event the server
 * produces (the disconnect is observed through the server's own `ClientKindStore.forget`).
 */

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

import { openSeededInMemoryDb } from "../../../test/helpers/migrated-db-seed.ts";
import { ProfileManager } from "../../config/profiles.ts";
import { AutoUpdateCache } from "../../extensions/auto-update-cache.ts";
import type { AvailableUpdate } from "../../extensions/auto-update-types.ts";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../../index/local-index.ts";
import { type ListenerReport, processListeners } from "../../locality/listener-registry.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { IPCServer } from "../types.ts";
import { ClientKindStore } from "./client-kind.ts";
import { createIpcServer } from "./server.ts";

const servers: IPCServer[] = [];
const sockets: net.Socket[] = [];
const openDbs: Database[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const sock of sockets.splice(0)) sock.destroy();
  for (const server of servers.splice(0)) await server.stop();
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function listenPath(): string {
  return platform() === "win32"
    ? String.raw`\\.\pipe\nimbus-srv-disconnect-` + randomUUID()
    : join(tempDir("nimbus-srv-disc-"), "s.sock");
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve: (value) => resolve(value) };
}

/** Records the ids the server forgets — i.e. the moment it disposed a client's session. */
class ObservedKinds extends ClientKindStore {
  readonly disposed = deferred<string>();
  override forget(clientId: string): void {
    super.forget(clientId);
    this.disposed.resolve(clientId);
  }
}

/** An NDJSON client over `node:net` (unix socket or named pipe alike). */
class LineClient {
  private buffer = "";
  private readonly received: Array<Record<string, unknown>> = [];
  private readonly waiters: Array<() => void> = [];

  private constructor(readonly socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf("\n");
      while (nl >= 0) {
        this.received.push(JSON.parse(this.buffer.slice(0, nl)) as Record<string, unknown>);
        this.buffer = this.buffer.slice(nl + 1);
        nl = this.buffer.indexOf("\n");
      }
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  static async connect(path: string): Promise<LineClient> {
    const socket = net.createConnection(path);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    return new LineClient(socket);
  }

  send(...messages: unknown[]): void {
    this.socket.write(messages.map((m) => `${JSON.stringify(m)}\n`).join(""));
  }

  /** Every message received so far that matches `pred` — never waits. */
  seen(pred: (m: Record<string, unknown>) => boolean): Array<Record<string, unknown>> {
    return this.received.filter(pred);
  }

  /** The first received message matching `pred`, waiting for it if it has not arrived yet. */
  async next(pred: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    for (;;) {
      const hit = this.received.find(pred);
      if (hit !== undefined) return hit;
      await new Promise<void>((wake) => this.waiters.push(wake));
    }
  }
}

/** Yields to the event loop until `check` holds; bounded, so a regression fails instead of hanging. */
async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2_000; i++) {
    if (check()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function freshIndex(): LocalIndex {
  const db = openSeededInMemoryDb(CURRENT_SCHEMA_VERSION);
  openDbs.push(db);
  return new LocalIndex(db);
}

function cachedUpdate(): AvailableUpdate {
  return {
    id: "ext.pending",
    displayName: "Pending",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    channel: "stable",
    changelog: "",
    publisherStatus: "verified",
    manifestHash: "0123456789abcdef".repeat(4),
    signatureB64: "",
    entryHash: "e".repeat(64),
    tarballUrl: "https://registry.invalid/ext.pending-1.1.0.tgz",
    permissionDiff: {
      network: { added: [], removed: [] },
      filesystem: { read: { added: [], removed: [] }, write: { added: [], removed: [] } },
    },
    verificationStatus: "verified",
    detectedAt: 1,
  };
}

describe("createIpcServer — a request in flight when its client disconnects", () => {
  test("its approval cannot be obtained (fail closed), and the request pipelined behind it is dropped", async () => {
    const index = freshIndex();
    const configDir = tempDir("nimbus-srv-disc-cfg-");
    const kinds = new ObservedKinds();
    const reachedVersionLookup = deferred<void>();
    const installedVersion = deferred<string | null>();
    const upgrades: string[] = [];
    const cache = new AutoUpdateCache();
    cache.upsert(cachedUpdate());

    const path = listenPath();
    const server = createIpcServer({
      listenPath: path,
      vault: createMockVault(),
      version: "0.0.0-test",
      localIndex: index,
      clientKinds: kinds,
      profileManager: new ProfileManager(configDir),
      extensionsAutoUpdate: {
        cache,
        forcePoll: async () => {},
        // Holds the request open INSIDE the handler, before the HITL gate is reached.
        getInstalledVersion: () => {
          reachedVersionLookup.resolve();
          return installedVersion.promise;
        },
        hasPrevVersion: async () => false,
        performUpgrade: async (u) => {
          upgrades.push(u.id);
        },
        performDowngrade: async () => {},
        appendAudit: async () => {},
      },
    });
    servers.push(server);
    await server.start();

    const client = await LineClient.connect(path);
    client.send(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "extension.update",
        params: { id: "ext.pending", toVersion: "1.1.0" },
      },
      // Would create `nimbus.ghost.toml` if it were ever executed.
      { jsonrpc: "2.0", id: 2, method: "profile.create", params: { name: "ghost" } },
    );

    await reachedVersionLookup.promise;
    client.socket.destroy();
    await kinds.disposed.promise; // the server has dropped the session

    installedVersion.resolve("1.0.0"); // let the in-flight request carry on to its gate
    const auditRows = (): Array<{ hitl_status: string; action_json: string }> =>
      index
        .getDatabase()
        .query<{ hitl_status: string; action_json: string }, []>(
          "SELECT hitl_status, action_json FROM audit_log WHERE action_type = 'extension.autoUpdate'",
        )
        .all();
    await eventually(() => auditRows().length > 0, "the auto-update gate's audit row");
    await new Promise<void>((r) => setImmediate(r));

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hitl_status).toBe("rejected");
    expect(JSON.parse(rows[0]?.action_json ?? "{}")).toMatchObject({
      hitlRejectReason: "client disconnected",
    });
    expect(upgrades).toEqual([]);
    expect(existsSync(join(configDir, "nimbus.ghost.toml"))).toBe(false);
    expect(server.consent.pendingCount()).toBe(0);
  });

  test("a prompt still awaiting its client when that client disconnects is rejected at once", async () => {
    // The other order from the test above: here the prompt is ALREADY pending when the client
    // goes. The consent coordinator has no timeout of its own, so only the session's disposal
    // (`onClientDisconnect`) settles it — without that, the gate would wait on an answer nobody
    // can give for as long as the gateway runs.
    const index = freshIndex();
    const vault = createMockVault();
    const kinds = new ObservedKinds();
    const path = listenPath();
    const server = createIpcServer({
      listenPath: path,
      vault,
      version: "0.0.0-test",
      localIndex: index,
      clientKinds: kinds,
    });
    servers.push(server);
    await server.start();

    const client = await LineClient.connect(path);
    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "vault.set",
      params: { key: "github.pat", value: "ghp_not_stored" },
    });
    await client.next((m) => m["method"] === "consent.request");
    expect(server.consent.pendingCount()).toBe(1);

    client.socket.destroy();
    await kinds.disposed.promise; // the server has dropped the session
    expect(server.consent.pendingCount()).toBe(0);

    const auditRows = (): Array<{ hitl_status: string; action_json: string }> =>
      index
        .getDatabase()
        .query<{ hitl_status: string; action_json: string }, []>(
          "SELECT hitl_status, action_json FROM audit_log WHERE action_type = 'vault.set'",
        )
        .all();
    await eventually(() => auditRows().length > 0, "the vault.set gate's audit row");
    await new Promise<void>((r) => setImmediate(r));

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hitl_status).toBe("rejected");
    expect(JSON.parse(rows[0]?.action_json ?? "{}")).toMatchObject({
      hitlRejectReason: "client disconnected",
    });
    expect(await vault.get("github.pat")).toBeNull();
  });
});

describe("createIpcServer — a connected client's approval round-trip", () => {
  test("the prompt goes to the requesting client's own session, and its denial is honoured", async () => {
    const vault = createMockVault();
    const path = listenPath();
    const server = createIpcServer({
      listenPath: path,
      vault,
      version: "0.0.0-test",
      localIndex: freshIndex(),
    });
    servers.push(server);
    await server.start();

    const client = await LineClient.connect(path);
    // A second connected client: "its OWN session" is only a claim if someone else could have
    // been asked instead. A completed round-trip proves its session is attached before the
    // request below is made.
    const bystander = await LineClient.connect(path);
    bystander.send({ jsonrpc: "2.0", id: 1, method: "gateway.ping", params: {} });
    await bystander.next((m) => m["id"] === 1);

    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "vault.set",
      params: { key: "github.pat", value: "ghp_not_stored" },
    });

    const prompt = await client.next((m) => m["method"] === "consent.request");
    const requestId = (prompt["params"] as Record<string, unknown>)["requestId"];
    expect(typeof requestId).toBe("string");
    // A prompt fanned out to every session would have been written to the bystander's socket
    // BEFORE the pong below (one connection's writes are ordered), so once the pong is in, its
    // absence is conclusive rather than a race.
    bystander.send({ jsonrpc: "2.0", id: 2, method: "gateway.ping", params: {} });
    await bystander.next((m) => m["id"] === 2);
    expect(bystander.seen((m) => m["method"] === "consent.request")).toEqual([]);

    client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "consent.respond",
      params: { requestId, approved: false },
    });

    const refused = await client.next((m) => m["id"] === 1);
    expect(refused["error"]).toEqual({ code: -32000, message: "User declined consent gate." });
    const ack = await client.next((m) => m["id"] === 2);
    expect(ack["error"]).toBeUndefined();
    expect(await vault.get("github.pat")).toBeNull();
  });
});

describe("createIpcServer — the node:net transport arm (Windows' named-pipe transport)", () => {
  /**
   * Forces `"win32"` and counts how often the server asked. Both transports register the same
   * `ipc` listener and answer the same pings, so on Linux/macOS nothing below could tell the arms
   * apart: a `start()` that went back to calling `platform()` directly would quietly serve these
   * tests from the Bun unix arm, and CI's (Linux-only) coverage of the named-pipe arm would vanish
   * with every test still green. Asserting the seam was consulted closes that.
   */
  function forcedWin32(): {
    readonly platform: () => NodeJS.Platform;
    readonly asked: () => number;
  } {
    let asked = 0;
    return {
      platform: () => {
        asked++;
        return "win32";
      },
      asked: () => asked,
    };
  }

  function ipcListenersAt(path: string): string[] {
    // Filtered by OUR OWN address: `processListeners` is process-global.
    return processListeners
      .live()
      .filter((l) => l.address === path)
      .map((l) => l.name);
  }

  /**
   * Records each probe registered with the process-wide listener registry and whether its
   * unregister function was called. `live()` alone cannot show that `stop()` unregistered the
   * pipe: its probe reads `netServer.listening` live, so a closed pipe drops out of `live()`
   * whether or not anything unregistered it, and a leaked registration would go unseen.
   * Restored in the test's `finally` — the registry is shared by the whole process.
   */
  function trackRegistrations(): {
    readonly registeredFor: (path: string) => Array<{ readonly unregistered: boolean }>;
    readonly restore: () => void;
  } {
    const realRegister = processListeners.register;
    const records: Array<{
      readonly probe: () => ListenerReport | null;
      unregistered: boolean;
    }> = [];
    const spy = spyOn(processListeners, "register").mockImplementation((probe) => {
      const record = { probe, unregistered: false };
      records.push(record);
      const unregister = realRegister.call(processListeners, probe);
      return () => {
        record.unregistered = true;
        unregister();
      };
    });
    return {
      // Read while the listener is up: a probe names its address only while listening.
      registeredFor: (path) => records.filter((r) => r.probe()?.address === path),
      restore: () => spy.mockRestore(),
    };
  }

  test("serves requests, registers its listener, and stop() drops live clients and unregisters", async () => {
    const registry = trackRegistrations();
    try {
      const path = listenPath();
      const host = forcedWin32();
      const server = createIpcServer(
        { listenPath: path, vault: createMockVault(), version: "0.0.0-net-arm" },
        host.platform,
      );
      servers.push(server);
      await server.start();
      expect(host.asked()).toBeGreaterThan(0);
      expect(ipcListenersAt(path)).toEqual(["ipc"]);
      const ours = registry.registeredFor(path);
      expect(ours).toHaveLength(1);

      const client = await LineClient.connect(path);
      client.send({ jsonrpc: "2.0", id: 7, method: "gateway.ping", params: {} });
      const pong = await client.next((m) => m["id"] === 7);
      expect(pong["result"]).toMatchObject({ version: "0.0.0-net-arm" });

      const clientClosed = new Promise<void>((resolve) =>
        client.socket.once("close", () => resolve()),
      );
      expect(ours[0]?.unregistered).toBe(false);
      await server.stop();
      // stop() destroys every live client socket rather than waiting for clients to leave.
      await clientClosed;
      expect(ipcListenersAt(path)).toEqual([]);
      expect(ours[0]?.unregistered).toBe(true);

      // A second stop() has nothing left to close and must not throw.
      await expect(server.stop()).resolves.toBeUndefined();
    } finally {
      registry.restore();
    }
  });

  test("a client that has already disconnected is not in the way of stop()", async () => {
    const path = listenPath();
    const kinds = new ObservedKinds();
    const host = forcedWin32();
    const server = createIpcServer(
      { listenPath: path, vault: createMockVault(), version: "0.0.0-net-arm", clientKinds: kinds },
      host.platform,
    );
    servers.push(server);
    await server.start();
    expect(host.asked()).toBeGreaterThan(0);

    const client = await LineClient.connect(path);
    client.send({ jsonrpc: "2.0", id: 1, method: "gateway.ping", params: {} });
    await client.next((m) => m["id"] === 1);
    client.socket.destroy();
    await kinds.disposed.promise;

    await expect(server.stop()).resolves.toBeUndefined();
    expect(ipcListenersAt(path)).toEqual([]);
  });

  /**
   * Hands back the next `node:net` server created, so a test can fault the pipe server
   * `createIpcServer` keeps private. Restored in the test's `finally` — `node:net` is shared by the
   * whole process.
   */
  function captureNextNetServer(): {
    readonly server: () => net.Server;
    readonly restore: () => void;
  } {
    const realCreateServer = net.createServer;
    let created: net.Server | undefined;
    const spy = spyOn(net, "createServer").mockImplementation(((...args: unknown[]) => {
      const server = (realCreateServer as (...a: unknown[]) => net.Server).apply(net, args);
      created ??= server;
      return server;
    }) as unknown as typeof net.createServer);
    return {
      server: () => {
        if (created === undefined) throw new Error("createIpcServer opened no node:net server");
        return created;
      },
      restore: () => spy.mockRestore(),
    };
  }

  /** The `ipc-pipe` lines written to stderr, parsed; every other write passes through untouched. */
  function captureIpcPipeLog(): {
    readonly lines: () => Array<Record<string, unknown>>;
    readonly restore: () => void;
  } {
    const raw: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr) as (...args: unknown[]) => boolean;
    const spy = spyOn(process.stderr, "write").mockImplementation(((
      chunk: unknown,
      ...rest: unknown[]
    ) => {
      if (typeof chunk === "string" && chunk.includes('"name":"ipc-pipe"')) {
        raw.push(chunk);
        return true;
      }
      return realWrite(chunk, ...rest);
    }) as unknown as typeof process.stderr.write);
    return {
      lines: () => raw.map((line) => JSON.parse(line) as Record<string, unknown>),
      restore: () => spy.mockRestore(),
    };
  }

  test("a pipe server that faults after listen is logged, one pino line per fault", async () => {
    // Clients of a dead pipe see only ENOENT, so this line is the one record of why: it must name
    // the pipe and carry the error.
    const log = captureIpcPipeLog();
    const pipe = captureNextNetServer();
    try {
      const path = listenPath();
      const host = forcedWin32();
      const server = createIpcServer(
        { listenPath: path, vault: createMockVault(), version: "0.0.0-net-arm" },
        host.platform,
      );
      servers.push(server);
      await server.start();
      pipe.restore();
      const netServer = pipe.server();
      expect(log.lines()).toEqual([]);

      const withStack = new Error("pipe handle invalidated");
      netServer.emit("error", withStack);
      // An error object that lost its stack is still logged — as the error itself.
      const noStack = new Error("pipe handle gone");
      Object.defineProperty(noStack, "stack", { value: undefined });
      netServer.emit("error", noStack);
      // An unrequested close, as when the pipe is torn down out from under the gateway.
      await new Promise<void>((resolve) => {
        netServer.close(() => resolve());
      });
      // The registry probe reads the server live: the closed pipe is no longer advertised as open.
      expect(ipcListenersAt(path)).toEqual([]);

      const shape = (event: string, err: unknown): Record<string, unknown> => ({
        level: 50,
        time: expect.any(Number),
        pid: process.pid,
        name: "ipc-pipe",
        event: `pipe_server_${event}`,
        listenPath: path,
        err,
        msg: `IPC named-pipe server ${event} after listen — clients will see ENOENT`,
      });
      expect(log.lines()).toEqual([
        shape("error", expect.stringContaining("Error: pipe handle invalidated\n")),
        shape("error", "Error: pipe handle gone"),
        shape("close", null),
      ]);

      // A gateway shutting down after the fault must not hang on the server that is already gone,
      // and closing it on purpose is not a further fault.
      await expect(server.stop()).resolves.toBeUndefined();
      expect(log.lines()).toHaveLength(3);
    } finally {
      pipe.restore();
      log.restore();
    }
  });

  test("a deliberate stop() of a live pipe server is not logged as a fault", async () => {
    const log = captureIpcPipeLog();
    try {
      const path = listenPath();
      const host = forcedWin32();
      const server = createIpcServer(
        { listenPath: path, vault: createMockVault(), version: "0.0.0-net-arm" },
        host.platform,
      );
      servers.push(server);
      await server.start();
      expect(host.asked()).toBeGreaterThan(0);
      const client = await LineClient.connect(path);
      client.send({ jsonrpc: "2.0", id: 1, method: "gateway.ping", params: {} });
      await client.next((m) => m["id"] === 1);

      await server.stop();
      expect(ipcListenersAt(path)).toEqual([]);
      expect(log.lines()).toEqual([]);
    } finally {
      log.restore();
    }
  });
});

describe("createIpcServer — broadcast", () => {
  test("a broadcast reaches every connected client as a JSON-RPC notification", async () => {
    const path = listenPath();
    const server = createIpcServer({
      listenPath: path,
      vault: createMockVault(),
      version: "0.0.0-test",
    });
    servers.push(server);
    await server.start();

    const clients = [await LineClient.connect(path), await LineClient.connect(path)];
    // A completed round-trip proves each session is attached before the broadcast goes out.
    for (const client of clients) {
      client.send({ jsonrpc: "2.0", id: 1, method: "gateway.ping", params: {} });
      await client.next((m) => m["id"] === 1);
    }

    server.broadcast("test.fanout", { seq: 42 });

    for (const client of clients) {
      expect(await client.next((m) => m["method"] === "test.fanout")).toEqual({
        jsonrpc: "2.0",
        method: "test.fanout",
        params: { seq: 42 },
      });
    }
  });
});
