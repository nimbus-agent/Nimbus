// Task 9 of the `nimbus tail` plan: end-to-end over a REAL gateway socket.
//
// Every other test in this plan asserts against an in-process sink (the emitter is called
// directly, or `setGatewayEventBroadcast` is bound to an in-process array). None of those would
// notice if `connector.healthChanged` were renamed — the desktop's `ConnectorGrid.tsx` and the
// CLI's `tail` command bind to that literal method name over the wire, and nothing in this repo
// re-derives it. This test boots a real gateway subprocess, connects a real Unix-socket/named-pipe
// client, and proves the bytes a rename would silently break actually arrive.
//
// Trigger: there is no IPC method that forces a health transition directly. This drives
// `connector.pause` — `ipc/connector-rpc.ts` -> `handleConnectorPause` -> `SyncScheduler.pause` ->
// `connectors/health.ts`'s `transitionHealth(db, id, { type: "paused" })` — which maps to
// `health: "paused"` / `reason: "connector paused"` and genuinely calls
// `emitConnectorHealthChanged`, a real production path rather than a test-only backdoor. `github`
// is registered with the scheduler unconditionally at boot (`registerConnectorMeshSyncables`, in
// `platform/assemble-sync-registrations.ts`) regardless of whether a credential is configured, so
// `connector.pause` succeeds against a fresh gateway with no setup.
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNNER = join(import.meta.dir, "..", "..", "e2e", "_fixtures", "gateway-runner.ts");

const BOOT_TIMEOUT_MS = 60_000;
const WAIT_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 120_000;

function pipeOrSocket(dir: string, tag: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\nimbus-tailstream-${tag}-${process.pid}-${randomUUID().slice(0, 8)}`
    : join(dir, `gw-${tag}.sock`);
}

/** Polls `probe` on a fixed interval instead of a single sleep — CI's temp-dir SQLite work is
 * 13-18x slower than a dev machine, so a fixed-delay wait is either flaky there or wastefully
 * slow here; a generous ceiling bounds the failure case instead. */
async function until(probe: () => boolean, what: string, ms: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (probe()) return;
    if (Date.now() - start > ms) {
      throw new Error(`timed out waiting for ${what} after ${String(ms)}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

type RpcReply = {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

/**
 * `packages/gateway/test/e2e/gateway-bind-first.e2e.test.ts`'s `TinyIpcClient` cannot be reused
 * as-is: its `onLine` does `if (typeof id !== "number") return;`, which drops every notification —
 * a frame with NO `id` is precisely what a JSON-RPC notification is. `ipc/server/server.ts`'s
 * `broadcastNotification` writes `{ jsonrpc: "2.0", method, params }` over the wire with no `id`
 * field at all, so that client would silently observe nothing this test cares about.
 *
 * This client routes id-less frames to per-method subscribers while still resolving id-bearing
 * responses. Proving notifications reach a real socket subscriber under the real method name is
 * the entire point of this test, so this client IS part of what is under test.
 */
class TailTestClient {
  private sock: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (v: RpcReply) => void>();
  private readonly subscribers = new Map<string, Array<(params: unknown) => void>>();

  connect(socketPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      sock.on("connect", () => resolve());
      sock.on("error", (e) => reject(e));
      sock.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        let idx = this.buffer.indexOf("\n");
        while (idx !== -1) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (line !== "") this.onLine(line);
          idx = this.buffer.indexOf("\n");
        }
      });
      this.sock = sock;
    });
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg["id"];
    if (typeof id === "number") {
      const cb = this.pending.get(id);
      if (cb === undefined) return;
      this.pending.delete(id);
      cb(msg as RpcReply);
      return;
    }
    // No `id` at all: a notification. Route by method name to every subscriber registered for it
    // — the exact seam `nimbus tail` and the desktop's `ConnectorGrid` bind to.
    const method = msg["method"];
    if (typeof method !== "string") return;
    const params = msg["params"];
    for (const cb of this.subscribers.get(method) ?? []) {
      cb(params);
    }
  }

  /** Registers a subscriber for a notification method. Multiple subscribers on the same method
   * (and the same client) all fire — used nowhere here, kept for symmetry with the real client. */
  onNotification(method: string, cb: (params: unknown) => void): void {
    const list = this.subscribers.get(method) ?? [];
    list.push(cb);
    this.subscribers.set(method, list);
  }

  raw(method: string, params: unknown): Promise<RpcReply> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.sock?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  disconnect(): void {
    this.sock?.destroy();
  }
}

interface TestGateway {
  connect(): Promise<TailTestClient>;
  /** Drives a REAL health transition through `connector.pause` on a short-lived driver
   * connection — see the file header for why this, and not a test-only backdoor, is the trigger. */
  transitionConnectorHealth(serviceId: string): Promise<void>;
  waitFor(probe: () => boolean, ms?: number): Promise<void>;
  stop(): Promise<void>;
}

