import { describe, expect, test } from "bun:test";

import { DEFAULT_COST_AZURE_CONFIG } from "./cost-azure-toml.ts";
import { resolveCostConfig } from "./cost-toml.ts";
import { mergeLayerDocs, parseLayerDoc } from "./layered-merge.ts";

const base = (text: string) =>
  resolveCostConfig(
    mergeLayerDocs([parseLayerDoc({ kind: "base", id: "base", path: "/x/0" }, text)]).sections,
  );
const az = (body: string) => base(`[cost.azure]\n${body}\n`);
const EXPORT = 'export = { account = "acmecost", container = "exports", path = "focus/monthly" }';

describe("[cost.azure]", () => {
  test("absent: nothing configured", () => {
    expect(base("").azure).toEqual(DEFAULT_COST_AZURE_CONFIG);
  });

  test("an export and scopes; the path's outer slashes and a scope's trailing slash are dropped", () => {
    const c = az(
      `export = { account = "acmecost", container = "my-exports", path = "/focus/monthly/" }\nscopes = ["/subscriptions/00000000-0000-0000-0000-000000000000/", "providers/Microsoft.Billing/billingAccounts/123"]`,
    );
    expect(c.error).toBeNull();
    expect(c.azure).toEqual({
      export: { account: "acmecost", container: "my-exports", path: "focus/monthly" },
      scopes: [
        "/subscriptions/00000000-0000-0000-0000-000000000000",
        "/providers/microsoft.billing/billingaccounts/123",
      ],
    });
  });

  test("scopes alone are parsed (slice 12b reads them)", () => {
    const c = az(
      'scopes = ["/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg-1"]',
    );
    expect(c.azure.export).toBeNull();
    expect(c.azure.scopes).toEqual([
      "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg-1",
    ]);
  });

  test("refusals refuse the whole cost config", () => {
    const bad = [
      'export = "x"',
      'export = { account = "AB", container = "exports", path = "p" }',
      'export = { account = "acmecost", container = "a--b", path = "p" }',
      'export = { account = "acmecost", container = "exports", path = "" }',
      'export = { account = "acmecost", container = "exports", path = "a/../b" }',
      'export = { account = "acmecost", container = "exports", path = "a b" }',
      'export = { account = "acmecost", container = "exports", path = 3 }',
      'export = { account = "acmecost", container = "exports", path = "p", extra = 1 }',
      'scopes = "x"',
      'scopes = ["relative"]',
      'scopes = ["/a"]',
      'scopes = ["/subscriptions/0000"]',
      'scopes = ["/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/.."]',
      'scopes = ["/subscriptions/00000000-0000-0000-0000-000000000000", "/subscriptions/00000000-0000-0000-0000-000000000000/"]',
      'scopes = ["/a/../b"]',
      "bogus = 1",
    ];
    for (const b of bad) expect(az(b).error).not.toBeNull();
    expect(az(EXPORT).error).toBeNull();
    const many = Array.from(
      { length: 51 },
      (_, i) => `"/subscriptions/00000000-0000-0000-0000-${String(i).padStart(12, "0")}"`,
    ).join(",");
    expect(az(`scopes = [${many}]`).error).toContain("at most 50");
  });

  test("scopes are lower-cased; two spellings of one scope are one scope (a duplicate)", () => {
    const c = az(
      'scopes = ["/Subscriptions/00000000-0000-0000-0000-000000000000/ResourceGroups/RG-One"]',
    );
    expect(c.azure.scopes).toEqual([
      "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg-one",
    ]);
    const d = az(
      'scopes = ["/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg", "/SUBSCRIPTIONS/00000000-0000-0000-0000-000000000000/RESOURCEGROUPS/RG/"]',
    );
    expect(d.error).toContain("twice");
  });

  test("a scope inside another listed scope is refused, naming both", () => {
    const c = az(
      'scopes = ["/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg", "/subscriptions/00000000-0000-0000-0000-000000000000"]',
    );
    expect(c.error).toContain(
      "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg",
    );
    expect(c.error).toContain("is inside /subscriptions/00000000-0000-0000-0000-000000000000");
    expect(
      az(
        'scopes = ["/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/a", "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/b"]',
      ).error,
    ).toBeNull();
  });
});
