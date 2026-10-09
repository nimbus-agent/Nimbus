/**
 * I11 for a user-MCP tool's INPUT SCHEMA: the JSON Schema a server lists is server-supplied text
 * the model reads, so it is REBUILT from an allowlist of structural keywords rather than passed
 * through. Kept: `type`, `properties`, `required`, `items` (single or tuple), `prefixItems`,
 * `additionalProperties`, `anyOf`/`oneOf`/`allOf`, `enum`, `const`, the numeric / length / array
 * bounds, `pattern` (only when it compiles) and `format`. `description`/`title` are kept as prose,
 * with every I11 closer escaped (`escapeEnvelopeClosers`) and then capped at
 * {@link USER_MCP_SCHEMA_PROSE_MAX}. EVERYTHING else is dropped — `examples`, `default`,
 * `$comment`, `$schema`, `x-*` and any unrecognised keyword — and so are `$ref`/`$defs`: a node
 * that was only a `$ref` becomes the permissive `{}`, never a resolved copy of server text. The
 * server still validates its own input, so a dropped constraint loosens what the model may send,
 * never what the server accepts.
 *
 * Bounds, stated: `enum`/`const` values and property NAMES reach the model VERBATIM (they are
 * data the model must echo exactly, so they are not escaped). An over-long value or name is not
 * truncated — a truncated enum value could never match — so the `enum`/`const` constraint, or the
 * property together with its `required` entry, is dropped instead. Past
 * {@link USER_MCP_SCHEMA_MAX_DEPTH} a subtree becomes `{}`; a schema with more than
 * {@link USER_MCP_SCHEMA_MAX_NODES} nodes, or whose rebuilt form exceeds
 * {@link USER_MCP_SCHEMA_MAX_BYTES}, or whose root is not an object, falls back to
 * {@link PERMISSIVE_USER_MCP_INPUT_SCHEMA}. Nothing here throws.
 */
import { escapeEnvelopeClosers } from "./tool-output-envelope.ts";

export const USER_MCP_SCHEMA_PROSE_MAX = 200;
export const USER_MCP_SCHEMA_MAX_DEPTH = 16;
export const USER_MCP_SCHEMA_MAX_NODES = 1000;
export const USER_MCP_SCHEMA_MAX_BYTES = 32_768;
const PROPERTY_NAME_MAX = 128;
const PATTERN_MAX = 500;
const FORMAT_MAX = 64;
const ENUM_MAX_VALUES = 100;
const COMBINATOR_MAX_BRANCHES = 32;

export const PERMISSIVE_USER_MCP_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
});

type JsonObject = Record<string, unknown>;

const JSON_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);
const NUMERIC_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
] as const;
const COUNT_KEYWORDS = ["minLength", "maxLength", "minItems", "maxItems"] as const;
const PROSE_KEYWORDS = ["title", "description"] as const;
const COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;