async function startTestGateway(tag: string): Promise<TestGateway> {
  const tmp = mkdtempSync(join(tmpdir(), `nimbus-tailstream-${tag}-`));
  const paths = {
    configDir: join(tmp, "config"),
    dataDir: join(tmp, "data"),
    logDir: join(tmp, "logs"),
    socketPath: pipeOrSocket(tmp, tag),
    extensionsDir: join(tmp, "extensions"),
    tempDir: join(tmp, "tmp"),
  };
  mkdirSync(paths.configDir, { recursive: true });
  mkdirSync(paths.dataDir, { recursive: true });

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NIMBUS_E2E_PATHS_JSON: JSON.stringify(paths),
    // This test never touches search or embeddings; skipping the runtime avoids a real (or
    // stalled) MiniLM/CDN fetch slowing every boot down for no reason relevant to what is tested.
    NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
  };

  const proc = Bun.spawn(["bun", RUNNER], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  let log = "";
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) log += decoder.decode(chunk);
  };
  void collect(proc.stdout as ReadableStream<Uint8Array>);
  void collect(proc.stderr as ReadableStream<Uint8Array>);

  try {
    await until(
      () => log.includes("[gateway] ready (e2e)"),
      `${tag} gateway bind`,
      BOOT_TIMEOUT_MS,
    );
  } catch (e) {
    proc.kill();
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}\n--- gateway output ---\n${log.slice(-4000)}`,
    );
  }

  const clients: TailTestClient[] = [];
  let stopped = false;

  return {
    async connect(): Promise<TailTestClient> {
      const client = new TailTestClient();
      await client.connect(paths.socketPath);
      clients.push(client);
      return client;
    },

    async transitionConnectorHealth(serviceId: string): Promise<void> {
      const driver = new TailTestClient();
      await driver.connect(paths.socketPath);
      try {
        const reply = await driver.raw("connector.pause", { serviceId });
        if (reply.error !== undefined) {
          throw new Error(`connector.pause(${serviceId}) failed: ${JSON.stringify(reply.error)}`);
        }
      } finally {
        driver.disconnect();
      }
    },

    async waitFor(probe: () => boolean, ms = WAIT_TIMEOUT_MS): Promise<void> {
      await until(probe, "expected notification", ms);
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const c of clients) c.disconnect();
      proc.kill();
      try {
        await proc.exited;
      } catch {
        // best-effort — the process is being torn down regardless
      }
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/**
 * `registerConnectorMeshSyncables` registers close to 90 syncables unconditionally at boot, and
 * the scheduler eagerly runs a first tick for each of them — an unconfigured connector's `sync()`
 * short-circuits to a no-op `sync_success`, which itself emits `connector.healthChanged` (see
 * `sync/scheduler.ts`'s `runJob`). That background traffic is REAL production behaviour, not test
 * noise to suppress: a fresh gateway genuinely broadcasts health events for connectors this test
 * never touched. `"paused"` is therefore the only health value this filter needs, since nothing but
 * an explicit `connector.pause` (this test's own trigger) ever produces it — `nextState()` in
 * `connectors/health.ts` maps no other `HealthEvent` to `"paused"`.
 */
function isPausedGithub(params: unknown): boolean {
  const p = params as Record<string, unknown>;
  return p["name"] === "github" && p["health"] === "paused";
}

describe("tail stream over a real socket", () => {
  test(
    "a health transition arrives as connector.healthChanged with the desktop's fields",
    async () => {
      const gw = await startTestGateway("single");
      try {
        const client = await gw.connect();
        const seen: unknown[] = [];
        client.onNotification("connector.healthChanged", (params) => seen.push(params));

        await gw.transitionConnectorHealth("github");
        await gw.waitFor(() => seen.some(isPausedGithub));

        // Exactly one — a duplicate delivery of the SAME transition would be its own bug (the
        // broadcast fan-out re-delivering, or the gate double-firing), distinct from the
        // background noise this filter already excludes.
        const matches = seen.filter(isPausedGithub);
        expect(matches).toHaveLength(1);
        const p = matches[0] as Record<string, unknown>;
        // The two fields ConnectorGrid actually reads. A rename breaks HERE, loudly.
        expect(p["name"]).toBe("github");
        expect(p["health"]).toBe("paused");
      } finally {
        await gw.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "every connected client receives the same broadcast",
    async () => {
      // `broadcastNotification` fans out per session. A second `tail` must not starve the first,
      // and the desktop must not miss what the CLI saw.
      const gw = await startTestGateway("fanout");
      try {
        const a = await gw.connect();
        const b = await gw.connect();
        const seenA: unknown[] = [];
        const seenB: unknown[] = [];
        a.onNotification("connector.healthChanged", (p) => seenA.push(p));
        b.onNotification("connector.healthChanged", (p) => seenB.push(p));

        await gw.transitionConnectorHealth("github");
        await gw.waitFor(() => seenA.some(isPausedGithub) && seenB.some(isPausedGithub));

        const matchesA = seenA.filter(isPausedGithub);
        const matchesB = seenB.filter(isPausedGithub);
        expect(matchesA).toHaveLength(1);
        expect(matchesB).toHaveLength(1);
        expect(matchesA[0]).toEqual(matchesB[0]);
      } finally {
        await gw.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
