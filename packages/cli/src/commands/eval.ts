/**
 * `nimbus eval --package <dir>`: run an extension package's eval suites in the sandbox and print
 * the score. Gateway-free: it spawns the gateway executable's `__nimbus-eval` role, which writes
 * exactly ONE JSON document to stdout, and renders that. The CLI never imports gateway source, so
 * the document type is declared here.
 */
import { resolve } from "node:path";
import { type EvalReport, parseEvalQuality } from "@nimbus-dev/registry-format";
import { type GatewayLaunchPlan, resolveGatewayLaunch } from "../lib/resolve-gateway-launch.ts";

export const EVAL_ROLE_STDOUT_MAX_BYTES = 8 * 1024 * 1024;
export const EVAL_ROLE_STDERR_KEEP_BYTES = 64 * 1024;
export const EVAL_ROLE_WALL_CLOCK_MS = 12 * 60 * 1000;

export type EvalRoleDocument =
  | { ok: true; extensionId: string; version: string; report: EvalReport }
  | { ok: false; error: { code: string; message: string } };

export interface EvalSpawnResult {
  code: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  timedOut: boolean;
}

export interface EvalCliDeps {
  launch: () => GatewayLaunchPlan;
  spawnRole: (
    cmd: string[],
    cwd: string | undefined,
    timeoutMs: number,
  ) => Promise<EvalSpawnResult>;
  log: (s: string) => void;
  err: (s: string) => void;
}

const USAGE = "usage: nimbus eval --package <dir> [--suite <file>] [--json]";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isResult(v: unknown): boolean {
  return (
    isObject(v) &&
    typeof v["suite"] === "string" &&
    typeof v["case"] === "string" &&
    typeof v["rubric"] === "string" &&
    typeof v["pass"] === "boolean" &&
    (v["reason"] === null || typeof v["reason"] === "string")
  );
}

function parseReport(raw: unknown): EvalReport | null {
  if (!isObject(raw) || !Array.isArray(raw["results"])) return null;
  if (!raw["results"].every(isResult)) return null;
  const { results: _results, ...quality } = raw;
  try {
    parseEvalQuality(quality);
  } catch {
    return null;
  }
  return raw as unknown as EvalReport;
}

/** Validate the role's document; null when it is not one. */
export function parseEvalRoleDocument(text: string): EvalRoleDocument | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  if (raw["ok"] === false) {
    const e = raw["error"];
    if (isObject(e) && typeof e["code"] === "string" && typeof e["message"] === "string") {
      return { ok: false, error: { code: e["code"], message: e["message"] } };
    }
    return null;
  }
  if (raw["ok"] !== true) return null;
  if (typeof raw["extensionId"] !== "string" || typeof raw["version"] !== "string") return null;
  const report = parseReport(raw["report"]);
  if (report === null) return null;
  return { ok: true, extensionId: raw["extensionId"], version: raw["version"], report };
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  max: number,
  keep: "first" | "last",
  onOverflow: () => void,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflowed = false;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (overflowed) continue;
    chunks.push(value);
    size += value.byteLength;
    if (keep === "first" && size > max) {
      overflowed = true;
      onOverflow();
    }
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return keep === "last" && all.byteLength > max ? all.subarray(all.byteLength - max) : all;
}

export const spawnEvalRole: EvalCliDeps["spawnRole"] = async (cmd, cwd, timeoutMs) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      ...(cwd === undefined ? {} : { cwd }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
  } catch (e) {
    const msg = `could not start the gateway: ${e instanceof Error ? e.message : String(e)}`;
    return {
      code: null,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode(msg),
      timedOut: false,
    };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      readCapped(
        proc.stdout as ReadableStream<Uint8Array>,
        EVAL_ROLE_STDOUT_MAX_BYTES,
        "first",
        () => proc.kill(),
      ),
      readCapped(
        proc.stderr as ReadableStream<Uint8Array>,
        EVAL_ROLE_STDERR_KEEP_BYTES,
        "last",
        () => {},
      ),
      proc.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

function defaultDeps(): EvalCliDeps {
  return {
    launch: () => resolveGatewayLaunch(process.execPath, import.meta.url),
    spawnRole: spawnEvalRole,
    log: (s) => console.log(s),
    err: (s) => console.error(s),
  };
}

interface ParsedArgs {
  pkg?: string;
  suite?: string;
  json: boolean;
  unavailable?: string;
  bad?: string;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") out.json = true;
    else if (a === "--extension" || a === "--installed") out.unavailable = a;
    else if (a === "--package" || a === "--suite") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) out.bad = `${a} needs a value`;
      else if (a === "--package") out.pkg = v;
      else out.suite = v;
      i++;
    } else out.bad = `unknown argument: ${a}`;
  }
  return out;
}

function renderReport(doc: Extract<EvalRoleDocument, { ok: true }>): string[] {
  const { report } = doc;
  const lines: string[] = [`${doc.extensionId} ${doc.version}`];
  const bySuite = new Map<string, { passed: number; total: number }>();
  for (const r of report.results) {
    const t = bySuite.get(r.suite) ?? { passed: 0, total: 0 };
    t.total += 1;
    if (r.pass) t.passed += 1;
    bySuite.set(r.suite, t);
  }
  for (const [suite, t] of bySuite) lines.push(`${suite}: ${t.passed}/${t.total}`);
  for (const r of report.results) {
    if (!r.pass) lines.push(`  FAIL ${r.suite} ${r.case}: ${r.reason ?? "failed"}`);
  }
  lines.push(`score ${report.score}/100 (${report.passed} of ${report.cases} cases)`);
  lines.push("measured locally; a registry's published score is measured by its CI");
  return lines;
}

/** Returns the process exit code: 0 when the eval ran (any score), 2 on an eval or usage error. */
export async function runEval(args: readonly string[], deps?: EvalCliDeps): Promise<number> {
  const d = deps ?? defaultDeps();
  const p = parseArgs(args);
  if (p.unavailable !== undefined) {
    d.err(`nimbus eval ${p.unavailable} is not available yet; use --package <dir>`);
    return 2;
  }
  if (p.bad !== undefined || p.pkg === undefined) {
    d.err(p.bad === undefined ? USAGE : `${p.bad}\n${USAGE}`);
    return 2;
  }
  const plan = d.launch();
  if (!plan.ok) {
    d.err(`eval failed: ${plan.message}`);
    return 2;
  }
  const roleArgs = ["__nimbus-eval", "--package", resolve(p.pkg)];
  if (p.suite !== undefined) roleArgs.push("--suite", p.suite);
  const res = await d.spawnRole([...plan.cmd, ...roleArgs], plan.cwd, EVAL_ROLE_WALL_CLOCK_MS);
  const tail = new TextDecoder().decode(res.stderr).trim();
  const fail = (what: string): number => {
    d.err(`eval failed: ${what}`);
    if (tail.length > 0) d.err(tail);
    return 2;
  };
  if (res.timedOut) return fail("the eval run exceeded its 12 minute wall-clock limit");
  if (res.stdout.byteLength > EVAL_ROLE_STDOUT_MAX_BYTES) {
    return fail("the eval output was too large");
  }
  const text = new TextDecoder().decode(res.stdout).trim();
  const doc = parseEvalRoleDocument(text);
  if (doc === null) {
    return fail(
      res.code === 0 || res.code === null
        ? "the eval role printed no valid document"
        : `the eval role exited ${res.code} without a document`,
    );
  }
  if (!doc.ok) return fail(`${doc.error.code}: ${doc.error.message}`);
  if (p.json) d.log(text);
  else for (const line of renderReport(doc)) d.log(line);
  return 0;
}
