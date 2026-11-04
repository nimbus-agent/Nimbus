import { describe, expect, test } from "bun:test";
import {
  CHARS_PER_NODE,
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
      "the document expands to more than 100,000 schema nodes",
    );
    expect(MAX_RESOLVED_NODES).toBe(100_000);
  });

  test("one budget object is shared across calls", () => {
    const budget = { used: 0, limit: 10 };
    resolveRefs({ a: { b: {} } }, {}, 0, undefined, budget);
    expect(budget.used).toBe(3);
    resolveRefs({ a: { b: { c: {} } } }, {}, 0, undefined, budget);
    expect(budget.used).toBe(7);
    expect(
      errorOf(() => resolveRefs({ a: { b: { c: {} } } }, {}, 0, undefined, budget)).message,
    ).toBe("the document expands to more than 10 schema nodes");
  });

  test("strings, other primitives and long keys are charged to the budget", () => {
    const charge = (node: unknown): number => {
      const budget = { used: 0, limit: 1_000_000 };
      resolveRefs(node, {}, 0, undefined, budget);
      return budget.used;
    };
    expect(CHARS_PER_NODE).toBe(64);
    expect(charge("")).toBe(0);
    expect(charge("a")).toBe(1);
    expect(charge("a".repeat(64))).toBe(1);
    expect(charge("a".repeat(65))).toBe(2);
    expect(charge([1, true, null])).toBe(4);
    // An object is 1; a key of up to 64 characters is free, then 1 more per 64.
    expect(charge({ ["k".repeat(64)]: 1 })).toBe(2);
    expect(charge({ ["k".repeat(129)]: 1 })).toBe(4);
  });

  test("a long string referenced many times exhausts the budget", () => {
    const root = { big: "x".repeat(CHARS_PER_NODE * 1000) };
    const refs = Array.from({ length: 20 }, () => ({ $ref: "#/big" }));
    const budget = { used: 0, limit: 10_000 };
    expect(errorOf(() => resolveRefs(refs, root, 0, undefined, budget)).message).toBe(
      "the document expands to more than 10,000 schema nodes",
    );
  });

  test("pointer segments are percent-decoded, then ~ unescaped (RFC 6901 fragment order)", () => {
    const root = { paths: { "/pets/{id}": { ok: true }, "a b": { sp: true } } };
    expect(resolveRefs({ $ref: "#/paths/~1pets~1%7Bid%7D" }, root)).toEqual({ ok: true });
    expect(resolveRefs({ $ref: "#/paths/a%20b" }, root)).toEqual({ sp: true });
  });

  test("a percent-encoded tilde decodes to ~1 and then unescapes to /", () => {
    const root = { paths: { "/pets": { slash: true }, "~1pets": { literal: true } } };
    expect(resolveRefs({ $ref: "#/paths/%7E1pets" }, root)).toEqual({ slash: true });
  });

  test("a percent-encoded forbidden segment is still refused", () => {
    expect(errorOf(() => resolveRefs({ $ref: "#/a/%5F%5Fproto%5F%5F" }, { a: {} })).message).toBe(
      '$ref #/a/%5F%5Fproto%5F%5F uses the forbidden segment "__proto__"',
    );
  });

  test("a malformed percent-escape is refused", () => {
    const e = errorOf(() => resolveRefs({ $ref: "#/a/%E0%A4%A" }, { a: {} }));
    expect(e).toBeInstanceOf(OpenApiModelError);
    expect(e.message).toBe("$ref #/a/%E0%A4%A has a malformed percent-escape");
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
