import { describe, expect, test } from "bun:test";

import { HITL_REQUIRED } from "../engine/executor.ts";
import { serviceOf } from "../engine/service-of.ts";
import { CONNECTOR_WRITE_ROWS } from "./connector-writes/index.ts";
import { meshServerForToolKey } from "./lazy-mesh/tool-map.ts";
import {
  ACTION_PROPOSABILITY,
  classifyActionType,
  listProposableActionTypes,
  PROPOSABLE_WRITE_TOOLS,
  proposableWriteTool,
} from "./proposable-actions.ts";

const OPEN = {
  modelAccessServices: () => new Set(["mcp_echo"]),
  userMcpModelAccessAllowed: () => true,
};

const PROPOSABLE = [
  "apple.calendar.event.create",
  "apple.mail.draft.create",
  "apple.mail.send",
  "confluence.comment.add",
  "confluence.page.append",
  "confluence.page.create",
  "confluence.page.update",
  "discord.message.post",
  "fastmail.mail.send",
  "github.branch.create",
  "github.issue.assignees.add",
  "github.issue.comment.create",
  "github.issue.create",
  "github.issue.labels.add",
  "github.issue.state.set",
  "github.pr.create",
  "gitlab.branch.create",
  "gitlab.issue.assignees.add",
  "gitlab.issue.create",
  "gitlab.issue.labels.add",
  "gitlab.issue.note.create",
  "gitlab.issue.state.set",
  "gitlab.mr.create",
  "gitlab.mr.note.create",
  "gmail.draft.create",
  "gmail.draft.send",
  "gmail.message.send",
  "google_drive.file.create",
  "imap.mail.send",
  "jira.comment.add",
  "jira.issue.create",
  "jira.issue.update",
  "linear.comment.create",
  "linear.issue.create",
  "linear.issue.update",
  "notion.block.append",
  "notion.comment.create",
  "notion.page.create",
  "notion.page.update",
  "obsidian.note.append",
  "outlook.calendar.create",
  "outlook.draft.create",
  "outlook.mail.send",
  "protonmail.mail.send",
  "slack.message.post",
  "teams.message.post",
  "teams.message.postChat",
];

describe("ACTION_PROPOSABILITY", () => {
  test("is total over HITL_REQUIRED and names nothing else", () => {
    expect(Object.keys(ACTION_PROPOSABILITY).sort()).toEqual([...HITL_REQUIRED].sort());
  });
  test("the proposable set is exactly the reviewed 47", () => {
    const got = Object.entries(ACTION_PROPOSABILITY)
      .filter(([, p]) => p.kind === "proposable")
      .map(([t]) => t)
      .sort();
    expect(got).toEqual(PROPOSABLE);
  });
  test("counts, derived: 47 proposable, 138 denied, 9 of them not_yet_offered", () => {
    const all = Object.values(ACTION_PROPOSABILITY);
    expect(PROPOSABLE).toHaveLength(47);
    expect(all.filter((p) => p.kind === "proposable")).toHaveLength(47);
    expect(all.filter((p) => p.kind === "denied")).toHaveLength(138);
    expect(all.filter((p) => p.kind === "denied" && p.class === "not_yet_offered")).toHaveLength(9);
    expect(all).toHaveLength(HITL_REQUIRED.size);
  });
  test("§ 6.2 borderline types stay denied", () => {
    for (const t of [
      "pagerduty.incident.acknowledge",
      "alert.acknowledge",
      "github.pr.close",
      "repo.pr.close",
      "tableau.datasource.refresh",
      "powerbi.dataset.refresh",
    ]) {
      expect(ACTION_PROPOSABILITY[t]?.kind, t).toBe("denied");
    }
  });
});

test("not_yet_offered is exactly the Jira transition plus the two VCS updates, the five flag and Jira alert writes (C1, C2) and the Gmail thread archive (SA2), each a real connector-write row", () => {
  const notYet = Object.entries(ACTION_PROPOSABILITY)
    .filter(([, p]) => p.kind === "denied" && p.class === "not_yet_offered")
    .map(([t]) => t)
    .sort();
  expect(notYet).toEqual(
    [
      // jira.issue.transition by owner ruling OR-B2-4 (no before-read on the act door).
      "jira.issue.transition",
      // The two VCS updates (C2): templated, but not recoverable (the connector overwrites the old
      // text or base) and the act door runs no before-read, so the owner would approve an edit
      // with no current title or base to compare. The creates are proposable.
      "github.pr.update",
      "gitlab.mr.update",
      // The flag and Jira alert writes (C1): untemplated, no act-door refusals yet (C3).
      "launchdarkly.flag.toggle",
      "launchdarkly.flag.rollout.set",
      "flagsmith.feature.state.set",
      "jira.ops.alert.acknowledge",
      "jira.ops.alert.close",
      // The Gmail thread archive (SA2): a thread id is opaque and the act door shows no before-state.
      "gmail.thread.archive",
    ].sort((a, b) => a.localeCompare(b)),
  );
  // Unlike `unroutable`, each resolves: a row names its tool on its own server.
  const rowTypes = new Set(CONNECTOR_WRITE_ROWS.map((r) => r.actionType));
  expect(notYet.filter((t) => !rowTypes.has(t))).toEqual([]);
  for (const t of notYet) {
    expect(classifyActionType(t, OPEN), t).toEqual({ kind: "denied", class: "not_yet_offered" });
    expect(proposableWriteTool(t), t).toBeUndefined();
  }
});

