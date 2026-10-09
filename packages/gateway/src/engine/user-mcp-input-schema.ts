/**
 * I11 for a user-MCP tool's INPUT SCHEMA: the JSON Schema a server lists is server-supplied text
 * the model reads, so it is REBUILT from an allowlist of structural keywords rather than passed
 * through. Kept: `type`, `properties`, `required` (only names declared in the same object's
 * `properties`), `items` (single, or a tuple), `prefixItems`, `additionalProperties`,
 * `anyOf`/`oneOf`/`allOf`, `enum`, `const`, the numeric / length / array bounds and `format` (only a known JSON-Schema
 * format name). `pattern` is DROPPED: the validator compiles it into a backtracking `RegExp` run
 * in the gateway process against the model's argument, so a server-supplied `^(a+)+$` could stall
 * the event loop (ReDoS), and no syntactic check proves a regex linear. Dropping it only loosens;
 * the server still validates its own input.
 * `description`/`title` are kept as prose, with every I11 closer escaped (`escapeEnvelopeClosers`)
 * and then capped at {@link USER_MCP_SCHEMA_PROSE_MAX}. EVERYTHING else is dropped — `examples`,
 * `default`, `$comment`, `x-*` and any unrecognised keyword — and so are `$ref`/`$defs`: a node
 * that was only a `$ref` becomes the permissive `{}`, never a resolved copy of server text. The
 * server still validates its own input, so a dropped constraint loosens what the model may send,
 * never what the server accepts.
 *
 * `$schema` is the one root-only keyword with a structural job: it picks the validator's dialect.
 * `@mastra/mcp` stamps every listed schema 2020-12 when the server declares none, and validating a
 * 2020-12 schema as draft-07 (Ajv's default) ignores `prefixItems` and applies `items` to every
 * element. So a supported dialect URI (2020-12 or draft-07, with or without the trailing `#`) is
 * kept and anything else becomes 2020-12, MCP's default; under 2020-12 a draft-07 tuple `items`
 * array becomes `prefixItems`, since Ajv 2020 rejects the array form outright, and
 * `additionalItems: false` becomes `items: false` (kept as `additionalItems: false` under
 * draft-07). Only a boolean `false` is carried; a schema-valued `additionalItems` is dropped, so
 * that tuple's tail is left open.
 *
 * Openness: an object node whose listing leaves `additionalProperties` unset is emitted with an
 * explicit `additionalProperties: true` (the JSON Schema default, and what the listed validator
 * applies), because the read-back (`standardSchemaToJSONSchema`'s default override) would
 * otherwise close it. An explicit `false` or schema value is kept as listed — UNLESS this node
 * dropped a key the listing would have accepted (a `patternProperties` key, or a property whose
 * name exceeds the name cap): those keys would then fall to `additionalProperties` and be refused
 * or re-validated, so the node is opened to `true` instead. The rebuilt schema is therefore never
 * stricter than the listing's own validator. A boolean `nullable` is kept beside `type`.
 *
 * Bounds, stated: `enum`/`const` values and property NAMES reach the model VERBATIM (data the
 * model must echo exactly, so they are not escaped). An over-long value or
 * name is not truncated — a truncated enum value could never match — so the `enum`/`const`
 * constraint, or the property together with its `required` entry, is dropped instead. The real
 * ceiling on raw schema text the model can read is therefore {@link USER_MCP_SCHEMA_MAX_BYTES},
 * not the 1000-character description cap. Past {@link USER_MCP_SCHEMA_MAX_DEPTH} a subtree becomes
 * `{}`; a schema with more than {@link USER_MCP_SCHEMA_MAX_NODES} nodes, or whose rebuilt form
 * exceeds {@link USER_MCP_SCHEMA_MAX_BYTES}, or whose root is not an object, falls back to
 * {@link PERMISSIVE_USER_MCP_INPUT_SCHEMA}. Nothing here throws.
 */
import { escapeEnvelopeClosers } from "./tool-output-envelope.ts";

export const USER_MCP_SCHEMA_PROSE_MAX = 200;
export const USER_MCP_SCHEMA_MAX_DEPTH = 16;
export const USER_MCP_SCHEMA_MAX_NODES = 1000;
export const USER_MCP_SCHEMA_MAX_BYTES = 32_768;
const PROPERTY_NAME_MAX = 128;
const ENUM_MAX_VALUES = 100;
const COMBINATOR_MAX_BRANCHES = 32;

