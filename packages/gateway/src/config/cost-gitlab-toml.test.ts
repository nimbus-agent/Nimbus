import { describe, expect, test } from "bun:test";

import {
  costRatesFingerprint,
  pricedFields,
  rateForKey,
  rateKeyForRunner,
  ratePrice,
} from "../finops/cost-rate-price.ts";
import { DEFAULT_COST_GITLAB_CONFIG } from "./cost-gitlab-toml.ts";
import { resolveCostConfig } from "./cost-toml.ts";
import { mergeLayerDocs, parseLayerDoc } from "./layered-merge.ts";

const base = (text: string) =>
  resolveCostConfig(
    mergeLayerDocs([parseLayerDoc({ kind: "base", id: "base", path: "/x/0" }, text)]).sections,
  );
const gitlab = (body: string) => base(`[cost.gitlab]\n${body}\n`);

describe("[cost.gitlab]", () => {
  test("absent: no groups and no rate, so nothing is synced", () => {
    expect(base("").gitlab).toEqual(DEFAULT_COST_GITLAB_CONFIG);
  });

  test("groups, a rate, a currency and runner rates", () => {
    const c = gitlab(
      'groups = ["acme", "other/platform"]\nrate_per_minute = 0.008\ncurrency = "EUR"\nrunner_rates = { "zeta" = 0.03, "big-linux" = 0.02 }',
    );
    expect(c.error).toBeNull();
    expect(c.gitlab).toEqual({
      groups: ["acme", "other/platform"],
      ratePerMinute: 0.008,
      currency: "EUR",
      runnerRates: [
        ["big-linux", 0.02],
        ["zeta", 0.03],
      ],
    });
  });

  test("a group inside another listed group is refused, either order, any case", () => {
    expect(gitlab('groups = ["acme", "acme/web"]').error).toContain("acme/web is inside acme");
    expect(gitlab('groups = ["ACME/web", "acme"]').error).toContain("ACME/web is inside acme");
    expect(gitlab('groups = ["acme", "Acme"]').error).toContain("listed twice");
    expect(gitlab('groups = ["acme", "acme-web"]').error).toBeNull();
  });

  test("a malformed group path is refused", () => {
    for (const g of ['"-acme"', '"acme//web"', '"acme/"', '""', "3", '"a b"']) {
      expect(gitlab(`groups = [${g}]`).error).toContain("not a GitLab group path");
    }
  });

  test("a negative, too large or non-number rate is refused", () => {
    expect(gitlab("rate_per_minute = -1").error).toContain("rate_per_minute must be a number");
    expect(gitlab("rate_per_minute = 5000").error).toContain("rate_per_minute must be a number");
    expect(gitlab('rate_per_minute = "0.01"').error).toContain("rate_per_minute must be a number");
    expect(gitlab('runner_rates = { "r" = -2 }').error).toContain("runner_rates");
  });

  test("a currency must be three capital letters, and an unknown key is refused", () => {
    expect(gitlab('currency = "usd"').error).toContain("ISO 4217");
    expect(gitlab("rates = 1").error).toContain('unknown key "rates"');
  });

  test("an error refuses the whole cost config, as for every cost section", () => {
    const c = base(
      '[cost.gitlab]\nrate_per_minute = -1\n[[cost.rule]]\nmatch = { provider = "aws" }\nset = { product = "x" }\n',
    );
    expect(c.rules).toEqual([]);
    expect(c.error).not.toBeNull();
  });
});

describe("rate prices", () => {
  const rates = {
    ratePerMinute: 0.01,
    currency: "USD",
    runnerRates: [["big", 0.05]] as const,
  };

  test("a runner key prices at its runner's rate, and falls back to the default when unlisted", () => {
    expect(rateKeyForRunner("big")).toBe("runner:big");
    // An unlisted runner keeps its own key, and prices at the default until a rate is added for it.
    expect(rateKeyForRunner("small")).toBe("runner:small");
    expect(rateForKey(rates, "runner:small")).toBe(0.01);
    expect(rateKeyForRunner(null)).toBe("default");
    expect(rateForKey(rates, "runner:big")).toBe(0.05);
    expect(rateForKey(rates, "runner:gone")).toBe(0.01);
    expect(rateForKey({ ...rates, ratePerMinute: null }, "runner:gone")).toBeNull();
    expect(rateForKey(rates, "default")).toBe(0.01);
  });

  test("rounding is stable, and no rate is an unpriced line", () => {
    expect(ratePrice(3, 0.1)).toBe(0.3);
    expect(pricedFields(100, 0.01)).toEqual({ billedCost: 1, effectiveCost: 1, priced: true });
    expect(pricedFields(100, null)).toEqual({ billedCost: 0, effectiveCost: null, priced: false });
  });

  test("the fingerprint changes with a rate or the currency, and not otherwise", () => {
    const f = costRatesFingerprint(rates);
    expect(costRatesFingerprint({ ...rates })).toBe(f);
    expect(costRatesFingerprint({ ...rates, currency: "EUR" })).not.toBe(f);
    expect(costRatesFingerprint({ ...rates, ratePerMinute: 0.02 })).not.toBe(f);
    expect(costRatesFingerprint({ ...rates, runnerRates: [] })).not.toBe(f);
  });
});
