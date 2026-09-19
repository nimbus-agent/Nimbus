// The whole `nimbus demo` flow, end to end, over the real CLI entry — which spawns the real
// gateway entry — on temp OS roots. `demo-root-isolation.e2e.test.ts` proves the per-function I41
// isolation properties against a directly-spawned gateway; this test proves the user-facing
// SEQUENCE actually works: seed, the three-brief tour, ordinary `--demo` commands, the refusal
// gate, the HTTP sidecar staying off, a re-run over a live demo gateway, a clean stop, and — via a
// local recorder standing in for the telemetry and updater endpoints — no outbound request from
// any demo gateway, all through the same CLI a person types.
//
// Run it with no `dist/nimbus-gateway*` in the checkout: the CLI prefers a compiled gateway there
// over the source entry (`cli/src/lib/resolve-gateway-launch.ts`), so a stale local build would be
// what this test exercises. CI has no `dist/` in this job.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

const CLI_ENTRY = join(import.meta.dir, "..", "..", "..", "cli", "src", "index.ts");
const BOOT_TIMEOUT_MS = 60_000;
const DEMO_TIMEOUT_MS = 180_000;
const CLI_TIMEOUT_MS = 30_000;
const ASK_TIMEOUT_MS = 90_000;
const TRY_TIMEOUT_MS = 60_000;

// Short names: a macOS unix-socket path must stay under 104 bytes.
const root = mkdtempSync(join(tmpdir(), "ndt-"));
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

const demoRoot = join(realNimbusDirs().dataDir, "demo");
const demoDataDir = join(demoRoot, "data");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
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

/** The gateway pid `nimbus demo`/`nimbus start` recorded — read directly, no cli-package import. */
function readGatewayPid(dataDir: string): number | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, "gateway.json"), "utf8"));
    const pid = (raw as { pid?: unknown } | null)?.pid;
    return typeof pid === "number" ? pid : undefined;
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
let httpPort = 0;

/**
 * A local stand-in for EVERY outbound endpoint a booting gateway would contact on its own (spec
 * § 11.3): the telemetry flush (`NIMBUS_TELEMETRY_ENDPOINT`, `config/telemetry-toml.ts`) and the
 * updater's startup manifest check (`NIMBUS_UPDATER_URL`, `config/nimbus-toml.ts`'s
 * `parseNimbusUpdaterToml`). Both are env overrides read at boot, which is the path that matters:
 * the seeder writes the demo `nimbus.toml` only AFTER the first boot, so a TOML-based redirect
 * could not cover the first gateway at all. Without this, a regression that re-enabled either
 * would POST to production from CI and every assertion here would still pass.
 */
type RecordedRequest = { method: string; url: string };
const outbound: RecordedRequest[] = [];
let outboundServer: ReturnType<typeof Bun.serve> | undefined;

function expectNoOutboundRequests(): void {
  expect(outbound).toEqual([]);
}

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

beforeAll(async () => {
  httpPort = await freePort();
  outboundServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      outbound.push({ method: req.method, url: req.url });
      return new Response("{}", { status: 404 });
    },
  });
  const outboundBase = `http://127.0.0.1:${String(outboundServer.port)}`;
  env = { ...(process.env as Record<string, string>) };
  for (const k of [
    "NIMBUS_CONFIG_DIR",
    "NIMBUS_GATEWAY_SOCKET",
    "NIMBUS_E2E_PATHS_JSON",
    "NIMBUS_METRICS_PORT",
    "NIMBUS_GATEWAY_LOG_PATH",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    // Either would make a regression here pass for the wrong reason: the first switches the
    // updater off by config, the second makes `createUpdaterFromConfig` decline to build one
    // (a package-manager install). With both absent, only the demo boot policy stands between
    // a booting gateway and the recorder below.
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
    // These must be ignored by a demo boot (I41 clause 4/spec § 11.3) — proven by test 5 (HTTP
    // sidecar) and by `outbound` staying empty (telemetry flush + updater startup check). The
    // telemetry flush ticks once IMMEDIATELY at boot and the updater checks on startup, so a
    // regression in either gate is recorded within the first boot of test 1.
    NIMBUS_TELEMETRY_ENABLED: "1",
    NIMBUS_TELEMETRY_ENDPOINT: `${outboundBase}/telemetry`,
    NIMBUS_UPDATER_URL: `${outboundBase}/latest.json`,
    NIMBUS_HTTP_PORT: String(httpPort),
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
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  try {
    await cli(["demo", "stop"], CLI_TIMEOUT_MS);
  } catch {
    /* best effort */
  }
  const leftoverPid = readGatewayPid(demoDataDir);
  if (leftoverPid !== undefined && isAlive(leftoverPid)) {
    try {
      process.kill(leftoverPid, "SIGTERM");
    } catch {
      /* best effort */
    }
  }
  await outboundServer?.stop(true);
  try {
    // Retries are for a lagging Windows handle release, not for flakiness.
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* best effort — a Windows handle release can lag behind process exit */
  }
});

