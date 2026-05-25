import { describe, expect, test } from "bun:test";

import { filterArgocdApplications } from "../src/search-filter.ts";

function app(over: {
  name?: string;
  project?: string;
  repoURL?: string;
  sync?: string;
  health?: string;
}): Record<string, unknown> {
  return {
    metadata: { name: over.name ?? "payments-api" },
    spec: {
      project: over.project ?? "default",
      source: { repoURL: over.repoURL ?? "https://github.com/acme/payments" },
    },
    status: {
      sync: { status: over.sync ?? "Synced" },
      health: { status: over.health ?? "Healthy" },
    },
  };
}

describe("filterArgocdApplications", () => {
  test("matches against metadata.name (case-insensitive)", () => {
    expect(filterArgocdApplications([app({})], { query: "PAYMENTS" })).toHaveLength(1);
  });

  test("matches against spec.project", () => {
    expect(
      filterArgocdApplications([app({ project: "team-billing" })], { query: "billing" }),
    ).toHaveLength(1);
  });

  test("matches against spec.source.repoURL", () => {
    expect(filterArgocdApplications([app({})], { query: "github.com/acme" })).toHaveLength(1);
  });

  test("matches against status.sync.status and status.health.status", () => {
    expect(
      filterArgocdApplications([app({ sync: "OutOfSync" })], { query: "outofsync" }),
    ).toHaveLength(1);
    expect(
      filterArgocdApplications([app({ health: "Degraded" })], { query: "degraded" }),
    ).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterArgocdApplications([app({})], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterArgocdApplications([null, 42, "x", app({})], { query: "payments" })).toHaveLength(
      1,
    );
  });

  test("tolerates missing sub-objects without throwing", () => {
    const bare = { metadata: { name: "lonely-app" } };
    expect(filterArgocdApplications([bare], { query: "lonely" })).toHaveLength(1);
    expect(filterArgocdApplications([bare], { query: "Synced" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => app({ name: `app-${String(i)}` }));
    expect(filterArgocdApplications(many, { query: "app-", limit: 3 })).toHaveLength(3);
  });
});
