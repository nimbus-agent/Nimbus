import { describe, expect, test } from "bun:test";

import {
  type DesiredRuleset,
  decideExit,
  diffRuleset,
  mergeDesired,
  type SharedRuleset,
} from "./check-ruleset-drift.ts";

const SHARED: SharedRuleset = {
  name: "General",
  target: "branch",
  enforcement: "active",
  conditions_ref_include: ["refs/heads/main"],
  required_rule_types: ["deletion", "non_fast_forward", "pull_request"],
  pull_request: {
    allowed_merge_methods: ["squash"],
    dismiss_stale_reviews_on_push: true,
    required_review_thread_resolution: true,
    require_code_owner_review: false,
    require_last_push_approval: false,
    required_approving_review_count: 0,
  },
};

const DESIRED: DesiredRuleset = mergeDesired(SHARED, { bypass_actor_types: [] });

function liveRuleset(overrides: Record<string, unknown> = {}) {
  return {
    name: "General",
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: {
        include: ["refs/heads/main"],
        exclude: [],
      },
    },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
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
    bypass_actors: [] as Array<{ actor_type: string }>,
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
    expect(result.errors.join("\n")).toContain("no pull_request rule present");
  });

  test("passes when conditions + bypass + protection rules all match", () => {
    const desired = mergeDesired(SHARED, { bypass_actor_types: ["OrganizationAdmin"] });
    const live = {
      ...liveRuleset(),
      bypass_actors: [{ actor_type: "OrganizationAdmin" }],
    };
    const result = diffRuleset(desired, live);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("flags a wrong conditions.ref_name.include", () => {
    const live = {
      ...liveRuleset(),
      conditions: { ref_name: { include: ["refs/heads/develop"], exclude: [] } },
    };
    const result = diffRuleset(DESIRED, live);
    expect(result.ok).toBe(false);
    const msg = result.errors.join("\n");
    expect(msg).toContain("conditions.ref_name.include");
    expect(msg).toContain("refs/heads/main");
    expect(msg).toContain("refs/heads/develop");
  });

  test("flags a missing deletion rule", () => {
    const live = liveRuleset();
    live.rules = live.rules.filter((r) => r.type !== "deletion");
    const result = diffRuleset(DESIRED, live);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("missing required rule: deletion");
  });

  test("flags a bypass_actor_types mismatch", () => {
    const desired = mergeDesired(SHARED, { bypass_actor_types: [] });
    const live = {
      ...liveRuleset(),
      bypass_actors: [{ actor_type: "OrganizationAdmin" }],
    };
    const result = diffRuleset(desired, live);
    expect(result.ok).toBe(false);
    const msg = result.errors.join("\n");
    expect(msg).toContain("bypass_actor_types");
    expect(msg).toContain("OrganizationAdmin");
  });

  test("treats a reordered bypass set as a match (order-independent)", () => {
    const desired = mergeDesired(SHARED, {
      bypass_actor_types: ["OrganizationAdmin", "RepositoryAdmin"],
    });
    const live = {
      ...liveRuleset(),
      bypass_actors: [{ actor_type: "RepositoryAdmin" }, { actor_type: "OrganizationAdmin" }],
    };
    const result = diffRuleset(desired, live);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("decideExit", () => {
  test("all repos unreachable → skip green", () => {
    const result = decideExit({
      queried: 0,
      errors: [],
      unreachable: [
        "nimbus-client",
        "nimbus-sdk",
        "nimbus-vscode",
        "nimbus-web-clipper",
        "linux-repo",
      ],
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("skipped");
  });

  test("real drift on a queried repo is never masked by a different repo's gh failure (regression)", () => {
    const result = decideExit({
      queried: 4,
      errors: ["nimbus-sdk: enforcement: expected active, got disabled"],
      unreachable: ["nimbus-vscode"],
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("nimbus-sdk: enforcement: expected active, got disabled");
    expect(result.message).toContain("could not query");
    expect(result.message).toContain("nimbus-vscode");
  });

  test("all repos queried, no drift → OK", () => {
    const result = decideExit({ queried: 5, errors: [], unreachable: [] });
    expect(result.code).toBe(0);
    expect(result.message).toContain("OK (5 repos)");
  });

  test("some repos unreachable but no drift on the queried ones → OK with a warning", () => {
    const result = decideExit({
      queried: 3,
      errors: [],
      unreachable: ["nimbus-vscode", "nimbus-web-clipper"],
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("OK (3 repos)");
    expect(result.message).toContain("could not query");
  });
});