class SchemaTooLarge extends Error {}

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPrimitive(v: unknown): boolean {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

/** An enum/const value the model may be shown verbatim: a primitive, a string within the cap. */
function isOfferableValue(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return v.length <= USER_MCP_SCHEMA_PROSE_MAX;
  return isPrimitive(v);
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

type Walk = { nodes: number };

function sanitiseType(v: unknown): string | string[] | undefined {
  if (typeof v === "string") return JSON_TYPES.has(v) ? v : undefined;
  if (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((t) => typeof t === "string" && JSON_TYPES.has(t))
  )
    return v as string[];
  return undefined;
}

function copyScalarKeywords(raw: JsonObject, out: JsonObject): void {
  const type = sanitiseType(raw["type"]);
  if (type !== undefined) out["type"] = type;
  for (const k of NUMERIC_KEYWORDS) {
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  for (const k of COUNT_KEYWORDS) {
    const v = raw[k];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) out[k] = v;
  }
  if (typeof raw["uniqueItems"] === "boolean") out["uniqueItems"] = raw["uniqueItems"];
  const pattern = raw["pattern"];
  if (typeof pattern === "string" && pattern.length <= PATTERN_MAX && compiles(pattern))
    out["pattern"] = pattern;
  const format = raw["format"];
  if (typeof format === "string" && format.length <= FORMAT_MAX) out["format"] = format;
  for (const k of PROSE_KEYWORDS) {
    const v = raw[k];
    if (typeof v === "string")
      out[k] = escapeEnvelopeClosers(v).slice(0, USER_MCP_SCHEMA_PROSE_MAX);
  }
  const values = raw["enum"];
  if (
    Array.isArray(values) &&
    values.length > 0 &&
    values.length <= ENUM_MAX_VALUES &&
    values.every(isOfferableValue)
  )
    out["enum"] = [...values];
  if ("const" in raw && isOfferableValue(raw["const"])) out["const"] = raw["const"];
}

function sanitiseProperties(
  raw: unknown,
  depth: number,
  walk: Walk,
): { properties: JsonObject; dropped: Set<string> } | undefined {
  if (!isPlainObject(raw)) return undefined;
  const properties: JsonObject = {};
  const dropped = new Set<string>();
  for (const [name, sub] of Object.entries(raw)) {
    if (name.length > PROPERTY_NAME_MAX) {
      dropped.add(name);
      continue;
    }
    properties[name] = sanitiseNode(sub, depth + 1, walk);
  }
  return { properties, dropped };
}

function sanitiseBranches(raw: unknown, depth: number, walk: Walk): unknown[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > COMBINATOR_MAX_BRANCHES)
    return undefined;
  return raw.map((b) => sanitiseNode(b, depth + 1, walk));
}

function copyStructuralKeywords(raw: JsonObject, out: JsonObject, depth: number, walk: Walk): void {
  const props = sanitiseProperties(raw["properties"], depth, walk);
  if (props !== undefined) out["properties"] = props.properties;
  const required = raw["required"];
  if (Array.isArray(required)) {
    const names = required.filter(
      (n): n is string =>
        typeof n === "string" && n.length <= PROPERTY_NAME_MAX && !props?.dropped.has(n),
    );
    if (names.length > 0) out["required"] = names;
  }
  const items = raw["items"];
  if (Array.isArray(items)) {
    const tuple = sanitiseBranches(items, depth, walk);
    if (tuple !== undefined) out["items"] = tuple;
  } else if (isPlainObject(items) || typeof items === "boolean") {
    out["items"] = sanitiseNode(items, depth + 1, walk);
  }
  const prefixItems = sanitiseBranches(raw["prefixItems"], depth, walk);
  if (prefixItems !== undefined) out["prefixItems"] = prefixItems;
  const additional = raw["additionalProperties"];
  if (typeof additional === "boolean") out["additionalProperties"] = additional;
  else if (isPlainObject(additional))
    out["additionalProperties"] = sanitiseNode(additional, depth + 1, walk);
  for (const k of COMBINATORS) {
    const branches = sanitiseBranches(raw[k], depth, walk);
    if (branches !== undefined) out[k] = branches;
  }
}

function sanitiseNode(raw: unknown, depth: number, walk: Walk): unknown {
  // A boolean subschema carries no text; keep it as the structure it is.
  if (typeof raw === "boolean") return raw;
  if (!isPlainObject(raw) || depth > USER_MCP_SCHEMA_MAX_DEPTH) return {};
  walk.nodes += 1;
  if (walk.nodes > USER_MCP_SCHEMA_MAX_NODES) throw new SchemaTooLarge();
  const out: JsonObject = {};
  copyScalarKeywords(raw, out);
  copyStructuralKeywords(raw, out, depth, walk);
  return out;
}

/**
 * The listed JSON Schema rebuilt from the allowlist above, or
 * {@link PERMISSIVE_USER_MCP_INPUT_SCHEMA} when the root is not an object or a bound is exceeded.
 */
export function sanitiseUserMcpInputSchema(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) return { ...PERMISSIVE_USER_MCP_INPUT_SCHEMA };
  try {
    const out = sanitiseNode(raw, 1, { nodes: 0 });
    if (!isPlainObject(out)) return { ...PERMISSIVE_USER_MCP_INPUT_SCHEMA };
    if (JSON.stringify(out).length > USER_MCP_SCHEMA_MAX_BYTES)
      return { ...PERMISSIVE_USER_MCP_INPUT_SCHEMA };
    return out;
  } catch {
    // SchemaTooLarge, or anything a hostile object could raise mid-walk: never throw.
    return { ...PERMISSIVE_USER_MCP_INPUT_SCHEMA };
  }
}
