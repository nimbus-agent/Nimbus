import { describe, expect, test } from "bun:test";

import { DEFAULT_COST_BITBUCKET_CONFIG } from "./cost-bitbucket-toml.ts";
import { resolveCostConfig } from "./cost-toml.ts";
import { mergeLayerDocs, parseLayerDoc } from "./layered-merge.ts";

const base = (text: string) =>
  resolveCostConfig(
    mergeLayerDocs([parseLayerDoc({ kind: "base", id: "base", path: "/x/0" }, text)]).sections,
  );
const bitbucket = (body: string) => base(`[cost.bitbucket]\n${body}\n`);

describe("[cost.bitbucket]", () => {
  test("absent: no workspaces and no rate, so nothing is synced", () => {
    expect(base("").bitbucket).toEqual(DEFAULT_COST_BITBUCKET_CONFIG);
  });

  test("workspaces, a rate, a currency and size rates (sorted)", () => {
    const c = bitbucket(
      'workspaces = ["acme", "acme-labs"]\nrate_per_minute = 0.01\ncurrency = "EUR"\nsize_rates = { "4x" = 0.04, "2x" = 0.02 }',
    );
    expect(c.error).toBeNull();
    expect(c.bitbucket).toEqual({
      workspaces: ["acme", "acme-labs"],
      ratePerMinute: 0.01,
      currency: "EUR",
      sizeRates: [
        ["2x", 0.02],
        ["4x", 0.04],
      ],
    });
  });

  test.each([
    ['workspaces = ["Bad Slug"]', "workspace slug"],
    ['workspaces = ["-lead"]', "workspace slug"],
    ['workspaces = ["a", "a"]', "listed twice"],
    ['workspaces = "acme"', "list of workspace slugs"],
    ["workspaces = [1]", "workspace slug"],
    ['size_rates = { "3x" = 0.1 }', "not a step size"],
    ['size_rates = { "2x" = -1 }', "price per minute"],
    ['size_rates = ["2x"]', "size_rates must be a table"],
    ["rate_per_minute = -0.5", "price per minute"],
    ['rate_per_minute = "0.01"', "price per minute"],
    ["rate_per_minute = 100000", "price per minute"],
    ['currency = "usd"', "ISO 4217"],
    ["unknown_key = 1", "unknown key"],
  ])("%s is refused (%s) and refuses the cost config", (body, why) => {
    const c = bitbucket(body);
    expect(c.error).toContain(why);
    expect(c.rules).toEqual([]);
    expect(c.bitbucket).toEqual(DEFAULT_COST_BITBUCKET_CONFIG);
  });

  test("more than 50 workspaces is refused", () => {
    const many = Array.from({ length: 51 }, (_, i) => `"w${String(i)}"`).join(", ");
    expect(bitbucket(`workspaces = [${many}]`).error).toContain("at most 50");
  });
});
