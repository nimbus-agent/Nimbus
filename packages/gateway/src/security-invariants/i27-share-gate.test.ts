import { describe, expect, test } from "bun:test";

describe("I27 — outbound share gated by share.publish HITL action", () => {
  test("HITL_REQUIRED includes share.publish", async () => {
    const { HITL_REQUIRED } = await import("../engine/executor.ts");
    expect(HITL_REQUIRED.has("share.publish")).toBe(true);
  });

  // Replay executes tool calls named by an untrusted share file against the owner's live
  // credentialed mesh, so the read-only classifier is a security boundary and not a convenience.
  // It classifies by NAME: `iac_pulumi_preview` once matched the `preview` verb, and it runs
  // `pulumi preview --cwd <caller-supplied directory>`, which EVALUATES the stack program there.
  // Re-adding any verb that a process-spawning tool can carry reopens that path.
  test("the replay read-only classifier admits no process-spawning tool", async () => {
    const { isReadOnlyToolId } = await import("../share/read-tool-registry.ts");
    for (const id of [
      "iac_terraform_plan",
      "iac_terraform_destroy_plan",
      "iac_terraform_show_json",
      "iac_terraform_apply",
      "iac_terraform_destroy",
      "iac_cloudformation_changeset_create",
      "iac_cloudformation_changeset_discard",
      "iac_cloudformation_deploy",
      "iac_pulumi_preview",
      "iac_pulumi_up",
      "k8s_manifest_plan",
      "k8s_manifest_apply",
    ]) {
      expect(isReadOnlyToolId(id)).toBe(false);
    }
  });
});
