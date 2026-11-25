import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";

import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import type { ConnectorWriteRow } from "../connectors/connector-writes/types.ts";
import { mcpClientToolKey, meshServerForToolKey } from "../connectors/lazy-mesh/tool-map.ts";
import { RUNBOOK_MAX_STEPS, RUNBOOK_NAME_RE } from "../engine/incident-link.ts";
import { isTriggerService } from "../incident/trigger-sources.ts";
import { isReadOnlyToolId } from "../share/read-tool-registry.ts";
import { untypedPlaceholder } from "./runbook-interpolate.ts";
import type {
  Runbook,
  RunbookLoadError,
  RunbookLoadResult,
  RunbookMatch,
  RunbookParam,
  RunbookParams,
  RunbookStep,
} from "./runbook-types.ts";

/**
 * The runbook loader (Phase 10 IC6, incident-engine spec § 5.6, invariant I57 (c)): reads ONLY
 * `<configDir>/runbooks/*.toml`, the owner's own files. Never fetched, never from a pack or an extension.
 *
 * A file is refused, by name and with its reason, when it does not parse, names an unknown key, sets any approval
 * behaviour, names a tool it may not (an action that is not a connector write row, a bound row, a row with a fixed
 * refusal; a read that is a write, is not a read by name, or is not that service's), carries a parameter that is
 * not plain data, or interpolates anything but a typed record field. The other files still load.
 *
 * Parsed with Bun's built-in TOML reader. An unquoted date or time and a multi-line string are refused before it
 * runs (it would mis-read them); a `\u` escape fails it (not valid TOML); it reads `nan` and `inf` as strings.
 *
 * Stated bound: a parameter is not checked against the connector's own input schema here (the gateway holds no
 * static schema for a tool); the connector validates its input at the call, and the owner's prompt shows every
 * value before an action is approved.
 */

export const RUNBOOK_DIR = "runbooks";
export const RUNBOOK_MAX_FILES = 100;
export const RUNBOOK_MAX_FILE_BYTES = 64 * 1024;
export const RUNBOOK_TEXT_MAX = 500;
export const RUNBOOK_TITLE_MAX = 200;
export const RUNBOOK_PARAMS_MAX_BYTES = 4096;
const PARAMS_MAX_DEPTH = 4;
const SERVICE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TOOL_ID_RE = /^[a-z0-9][a-z0-9_]{0,127}$/;

/** Keys that would set approval behaviour; a runbook cannot (spec § 5.6). Named so the refusal says why. */
const APPROVAL_KEYS: ReadonlySet<string> = new Set([
  "approve",
  "approval",
  "auto",
  "auto_approve",
  "yes",
  "standing",
  "confirm",
  "delegate",
  "unattended",
]);

/** A runbook file the loader refused; `message` is the reason shown to the owner. */
export class RunbookRefusal extends Error {}

function refuse(reason: string): never {
  throw new RunbookRefusal(reason);
}

function isTable(x: unknown): x is Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x) as unknown;
  return proto === Object.prototype || proto === null;
}

function onlyKeys(where: string, t: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(t)) {
    if (APPROVAL_KEYS.has(k)) {
      refuse(`${where}: "${k}" would set approval behaviour, which a runbook cannot do`);
    }
    if (!allowed.includes(k)) refuse(`${where}: unknown key "${k}"`);
  }
}

function stringField(where: string, v: unknown, max: number): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) {
    refuse(`${where} must be a non-empty string of at most ${String(max)} characters`);
  }
  if (Array.from(v).some((c) => c < " " || c === "\u007f")) {
    refuse(`${where} may not hold control characters`);
  }
  return v;
}

function stringList(where: string, v: unknown, re: RegExp): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 50) refuse(`${where} must be a list of at most 50 strings`);
  return v.map((x: unknown) => {
    if (typeof x !== "string" || !re.test(x))
      refuse(`${where}: ${JSON.stringify(x)} is not allowed`);
    return x;
  });
}