test("email.draft.create stays unroutable: no row's action type, never proposable (B3)", () => {
  expect(ACTION_PROPOSABILITY["email.draft.create"]).toEqual({
    kind: "denied",
    class: "unroutable",
  });
  expect(proposableWriteTool("email.draft.create")).toBeUndefined();
  expect(CONNECTOR_WRITE_ROWS.some((r) => r.actionType === "email.draft.create")).toBe(false);
});

test("share.publish stays denied as gateway_internal", () => {
  expect(ACTION_PROPOSABILITY["share.publish"]).toEqual({
    kind: "denied",
    class: "gateway_internal",
  });
});

describe("PROPOSABLE_WRITE_TOOLS", () => {
  test("keys are exactly the proposable first-party types", () => {
    expect(Object.keys(PROPOSABLE_WRITE_TOOLS).sort()).toEqual(PROPOSABLE);
  });
  test("each row resolves on its OWN server in the mesh key form", () => {
    // resolveServerTool(map, serviceOf(type), toolId) looks up `${server}_${toolId}` and requires
    // meshServerForToolKey to give that key back to the same server.
    for (const [type, tool] of Object.entries(PROPOSABLE_WRITE_TOOLS)) {
      const server = serviceOf(type);
      expect(meshServerForToolKey(`${server}_${tool}`), type).toBe(server);
    }
  });
  test("proposableWriteTool: routing value for proposables, undefined otherwise", () => {
    expect(proposableWriteTool("slack.message.post")).toBe("slack_message_post");
    expect(proposableWriteTool("obsidian.note.append")).toBe("obsidian_append_to_daily_note");
    expect(proposableWriteTool("email.send")).toBeUndefined();
    expect(proposableWriteTool("github.pr.merge")).toBeUndefined();
    expect(proposableWriteTool("mcp_echo.echo")).toBeUndefined();
    expect(proposableWriteTool("toString")).toBeUndefined();
  });
});

describe("classifyActionType", () => {
  test("first-party proposable / denied / unknown", () => {
    expect(classifyActionType("slack.message.post", OPEN)).toEqual({ kind: "proposable" });
    expect(classifyActionType("github.pr.merge", OPEN)).toEqual({ kind: "denied", class: "vcs" });
    expect(classifyActionType("Slack.Message.Post", OPEN)).toEqual({ kind: "unknown" });
    expect(classifyActionType("constructor", OPEN)).toEqual({ kind: "unknown" });
  });
  test("user-MCP: proposable only for a --model server while policy allows", () => {
    expect(classifyActionType("mcp_echo.echo", OPEN)).toEqual({ kind: "proposable" });
    expect(classifyActionType("mcp_other.echo", OPEN)).toEqual({
      kind: "denied",
      class: "user_mcp_no_model_access",
    });
    expect(
      classifyActionType("mcp_echo.echo", { ...OPEN, userMcpModelAccessAllowed: () => false }),
    ).toEqual({ kind: "denied", class: "user_mcp_policy" });
    expect(classifyActionType("mcp_echo.", OPEN)).toEqual({ kind: "unknown" });
  });
  test("user-MCP: a tool segment outside [A-Za-z0-9_-]{1,64} is unknown, even for a --model server", () => {
    const esc = String.fromCodePoint(0x1b);
    const rlo = String.fromCodePoint(0x202e);
    for (const t of [
      `mcp_echo.echo${esc}[8m${rlo}`,
      "mcp_echo.a.b",
      "mcp_echo.a b",
      "mcp_echo.e/cho",
      `mcp_echo.${"x".repeat(65)}`,
    ]) {
      expect(classifyActionType(t, OPEN)).toEqual({ kind: "unknown" });
    }
    expect(classifyActionType(`mcp_echo.${"x".repeat(64)}`, OPEN)).toEqual({ kind: "proposable" });
    expect(classifyActionType("mcp_echo.do-it_2", OPEN)).toEqual({ kind: "proposable" });
  });
});

describe("listProposableActionTypes", () => {
  test("configured first-party types plus one pattern per --model server, sorted", async () => {
    const out = await listProposableActionTypes({
      ...OPEN,
      isServiceConfigured: (s) => Promise.resolve(s === "slack" || s === "jira"),
    });
    expect(out).toEqual([
      "jira.comment.add",
      "jira.issue.create",
      "jira.issue.update",
      "mcp_echo.*",
      "slack.message.post",
    ]);
  });
  test("policy off: no user-MCP pattern", async () => {
    const out = await listProposableActionTypes({
      ...OPEN,
      userMcpModelAccessAllowed: () => false,
      isServiceConfigured: () => Promise.resolve(false),
    });
    expect(out).toEqual([]);
  });
});

