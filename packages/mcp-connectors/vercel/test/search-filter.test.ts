import { describe, expect, test } from "bun:test";

import { filterVercelDeployments } from "../src/search-filter.ts";

function deployment(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: "dpl_abc123",
    name: "my-app",
    state: "READY",
    target: "production",
    url: "my-app-abc123.vercel.app",
    meta: { githubCommitMessage: "Fix the redesigned checkout flow" },
    ...over,
  };
}

describe("filterVercelDeployments", () => {
  test("matches against project name (case-insensitive)", () => {
    expect(filterVercelDeployments([deployment()], { query: "MY-APP" })).toHaveLength(1);
  });

  test("matches against uid, state, target, url, and commit message", () => {
    expect(filterVercelDeployments([deployment()], { query: "dpl_abc" })).toHaveLength(1);
    expect(filterVercelDeployments([deployment()], { query: "ready" })).toHaveLength(1);
    expect(filterVercelDeployments([deployment()], { query: "production" })).toHaveLength(1);
    expect(filterVercelDeployments([deployment()], { query: "vercel.app" })).toHaveLength(1);
    expect(filterVercelDeployments([deployment()], { query: "checkout" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterVercelDeployments([deployment()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(
      filterVercelDeployments([null, 42, "x", deployment()], { query: "my-app" }),
    ).toHaveLength(1);
  });

  test("tolerates a missing meta object", () => {
    const noMeta = deployment();
    delete noMeta["meta"];
    expect(filterVercelDeployments([noMeta], { query: "my-app" })).toHaveLength(1);
    expect(filterVercelDeployments([noMeta], { query: "checkout" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => deployment({ uid: `dpl_${String(i)}` }));
    expect(filterVercelDeployments(many, { query: "my-app", limit: 3 })).toHaveLength(3);
  });
});
