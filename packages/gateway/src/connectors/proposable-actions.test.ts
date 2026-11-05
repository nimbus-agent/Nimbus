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
  "confluence.page.create",
  "confluence.page.update",
  "discord.message.post",
  "fastmail.mail.send",
  "github.issue.comment.create",
  "github.issue.create",
  "gitlab.issue.note.create",
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
  test("the proposable set is exactly the reviewed 34", () => {
    const got = Object.entries(ACTION_PROPOSABILITY)
      .filter(([, p]) => p.kind === "proposable")
      .map(([t]) => t)
      .sort();
    expect(got).toEqual(PROPOSABLE);
  });
  test("counts, derived: 34 proposable, 126 denied, 10 of them not_yet_offered", () => {
    const all = Object.values(ACTION_PROPOSABILITY);
    expect(all.filter((p) => p.kind === "proposable")).toHaveLength(34);
    expect(all.filter((p) => p.kind === "denied")).toHaveLength(126);
    expect(all.filter((p) => p.kind === "denied" && p.class === "not_yet_offered")).toHaveLength(
      10,
    );
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

test("not_yet_offered is exactly the routable 0.4.0 writes, each a real connector-write row", () => {
  const notYet = Object.entries(ACTION_PROPOSABILITY)
    .filter(([, p]) => p.kind === "denied" && p.class === "not_yet_offered")
    .map(([t]) => t)
    .sort();
  expect(notYet).toEqual(
    [
      "confluence.page.append",
      "github.issue.assignees.add",
      "github.issue.labels.add",
      "github.issue.state.set",
      "gitlab.issue.assignees.add",
      "gitlab.issue.create",
      "gitlab.issue.labels.add",
      "gitlab.issue.state.set",
      "jira.issue.transition",
      "outlook.draft.create",
    ].sort(),
  );
  // Unlike `unroutable`, each resolves: a row names its tool on its own server.
  const rowTypes = new Set(CONNECTOR_WRITE_ROWS.map((r) => r.actionType));
  expect(notYet.filter((t) => !rowTypes.has(t))).toEqual([]);
  for (const t of notYet) {
    expect(classifyActionType(t, OPEN), t).toEqual({ kind: "denied", class: "not_yet_offered" });
    expect(proposableWriteTool(t), t).toBeUndefined();
  }
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
