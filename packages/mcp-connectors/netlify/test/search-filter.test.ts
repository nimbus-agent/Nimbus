import { describe, expect, test } from "bun:test";

import { filterNetlifySites } from "../src/search-filter.ts";

function site(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "site_abc123",
    name: "my-app",
    url: "http://my-app.netlify.app",
    ssl_url: "https://my-app.netlify.app",
    build_settings: { repo_url: "https://github.com/acme/my-app", repo_branch: "main" },
    published_deploy: {
      state: "ready",
      branch: "main",
      commit_ref: "abcdef1234567890",
      title: "Ship the redesigned checkout flow",
    },
    ...over,
  };
}

describe("filterNetlifySites", () => {
  test("matches against site name (case-insensitive)", () => {
    expect(filterNetlifySites([site()], { query: "MY-APP" })).toHaveLength(1);
  });

  test("matches against id, url, ssl_url, repo, branch, deploy state, and commit ref", () => {
    expect(filterNetlifySites([site()], { query: "site_abc" })).toHaveLength(1);
    expect(filterNetlifySites([site()], { query: "netlify.app" })).toHaveLength(1);
    expect(filterNetlifySites([site()], { query: "github.com/acme" })).toHaveLength(1);
    expect(filterNetlifySites([site()], { query: "main" })).toHaveLength(1);
    expect(filterNetlifySites([site()], { query: "ready" })).toHaveLength(1);
    expect(filterNetlifySites([site()], { query: "abcdef12" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterNetlifySites([site()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterNetlifySites([null, 42, "x", site()], { query: "my-app" })).toHaveLength(1);
  });

  test("tolerates a missing build_settings / published_deploy object", () => {
    const bare = site();
    delete bare["build_settings"];
    delete bare["published_deploy"];
    expect(filterNetlifySites([bare], { query: "my-app" })).toHaveLength(1);
    expect(filterNetlifySites([bare], { query: "ready" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => site({ id: `site_${String(i)}` }));
    expect(filterNetlifySites(many, { query: "my-app", limit: 3 })).toHaveLength(3);
  });
});
