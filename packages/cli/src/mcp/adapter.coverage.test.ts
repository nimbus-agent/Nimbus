/**
 * Coverage for the parts of `adapter.ts` the main suite never reaches: the production deps
 * (`createProductionDeps`, the real gateway-state read and IPC connect), the shipped stdio entry
 * point (`runMcpServerStdio`), the MCP registration callback that actually runs a tool, and the
 * wrapper's `disconnect` forwarding — plus connection state the main suite reaches but never pins
 * (an unexpected close invalidating the cache, a reconnect re-enabling the agent tools, the demo
 * flag on a refused connect, `offNotification` keeping the raw client as `this`).
 *
 * Kept apart from `adapter.test.ts` because that file also exercises the sibling modules
 * (`client-surface.ts`, `errors.ts`); everything here is about `adapter.ts` alone.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import type { CliPlatformPaths } from "../paths.ts";
import {
  type AdapterDeps,
  AGENT_TOOLS_UNSUPPORTED_MESSAGE,
  buildMcpServer,
  type ConnectionEnv,
  createDeps,
  createProductionDeps,
  GatewayUnavailableError,
  INDEX_TOOL_SPECS,
  type IpcCallable,
  type ProductionIo,
  runMcpServerStdio,
  TOOL_SPECS,
  type ToolSpec,
} from "./adapter.ts";
import { supportsNotifications } from "./client-surface.ts";

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function envFor(raw: IpcCallable): ConnectionEnv {
  return {
    readState: () => Promise.resolve({ socketPath: "unused-by-the-fake" }),
    connect: () => Promise.resolve(raw),
  };
}

type RecordedCall = { method: string; params: unknown };

/** A connected gateway that answers every call with `result` and records what it was asked. */
function recordingDeps(result: unknown): { deps: AdapterDeps; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: IpcCallable = {
    call: <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      return Promise.resolve(result as T);
    },
    disconnect: () => Promise.resolve(),
  };
  return { deps: { getClient: () => Promise.resolve(client) }, calls };
}

function spec(name: string): ToolSpec {
  const found = TOOL_SPECS.find((s) => s.name === name);
  if (found === undefined) {
    throw new Error(`no tool spec ${name}`);
  }
  return found;
}

/** The text of the first content block of an MCP tool result, failing loudly on any other shape. */
function firstText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new Error(`tool result has no content array: ${JSON.stringify(result)}`);
  }
  const block = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (block?.type !== "text" || typeof block.text !== "string") {
    throw new Error(`first content block is not text: ${JSON.stringify(block)}`);
  }
  return block.text;
}

function sortedNames(specs: readonly { name: string }[]): string[] {
  return specs.map((s) => s.name).sort((a, b) => a.localeCompare(b));
}

