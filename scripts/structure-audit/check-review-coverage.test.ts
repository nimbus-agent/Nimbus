import { describe, expect, test } from "bun:test";

import {
  classifyRepoRead,
  diffReviewCoverage,
  EXEMPT_REPOS,
  type LiveConfig,
  parseConfig,
} from "./check-review-coverage.ts";

/** A config that passes every check — the base each case mutates one field of. */
function goodConfig(): Record<string, unknown> {
  return {
    language: "en-US",
    reviews: {
      profile: "chill",
      auto_review: { enabled: true, drafts: false, base_branches: ["main"] },
      path_instructions: [{ path: "src/**/*.ts", instructions: "long enough guidance" }],
    },
  };
}

const REPOS = ["Nimbus", "nimbus-sdk"];

function live(overrides: Record<string, LiveConfig> = {}): Record<string, LiveConfig> {
  return { Nimbus: goodConfig(), "nimbus-sdk": goodConfig(), ...overrides };
}

describe("diffReviewCoverage", () => {
  test("passes when every repo has a present, parseable, active config", () => {
    const r = diffReviewCoverage(REPOS, live());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("flags an absent config", () => {
    const r = diffReviewCoverage(REPOS, live({ "nimbus-sdk": null }));
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(["nimbus-sdk: no .coderabbit.yaml"]);
  });

  test("a repo missing from the live map is absent, not silently skipped", () => {
    // Guards the `undefined` branch: a read loop that never wrote a key must not
    // read as covered.
    const r = diffReviewCoverage(REPOS, { Nimbus: goodConfig() });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(["nimbus-sdk: no .coderabbit.yaml"]);
  });

  test("flags an unparseable config distinctly from an absent one", () => {
    const r = diffReviewCoverage(REPOS, live({ Nimbus: "unparseable" }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("not valid YAML");
    // The distinction is the point: the repair differs.
    expect(r.errors[0]).not.toContain("no .coderabbit.yaml");
  });

  test("flags a config with no reviews section", () => {
    const r = diffReviewCoverage(REPOS, live({ Nimbus: { language: "en-US" } }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("no `reviews` section");
  });

  test("flags auto_review.enabled: false — present but inert", () => {
    const cfg = goodConfig();
    (cfg["reviews"] as Record<string, unknown>)["auto_review"] = {
      enabled: false,
      base_branches: ["main"],
    };
    const r = diffReviewCoverage(REPOS, live({ Nimbus: cfg }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("inert"))).toBe(true);
  });

  test("a missing `enabled` key is not treated as enabled", () => {
    // `!== true` rather than `=== false`: an absent key must fail closed.
    const cfg = goodConfig();
    (cfg["reviews"] as Record<string, unknown>)["auto_review"] = { base_branches: ["main"] };
    const r = diffReviewCoverage(REPOS, live({ Nimbus: cfg }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("inert"))).toBe(true);
  });

  test("flags base_branches that does not cover main", () => {
    const cfg = goodConfig();
    (cfg["reviews"] as Record<string, unknown>)["auto_review"] = {
      enabled: true,
      base_branches: ["develop"],
    };
    const r = diffReviewCoverage(REPOS, live({ Nimbus: cfg }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("base_branches"))).toBe(true);
  });

  test("flags a missing auto_review block", () => {
    const cfg = goodConfig();
    // biome-ignore lint/performance/noDelete: exercising the absent-key path
    delete (cfg["reviews"] as Record<string, unknown>)["auto_review"];
    const r = diffReviewCoverage(REPOS, live({ Nimbus: cfg }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("not reviewed automatically"))).toBe(true);
  });

  test("flags empty path_instructions", () => {
    const cfg = goodConfig();
    (cfg["reviews"] as Record<string, unknown>)["path_instructions"] = [];
    const r = diffReviewCoverage(REPOS, live({ Nimbus: cfg }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("path_instructions"))).toBe(true);
  });

  test("reports every failing repo, not just the first", () => {
    const r = diffReviewCoverage(REPOS, { Nimbus: null, "nimbus-sdk": null });
    expect(r.errors).toHaveLength(2);
  });

  test("does not check instruction CONTENT — repos are different products", () => {
    // A deliberately terse instruction is still a pass here; content is the
    // owning repo's local test's job.
    const cfg = goodConfig();
    (cfg["reviews"] as Record<string, unknown>)["path_instructions"] = [
      { path: "src/**", instructions: "x" },
    ];
    expect(diffReviewCoverage(REPOS, live({ Nimbus: cfg })).ok).toBe(true);
  });
});

describe("parseConfig", () => {
  test("parses a mapping", () => {
    expect(parseConfig("language: en-US\n")).toEqual({ language: "en-US" });
  });

  test("invalid YAML is unparseable, not a throw", () => {
    expect(parseConfig("reviews:\n  - a\n bad indent: [")).toBe("unparseable");
  });

  test("a scalar document is unparseable — it is not a usable config", () => {
    expect(parseConfig("just a string")).toBe("unparseable");
  });

  test("a list document is unparseable", () => {
    expect(parseConfig("- a\n- b\n")).toBe("unparseable");
  });

  test("an empty document is unparseable rather than an empty pass", () => {
    expect(parseConfig("")).toBe("unparseable");
  });
});

describe("classifyRepoRead", () => {
  test("a successful read is `read`", () => {
    expect(classifyRepoRead({ ok: true, stdout: "x", stderr: "" }).kind).toBe("read");
  });

  test("404 is `absent` — a real finding", () => {
    expect(classifyRepoRead({ ok: false, stdout: "", stderr: "", httpStatus: 404 }).kind).toBe(
      "absent",
    );
  });

  test("5xx is `indeterminate`, never absence", () => {
    // The failure mode this prevents: a blip reported as "repo lost its config".
    expect(classifyRepoRead({ ok: false, stdout: "", stderr: "", httpStatus: 503 }).kind).toBe(
      "indeterminate",
    );
  });

  test("an unknown status is `indeterminate`", () => {
    expect(classifyRepoRead({ ok: false, stdout: "", stderr: "" }).kind).toBe("indeterminate");
  });
});

describe("exemptions", () => {
  test("awesome-nimbus is exempt with a stated reason", () => {
    // Recorded so the next reader can tell "decided" from "forgotten".
    expect(EXEMPT_REPOS["awesome-nimbus"]).toContain("no source tree");
  });

  test("every exemption carries a non-empty reason", () => {
    for (const [repo, reason] of Object.entries(EXEMPT_REPOS)) {
      expect(reason.length, `${repo} needs a reason`).toBeGreaterThan(10);
    }
  });
});
