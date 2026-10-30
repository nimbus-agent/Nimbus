/**
 * `nimbus eval --installed [--threshold <n>] [--json]`: evaluate every enabled installed extension
 * behind ONE owner approval, then compare each local score with the score its source registry
 * signed for the same version. The run is four named phases: candidates (`extension.list`) →
 * evaluate (one `extension.eval`) → compare (`registry.info`, sequentially, after the eval) →
 * render. Every gateway answer is external data and is validated here; the CLI reaches the gateway
 * over IPC only.
 */
import { type EvalReport, parseEvalReport } from "@nimbus-dev/registry-format";
import { stripControlChars } from "../lib/strip-control-chars.ts";
import { scoreOf } from "./extension-registry-cmds.ts";

export interface InstalledRunDeps {
  /** Every call shares ONE terminal-consent client session. */
  call: <T>(method: string, params: Record<string, unknown>) => Promise<T>;
  log: (s: string) => void;
  err: (s: string) => void;
}

/** A candidate: one enabled, non-starter-pack row of `extension.list` (the gateway's field name). */
export interface InstalledRow {
  id: string;
  version: string;
  source_registry: string | null;
}

/** One entry of the gateway's `extension.eval` result. Declared here: the CLI reaches it over IPC only. */
export type ExtensionEvalEntry =
  | { id: string; version: string; ok: true; report: EvalReport }
  | { id: string; version: string | null; ok: false; error: { code: string; message: string } };

/** One run evaluates at most this many extensions: one run is one approval, never batched. */
export const MAX_INSTALLED_EVAL = 50;
export const DEFAULT_EVAL_THRESHOLD = 5;
const CELL_MAX = 120;
const NOT_APPROVED = "ERR_EXTENSION_EVAL_NOT_APPROVED";
const NO_SUITES = "ERR_EVAL_NO_SUITES";
const MISSING = "—";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The `{ ok:false, error }` document every `nimbus eval` mode prints for a whole-run failure. */
export function evalFailureDocument(code: string, message: string): string {
  return JSON.stringify({ ok: false, error: { code, message } });
}

// ---------------------------------------------------------------- candidates

/** A non-empty, non-whitespace registry name, or null (a local install). */
function sourceRegistryOf(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return undefined;
  return v.trim() === "" ? null : v;
}

/** One `extension.list` row: a candidate, `"skip"` (disabled / starter pack), or null (malformed). */
function rowOf(r: unknown): InstalledRow | "skip" | null {
  if (!isObject(r)) return null;
  const { id, version, enabled, kind } = r;
  if (typeof id !== "string" || id.trim() === "" || typeof version !== "string") return null;
  if (typeof enabled !== "number" || (kind !== undefined && typeof kind !== "string")) return null;
  const source = sourceRegistryOf(r["source_registry"]);
  if (source === undefined) return null;
  if (enabled !== 1 || kind === "starter-pack") return "skip";
  return { id, version, source_registry: source };
}

/**
 * The candidates in `extension.list`'s answer: enabled rows that are not starter packs (an older
 * gateway omits `kind`: an extension). A malformed row is skipped with a stderr note; null when
 * the answer itself is malformed (never read as "nothing installed").
 */
export function candidatesOf(raw: unknown, err: (s: string) => void): InstalledRow[] | null {
  if (!isObject(raw) || !Array.isArray(raw["extensions"])) return null;
  const out: InstalledRow[] = [];
  raw["extensions"].forEach((r: unknown, i: number) => {
    const c = rowOf(r);
    if (c === null) err(`skipping a malformed extension.list row (position ${i + 1})`);
    else if (c !== "skip") out.push(c);
  });
  return out;
}

// ---------------------------------------------------------------- evaluate

function parseEntry(e: unknown, id: string): ExtensionEvalEntry | null {
  if (!isObject(e) || e["id"] !== id) return null;
  if (e["ok"] === true) {
    const report = parseEvalReport(e["report"]);
    if (typeof e["version"] !== "string" || report === null) return null;
    return { id, version: e["version"], ok: true, report };
  }
  if (e["ok"] !== false) return null;
  const err = e["error"];
  if (!isObject(err) || typeof err["code"] !== "string" || typeof err["message"] !== "string") {
    return null;
  }
  const version = typeof e["version"] === "string" ? e["version"] : null;
  return { id, version, ok: false, error: { code: err["code"], message: err["message"] } };
}

/**
 * Validate `extension.eval`'s answer: exactly one entry per requested id, in request order, each
 * naming the id requested. Null when it is not that.
 */
