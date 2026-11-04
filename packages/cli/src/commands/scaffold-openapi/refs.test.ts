import { describe, expect, test } from "bun:test";
import {
  emptyObject,
  isObject,
  MAX_NESTING,
  MAX_REF_DEPTH,
  MAX_RESOLVED_NODES,
  OpenApiModelError,
  own,
  resolveRefs,
} from "./refs.ts";

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw");
}

describe("resolveRefs", () => {
  test("replaces a local $ref with its target, deeply, through arrays", () => {
    const root = {
      components: { schemas: { Id: { type: "string" } } },
    };
    const out = resolveRefs(
      { a: [{ $ref: "#/components/schemas/Id" }], b: { $ref: "#/components/schemas/Id" } },
      root,
    );
    expect(out).toEqual({ a: [{ type: "string" }], b: { type: "string" } });
  });

  test("unescapes ~1 to / and ~0 to ~ (in that order)", () => {
    const root = { paths: { "/pets": { x: 1 }, "a~1b": { y: 2 } } };
    expect(resolveRefs({ $ref: "#/paths/~1pets" }, root)).toEqual({ x: 1 });
    expect(resolveRefs({ $ref: "#/paths/a~01b" }, root)).toEqual({ y: 2 });
  });

  test("resolves array indices and the whole document", () => {
    const root = { list: ["zero", { one: true }] };
    expect(resolveRefs({ $ref: "#/list/1" }, root)).toEqual({ one: true });
    expect(resolveRefs({ $ref: "#" }, { k: 1 })).toEqual({ k: 1 });
  });

  test("an external $ref is refused naming the pointer", () => {
    const e = errorOf(() => resolveRefs({ $ref: "other.yaml#/components/x" }, {}));
    expect(e).toBeInstanceOf(OpenApiModelError);
    expect(e.message).toBe("external $ref is not supported: other.yaml#/components/x");
  });

  test("a $ref to a missing pointer is refused", () => {
    const e = errorOf(() => resolveRefs({ $ref: "#/components/schemas/Nope" }, { components: {} }));
    expect(e.message).toBe("$ref #/components/schemas/Nope points at nothing in the document");
  });

  test("a fragment that is not a pointer is refused", () => {
    const e = errorOf(() => resolveRefs({ $ref: "#Pet" }, {}));
    expect(e.message).toBe("$ref #Pet is not a JSON pointer");
  });

  test.each(["__proto__", "constructor", "prototype"])("the segment %s is refused", (seg) => {
    const e = errorOf(() => resolveRefs({ $ref: `#/a/${seg}` }, { a: {} }));
    expect(e).toBeInstanceOf(OpenApiModelError);
    expect(e.message).toBe(`$ref #/a/${seg} uses the forbidden segment "${seg}"`);
  });

  test("inherited properties are never followed", () => {
    const e = errorOf(() => resolveRefs({ $ref: "#/toString" }, {}));
    expect(e.message).toBe("$ref #/toString points at nothing in the document");
  });

  test("a cycle is cut at depth 8 with {} and one warning per cut, never a stack overflow", () => {
    const root = { s: { A: { next: { $ref: "#/s/A" } } } };
    const cuts: string[] = [];
    const out = resolveRefs({ $ref: "#/s/A" }, root, 0, (r) => cuts.push(r));
    let expected: unknown = {};
    for (let i = 0; i < MAX_REF_DEPTH; i++) expected = { next: expected };
    expect(out).toEqual(expected);
    expect(cuts).toEqual(["#/s/A"]);
  });

  test("a self-referencing $ref is cut too", () => {
    const root = { a: { $ref: "#/a" } };
    const cuts: string[] = [];
    expect(resolveRefs({ $ref: "#/a" }, root, 0, (r) => cuts.push(r))).toEqual({});
    expect(cuts).toEqual(["#/a"]);
  });

  test("the starting depth counts against the cap", () => {
    const root = { a: { v: 1 } };
    expect(resolveRefs({ $ref: "#/a" }, root, MAX_REF_DEPTH)).toEqual({});
    expect(resolveRefs({ $ref: "#/a" }, root, MAX_REF_DEPTH - 1)).toEqual({ v: 1 });
  });

  test("a document key __proto__ lands as own data on a null-prototype object", () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "x": 1}') as unknown;
    const out = resolveRefs(parsed, {}) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("a $ref key whose value is not a string is ordinary data", () => {
    expect(resolveRefs({ properties: { $ref: { type: "string" } } }, {})).toEqual({
      properties: { $ref: { type: "string" } },
    });
  });

  test("nesting deeper than the cap is refused with a message", () => {
    let deep: unknown = {};
    for (let i = 0; i <= MAX_NESTING + 1; i++) deep = { d: deep };
    expect(errorOf(() => resolveRefs(deep, {})).message).toBe(
      `the document nests more than ${MAX_NESTING} levels deep`,
    );
  });

  test("an expansion past the node budget is refused", () => {
    // Each level references the next one ten times: 10^5 nodes well before the depth cut.
    const s: Record<string, unknown> = {};
    for (let i = 0; i < 6; i++) {
      s[`L${i}`] = Array.from({ length: 10 }, () => ({ $ref: `#/s/L${i + 1}` }));
    }
    s["L6"] = { leaf: true };
    expect(errorOf(() => resolveRefs({ $ref: "#/s/L0" }, { s })).message).toBe(
      `$ref expansion exceeds ${MAX_RESOLVED_NODES} nodes`,
    );
  });

  test("primitives pass through", () => {
    expect(resolveRefs("x", {})).toBe("x");
    expect(resolveRefs(null, {})).toBeNull();
  });
});

describe("helpers", () => {
  test("own reads own properties only", () => {
    expect(own({ a: 1 }, "a")).toBe(1);
    expect(own({}, "toString")).toBeUndefined();
    expect(own(null, "a")).toBeUndefined();
    expect(own("str", "length")).toBeUndefined();
  });

  test("isObject excludes null and arrays", () => {
    expect(isObject({})).toBe(true);
    expect(isObject([])).toBe(false);
    expect(isObject(null)).toBe(false);
  });

  test("emptyObject has no prototype", () => {
    expect(Object.getPrototypeOf(emptyObject())).toBeNull();
  });
});
