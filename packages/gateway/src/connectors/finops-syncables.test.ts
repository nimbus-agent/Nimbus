// The FinOps syncables register in order, and with no options each cost sync reads its empty default (no fetch).
import { describe, expect, test } from "bun:test";
import pino from "pino";

import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import type { Syncable, SyncContext } from "../sync/types.ts";
import { registerFinopsSyncables } from "./finops-syncables.ts";

function registered(options: Parameters<typeof registerFinopsSyncables>[1]): Syncable[] {
  const out: Syncable[] = [];
  registerFinopsSyncables({ register: (s) => out.push(s) }, options);
  return out;
}

const ctx = {
  logger: pino({ level: "silent" }),
  rateLimiter: new ProviderRateLimiter(),
  depth: "full",
  getSharedSecret: () => {
    throw new Error("no secret is read when nothing is configured");
  },
} as unknown as SyncContext;

describe("registerFinopsSyncables", () => {
  test("every FinOps source, in order", () => {
    expect(registered(undefined).map((s) => s.serviceId)).toEqual([
      "vantage",
      "opencost",
      "kubecost",
      "github_billing",
      "openai_billing",
      "anthropic_billing",
      "gitlab_billing",
      "bitbucket_billing",
      "jenkins_billing",
      "aws_billing",
    ]);
  });

  test("with no options, GitHub billing, GitLab minutes and Bitbucket minutes have nothing to sync", async () => {
    const byId = new Map(registered(undefined).map((s) => [s.serviceId, s]));
    for (const id of [
      "github_billing",
      "gitlab_billing",
      "bitbucket_billing",
      "jenkins_billing",
      "aws_billing",
    ]) {
      const r = await byId.get(id)?.sync(ctx, null);
      expect(r?.itemsUpserted ?? 0).toBe(0);
    }
  });

  test("the configured readers are used when given", async () => {
    let read = 0;
    const s = registered({
      maxSeries: () => 5,
      githubOrgs: () => [],
      gitlab: () => {
        read++;
        return { groups: [], ratePerMinute: null, currency: "USD", runnerRates: [] };
      },
    }).find((x) => x.serviceId === "gitlab_billing");
    await s?.sync(ctx, null);
    expect(read).toBe(1);
  });
});