describe("the client getClient() hands out — connection teardown", () => {
  test("closes the raw connection, once per call", async () => {
    let disconnects = 0;
    const raw: IpcCallable = {
      call: <T>(): Promise<T> => Promise.resolve({} as T),
      disconnect: () => {
        disconnects += 1;
        return Promise.resolve();
      },
    };
    const client = await createDeps(envFor(raw)).getClient();
    expect(disconnects).toBe(0);
    await client.disconnect();
    expect(disconnects).toBe(1);
  });

  test("surfaces the raw connection's disconnect failure rather than swallowing it", async () => {
    const failure = new Error("pipe already closed");
    const raw: IpcCallable = {
      call: <T>(): Promise<T> => Promise.resolve({} as T),
      disconnect: () => Promise.reject(failure),
    };
    const client = await createDeps(envFor(raw)).getClient();
    await expect(client.disconnect()).rejects.toBe(failure);
  });

  test("after a dropped call, a failing teardown is swallowed and the caller sees the drop", async () => {
    // The wrapper tears the dead connection down itself (fire-and-forget). If that teardown also
    // fails, the failure must not escape as an unhandled rejection, and must not replace the error
    // the caller is actually owed.
    let teardowns = 0;
    let connects = 0;
    const raw: IpcCallable = {
      call: <T>(method: string): Promise<T> =>
        method === "session.declareKind"
          ? Promise.resolve({} as T)
          : Promise.reject(new Error("IPC connection closed")),
      disconnect: () => {
        teardowns += 1;
        return Promise.reject(new Error("socket already destroyed"));
      },
    };
    const deps = createDeps({
      readState: () => Promise.resolve({ socketPath: "unused-by-the-fake" }),
      connect: () => {
        connects += 1;
        return Promise.resolve(raw);
      },
    });
    const client = await deps.getClient();
    const err = await client.call("index.searchRanked", {}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("IPC connection closed");
    expect(teardowns).toBe(1);
    // Let the rejected teardown settle inside this test, so an unswallowed rejection fails HERE.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    // The drop also invalidated the cache: the next getClient opens a fresh connection.
    await deps.getClient();
    expect(connects).toBe(2);
  });
});

describe("the cached connection — what must not outlive it", () => {
  test("an unexpected transport close drops the cached client, so the next getClient reconnects", async () => {
    // A gateway that dies while NO call is in flight is seen only through onClose; if that did not
    // invalidate the cache, every later tool call would be handed the dead client.
    let fireClose: ((err: Error) => void) | undefined;
    let connects = 0;
    const raw = {
      call: <T>(): Promise<T> => Promise.resolve({} as T),
      disconnect: (): Promise<void> => Promise.resolve(),
      onClose(handler: (err: Error) => void): void {
        fireClose = handler;
      },
      offClose(_handler: (err: Error) => void): void {},
    };
    const deps = createDeps({
      readState: () => Promise.resolve({ socketPath: "unused-by-the-fake" }),
      connect: () => {
        connects += 1;
        return Promise.resolve(raw);
      },
    });
    const first = await deps.getClient();
    // Control: while the connection is healthy, the client is cached.
    expect(await deps.getClient()).toBe(first);
    expect(connects).toBe(1);
    expect(fireClose).toBeDefined();

    fireClose?.(new Error("IPC connection closed"));
    const second = await deps.getClient();
    expect(connects).toBe(2);
    expect(second).not.toBe(first);
  });

  test("an upgraded gateway reached on reconnect re-enables the agent tools an old one disabled", async () => {
    // The first connection reaches a gateway too old for session.declareKind, so the agent tools
    // are withheld; that connection then drops, and the next one reaches a gateway that accepts it.
    // Withholding is a property of the CONNECTION, so it must not survive into the new one.
    const peeks: unknown[] = [];
    const oldGateway: IpcCallable = {
      call: <T>(method: string): Promise<T> =>
        Promise.reject(
          new Error(
            method === "session.declareKind" ? "Method not found" : "IPC connection closed",
          ),
        ),
      disconnect: () => Promise.resolve(),
    };
    const upgraded: IpcCallable = {
      call: <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "agents.whyPeek") {
          peeks.push(params);
        }
        return Promise.resolve({ summary: "added in #12" } as T);
      },
      disconnect: () => Promise.resolve(),
    };
    const gateways = [oldGateway, upgraded];
    const deps = createDeps({
      readState: () => Promise.resolve({ socketPath: "unused-by-the-fake" }),
      connect: () => {
        const next = gateways.shift();
        return next === undefined
          ? Promise.reject(new Error("no further gateway scripted"))
          : Promise.resolve(next);
      },
    });

    const { result: first, stderr } = await captureStderr(() => deps.getClient());
    expect(stderr).toContain("agent tools are DISABLED");
    expect(deps.agentToolsDisabledReason?.()).toBe(AGENT_TOOLS_UNSUPPORTED_MESSAGE);
    const withheld = await spec("peekWhy").run(deps, { ref: "src/a.ts" });
    expect(withheld.isError).toBe(true);
    expect(firstText(withheld)).toBe(AGENT_TOOLS_UNSUPPORTED_MESSAGE);

    await expect(first.call("index.searchRanked", {})).rejects.toThrow("IPC connection closed");
    const second = await deps.getClient();
    expect(second).not.toBe(first);
    expect(deps.agentToolsDisabledReason?.()).toBeUndefined();
    const served = await spec("peekWhy").run(deps, { ref: "src/a.ts" });
    expect(served.isError).toBeUndefined();
    expect(firstText(served)).toContain("added in #12");
    expect(peeks).toEqual([{ ref: "src/a.ts" }]);
  });

  test("offNotification reaches the raw client as a method call, with the raw client as `this`", async () => {
    // The real IPC client is a class whose methods read their own state through `this`. Forwarding
    // the bare function would detach it, so unbinding a brief listener would throw instead.
    class HandlerTable implements IpcCallable {
      private readonly handlers = new Map<string, Set<(params: unknown) => void>>();

      call<T>(): Promise<T> {
        return Promise.resolve({} as T);
      }

      disconnect(): Promise<void> {
        return Promise.resolve();
      }

      onNotification(method: string, handler: (params: unknown) => void): void {
        const set = this.handlers.get(method) ?? new Set<(params: unknown) => void>();
        set.add(handler);
        this.handlers.set(method, set);
      }

      offNotification(method: string, handler: (params: unknown) => void): void {
        this.handlers.get(method)?.delete(handler);
      }

      count(method: string): number {
        return this.handlers.get(method)?.size ?? 0;
      }
    }
    const raw = new HandlerTable();
    const client = await createDeps(envFor(raw)).getClient();
    if (!supportsNotifications(client) || client.offNotification === undefined) {
      throw new Error("the client getClient() handed out lost the raw client's notification API");
    }
    const handler = (): void => {};
    client.onNotification("why.briefReady", handler);
    expect(raw.count("why.briefReady")).toBe(1);
    client.offNotification("why.briefReady", handler);
    expect(raw.count("why.briefReady")).toBe(0);
  });
});

