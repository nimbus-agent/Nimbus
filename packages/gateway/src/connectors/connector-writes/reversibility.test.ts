import { describe, expect, test } from "bun:test";
import { predictOutcome } from "./dry-run-predict.ts";

import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import {
  applyReversibility,
  checkReversibilityTable,
  REVERSIBILITY_TABLE,
  type ReversibilityEntry,
  reversibilityClassOf,
} from "./reversibility.ts";
import type { ConnectorWriteRow } from "./types.ts";

const byId = (toolId: string): ConnectorWriteRow => {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === toolId);
  if (r === undefined) throw new Error(`no row ${toolId}`);
  return r;
};

/** A reply the way the connector hands it back (a plain object; the runner accepts that or an MCP result). */
const mcp = (j: unknown) => ({ content: [{ type: "text", text: JSON.stringify(j) }] });

/** Runs the REAL reader on a recorded reply: the capture, and the display select over the same reply. */
function capture(
  toolId: string,
  reply: unknown,
  picked: Record<string, unknown>,
): Record<string, string> {
  const reader = byId(toolId).before;
  if (reader?.captures === undefined) throw new Error(`${toolId} captures nothing`);
  // The display select must accept the very reply the capture reads (one shape, two readings).
  expect(() => reader.select(reply, picked, undefined)).not.toThrow();
  const got = reader.captures.pick(reply, picked, undefined);
  expect(Object.keys(got).sort()).toEqual([...reader.captures.keys].sort());
  return { ...got };
}

function invert(
  toolId: string,
  input: Record<string, unknown>,
  captured: Record<string, string>,
): Record<string, unknown> | undefined {
  const d = byId(toolId).reversibility;
  if (d?.class !== "reversible") throw new Error(`${toolId} is not reversible`);
  return d.invert(input, captured);
}

