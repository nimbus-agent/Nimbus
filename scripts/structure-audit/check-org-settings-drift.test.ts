import { describe, expect, test } from "bun:test";

import {
  buildJqProjection,
  type DesiredValues,
  decideExit,
  diffOrgSettings,
  loadOrgAccess,
  ORG_SETTING_SOURCES,
  type SourceOutcome,
} from "./check-org-settings-drift.ts";

const DESIRED: DesiredValues = {
  members_can_create_repositories: false,
  default_repository_permission: "none",
};

const ok = (label: string): SourceOutcome => ({ label, status: "read", errors: [] });
const drift = (label: string, ...errors: string[]): SourceOutcome => ({
  label,
  status: "read",
  errors,
});

describe("diffOrgSettings", () => {
  test("passes when live matches desired", () => {
    const result = diffOrgSettings(DESIRED, {
      members_can_create_repositories: false,
      default_repository_permission: "none",
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("flags a reverted boolean setting", () => {
    const result = diffOrgSettings(DESIRED, {
      members_can_create_repositories: true,
      default_repository_permission: "none",
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("members_can_create_repositories");
    expect(result.errors[0]).toContain("expected false");
    expect(result.errors[0]).toContain("got true");
  });

  test("flags a reverted string setting", () => {
    const result = diffOrgSettings(DESIRED, {
      members_can_create_repositories: false,
      default_repository_permission: "read",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("default_repository_permission");
    expect(result.errors.join("\n")).toContain("read");
  });

  test("flags a non-object live response", () => {
    const result = diffOrgSettings(DESIRED, null);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("not an object");
  });

  test("flags a missing field", () => {
    const result = diffOrgSettings(DESIRED, { members_can_create_repositories: false });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("default_repository_permission");
  });

  test("diffs an Actions-endpoint block with the same code path", () => {
    // sha_pinning_required is the reason this gate grew past GET /orgs/{org}:
    // it is a single UI toggle and the only real-time unpinned-`uses:` control
    // on the repos outside the weekly sha-pins matrix.
    const result = diffOrgSettings({ sha_pinning_required: true }, { sha_pinning_required: false });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("sha_pinning_required");
    expect(result.errors[0]).toContain("expected true");
  });
});

describe("buildJqProjection", () => {
  test("projects the declared keys", () => {
    expect(
      buildJqProjection(["default_workflow_permissions", "can_approve_pull_request_reviews"]),
    ).toBe("{default_workflow_permissions, can_approve_pull_request_reviews}");
    expect(buildJqProjection(["sha_pinning_required"])).toBe("{sha_pinning_required}");
  });

  test("rejects a key that could inject jq", () => {
    expect(() => buildJqProjection(["ok_key", "x} | env | {y"])).toThrow("invalid setting key");
  });

  test("rejects an empty block", () => {
    expect(() => buildJqProjection([])).toThrow("no keys declared");
  });
});

describe("decideExit", () => {
  test("green when every source read clean", () => {
    const result = decideExit({
      outcomes: [ok("org"), ok("actions/permissions")],
      strict: true,
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("OK (2 sources)");
  });

  test("red on drift, and names the source", () => {
    const result = decideExit({
      outcomes: [
        ok("org"),
        drift("actions/permissions", "sha_pinning_required: expected true, got false"),
      ],
      strict: true,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("actions/permissions: sha_pinning_required");
  });

  test("drift on a readable source survives another source being unreadable", () => {
    // The load-bearing rule: a 403 on one endpoint must never swallow real
    // drift found on another.
    const result = decideExit({
      outcomes: [
        drift("org", "two_factor_requirement_enabled: expected true, got false"),
        { label: "actions/permissions/workflow", status: "indeterminate", errors: [] },
      ],
      strict: true,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("two_factor_requirement_enabled");
    expect(result.message).toContain("WARNING — could not read: actions/permissions/workflow");
  });

  test("a 404 on a declared endpoint is a finding, not a skip", () => {
    const result = decideExit({
      outcomes: [
        ok("org"),
        { label: "actions/permissions/fork-pr-contributor-approval", status: "absent", errors: [] },
      ],
      strict: true,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("declared but absent");
  });

  test("partial read with no drift is green, with the gap named", () => {
    const result = decideExit({
      outcomes: [ok("org"), { label: "actions/permissions", status: "indeterminate", errors: [] }],
      strict: true,
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("OK (1 sources)");
    expect(result.message).toContain("could not read actions/permissions");
  });

  test("nothing readable is a soft skip locally", () => {
    const result = decideExit({
      outcomes: [
        { label: "org", status: "indeterminate", errors: [] },
        { label: "actions/permissions", status: "indeterminate", errors: [] },
      ],
      strict: false,
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("::warning::");
  });

  test("nothing readable is a hard failure in the sweep", () => {
    const result = decideExit({
      outcomes: [{ label: "org", status: "indeterminate", errors: [] }],
      strict: true,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("::error::");
  });
});

describe("ORG_SETTING_SOURCES <-> .github/org-access.json", () => {
  const file = loadOrgAccess(process.cwd());

  test("every source resolves to a non-empty declared block", () => {
    for (const source of ORG_SETTING_SOURCES) {
      const block = source.select(file);
      expect(Object.keys(block).length, `${source.label} declares no keys`).toBeGreaterThan(0);
    }
  });

  test("every declared key projects into a valid jq program", () => {
    for (const source of ORG_SETTING_SOURCES) {
      expect(() => buildJqProjection(Object.keys(source.select(file)))).not.toThrow();
    }
  });

  test("the settings the audit called out are all gated", () => {
    // Named explicitly so removing one from org-access.json fails here rather
    // than silently shrinking the gate's coverage back down.
    expect(Object.keys(file.settings)).toEqual(
      expect.arrayContaining([
        "members_can_create_repositories",
        "members_can_create_public_repositories",
        "members_can_create_private_repositories",
        "default_repository_permission",
        "two_factor_requirement_enabled",
        "members_can_fork_private_repositories",
      ]),
    );
    expect(file.actions.permissions["sha_pinning_required"]).toBe(true);
    expect(file.actions.workflow["default_workflow_permissions"]).toBe("read");
    expect(file.actions.fork_pr_contributor_approval["approval_policy"]).toBeTypeOf("string");
  });

  test("no endpoint carries a leading slash", () => {
    // gh on Git Bash rewrites `/orgs/...` into a filesystem path and the call
    // fails as "invalid API endpoint" — which classifies as indeterminate, i.e.
    // a silently unwatched setting.
    for (const source of ORG_SETTING_SOURCES) {
      expect(source.endpoint.startsWith("/")).toBe(false);
    }
  });
});
