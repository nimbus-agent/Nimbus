// The Linux proof the quality layer's spec requires (project 6, PR 6b-1): an approved extension's
// network, observed end to end with nothing faked. A REAL gateway subprocess installs and approves a
// fixture extension declaring `api.github.com:443`, spawns it through the real `__nimbus-sandbox`
// wrapper, the real Linux runner, the built `nimbus-sandbox-helper` and nested `bwrap`, and the
// child, on one tool call, fetches the declared host once and looks up `undeclared.invalid`. The
// extension is then stopped, which makes its wrapper write the run's final window; the gateway is
// restarted, and its boot pass ingests the window files into V81. The rows are read back through
// the owner's own read path, `extension.audit`, from the restarted gateway.
//
// Also checked here, in the real child: neither observation variable reaches it (Review Focus 2),
// and the observation directory is the gateway's own, created 0700.
//
// Runs on Linux only, and only where the premise holds: the helper is built and answers `--check`,
// and the runner can confine a network policy. The skip is self-validating: under
// NIMBUS_REQUIRE_SANDBOX_HELPER=1 (the Linux `E2E Gateway` CI step builds the helper and sets it) an
// unmet premise FAILS by name instead of skipping. A host that cannot reach api.github.com even
// outside the sandbox FAILS in CI or when required (REQUIRE_REAL_NETWORK); only a local, unrequired
// run may skip the `used` row, saying so loudly.
//
// The fixture is a hand-written MCP stdio server (newline-delimited JSON-RPC, no SDK), so the
// installed package has no dependencies and no bundle step.
//
// Embeddings are skipped (NIMBUS_SKIP_EMBEDDING_RUNTIME=1); nothing here needs the index.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditEntry } from "../../src/ipc/extension-audit-rpc.ts";

const RUNNER = join(import.meta.dir, "_fixtures", "gateway-runner.ts");
const HELPER = join(import.meta.dir, "../../src-native/sandbox-helper/nimbus-sandbox-helper");
const PREMISE_PROBE = join(import.meta.dir, "_fixtures", "observation-premise-probe.ts");
const IS_LINUX = process.platform === "linux";
const REQUIRED = process.env["NIMBUS_REQUIRE_SANDBOX_HELPER"] === "1";
/**
 * The same rule as linux-forwarder-network.test.ts: in CI, or when asked, an api.github.com the
 * host cannot reach FAILS this file, since without it the `used` row is unproved. Only a local,
 * unrequired run may skip that one row, and it says so.
 */
const REQUIRE_REAL_NETWORK =
  REQUIRED || process.env["CI"] === "true" || process.env["NIMBUS_REQUIRE_REAL_NETWORK"] === "1";

type AuditResult = { extensions: AuditEntry[] };

const EXTENSION_ID = "e2e.observed";
const SERVICE_ID = "ext_e2e_observed";
const VERSION = "1.0.0";
const DECLARED = "api.github.com:443";
const DECLARED_URL = "https://api.github.com/zen";
const HOST_REACH_TIMEOUT_MS = 15_000;
const BOOT_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 120_000;

/** Why the built helper is unusable, or null when it answers `--check` as the forwarder suite requires. */
function helperProblem(): string | null {
  if (!IS_LINUX) return "not Linux";
  if (!existsSync(HELPER)) return `no helper at ${HELPER}`;
  // windows-console-ok: Linux only, where the flag is ignored.
  const r = spawnSync(HELPER, ["--check"], { encoding: "utf8" });
  if (r.status === 0 && r.stdout === "OK\n") return null;
  return `helper --check exited ${String(r.status)}: ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)}`;
}