const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const SUPPORTED_DIALECTS: ReadonlySet<string> = new Set([
  JSON_SCHEMA_2020_12,
  `${JSON_SCHEMA_2020_12}#`,
  "http://json-schema.org/draft-07/schema",
  "http://json-schema.org/draft-07/schema#",
]);

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
/** The JSON-Schema (2020-12 / draft-07) format vocabulary; any other `format` text is dropped. */
const KNOWN_FORMATS: ReadonlySet<string> = new Set([
  "date-time",
  "date",
  "time",
  "duration",
  "email",
  "idn-email",
  "hostname",
  "idn-hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uri-reference",
  "iri",
  "iri-reference",
  "uuid",
  "uri-template",
  "json-pointer",
  "relative-json-pointer",
  "regex",
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

type Walk = { nodes: number; is2020: boolean };

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
  // OpenAPI-style `nullable` (which @mastra/mcp's validator honours): Ajv accepts it only beside
  // `type`, and dropping it would refuse a null the server takes.
  if (type !== undefined && typeof raw["nullable"] === "boolean") out["nullable"] = raw["nullable"];
  const format = raw["format"];
  if (typeof format === "string" && KNOWN_FORMATS.has(format)) out["format"] = format;
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

interface SanitisedProperties {
  readonly properties: JsonObject;
  /** True when a declared property was dropped (name over the cap), so its key is now undeclared. */
  readonly droppedName: boolean;
}

function sanitiseProperties(
  raw: unknown,
  depth: number,
  walk: Walk,
): SanitisedProperties | undefined {
  if (!isPlainObject(raw)) return undefined;
  const properties: JsonObject = {};
  let droppedName = false;
  for (const [name, sub] of Object.entries(raw)) {
    if (name.length > PROPERTY_NAME_MAX) {
      droppedName = true;
      continue;
    }
    // defineProperty, not assignment: `properties["__proto__"] = x` would set the prototype and
    // silently drop the property (and, with it, its `required` entry).
    Object.defineProperty(properties, name, {
      value: sanitiseNode(sub, depth + 1, walk),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { properties, droppedName };
}

function sanitiseBranches(raw: unknown, depth: number, walk: Walk): unknown[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > COMBINATOR_MAX_BRANCHES)
    return undefined;
  return raw.map((b) => sanitiseNode(b, depth + 1, walk));
}

function copyArrayKeywords(raw: JsonObject, out: JsonObject, depth: number, walk: Walk): void {
  const prefixItems = sanitiseBranches(raw["prefixItems"], depth, walk);
  if (prefixItems !== undefined) out["prefixItems"] = prefixItems;
  const items = raw["items"];
  if (Array.isArray(items)) {
    const tuple = sanitiseBranches(items, depth, walk);
    if (tuple === undefined) return;
    // Ajv 2020 rejects an array `items`; its 2020-12 spelling is `prefixItems`.
    if (!walk.is2020) {
      out["items"] = tuple;
      if (raw["additionalItems"] === false) out["additionalItems"] = false;
    } else {
      if (prefixItems === undefined) out["prefixItems"] = tuple;
      // 2020-12 spells a closed tuple `items: false`. A schema-valued additionalItems stays
      // dropped (stated bound): the tuple is left open, looser than the server's.
      if (raw["additionalItems"] === false) out["items"] = false;
    }
  } else if (isPlainObject(items) || typeof items === "boolean") {
    out["items"] = sanitiseNode(items, depth + 1, walk);
  }
}

/**
 * An object node whose listing leaves `additionalProperties` unset is OPEN (the JSON Schema default,
 * and what @mastra/mcp's own validator applies). It is written out as an explicit `true` because
 * the read-back (`standardSchemaToJSONSchema`'s default override) otherwise adds
 * `additionalProperties: false` to any object with `properties`, which would refuse a call the
 * server accepts.
 */
function describesObject(out: JsonObject): boolean {
  if (out["properties"] !== undefined) return true;
  const type = out["type"];
  return type === "object" || (Array.isArray(type) && type.includes("object"));
}

function copyStructuralKeywords(raw: JsonObject, out: JsonObject, depth: number, walk: Walk): void {
  const sanitised = sanitiseProperties(raw["properties"], depth, walk);
  const properties = sanitised?.properties;
  if (properties !== undefined) out["properties"] = properties;
  const required = raw["required"];
  if (Array.isArray(required) && properties !== undefined) {
    // Only a DECLARED name survives: an undeclared one is free text with no structural job.
    const names = required.filter(
      (n): n is string => typeof n === "string" && Object.hasOwn(properties, n),
    );
    if (names.length > 0) out["required"] = names;
  }
  copyArrayKeywords(raw, out, depth, walk);
  const additional = raw["additionalProperties"];
  // A key the listing accepted through a dropped `patternProperties` or a dropped over-long
  // property name now falls to `additionalProperties`; open the node rather than refuse it.
  const droppedAcceptedKeys = sanitised?.droppedName === true || "patternProperties" in raw;
  if (droppedAcceptedKeys && additional !== true && additional !== undefined)
    out["additionalProperties"] = true;
  else if (typeof additional === "boolean") out["additionalProperties"] = additional;
  else if (isPlainObject(additional))
    out["additionalProperties"] = sanitiseNode(additional, depth + 1, walk);
  else if (describesObject(out)) out["additionalProperties"] = true;
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

/** A supported dialect URI is kept verbatim; anything else (or none) is MCP's default, 2020-12. */
function rootDialect(raw: JsonObject): string {
  const declared = raw["$schema"];
  return typeof declared === "string" && SUPPORTED_DIALECTS.has(declared)
    ? declared
    : JSON_SCHEMA_2020_12;
}

/**
 * The listed JSON Schema rebuilt from the allowlist above, or
 * {@link PERMISSIVE_USER_MCP_INPUT_SCHEMA} when the root is not an object or a bound is exceeded.
 */
export function sanitiseUserMcpInputSchema(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) return { ...PERMISSIVE_USER_MCP_INPUT_SCHEMA };
  try {
    const dialect = rootDialect(raw);
    const out = sanitiseNode(raw, 1, { nodes: 0, is2020: dialect.startsWith(JSON_SCHEMA_2020_12) });
    if (!isPlainObject(out)) return { ...PERMISSIVE_USER_MCP_INPUT_SCHEMA };
    const rebuilt = { $schema: dialect, ...out };
    if (JSON.stringify(rebuilt).length > USER_MCP_SCHEMA_MAX_BYTES)
      return { ...PERMISSIVE_USER_MCP_INPUT_SCHEMA };
    return rebuilt;
  } catch {
    // SchemaTooLarge, or anything a hostile object could raise mid-walk: never throw.
    return { ...PERMISSIVE_USER_MCP_INPUT_SCHEMA };
  }
}
