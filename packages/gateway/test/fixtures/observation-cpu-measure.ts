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
 * poller), unless `--no-baseline`. The catch rate is the connections the window files counted
 * (`used` plus `unmatched`) over the connections the child reports it opened.
 *
 * What it measures, and at what resolution. `process.cpuUsage()` is NOT used for the cost: on
 * Windows it is charged in whole clock ticks (15.625 ms), so a pass of a few hundred microseconds
 * that follows each timer wake is billed a tick or nothing, and the total measures the tick
 * accounting rather than the work. Instead:
 *
 * - Per pass, wall time: `Bun.nanoseconds()` around each `pass()` (nanosecond resolution). The
 *   wrapper's poller is started through the wrapper's test-only `startPoller` seam with its own
 *   timer off, and this script's own unref'd 250 ms `setInterval` calls `pollNow()`, which is the
 *   same `pass(false)` the production timer calls; the final pass is `stop()`, timed the same way.
 * - Per pass, CPU (Windows): `QueryThreadCycleTime` of the wrapper's main thread around each pass.
 *   A pass is synchronous on that thread, so the delta is the pass's own CPU, user and kernel mode
 *   alike, in cycle-counter units.
 * - Whole wrapper process, CPU (Windows): `QueryProcessCycleTime` at exit minus at start (after the
 *   calibration below), observed run against the unobserved one. That includes what a pass alone
 *   does not: timer wakes, the 60 s declared-name lookups on libuv's threads, GC.
 * - Converting cycles to time: Windows documents these counters as CPU clock cycles but does not
 *   name the clock (on current hardware it advances at the invariant TSC rate, not the core's
 *   momentary frequency). So the wrapper calibrates: it busy-spins its main thread for 300 ms and
 *   divides the thread's cycle delta by the `Bun.nanoseconds()` delta. That rate assumes the spin
 *   was not preempted; it is printed so the conversion can be checked.
 * - macOS: per-pass wall time as above, and `process.cpuUsage()` for the process (getrusage, which
 *   macOS keeps in microseconds, not ticks). No cycle counter is read there.
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
const POLL_PERIOD_MS = 250;
const CALIBRATE_MS = 300;

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

/** What the wrapper role writes at exit. */
type WrapperReport = {
  /** process.cpuUsage(), kept for comparison only: tick-charged on Windows. */
  userUs: number;
  systemUs: number;
  /** From the end of calibration to exit. */
  wallNs: number;
  /** Windows: process cycles over the same span; null elsewhere. */
  processCycles: number | null;
  /** Windows: cycles per second, from the calibration spin; null elsewhere. */
  cyclesPerSecond: number | null;
  /** One entry per pass: wall ns and (Windows) main-thread cycles. */
  passes: { wallNs: number; cycles: number | null }[];
};

type Entry = { o: string; h: string; p: number; n: number };
type RunResult = {
  observed: boolean;
  wallMs: number;
  report: WrapperReport;
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
  const files = readdirSync(obsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(obsDir, f), "utf8")) as Record<string, unknown>);
  const entries = files.flatMap((f) => (f["entries"] as Entry[] | undefined) ?? []);
  const sum = (o: string): number =>
    entries.filter((e) => e.o === o).reduce((total, e) => total + e.n, 0);
  return {
    observed,
    wallMs,
    report: JSON.parse(readFileSync(cpuFile, "utf8")) as WrapperReport,
    child: JSON.parse(readFileSync(report, "utf8")) as RunResult["child"],
    used: sum("used"),
    unmatched: sum("unmatched"),
    networkObserved: files.length === 0 ? null : files.every((f) => f["networkObserved"] === true),
    stderr: stderr.trim(),
  };
}

const ascending = (a: number, b: number): number => a - b;

function quantiles(values: readonly number[]) {
  const sorted = [...values].sort(ascending);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const total = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    mean: sorted.length === 0 ? 0 : total / sorted.length,
    median: at(0.5),
    p95: at(0.95),
    max: at(1),
  };
}