describe("tools run directly, without the SDK's schema validation in front", () => {
  // `run` is exported and reachable without zod (unit callers, future in-process callers). A
  // missing required argument must still produce a well-formed request the GATEWAY can refuse,
  // never a crash or an `undefined` on the wire.
  test("findPrsNotTouching with no pathGlob sends an empty glob, pinned to the pr type", async () => {
    const { deps, calls } = recordingDeps({ status: "refused", reason: "invalid_glob" });
    const out = await spec("findPrsNotTouching").run(deps, {});
    expect(calls).toEqual([
      { method: "index.queryItems", params: { types: ["pr"], notTouching: "", limit: 20 } },
    ]);
    expect(firstText(out)).toContain("invalid_glob");
  });

  test("peekWhy with no ref sends an empty ref to agents.whyPeek", async () => {
    const { deps, calls } = recordingDeps({ summary: "no such ref" });
    const out = await spec("peekWhy").run(deps, {});
    expect(calls).toEqual([{ method: "agents.whyPeek", params: { ref: "" } }]);
    expect(out.isError).toBeUndefined();
    expect(firstText(out)).toContain("no such ref");
  });
});

/** Connect a real MCP client to `server` over an in-memory transport pair. */
async function connectEditor(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const editor = new Client({ name: "editor", version: "0" });
  await Promise.all([server.connect(serverTransport), editor.connect(clientTransport)]);
  return editor;
}

describe("a registered tool reached through MCP tools/call", () => {
  test("runs with the arguments the schema validated, and returns projected rows", async () => {
    const { deps, calls } = recordingDeps([
      {
        name: "Fix login bug",
        service: "github",
        indexedType: "pr",
        score: 0.9,
        rawMeta: { state: "open", secret_token: "must-not-leak" },
      },
    ]);
    const editor = await connectEditor(buildMcpServer(deps));
    try {
      const res = await editor.callTool({
        name: "searchIndex",
        arguments: { query: "login", limit: 3, semantic: false },
      });
      expect(calls).toEqual([
        {
          method: "index.searchRanked",
          params: { name: "login", limit: 3, semantic: false, contextChunks: 0, envelope: true },
        },
      ]);
      expect(res.isError).toBeUndefined();
      expect(JSON.parse(firstText(res)) as unknown).toEqual([
        {
          name: "Fix login bug",
          service: "github",
          type: "pr",
          score: 0.9,
          meta: { state: "open" },
        },
      ]);
    } finally {
      await editor.close();
    }
  });

  test("refuses arguments the schema rejects before anything reaches the gateway", async () => {
    const { deps, calls } = recordingDeps([]);
    const editor = await connectEditor(buildMcpServer(deps));
    try {
      const res = await editor.callTool({ name: "searchIndex", arguments: { query: 42 } });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toContain("Invalid arguments for tool searchIndex");
      expect(calls).toHaveLength(0);
    } finally {
      await editor.close();
    }
  });
});

// ---- runMcpServerStdio: the shipped entry point, over the process's own stdio ----

interface SwappedStdio {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
}

type StdioKey = "stdin" | "stdout";

