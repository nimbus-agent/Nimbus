// packages/gateway/src/automation/workflow-steps.ts
// The steps of a saved workflow (Phase 10 SA2, spec § 4 item 2, § 5.4): the `run` prompts of old,
// plus two deterministic kinds that involve no model at all.
//
//   { "kind": "query", "label": "old-read-mail", "query": { ...closed form... } }
//   { "kind": "write", "tool": "gmail_thread_archive",
//     "input": { "threadId": { "from": "old-read-mail", "column": "metadata.threadId" } } }
//
// One parser serves `workflow.save` AND the run (the stored JSON is re-validated at every run, so
// the runner never trusts the store). A `run` row keeps its legacy leniency (a row with no `run`
// string is dropped, unknown keys are ignored) so a workflow saved before SA2 parses exactly as it
// did. A `query` or `write` row is STRICT: an unknown key is refused (a typo must not silently drop a
// constraint), a write may name only a wave 2 or 3 connector write row the model is not barred from
// by owner ruling, and a value may come only from a constant or from an EARLIER query step: a write
// can never read a `run` step's output, and a query's predicates are constants.
import { createHash } from "node:crypto";
import { connectorWriteRowByToolId } from "../connectors/connector-write-registry.ts";
import { MODEL_NEVER_OFFERED_TOOL_IDS } from "../connectors/connector-writes/model-offerable.ts";
import { canonicalJson } from "../util/canonical-json.ts";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** One value of a write step's input: a constant, or one id a query step selected. */
export type WriteValue =
  | { readonly const: JsonValue }
  | { readonly from: string; readonly column: string };

export type DeclaredPredicate =
  | { readonly metadata: string; readonly contains: string }
  | { readonly metadata: string; readonly notContains: string }
  | { readonly metadata: string; readonly equals: string | number | boolean }
  | { readonly olderThanDays: number }
  | { readonly newerThanDays: number };

/** Spec § 5.4's closed query form: not SQL and not a prompt. */
export type DeclaredQuery = {
  readonly service: string;
  readonly type: string;
  readonly where: readonly DeclaredPredicate[];
  /** `id`, `external_id` or `metadata.<key>`. */
  readonly select: string;
  readonly distinct: boolean;
  readonly limit: number;
};

export type RunWorkflowStep = {
  kind: "run";
  label?: string;
  run: string;
  continueOnError?: boolean;
};

export type QueryWorkflowStep = { kind: "query"; label: string; query: DeclaredQuery };

export type WriteWorkflowStep = {
  kind: "write";
  label?: string;
  tool: string;
  input: Readonly<Record<string, WriteValue>>;
  continueOnError?: boolean;
};

export type WorkflowStep = RunWorkflowStep | QueryWorkflowStep | WriteWorkflowStep;

/** A strict-kind row (query / write) that broke a rule, or a malformed array. */
export class WorkflowStepsError extends Error {}

/** A query limit is required and at most this many. */
export const QUERY_LIMIT_MAX = 500;
const MAX_PREDICATES = 8;
const MAX_INPUT_FIELDS = 32;
const MAX_CONST_BYTES = 8192;
const MAX_JSON_DEPTH = 6;
const MAX_DAYS = 36_500;

/** A metadata key in a declared query: a bound JSON path component, never SQL. */
export const METADATA_KEY_PATTERN = /^[A-Za-z]\w{0,63}$/;
const FIELD_KEY_PATTERN = /^[A-Za-z]\w{0,63}$/;
const SERVICE_TYPE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function refuse(message: string): never {
  throw new WorkflowStepsError(message);
}

/** Refuses any key of `rec` that is not in `allowed`. */
function onlyKeys(rec: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(rec)) {
    if (!allowed.includes(k)) refuse(`${where}: unknown key "${k}"`);
  }
}

function parseLabel(
  rec: Record<string, unknown>,
  where: string,
  required: boolean,
): string | undefined {
  const raw = rec["label"];
  if (raw === undefined) {
    if (required) refuse(`${where}: a label is required`);
    return undefined;
  }
  if (typeof raw !== "string" || raw.trim() === "")
    refuse(`${where}: label must be a non-empty string`);
  return raw.trim();
}

function parseRunRow(rec: Record<string, unknown>): RunWorkflowStep | null {
  const run = typeof rec["run"] === "string" ? rec["run"].trim() : "";
  if (run === "") return null;
  const label = typeof rec["label"] === "string" ? rec["label"].trim() : undefined;
  const continueOnError = rec["continueOnError"] === true || rec["continue_on_error"] === true;
  const step: RunWorkflowStep = { kind: "run", run };
  if (label !== undefined && label !== "") step.label = label;
  if (continueOnError) step.continueOnError = true;
  return step;
}