/** Why this runner, with this helper, cannot confine the extension's network policy; null if it can. */
async function confineProblem(): Promise<string | null> {
  const helper = helperProblem();
  if (helper !== null) return helper;
  // A child process with its own env, exactly as this file's gateway gets it: linux.ts resolves the
  // helper path once at module load, and the e2e tree shares one test process, so an in-process
  // probe would see whatever an earlier file loaded (CI run on PR #1872 showed exactly that).
  // windows-console-ok: Linux only.
  const r = spawnSync(process.execPath, [PREMISE_PROBE, DECLARED], {
    encoding: "utf8",
    env: { ...process.env, NIMBUS_SANDBOX_HELPER_PATH: HELPER },
    timeout: 60_000,
  });
  const out = (r.stdout ?? "").trim();
  if (r.status === 0 && out === "OK") return null;
  return `premise probe: exit ${String(r.status)}: ${out} ${(r.stderr ?? "").trim().slice(0, 400)}`;
}

const premiseProblem = IS_LINUX ? await confineProblem() : "not Linux";
const premise = premiseProblem === null;

describe.skipIf(!IS_LINUX || premise || !REQUIRED)(
  "extension observation e2e — required premise",
  () => {
    test("fails loudly instead of skipping the Linux proof", () => {
      expect(
        "extension-observation-e2e: NIMBUS_REQUIRE_SANDBOX_HELPER=1 but the premise is unmet: the " +
          "helper is not built or does not answer --check, or the runner cannot confine a network " +
          "policy in per-host mode. Run `bun run build:sandbox-helper` and " +
          `scripts/linux/install-sandbox-deps.sh. Reason: ${String(premiseProblem)}`,
      ).toBeNull();
    });
  },
);

/** A minimal MCP stdio server: initialize, tools/list and one `reach` tool. */
const SERVER_JS = `import dns from "node:dns/promises";
import readline from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");

async function reach() {
  const out = {};
  try {
    const res = await fetch(${JSON.stringify(DECLARED_URL)}, {
      headers: { "user-agent": "nimbus-extension-observation-e2e" },
      signal: AbortSignal.timeout(20000),
    });
    await res.text();
    out.status = res.status;
  } catch (e) {
    out.status = String(e?.code ?? e?.name ?? e);
  }
  try {
    await dns.lookup("undeclared.invalid");
    out.refused = "resolved";
  } catch (e) {
    out.refused = String(e?.code ?? "error");
  }
  out.sawChannel = Object.keys(process.env).filter((k) => k.includes("OBSERVATION"));
  return out;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "observed", version: "1.0.0" },
      },
    });
  } else if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "reach",
            description: "Fetch the declared host once and look up an undeclared name",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
  } else if (msg.method === "tools/call") {
    const report = await reach();
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: JSON.stringify(report) }] },
    });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
`;

type RpcReply = { result?: unknown; error?: unknown };

class IpcClient {
  private sock: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (v: RpcReply) => void>();
  private onConsent: ((params: Record<string, unknown>) => void) | undefined;

  connect(socketPath: string, onConsent: (params: Record<string, unknown>) => void): Promise<void> {
    this.onConsent = onConsent;
    return new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      sock.on("connect", () => resolve());
      sock.on("error", reject);
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

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg["id"];
    if (typeof id !== "number") {
      if (msg["method"] === "consent.request") {
        this.onConsent?.((msg["params"] as Record<string, unknown> | undefined) ?? {});
      }
      return;
    }
    const cb = this.pending.get(id);
    if (cb === undefined) return;
    this.pending.delete(id);
    cb(msg as RpcReply);
  }

  call<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (msg) => {
        if (msg.error !== undefined) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result as T);
      });
      this.sock?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close(): void {
    this.sock?.destroy();
  }
}

type Gateway = { proc: ReturnType<typeof Bun.spawn>; log: () => string };

