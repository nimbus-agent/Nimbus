import { describe, expect, it } from "vitest";
import {
  buildFormModel,
  collectParams,
  FEDERATED_AGENTS,
  hasRequiredParams,
  SINCE_PRESETS,
} from "../../src/briefs/brief-form";
import type { CatalogAgent, CatalogParam } from "../../src/ipc/types";

function p(over: Partial<CatalogParam> & { name: string }): CatalogParam {
  return { kind: "string", label: over.name, required: false, ...over };
}

function agent(name: string, params: CatalogParam[]): CatalogAgent {
  return {
    name,
    method: `agents.${name}`,
    displayName: name,
    description: "",
    category: "code",
    roles: [],
    params,
    surfaces: { external: true, fleet: true },
    visible: true,
  };
}

describe("buildFormModel", () => {
  it("never offers federation params", () => {
    const m = buildFormModel([
      p({ name: "namespace" }),
      p({ name: "namespaces", kind: "stringArray" }),
      p({ name: "service" }),
    ]);
    expect(m.plain.map((x) => x.name)).toEqual(["service"]);
    expect(m.groups).toEqual([]);
  });

  it("groups oneOf params by group and arm, in order", () => {
    const m = buildFormModel([
      p({
        name: "file",
        oneOf: { group: "target", arm: "file", required: true, armRequired: true },
      }),
      p({
        name: "repo",
        oneOf: { group: "target", arm: "forge", required: true, armRequired: true },
      }),
      p({
        name: "service",
        oneOf: { group: "target", arm: "forge", required: true, armRequired: false },
      }),
    ]);
    expect(m.groups).toHaveLength(1);
    expect(m.groups[0]?.required).toBe(true);
    expect(m.groups[0]?.arms.map((a) => [a.arm, a.fields.map((f) => f.name)])).toEqual([
      ["file", ["file"]],
      ["forge", ["repo", "service"]],
    ]);
  });
});

describe("collectParams", () => {
  const model = (params: CatalogParam[]) => buildFormModel(params);

  it("trims strings and omits empty ones", () => {
    const m = model([p({ name: "a" }), p({ name: "b" })]);
    expect(collectParams(m, { a: "  x  ", b: "   " }, {})).toEqual({
      ok: true,
      params: { a: "x" },
    });
  });

  it("converts numbers and reports non-finite ones", () => {
    const m = model([p({ name: "n", kind: "number", label: "Count" })]);
    expect(collectParams(m, { n: "42" }, {})).toEqual({ ok: true, params: { n: 42 } });
    expect(collectParams(m, { n: "abc" }, {})).toEqual({
      ok: false,
      problems: ["Count must be a number"],
    });
    expect(collectParams(m, { n: "" }, {})).toEqual({ ok: true, params: {} });
  });

  it("sends booleans only when true", () => {
    const m = model([p({ name: "f", kind: "boolean" })]);
    expect(collectParams(m, { f: true }, {})).toEqual({ ok: true, params: { f: true } });
    expect(collectParams(m, { f: false }, {})).toEqual({ ok: true, params: {} });
  });

  it("splits string arrays on commas, trims, drops empties and omits an empty list", () => {
    const m = model([p({ name: "l", kind: "stringArray" })]);
    expect(collectParams(m, { l: " a, b ,,c " }, {})).toEqual({
      ok: true,
      params: { l: ["a", "b", "c"] },
    });
    expect(collectParams(m, { l: " , " }, {})).toEqual({ ok: true, params: {} });
  });

  it("enforces required plain params", () => {
    const m = model([p({ name: "svc", label: "Service", required: true })]);
    expect(collectParams(m, {}, {})).toEqual({ ok: false, problems: ["Service is required"] });
  });

  it("requires an arm for a required group and names the choices", () => {
    const m = model([
      p({ name: "a", oneOf: { group: "g", arm: "one", required: true, armRequired: true } }),
      p({ name: "b", oneOf: { group: "g", arm: "two", required: true, armRequired: true } }),
    ]);
    expect(collectParams(m, {}, {})).toEqual({
      ok: false,
      problems: ["Choose one of: one, two"],
    });
  });

  it("sends only the chosen arm's fields and enforces its armRequired ones", () => {
    const m = model([
      p({
        name: "a",
        label: "A",
        oneOf: { group: "g", arm: "one", required: true, armRequired: true },
      }),
      p({ name: "b", oneOf: { group: "g", arm: "two", required: true, armRequired: true } }),
      p({ name: "c", oneOf: { group: "g", arm: "one", required: true, armRequired: false } }),
    ]);
    expect(collectParams(m, { a: "x", b: "y", c: "z" }, { g: "one" })).toEqual({
      ok: true,
      params: { a: "x", c: "z" },
    });
    expect(collectParams(m, { b: "y" }, { g: "one" })).toEqual({
      ok: false,
      problems: ["A is required"],
    });
  });

  it("collects a sinceMs select value as a number and omits Default", () => {
    const m = model([p({ name: "sinceMs", kind: "number", label: "Window" })]);
    expect(collectParams(m, { sinceMs: "604800000" }, {})).toEqual({
      ok: true,
      params: { sinceMs: 604_800_000 },
    });
    expect(collectParams(m, { sinceMs: "Default" }, {})).toEqual({ ok: true, params: {} });
    expect(collectParams(m, { sinceMs: "" }, {})).toEqual({ ok: true, params: {} });
  });
});

describe("hasRequiredParams", () => {
  it("is true for a required plain param", () => {
    expect(hasRequiredParams(agent("why", [p({ name: "q", required: true })]))).toBe(true);
  });

  it("is true for a required group", () => {
    const a = agent("impact", [
      p({ name: "f", oneOf: { group: "g", arm: "x", required: true, armRequired: true } }),
    ]);
    expect(hasRequiredParams(a)).toBe(true);
  });

  it("is false when nothing is required", () => {
    expect(hasRequiredParams(agent("decisions", [p({ name: "sinceMs", kind: "number" })]))).toBe(
      false,
    );
  });

  it("ignores a required federation param the form hides", () => {
    expect(hasRequiredParams(agent("x", [p({ name: "namespace", required: true })]))).toBe(false);
  });
});

describe("constants", () => {
  it("names the federated agents and the since presets", () => {
    expect([...FEDERATED_AGENTS].sort()).toEqual(["ghost", "huddle"]);
    expect(SINCE_PRESETS.map((s) => s.label)).toEqual([
      "Default",
      "24 hours",
      "7 days",
      "30 days",
      "90 days",
      "1 year",
    ]);
  });
});
