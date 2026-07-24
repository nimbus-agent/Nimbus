import { describe, expect, test } from "bun:test";

import { diffOrgSettings, type OrgSettings } from "./check-org-settings-drift.ts";

const DESIRED: OrgSettings = {
  members_can_create_repositories: false,
  default_repository_permission: "none",
};

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
});
