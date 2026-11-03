/**
 * A by-hand measurement of what network observation costs on Windows or macOS, and how many
 * connections it catches. Not a test: nothing runs it in CI. The figures it printed are recorded in
 * `docs/sandbox.md` § Observation.
 *
 *   NIMBUS_SANDBOX_HELPER_PATH=<helper.exe> bun packages/gateway/test/fixtures/observation-cpu-measure.ts \
 *     [--seconds 60] [--interval 200] [--hold 100] [--no-baseline]
 *
 * It runs the real `runSandboxWrapper` (production dependencies: the platform runner, the
 * connection source, the 250 ms poller, the OS resolver) around a real sandboxed child that opens a
 * TCP connection to `api.github.com:443` every `--interval` ms for `--seconds` s and holds each one
 * `--hold` ms after it connects. It runs this twice: once observed (the observation env set, so the
 * wrapper opens the connection source and polls) and once not (no observation env: no source, no
 * poller), unless `--no-baseline`. The wrapper process reports its own `process.cpuUsage()` at exit;
 * the observed run's CPU minus the unobserved run's is what observation cost. The catch rate is the
 * connections the window files counted (`used` plus `unmatched`) over the connections the child
 * reports it opened.
 *
 * Needs the network. Test data lives in a fresh temp dir, removed at the end; on Windows the
 * AppContainer profile it created is deleted too.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  SANDBOX_CWD_ENV,
  SANDBOX_OBSERVATION_FILE_ENV,
  SANDBOX_OBSERVATION_LABEL_ENV,
  SANDBOX_POLICY_ENV,
} from "../../src/platform/sandbox/sandbox-policy.ts";

const HOST = "api.github.com";
const POLICY_ID = "nimbus.observe-cpu-measure";

// --- The driver ----------------------------------------------------------------------------------

/** Runs inside the sandbox. Resolves the host once, then connects on a fixed interval. */
const CHILD_SOURCE = `
import { writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
const [host, seconds, interval, hold, outFile] = process.argv.slice(2);
const { address } = await lookup(host, { family: 4 });
let made = 0, ok = 0, failed = 0;
const pending = new Set();
function open() {
  made++;
  const p = new Promise((done) => {
    const s = connect({ host: address, port: 443 });
    const t = setTimeout(() => { s.destroy(); failed++; done(); }, 10000);
    s.once("connect", () => {
      clearTimeout(t);
      ok++;
      setTimeout(() => { s.destroy(); done(); }, Number(hold));
    });
    s.once("error", () => { clearTimeout(t); failed++; done(); });
  });
  pending.add(p);
  p.then(() => pending.delete(p));
}
const end = Date.now() + Number(seconds) * 1000;
await new Promise((stop) => {
  const timer = setInterval(() => {
    if (Date.now() >= end) { clearInterval(timer); stop(); return; }
    open();
  }, Number(interval));
});
await Promise.all([...pending]);
writeFileSync(outFile, JSON.stringify({ address, made, ok, failed }));
`;

type Args = { seconds: number; interval: number; hold: number; baseline: boolean };

function parseArgs(argv: readonly string[]): Args {
  const num = (flag: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    if (i < 0) return fallback;
    const v = Number(argv[i + 1]);
    if (!Number.isFinite(v) || v < 0) throw new Error(`${flag} needs a non-negative number`);
    return v;
  };
  return {
    seconds: num("--seconds", 60),
    interval: num("--interval", 200),
    hold: num("--hold", 100),
    baseline: !argv.includes("--no-baseline"),
  };
}

type Entry = { o: string; h: string; p: number; n: number };
type RunResult = {
  observed: boolean;
  cpuMs: number;
  wallMs: number;
  child: { address: string; made: number; ok: number; failed: number };
  used: number;
  unmatched: number;
  networkObserved: boolean | null;
  stderr: string;
};

