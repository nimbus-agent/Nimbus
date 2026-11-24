/**
 * The macOS connection source against the real OS: a child started through the real sandbox runner
 * (`sandbox-exec`) opens connections to a declared host and starts a grandchild process, while an
 * unsandboxed control process does the same; the source must find the child's and the grandchild's
 * and none of the control's. The fake-libproc half is `darwin-connections.test.ts`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const IS_DARWIN = process.platform === "darwin";
/** The real run's answer and timings are printed only on request (`NIMBUS_OBSERVE_METRICS=1`). */
const PRINT_METRICS = process.env["NIMBUS_OBSERVE_METRICS"] === "1";
const POLICY_ID = "nimbus.observe-darwin-test";
const HOST = "api.github.com";

/**
 * The child's GRANDCHILD: a separate process (its own PID, spawned by the sandboxed child, so inside
 * the sandbox) that opens one connection, reports it, and holds it until its stdin closes. Imports
 * nothing from the repo.
 */
const GRANDCHILD_SOURCE = `
import { connect } from "node:net";
const s = connect({ host: ${JSON.stringify(HOST)}, port: 443 });
let connected = false;
const report = (r) => process.stdout.write(JSON.stringify(r) + "\\n");
const t = setTimeout(() => { report({ error: "timeout" }); process.exit(2); }, 8000);
s.once("connect", () => {
  connected = true;
  clearTimeout(t);
  report({ localPort: s.localPort, remoteIp: s.remoteAddress });
});
// After the connect the peer may drop the idle socket; nothing the test reads depends on it.
s.on("error", (e) => {
  if (!connected) { clearTimeout(t); report({ error: e.code ?? e.message }); process.exit(3); }
});
process.stdin.resume();
process.stdin.once("end", () => { s.destroy(); process.exit(0); });
`;

/** Runs under sandbox-exec (or, with --control, outside it). Imports nothing from the repo. */
const CHILD_SOURCE = `
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const role = process.argv.includes("--control") ? "control" : "child";
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "out");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function open(port, holdMs) {
  return new Promise((resolve) => {
    const s = connect({ host: ${JSON.stringify(HOST)}, port });
    const t = setTimeout(() => { s.destroy(); resolve({ ok: false, error: "timeout" }); }, 8000);
    s.once("connect", () => {
      clearTimeout(t);
      const r = { ok: true, localPort: s.localPort, remoteIp: s.remoteAddress, remotePort: s.remotePort };
      setTimeout(() => { s.destroy(); resolve(r); }, holdMs);
    });
    s.once("error", (e) => { clearTimeout(t); resolve({ ok: false, error: e.code ?? e.message }); });
  });
}
async function waitFor(path, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (existsSync(path)) return true; await sleep(50); }
  return false;
}
// The grandchild owns its own connection and HOLDS it until the driver reports it observed that
// exact row (out/grand-seen), so the check never races the connection's lifetime: the earlier
// grandchild, a rate-limited curl, finished before a 100 ms poll landed on the macOS runner. The
// handshake decides only WHEN the grandchild lets go; the driver finds its row through the process
// tree like any other, and the child gives up after 20 s, which fails the test.
function grandchild() {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(process.execPath, [join(here, "grand.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; let err = ""; let r = null; let observed = false;
    p.stdout.on("data", async (d) => {
      out += String(d);
      if (r !== null || !out.includes("\\n")) return;
      try { r = JSON.parse(out.split("\\n")[0]); } catch { r = { error: "bad report" }; }
      if (typeof r.localPort === "number") {
        writeFileSync(join(OUT, "grand.json.tmp"),
          JSON.stringify({ pid: p.pid, localPort: r.localPort, remoteIp: r.remoteIp }));
        renameSync(join(OUT, "grand.json.tmp"), join(OUT, "grand.json"));
        observed = await waitFor(join(OUT, "grand-seen"), 20000);
      }
      p.stdin.end();
    });
    p.stderr.on("data", (d) => { err += String(d); });
    p.on("error", (e) => resolve({ error: e.message }));
    p.on("close", (code) => {
      resolve({ pid: p.pid, exit: code, localPort: r?.localPort, remoteIp: r?.remoteIp, observed,
        error: r?.error, ms: Date.now() - started, stderr: err.slice(0, 500) });
    });
  });
}
await sleep(500);
const connections = await Promise.all([open(443, 1000), open(443, 1000), open(443, 1000)]);
// The premise that this child really is confined: port 80 is not declared, so sandbox-exec refuses it.
const undeclared = role === "child" ? await open(80, 0) : null;
const grand = role === "child" ? await grandchild() : null;
process.stdout.write(JSON.stringify({ role, pid: process.pid, connections, undeclared, grand }) + "\\n");
`;