function parseMatch(v: unknown): RunbookMatch {
  if (v === undefined) return { services: [], sources: [], title: null };
  if (!isTable(v)) refuse("match must be a table");
  onlyKeys("match", v, ["services", "sources", "title"]);
  const services = stringList("match.services", v["services"], SERVICE_ID_RE);
  const sources = stringList("match.sources", v["sources"], SERVICE_ID_RE);
  for (const s of sources) {
    if (!isTriggerService(s)) refuse(`match.sources: ${JSON.stringify(s)} is not a trigger source`);
  }
  // A plain case-insensitive substring, never a regular expression: matching it is linear in the title.
  const title =
    v["title"] === undefined ? null : stringField("match.title", v["title"], RUNBOOK_TITLE_MAX);
  return { services, sources, title };
}

function plainParam(where: string, v: unknown, depth: number): RunbookParam {
  if (typeof v === "string" || typeof v === "boolean") return v;
  // Bun's TOML reader returns `nan` and `inf` as strings today; a non-finite number is refused if one ever arrives.
  if (typeof v === "number")
    return Number.isFinite(v) ? v : refuse(`${where}: a number must be finite`);
  if (depth >= PARAMS_MAX_DEPTH)
    refuse(`${where}: nested more than ${String(PARAMS_MAX_DEPTH)} deep`);
  if (Array.isArray(v))
    return v.map((x: unknown, i) => plainParam(`${where}[${String(i)}]`, x, depth + 1));
  if (isTable(v)) {
    const out: Record<string, RunbookParam> = {};
    for (const [k, x] of Object.entries(v)) {
      if (APPROVAL_KEYS.has(k) && depth === 0) {
        refuse(`${where}: "${k}" would set approval behaviour, which a runbook cannot do`);
      }
      out[k] = plainParam(`${where}.${k}`, x, depth + 1);
    }
    return out;
  }
  // A TOML date or time, or anything else, is not plain data a tool input may take.
  return refuse(`${where}: only strings, numbers, booleans, lists and tables are allowed`);
}

function parseParams(where: string, v: unknown): RunbookParams {
  if (v === undefined) return {};
  if (!isTable(v)) refuse(`${where} must be a table`);
  const params = plainParam(where, v, 0) as RunbookParams;
  if (Buffer.byteLength(JSON.stringify(params), "utf8") > RUNBOOK_PARAMS_MAX_BYTES) {
    refuse(`${where} is longer than ${String(RUNBOOK_PARAMS_MAX_BYTES)} bytes`);
  }
  const untyped = untypedPlaceholder(params);
  if (untyped !== null) refuse(`${where}: ${untyped}`);
  return params;
}

function actionRow(where: string, tool: string, rows: readonly ConnectorWriteRow[]): void {
  const row = rows.find((r) => r.toolId === tool);
  if (row === undefined) refuse(`${where}: ${JSON.stringify(tool)} is not a connector write row`);
  if (row.bound !== undefined) {
    refuse(`${where}: ${tool} is a bound write, whose prepared facts a runbook cannot supply`);
  }
  if (row.refuse !== undefined) refuse(`${where}: ${tool} is refused on every door`);
}