/** An `olderThanDays` / `newerThanDays` predicate: the only key, an integer day count. */
function parseAgePredicate(raw: Record<string, unknown>, where: string): DeclaredPredicate {
  const key = typeof raw["olderThanDays"] === "number" ? "olderThanDays" : "newerThanDays";
  onlyKeys(raw, [key], where);
  const days = raw[key];
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > MAX_DAYS) {
    refuse(`${where}: ${key} must be an integer from 0 to ${String(MAX_DAYS)}`);
  }
  return key === "olderThanDays" ? { olderThanDays: days } : { newerThanDays: days };
}

function parsePredicate(raw: unknown, where: string): DeclaredPredicate {
  if (!isPlainRecord(raw)) refuse(`${where}: a predicate must be an object`);
  const keys = Object.keys(raw);
  if (typeof raw["olderThanDays"] === "number" || typeof raw["newerThanDays"] === "number") {
    return parseAgePredicate(raw, where);
  }
  const opKeys = keys.filter((k) => k === "contains" || k === "notContains" || k === "equals");
  if (opKeys.length !== 1) {
    refuse(`${where}: a metadata predicate needs exactly one of contains, notContains or equals`);
  }
  const op = opKeys[0] as "contains" | "notContains" | "equals";
  onlyKeys(raw, ["metadata", op], where);
  const key = raw["metadata"];
  if (typeof key !== "string" || !METADATA_KEY_PATTERN.test(key)) {
    refuse(`${where}: metadata must be a plain key (letters, digits, underscore)`);
  }
  const value = raw[op];
  if (op === "equals") {
    const scalar = typeof value;
    if (
      scalar !== "string" &&
      scalar !== "boolean" &&
      !(scalar === "number" && Number.isFinite(value))
    ) {
      refuse(`${where}: equals must be a string, number or boolean constant`);
    }
    return { metadata: key, equals: value as string | number | boolean };
  }
  if (typeof value !== "string" || value === "" || value.length > 256) {
    refuse(`${where}: ${op} must be a non-empty string constant`);
  }
  return op === "contains"
    ? { metadata: key, contains: value }
    : { metadata: key, notContains: value };
}

/** `id`, `external_id` or `metadata.<key>`; anything else (free text columns included) is refused. */
export function isSelectableColumn(select: string): boolean {
  if (select === "id" || select === "external_id") return true;
  return (
    select.startsWith("metadata.") && METADATA_KEY_PATTERN.test(select.slice("metadata.".length))
  );
}

export function parseDeclaredQuery(raw: unknown, where: string): DeclaredQuery {
  if (!isPlainRecord(raw)) refuse(`${where}: query must be an object`);
  onlyKeys(raw, ["service", "type", "where", "select", "distinct", "limit"], where);
  const service = raw["service"];
  const type = raw["type"];
  if (typeof service !== "string" || !SERVICE_TYPE_PATTERN.test(service)) {
    refuse(`${where}: service must be a plain service id`);
  }
  if (typeof type !== "string" || !SERVICE_TYPE_PATTERN.test(type)) {
    refuse(`${where}: type must be a plain item type`);
  }
  const preds = raw["where"] === undefined ? [] : raw["where"];
  if (!Array.isArray(preds) || preds.length > MAX_PREDICATES) {
    refuse(`${where}: where must be a list of at most ${String(MAX_PREDICATES)} predicates`);
  }
  const select = raw["select"];
  if (typeof select !== "string" || !isSelectableColumn(select)) {
    refuse(`${where}: select must be id, external_id or metadata.<key>`);
  }
  const distinct = raw["distinct"];
  if (distinct !== undefined && typeof distinct !== "boolean") {
    refuse(`${where}: distinct must be true or false`);
  }
  const limit = raw["limit"];
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > QUERY_LIMIT_MAX
  ) {
    refuse(
      `${where}: limit is required and must be an integer from 1 to ${String(QUERY_LIMIT_MAX)}`,
    );
  }
  return {
    service,
    type,
    where: (preds as unknown[]).map((p, i) => parsePredicate(p, `${where} where[${String(i)}]`)),
    select,
    distinct: distinct === true,
    limit,
  };
}