/**
 * Run `fn` with `process.stdin`/`process.stdout` replaced by in-memory streams, returning them.
 *
 * `runMcpServerStdio` builds `new StdioServerTransport()` with no arguments, which binds the
 * PROCESS streams at construction — so this swap is the only way to drive the shipped entry point
 * in-process without it reading the test runner's stdin or writing protocol frames into the
 * runner's output. The window is exactly the call: the transport keeps its own references once
 * built, and both descriptors are restored in `finally` even when the call throws.
 */
async function withSwappedStdio(fn: () => Promise<void>): Promise<SwappedStdio> {
  const io: SwappedStdio = { stdin: new PassThrough(), stdout: new PassThrough() };
  const saved: Record<StdioKey, PropertyDescriptor | undefined> = {
    stdin: Object.getOwnPropertyDescriptor(process, "stdin"),
    stdout: Object.getOwnPropertyDescriptor(process, "stdout"),
  };
  const restore = (key: StdioKey): void => {
    const descriptor = saved[key];
    if (descriptor === undefined) {
      Reflect.deleteProperty(process, key);
    } else {
      Object.defineProperty(process, key, descriptor);
    }
  };
  for (const key of ["stdin", "stdout"] as const) {
    Object.defineProperty(process, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: io[key],
    });
  }
  try {
    await fn();
  } finally {
    restore("stdin");
    restore("stdout");
  }
  return io;
}

/** Record `process.stderr` writes for the duration of `fn` (restored in `finally`). */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stderr: chunks.join("") };
  } finally {
    process.stderr.write = original;
  }
}

/**
 * The editor's end of a stdio MCP session: it writes what the server reads on stdin and reads what
 * the server writes on stdout, using the SDK's own newline-delimited JSON-RPC framing.
 */
class EditorStdioTransport implements Transport {
  onmessage?: NonNullable<Transport["onmessage"]>;
  onclose?: NonNullable<Transport["onclose"]>;
  onerror?: NonNullable<Transport["onerror"]>;
  private readonly buffer = new ReadBuffer();
  private readonly toServer: PassThrough;
  private readonly fromServer: PassThrough;
  private readonly onData = (chunk: Buffer): void => {
    this.buffer.append(chunk);
    for (let m = this.buffer.readMessage(); m !== null; m = this.buffer.readMessage()) {
      this.onmessage?.(m);
    }
  };

  constructor(io: SwappedStdio) {
    this.toServer = io.stdin;
    this.fromServer = io.stdout;
  }

  start(): Promise<void> {
    this.fromServer.on("data", this.onData);
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    this.toServer.write(serializeMessage(message));
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.fromServer.off("data", this.onData);
    this.onclose?.();
    return Promise.resolve();
  }
}

async function connectOverStdio(io: SwappedStdio): Promise<Client> {
  const editor = new Client({ name: "editor", version: "0" });
  await editor.connect(new EditorStdioTransport(io));
  return editor;
}

describe("runMcpServerStdio", () => {
  test("serves every tool over the process's stdio, and a call round-trips through the framing", async () => {
    const gatewayCalls: string[] = [];
    const raw: IpcCallable = {
      call: <T>(method: string): Promise<T> => {
        gatewayCalls.push(method);
        const rows = [{ serviceId: "github", healthState: "healthy" }];
        return Promise.resolve((method === "connector.listStatus" ? rows : {}) as T);
      },
      disconnect: () => Promise.resolve(),
    };
    const io = await withSwappedStdio(() => runMcpServerStdio(createDeps(envFor(raw))));
    // Bound to the swapped streams, and silent until the editor speaks: stdout is the protocol
    // channel, so a stray write here would corrupt the session.
    expect(process.stdout).not.toBe(io.stdout);
    expect(io.stdout.readableLength).toBe(0);

    const editor = await connectOverStdio(io);
    try {
      const { tools } = await editor.listTools();
      expect(sortedNames(tools)).toEqual(sortedNames(TOOL_SPECS));
      const res = await editor.callTool({ name: "getConnectorStatus", arguments: {} });
      expect(res.isError).toBeUndefined();
      expect(firstText(res)).toContain('"healthState": "healthy"');
      expect(gatewayCalls).toEqual(["session.declareKind", "connector.listStatus"]);
    } finally {
      await editor.close();
    }
  });

  test("against a gateway without session.declareKind it registers only the index tools", async () => {
    // The fail-closed property at the REAL entry point: if this function ever built the server
    // without the capability probe, the agent tools would be served unrecorded.
    const raw: IpcCallable = {
      call: <T>(method: string): Promise<T> =>
        method === "session.declareKind"
          ? Promise.reject(new Error("Method not found"))
          : Promise.resolve({} as T),
      disconnect: () => Promise.resolve(),
    };
    const { result: io, stderr } = await captureStderr(() =>
      withSwappedStdio(() => runMcpServerStdio(createDeps(envFor(raw)))),
    );
    // The upgrade warning went to stderr — never onto the protocol channel.
    expect(stderr).toContain("agent tools are DISABLED");
    expect(io.stdout.readableLength).toBe(0);

    const editor = await connectOverStdio(io);
    try {
      const { tools } = await editor.listTools();
      expect(sortedNames(tools)).toEqual(sortedNames(INDEX_TOOL_SPECS));
      // Not registered at all, as opposed to registered-but-refusing.
      const res = await editor.callTool({ name: "peekWhy", arguments: { ref: "src/a.ts" } });
      expect(res.isError).toBe(true);
      expect(firstText(res)).toContain("Tool peekWhy not found");
    } finally {
      await editor.close();
    }
  });
});

