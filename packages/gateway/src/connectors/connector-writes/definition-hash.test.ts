import { describe, expect, test } from "bun:test";
import { toStandardSchema } from "@mastra/core/schema";

import { definitionSha256 } from "./definition-hash.ts";

type JsonSchemaInput = Parameters<typeof toStandardSchema>[0];

/** A listed entry the way `MCPClient.listTools()` hands it out: description plus a schema wrapper. */
function entry(description: unknown, schema: Record<string, unknown>): unknown {
  return { description, inputSchema: toStandardSchema(schema as JsonSchemaInput) };
}

const BASE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    labels: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, color: { type: "string" } },
      },
    },
    mode: { type: "string", enum: ["a", "b"] },
  },
  required: ["title"],
};

describe("definitionSha256", () => {
  test("is 64 lower-case hex characters", () => {
    expect(definitionSha256("t", entry("d", BASE_SCHEMA))).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is the same whatever the key order, at the top level and nested three levels deep", () => {
    const reordered = {
      required: ["title"],
      properties: {
        mode: { enum: ["a", "b"], type: "string" },
        labels: {
          items: {
            properties: { color: { type: "string" }, name: { type: "string" } },
            type: "object",
          },
          type: "array",
        },
        title: { type: "string" },
      },
      type: "object",
    };
    expect(definitionSha256("t", entry("d", reordered))).toBe(
      definitionSha256("t", entry("d", BASE_SCHEMA)),
    );
  });

  test("array order is kept and DOES change the hash", () => {
    const flipped = {
      ...BASE_SCHEMA,
      properties: { ...BASE_SCHEMA.properties, mode: { type: "string", enum: ["b", "a"] } },
    };
    expect(definitionSha256("t", entry("d", flipped))).not.toBe(
      definitionSha256("t", entry("d", BASE_SCHEMA)),
    );
  });

  test.each([
    ["the description", () => entry("d!", BASE_SCHEMA)],
    [
      "a property name",
      () =>
        entry("d", {
          ...BASE_SCHEMA,
          properties: { ...BASE_SCHEMA.properties, titel: { type: "string" }, title: undefined },
        }),
    ],
    [
      "a nested enum value",
      () =>
        entry("d", {
          ...BASE_SCHEMA,
          properties: { ...BASE_SCHEMA.properties, mode: { type: "string", enum: ["a", "c"] } },
        }),
    ],
    ["required", () => entry("d", { ...BASE_SCHEMA, required: [] })],
  ])("a one-byte change in %s changes the hash", (_n, make) => {
    expect(definitionSha256("t", make())).not.toBe(definitionSha256("t", entry("d", BASE_SCHEMA)));
  });

  test("the tool id is part of it", () => {
    expect(definitionSha256("a", entry("d", BASE_SCHEMA))).not.toBe(
      definitionSha256("b", entry("d", BASE_SCHEMA)),
    );
  });

  test("a description that is not a string hashes as null and differs from the empty string", () => {
    const asNull = definitionSha256("t", entry(undefined, BASE_SCHEMA));
    expect(asNull).toBe(definitionSha256("t", entry(42, BASE_SCHEMA)));
    expect(asNull).not.toBe(definitionSha256("t", entry("", BASE_SCHEMA)));
  });

  test("an NFC and an NFD spelling of one description hash differently", () => {
    const nfc = `caf${String.fromCodePoint(0xe9)}`;
    const nfd = `cafe${String.fromCodePoint(0x301)}`;
    expect(definitionSha256("t", entry(nfc, BASE_SCHEMA))).not.toBe(
      definitionSha256("t", entry(nfd, BASE_SCHEMA)),
    );
  });

  test("a schema holding a non-integer number hashes", () => {
    expect(
      definitionSha256(
        "t",
        entry("d", { type: "object", properties: { n: { type: "number", minimum: 0.5 } } }),
      ),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "x"],
    ["an array", []],
    ["an entry with no schema", { description: "d" }],
    ["an entry whose schema is not a standard schema", { description: "d", inputSchema: { a: 1 } }],
    ["an entry whose schema is a string", { description: "d", inputSchema: "object" }],
  ])("%s cannot be hashed", (_n, listed) => {
    expect(definitionSha256("t", listed)).toBeUndefined();
  });
});