function parseQueryRow(rec: Record<string, unknown>, index: number): QueryWorkflowStep {
  const where = `step ${String(index + 1)} (query)`;
  onlyKeys(rec, ["kind", "label", "query"], where);
  const label = parseLabel(rec, where, true) as string;
  return { kind: "query", label, query: parseDeclaredQuery(rec["query"], where) };
}

function checkJsonConst(v: unknown, depth: number, where: string): JsonValue {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) refuse(`${where}: a constant number must be finite`);
    return v;
  }
  if (depth >= MAX_JSON_DEPTH) refuse(`${where}: a constant is nested too deeply`);
  if (Array.isArray(v)) return v.map((x) => checkJsonConst(x, depth + 1, where));
  if (isPlainRecord(v)) {
    const out: Record<string, JsonValue> = {};
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.has(k)) refuse(`${where}: a constant may not hold the key "${k}"`);
      out[k] = checkJsonConst(x, depth + 1, where);
    }
    return out;
  }
  return refuse(`${where}: a constant must be JSON`);
}

function parseWriteValue(field: string, raw: unknown, where: string): WriteValue {
  if (!isPlainRecord(raw)) {
    refuse(
      `${where}: input.${field} must be { "const": ... } or { "from": <query label>, "column": ... }`,
    );
  }
  if (Object.hasOwn(raw, "const")) {
    onlyKeys(raw, ["const"], `${where} input.${field}`);
    const value = checkJsonConst(raw["const"], 0, `${where} input.${field}`);
    if (JSON.stringify(value).length > MAX_CONST_BYTES) {
      refuse(`${where}: input.${field} constant is larger than ${String(MAX_CONST_BYTES)} bytes`);
    }
    return { const: value };
  }
  onlyKeys(raw, ["from", "column"], `${where} input.${field}`);
  const from = raw["from"];
  const column = raw["column"];
  if (typeof from !== "string" || from === "" || typeof column !== "string" || column === "") {
    refuse(`${where}: input.${field} needs a from (a query label) and a column`);
  }
  return { from, column };
}

function parseWriteRow(rec: Record<string, unknown>, index: number): WriteWorkflowStep {
  const where = `step ${String(index + 1)} (write)`;
  onlyKeys(rec, ["kind", "label", "tool", "input", "continueOnError", "continue_on_error"], where);
  const tool = rec["tool"];
  if (typeof tool !== "string" || tool === "")
    refuse(`${where}: tool must be a connector write tool id`);
  refuseIneligibleWrite(tool, where);
  const rawInput = rec["input"];
  if (!isPlainRecord(rawInput)) refuse(`${where}: input must be an object`);
  const fields = Object.keys(rawInput);
  if (fields.length > MAX_INPUT_FIELDS) {
    refuse(`${where}: input has more than ${String(MAX_INPUT_FIELDS)} fields`);
  }
  const input: Record<string, WriteValue> = {};
  for (const field of fields) {
    if (!FIELD_KEY_PATTERN.test(field) || FORBIDDEN_KEYS.has(field)) {
      refuse(`${where}: "${field}" is not a plain input field name`);
    }
    input[field] = parseWriteValue(field, rawInput[field], where);
  }
  const label = parseLabel(rec, where, false);
  const step: WriteWorkflowStep = { kind: "write", tool, input };
  if (label !== undefined) step.label = label;
  if (rec["continueOnError"] === true || rec["continue_on_error"] === true)
    step.continueOnError = true;
  return step;
}

/**
 * A workflow write may name only a connector write the gateway classifies as wave 2 or 3 that is
 * not barred from the model by owner ruling (no mail send), is not bound to a prepare step and
 * carries no row-level refusal. A wave 4 write stays owner-typed on its own doors.
 */
function refuseIneligibleWrite(tool: string, where: string): void {
  const row = connectorWriteRowByToolId(tool);
  if (row === undefined) refuse(`${where}: "${tool}" is not a connector write tool`);
  if (row.wave !== 2 && row.wave !== 3) {
    refuse(
      `${where}: "${tool}" is a wave ${String(row.wave)} write; a workflow runs only wave 2 or 3 writes`,
    );
  }
  if (MODEL_NEVER_OFFERED_TOOL_IDS.has(tool)) {
    refuse(`${where}: "${tool}" is never run by an automatic step`);
  }
  if (row.bound !== undefined || row.refuse !== undefined) {
    refuse(`${where}: "${tool}" cannot run as a workflow step`);
  }
}

