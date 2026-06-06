import { describe, expect, test } from "bun:test";

import { filterFluxResources } from "../src/search-filter.ts";

function res(over: {
  name?: string;
  namespace?: string;
  readyReason?: string;
  readyMessage?: string;
  conditions?: unknown;
}): Record<string, unknown> {
  const conditions =
    over.conditions === undefined
      ? [
          {
            type: "Ready",
            status: "True",
            reason: over.readyReason ?? "ReconciliationSucceeded",
            message: over.readyMessage ?? "Applied revision: main@sha1:abc",
          },
        ]
      : over.conditions;
  return {
    metadata: { name: over.name ?? "podinfo", namespace: over.namespace ?? "flux-system" },
    status: { conditions },
  };
}

describe("filterFluxResources", () => {
  test("matches against metadata.name (case-insensitive)", () => {
    expect(filterFluxResources([res({})], { query: "PODINFO" })).toHaveLength(1);
  });

  test("matches against metadata.namespace", () => {
    expect(
      filterFluxResources([res({ namespace: "team-payments" })], { query: "payments" }),
    ).toHaveLength(1);
  });

  test("matches against the Ready condition reason", () => {
    expect(
      filterFluxResources([res({ readyReason: "BuildFailed" })], { query: "buildfailed" }),
    ).toHaveLength(1);
  });

  test("matches against the Ready condition message", () => {
    expect(
      filterFluxResources([res({ readyMessage: "kustomize build failed" })], {
        query: "kustomize",
      }),
    ).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterFluxResources([res({})], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterFluxResources([null, 42, "x", res({})], { query: "podinfo" })).toHaveLength(1);
  });

  test("tolerates missing status / conditions without throwing", () => {
    const bare = { metadata: { name: "lonely-ks" } };
    expect(filterFluxResources([bare], { query: "lonely" })).toHaveLength(1);
    expect(filterFluxResources([bare], { query: "ReconciliationSucceeded" })).toHaveLength(0);
  });

  test("ignores non-Ready conditions in the haystack", () => {
    const onlyHealthy = res({
      conditions: [{ type: "Healthy", status: "True", reason: "HealthCheckPassed", message: "ok" }],
    });
    expect(filterFluxResources([onlyHealthy], { query: "healthcheckpassed" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => res({ name: `ks-${String(i)}` }));
    expect(filterFluxResources(many, { query: "ks-", limit: 3 })).toHaveLength(3);
  });
});
