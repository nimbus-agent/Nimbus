import { describe, expect, test } from "bun:test";
import { DRY_RUN_LABEL, PREDICTABLE_TOOLS, predictOutcome } from "./dry-run-predict.ts";

describe("predictOutcome", () => {
  test("a LaunchDarkly toggle predicts a change, or no change when the flag is already there", () => {
    expect(predictOutcome("launchdarkly_flag_toggle", { on: false }, { on: "true" })).toEqual({
      verdict: "would_change",
      text: "on: true -> false",
    });
    expect(predictOutcome("launchdarkly_flag_toggle", { on: true }, { on: "true" }).verdict).toBe(
      "no_change",
    );
    expect(predictOutcome("launchdarkly_flag_toggle", {}, { on: "true" }).verdict).toBe(
      "uncertain",
    );
    expect(predictOutcome("launchdarkly_flag_toggle", { on: true }, { on: "maybe" }).verdict).toBe(
      "none",
    );
  });

  test("a Flagsmith set compares enabled, and a set value makes it uncertain", () => {
    expect(
      predictOutcome("flagsmith_feature_state_set", { enabled: true }, { enabled: "false" }),
    ).toEqual({ verdict: "would_change", text: "enabled: false -> true" });
    const withValue = predictOutcome(
      "flagsmith_feature_state_set",
      { enabled: true, value: "x" },
      { enabled: "false" },
    );
    expect(withValue.verdict).toBe("uncertain");
    expect(withValue.text).toContain("is not compared");
    expect(
      predictOutcome("flagsmith_feature_state_set", { enabled: true, value: "x" }, {}).verdict,
    ).toBe("none");
  });

  test("EC2 stop and start: the opposite state changes, a settled state does not, anything else is uncertain", () => {
    expect(predictOutcome("aws_ec2_instance_stop", {}, { state: "running" })).toEqual({
      verdict: "would_change",
      text: "instance state: running -> stopping",
    });
    expect(predictOutcome("aws_ec2_instance_stop", {}, { state: "stopped" }).verdict).toBe(
      "no_change",
    );
    expect(predictOutcome("aws_ec2_instance_start", {}, { state: "stopped" }).verdict).toBe(
      "would_change",
    );
    expect(predictOutcome("aws_ec2_instance_start", {}, { state: "pending" }).verdict).toBe(
      "no_change",
    );
    expect(predictOutcome("aws_ec2_instance_start", {}, { state: "shutting-down" }).verdict).toBe(
      "uncertain",
    );
    expect(predictOutcome("aws_ec2_instance_start", {}, {}).verdict).toBe("none");
  });

  test("an ECS update compares the task definition", () => {
    expect(
      predictOutcome(
        "aws_ecs_service_update",
        { taskDefinition: "td:2" },
        { taskDefinition: "td:1" },
      ),
    ).toEqual({ verdict: "would_change", text: "task definition: td:1 -> td:2" });
    expect(
      predictOutcome(
        "aws_ecs_service_update",
        { taskDefinition: "td:1" },
        { taskDefinition: "td:1" },
      ).verdict,
    ).toBe("no_change");
    expect(predictOutcome("aws_ecs_service_update", {}, { taskDefinition: "td:1" }).verdict).toBe(
      "uncertain",
    );
    expect(predictOutcome("aws_ecs_service_update", { taskDefinition: "td:1" }, {}).verdict).toBe(
      "none",
    );
  });

  test("an Argo CD rollback names the current history and the target, and is uncertain when Argo would refuse", () => {
    const cap = { currentHistoryId: "9", autoSync: "off", historyIds: "9,8,7" };
    const p = predictOutcome("argocd_app_rollback", { name: "web", id: 7 }, cap);
    expect(p.verdict).toBe("would_change");
    expect(p.text).toBe("the application moves from history 9 back to the revision of history 7");
    expect(predictOutcome("argocd_app_rollback", { name: "web", id: 9 }, cap).verdict).toBe(
      "no_change",
    );
    expect(predictOutcome("argocd_app_rollback", { name: "web" }, cap).verdict).toBe("uncertain");
    expect(predictOutcome("argocd_app_rollback", { id: 7 }, {}).verdict).toBe("none");
    const auto = predictOutcome("argocd_app_rollback", { id: 7 }, { ...cap, autoSync: "on" });
    expect(auto).toEqual({
      verdict: "uncertain",
      text: "auto-sync is on: Argo CD refuses a rollback while it is on",
    });
    expect(predictOutcome("argocd_app_rollback", { id: 3 }, cap).text).toContain(
      "no longer in the application's retained history",
    );
    expect(
      predictOutcome("argocd_app_rollback", { id: 7 }, { currentHistoryId: "9" }).verdict,
    ).toBe("uncertain");
  });

  test("an unpredictable tool, a failed read or a non-object input never claims a change", () => {
    expect(predictOutcome("pd_incident_acknowledge", { incidentId: "P1" }, {}).verdict).toBe(
      "none",
    );
    expect(predictOutcome("launchdarkly_flag_toggle", { on: true }, undefined).verdict).toBe(
      "none",
    );
    expect(predictOutcome("launchdarkly_flag_toggle", [true], { on: "true" }).verdict).toBe(
      "uncertain",
    );
    expect(predictOutcome("launchdarkly_flag_toggle", null, { on: "true" }).verdict).toBe(
      "uncertain",
    );
  });

  test("every predictable tool is deterministic, and the label never claims a provider simulation", () => {
    for (const tool of PREDICTABLE_TOOLS) {
      const a = predictOutcome(tool, { on: true }, { on: "false", state: "running" });
      const b = predictOutcome(tool, { on: true }, { on: "false", state: "running" });
      expect(a).toEqual(b);
    }
    expect(DRY_RUN_LABEL).toContain("not asked to simulate");
  });
});
