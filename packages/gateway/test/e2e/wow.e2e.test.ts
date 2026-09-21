// E2E over a REAL gateway socket/pipe for `nimbus wow` (spec: 2026-09-21-nimbus-wow, task B10).
//
// This is the one layer that proves `tour.plan` and `locality.report` are actually routed by the
// outer dispatcher (`ipc/server/dispatchers.ts`) rather than only reachable from a unit test that
// calls `dispatchTourRpc`/`dispatchLocalityRpc` directly — the same gap `explain-last.e2e.test.ts`
// exists to close for `ask.explainLast`. A handler present in the inner dispatcher without a
// matching entry in the outer method-routing match compiles clean and passes every unit test, and
// returns "Method not found" over a real socket.
//
// Modeled on `demo-tour.e2e.test.ts`: the real CLI entry drives a DEMO-rooted gateway (`nimbus demo
// --no-tour` seeds and starts it) with every platform data/config dir redirected under a fresh
// `mkdtempSync` temp root, so this test can never touch the user's real
// `%LOCALAPPDATA%\Nimbus`/`~/.config/nimbus` install. Once the demo gateway is up, this test
// connects to its real socket/pipe directly (the `TinyIpcClient` pattern from
// `explain-last.e2e.test.ts`) to drive `tour.plan`/`locality.report`, then separately spawns the
// real CLI as `nimbus --demo wow` to prove the full command path against the same running gateway.
//
// Run with no `dist/nimbus-gateway*` in the checkout — the CLI prefers a compiled gateway there
// over the source entry.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_ENTRY = join(import.meta.dir, "..", "..", "..", "cli", "src", "index.ts");
const BOOT_TIMEOUT_MS = 60_000;
const DEMO_TIMEOUT_MS = 180_000;
const CLI_TIMEOUT_MS = 30_000;
const RPC_TIMEOUT_MS = 30_000;
const WOW_TIMEOUT_MS = 120_000;

