// packages/gateway/src/connectors/lazy-mesh/iac-tool-profile.test.ts
// The tools the IaC runner executes, and the per-run profile each runs under (OR-S4-DRIFT added the
// refresh-only pair to the plan and apply profiles; the CloudFormation reads joined the cfn one).
import { describe, expect, test } from "bun:test";
import { CFN_READ_TOOLS, IAC_TOOL_PROFILE } from "./iac-runner.ts";

describe("IAC_TOOL_PROFILE", () => {
  test("is the fourteen tools the runner executes", () => {
    expect(Object.keys(IAC_TOOL_PROFILE).sort()).toEqual([
      "iac_cloudformation_changeset_create",
      "iac_cloudformation_changeset_discard",
      "iac_cloudformation_changeset_get",
      "iac_cloudformation_changesets_list",
      "iac_cloudformation_deploy",
      "iac_cloudformation_stack_get",
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

  test("the three CloudFormation reads run in the cfn profile, as reads (no scratch directory)", () => {
    for (const id of [
      "iac_cloudformation_stack_get",
      "iac_cloudformation_changesets_list",
      "iac_cloudformation_changeset_get",
    ]) {
      expect(IAC_TOOL_PROFILE[id]).toBe("cfn");
      expect(CFN_READ_TOOLS.has(id)).toBe(true);
    }
    for (const write of [
      "iac_cloudformation_changeset_create",
      "iac_cloudformation_changeset_discard",
      "iac_cloudformation_deploy",
    ]) {
      expect(CFN_READ_TOOLS.has(write)).toBe(false);
    }
  });
});