function parseStep(i: number, v: unknown, rows: readonly ConnectorWriteRow[]): RunbookStep {
  const where = `steps[${String(i + 1)}]`;
  if (!isTable(v)) refuse(`${where} must be a table`);
  const kind = v["kind"];
  if (kind === "check") {
    onlyKeys(where, v, ["kind", "text"]);
    return { kind, text: stringField(`${where}.text`, v["text"], RUNBOOK_TEXT_MAX) };
  }
  if (kind === "read") {
    onlyKeys(where, v, ["kind", "service", "tool", "params"]);
    const service = stringField(`${where}.service`, v["service"], 64);
    const tool = stringField(`${where}.tool`, v["tool"], 128);
    if (!SERVICE_ID_RE.test(service)) refuse(`${where}.service is not a connector id`);
    if (!TOOL_ID_RE.test(tool)) refuse(`${where}.tool is not a tool id`);
    const key = mcpClientToolKey(service, tool);
    if (!isReadOnlyToolId(key) || rows.some((r) => r.toolId === tool)) {
      refuse(`${where}: ${tool} is not a read tool`);
    }
    if (meshServerForToolKey(key) !== service) {
      refuse(`${where}: ${service} is not a connector Nimbus runs`);
    }
    return { kind, service, tool, params: parseParams(`${where}.params`, v["params"]) };
  }
  if (kind === "action") {
    onlyKeys(where, v, ["kind", "tool", "params"]);
    const tool = stringField(`${where}.tool`, v["tool"], 128);
    actionRow(where, tool, rows);
    return { kind, tool, params: parseParams(`${where}.params`, v["params"]) };
  }
  return refuse(`${where}.kind must be "check", "read" or "action"`);
}

/**
 * One line with its quoted text emptied (`"..."` and `'...'` become `""`) and its comment removed, in one linear
 * pass. `multiline` is set when a `"""` or `'''` opens outside a string and outside a comment.
 */
export function bareLine(line: string): { readonly text: string; readonly multiline: boolean } {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line.charAt(i);
    if (c === "#") break;
    if (c === '"' || c === "'") {
      if (line.startsWith(c.repeat(3), i)) return { text: out, multiline: true };
      out += '""';
      i = stringEnd(line, i, c);
      continue;
    }
    out += c;
    i += 1;
  }
  return { text: out, multiline: false };
}

/** The index just past the string that opens at `i` with quote `c` (a backslash escapes in a `"` string). */
function stringEnd(line: string, i: number, c: string): number {
  let j = i + 1;
  while (j < line.length && line.charAt(j) !== c) j += c === '"' && line.charAt(j) === "\\" ? 2 : 1;
  return j + 1;
}

/**
 * Unquoted text shaped like a TOML date or time, anywhere outside a string or a comment. Keys too: Bun's reader
 * splits a bare `2026-11-18` key into `2026` and `18`, so a date-shaped key is refused like a value (quote it).
 */
const BARE_DATE = /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}/u;

/**
 * Bun's TOML reader mis-reads an unquoted date or time (`at = 1979-05-27` becomes two numbers) instead of failing,
 * so unquoted date-shaped text is refused before parsing, as is a multi-line string. Quoted text and comments are
 * not scanned.
 */
function unsupportedSyntax(text: string): string | null {
  for (const line of text.split("\n")) {
    const bare = bareLine(line);
    if (bare.multiline) return "multi-line strings are not supported";
    if (BARE_DATE.test(bare.text)) {
      return "an unquoted date or time (a value or a key) is not supported; write it as a quoted string";
    }
  }
  return null;
}

/** Parse and validate one runbook's text. Throws a {@link RunbookRefusal} on any problem. */
export function parseRunbookText(
  file: string,
  text: string,
  rows: readonly ConnectorWriteRow[] = CONNECTOR_WRITE_ROWS,
): Runbook {
  const syntax = unsupportedSyntax(text);
  if (syntax !== null) refuse(syntax);
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch {
    refuse("the file is not valid TOML");
  }
  if (!isTable(raw)) refuse("the file must be a TOML table");
  onlyKeys("runbook", raw, ["name", "description", "match", "steps"]);
  const stem = file.replace(/\.toml$/u, "");
  const name = raw["name"] === undefined ? stem : raw["name"];
  if (typeof name !== "string" || !RUNBOOK_NAME_RE.test(name)) {
    refuse(
      "name must be 1-64 lower-case letters, digits and hyphens, starting with a letter or digit",
    );
  }
  const description =
    raw["description"] === undefined
      ? null
      : stringField("description", raw["description"], RUNBOOK_TEXT_MAX);
  const steps = raw["steps"];
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > RUNBOOK_MAX_STEPS) {
    refuse(`steps must be a list of 1 to ${String(RUNBOOK_MAX_STEPS)} [[steps]] tables`);
  }
  return {
    name,
    description,
    file,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    match: parseMatch(raw["match"]),
    steps: steps.map((s: unknown, i) => parseStep(i, s, rows)),
  };
}

