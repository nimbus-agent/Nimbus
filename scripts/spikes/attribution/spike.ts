// Spike 6a driver (quality layer, spec section 10.2). Throwaway; never merges.
//
// Question: unelevated, can the gateway attribute a TCP connection to an extension's REAL child,
// through the Windows helper (AppContainer) and the macOS sandbox-exec wrapper, including a
// grandchild, without claiming an unrelated process's connections?
//
// For each polling period it spawns the child through the gateway's real SandboxRunner with a
// declared network, starts the native poller on the spawned PID, also runs an UNSANDBOXED control
// process making the same connections, and compares what the poller saw with what each process
// says it opened (by local port). Writes spike-result.json and a markdown summary.
//
// Usage: bun scripts/spikes/attribution/spike.ts <poller binary> [periods, default 5,20,100]
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSandboxRunner } from "../../../packages/gateway/src/platform/sandbox/index.ts";
import type { SandboxPolicy } from "../../../packages/gateway/src/platform/sandbox/sandbox-policy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const poller = process.argv[2];
if (poller === undefined) throw new Error("usage: spike.ts <poller binary> [periods]");
const periods = (process.argv[3] ?? "5,20,100").split(",").map(Number);
const DURATION_MS = 25_000;

type Conn = { localPort: number; holdMs: number; kind: string; ok: boolean; error?: string };
type Report = {
  pid: number;
  role: string;
  connections: Conn[];
  grandchild?: { pid?: number; exit?: number | null; error?: string }[];
};
type Row = {
  pid: number;
  localPort: number;
  remote: string;
  remotePort: number;
  byTree: boolean;
  bySid: boolean;
};

function collect(
  p: ReturnType<typeof spawn>,
): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    p.stdout?.on("data", (d) => {
      out += String(d);
    });
    p.stderr?.on("data", (d) => {
      err += String(d);
    });
    p.on("close", (code) => resolve({ out, err, code }));
    p.on("error", (e) => resolve({ out, err: `${err}\nspawn error: ${e.message}`, code: -1 }));
  });
}

/** Every report line in a process's stdout; the child and its grandchild share one stdout. */
function parseReports(text: string): Report[] {
  const out: Report[] = [];
  for (const l of text.split("\n")) {
    if (!l.startsWith("{")) continue;
    try {
      out.push(JSON.parse(l) as Report);
    } catch {
      // not a report line
    }
  }
  return out;
}

const runner = await createSandboxRunner();
const policy: SandboxPolicy = {
  id: "ext.spike-attribution",
  permissions: {
    network: ["api.github.com:443"],
    filesystem: { read: [here], write: [] },
  },
};
const posture = {
  platform: runner.platform,
  fullyActive: runner.isFullyActive(),
  degraded: runner.degradedReason(),
  canConfine: runner.canConfine(policy),
  networkScope: runner.networkScope?.() ?? "per_host",
};
console.log("posture", JSON.stringify(posture));
if (posture.canConfine !== null)
  throw new Error(`the runner cannot confine the policy: ${posture.canConfine}`);