describe("reversibility: six reversible rows, each proven by a recorded before-state (D-IC-4; the 0.22.0 flag rows in unleash-split-rows.test.ts)", () => {
  const ld = {
    on: true,
    variations: [{ id: "v1", name: "On" }],
    offVariationId: "v1",
    fallthrough: { variationId: "v1" },
  };
  const ldInput = {
    environmentKey: "production",
    projectKey: "web",
    flagKey: "checkout",
    on: false,
  };

  test("launchdarkly_flag_toggle: the inverse sets the switch back to what it was", () => {
    const captured = capture("launchdarkly_flag_toggle", ld, ldInput);
    expect(captured).toEqual({ on: "true" });
    expect(invert("launchdarkly_flag_toggle", ldInput, captured)).toEqual({
      environmentKey: "production",
      projectKey: "web",
      flagKey: "checkout",
      on: true,
    });
  });

  test("launchdarkly_flag_toggle: a call that changed nothing has no inverse", () => {
    expect(
      invert("launchdarkly_flag_toggle", { ...ldInput, on: true }, { on: "true" }),
    ).toBeUndefined();
    expect(invert("launchdarkly_flag_toggle", ldInput, { on: "yes" })).toBeUndefined();
    expect(invert("launchdarkly_flag_toggle", { on: true }, { on: "false" })).toBeUndefined();
  });

  test("flagsmith_feature_state_set: the inverse restores the switch; a call that set a value cannot be undone", () => {
    const reply = { environment_default: { enabled: false, value: "x" }, segment_overrides: [] };
    const input = { environmentKey: "env", featureId: 7, enabled: true };
    const captured = capture("flagsmith_feature_state_set", reply, input);
    expect(captured).toEqual({ enabled: "false" });
    expect(invert("flagsmith_feature_state_set", input, captured)).toEqual({
      environmentKey: "env",
      featureId: 7,
      enabled: false,
    });
    expect(
      invert("flagsmith_feature_state_set", { ...input, value: "y" }, captured),
    ).toBeUndefined();
    expect(
      invert("flagsmith_feature_state_set", { ...input, enabled: false }, captured),
    ).toBeUndefined();
    expect(
      invert("flagsmith_feature_state_set", { ...input, featureId: "7" }, captured),
    ).toBeUndefined();
  });

  test("aws_ec2_instance_stop and start undo each other, and only when the state really changed", () => {
    const input = { instanceIds: "i-0abc" };
    const running = capture(
      "aws_ec2_instance_stop",
      { instanceId: "i-0abc", state: "running" },
      input,
    );
    expect(invert("aws_ec2_instance_stop", input, running)).toEqual(input);
    expect(invert("aws_ec2_instance_stop", input, { state: "stopped" })).toBeUndefined();
    const stopped = capture(
      "aws_ec2_instance_start",
      { instanceId: "i-0abc", state: "stopped" },
      input,
    );
    expect(invert("aws_ec2_instance_start", input, stopped)).toEqual(input);
    expect(invert("aws_ec2_instance_start", input, { state: "running" })).toBeUndefined();
    expect(invert("aws_ec2_instance_start", {}, stopped)).toBeUndefined();
    expect(byId("aws_ec2_instance_stop").reversibility).toMatchObject({
      inverse: "aws_ec2_instance_start",
    });
    expect(byId("aws_ec2_instance_start").reversibility).toMatchObject({
      inverse: "aws_ec2_instance_stop",
    });
  });

  test("aws_ecs_service_update: the inverse is an update back to the task definition the service ran", () => {
    const now = "arn:aws:ecs:us-east-1:1:task-definition/web:41";
    const input = { cluster: "prod", service: "web", taskDefinition: "web:42" };
    const captured = capture(
      "aws_ecs_service_update",
      { serviceName: "web", taskDefinition: now, desiredCount: 2, status: "ACTIVE" },
      input,
    );
    expect(captured).toEqual({ taskDefinition: now });
    expect(invert("aws_ecs_service_update", input, captured)).toEqual({
      cluster: "prod",
      service: "web",
      taskDefinition: now,
    });
    expect(
      invert("aws_ecs_service_update", { ...input, taskDefinition: now }, captured),
    ).toBeUndefined();
    expect(invert("aws_ecs_service_update", { cluster: "prod" }, captured)).toBeUndefined();
  });

  test("argocd_app_rollback: the inverse rolls back to the history id that was current", () => {
    const reply = {
      metadata: { name: "web" },
      status: {
        history: [
          { id: 3, revision: "aaa" },
          { id: 5, revision: "ccc" },
          { id: 4, revision: "bbb" },
          { id: "x", revision: "bad" },
        ],
      },
    };
    const input = { name: "web", id: 3 };
    const captured = capture("argocd_app_rollback", reply, input);
    expect(captured).toEqual({ currentHistoryId: "5", autoSync: "off", historyIds: "5,4,3" });
    expect(invert("argocd_app_rollback", input, captured)).toEqual({ name: "web", id: 5 });
    expect(invert("argocd_app_rollback", { name: "web", id: 5 }, captured)).toBeUndefined();
    expect(invert("argocd_app_rollback", input, { currentHistoryId: "x5" })).toBeUndefined();
    expect(invert("argocd_app_rollback", { id: 3 }, captured)).toBeUndefined();
  });

  test("argocd_app_rollback: auto-sync is on while `automated` is an object, unless it says `enabled: false`", () => {
    const history = { history: [{ id: 2, revision: "bbb" }] };
    const autoSyncOf = (automated: unknown): string | undefined =>
      capture(
        "argocd_app_rollback",
        { metadata: { name: "web" }, spec: { syncPolicy: { automated } }, status: history },
        { name: "web", id: 2 },
      )?.["autoSync"];
    expect(autoSyncOf({})).toBe("on");
    expect(autoSyncOf({ enabled: true, prune: true })).toBe("on");
    expect(autoSyncOf({ enabled: null })).toBe("on");
    expect(autoSyncOf({ enabled: false, prune: true })).toBe("off");
    expect(autoSyncOf(null)).toBe("off");
    expect(autoSyncOf([])).toBe("off");
    // Capture to prediction: an explicitly disabled policy predicts the rollback; an enabled one is uncertain.
    const reply = (automated: unknown) => ({
      metadata: { name: "web" },
      spec: { syncPolicy: { automated } },
      status: {
        history: [
          { id: 1, revision: "aaa" },
          { id: 2, revision: "bbb" },
        ],
      },
    });
    const input = { name: "web", id: 1 };
    const predict = (automated: unknown) =>
      predictOutcome(
        "argocd_app_rollback",
        input,
        capture("argocd_app_rollback", reply(automated), input),
      );
    expect(predict({ enabled: false })).toEqual({
      verdict: "would_change",
      text: "the application moves from history 2 back to the revision of history 1",
    });
    expect(predict({ enabled: true }).verdict).toBe("uncertain");
  });

  test("a capture refuses a reply without the value (no guess)", () => {
    for (const toolId of [
      "launchdarkly_flag_toggle",
      "flagsmith_feature_state_set",
      "aws_ec2_instance_stop",
      "aws_ecs_service_update",
      "argocd_app_rollback",
    ]) {
      const reader = byId(toolId).before;
      expect(() => reader?.captures?.pick({}, {}, undefined)).toThrow();
    }
    expect(() =>
      byId("argocd_app_rollback").before?.captures?.pick(
        mcp({ status: { history: [] } }),
        {},
        undefined,
      ),
    ).toThrow("no history");
  });
});