const DRIVER_SOURCE = (childPath: string, workDir: string) => `
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSandboxRunner } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../index.ts")).href)};
import { openDarwinConnectionSource } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "darwin-connections.ts")).href)};
const bunDir = dirname(process.execPath);
// Bun reads its own home tree (~/.bun) at startup, not only the binary (sandbox-wrapper-spawn.test.ts).
const policy = { id: ${JSON.stringify(POLICY_ID)}, permissions: {
  network: ["${HOST}:443"],
  filesystem: { read: [${JSON.stringify(workDir)}, bunDir, dirname(bunDir)], write: [join(${JSON.stringify(workDir)}, "out")] } } };
const runner = await createSandboxRunner();
const refusal = runner.canConfine(policy);
if (refusal !== null) { console.log(JSON.stringify({ refusal })); process.exit(0); }
function collect(p) {
  return new Promise((resolve) => {
    let out = ""; let err = "";
    p.stdout.on("data", (d) => { out += String(d); });
    p.stderr.on("data", (d) => { err += String(d); });
    p.on("close", (code) => resolve({ out, err, code }));
    p.on("error", (e) => resolve({ out, err: err + e.message, code: -1 }));
  });
}
const child = runner.spawn(process.execPath, [${JSON.stringify(childPath)}], {
  policy, env: { ...process.env }, cwd: ${JSON.stringify(workDir)}, stdio: ["ignore", "pipe", "pipe"],
});
const control = spawn(process.execPath, [${JSON.stringify(childPath)}, "--control"], {
  stdio: ["ignore", "pipe", "pipe"] });
const t0 = performance.now();
const source = openDarwinConnectionSource({ rootPid: child.pid });
const openMs = performance.now() - t0;
if ("error" in source) { child.kill(); control.kill(); console.log(JSON.stringify({ openError: source.error })); process.exit(0); }
const seen = new Map();
const pollMs = [];
let pollErrors = 0;
let firstError = "";
const outDir = join(${JSON.stringify(workDir)}, "out");
let grandSeen = false;
// Lets the grandchild close once its row has been observed. It reads what the child reported and
// never feeds the source, which finds the grandchild only through the process tree.
function releaseGrandchild() {
  if (grandSeen || !existsSync(join(outDir, "grand.json"))) return;
  const g = JSON.parse(readFileSync(join(outDir, "grand.json"), "utf8"));
  if (!seen.has(g.pid + "|" + g.localPort + "|" + g.remoteIp + "|443")) return;
  grandSeen = true;
  writeFileSync(join(outDir, "grand-seen"), "");
}
function pass() {
  const s = performance.now();
  try {
    for (const c of source.poll()) seen.set(c.pid + "|" + c.localPort + "|" + c.remoteIp + "|" + c.remotePort, c);
  } catch (e) { pollErrors++; firstError ||= String(e); }
  pollMs.push(performance.now() - s);
  releaseGrandchild();
}
const timer = setInterval(pass, 100);
const kill = setTimeout(() => { child.kill(); control.kill(); }, 45000);
const [c, k] = await Promise.all([collect(child), collect(control)]);
clearInterval(timer);
clearTimeout(kill);
pass();
source.close();
const cpu = process.cpuUsage();
console.log(JSON.stringify({
  rootPid: child.pid, openMs, pollMs, pollErrors, firstError, rows: [...seen.values()],
  child: { code: c.code, out: c.out, err: c.err.slice(0, 2000) },
  control: { code: k.code, out: k.out, err: k.err.slice(0, 2000) },
  cpuUs: cpu.user + cpu.system,
}));
`;

type Conn = { ok: boolean; localPort?: number; remoteIp?: string; remotePort?: number };
type Report = {
  role: string;
  pid: number;
  connections: Conn[];
  undeclared: (Conn & { error?: string }) | null;
  grand: {
    pid?: number;
    exit?: number;
    observed?: boolean;
    localPort?: number;
    remoteIp?: string;
    ms?: number;
    error?: string;
    stderr?: string;
  } | null;
};
type Row = { pid: number; localPort: number; remoteIp: string; remotePort: number };
type DriverAnswer = {
  refusal?: string;
  openError?: string;
  rootPid: number;
  openMs: number;
  pollMs: number[];
  pollErrors: number;
  firstError: string;
  rows: Row[];
  child: { code: number | null; out: string; err: string };
  control: { code: number | null; out: string; err: string };
  cpuUs: number;
};

/** One row as text, so a missing field in what the child reported shows up as `undefined`. */
function rowKey(pid?: number, localPort?: number, remoteIp?: string, remotePort?: number): string {
  return `${pid}|${localPort}|${remoteIp}|${remotePort}`;
}

