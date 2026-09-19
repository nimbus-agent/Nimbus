// The real gateway entry, booted with NIMBUS_DEMO=1 on temp OS roots. Proves end-to-end what the
// I41 unit tests prove per function: the resolved demo socket is what binds, the gateway answers
// there, it does not start the env-selected HTTP sidecar, and every file it wrote under the would-be
// REAL Nimbus directories is inside the demo root.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import { pickSentinelPort } from "./_fixtures/sentinel-port.ts";

const ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");
const BOOT_TIMEOUT_MS = 60_000;

// Short names: a macOS unix-socket path must stay under 104 bytes.
const root = mkdtempSync(join(tmpdir(), "nd-"));
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

/** The REAL Nimbus directories each OS would use under these temp roots (mirrors platform/paths). */
function realNimbusDirs(): { dataDir: string; others: string[] } {
  if (process.platform === "win32") {
    return {
      dataDir: join(dirs.local, "Nimbus", "data"),
      others: [join(dirs.roaming, "Nimbus"), join(dirs.local, "Nimbus", "extensions")],
    };
  }
  if (process.platform === "darwin") {
    return { dataDir: join(dirs.home, "Library", "Application Support", "Nimbus"), others: [] };
  }
  return { dataDir: join(dirs.xdgData, "nimbus"), others: [join(dirs.xdgConfig, "nimbus")] };
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function until(probe: () => boolean, what: string, ms: number): Promise<void> {
  const start = Date.now();
  while (!probe()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** One JSON-RPC request over a fresh connection. */
function rpc(socketPath: string, method: string): Promise<{ result?: unknown; error?: unknown }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    sock.on("error", reject);
    sock.on("connect", () => {
      sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} })}\n`);
    });
    sock.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const msg = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      if (msg["id"] !== 1) return; // a notification; keep reading
      sock.end();
      resolve({ result: msg["result"], error: msg["error"] });
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

let proc: ReturnType<typeof Bun.spawn> | undefined;
let output = "";
let socketPath = "";
let httpPort = 0;

beforeAll(async () => {
  httpPort = await pickSentinelPort();
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of [
    "NIMBUS_CONFIG_DIR",
    "NIMBUS_GATEWAY_SOCKET",
    "NIMBUS_E2E_PATHS_JSON",
    "NIMBUS_METRICS_PORT",
    // This launches the gateway entry directly, not through the CLI's spawnGateway (which always
    // overwrites this var with the demo log path before spawning) — an inherited value from the
    // caller's own shell would send the lifecycle log outside the temp roots this test cleans up.
    "NIMBUS_GATEWAY_LOG_PATH",
  ]) {
    delete env[k];
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
    NIMBUS_HTTP_PORT: String(httpPort),
    NIMBUS_DEMO: "1",
    // An owner's shell may export a profile. The demo config dir holds no `nimbus.work.toml`,
    // so `resolveNimbusTomlForProfile` must fall back to the demo `nimbus.toml` — set, not
    // deleted, so the boot below proves that fallback rather than assuming it (spec § 3.2).
    NIMBUS_PROFILE: "work",
  });

  // Premise: the child must resolve homedir() to the temp HOME, or on macOS this test would boot
  // against the developer's REAL ~/Library/Application Support/Nimbus. Fail, never proceed.
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

  proc = Bun.spawn([process.execPath, ENTRY], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const collect = async (s: ReadableStream<Uint8Array>): Promise<void> => {
    const d = new TextDecoder();
    for await (const chunk of s) output += d.decode(chunk);
  };
  void collect(proc.stdout as ReadableStream<Uint8Array>);
  void collect(proc.stderr as ReadableStream<Uint8Array>);
  try {
    await until(
      () => /\[gateway\] ready \(.+\) IPC (.+)/.test(output),
      "demo gateway ready",
      BOOT_TIMEOUT_MS,
    );
  } catch (e) {
    proc.kill();
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}\n--- output ---\n${output.slice(-4000)}`,
    );
  }
  socketPath = (/\[gateway\] ready \(.+\) IPC (.+)/.exec(output)?.[1] ?? "").trim();
}, BOOT_TIMEOUT_MS + 30_000);

afterAll(async () => {
  if (proc !== undefined) {
    proc.kill();
    await proc.exited;
  }
  try {
    // Retries are for the LEAK (issue #972), not for flakiness: a failure is already swallowed.
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* best effort — a Windows handle release can lag behind process exit */
  }
});

describe("I41 e2e: the real gateway entry, demo-rooted", () => {
  const demoRoot = join(realNimbusDirs().dataDir, "demo");

  test("binds the DEMO endpoint derived from the demo root", () => {
    if (process.platform === "win32") {
      expect(socketPath).toMatch(/^\\\\\.\\pipe\\nimbus-gateway-demo-[0-9a-f]{12}$/);
    } else {
      const dir = process.platform === "darwin" ? dirs.tmp : dirs.run;
      expect(dirname(socketPath)).toBe(dir);
      expect(basename(socketPath)).toMatch(/^nimbus-gateway-demo-[0-9a-f]{12}\.sock$/);
    }
  });

  test("answers gateway.ping on that endpoint", async () => {
    const r = await rpc(socketPath, "gateway.ping");
    expect(r.error).toBeUndefined();
  });

  test("the index and the state file are inside the demo root (positive control)", () => {
    expect(existsSync(join(demoRoot, "data", "nimbus.db"))).toBe(true);
    expect(existsSync(join(demoRoot, "data", "gateway.json"))).toBe(true);
  });

  test("does not start the env-selected HTTP sidecar", async () => {
    expect(await canConnect(httpPort)).toBe(false);
  });

  test("every file under the would-be REAL Nimbus directories is inside the demo root", () => {
    const { dataDir, others } = realNimbusDirs();
    const stray = [dataDir, ...others].flatMap(filesUnder).filter((f) => !isInside(f, demoRoot));
    expect(stray).toEqual([]);
    expect(existsSync(join(dirs.tmp, "nimbus"))).toBe(false); // the REAL tempDir
  });
});
