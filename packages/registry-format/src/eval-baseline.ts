/**
 * The Nimbus-owned baseline check on an index version entry: did the package's server start, list
 * its tools, and describe each one well enough to call. It is a displayed fact, never a score, and
 * never part of `quality`. The index signature covers the parsed document, so `parseRegistryIndex`
 * carries `baseline` RAW; a reader validates it here and a malformed value degrades to `invalid`
 * rather than throwing. `failure` is a code from a fixed set, never text from the child.
 * Pure: no Bun, no gateway imports, no ES2024+ runtime API (it runs under the runner's Node).
 */
import { RegistryError } from "./errors.ts";
import type { RegistryVersionEntry } from "./index-format.ts";

export const EVAL_BASELINE_SCORER_VERSION = 1;

export const EVAL_BASELINE_FAILURES = ["no-listing", "listing-timeout", "invalid-tool"] as const;
export type EvalBaselineFailure = (typeof EVAL_BASELINE_FAILURES)[number];

/** The most tools a baseline counts; a larger listing is counted as this many. */
export const MAX_EVAL_BASELINE_TOOLS = 1_000_000;

/** The longest tool name a definition may carry. */
const MAX_TOOL_NAME_CHARS = 128;

export type EvalBaseline =
  | { readonly scorer: 1; readonly passed: true; readonly tools: number }
  | {
      readonly scorer: 1;
      readonly passed: false;
      readonly tools: number;
      readonly failure: EvalBaselineFailure;
    };

export type VersionBaseline =
  | { readonly state: "checked"; readonly baseline: EvalBaseline }
  | { readonly state: "unchecked" }
  | { readonly state: "invalid"; readonly reason: string };

function bad(why: string): RegistryError {
  return new RegistryError("ERR_REGISTRY_EVAL_QUALITY_INVALID", why);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFailure(v: unknown): v is EvalBaselineFailure {
  return (EVAL_BASELINE_FAILURES as readonly unknown[]).includes(v);
}

/** A baseline rebuilt from exactly its keys; throws `ERR_REGISTRY_EVAL_QUALITY_INVALID` otherwise. */
export function parseEvalBaseline(raw: unknown): EvalBaseline {
  if (!isObject(raw)) throw bad("baseline must be an object");
  const passed = raw["passed"];
  if (typeof passed !== "boolean") throw bad("baseline.passed must be a boolean");
  const want = passed ? ["passed", "scorer", "tools"] : ["failure", "passed", "scorer", "tools"];
  const have = Object.keys(raw).sort();
  if (have.join(",") !== want.join(",")) {
    throw bad(`baseline must have exactly the keys ${want.join(", ")}`);
  }
  if (raw["scorer"] !== EVAL_BASELINE_SCORER_VERSION) {
    throw bad("baseline.scorer is not a known scorer");
  }
  const tools = raw["tools"];
  if (
    typeof tools !== "number" ||
    !Number.isInteger(tools) ||
    tools < 0 ||
    tools > MAX_EVAL_BASELINE_TOOLS
  ) {
    throw bad(`baseline.tools must be an integer from 0 to ${String(MAX_EVAL_BASELINE_TOOLS)}`);
  }
  if (passed) return { scorer: 1, passed: true, tools };
  const failure = raw["failure"];
  if (!isFailure(failure)) throw bad("baseline.failure is not a known failure code");
  return { scorer: 1, passed: false, tools, failure };
}

/** Read a version entry's baseline. Never throws: a malformed value is `invalid`, not an error. */
export function readVersionBaseline(entry: RegistryVersionEntry): VersionBaseline {
  const raw = entry.baseline;
  if (raw === undefined) return { state: "unchecked" };
  try {
    return { state: "checked", baseline: parseEvalBaseline(raw) };
  } catch (e) {
    const reason = e instanceof RegistryError ? e.detail : "baseline is malformed";
    return { state: "invalid", reason };
  }
}

/** A name of 1 to 128 characters with no whitespace and no control character. */
function isValidToolName(name: unknown): boolean {
  if (typeof name !== "string" || name.length < 1 || name.length > MAX_TOOL_NAME_CHARS) {
    return false;
  }
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || ch.trim() === "") {
      return false;
    }
  }
  return true;
}

function isValidInputSchema(schema: unknown): boolean {
  if (!isObject(schema) || schema["type"] !== "object") return false;
  const props = schema["properties"];
  if (props !== undefined) {
    if (!isObject(props)) return false;
    for (const p of Object.values(props)) {
      if (typeof p !== "boolean" && !isObject(p)) return false;
    }
  }
  const required = schema["required"];
  if (required !== undefined) {
    if (!Array.isArray(required) || !required.every((r) => typeof r === "string")) return false;
  }
  return true;
}

function isValidToolDefinition(def: unknown): boolean {
  return isObject(def) && isValidToolName(def["name"]) && isValidInputSchema(def["inputSchema"]);
}

/** A list, or a record whose prototype nothing has replaced. */
function hasPlainShape(definitions: object): boolean {
  if (Array.isArray(definitions)) return true;
  const proto: unknown = Object.getPrototypeOf(definitions);
  return proto === Object.prototype || proto === null;
}

/**
 * Judge a tool listing's raw definitions (a record or a list of them, each with its server-supplied
 * `name` and `inputSchema`). Structural only, no schema compiler: valid means a plain object with
 * `type: "object"`, `properties` absent or an object of objects or booleans, `required` absent or
 * an array of strings. `tools` is the count, capped at the maximum; anything that is not an
 * object or a list is `no-listing`.
 *
 * It sees what the listing kept. A client that collects definitions by name turns a tool named
 * `__proto__` into the record's prototype, where no key shows it, so a record with a foreign
 * prototype is `invalid-tool`. A duplicate name overwrites the earlier tool and leaves no trace,
 * so it cannot be detected here: that is a stated limit.
 */
export function judgeToolDefinitions(definitions: unknown): EvalBaseline {
  if (typeof definitions !== "object" || definitions === null) {
    return { scorer: 1, passed: false, tools: 0, failure: "no-listing" };
  }
  const list = Object.values(definitions);
  const plain = hasPlainShape(definitions);
  // The tool that replaced the prototype was listed too, so it counts.
  const tools = Math.min(list.length + (plain ? 0 : 1), MAX_EVAL_BASELINE_TOOLS);
  if (!plain || !list.every(isValidToolDefinition)) {
    return { scorer: 1, passed: false, tools, failure: "invalid-tool" };
  }
  return { scorer: 1, passed: true, tools };
}

export type EvalBaselineDocument =
  | { ok: true; extensionId: string; version: string; baseline: EvalBaseline }
  | { ok: false; error: { code: string; message: string } };

/** Validate the role's baseline document; null when it is not one of the two shapes. */
export function parseEvalBaselineDocument(text: string): EvalBaselineDocument | null {
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
  const { extensionId, version } = raw;
  if (typeof extensionId !== "string" || typeof version !== "string") return null;
  try {
    return { ok: true, extensionId, version, baseline: parseEvalBaseline(raw["baseline"]) };
  } catch {
    return null;
  }
}
