import { describe, expect, test } from "bun:test";

import type { CostLine } from "./cost-line.ts";
import { allocate, type CostRule, compileCostRule, globMatches } from "./cost-rules.ts";

function line(over: Partial<CostLine> = {}): CostLine {
  return {
    source: "focus",
    provider: "aws",
    billingAccountId: "111",
    billingPeriod: "2026-11",
    chargeDay: "2026-11-01",
    subAccountId: "222",
    subAccountName: "web-prod",
    serviceName: "Amazon S3",
    serviceCategory: "Storage",
    regionId: "us-east-1",
    resourceId: "arn:aws:s3:::acme-web",
    resourceName: "acme-web",
    skuId: null,
    chargeCategory: "usage",
    billedCost: 1,
    effectiveCost: null,
    currency: "USD",
    tags: { product: "checkout", env: "prod" },
    repo: null,
    workflow: null,
    model: null,
    importId: "i",
    ...over,
  };
}

const rule = (match: CostRule["match"], set: CostRule["set"], index = 1): CostRule =>
  compileCostRule({ match, set }, index);

describe("globMatches", () => {
  test("* and ? only, case-insensitive, regex characters literal", () => {
    expect(globMatches("amazon *", "Amazon S3")).toBe(true);
    expect(globMatches("s?", "S3")).toBe(true);
    expect(globMatches("s?", "S33")).toBe(false);
    expect(globMatches("a.b", "aXb")).toBe(false);
    expect(globMatches("(x)+", "(x)+")).toBe(true);
  });
});

describe("allocate", () => {
  test("first match wins", () => {
    const rules = [
      rule({ provider: "aws" }, { product: "first" }),
      rule({}, { product: "second" }, 2),
    ];
    expect(allocate(line(), rules)).toMatchObject({ product: "first", rule: 1 });
  });

  test("every given match key must match", () => {
    const rules = [
      rule({ provider: "aws", service: "Amazon EC2" }, { product: "ec2" }),
      rule({}, { env: "x" }, 2),
    ];
    expect(allocate(line(), rules)).toMatchObject({ product: null, env: "x", rule: 2 });
  });

  test("sub_account and resource match the id or the name; a missing value never matches", () => {
    expect(allocate(line(), [rule({ sub_account: "web-*" }, { product: "p" })]).product).toBe("p");
    expect(allocate(line(), [rule({ resource: "acme-web" }, { product: "p" })]).product).toBe("p");
    expect(
      allocate(line({ repo: null }), [rule({ repo: "*" }, { product: "p" })]).unassignedReason,
    ).toBe("no rule matched");
  });

  test("tag matchers need the tag present and matching", () => {
    const r = [rule({ tag: { product: "check*" } }, { product: "p" })];
    expect(allocate(line(), r).product).toBe("p");
    expect(allocate(line({ tags: {} }), r).unassignedReason).toBe("no rule matched");
  });

  test("a tag is read as an own property only, never from the prototype", () => {
    const byMatch = [rule({ tag: { constructor: "*" } }, { product: "p" })];
    expect(allocate(line(), byMatch).unassignedReason).toBe("no rule matched");
    const byPlaceholder = [rule({}, { product: "{tag.constructor}" })];
    expect(allocate(line(), byPlaceholder).product).toBeNull();
    const own = line({ tags: JSON.parse('{"__proto__":"finance"}') as Record<string, string> });
    expect(allocate(own, [rule({}, { product: "{tag.__proto__}" })]).product).toBe("finance");
  });

  test("placeholders substitute from the line", () => {
    const r = [
      rule({}, { product: "{tag.product}", env: "{tag.env}", service: "svc-{sub_account}" }),
    ];
    expect(allocate(line(), r)).toEqual({
      product: "checkout",
      env: "prod",
      service: "svc-222",
      rule: 1,
      unassignedReason: null,
    });
    const repo = [rule({ source: "github_actions" }, { product: "{repo}" })];
    expect(allocate(line({ source: "github_actions", repo: "acme/web" }), repo).product).toBe(
      "acme/web",
    );
  });

  test("a substituted value outside the charset lands the line unassigned with the reason (Review Focus 4)", () => {
    const r = [rule({}, { product: "{tag.product}" })];
    for (const bad of ["<!here>", "../../x", "a b", "x".repeat(65), "/etc", "@channel*"]) {
      const a = allocate(line({ tags: { product: bad } }), r);
      expect(a.product).toBeNull();
      expect(a.rule).toBe(1);
      expect(a.unassignedReason).toContain("rule 1: product");
    }
  });

  test("an empty placeholder value is unassigned, not a fall-through to the next rule", () => {
    const r = [rule({}, { product: "{tag.missing}" }), rule({}, { product: "never" }, 2)];
    expect(allocate(line(), r)).toMatchObject({
      product: null,
      rule: 1,
      unassignedReason: "rule 1: product: {tag.missing} is empty on this line",
    });
  });

  test("no rules, or none matching, is unassigned 'no rule matched'", () => {
    expect(allocate(line(), [])).toEqual({
      product: null,
      env: null,
      service: null,
      rule: null,
      unassignedReason: "no rule matched",
    });
  });
});

describe("compileCostRule (config load)", () => {
  test("an unknown match key or set key is an error naming it", () => {
    expect(() => compileCostRule({ match: { colour: "red" }, set: { product: "p" } }, 3)).toThrow(
      /rule 3: unknown match key "colour"/,
    );
    expect(() => compileCostRule({ match: {}, set: { team: "p" } }, 1)).toThrow(
      /unknown set key "team"/,
    );
  });

  test("an unknown placeholder, two placeholders, or a bad literal is an error naming it", () => {
    expect(() => compileCostRule({ match: {}, set: { product: "{owner}" } }, 2)).toThrow(
      /rule 2: product: unknown placeholder \{owner\}/,
    );
    expect(() =>
      compileCostRule({ match: {}, set: { product: "{repo}-{sub_account}" } }, 1),
    ).toThrow(/at most one placeholder/);
    expect(() => compileCostRule({ match: {}, set: { product: "a b" } }, 1)).toThrow(/not allowed/);
  });

  test("a rule must set something", () => {
    expect(() => compileCostRule({ match: { provider: "aws" }, set: {} }, 1)).toThrow(
      /sets nothing/,
    );
  });

  test("non-string values are refused", () => {
    expect(() => compileCostRule({ match: { provider: 1 }, set: { product: "p" } }, 1)).toThrow(
      /string/,
    );
    expect(() => compileCostRule({ match: { tag: "x" }, set: { product: "p" } }, 1)).toThrow(
      /table/,
    );
  });
});