describe("nimbus demo: the whole flow, end to end, on temp roots", () => {
  test(
    "1. `nimbus demo` seeds and tours: exit 0, three headers in order, exact commands, real content, ## Gaps",
    async () => {
      const r = await cli(["demo"], DEMO_TIMEOUT_MS);
      if (r.code !== 0) {
        throw new Error(
          `\`nimbus demo\` exited ${String(r.code)}\n` +
            `--- stdout ---\n${r.stdout.slice(-2000)}\n--- stderr ---\n${r.stderr.slice(-2000)}`,
        );
      }

      const h1 = "── [1/3] On-call triage";
      const h2 = "── [2/3] Why this line changed";
      const h3 = "── [3/3] Who owns this code";
      const i1 = r.stdout.indexOf(h1);
      const i2 = r.stdout.indexOf(h2);
      const i3 = r.stdout.indexOf(h3);
      expect(i1).toBeGreaterThanOrEqual(0);
      expect(i2).toBeGreaterThan(i1);
      expect(i3).toBeGreaterThan(i2);

      expect(r.stdout).toContain("$ nimbus --demo oncall");
      expect(r.stdout).toContain("$ nimbus --demo why src/retry/backoff.ts:42");
      expect(r.stdout).toContain("$ nimbus --demo owners src/retry");

      const onCallSection = r.stdout.slice(i1, i2);
      const whySection = r.stdout.slice(i2, i3);
      const ownersSection = r.stdout.slice(i3);

      expect(onCallSection).toContain("payment-service");
      expect(onCallSection).toContain("412");
      expect(onCallSection).toContain("## Gaps");

      expect(whySection).toContain("PAY-231");
      expect(whySection).toContain("## Gaps");

      expect(ownersSection).toMatch(/Dana( Okafor)?|dana\.okafor@acme\.example/);
      expect(ownersSection).toContain("## Gaps");

      // The closing "Try:" list — every one of its commands is exercised in test 5b.
      expect(r.stdout).toContain("nimbus --demo standup");
      expect(r.stdout).toContain("nimbus --demo expert payments");
      expect(r.stdout).toContain("nimbus --demo decisions");
      expect(r.stdout).toContain(
        "nimbus --demo stats deployment-frequency --service payment-service",
      );

      // Two demo gateways booted above (seed, then restart). Neither may have flushed
      // telemetry or checked for an update — spec § 11.3's "no outbound call".
      expectNoOutboundRequests();
    },
    DEMO_TIMEOUT_MS + 30_000,
  );

  test(
    "1b. `nimbus demo --no-tour` run AGAIN while the first demo gateway is still up: exit 0 (spec § 6, the Windows EBUSY case)",
    async () => {
      // The re-run must stop the live gateway and WAIT for its process to exit before it deletes
      // and recreates the root — on Windows an immediate delete hits EBUSY on nimbus.db. It
      // leaves a running, freshly seeded demo gateway behind, which every later test relies on.
      const pidBefore = readGatewayPid(demoDataDir);
      expect(pidBefore).toBeDefined();
      if (pidBefore !== undefined) expect(isAlive(pidBefore)).toBe(true);

      const r = await cli(["demo", "--no-tour"], DEMO_TIMEOUT_MS);
      if (r.code !== 0) {
        throw new Error(
          `second \`nimbus demo --no-tour\` exited ${String(r.code)}\n` +
            `--- stdout ---\n${r.stdout.slice(-2000)}\n--- stderr ---\n${r.stderr.slice(-2000)}`,
        );
      }
      expect(r.stdout).toContain('Seeded the synthetic "Acme" org');
      expect(r.stdout).not.toContain("── [1/3]");

      const pidAfter = readGatewayPid(demoDataDir);
      expect(pidAfter).toBeDefined();
      expect(pidAfter).not.toBe(pidBefore);
      if (pidBefore !== undefined) expect(isAlive(pidBefore)).toBe(false);
      if (pidAfter !== undefined) expect(isAlive(pidAfter)).toBe(true);
      expectNoOutboundRequests();
    },
    DEMO_TIMEOUT_MS + 30_000,
  );

  test("2. `--demo status`: exit 0, stderr carries the seeded banner, stdout does not", async () => {
    const r = await cli(["--demo", "status"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('DEMO — synthetic "Acme" org, not your data');
    expect(r.stdout).not.toContain("DEMO —");
  });

  test("3. `--demo connector auth github`: refused with ERR_DEMO_FORBIDDEN (I41 clause 6)", async () => {
    // `--token` is supplied so the CLI's own local validation (a real PAT is required before it
    // will even attempt the call) does not short-circuit before the gateway's refusal gate has a
    // chance to fire — the value is never used, since the demo gateway refuses the method before
    // any connector code runs.
    const r = await cli(["--demo", "connector", "auth", "github", "--token", "demo-refusal-probe"]);
    expect(r.code).not.toBe(0);
    expect(`${r.stdout}\n${r.stderr}`).toContain("ERR_DEMO_FORBIDDEN");
  });

  test(
    "4. `--demo ask`: exits within 90s (no hang) and prints something",
    async () => {
      const r = await cli(
        ["--demo", "ask", "what is going on with payment-service?"],
        ASK_TIMEOUT_MS,
      );
      console.log(
        `[task 10] --demo ask exit=${String(r.code)}\n` +
          `--- stdout (first 15 lines) ---\n${r.stdout.split("\n").slice(0, 15).join("\n")}\n` +
          `--- stderr (first 15 lines) ---\n${r.stderr.split("\n").slice(0, 15).join("\n")}`,
      );
      expect(typeof r.code).toBe("number");
      const combined = `${r.stdout}${r.stderr}`;
      expect(combined.trim().length).toBeGreaterThan(0);
      // A demo hint must never name a command the demo gateway itself refuses (I41 clause 6) —
      // fix round 1: `ask.ts` now skips the real-install connector-registered pre-check entirely
      // in a demo root, so this text (and its `connector auth` guidance) must not appear here.
      expect(combined).not.toContain("nimbus connector auth");
      // fix round 2: the demo seeds no `[llm]` section, so `ask` now reaches the gateway (round
      // 1) and fails with the guided no-LLM message rather than a raw router error — and, since
      // this is a demo root, the DEMO variant of that message (never the real-install one, which
      // would say to edit nimbus.toml and run `nimbus stop && nimbus start` — dropping `--demo`
      // and stopping the REAL gateway).
      expect(combined).toContain("Nimbus needs an LLM for this command");
      expect(combined).not.toContain("nimbus stop");
      // Final fix wave: the demo variant now comes from the GATEWAY (`runAsk`), so this is the
      // same text the REPL, the TUI and `nimbus prove` receive.
      expect(combined).toContain("The demo does not configure one.");
      expect(combined).not.toContain("nimbus.toml");
    },
    ASK_TIMEOUT_MS + 10_000,
  );

  test("5. the env-selected HTTP sidecar never started", async () => {
    expect(await canConnect(httpPort)).toBe(false);
  });

  test(
    '5b. every command in the tour\'s closing "Try:" list works with --demo',
    async () => {
      const commands: string[][] = [
        ["standup"],
        ["expert", "payments"],
        ["decisions"],
        ["stats", "deployment-frequency", "--service", "payment-service"],
      ];
      for (const c of commands) {
        const r = await cli(["--demo", ...c], TRY_TIMEOUT_MS);
        if (r.code !== 0) {
          throw new Error(
            `nimbus --demo ${c.join(" ")} exited ${String(r.code)}\n` +
              `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
          );
        }
      }
    },
    TRY_TIMEOUT_MS * 4 + 20_000,
  );

  test("6. `demo stop`: exit 0; the run's gateway process is no longer alive", async () => {
    const pidBefore = readGatewayPid(demoDataDir);
    expect(pidBefore).toBeDefined();
    if (pidBefore === undefined) return; // unreachable; narrows for TS below
    expect(isAlive(pidBefore)).toBe(true);

    const r = await cli(["demo", "stop"], CLI_TIMEOUT_MS);
    expect(r.code).toBe(0);
    // `stopAndWaitForExit` blocks the CLI process until the OS process is gone (or throws), so a
    // clean exit 0 here already proves this — re-checked directly against the recorded pid.
    expect(isAlive(pidBefore)).toBe(false);
  });

  test("7. every file under the would-be REAL Nimbus directories is inside the demo root", () => {
    const { dataDir, others } = realNimbusDirs();
    const stray = [dataDir, ...others].flatMap(filesUnder).filter((f) => !isInside(f, demoRoot));
    expect(stray).toEqual([]);
  });

  test("8. across the whole run, no demo gateway contacted the telemetry or updater endpoint", () => {
    expectNoOutboundRequests();
  });
});
