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

  test("skips non-objectish entries inside the conditions array", () => {
    // null, 42, and "str" are non-object — asRecord(entry) returns undefined → continue
    // "Ready" object must still be found after skipping
    const mixed: Record<string, unknown> = {
      metadata: { name: "ks-mixed", namespace: "default" },
      status: {
        conditions: [
          null,
          42,
          "str",
          { type: "Ready", status: "True", reason: "Applied", message: "ok" },
        ],
      },
    };
    // matches on the Ready reason "Applied"
    expect(filterFluxResources([mixed], { query: "applied" })).toHaveLength(1);
  });

  test("Ready condition with non-string reason falls back to empty string", () => {
    // reason is a number → typeof c["reason"] === "string" is false → "" used
    const withNumericReason: Record<string, unknown> = {
      metadata: { name: "ks-nr", namespace: "default" },
      status: {
        conditions: [{ type: "Ready", status: "True", reason: 99, message: "success" }],
      },
    };
    // "success" is the message so it should match
    expect(filterFluxResources([withNumericReason], { query: "success" })).toHaveLength(1);
    // "99" is not in the haystack because reason fell back to ""
    expect(filterFluxResources([withNumericReason], { query: "99" })).toHaveLength(0);
  });

  test("Ready condition with non-string message falls back to empty string", () => {
    // message is null → typeof c["message"] === "string" is false → "" used
    const withNullMessage: Record<string, unknown> = {
      metadata: { name: "ks-nm", namespace: "default" },
      status: {
        conditions: [{ type: "Ready", status: "True", reason: "Reconciled", message: null }],
      },
    };
    // "reconciled" (reason) matches
    expect(filterFluxResources([withNullMessage], { query: "reconciled" })).toHaveLength(1);
    // confirm null did not end up in haystack as a string
    expect(filterFluxResources([withNullMessage], { query: "null" })).toHaveLength(0);
  });

  test("metadata.name is not a string — falls back to empty string in the haystack", () => {
    // nestedString leaf is not a string → returns ""
    const numericName: Record<string, unknown> = {
      metadata: { name: 123, namespace: "fallback-ns" },
      status: { conditions: [] },
    };
    // matches on namespace
    expect(filterFluxResources([numericName], { query: "fallback-ns" })).toHaveLength(1);
    // "123" is not in haystack because nestedString returned ""
    expect(filterFluxResources([numericName], { query: "123" })).toHaveLength(0);
  });

  test("metadata is not an object — nestedString returns empty for name and namespace", () => {
    // asRecord of a string returns undefined → nestedString returns "" for both paths
    const nonObjectMeta: Record<string, unknown> = {
      metadata: "broken",
      status: { conditions: [{ type: "Ready", reason: "Synced", message: "done" }] },
    };
    // matches on the Ready condition text
    expect(filterFluxResources([nonObjectMeta], { query: "synced" })).toHaveLength(1);
    // "broken" is not in haystack
    expect(filterFluxResources([nonObjectMeta], { query: "broken" })).toHaveLength(0);
  });
});
