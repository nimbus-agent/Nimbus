// packages/gateway/src/connectors/lazy-mesh/iac-tool-profile.test.ts
// The tools the IaC runner executes, and the per-run profile each runs under (OR-S4-DRIFT added the
// refresh-only pair to the plan and apply profiles).
import { describe, expect, test } from "bun:test";
import { IAC_TOOL_PROFILE } from "./iac-runner.ts";

describe("IAC_TOOL_PROFILE", () => {
  test("is the eleven tools the runner executes", () => {
    expect(Object.keys(IAC_TOOL_PROFILE).sort()).toEqual([
      "iac_cloudformation_changeset_create",
      "iac_cloudformation_changeset_discard",
      "iac_cloudformation_deploy",
      "iac_terraform_apply",
      "iac_terraform_apply_refresh_only",
      "iac_terraform_destroy",
      "iac_terraform_destroy_plan",
      "iac_terraform_init",
      "iac_terraform_plan",
      "iac_terraform_plan_refresh_only",
      "iac_terraform_show_json",
    ]);
  });

  test("a refresh-only plan runs as a plan and its apply as an apply; show renders any plan", () => {
    expect(IAC_TOOL_PROFILE["iac_terraform_plan_refresh_only"]).toBe("plan");
    expect(IAC_TOOL_PROFILE["iac_terraform_apply_refresh_only"]).toBe("apply");
    expect(IAC_TOOL_PROFILE["iac_terraform_show_json"]).toBe("show");
  });

  test("the init runs in its own profile (connectors 0.21.0)", () => {
    expect(IAC_TOOL_PROFILE["iac_terraform_init"]).toBe("init");
  });
});
