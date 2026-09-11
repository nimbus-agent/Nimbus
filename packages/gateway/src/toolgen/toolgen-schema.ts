import { z } from "zod";
import type { ToolInputProperty, ToolInputScalar, ToolInputSchema } from "./toolgen-types.ts";
import { ToolgenError } from "./toolgen-types.ts";

/**
 * Keywords rejected EXPLICITLY rather than by not being read.
 *
 * Validating by absence would silently accept a schema carrying `oneOf`, drop it, and present the
 * owner a prompt that does not describe what the model meant. The owner approving the parameters
 * (spec § 5.2) is only meaningful if what they read is the whole schema.
 */
const RESERVED_KEYWORDS = [
  "$ref",
  "$schema",
  "oneOf",
  "anyOf",
  "allOf",
  "additionalProperties",
] as const;

const SCALARS = new Set<string>(["string", "number", "boolean"]);

function fail(message: string): never {
  throw new ToolgenError("ERR_TOOLGEN_SCHEMA_INVALID", message);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * The tool's OWN argument names, which the model chooses freely — they need not mirror the API's
 * wire names, since the body maps arguments onto query parameters itself.
 *
 * Enforced because `args.repo-name` is VALID JavaScript: it parses as `args.repo - name`, so rung 3
 * compiles it happily and the tool fails only at runtime, after approval. Verified — the
 * AsyncFunction constructor accepts it. A hyphenated API parameter is still perfectly reachable;
 * the model just declares `repoName` and writes `"repo-name"` in the URL it builds.
 */
const VALID_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

function validateProperty(name: string, raw: unknown): ToolInputProperty {
  if (!VALID_IDENTIFIER.test(name)) {
    fail(`property name "${name}" is not a valid JavaScript identifier`);
  }
  const p = asRecord(raw);
  if (p === null) fail(`property "${name}" must be an object`);
  const description = typeof p["description"] === "string" ? p["description"] : undefined;
  const type = p["type"];
  if (typeof type !== "string") fail(`property "${name}" has no type`);

  if (SCALARS.has(type)) {
    return {
      type: type as ToolInputScalar,
      ...(description === undefined ? {} : { description }),
    };
  }
  if (type === "array") {
    const items = asRecord(p["items"]);
    if (items === null) fail(`array property "${name}" must declare items`);
    const itemType = items["type"];
    if (typeof itemType !== "string" || !SCALARS.has(itemType)) {
      fail(`array property "${name}" items must be string, number or boolean`);
    }
    return {
      type: "array",
      items: { type: itemType as ToolInputScalar },
      ...(description === undefined ? {} : { description }),
    };
  }
  // Nested objects land here deliberately: a nested argument crossing the newline-delimited JSON
  // protocol into the sandboxed child is a drafting smell, and refusing it removes a class of
  // disagreement between what the model meant and what arrives (spec § 5.1).
  return fail(`property "${name}" has unsupported type "${type}" (nested objects are not allowed)`);
}

/** Rung 2 of the draft ladder. Returns a NORMALISED copy — never the caller's object. */
export function validateInputSchema(raw: unknown): ToolInputSchema {
  const s = asRecord(raw);
  if (s === null) fail("inputSchema must be a JSON object");
  if (s["type"] !== "object") fail('inputSchema.type must be "object"');

  for (const kw of RESERVED_KEYWORDS) {
    if (kw in s) fail(`keyword "${kw}" is not permitted in a generated tool schema`);
  }

  const props = asRecord(s["properties"]);
  if (props === null) fail("inputSchema.properties must be an object");

  // `Object.create(null)`, never a `{}` literal. `properties[name] = …` with `name === "__proto__"`
  // does NOT create a property on a plain object — it invokes `Object.prototype`'s `__proto__`
  // SETTER, which reparents the map instead. `__proto__` is a valid JavaScript identifier, so
  // `VALID_IDENTIFIER` lets it through, and `JSON.parse` hands it over as an ordinary own key, so a
  // model (or anything feeding this) can reach it. The damage is not "pollution of a global" — it
  // is that the property VANISHES from `Object.entries` while the `required` check below, using
  // `in`, traverses the newly injected prototype and finds it anyway: `required` would validate
  // against a property the returned schema does not declare, and the owner would approve a
  // parameter list missing an argument the model intends to read.
  //
  // `Object.hasOwn` for the `required` check for the same reason — `in` walks the prototype chain,
  // so it answers `true` for `"toString"` on a plain object even with no such property declared.
  const properties: Record<string, ToolInputProperty> = Object.create(null) as Record<
    string,
    ToolInputProperty
  >;
  for (const [name, def] of Object.entries(props)) {
    properties[name] = validateProperty(name, def);
  }
  // Spread back onto an ordinary object for the RETURN value: spreading copies own enumerable keys
  // with `CreateDataProperty`, which does not invoke the `__proto__` setter either, so a
  // `__proto__` property survives as a plain own data property — while everything downstream
  // (`Object.entries`, `JSON.stringify`, deep-equality in tests) sees a normal object rather than a
  // prototype-less one.
  const safeProperties = { ...properties };

  const rawRequired = s["required"];
  if (rawRequired === undefined) return { type: "object", properties: safeProperties };
  if (!Array.isArray(rawRequired) || !rawRequired.every((k) => typeof k === "string")) {
    fail("inputSchema.required must be an array of strings");
  }
  for (const key of rawRequired as string[]) {
    if (!Object.hasOwn(properties, key)) {
      fail(`inputSchema.required names undeclared property "${key}"`);
    }
  }
  // DEDUPLICATED, because this returns the CANONICAL form: the schema goes inside the artifact
  // that `artifactDigest` hashes and PR 3 signs, so two schemas that mean the same thing must not
  // produce two digests. `zodSchemaFromInputSchema` already dedupes via a Set, so this changes no
  // behaviour — only the canonical bytes.
  const required = [...new Set(rawRequired as string[])];
  // OMITTED when empty after dedup, for the same reason: `{ required: [] }` and an absent
  // `required` are the same schema, but differ in canonical bytes unless collapsed to one shape
  // here. Left as two spellings, a re-validation of an already-approved artifact (Task 9) could
  // produce a digest that no longer matches the one the owner approved.
  return required.length === 0
    ? { type: "object", properties: safeProperties }
    : { type: "object", properties: safeProperties, required };
}

function zodForProperty(prop: ToolInputProperty): z.ZodType {
  switch (prop.type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      switch (prop.items.type) {
        case "string":
          return z.array(z.string());
        case "number":
          return z.array(z.number());
        case "boolean":
          return z.array(z.boolean());
        default: {
          const never: never = prop.items.type;
          throw new Error(`unhandled array item type: ${String(never)}`);
        }
      }
    default: {
      // Exhaustive by construction: widening ToolInputProperty without extending this switch is a
      // COMPILE error, not a property silently dropped from the model-facing schema.
      const never: never = prop;
      throw new Error(`unhandled property: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Build the model-facing zod schema from the schema the OWNER APPROVED.
 *
 * `required` drives optionality and its absence means "all optional". Getting that backwards is
 * invisible in a type test and surfaces only as a model omitting an argument the body then reads
 * as `undefined`.
 */
export function zodSchemaFromInputSchema(
  schema: ToolInputSchema,
): z.ZodObject<Record<string, z.ZodType>> {
  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    let field = zodForProperty(prop);
    if (prop.description !== undefined) field = field.describe(prop.description);
    shape[name] = required.has(name) ? field : field.optional();
  }
  return z.object(shape);
}