/** The `from` references of a write step: its distinct query labels and columns. */
function referencesOf(step: WriteWorkflowStep): { label: string; column: string }[] {
  const out: { label: string; column: string }[] = [];
  for (const v of Object.values(step.input)) {
    if ("from" in v) out.push({ label: v.from, column: v.column });
  }
  return out;
}

/** Cross-step rules: references name an EARLIER query, one query per write, labels do not collide. */
function validateReferences(steps: readonly WorkflowStep[]): void {
  const queryAt = new Map<string, number>();
  const labelAt = new Map<string, number>();
  steps.forEach((s, i) => {
    const label = s.label ?? `step-${String(i + 1)}`;
    if (s.kind === "query") {
      if (queryAt.has(label) || labelAt.has(label))
        refuse(`step ${String(i + 1)}: label "${label}" is already used`);
      queryAt.set(label, i);
    } else if (queryAt.has(label)) {
      refuse(`step ${String(i + 1)}: label "${label}" is a query step's label`);
    }
    labelAt.set(label, i);
  });
  steps.forEach((s, i) => {
    if (s.kind !== "write") return;
    const refs = referencesOf(s);
    for (const r of refs) {
      const at = queryAt.get(r.label);
      if (at === undefined || at >= i) {
        const named = labelAt.get(r.label);
        const why =
          named !== undefined && steps[named]?.kind === "run"
            ? "a write step can never read a run step"
            : "it must name an earlier query step";
        refuse(`step ${String(i + 1)} (write): from "${r.label}": ${why}`);
      }
      const q = steps[at];
      if (q?.kind !== "query" || q.query.select !== r.column) {
        refuse(
          `step ${String(i + 1)} (write): column "${r.column}" is not what query "${r.label}" selects`,
        );
      }
    }
    if (new Set(refs.map((r) => r.label)).size > 1) {
      refuse(`step ${String(i + 1)} (write): a write may read from only one query step`);
    }
  });
}

/**
 * Parses a workflow's `steps_json`. Legacy `run` rows keep their old leniency and old error text;
 * a `query` or `write` row is strict. Throws {@link WorkflowStepsError} for a strict violation, a
 * plain `Error` for the legacy failures (not JSON, not an array, nothing executable).
 */
export function parseWorkflowSteps(stepsJson: string): WorkflowStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stepsJson) as unknown;
  } catch {
    throw new Error("workflow steps_json is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError("workflow steps must be a JSON array");
  }
  const out: WorkflowStep[] = [];
  (parsed as unknown[]).forEach((row, index) => {
    if (!isPlainRecord(row)) return;
    const kind = row["kind"];
    if (kind === undefined || kind === "run") {
      const step = parseRunRow(row);
      if (step !== null) out.push(step);
    } else if (kind === "query") {
      out.push(parseQueryRow(row, index));
    } else if (kind === "write") {
      out.push(parseWriteRow(row, index));
    } else {
      refuse(`step ${String(index + 1)}: kind must be run, query or write`);
    }
  });
  if (out.length === 0) {
    throw new Error("workflow has no executable steps (need objects with non-empty run string)");
  }
  validateReferences(out);
  return out;
}

/** The SHA-256 of the canonical JSON of the steps a run loaded (keys sorted, no whitespace). */
export function workflowStepsSha256(steps: readonly WorkflowStep[]): string {
  return createHash("sha256").update(canonicalJson(steps)).digest("hex");
}

/** The labels a run's `paramsOverride` may not name: every write and query step, defaults included. */
export function nonRunStepLabels(steps: readonly WorkflowStep[]): string[] {
  const out: string[] = [];
  steps.forEach((s, i) => {
    if (s.kind !== "run") out.push(s.label ?? `step-${String(i + 1)}`);
  });
  return out;
}

/** True when the workflow has a step that needs the model (a `run` prompt). */
export function needsModel(steps: readonly WorkflowStep[]): boolean {
  return steps.some((s) => s.kind === "run");
}

/**
 * What `workflow.save` refuses: a strict-kind (query / write / unknown kind) violation. Legacy
 * `run`-only JSON, including JSON the runner would later refuse, saves exactly as it did before.
 * Returns the refusal text, or `undefined` to save.
 */
export function stepsSaveRefusal(stepsJson: string): string | undefined {
  try {
    parseWorkflowSteps(stepsJson);
    return undefined;
  } catch (e) {
    return e instanceof WorkflowStepsError ? e.message : undefined;
  }
}