async function runOnce(work: string, args: Args, observed: boolean): Promise<RunResult> {
  const tag = observed ? "observed" : "unobserved";
  const sandboxDir = join(work, tag, "sandbox");
  const outDir = join(sandboxDir, "out");
  const obsDir = join(work, tag, "observations");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(obsDir);
  const childPath = join(sandboxDir, "child.mjs");
  writeFileSync(childPath, CHILD_SOURCE);
  const report = join(outDir, "report.json");
  const cpuFile = join(work, tag, "cpu.json");
  const bunDir = dirname(process.execPath);
  const read = process.platform === "darwin" ? [sandboxDir, bunDir, dirname(bunDir)] : [sandboxDir];
  const policy = {
    id: POLICY_ID,
    permissions: { network: [`${HOST}:443`], filesystem: { read, write: [outDir] } },
  };
  const env: Record<string, string | undefined> = {
    ...process.env,
    [SANDBOX_POLICY_ENV]: JSON.stringify(policy),
    [SANDBOX_CWD_ENV]: sandboxDir,
  };
  if (observed) {
    env[SANDBOX_OBSERVATION_FILE_ENV] = join(obsDir, "ext_measure.1000.deadbeef");
    env[SANDBOX_OBSERVATION_LABEL_ENV] = JSON.stringify({
      extensionId: "com.example.measure",
      version: "1.0.0",
    });
  }
  const childArgs = [
    process.execPath,
    childPath,
    HOST,
    String(args.seconds),
    String(args.interval),
    String(args.hold),
    report,
  ];
  const started = performance.now();
  const wrapper = Bun.spawn(
    [process.execPath, "--no-env-file", import.meta.path, "--wrapper", cpuFile, ...childArgs],
    { env, stdout: "pipe", stderr: "pipe", windowsHide: true },
  );
  const [, stderr, code] = await Promise.all([
    new Response(wrapper.stdout).text(),
    new Response(wrapper.stderr).text(),
    wrapper.exited,
  ]);
  const wallMs = performance.now() - started;
  if (code !== 0 || !existsSync(report)) {
    throw new Error(`${tag} run failed (exit ${code}): ${stderr}`);
  }
  const cpu = JSON.parse(readFileSync(cpuFile, "utf8")) as { userUs: number; systemUs: number };
  const files = readdirSync(obsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(obsDir, f), "utf8")) as Record<string, unknown>);
  const entries = files.flatMap((f) => (f["entries"] as Entry[] | undefined) ?? []);
  const sum = (o: string): number =>
    entries.filter((e) => e.o === o).reduce((total, e) => total + e.n, 0);
  return {
    observed,
    cpuMs: (cpu.userUs + cpu.systemUs) / 1000,
    wallMs,
    child: JSON.parse(readFileSync(report, "utf8")) as RunResult["child"],
    used: sum("used"),
    unmatched: sum("unmatched"),
    networkObserved: files.length === 0 ? null : files.every((f) => f["networkObserved"] === true),
    stderr: stderr.trim(),
  };
}

async function main(): Promise<void> {
  if (process.platform !== "win32" && process.platform !== "darwin") {
    throw new Error("observation-cpu-measure: Windows or macOS only");
  }
  const args = parseArgs(process.argv.slice(2));
  const helper =
    process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
    resolve(import.meta.dir, "../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");
  if (process.platform === "win32") {
    if (!existsSync(helper)) throw new Error(`build the helper first: ${helper}`);
    process.env["NIMBUS_SANDBOX_HELPER_PATH"] = helper;
  }
  const work = mkdtempSync(join(tmpdir(), "nimbus-observe-cpu-"));
  try {
    const observed = await runOnce(work, args, true);
    const baseline = args.baseline ? await runOnce(work, args, false) : undefined;
    const seen = observed.used + observed.unmatched;
    const result = {
      platform: process.platform,
      args,
      pollPeriodMs: 250,
      observed,
      baseline,
      catchRate: observed.child.ok === 0 ? null : seen / observed.child.ok,
      observationCpuMs: baseline === undefined ? null : observed.cpuMs - baseline.cpuMs,
      observationCpuPctOfOneCore:
        baseline === undefined ? null : ((observed.cpuMs - baseline.cpuMs) / observed.wallMs) * 100,
    };
    process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
    if (process.platform === "win32") {
      spawnSync(helper, ["--delete-profile", `nimbus-ext-${POLICY_ID}`], { windowsHide: true });
    }
  }
}

// --- Entry: the wrapper role (a child of the driver) or the driver -------------------------------

if (process.argv[2] === "--wrapper") {
  const cpuFile = process.argv[3] ?? "";
  // The wrapper ends with process.exit once the child exits: the 'exit' event still runs.
  process.on("exit", () => {
    const cpu = process.cpuUsage();
    writeFileSync(cpuFile, JSON.stringify({ userUs: cpu.user, systemUs: cpu.system }));
  });
  const { runSandboxWrapper } = await import("../../src/platform/sandbox/sandbox-wrapper.ts");
  await runSandboxWrapper(process.argv.slice(4));
} else {
  await main();
}