const NOT_A_FILE = "not a regular file (a link or a directory is not read)";

function errCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String(e.code) : undefined;
}

/**
 * Read one runbook through ONE open file handle: the type and size checks and the read are of the same handle, so
 * the file cannot be swapped between them. `O_NOFOLLOW` refuses a link on POSIX; the link check after the read covers
 * a platform without it (the bytes already read are then discarded, never used).
 */
function readRunbookFile(path: string): string {
  let fd: number;
  try {
    // O_NONBLOCK: a named pipe with no writer must not block the gateway (a regular file is unaffected).
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (e) {
    const code = errCode(e);
    if (code === "ELOOP" || code === "EISDIR") refuse(NOT_A_FILE);
    throw e;
  }
  let text: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) refuse(NOT_A_FILE);
    if (st.size > RUNBOOK_MAX_FILE_BYTES) {
      refuse(`larger than ${String(RUNBOOK_MAX_FILE_BYTES)} bytes`);
    }
    // Read at most one byte past the cap through the same handle, so a file that grows after the stat is refused too.
    const buf = Buffer.alloc(RUNBOOK_MAX_FILE_BYTES + 1);
    let got = 0;
    for (;;) {
      const n = readSync(fd, buf, got, buf.length - got, null);
      if (n === 0) break;
      got += n;
      if (got > RUNBOOK_MAX_FILE_BYTES)
        refuse(`larger than ${String(RUNBOOK_MAX_FILE_BYTES)} bytes`);
    }
    text = buf.subarray(0, got).toString("utf8");
  } finally {
    closeSync(fd);
  }
  if (lstatSync(path).isSymbolicLink()) refuse(NOT_A_FILE);
  return text;
}

/** Code-unit order, so the order of the files never depends on a locale. */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Every runbook under `<configDir>/runbooks/`, read fresh per call. Only regular `*.toml` files are read (a link,
 * a directory and anything else are skipped and reported); a later file whose name repeats an earlier one is
 * refused. An absent directory is no runbooks and no errors; one that cannot be read is reported.
 */
export function loadRunbooks(
  configDir: string,
  rows: readonly ConnectorWriteRow[] = CONNECTOR_WRITE_ROWS,
): RunbookLoadResult {
  const dir = join(configDir, RUNBOOK_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".toml"));
  } catch (e) {
    if (errCode(e) === "ENOENT") return { runbooks: [], errors: [] };
    return {
      runbooks: [],
      errors: [{ file: RUNBOOK_DIR, reason: "the runbooks folder could not be read" }],
    };
  }
  names.sort(byCodeUnit);
  const runbooks: Runbook[] = [];
  const errors: RunbookLoadError[] = [];
  if (names.length > RUNBOOK_MAX_FILES) {
    errors.push({
      file: RUNBOOK_DIR,
      reason: `more than ${String(RUNBOOK_MAX_FILES)} runbooks; only the first ${String(RUNBOOK_MAX_FILES)} were read`,
    });
    names = names.slice(0, RUNBOOK_MAX_FILES);
  }
  const seen = new Set<string>();
  for (const file of names) {
    const path = join(dir, file);
    try {
      const rb = parseRunbookText(file, readRunbookFile(path), rows);
      if (seen.has(rb.name)) refuse(`another runbook is already named ${rb.name}`);
      seen.add(rb.name);
      runbooks.push(rb);
    } catch (e) {
      errors.push({
        file,
        reason: e instanceof RunbookRefusal ? e.message : "the file could not be read",
      });
    }
  }
  return { runbooks, errors };
}