// ---- createProductionDeps: the real gateway-state read and the real IPC connect ----

type EnvPatch = Readonly<Record<string, string | undefined>>;

function applyEnv(patch: EnvPatch): EnvPatch {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(patch)) {
    saved[key] = process.env[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  return saved;
}

async function withEnv<T>(patch: EnvPatch, fn: () => Promise<T> | T): Promise<T> {
  const saved = applyEnv(patch);
  try {
    return await fn();
  } finally {
    applyEnv(saved);
  }
}

/** Every variable that selects a different CLI root (a demo root, or a relocated config/socket). */
const ROOT_SELECTORS = ["NIMBUS_DEMO", "NIMBUS_CONFIG_DIR", "NIMBUS_GATEWAY_SOCKET"] as const;

const UNSET_ROOT_SELECTORS: EnvPatch = Object.fromEntries(
  ROOT_SELECTORS.map((k) => [k, undefined]),
);

/** A fresh IPC endpoint name: a named pipe on Windows, a socket file under `root` elsewhere. */
function freshSocketPath(root: string, label: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\nimbus-mcp-${label}-${randomUUID()}`
    : join(root, `${label}.sock`);
}

interface FakeGateway {
  /** Every JSON-RPC request received, in order. */
  readonly requests: RecordedCall[];
  close(): Promise<void>;
}

/** A minimal NDJSON JSON-RPC 2.0 endpoint — the wire shape the real gateway speaks to IPCClient. */
async function startFakeGateway(
  socketPath: string,
  results: Readonly<Record<string, unknown>>,
): Promise<FakeGateway> {
  const requests: RecordedCall[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    let pending = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      pending += chunk;
      for (let nl = pending.indexOf("\n"); nl !== -1; nl = pending.indexOf("\n")) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        const msg = JSON.parse(line) as { id?: unknown; method?: unknown; params?: unknown };
        if (typeof msg.method !== "string") {
          continue;
        }
        requests.push({ method: msg.method, params: msg.params });
        if (msg.id !== undefined) {
          const result = results[msg.method] ?? null;
          sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
        }
      }
    });
    sock.on("error", () => undefined);
    sock.on("close", () => {
      sockets.delete(sock);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      resolve();
    });
  });
  return {
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const sock of sockets) {
          sock.destroy();
        }
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * `createProductionDeps`'s I/O closures read `lib/gateway-process.ts` and `ipc-client/index.ts`,
 * and `test/helpers/cli-mocks.ts` replaces BOTH with a process-global `mock.module` for the rest of
 * any combined `bun test` run (the leak that forced `lib/gw-state-helpers.ts`). In-process, these
 * scenarios would exercise the fixture-driven fakes whenever a command test ran first. So they run
 * in a fresh bun process — the probe below — against a fake gateway hosted HERE.
 */
const PRODUCTION_DEPS_PROBE = join(
  import.meta.dir,
  "..",
  "..",
  "test",
  "fixtures",
  "mcp-production-deps-probe.ts",
);

/**
 * A cold child (transpile + the MCP SDK's module graph) can take seconds on a loaded CI runner,
 * notably Windows; the test's own timeout sits above this so the deadline reports by name.
 */
const PROBE_DEADLINE_MS = 30_000;

/**
 * The child's env: every variable `getCliPlatformPaths()` derives a data directory from points
 * into `root` (set at spawn, so darwin's `homedir()` sees it), and every root selector is unset —
 * `NIMBUS_DEMO=1` combined with a relocated socket or config dir is refused outright.
 *
 * The one exception is `NIMBUS_GATEWAY_SOCKET`, set to an endpoint nothing listens on. The paths'
 * DEFAULT socket is a live gateway's address — machine-global on Windows, the developer's own
 * runtime dir elsewhere — and production must never dial it here (it dials the socket the state
 * file names). Should a regression dial it anyway, it now fails as "not running" instead of
 * reaching that gateway. The probe lifts the variable for its demo scenario, whose socket is
 * derived from `root` already.
 */
function probeEnv(root: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    APPDATA: join(root, "AppData", "Roaming"),
    LOCALAPPDATA: join(root, "AppData", "Local"),
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
  };
  for (const key of ROOT_SELECTORS) {
    Reflect.deleteProperty(env, key);
  }
  env["NIMBUS_GATEWAY_SOCKET"] = freshSocketPath(root, "paths-default");
  return env;
}

interface ProbeRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Spawned asynchronously with an explicit deadline (see `tui/dumb-terminal.test.ts` for why). */
async function runProductionDepsProbe(
  root: string,
  liveSocket: string,
  deadSocket: string,
): Promise<ProbeRun> {
  const proc = Bun.spawn([process.execPath, PRODUCTION_DEPS_PROBE, root, liveSocket, deadSocket], {
    env: probeEnv(root),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, PROBE_DEADLINE_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(deadline);
  }
}

interface ProbeReport {
  readonly noState: unknown;
  readonly noStateDemo: unknown;
  readonly demoFlag: unknown;
  readonly deadSocket: unknown;
  readonly live: unknown;
}

describe("createProductionDeps", () => {
  test("takes its demo flag from the same paths resolver the connection uses", async () => {
    await withEnv({ ...UNSET_ROOT_SELECTORS, NIMBUS_DEMO: "1" }, () => {
      expect(createProductionDeps().demo).toBe(true);
    });
    await withEnv(UNSET_ROOT_SELECTORS, () => {
      expect(createProductionDeps().demo).toBe(false);
    });
  });

  test("reads the state file the CLI paths name, connects there, and declares itself MCP first", async () => {
    const root = tempRoot("nimbus-mcp-prod-");
    const liveSocket = freshSocketPath(root, "gateway");
    const rows = [{ serviceId: "github", healthState: "healthy" }];
    const gateway = await startFakeGateway(liveSocket, {
      "session.declareKind": { ok: true },
      "connector.listStatus": rows,
    });
    try {
      const run = await runProductionDepsProbe(root, liveSocket, freshSocketPath(root, "absent"));
      if (run.code !== 0 || run.timedOut) {
        throw new Error(
          `probe exited ${String(run.code)}${run.timedOut ? " (killed at deadline)" : ""}:\n${run.stderr}`,
        );
      }
      const report = JSON.parse(run.stdout) as ProbeReport;
      const unavailable = (demo: boolean): { name: string; message: string } => {
        const e = new GatewayUnavailableError({ demo });
        return { name: e.name, message: e.message };
      };
      expect(report.noState).toEqual(unavailable(false));
      // Demo-rooted, the same failure names the DEMO gateway's start command instead.
      expect(report.noStateDemo).toEqual(unavailable(true));
      expect(report.noStateDemo).not.toEqual(report.noState);
      expect(report.demoFlag).toBe(true);
      expect(report.deadSocket).toEqual(unavailable(false));
      expect(report.live).toEqual({ listed: rows, agentToolsDisabledReason: null });
      // Attribution is the first thing on the wire (invariant I29), before any tool call — and the
      // dead-socket scenario before it never reached this endpoint at all.
      expect(gateway.requests).toEqual([
        { method: "session.declareKind", params: { kind: "mcp" } },
        { method: "connector.listStatus", params: undefined },
      ]);
    } finally {
      await gateway.close();
    }
  }, 45_000);
});

// ---- createProductionDeps's composition, with the real I/O swapped for a scripted stand-in ----
//
// The probe above proves the DEFAULT wiring end to end, but from a child process this file's
// coverage cannot see. These drive the same composition in-process through `ProductionIo`.

/** A complete paths record whose fields are labels, never touched on disk. */
function scriptedPaths(label: string, demo: boolean): CliPlatformPaths {
  const paths: CliPlatformPaths = {
    configDir: `config-${label}`,
    dataDir: `data-${label}`,
    logDir: `log-${label}`,
    socketPath: `paths-socket-${label}`,
    extensionsDir: `extensions-${label}`,
    tempDir: `temp-${label}`,
  };
  return demo ? { ...paths, demo: true } : paths;
}

interface IoScript {
  readonly paths: CliPlatformPaths;
  /** What each successive state read returns; the last entry repeats. */
  readonly states: ReadonlyArray<{ readonly socketPath: string; readonly pid: number } | undefined>;
  /** How many leading `connect()` calls reject (each with ECONNREFUSED). */
  readonly refusedConnects?: number;
  /** A method whose call on the FIRST client dies as a dropped transport. */
  readonly droppedMethod?: string;
}

/**
 * A `ProductionIo` that records, in order, every state read (by the `dataDir` it was given), every
 * client construction, connect, call and disconnect (by the socket the client was opened on).
 */
function scriptedIo(script: IoScript): { io: ProductionIo; events: string[] } {
  const events: string[] = [];
  let stateReads = 0;
  let connects = 0;
  let constructed = 0;

  class ScriptedClient implements IpcCallable {
    readonly socketPath: string;
    readonly ordinal: number;

    constructor(socketPath: string) {
      constructed += 1;
      this.ordinal = constructed;
      this.socketPath = socketPath;
      events.push(`new(${socketPath})`);
    }

    connect(): Promise<void> {
      connects += 1;
      if (connects <= (script.refusedConnects ?? 0)) {
        events.push(`connect(${this.socketPath}) refused`);
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      events.push(`connect(${this.socketPath})`);
      return Promise.resolve();
    }

    call<T>(method: string, params?: unknown): Promise<T> {
      events.push(`call(${this.socketPath} ${method} ${JSON.stringify(params) ?? "-"})`);
      if (this.ordinal === 1 && method === script.droppedMethod) {
        return Promise.reject(new Error("IPC connection closed"));
      }
      return Promise.resolve({ answeredBy: this.socketPath } as T);
    }

    disconnect(): Promise<void> {
      events.push(`disconnect(${this.socketPath})`);
      return Promise.resolve();
    }
  }

  const io: ProductionIo = {
    paths: () => script.paths,
    readGatewayState: (paths) => {
      events.push(`readState(${paths.dataDir})`);
      const state = script.states[Math.min(stateReads, script.states.length - 1)];
      stateReads += 1;
      return Promise.resolve(state);
    },
    IpcClient: ScriptedClient,
  };
  return { io, events };
}

/** Settle whatever `getClient()` does, as a value: the client, or the error it rejected with. */
async function settle(deps: AdapterDeps): Promise<IpcCallable | Error> {
  try {
    return await deps.getClient();
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

const DECLARE_MCP = `session.declareKind ${JSON.stringify({ kind: "mcp" })}`;

describe("createProductionDeps — the composition, with injected I/O", () => {
  test("reads the state from the resolver's paths, opens the socket it names, connects, then declares MCP", async () => {
    const { io, events } = scriptedIo({
      paths: scriptedPaths("A", false),
      states: [{ socketPath: "sock-1", pid: 4242 }],
    });
    const deps = createProductionDeps(io);
    expect(deps.demo).toBe(false);
    // Lazy: building the deps reads nothing and opens nothing.
    expect(events).toEqual([]);

    const client = await deps.getClient();
    // The client is constructed on the STATE's socket (never the paths record's own default), it
    // is connected before anything is sent, and attribution is the first thing on the wire (I29).
    expect(events).toEqual([
      "readState(data-A)",
      "new(sock-1)",
      "connect(sock-1)",
      `call(sock-1 ${DECLARE_MCP})`,
    ]);
    expect(deps.agentToolsDisabledReason?.()).toBeUndefined();

    expect(await client.call<unknown>("connector.listStatus")).toEqual({ answeredBy: "sock-1" });
    // Cached: a second getClient neither re-reads the state nor reconnects.
    expect(await deps.getClient()).toBe(client);
    expect(events.slice(4)).toEqual(["call(sock-1 connector.listStatus -)"]);
  });

  test("with no state file it fails as 'not running' and never builds a client", async () => {
    const { io, events } = scriptedIo({ paths: scriptedPaths("A", false), states: [undefined] });
    const err = await settle(createProductionDeps(io));
    expect(err).toBeInstanceOf(GatewayUnavailableError);
    expect((err as Error).message).toBe(new GatewayUnavailableError({ demo: false }).message);
    expect(events).toEqual(["readState(data-A)"]);
  });

  test("a demo-rooted resolver sets the demo flag, so the same failure names the demo gateway", async () => {
    const real = new GatewayUnavailableError({ demo: false }).message;
    const demo = new GatewayUnavailableError({ demo: true }).message;
    // The two messages genuinely differ, so the equality below is evidence of the demo arm.
    expect(demo).not.toBe(real);

    const { io, events } = scriptedIo({ paths: scriptedPaths("D", true), states: [undefined] });
    const deps = createProductionDeps(io);
    expect(deps.demo).toBe(true);
    const err = await settle(deps);
    expect(err).toBeInstanceOf(GatewayUnavailableError);
    expect((err as Error).message).toBe(demo);
    expect(events).toEqual(["readState(data-D)"]);
  });

  test("demo-rooted, a state file whose socket refuses the connect also names the demo gateway", async () => {
    // The other way to be "not running": a stale state file left by a gateway that has since died.
    // That failure is raised on a different arm than the missing-state one above, so the demo flag
    // has to reach both.
    const { io, events } = scriptedIo({
      paths: scriptedPaths("D", true),
      states: [{ socketPath: "sock-stale", pid: 7 }],
      refusedConnects: 1,
    });
    const err = await settle(createProductionDeps(io));
    expect(err).toBeInstanceOf(GatewayUnavailableError);
    expect((err as Error).message).toBe(new GatewayUnavailableError({ demo: true }).message);
    expect(events).toEqual(["readState(data-D)", "new(sock-stale)", "connect(sock-stale) refused"]);
  });

  test("a client whose connect() fails is never called or handed out; the next attempt starts over", async () => {
    const { io, events } = scriptedIo({
      paths: scriptedPaths("A", false),
      states: [{ socketPath: "sock-1", pid: 1 }],
      refusedConnects: 1,
    });
    const deps = createProductionDeps(io);
    const first = await settle(deps);
    expect(first).toBeInstanceOf(GatewayUnavailableError);
    expect(events).toEqual(["readState(data-A)", "new(sock-1)", "connect(sock-1) refused"]);

    const second = await settle(deps);
    expect(second).not.toBeInstanceOf(Error);
    // A fresh state read and a fresh client — the refused one was dropped, not retried.
    expect(events.slice(3)).toEqual([
      "readState(data-A)",
      "new(sock-1)",
      "connect(sock-1)",
      `call(sock-1 ${DECLARE_MCP})`,
    ]);
  });

  test("after a dropped connection, the next getClient re-reads the state and opens the socket it names NOW", async () => {
    // A restarted gateway listens somewhere new and rewrites its state file; a reconnect that
    // reused the first socket would retry a dead endpoint forever.
    const { io, events } = scriptedIo({
      paths: scriptedPaths("A", false),
      states: [
        { socketPath: "sock-1", pid: 1 },
        { socketPath: "sock-2", pid: 2 },
      ],
      droppedMethod: "index.searchRanked",
    });
    const deps = createProductionDeps(io);
    const first = await deps.getClient();
    await expect(first.call("index.searchRanked", { name: "q" })).rejects.toThrow(
      "IPC connection closed",
    );
    const second = await deps.getClient();
    expect(second).not.toBe(first);
    expect(await second.call<unknown>("connector.listStatus")).toEqual({ answeredBy: "sock-2" });
    expect(events).toEqual([
      "readState(data-A)",
      "new(sock-1)",
      "connect(sock-1)",
      `call(sock-1 ${DECLARE_MCP})`,
      `call(sock-1 index.searchRanked ${JSON.stringify({ name: "q" })})`,
      // The wrapper tears the dead connection down itself.
      "disconnect(sock-1)",
      "readState(data-A)",
      "new(sock-2)",
      "connect(sock-2)",
      `call(sock-2 ${DECLARE_MCP})`,
      "call(sock-2 connector.listStatus -)",
    ]);
  });
});