describe("reversibility: the irreversible rows and the default", () => {
  const IRREVERSIBLE = [
    "pd_incident_acknowledge",
    "pd_incident_resolve",
    "pd_incident_escalate",
    "jira_ops_alert_acknowledge",
    "jira_ops_alert_close",
    "argocd_app_sync",
    "github_pr_merge",
    "gitlab_mr_merge",
    "bitbucket_pr_merge",
    "bitbucket_pr_comment_create",
    "github_pr_review_create",
    "github_branch_delete",
    "onedrive_item_delete",
    "outlook_calendar_delete",
    "apple_calendar_event_delete",
    "gcal_event_update",
    "gcal_event_delete",
    "aws_lambda_invoke",
    "jenkins_build_trigger",
    "gha_run_trigger",
    "circleci_pipeline_trigger",
    "netlify_build_trigger",
    "bitrise_build_trigger",
    "codemagic_build_trigger",
    "k8s_pod_delete",
    "iac_terraform_init",
  ];

  test.each(IRREVERSIBLE)("%s is declared irreversible, with a reason", (toolId) => {
    const row = byId(toolId);
    expect(reversibilityClassOf(row)).toBe("irreversible");
    const d = row.reversibility;
    expect(d?.class === "irreversible" && d.reason.length > 0).toBe(true);
  });

  test("the table holds exactly the nine reversible and these irreversible rows (a census)", () => {
    const reversible = Object.entries(REVERSIBILITY_TABLE)
      .filter(([, e]) => e.decl.class === "reversible")
      .map(([id]) => id)
      .sort();
    expect(reversible).toEqual([
      "argocd_app_rollback",
      "aws_ec2_instance_start",
      "aws_ec2_instance_stop",
      "aws_ecs_service_update",
      "flagsmith_feature_state_set",
      "launchdarkly_flag_toggle",
      "split_kill",
      "split_restore",
      "unleash_feature_toggle",
    ]);
    const irr = Object.entries(REVERSIBILITY_TABLE)
      .filter(([, e]) => e.decl.class === "irreversible")
      .map(([id]) => id)
      .sort();
    expect(irr).toEqual([...IRREVERSIBLE].sort());
  });

  test("every other row is unknown: nothing is inferred", () => {
    const other = CONNECTOR_WRITE_ROWS.filter((r) => REVERSIBILITY_TABLE[r.toolId] === undefined);
    expect(other.length).toBeGreaterThan(50);
    for (const r of other) expect(reversibilityClassOf(r)).toBe("unknown");
    expect(reversibilityClassOf(undefined)).toBe("unknown");
  });

  test("the table applied to the production rows is consistent", () => {
    expect(checkReversibilityTable(CONNECTOR_WRITE_ROWS)).toEqual([]);
  });
});

describe("reversibility: the static check refuses an inconsistent declaration", () => {
  const rows = CONNECTOR_WRITE_ROWS;
  const entry = (over: Partial<Extract<ReversibilityEntry["decl"], { class: "reversible" }>>) => {
    const base = REVERSIBILITY_TABLE["launchdarkly_flag_toggle"] as ReversibilityEntry;
    return {
      captures: base.captures,
      decl: { ...(base.decl as object), ...over } as ReversibilityEntry["decl"],
    } as ReversibilityEntry;
  };

  test("an inverse that is not a row", () => {
    const t = { launchdarkly_flag_toggle: entry({ inverse: "no_such_tool" }) };
    expect(checkReversibilityTable(rows, t)).toEqual([
      "launchdarkly_flag_toggle: inverse row no_such_tool does not exist",
    ]);
  });

  test("a fromBefore key the reader's captures do not supply", () => {
    const t = { launchdarkly_flag_toggle: entry({ fromBefore: ["on", "ghost"] }) };
    expect(checkReversibilityTable(rows, t)).toEqual([
      "launchdarkly_flag_toggle: fromBefore names ghost, which no capture supplies",
    ]);
  });

  test("a reversible entry with no captures, a row with no reader, a missing row, captures on an irreversible one", () => {
    const base = REVERSIBILITY_TABLE["launchdarkly_flag_toggle"] as ReversibilityEntry;
    expect(
      checkReversibilityTable(rows, { launchdarkly_flag_toggle: { decl: base.decl } }),
    ).toContain("launchdarkly_flag_toggle: reversible but no captures");
    // A reversible declaration on a row with no before reader (an unrelated write).
    const noReader = rows.find((r) => r.before === undefined);
    expect(noReader).toBeDefined();
    const problems = checkReversibilityTable(rows, { [noReader?.toolId ?? ""]: base });
    expect(problems).toContain(`${noReader?.toolId}: reversible but the row has no before reader`);
    expect(checkReversibilityTable(rows, { ghost_tool: base })).toEqual([
      "ghost_tool: no such write row",
    ]);
    expect(
      checkReversibilityTable(rows, {
        pd_incident_resolve: {
          decl: { class: "irreversible", reason: "r" },
          captures: base.captures as NonNullable<typeof base.captures>,
        },
      }),
    ).toEqual(["pd_incident_resolve: captures on an irreversible row"]);
  });

  test("applyReversibility throws on a bad table and attaches captures and the class on a good one", () => {
    expect(() =>
      applyReversibility(rows, {
        ghost_tool: REVERSIBILITY_TABLE["pd_incident_resolve"] as ReversibilityEntry,
      }),
    ).toThrow("connector write reversibility table: ghost_tool: no such write row");
    const applied = applyReversibility(rows, {});
    expect(applied).toHaveLength(rows.length);
    expect(Object.isFrozen(byId("launchdarkly_flag_toggle"))).toBe(true);
    expect(byId("launchdarkly_flag_toggle").before?.captures?.keys).toEqual(["on"]);
  });
});
