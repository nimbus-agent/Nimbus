import { describe, expect, test } from "bun:test";

import type { JenkinsAgentCost } from "../config/cost-jenkins-toml.ts";
import { COST_AGENT_DAY_MINUTES, splitAgentMachineCost } from "./cost-agent-split.ts";
import { type CostLine, tagOf } from "./cost-line.ts";

const DAY = "2026-11-20";
const AWS: JenkinsAgentCost = { agent: "big", provider: "aws", resource: "i-0abc*" };

function cloud(over: Partial<CostLine> = {}): CostLine {
  return {
    source: "aws_billing",
    provider: "aws",
    billingAccountId: "111",
    billingPeriod: "2026-11",
    chargeDay: DAY,
    subAccountId: null,
    subAccountName: null,
    serviceName: "Amazon EC2",
    serviceCategory: null,
    regionId: null,
    resourceId: "i-0abc123",
    resourceName: null,
    skuId: null,
    chargeCategory: "usage",
    billedCost: 14.4,
    effectiveCost: null,
    currency: "USD",
    tags: {},
    repo: null,
    workflow: null,
    model: null,
    importId: "x",
    ...over,
  };
}

function build(repo: string, minutes: number, over: Partial<CostLine> = {}): CostLine {
  return {
    ...cloud({
      source: "jenkins_billing",
      provider: "jenkins",
      serviceName: "Jenkins builds",
      resourceId: null,
      resourceName: "big",
      subAccountId: repo,
      repo,
      billedCost: 0,
      tags: { rate_key: "cloud:big", cloud_resource: "i-0abc*", team: repo },
    }),
    consumedQuantity: minutes,
    consumedUnit: "minute",
    priced: false,
    ...over,
  };
}

const sum = (ls: readonly CostLine[], currency = "USD"): number =>
  ls.filter((l) => l.currency === currency).reduce((a, l) => a + l.billedCost, 0);

describe("splitAgentMachineCost", () => {
  test("two builds split by minutes over a 1440-minute day; the rest is idle, tagged", () => {
    const c = cloud();
    const r = splitAgentMachineCost([c, build("app", 144), build("api", 288)], [AWS]);
    const byRepo = new Map(r.lines.map((l) => [l.repo, l]));
    expect(byRepo.get("app")?.billedCost).toBeCloseTo(1.44, 9);
    expect(byRepo.get("api")?.billedCost).toBeCloseTo(2.88, 9);
    expect(byRepo.get("app")?.priced).toBe(true);
    expect(tagOf(byRepo.get("app")?.tags ?? {}, "team")).toBe("app");
    const idle = r.lines.find((l) => tagOf(l.tags, "idle") === "true");
    expect(idle?.billedCost).toBeCloseTo(14.4 * (1 - 432 / COST_AGENT_DAY_MINUTES), 9);
    expect(idle?.resourceId).toBe("i-0abc123");
    expect(r.lines).toHaveLength(3);
    expect(Math.abs(sum(r.lines) - 14.4)).toBeLessThan(1e-9);
    expect(r.notes).toEqual([]);
  });

  test("more than 1440 build minutes (concurrent builds): shares by m/M, no idle", () => {
    const r = splitAgentMachineCost([cloud(), build("app", 1440), build("api", 1440)], [AWS]);
    expect(r.lines.map((l) => [l.repo, l.billedCost])).toEqual([
      ["app", 7.2],
      ["api", 7.2],
    ]);
    expect(r.lines.some((l) => tagOf(l.tags, "idle") !== undefined)).toBe(false);
    expect(Math.abs(sum(r.lines) - 14.4)).toBeLessThan(1e-9);
  });

  test("a day with no builds leaves the cloud line whole and untagged", () => {
    const other = cloud({ chargeDay: "2026-11-21" });
    const r = splitAgentMachineCost([other, build("app", 60)], [AWS]);
    expect(r.lines).toContainEqual(other);
    expect(tagOf(other.tags, "idle")).toBeUndefined();
    // The build's day has no machine cost: its minutes stay, unpriced, with a note.
    expect(r.lines.find((l) => l.repo === "app")?.priced).toBe(false);
    expect(r.notes.join("\n")).toContain("no aws cost line matched");
  });

  test("money in equals money out per currency, with two currencies on one machine-day", () => {
    const eur = cloud({ currency: "EUR", billedCost: 7, effectiveCost: 6 });
    const lines = [cloud(), eur, build("app", 100), build("api", 500), cloud({ resourceId: "z" })];
    const r = splitAgentMachineCost(lines, [AWS]);
    expect(Math.abs(sum(r.lines, "USD") - sum(lines, "USD"))).toBeLessThan(1e-9);
    expect(Math.abs(sum(r.lines, "EUR") - 7)).toBeLessThan(1e-9);
    const eurApp = r.lines.find((l) => l.repo === "app" && l.currency === "EUR");
    expect(eurApp?.effectiveCost).toBeCloseTo(6 * (100 / 1440), 9);
    expect(r.lines.filter((l) => l.resourceId === "z")).toHaveLength(1);
  });

  test("a machine matched by two agents is split once: the first in config order wins, with a note", () => {
    const second: JenkinsAgentCost = { agent: "small", provider: "aws", resource: "i-0*" };
    const smallBuild = build("web", 60, {
      resourceName: "small",
      tags: { rate_key: "cloud:small", cloud_resource: "i-0*" },
    });
    const r = splitAgentMachineCost([cloud(), build("app", 60), smallBuild], [AWS, second]);
    expect(Math.abs(sum(r.lines) - 14.4)).toBeLessThan(1e-9);
    expect(r.lines.find((l) => l.repo === "app")?.billedCost).toBeCloseTo(0.6, 9);
    expect(r.lines.find((l) => l.repo === "web")?.priced).toBe(false);
    expect(r.notes.join("\n")).toContain("small matches a machine already matched by big");
  });

  test("the glob also matches the resource name, and a provider mismatch never matches", () => {
    const named = cloud({ resourceId: null, resourceName: "i-0abc-name" });
    const wrong = cloud({ provider: "gcp", resourceId: "i-0abc9" });
    const r = splitAgentMachineCost([named, wrong, build("app", 1440)], [AWS]);
    expect(r.lines.find((l) => l.repo === "app")?.billedCost).toBeCloseTo(14.4, 9);
    expect(r.lines).toContainEqual(wrong);
  });

  test("lines with no resource id (Cost Explorer) cannot be matched, and the note says so", () => {
    const ce = cloud({ resourceId: null, resourceName: null });
    const r = splitAgentMachineCost([ce, build("app", 60)], [AWS]);
    expect(r.lines).toContainEqual(ce);
    expect(r.notes.join("\n")).toContain("carry no resource id");
  });

  test("no mapping, or no quantity-only lines: the lines are returned as they are", () => {
    const ls = [cloud(), build("app", 60)];
    expect(splitAgentMachineCost(ls, []).lines).toBe(ls);
    expect(splitAgentMachineCost([cloud()], [AWS]).lines).toHaveLength(1);
  });

  test("an agent no longer in the config keeps its minutes; zero-minute builds split nothing", () => {
    const gone = build("old", 5, { resourceName: "gone", tags: { rate_key: "cloud:gone" } });
    const r = splitAgentMachineCost([cloud(), build("app", 0), gone], [AWS]);
    expect(r.lines.filter((l) => l.source === "aws_billing")).toHaveLength(1);
    expect(r.lines.find((l) => l.repo === "old")?.priced).toBe(false);
  });
});
