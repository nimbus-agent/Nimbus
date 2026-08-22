// Sandboxed code execution (S2 slice 1) end-to-end: a REAL gateway subprocess driven over IPC.
//
// This is the only test that proves the WIRE. `ipc/exec-rpc.test.ts` exercises the handlers with a
// real consent broker, and `exec/exec-gate.test.ts` exercises the gate — but both would still pass
// with the dispatcher unregistered in `dispatchers.ts` or `execRpcCtx` unwired in `assemble.ts`,
// which is the "both ends tested, dead feature" shape this tree has shipped before. Here the
// approval prompt genuinely crosses the socket and the answer genuinely comes back.
//
// Embeddings are skipped (NIMBUS_SKIP_EMBEDDING_RUNTIME=1); nothing here needs the index.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

type NotificationHandler = (params: Record<string, unknown>) => void;

class TestIpcClient {
  private sock: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
  private readonly notifyHandlers = new Map<string, NotificationHandler>();

  private failAllPending(reason: string): void {
    for (const [, cb] of this.pending) cb({ error: { message: reason } });
    this.pending.clear();
  }

  async connect(socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      sock.on("connect", () => resolve());
      sock.on("error", (e) => {
        reject(e);
        this.failAllPending(`socket error: ${e.message}`);
      });
      sock.on("close", () => this.failAllPending("socket closed"));
      sock.on("data", (chunk) => {
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

  onNotification(method: string, handler: NotificationHandler): void {
    this.notifyHandlers.set(method, handler);
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg["id"];
    if (typeof id !== "number") {
      const method = msg["method"];
      if (typeof method === "string") {
        const handler = this.notifyHandlers.get(method);
        if (handler !== undefined) {
          handler((msg["params"] as Record<string, unknown> | undefined) ?? {});
        }
      }
      return;
    }
    const cb = this.pending.get(id);
    if (cb === undefined) return;
    this.pending.delete(id);
    cb(msg as { result?: unknown; error?: unknown });
  }

  call<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (msg) => {
        if (msg.error !== undefined) {
          reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
          return;
        }
        resolve(msg.result as T);
      });
      this.sock?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  clearNotificationHandlers(): void {
    this.notifyHandlers.clear();
  }

  close(): void {
    this.sock?.destroy();
  }
}

const FIXTURES_DIR = join(import.meta.dir, "_fixtures");
const RUNNER = join(FIXTURES_DIR, "gateway-runner.ts");

async function until<T>(probe: () => T | undefined, what: string, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function pipePath(tag: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\nimbus-exec-e2e-${tag}-${process.pid}-${randomUUID().slice(0, 8)}`
    : "";
}

interface ExecOutcome {
  status: string;
  code?: string;
  result?: { exitCode: number | null; stdout: string; stderr: string; terminationReason: string };
}

/**
 * Whether this machine can actually confine a child.
 *
 * The gate is fail-closed: with no platform sandbox helper installed it refuses EVERY execution
 * with ERR_EXEC_SANDBOX_DEGRADED, which is correct behaviour but means the spawn-dependent cases
 * below cannot run here. They are skipped with a named reason rather than weakened to pass -- a
 * test that "passes" on a box where nothing can execute proves nothing about execution.
 *
 * OFF CI that is a contributor convenience. ON CI it is a FAILURE: a skip and a pass are
 * indistinguishable in a CI summary, which is exactly how a broken Windows spawn path once
 * survived a green three-OS matrix. Same discipline as
 * `test/integration/platform/sandbox/sandbox-wrapper-spawn.test.ts`.
 *
 * Note for anyone reading a green local Windows/macOS run: `audit:platform-test-gaps` will NOT
 * flag these, because it keys on `process.platform` and this condition is sandbox availability.
 */
const IS_CI = process.env["CI"] === "true";
const sandboxAvailable = await (async () => {
  const { createSandboxRunner } = await import("../../src/platform/sandbox/sandbox-runner.ts");
  try {
    return (await createSandboxRunner()).isFullyActive();
  } catch {
    return false;
  }
})();

/**
 * ONE loud, named failure when CI cannot confine, instead of three per-test failures that all say
 * the same thing less clearly. Mirrors the CI-fail-fast branch in
 * `test/integration/platform/sandbox/sandbox-wrapper-spawn.test.ts`.
 *
 * Note this fires under `verify:docker` too, which sets CI=true on a plain bun image with no
 * sandbox dependencies installed — the real CI job installs them via
 * `scripts/linux/install-sandbox-deps.sh`. That is the same pre-existing condition the sibling
 * suite has; it means "this environment lacks the dependency", not "the code is broken".
 */
describe.skipIf(sandboxAvailable || !IS_CI)("nimbus exec e2e — CI sandbox precondition", () => {
  test("fails loudly instead of silently skipping the spawn-dependent cases", () => {
    throw new Error(
      "exec-e2e: CI precondition unmet — the platform sandbox is not fully active, so no " +
        "execution can be confined and the approve/deny round-trip cannot be exercised. A skip " +
        "and a pass are indistinguishable in a CI summary; install this platform's sandbox " +
        "dependency (scripts/linux/install-sandbox-deps.sh on Linux) and re-run.",
    );
  });
});

describe("nimbus exec e2e (real gateway subprocess)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-exec-e2e-"));
  const socketPath = process.platform === "win32" ? pipePath("a") : join(tmp, "gateway.sock");
  let gateway: ReturnType<typeof Bun.spawn> | undefined;
  let gatewayLog = "";
  const ipc = new TestIpcClient();

  beforeAll(async () => {
    const paths = {
      configDir: join(tmp, "config"),
      dataDir: join(tmp, "data"),
      logDir: join(tmp, "logs"),
      socketPath,
      extensionsDir: join(tmp, "extensions"),
      tempDir: join(tmp, "tmp"),
    };
    mkdirSync(paths.configDir, { recursive: true });
    mkdirSync(paths.dataDir, { recursive: true });
    // The capability is DEFAULT OFF, so the e2e must opt in explicitly — which is itself part of
    // what this proves: the config is read at boot and reaches the gate.
    writeFileSync(
      join(paths.configDir, "nimbus.toml"),
      "[code_execution]\nenabled = true\nmax_wall_clock_ms = 15000\n",
    );

    gateway = Bun.spawn(["bun", RUNNER], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
        NIMBUS_E2E_PATHS_JSON: JSON.stringify(paths),
      },
    });
    const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) gatewayLog += decoder.decode(chunk);
    };
    void collect(gateway.stdout as ReadableStream<Uint8Array>);
    void collect(gateway.stderr as ReadableStream<Uint8Array>);

    try {
      await until(
        () => (gatewayLog.includes("[gateway] ready (e2e)") ? true : undefined),
        "ready",
        60_000,
      );
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n--- gateway output (tail) ---\n${gatewayLog.slice(-6000)}`,
      );
    }
    await ipc.connect(socketPath);
  }, 120_000);

  afterAll(async () => {
    ipc.close();
    gateway?.kill();
    await gateway?.exited.catch(() => {});
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Windows handle race; harmless */
    }
  });

  afterEach(() => {
    ipc.clearNotificationHandlers();
  });

  /** Answer the next approval prompt, returning what the owner was shown. */
  function answerWith(approved: boolean): { seen: Record<string, unknown> | undefined } {
    const box: { seen: Record<string, unknown> | undefined } = { seen: undefined };
    ipc.onNotification("exec.approvalRequest", (params) => {
      box.seen = params;
      void ipc.call("exec.approvalRespond", {
        requestId: params["requestId"],
        approved,
      });
    });
    return box;
  }

  test.skipIf(!sandboxAvailable)(
    "an APPROVED execution runs and returns the script's own exit code",
    async () => {
      const box = answerWith(true);
      const out = await ipc.call<ExecOutcome>("exec.run", {
        code: "console.log('hello from sandbox'); process.exit(3);",
        cwd: tmp,
        fsRead: [],
        fsWrite: [],
      });
      expect(out.status).toBe("ran");
      expect(out.result?.exitCode).toBe(3);
      expect(out.result?.stdout).toContain("hello from sandbox");
      // The prompt genuinely crossed the socket, carrying the verbatim body.
      expect(box.seen?.["codeBody"]).toContain("hello from sandbox");
    },
    60_000,
  );

  test.skipIf(!sandboxAvailable)(
    "the prompt discloses an EMPTY network grant rather than omitting it",
    async () => {
      const box = answerWith(false);
      await ipc.call<ExecOutcome>("exec.run", { code: "1", cwd: tmp, fsRead: [], fsWrite: [] });
      const grants = box.seen?.["grants"] as { network: string[] } | undefined;
      expect(grants?.network).toEqual([]);
    },
    60_000,
  );

  test.skipIf(!sandboxAvailable)(
    "a DENIED execution runs nothing",
    async () => {
      answerWith(false);
      const out = await ipc.call<ExecOutcome>("exec.run", {
        code: "console.log('SHOULD NOT RUN');",
        cwd: tmp,
        fsRead: [],
        fsWrite: [],
      });
      expect(out.status).toBe("denied");
      expect(out.result).toBeUndefined();
    },
    60_000,
  );

  test("a requested network grant is REFUSED before any prompt is shown", async () => {
    let prompted = false;
    ipc.onNotification("exec.approvalRequest", () => {
      prompted = true;
    });
    const out = await ipc.call<ExecOutcome>("exec.run", {
      code: "1",
      cwd: tmp,
      fsRead: [],
      fsWrite: [],
      network: ["example.com"],
    });
    expect(out.status).toBe("refused");
    expect(out.code).toBe("ERR_EXEC_NETWORK_UNSUPPORTED");
    expect(prompted).toBe(false);
  }, 60_000);

  test("a RELATIVE fs grant is refused, not resolved against the gateway's cwd", async () => {
    const out = await ipc.call<ExecOutcome>("exec.run", {
      code: "1",
      cwd: tmp,
      fsRead: ["./relative"],
      fsWrite: [],
    });
    expect(out.status).toBe("refused");
    expect(out.code).toBe("ERR_EXEC_RELATIVE_PATH");
  }, 60_000);
});
