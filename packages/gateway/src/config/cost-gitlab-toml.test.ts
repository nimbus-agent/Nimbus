import { describe, expect, test } from "bun:test";
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