function report(proc: { code: number | null; out: string; err: string }): Report {
  const line = proc.out
    .split(/\r?\n/)
    .filter((l) => l.startsWith("{"))
    .at(-1);
  if (line === undefined) {
    throw new Error(`no report (exit ${proc.code}): ${proc.out}
${proc.err}`);
  }
  return JSON.parse(line) as Report;
}

describe.skipIf(!IS_DARWIN)("openDarwinConnectionSource (real macOS)", () => {
  // realpath'd: /var is a symlink to /private/var, and the SBPL profile matches the kernel's path.
  const work = IS_DARWIN ? realpathSync(mkdtempSync(join(tmpdir(), "nimbus-observe-darwin-"))) : "";
  afterAll(() => {
    if (work !== "") rmSync(work, { recursive: true, force: true });
  });

  test("finds the sandboxed child's and its grandchild's connections and none of the control's", async () => {
    const childPath = join(work, "child.mjs");
    writeFileSync(childPath, CHILD_SOURCE);
    writeFileSync(join(work, "grand.mjs"), GRANDCHILD_SOURCE);
    mkdirSync(join(work, "out"));
    const driverDir = mkdtempSync(join(dirname(work), "nimbus-observe-darwin-driver-"));
    const driver = join(driverDir, "driver.ts");
    writeFileSync(driver, DRIVER_SOURCE(childPath, work));
    try {
      // The driver, not this test worker, spawns the children: a node:child_process spawn inside a
      // macOS test worker can lose its child's exit (oven-sh/bun#41024).
      const proc = Bun.spawn([process.execPath, "--no-env-file", driver], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 90_000,
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const line = stdout.trim().split(/\r?\n/).at(-1);
      if (line === undefined || line === "") throw new Error(`driver gave no answer: ${stderr}`);
      const a = JSON.parse(line) as DriverAnswer;
      // Premise: the runner confines a port-443 policy, and the source opened.
      expect(a.refusal).toBeUndefined();
      expect(a.openError).toBeUndefined();
      expect(a.firstError).toBe("");
      expect(a.pollErrors).toBe(0);

      const child = report(a.child);
      const control = report(a.control);
      // Premise: both really connected, or "found none of the control's" would pass vacuously...
      expect(child.connections.every((x) => x.ok)).toBe(true);
      expect(control.connections.every((x) => x.ok)).toBe(true);
      // ...and the child really is confined (an undeclared port is refused), so this is the
      // sandboxed tree and not an unconfined process that happens to share a parent.
      expect(child.undeclared?.ok).toBe(false);

      // Each of the child's sockets, with the local port, remote address and remote port the child
      // itself saw: a wrong struct offset in any of the three fails here.
      const keys = a.rows.map((r) => rowKey(r.pid, r.localPort, r.remoteIp, r.remotePort));
      for (const conn of child.connections) {
        expect(keys).toContain(rowKey(child.pid, conn.localPort, conn.remoteIp, 443));
      }
      // The grandchild: found through the process tree, owned by the grandchild's own PID.
      expect(child.grand).toMatchObject({ exit: 0 });
      const g = child.grand;
      expect(g?.localPort).toBeGreaterThan(0);
      expect(g?.pid).not.toBe(child.pid);
      expect(keys).toContain(rowKey(g?.pid, g?.localPort, g?.remoteIp, 443));
      // ...and the driver released it only after seeing that row, not on the child's 20 s give-up.
      expect(g?.observed).toBe(true);
      // Nothing of the control's, and nothing from any process outside the child's tree.
      const controlPorts = control.connections.map((x) => x.localPort);
      expect(a.rows.filter((r) => controlPorts.includes(r.localPort))).toEqual([]);
      expect(a.rows.some((r) => r.pid === control.pid)).toBe(false);
      const tree = new Set([a.rootPid, child.pid, g?.pid]);
      expect(a.rows.filter((r) => !tree.has(r.pid))).toEqual([]);

      const sorted = [...a.pollMs].sort((x, y) => x - y);
      if (PRINT_METRICS) {
        console.log(`[observe-darwin] driver answer: ${line.slice(0, 6000)}`);
        console.log(
          JSON.stringify({
            rootPid: a.rootPid,
            childPid: child.pid,
            grandPid: g?.pid,
            openMs: a.openMs,
            polls: a.pollMs.length,
            pollMsMedian: sorted[Math.floor(sorted.length / 2)],
            pollMsMax: sorted.at(-1),
            driverCpuMs: a.cpuUs / 1000,
            rows: a.rows.length,
            grandchildMs: g?.ms,
          }),
        );
      }
    } finally {
      rmSync(driverDir, { recursive: true, force: true });
    }
  }, 120_000);
});
