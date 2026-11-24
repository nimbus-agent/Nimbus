// Owner ruling 9: a live investigation read (`<service>.investigate.read`) resolves only to a READ tool of its own
// service, exactly as a before-state read and a runbook read do; the same keys under an ordinary type are untouched.
import { describe, expect, test } from "bun:test";

import type { PlannedAction } from "../engine/types.ts";
import { createConnectorDispatcher, type McpToolListingClient } from "./registry.ts";

function mapOf(keys: readonly string[]) {
  const ran: string[] = [];
  const tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> = {};
  for (const k of keys) {
    tools[k] = {
      execute: async () => {
        ran.push(k);
        return { from: k };
      },
    };
  }
  const client: McpToolListingClient = { listTools: async () => tools };
  return { d: createConnectorDispatcher(client), ran };
}

const read = (type: string, mcpToolId: string): PlannedAction => ({
  type,
  payload: { mcpToolId, input: { projectSlug: "p" } },
});

describe("<service>.investigate.read at the dispatcher", () => {
  test("a read of its own service dispatches", async () => {
    const { d, ran } = mapOf(["sentry_sentry_issue_list"]);
    await expect(
      d.dispatch(read("sentry.investigate.read", "sentry_sentry_issue_list")),
    ).resolves.toEqual({ from: "sentry_sentry_issue_list" });
    expect(ran).toEqual(["sentry_sentry_issue_list"]);
  });

  test("a write key under it throws and runs nothing", async () => {
    const { d, ran } = mapOf(["jira_jira_issue_update", "jira_jira_comment_add"]);
    for (const key of ["jira_jira_issue_update", "jira_jira_comment_add"]) {
      await expect(d.dispatch(read("jira.investigate.read", key))).rejects.toThrow(
        `ERR_BEFORE_READ_NOT_A_READ: action type "jira.investigate.read" may not dispatch tool "${key}"`,
      );
    }
    expect(ran).toEqual([]);
  });

  test("a non-read verb is refused too", async () => {
    const { d, ran } = mapOf(["sentry_sentry_issue_frobnicate"]);
    await expect(
      d.dispatch(read("sentry.investigate.read", "sentry_sentry_issue_frobnicate")),
    ).rejects.toThrow("ERR_BEFORE_READ_NOT_A_READ");
    expect(ran).toEqual([]);
  });

  test("a read of ANOTHER connector is refused: it cannot misattribute its egress row", async () => {
    const { d, ran } = mapOf(["github_github_issue_get", "sentry_sentry_issue_list"]);
    await expect(
      d.dispatch(read("sentry.investigate.read", "github_github_issue_get")),
    ).rejects.toThrow(
      `ERR_BEFORE_READ_SERVICE_MISMATCH: action type "sentry.investigate.read" may not dispatch tool "github_github_issue_get"`,
    );
    expect(ran).toEqual([]);
  });

  test("the same write key under an ordinary type is untouched by the guard", async () => {
    const { d, ran } = mapOf(["jira_jira_issue_update"]);
    await d.dispatch(read("jira.issue.update", "jira_jira_issue_update"));
    expect(ran).toEqual(["jira_jira_issue_update"]);
  });
});
