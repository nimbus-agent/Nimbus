import { describe, expect, test } from "bun:test";

import { DEFAULT_COST_JENKINS_CONFIG } from "./cost-jenkins-toml.ts";
import { resolveCostConfig } from "./cost-toml.ts";
import { mergeLayerDocs, parseLayerDoc } from "./layered-merge.ts";

const base = (text: string) =>
  resolveCostConfig(
    mergeLayerDocs([parseLayerDoc({ kind: "base", id: "base", path: "/x/0" }, text)]).sections,
  );
const jenkins = (body: string) => base(`[cost.jenkins]\n${body}\n`);

describe("[cost.jenkins]", () => {
  test("absent: not enabled, nothing is synced", () => {
    expect(base("").jenkins).toEqual(DEFAULT_COST_JENKINS_CONFIG);
    expect(base("").jenkins.enabled).toBe(false);
  });

  test("an empty table enables the sync with no rate", () => {
    expect(jenkins("").jenkins).toEqual({
      enabled: true,
      ratePerMinute: null,
      currency: "USD",
      agentRates: [],
    });
  });

  test("a rate, a currency and agent rates (sorted)", () => {
    const c = jenkins(
      'rate_per_minute = 0.008\ncurrency = "EUR"\nagent_rates = { "z-agent" = 0.02, "built-in" = 0 }',
    );
    expect(c.error).toBeNull();
    expect(c.jenkins).toEqual({
      enabled: true,
      ratePerMinute: 0.008,
      currency: "EUR",
      agentRates: [
        ["built-in", 0],
        ["z-agent", 0.02],
      ],
    });
  });

  test.each([
    ["rate_per_minute = -1"],
    ["rate_per_minute = 5000"],
    ['rate_per_minute = "1"'],
    ['currency = "usd"'],
    ["agent_rates = 3"],
    ["agent_rates = { a = -1 }"],
    ['agent_rates = { " " = 1 }'],
    ["label_rates = { a = 1 }"],
  ])("%s refuses the cost config", (body) => {
    expect(jenkins(body).error).not.toBeNull();
  });

  test("more than 500 agents is refused", () => {
    const many = Array.from({ length: 501 }, (_, i) => `"a${String(i)}" = 1`).join(", ");
    expect(jenkins(`agent_rates = { ${many} }`).error).not.toBeNull();
  });
});
