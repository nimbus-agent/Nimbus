/**
 * Paths of `toolgen-schema.ts` that `toolgen-schema.test.ts` does not reach: the exact refusal for
 * a property that is not an object or has no type, a described array property, the boolean /
 * number[] / boolean[] zod mappings, descriptions reaching the model-facing schema, and the
 * fail-closed throw for a schema that never went through `validateInputSchema`.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { validateInputSchema, zodSchemaFromInputSchema } from "./toolgen-schema.ts";
import { ToolgenError, type ToolInputSchema } from "./toolgen-types.ts";

function refusal(input: unknown): ToolgenError {
  try {
    validateInputSchema(input);
  } catch (e) {
    if (e instanceof ToolgenError) return e;
    throw e;
  }
  throw new Error("expected validateInputSchema to refuse");
}

describe("validateInputSchema — a property's own shape", () => {
  test.each([
    ["null", null],
    ["an array", ["string"]],
    ["a bare string", "string"],
  ])("a property definition that is %s is refused as not an object", (_label, def) => {
    const e = refusal({ type: "object", properties: { owner: def } });
    expect(e.code).toBe("ERR_TOOLGEN_SCHEMA_INVALID");
    expect(e.message).toBe('property "owner" must be an object');
    expect(e.message).not.toContain("has no type");
  });

  test.each([
    ["no type at all", { description: "who owns it" }],
    ["a numeric type", { type: 7 }],
  ])("a property with %s is refused as having no type", (_label, def) => {
    const e = refusal({ type: "object", properties: { owner: def } });
    expect(e.code).toBe("ERR_TOOLGEN_SCHEMA_INVALID");
    expect(e.message).toBe('property "owner" has no type');
    expect(e.message).not.toContain("must be an object");
  });

  test("an array property keeps its description, and a non-string description is dropped", () => {
    const out = validateInputSchema({
      type: "object",
      properties: {
        pages: { type: "array", items: { type: "number" }, description: "page numbers" },
        flags: { type: "array", items: { type: "boolean" }, description: 42 },
      },
    });
    expect(out.properties["pages"]).toEqual({
      type: "array",
      items: { type: "number" },
      description: "page numbers",
    });
    expect(out.properties["flags"]).toEqual({ type: "array", items: { type: "boolean" } });
  });
});

describe("zodSchemaFromInputSchema — every scalar and array item type", () => {
  const schema = validateInputSchema({
    type: "object",
    properties: {
      draft: { type: "boolean", description: "open as a draft" },
      ids: { type: "array", items: { type: "number" } },
      toggles: { type: "array", items: { type: "boolean" } },
    },
    required: ["draft"],
  });
  const zod = zodSchemaFromInputSchema(schema);

  test("a boolean property takes a boolean and refuses a string that looks like one", () => {
    expect(zod.safeParse({ draft: true }).success).toBe(true);
    expect(zod.safeParse({ draft: "true" }).success).toBe(false);
  });

  test("a number[] property takes numbers and refuses numeric strings", () => {
    expect(zod.safeParse({ draft: false, ids: [1, 2.5] }).success).toBe(true);
    expect(zod.safeParse({ draft: false, ids: ["1"] }).success).toBe(false);
  });

  test("a boolean[] property takes booleans and refuses 0/1", () => {
    expect(zod.safeParse({ draft: false, toggles: [true, false] }).success).toBe(true);
    expect(zod.safeParse({ draft: false, toggles: [0, 1] }).success).toBe(false);
  });

  test("a description reaches the model-facing schema; an undescribed property carries none", () => {
    const json = z.toJSONSchema(zod) as {
      properties: Record<string, { description?: string }>;
      required?: string[];
    };
    expect(json.properties["draft"]?.description).toBe("open as a draft");
    expect(json.properties["ids"]?.description).toBeUndefined();
    expect(json.required).toEqual(["draft"]);
  });
});

describe("zodSchemaFromInputSchema — a schema that skipped validation fails closed", () => {
  // Only reachable with a schema that never passed `validateInputSchema` (a hand-built or corrupted
  // one). It must throw, not quietly produce a permissive model-facing schema.
  test("an unknown property type throws, naming the property", () => {
    const bad = {
      type: "object",
      properties: { when: { type: "date" } },
    } as unknown as ToolInputSchema;
    expect(() => zodSchemaFromInputSchema(bad)).toThrow('unhandled property: {"type":"date"}');
  });

  test("an unknown array item type throws, naming the item type", () => {
    const bad = {
      type: "object",
      properties: { rows: { type: "array", items: { type: "object" } } },
    } as unknown as ToolInputSchema;
    expect(() => zodSchemaFromInputSchema(bad)).toThrow("unhandled array item type: object");
  });
});
