import { describe, expect, test } from "bun:test";

import { type DesiredRuleset, diffRuleset } from "./check-ruleset-drift.ts";

const DESIRED: DesiredRuleset = {
  repos: ["nimbus-client"],
  name: "General",
  target: "branch",
  enforcement: "active",
  pull_request: {
    allowed_merge_methods: ["squash"],
    dismiss_stale_reviews_on_push: true,
    required_review_thread_resolution: true,
    require_code_owner_review: false,
    require_last_push_approval: false,
    required_approving_review_count: 0,
  },
};

function liveRuleset(overrides: Record<string, unknown> = {}) {
  return {
    name: "General",
    target: "branch",
    enforcement: "active",
    rules: [
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: ["squash"],
          dismiss_stale_reviews_on_push: true,
          required_review_thread_resolution: true,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          ...overrides,
        },
      },
    ],
  };
}

describe("diffRuleset", () => {
  test("passes when live matches desired", () => {
    const result = diffRuleset(DESIRED, liveRuleset());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("flags a drifted pull_request parameter", () => {
    const result = diffRuleset(DESIRED, liveRuleset({ required_approving_review_count: 1 }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("required_approving_review_count");
    expect(result.errors[0]).toContain("expected 0");
    expect(result.errors[0]).toContain("got 1");
  });

  test("flags disabled enforcement", () => {
    const live = { ...liveRuleset(), enforcement: "disabled" };
    const result = diffRuleset(DESIRED, live);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("enforcement");
  });

  test("flags a missing ruleset entirely", () => {
    const result = diffRuleset(DESIRED, null);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("no 'General' ruleset");
  });

  test("flags a missing pull_request rule", () => {
    const result = diffRuleset(DESIRED, {
      name: "General",
      target: "branch",
      enforcement: "active",
      rules: [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("pull_request");
  });
});