async function until<T>(probe: () => T | undefined, what: string, ms: number): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!premise)("an approved extension's network, observed on Linux", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-extobs-e2e-"));
  const pkg = join(tmp, "pkg");
  const paths = {
    configDir: join(tmp, "config"),
    dataDir: join(tmp, "data"),
    logDir: join(tmp, "logs"),
    socketPath: join(tmp, "gw.sock"),
    extensionsDir: join(tmp, "extensions"),
    tempDir: join(tmp, "tmp"),
    sandboxDir: join(tmp, "sandbox"),
  };
  const obsDir = join(paths.dataDir, "extension-observations");
  let gateway: Gateway | undefined;
  let client = new IpcClient();
  /** Whether the host reaches the declared URL outside the sandbox; false is an outage, not a proof. */
  let hostReached = false;
  /**
   * Every window file name ever seen. The gateway's own 60 s ingest pass may delete files before a
   * probe looks, so what a run wrote is judged from this, never from what is on disk at one moment.
   */
  const seen = new Set<string>();
  let watcher: ReturnType<typeof setInterval> | undefined;

  function noteFiles(): void {
    for (const n of windowFiles()) seen.add(n);
  }

  /** The seqs seen for this extension's run(s), ascending. */
  function seenSeqs(): number[] {
    const seqs: number[] = [];
    for (const n of seen) {
      const m = /\.(\d+)\.json$/.exec(n);
      if (n.startsWith(`${SERVICE_ID}.`) && m !== null) seqs.push(Number(m[1]));
    }
    return seqs.sort((a, b) => a - b);
  }

  function requireHostOrSkip(what: string): boolean {
    if (hostReached) return true;
    if (REQUIRE_REAL_NETWORK) {
      throw new Error(
        `this host cannot reach ${DECLARED_URL} even outside the sandbox, so ${what} is unproved; ` +
          "in CI (or under NIMBUS_REQUIRE_SANDBOX_HELPER / NIMBUS_REQUIRE_REAL_NETWORK) that is a failure",
      );
    }
    console.error(`SKIPPED, NOT PROVED: this machine cannot reach ${DECLARED_URL}, so ${what}`);
    return false;
  }

  async function bootGateway(): Promise<void> {
    const proc = Bun.spawn(["bun", RUNNER], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...(process.env as Record<string, string>),
        NIMBUS_E2E_PATHS_JSON: JSON.stringify(paths),
        NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
        NIMBUS_NOTIFICATIONS: "off",
        // The gateway forwards this to the wrapper of a network-declaring spawn (Linux only).
        NIMBUS_SANDBOX_HELPER_PATH: HELPER,
      },
    });
    let log = "";
    const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) log += decoder.decode(chunk);
    };
    void collect(proc.stderr as ReadableStream<Uint8Array>);
    void collect(proc.stdout as ReadableStream<Uint8Array>);
    gateway = { proc, log: () => log };
    try {
      await until(
        () => (log.includes("[gateway] ready (e2e)") ? true : undefined),
        "gateway bind",
        BOOT_TIMEOUT_MS,
      );
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n--- gateway output (tail) ---\n${log.slice(-6000)}`,
      );
    }
    client = new IpcClient();
    await client.connect(paths.socketPath, (params) => {
      void client.call("consent.respond", { requestId: params["requestId"], approved: true });
    });
  }

  async function stopGateway(): Promise<void> {
    client.close();
    gateway?.proc.kill();
    await gateway?.proc.exited.catch(() => {});
    gateway = undefined;
  }

  function windowFiles(): string[] {
    return existsSync(obsDir) ? readdirSync(obsDir).filter((n) => n.endsWith(".json")) : [];
  }

  beforeAll(async () => {
    // Twice, so one transient runner DNS failure is not an outage.
    for (let attempt = 0; attempt < 2 && !hostReached; attempt += 1) {
      hostReached = await fetch(DECLARED_URL, {
        headers: { "user-agent": "nimbus-extension-observation-e2e" },
        signal: AbortSignal.timeout(HOST_REACH_TIMEOUT_MS),
      }).then(
        () => true,
        () => false,
      );
    }
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "dist", "index.js"), SERVER_JS, "utf8");
    writeFileSync(
      join(pkg, "nimbus.extension.json"),
      JSON.stringify({
        id: EXTENSION_ID,
        version: VERSION,
        entry: "dist/index.js",
        permissions: { network: [DECLARED], filesystem: { read: [], write: [] } },
      }),
      "utf8",
    );
    for (const d of [paths.configDir, paths.dataDir]) mkdirSync(d, { recursive: true });
    await bootGateway();
    watcher = setInterval(noteFiles, 20);
  }, 180_000);

  afterAll(async () => {
    if (watcher !== undefined) clearInterval(watcher);
    await stopGateway();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("the gateway made its observation directory owner-only at boot", () => {
    expect(statSync(obsDir).isDirectory()).toBe(true);
    expect(statSync(obsDir).mode & 0o777).toBe(0o700);
  });

  test(
    "install, approve, call: the child reaches the declared host, is refused the undeclared name, and never sees the channel",
    async () => {
      requireHostOrSkip("the child's fetch of the declared host");
      await client.call("extension.install", { sourcePath: pkg });
      const approved = await client.call<{ serviceId: string }>("extension.approveRun", {
        id: EXTENSION_ID,
      });
      expect(approved.serviceId).toBe(SERVICE_ID);
      const tools = await client.call<{ tools: Array<{ name: string }> }>(
        "connector.userMcpTools",
        { serviceId: SERVICE_ID },
      );
      if (!tools.tools.some((t) => t.name === "reach")) {
        throw new Error(`no reach tool\n--- gateway output ---\n${gateway?.log().slice(-6000)}`);
      }
      const out = await client.call<{ status: string; result: { content: { text: string }[] } }>(
        "connector.userMcpCall",
        { serviceId: SERVICE_ID, tool: "reach", input: {} },
      );
      expect(out.status).toBe("ok");
      const report = JSON.parse(out.result.content[0]?.text ?? "{}") as {
        status: unknown;
        refused: unknown;
        sawChannel: unknown;
      };
      expect(report.refused).toBe("ENOTFOUND");
      expect(report.sawChannel).toEqual([]);
      // Unconditional when the network is required (requireHostOrSkip threw otherwise above).
      if (hostReached || REQUIRE_REAL_NETWORK) expect(typeof report.status).toBe("number");
      // File 0 is written when the wrapper starts, before the child runs.
      noteFiles();
      expect(seenSeqs()).toContain(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "stop, then an ingest pass at the next boot: V81 holds what the child used and was refused, for one run",
    async () => {
      expect(await client.call<{ ok: boolean }>("extension.disable", { id: EXTENSION_ID })).toEqual(
        { ok: true },
      );
      // The stopped wrapper writes the run's final window from its exit: a later seq than 0.
      const finalWritten = await until(
        () => {
          noteFiles();
          return seenSeqs().some((q) => q > 0) ? true : undefined;
        },
        "the final window file",
        30_000,
      ).catch(() => false);
      await stopGateway();
      await bootGateway();
      // The boot pass ran before the socket answered, so nothing is left to ingest.
      expect(windowFiles()).toEqual([]);
      // The read path under test is the owner's own: `extension.audit` over IPC, not the tables.
      let audit: AuditResult;
      try {
        audit = await client.call<AuditResult>("extension.audit", { id: EXTENSION_ID });
      } finally {
        await stopGateway();
      }
      const entry = audit.extensions[0];
      expect(finalWritten).toBe(true);
      expect(seenSeqs()[0]).toBe(0);
      expect(audit.extensions).toHaveLength(1);
      expect(entry).toMatchObject({
        id: EXTENSION_ID,
        version: VERSION,
        runs: 1,
        os: "linux",
        networkObserved: true,
        declared: ["api.github.com:443"],
      });
      const refused = entry?.refused.find((r) => r.destination === "undeclared.invalid");
      expect(refused?.port).toBe(0);
      expect(refused?.count ?? 0).toBeGreaterThanOrEqual(1);
      if (!requireHostOrSkip("the used row")) return;
      const used = entry?.used.find((r) => r.destination === "api.github.com" && r.port === 443);
      expect(used?.count ?? 0).toBeGreaterThanOrEqual(1);
      expect(entry?.notSeen).toEqual([]);
    },
    TEST_TIMEOUT_MS * 2,
  );
});
