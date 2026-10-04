/**
 * `parseSpec` over inline documents: the malformed path items, non-method keys and sparse AsyncAPI
 * channels real specs contain, and the parse-failure / not-a-spec shapes the fixture files in
 * `openapi-indexer-parsing.test.ts` do not cover.
 */
import { describe, expect, test } from "bun:test";

import { type ParseResult, parseSpec } from "./openapi-indexer-parsing.ts";

const MAX = 5 * 1024 * 1024;

function parsed(r: ParseResult): Extract<ParseResult, { kind: "parsed" }> {
  if (r.kind !== "parsed") throw new Error(`expected a parsed spec, got skipped: ${r.reason}`);
  return r;
}

function jsonSpec(doc: unknown): ParseResult {
  return parseSpec({ absPath: "spec.json", source: JSON.stringify(doc), maxBytes: MAX });
}

describe("OpenAPI path items", () => {
  test("non-object path items, non-method keys and non-object operations are skipped", () => {
    const r = parsed(
      jsonSpec({
        openapi: "3.0.3",
        info: { title: "Shop" },
        paths: {
          "/null-item": null,
          "/number-item": 5,
          "/orders": {
            summary: "path-level summary is not an operation",
            parameters: [{ name: "id", in: "path" }],
            "x-internal": { get: "vendor extension" },
            get: { operationId: "listOrders", tags: ["orders", 7, null] },
            post: null,
            delete: "not an operation object",
            PATCH: { operationId: "patchOrders", deprecated: true },
          },
        },
      }),
    );

    // Only the two real operations survive; method keys match case-insensitively.
    expect(r.endpoints).toEqual([
      {
        method: "GET",
        path: "/orders",
        operationId: "listOrders",
        tags: ["orders"],
        deprecated: false,
      },
      {
        method: "PATCH",
        path: "/orders",
        operationId: "patchOrders",
        tags: [],
        deprecated: true,
      },
    ]);
  });

  test("a blank operationId or title reads as absent", () => {
    const r = parsed(
      jsonSpec({
        openapi: "3.1.0",
        info: { title: "   " },
        paths: { "/x": { get: { operationId: "  " } } },
      }),
    );
    expect(r.endpoints[0]?.operationId).toBeUndefined();
    expect(r.infoTitle).toBe("");
  });

  test("a spec with no info block at all has an empty title", () => {
    const r = parsed(jsonSpec({ swagger: "2.0", paths: {} }));
    expect(r.infoTitle).toBe("");
    expect(r.specVersion).toBe("swagger-2.0");
    expect(r.endpoints).toEqual([]);
  });
});

describe("AsyncAPI channels", () => {
  test("a document with no channels object yields no endpoints but still parses", () => {
    for (const channels of [undefined, null, "not an object"]) {
      const r = parsed(jsonSpec({ asyncapi: "2.6.0", info: { title: "Events" }, channels }));
      expect(r.endpoints).toEqual([]);
      expect(r.specVersion).toBe("asyncapi-2.6.0");
      expect(r.infoTitle).toBe("Events");
    }
  });

  test("non-object channels and missing operations are skipped", () => {
    const r = parsed(
      jsonSpec({
        asyncapi: "2.6.0",
        channels: {
          "user/null": null,
          "user/string": "nope",
          "user/signedup": {
            publish: { operationId: "onSignup", tags: ["users"] },
            subscribe: null,
          },
          "user/deleted": { subscribe: { deprecated: true } },
        },
      }),
    );
    expect(r.endpoints).toEqual([
      {
        method: "PUBLISH",
        path: "user/signedup",
        operationId: "onSignup",
        tags: ["users"],
        deprecated: false,
      },
      {
        method: "SUBSCRIBE",
        path: "user/deleted",
        operationId: undefined,
        tags: [],
        deprecated: true,
      },
    ]);
  });
});

describe("documents that are not parseable specs", () => {
  test.each([
    ["a .json file with invalid JSON", "api.json", '{"openapi": "3.0.0",'],
    ["a .yaml file whose body starts like JSON but is not", "api.yaml", "{ openapi: 3.0.0 ]"],
    ["a .yaml file that starts like a JSON array but is not", "api.yaml", "[1, 2"],
    ["an empty YAML document", "api.yaml", ""],
  ])("%s → parse_failed", (_label, absPath, source) => {
    expect(parseSpec({ absPath, source, maxBytes: MAX })).toEqual({
      kind: "skipped",
      reason: "parse_failed",
    });
  });

  test.each([
    ["a YAML scalar", "api.yaml", "just a sentence, not a mapping"],
    ["a YAML null", "api.yaml", "~"],
    ["a JSON number", "api.json", "42"],
    ["a JSON object with no version key", "api.json", '{"info":{"title":"x"},"paths":{}}'],
  ])("%s → not_a_spec", (_label, absPath, source) => {
    expect(parseSpec({ absPath, source, maxBytes: MAX })).toEqual({
      kind: "skipped",
      reason: "not_a_spec",
    });
  });
});