describe("extension service ids are not proposable on the act door", () => {
  test("ext_ falls through to unknown even when listed as model-accessible", () => {
    const ctx = {
      modelAccessServices: () => new Set(["ext_foo"]),
      userMcpModelAccessAllowed: () => true,
    };
    expect(classifyActionType("ext_foo.echo", ctx)).toEqual({ kind: "unknown" });
  });
});

test("D1: every Wave 4 row stays denied on the act door, in the class it had (nothing becomes proposable, the act door runs no before-read)", () => {
  const wave4 = CONNECTOR_WRITE_ROWS.filter((r) => r.wave === 4);
  expect(wave4).toHaveLength(50);
  const classes = new Map<string, string>();
  for (const r of wave4) {
    const p = ACTION_PROPOSABILITY[r.actionType];
    expect(p?.kind, r.toolId).toBe("denied");
    expect(proposableWriteTool(r.actionType), r.toolId).toBeUndefined();
    classes.set(r.actionType, p?.kind === "denied" ? p.class : "");
  }
  // The 31 with a typed preview (27 offered to the model, plus the Bitbucket merge and the three
  // Azure and Cloud Run rows) keep the class they had before D1.
  expect(Object.fromEntries(classes)).toMatchObject({
    "github.pr.merge": "vcs",
    "github.branch.delete": "vcs",
    "github.tag.create": "vcs",
    "gitlab.mr.merge": "vcs",
    "bitbucket.pr.merge": "vcs",
    "jenkins.build.trigger": "pipeline",
    "github_actions.run.trigger": "pipeline",
    "circleci.pipeline.trigger": "pipeline",
    "gitlab.pipeline.cancel": "pipeline",
    "aws.lambda.invoke": "cloud",
    "azure.app_service.restart": "cloud",
    "gcp.cloud_run.deploy": "cloud",
    "argocd.app.sync": "deployment",
    "mlflow.model.promote": "deployment",
    "snowflake.tag.set": "data_platform",
    "onedrive.item.delete": "file",
    "outlook.calendar.delete": "calendar_delete",
    "apple.calendar.event.delete": "calendar_delete",
    "github.file.commit": "vcs",
    "gitlab.commit.create": "vcs",
    // D3b: the seven deploy-trigger and mobile-release writes, all denied.
    "vercel.deployment.redeploy": "deployment",
    "vercel.deployment.promote": "deployment",
    "netlify.build.trigger": "deployment",
    "bitrise.build.trigger": "pipeline",
    "codemagic.build.trigger": "pipeline",
    "testflight.build.distribute": "mobile_release",
    "firebase.release.distribute": "mobile_release",
  });
});

describe("a bound row is never proposable on the MCP act door (D1c, spec 15.5)", () => {
  // Phase 28 AD1: the act door now runs on the door executor, so its prompt is the executor's own.
  // The classification below is unchanged (AD3 revisits it): a bound row's preflight, prepare and
  // settle phases need an approval surface that can show a diff or a plan and collect the typed
  // confirmation, which the two-step `captures accept` flow does not yet offer on every channel.
  const bound = CONNECTOR_WRITE_ROWS.filter((r) => r.bound !== undefined);

  test("the bound rows are exactly the two commits, the three plan-bound iac writes and the Kubernetes apply (D3a)", () => {
    expect(bound.map((r) => r.actionType).sort()).toEqual([
      "github.file.commit",
      "gitlab.commit.create",
      "iac.cloudformation.deploy",
      "iac.terraform.apply",
      "iac.terraform.destroy",
      "kubernetes.manifest.apply",
    ]);
  });

  test("the act door's classes for the iac and Kubernetes writes D2 touched are all denied", () => {
    for (const [type, cls] of [
      ["iac.terraform.apply", "iac"],
      ["iac.terraform.destroy", "iac"],
      ["iac.cloudformation.deploy", "iac"],
      ["iac.cloudformation.changeset.discard", "iac"],
      ["iac.pulumi.up", "iac"],
      ["kubernetes.manifest.apply", "k8s"],
    ] as const) {
      const p = ACTION_PROPOSABILITY[type];
      expect(p?.kind, type).toBe("denied");
      expect(p?.kind === "denied" ? p.class : "", type).toBe(cls);
    }
  });

  test("no bound row is in the proposable set, the routing table or the classification", () => {
    for (const r of bound) {
      expect(ACTION_PROPOSABILITY[r.actionType]?.kind, r.actionType).toBe("denied");
      expect(proposableWriteTool(r.actionType), r.actionType).toBeUndefined();
      expect(PROPOSABLE_WRITE_TOOLS[r.actionType], r.actionType).toBeUndefined();
      expect(classifyActionType(r.actionType, OPEN).kind, r.actionType).toBe("denied");
    }
  });
});