/** The observed run's per-pass figures and the whole-process difference against the baseline. */
function summarise(observed: RunResult, baseline: RunResult | undefined) {
  const r = observed.report;
  const rate = r.cyclesPerSecond;
  const wall = quantiles(r.passes.map((p) => p.wallNs / 1e6));
  const passCycles = r.passes.flatMap((p) => (p.cycles === null ? [] : [p.cycles]));
  const cyclesToMs = (c: number): number | null => (rate === null ? null : (c / rate) * 1000);
  const cpu = quantiles(passCycles);
  const perPassCpuMs = cyclesToMs(cpu.mean);
  const tickCharged = (x: WrapperReport): number => (x.userUs + x.systemUs) / 1000;
  const processMs = (x: WrapperReport): number | null =>
    x.processCycles === null ? (x.userUs + x.systemUs) / 1000 : cyclesToMs(x.processCycles);
  const obsMs = processMs(r);
  const baseMs = baseline === undefined ? null : processMs(baseline.report);
  const spanS = r.wallNs / 1e9;
  return {
    passes: wall.n,
    perPassWallMs: wall,
    perPassCycles: passCycles.length === 0 ? null : cpu,
    cyclesPerSecond: rate,
    perPassCpuMs,
    perPassCpuPctOfOneCoreAt250ms:
      perPassCpuMs === null ? null : (perPassCpuMs / POLL_PERIOD_MS) * 100,
    perPassWallPctOfOneCoreAt250ms: (wall.mean / POLL_PERIOD_MS) * 100,
    process: {
      observedCpuMs: obsMs,
      baselineCpuMs: baseMs,
      differenceCpuMs: obsMs === null || baseMs === null ? null : obsMs - baseMs,
      differencePctOfOneCore:
        obsMs === null || baseMs === null ? null : ((obsMs - baseMs) / 1000 / spanS) * 100,
      spanS,
      method:
        r.processCycles === null
          ? "process.cpuUsage (getrusage, microseconds)"
          : "QueryProcessCycleTime",
    },
    tickChargedCpuUsageMs: {
      observed: tickCharged(r),
      baseline: baseline === undefined ? null : tickCharged(baseline.report),
      note: "process.cpuUsage(); on Windows charged in 15.625 ms ticks, so not a cost measurement",
    },
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
      pollPeriodMs: POLL_PERIOD_MS,
      child: observed.child,
      caught: { used: observed.used, unmatched: observed.unmatched, seen },
      catchRate: observed.child.ok === 0 ? null : seen / observed.child.ok,
      networkObserved: observed.networkObserved,
      cost: summarise(observed, baseline),
      stderr: { observed: observed.stderr, baseline: baseline?.stderr ?? null },
    };
    process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
    if (process.platform === "win32") {
      spawnSync(helper, ["--delete-profile", `nimbus-ext-${POLICY_ID}`], { windowsHide: true });
    }
  }
}

// --- The wrapper role: cycle counters and the timed poller ---------------------------------------

type CycleMeter = { thread(): number; process(): number };

/** Windows only: the main thread's and the whole process's cycle counters, through kernel32. */
async function openCycleMeter(): Promise<CycleMeter | null> {
  if (process.platform !== "win32") return null;
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  // The handles are the documented pseudo-handles, (HANDLE)-1 for the current process and
  // (HANDLE)-2 for the current thread, passed as i64: a pointer return of them does not survive
  // bun:ffi's conversion to a JS number.
  const k = dlopen("kernel32.dll", {
    QueryProcessCycleTime: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
    QueryThreadCycleTime: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
  const out = new BigUint64Array(1);
  const proc = -1n;
  const thread = -2n;
  const read = (ok: number): number => {
    if (ok === 0) throw new Error("cycle counter read failed");
    return Number(out[0] ?? 0n);
  };
  return {
    thread: () => read(k.QueryThreadCycleTime(thread, ptr(out))),
    process: () => read(k.QueryProcessCycleTime(proc, ptr(out))),
  };
}

/** Cycles per second of the counter: a busy spin of known wall time on the main thread. */
function calibrate(meter: CycleMeter): number {
  const c0 = meter.thread();
  const t0 = Bun.nanoseconds();
  while (Bun.nanoseconds() - t0 < CALIBRATE_MS * 1e6) {
    // Spin.
  }
  return (meter.thread() - c0) / ((Bun.nanoseconds() - t0) / 1e9);
}

async function wrapperRole(cpuFile: string, wrapperArgs: readonly string[]): Promise<void> {
  const meter = await openCycleMeter();
  const cyclesPerSecond = meter === null ? null : calibrate(meter);
  const passes: WrapperReport["passes"] = [];
  const startNs = Bun.nanoseconds();
  const startProcessCycles = meter?.process() ?? null;
  const startCpu = process.cpuUsage();
  // The wrapper ends with process.exit once the child exits: the 'exit' event still runs.
  process.on("exit", () => {
    const cpu = process.cpuUsage(startCpu);
    const report: WrapperReport = {
      userUs: cpu.user,
      systemUs: cpu.system,
      wallNs: Bun.nanoseconds() - startNs,
      processCycles:
        meter === null || startProcessCycles === null ? null : meter.process() - startProcessCycles,
      cyclesPerSecond,
      passes,
    };
    writeFileSync(cpuFile, JSON.stringify(report));
  });
  const timed = (run: () => void): void => {
    const c0 = meter?.thread() ?? null;
    const t0 = Bun.nanoseconds();
    run();
    const wallNs = Bun.nanoseconds() - t0;
    passes.push({ wallNs, cycles: c0 === null || meter === null ? null : meter.thread() - c0 });
  };
  const { startConnectionPoller } = await import(
    "../../src/platform/sandbox/observe/connection-poller.ts"
  );
  const { runSandboxWrapper } = await import("../../src/platform/sandbox/sandbox-wrapper.ts");
  await runSandboxWrapper(wrapperArgs, {
    // The production poller with its timer off, driven by an identical unref'd timer that times
    // each pass: `pollNow()` is the same `pass(false)` the production timer runs.
    startPoller: (opts) => {
      const inner = startConnectionPoller({ ...opts, periodMs: 0 });
      const timer = setInterval(() => timed(inner.pollNow), opts.periodMs ?? POLL_PERIOD_MS);
      timer.unref();
      return {
        pollNow: () => timed(inner.pollNow),
        stop: () => {
          clearInterval(timer);
          timed(inner.stop);
        },
      };
    },
  });
}

if (process.argv[2] === "--wrapper") {
  await wrapperRole(process.argv[3] ?? "", process.argv.slice(4));
} else {
  await main();
}