export function parseEvalResults(
  raw: unknown,
  ids: readonly string[],
): ExtensionEvalEntry[] | null {
  if (!isObject(raw) || !Array.isArray(raw["results"])) return null;
  const results: unknown[] = raw["results"];
  if (results.length !== ids.length) return null;
  const out: ExtensionEvalEntry[] = [];
  for (const [i, id] of ids.entries()) {
    const entry = parseEntry(results[i], id);
    if (entry === null) return null;
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------- compare

/**
 * The registry's signed score for exactly `version` in a `registry.info` answer, or why there is
 * none. Never another version's score; a shape the CLI cannot read is an invalid score.
 */
export function registryScoreOf(
  raw: unknown,
  version: string,
): { score: number } | { note: string } {
  if (!isObject(raw) || !Array.isArray(raw["versions"])) return { note: "invalid score" };
  const versions: unknown[] = raw["versions"];
  const v = versions.find((x) => isObject(x) && x["version"] === version);
  if (!isObject(v)) return { note: "version not in the registry" };
  if (v["qualityInvalid"] !== undefined) return { note: "invalid score" };
  if (v["quality"] === null || v["quality"] === undefined) return { note: "not evaluated" };
  const score = scoreOf(v["quality"]);
  return score === undefined ? { note: "invalid score" } : { score };
}

type RowStatus = "ok" | "regression" | "no-suites" | "error" | "no-registry-score";

interface ResultRow {
  id: string;
  version: string | null;
  local: number | null;
  registry: { name: string; score: number } | null;
  registryNote?: string;
  delta: number | null;
  status: RowStatus;
  error?: { code: string; message: string };
}

async function registryLookup(
  id: string,
  version: string,
  registry: string,
  call: InstalledRunDeps["call"],
): Promise<{ score: number } | { note: string }> {
  let raw: unknown;
  try {
    raw = await call<unknown>("registry.info", { id, registry });
  } catch (e) {
    return { note: `registry unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  // The registry reported is the one asked: an answer naming another is not its score.
  if (!isObject(raw) || raw["registry"] !== registry) return { note: "invalid score" };
  return registryScoreOf(raw, version);
}

/** A row for an entry that has no local score: no eval suites, or an eval error. */
function rowWithoutScore(
  entry: Extract<ExtensionEvalEntry, { ok: false }>,
  source: string | null,
): ResultRow {
  const base = { id: entry.id, version: entry.version, local: null, registry: null, delta: null };
  const note = source === null ? { registryNote: "local install" } : {};
  if (entry.error.code === NO_SUITES) return { ...base, ...note, status: "no-suites" };
  return { ...base, ...note, status: "error", error: entry.error };
}

function noRegistryScore(note: string) {
  return { registry: null, registryNote: note, delta: null, status: "no-registry-score" as const };
}

async function compareOne(
  entry: ExtensionEvalEntry,
  source: string | null,
  threshold: number,
  call: InstalledRunDeps["call"],
): Promise<ResultRow> {
  if (!entry.ok) return rowWithoutScore(entry, source);
  const local = entry.report.score;
  const base = { id: entry.id, version: entry.version, local };
  if (source === null) return { ...base, ...noRegistryScore("local install") };
  const found = await registryLookup(entry.id, entry.version, source, call);
  if ("note" in found) return { ...base, ...noRegistryScore(found.note) };
  const status: RowStatus = found.score - local > threshold ? "regression" : "ok";
  return {
    ...base,
    registry: { name: source, score: found.score },
    delta: local - found.score,
    status,
  };
}

/** Registry reads happen only now, after the eval, one at a time. */
async function compareAll(
  entries: readonly ExtensionEvalEntry[],
  candidates: readonly InstalledRow[],
  threshold: number,
  call: InstalledRunDeps["call"],
): Promise<ResultRow[]> {
  const rows: ResultRow[] = [];
  for (const [i, entry] of entries.entries()) {
    const source = candidates[i]?.source_registry ?? null;
    rows.push(await compareOne(entry, source, threshold, call));
  }
  return rows;
}

// ---------------------------------------------------------------- render

/** Gateway, extension or registry text for one line: control characters dropped, whitespace runs collapsed. */
function oneLine(s: string): string {
  return stripControlChars(s.replaceAll(/\s+/g, " ")).replaceAll(/\s+/g, " ").trim();
}

function cell(s: string): string {
  const t = oneLine(s);
  return t.length > CELL_MAX ? `${t.slice(0, CELL_MAX - 1)}…` : t;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function statusText(r: ResultRow): string {
  switch (r.status) {
    case "ok":
      return "ok";
    case "regression":
      return "REGRESSION";
    case "no-suites":
      return "no eval suites";
    case "error":
      return `error ${r.error?.code ?? ""}`;
    case "no-registry-score":
      return `no registry score: ${r.registryNote ?? ""}`;
  }
}

function cellsOf(r: ResultRow): string[] {
  return [
    cell(r.id),
    r.version === null ? MISSING : cell(r.version),
    r.local === null ? MISSING : String(r.local),
    r.registry === null ? MISSING : cell(`${r.registry.score} (${r.registry.name})`),
    r.delta === null ? MISSING : signed(r.delta),
    cell(statusText(r)),
  ];
}

function tableLines(rows: readonly string[][]): string[] {
  const header = ["id", "version", "local", "registry", "delta", "status"];
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  return all.map((r) =>
    r
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd(),
  );
}

function renderText(rows: readonly ResultRow[], threshold: number, deps: InstalledRunDeps): void {
  for (const line of tableLines(rows.map(cellsOf))) deps.log(line);
  const regressions = rows.filter((r) => r.status === "regression").length;
  deps.log(`threshold ${threshold}: ${regressions} regression(s)`);
  for (const r of rows) {
    if (r.error !== undefined) {
      deps.err(`${oneLine(r.id)}: ${oneLine(r.error.code)}: ${oneLine(r.error.message)}`);
    }
  }
}

function exitCodeOf(rows: readonly ResultRow[]): number {
  if (rows.some((r) => r.status === "error")) return 2;
  return rows.some((r) => r.status === "regression") ? 1 : 0;
}

// ---------------------------------------------------------------- the run

type Failure = { code: string; message: string };

function fail(opts: { json: boolean }, deps: InstalledRunDeps, f: Failure): number {
  if (opts.json) deps.log(evalFailureDocument(f.code, f.message));
  else {
    // A gateway message usually already names its code (`ERR_…: detail`): name it once.
    const prose = f.message.includes(f.code) ? f.message : `${f.code}: ${f.message}`;
    deps.err(`eval failed: ${oneLine(prose)}`);
  }
  return 2;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Phase 1: the candidates, or a whole-run failure. Decided before any `extension.eval`. */
async function loadCandidates(deps: InstalledRunDeps): Promise<InstalledRow[] | Failure> {
  let raw: unknown;
  try {
    raw = await deps.call<unknown>("extension.list", {});
  } catch (e) {
    return { code: "ERR_EVAL_IPC", message: messageOf(e) };
  }
  const candidates = candidatesOf(raw, deps.err);
  if (candidates === null) {
    return { code: "ERR_EVAL_BAD_RESPONSE", message: "the gateway's extension list was not valid" };
  }
  if (candidates.length > MAX_INSTALLED_EVAL) {
    return {
      code: "ERR_EVAL_TOO_MANY_EXTENSIONS",
      message: `${candidates.length} extensions are enabled; one run evaluates at most ${MAX_INSTALLED_EVAL} (one approval, never batched): use nimbus eval --extension <id>`,
    };
  }
  return candidates;
}

/** Phase 2: ONE `extension.eval` for every candidate, behind one owner approval. */
async function evaluate(
  ids: readonly string[],
  deps: InstalledRunDeps,
): Promise<ExtensionEvalEntry[] | Failure> {
  let raw: unknown;
  try {
    raw = await deps.call<unknown>("extension.eval", { ids: [...ids] });
  } catch (e) {
    const message = messageOf(e);
    const code = message.includes(NOT_APPROVED) ? NOT_APPROVED : "ERR_EVAL_IPC";
    return { code, message };
  }
  const entries = parseEvalResults(raw, ids);
  if (entries === null) {
    return {
      code: "ERR_EVAL_BAD_RESPONSE",
      message: "the gateway's answer was not a valid result",
    };
  }
  return entries;
}

function isFailure(v: unknown): v is Failure {
  return isObject(v) && typeof v["code"] === "string" && typeof v["message"] === "string";
}

/** Exit 2 on a whole-run failure or an eval error; else 1 on any regression; else 0. */
export async function runEvalInstalled(
  opts: { threshold: number; json: boolean },
  deps: InstalledRunDeps,
): Promise<number> {
  const candidates = await loadCandidates(deps);
  if (isFailure(candidates)) return fail(opts, deps, candidates);
  if (candidates.length === 0) {
    if (opts.json) deps.log(JSON.stringify({ threshold: opts.threshold, results: [] }));
    else deps.log("no installed extension to evaluate");
    return 0;
  }
  const entries = await evaluate(
    candidates.map((c) => c.id),
    deps,
  );
  if (isFailure(entries)) return fail(opts, deps, entries);
  const rows = await compareAll(entries, candidates, opts.threshold, deps.call);
  if (opts.json) deps.log(JSON.stringify({ threshold: opts.threshold, results: rows }));
  else renderText(rows, opts.threshold, deps);
  return exitCodeOf(rows);
}