const trials: unknown[] = [];
for (const period of periods) {
  const child = runner.spawn(process.execPath, [join(here, "child.ts")], {
    policy,
    // The runner's own env, as a spike: a hand-picked minimal set failed CreateProcessW with 203
    // (ERROR_ENVVAR_NOT_FOUND) locally, and attribution does not depend on the env.
    env: { ...process.env } as Record<string, string>,
    cwd: here,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rootPid = child.pid ?? -1;
  // A hang inside the sandbox must not stall the whole run.
  const deadline = setTimeout(() => child.kill(), DURATION_MS + 60_000);
  const poll = spawn(poller, [String(rootPid), String(period), String(DURATION_MS)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const control = spawn(process.execPath, [join(here, "child.ts"), "--control"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [c, p, k] = await Promise.all([collect(child), collect(poll), collect(control)]);
  clearTimeout(deadline);

  const reports = parseReports(c.out);
  const childReport = reports.find((r) => r.role === "child");
  const grandReport = reports.find((r) => r.role === "grandchild");
  const controlReport = parseReports(k.out).find((r) => r.role === "control");
  const lines = p.out
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));
  const rows = lines.filter((l) => !l.summary) as Row[];
  const summary = lines.find((l) => l.summary);

  const truth: { role: string; pid: number; c: Conn }[] = [];
  if (childReport !== undefined) {
    for (const conn of childReport.connections)
      truth.push({ role: "child", pid: childReport.pid, c: conn });
  }
  if (grandReport !== undefined) {
    for (const conn of grandReport.connections)
      truth.push({ role: "grandchild", pid: grandReport.pid, c: conn });
  }
  const controlPorts = new Set(
    (controlReport?.connections ?? []).filter((x) => x.ok).map((x) => x.localPort),
  );

  const byKind: Record<
    string,
    { opened: number; failed: number; seen: number; tree: number; sid: number; pidMatch: number }
  > = {};
  for (const t of truth) {
    const key = `${t.role}:${t.c.kind}`;
    byKind[key] ??= { opened: 0, failed: 0, seen: 0, tree: 0, sid: 0, pidMatch: 0 };
    const b = byKind[key];
    if (!t.c.ok) {
      b.failed++;
      continue;
    }
    b.opened++;
    const hit = rows.filter((r) => r.localPort === t.c.localPort && r.remotePort === 443);
    if (hit.length > 0) b.seen++;
    if (hit.some((r) => r.byTree)) b.tree++;
    if (hit.some((r) => r.bySid)) b.sid++;
    if (hit.some((r) => r.pid === t.pid)) b.pidMatch++;
  }
  // curl grandchildren: matched by owning PID, since curl does not report its local port.
  const curls = childReport?.grandchild ?? [];
  const g = { opened: 0, failed: 0, seen: 0, tree: 0, sid: 0, pidMatch: 0 };
  const curlPids = new Set<number>();
  for (const cu of curls) {
    if (cu.exit !== 0 || cu.pid === undefined) {
      g.failed++;
      continue;
    }
    g.opened++;
    curlPids.add(cu.pid);
    const hit = rows.filter((r) => r.pid === cu.pid && r.remotePort === 443);
    if (hit.length > 0) {
      g.seen++;
      g.pidMatch++;
    }
    if (hit.some((r) => r.byTree)) g.tree++;
    if (hit.some((r) => r.bySid)) g.sid++;
  }
  byKind["grandchild:curl"] = g;
  const truthPorts = new Set(truth.filter((t) => t.c.ok).map((t) => t.c.localPort));
  const falseAttribution = rows.filter((r) => controlPorts.has(r.localPort)).length;
  const unexplained = rows.filter(
    (r) => !truthPorts.has(r.localPort) && !controlPorts.has(r.localPort) && !curlPids.has(r.pid),
  );

  const trial = {
    period,
    rootPid,
    childPid: childReport?.pid,
    grandchildren: curls,
    childExit: c.code,
    childStderr: c.err.slice(0, 2000),
    childErrors: truth
      .filter((t) => !t.c.ok)
      .map((t) => t.c.error)
      .slice(0, 5),
    grandchild: childReport?.grandchild,
    pollerExit: p.code,
    pollerStderr: p.err.slice(0, 2000),
    summary,
    byKind,
    controlOpened: controlPorts.size,
    falseAttribution,
    unexplained,
  };
  console.log(JSON.stringify(trial, null, 2));
  trials.push(trial);
}

const result = { posture, os: process.platform, arch: process.arch, trials };
writeFileSync("spike-result.json", `${JSON.stringify(result, null, 2)}\n`);

const md: string[] = [
  `## Attribution spike, ${process.platform}`,
  "",
  "```json",
  JSON.stringify(posture),
  "```",
  "",
];
for (const t of trials as Array<Record<string, unknown>>) {
  md.push(
    `### period ${String(t["period"])} ms`,
    "",
    "| connections | opened | failed | seen | by tree | by SID | owner PID = reported PID |",
    "|---|---|---|---|---|---|---|",
  );
  for (const [k, v] of Object.entries(t["byKind"] as Record<string, Record<string, number>>)) {
    md.push(
      `| ${k} | ${v["opened"]} | ${v["failed"]} | ${v["seen"]} | ${v["tree"]} | ${v["sid"]} | ${v["pidMatch"]} |`,
    );
  }
  md.push(
    "",
    `control connections ${String(t["controlOpened"])}, wrongly attributed ${String(t["falseAttribution"])}; poller ${JSON.stringify(t["summary"])}`,
    "",
  );
}
const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
if (summaryFile) appendFileSync(summaryFile, `${md.join("\n")}\n`);
console.log(md.join("\n"));