// Short names: a macOS unix-socket path must stay under 104 bytes.
const root = mkdtempSync(join(tmpdir(), "nwe-"));
const dirs = {
  roaming: join(root, "r"),
  local: join(root, "l"),
  home: join(root, "h"),
  xdgConfig: join(root, "c"),
  xdgData: join(root, "d"),
  run: join(root, "u"),
  tmp: join(root, "t"),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

/** The REAL Nimbus data dir each OS would use under these temp roots (mirrors platform/paths). */
function realNimbusDataDir(): string {
  if (process.platform === "win32") return join(dirs.local, "Nimbus", "data");
  if (process.platform === "darwin") {
    return join(dirs.home, "Library", "Application Support", "Nimbus");
  }
  return join(dirs.xdgData, "nimbus");
}

const demoDataDir = join(realNimbusDataDir(), "demo", "data");

function readGatewayState(dataDir: string): { pid: number; socketPath: string } | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, "gateway.json"), "utf8"));
    const o = raw as { pid?: unknown; socketPath?: unknown } | null;
    if (typeof o?.pid === "number" && typeof o.socketPath === "string") {
      return { pid: o.pid, socketPath: o.socketPath };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let env: Record<string, string>;

type CliResult = { code: number; stdout: string; stderr: string };

/** Spawns the real CLI entry with the shared temp-root env. Kills and reports if it hangs. */
async function cli(args: string[], timeoutMs = CLI_TIMEOUT_MS): Promise<CliResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  let killedForTimeout = false;
  const timer = setTimeout(() => {
    killedForTimeout = true;
    proc.kill();
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (killedForTimeout) {
    throw new Error(
      `cli ${args.join(" ")} did not exit within ${String(timeoutMs)}ms (killed)\n` +
        `--- stdout ---\n${stdout.slice(-2000)}\n--- stderr ---\n${stderr.slice(-2000)}`,
    );
  }
  return { code, stdout, stderr };
}

type RpcReply = {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

/**
 * A minimal JSON-RPC 2.0 client over the raw socket/pipe — request/response only, mirroring
 * `explain-last.e2e.test.ts`'s `TinyIpcClient`. No mocks at the IPC layer: this is a real
 * connection to the real gateway's socket.
 */
class TinyIpcClient {
  private sock: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (v: RpcReply) => void>();

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
    if (typeof id !== "number") return;
    const cb = this.pending.get(id);
    if (cb === undefined) return;
    this.pending.delete(id);
    cb(msg as RpcReply);
  }

  raw(method: string, params: unknown): Promise<RpcReply> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.sock?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** Calls `method` and returns the result, throwing on a JSON-RPC error. */
  async call<T>(method: string, params: unknown): Promise<T> {
    const reply = await this.raw(method, params);
    if (reply.error !== undefined) {
      throw new Error(`${method} failed: ${JSON.stringify(reply.error)}`);
    }
    return reply.result as T;
  }

  disconnect(): void {
    this.sock?.destroy();
  }
}

const client = new TinyIpcClient();

beforeAll(async () => {
  env = { ...(process.env as Record<string, string>) };
  for (const k of [
    "NIMBUS_CONFIG_DIR",
    "NIMBUS_GATEWAY_SOCKET",
    "NIMBUS_E2E_PATHS_JSON",
    "NIMBUS_METRICS_PORT",
    "NIMBUS_GATEWAY_LOG_PATH",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "NIMBUS_UPDATER_DISABLE",
    "NIMBUS_DISTRIBUTION_CHANNEL",
    "NODE_ENV",
  ]) {
    delete env[k];
  }
  for (const k of Object.keys(env)) {
    if (k.startsWith("NIMBUS_OAUTH_")) delete env[k];
  }
  Object.assign(env, {
    APPDATA: dirs.roaming,
    LOCALAPPDATA: dirs.local,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    XDG_CONFIG_HOME: dirs.xdgConfig,
    XDG_DATA_HOME: dirs.xdgData,
    XDG_RUNTIME_DIR: dirs.run,
    TMPDIR: dirs.tmp,
    TEMP: dirs.tmp,
    TMP: dirs.tmp,
    NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
  });

  // Premise: the child must resolve homedir() to the temp HOME, or this test would boot against
  // the developer's REAL profile. Fail, never proceed.
  const probe = Bun.spawn({
    cmd: [process.execPath, "-e", "process.stdout.write(require('node:os').homedir())"],
    stdout: "pipe",
    env,
  });
  const childHome = await new Response(probe.stdout).text();
  await probe.exited;
  if (childHome !== dirs.home) {
    throw new Error(`premise failed: child homedir() is ${childHome}, expected ${dirs.home}`);
  }

  // Seed + start a demo gateway (`--no-tour` skips `demo.ts`'s own built-in 3-brief tour — this
  // test drives `nimbus wow`'s tour, a different feature, over the resulting index).
  const seeded = await cli(["demo", "--no-tour"], DEMO_TIMEOUT_MS);
  if (seeded.code !== 0) {
    throw new Error(
      `\`nimbus demo --no-tour\` exited ${String(seeded.code)}\n` +
        `--- stdout ---\n${seeded.stdout.slice(-2000)}\n--- stderr ---\n${seeded.stderr.slice(-2000)}`,
    );
  }

  const state = readGatewayState(demoDataDir);
  if (state === undefined) {
    throw new Error(`no gateway.json under ${demoDataDir} after \`nimbus demo --no-tour\``);
  }
  await client.connect(state.socketPath);
}, BOOT_TIMEOUT_MS + DEMO_TIMEOUT_MS);

afterAll(async () => {
  client.disconnect();
  try {
    await cli(["demo", "stop"], CLI_TIMEOUT_MS);
  } catch {
    /* best effort */
  }
  const leftover = readGatewayState(demoDataDir);
  if (leftover !== undefined && isAlive(leftover.pid)) {
    try {
      process.kill(leftover.pid, "SIGTERM");
    } catch {
      /* best effort */
    }
  }
  try {
    // Retries are for a lagging Windows handle release, not for flakiness.
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* best effort — a Windows handle release can lag behind process exit */
  }
});

describe("nimbus wow: tour.plan and locality.report over a real gateway socket", () => {
  test(
    "1. tour.plan {} — real outer routing, not just the inner dispatcher",
    async () => {
      const plan = await client.call<{
        steps: ReadonlyArray<{ args: readonly string[]; command: string }>;
        t0: number;
      }>("tour.plan", {});

      // The seeded Acme demo corpus yields exactly 3 offerable steps (oncall/owners/standup);
      // why/decisions skip (no indexed symbols in configured roots / no extracted decisions).
      expect(plan.steps.length).toBe(3);
      for (const step of plan.steps) {
        expect(step.args).not.toContain("--demo");
        expect(step.command.startsWith("nimbus --demo ")).toBe(true);
      }
      expect(typeof plan.t0).toBe("number");
    },
    RPC_TIMEOUT_MS,
  );

  test(
    "2. locality.report {} — exactly one `ipc` listener, no `http`/`metrics` (I41 demo sidecars off)",
    async () => {
      const report = await client.call<{
        listeners: ReadonlyArray<{ name: string; loopback: boolean }>;
      }>("locality.report", {});

      const byName = report.listeners.filter((l) => l.name === "ipc");
      expect(byName.length).toBe(1);
      expect(report.listeners.some((l) => l.name === "http")).toBe(false);
      expect(report.listeners.some((l) => l.name === "metrics")).toBe(false);
      // A demo gateway never enables `[federation]` (default off; the demo seed writes no
      // `[federation]` section), so the LAN server's `start()` — gated on `federationCfg.enabled`
      // in `bootFederationIntoIpcOpts` — never runs, and mDNS advertising (gated inside that same
      // block) never runs either. Confirmed against `platform/assemble.ts` and the demo seed
      // config writer (`demo/seed.ts`'s `writeDemoConfig`) before asserting the full array here —
      // `address` is a per-run pipe/socket name, so this checks shape/count, not the literal path.
      expect(report.listeners.length).toBe(1);
      expect(report.listeners[0]?.name).toBe("ipc");
      expect(report.listeners[0]?.loopback).toBe(true);
    },
    RPC_TIMEOUT_MS,
  );

  test(
    "3. tour.plan { steps: 9 } — refused as an RPC error, never clamped",
    async () => {
      const reply = await client.raw("tour.plan", { steps: 9 });
      expect(reply.result).toBeUndefined();
      expect(reply.error).toBeDefined();
      expect(reply.error?.code).toBe(-32602);
      expect(reply.error?.message).toContain("steps must be an integer in 1..6");
    },
    RPC_TIMEOUT_MS,
  );

  test(
    "4. `nimbus --demo wow` over the real CLI path: the tour runs and the panel prints",
    async () => {
      const r = await cli(["--demo", "wow"], WOW_TIMEOUT_MS);
      if (r.code !== 0) {
        throw new Error(
          `\`nimbus --demo wow\` exited ${String(r.code)}\n` +
            `--- stdout ---\n${r.stdout.slice(-2000)}\n--- stderr ---\n${r.stderr.slice(-2000)}`,
        );
      }
      const headerCount = (r.stdout.match(/── \[/g) ?? []).length;
      expect(headerCount).toBeGreaterThanOrEqual(3);
      expect(r.stdout).toContain("Outbound activity during this tour (gateway-wide)");
      expect(r.code).toBe(0);
    },
    WOW_TIMEOUT_MS + 10_000,
  );
});
