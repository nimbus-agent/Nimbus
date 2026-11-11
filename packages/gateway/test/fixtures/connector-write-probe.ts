/**
 * Child-process half of `test/integration/connectors/connector-write-comments.integration.test.ts`
 * (suite `comments`, the default), `connector-write-issues.integration.test.ts` (suite `issues`)
 * and `connector-write-pages.integration.test.ts` (suite `pages`).
 *
 * Runs the suite's writes (B1: the comment writes for Jira, Confluence, GitLab issue and MR notes
 * and GitHub; B2: the issue writes for Jira, GitLab and GitHub; B3: the Confluence page writes,
 * with a Confluence KB destination configured for the KB-child guard) through
 * REAL connector processes (`connectorSpawn`, a real `@mastra/mcp` `MCPClient`), the production
 * mesh dispatcher (`createConnectorDispatcher`), a real `LocalIndex` with its egress ledger, and a
 * `ToolExecutor` shaped like the model door's (no delegate, the before-state runner as argument 8).
 * Each write runs once approved and once denied by the consent stub. The parent's fake upstream
 * records every request; this prints one line, `CONNECTOR_WRITE_PROBE <json>`, with the results,
 * the consent details and the egress rows.
 *
 * A SEPARATE PROCESS on purpose: other test files `mock.module("@mastra/mcp")`, and a module mock
 * is process-global in the one-process whole-repo run.
 *
 * argv[2]: a throwaway directory for the index database. argv[3]: the suite, `comments` (default),
 * `issues` or `pages`.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { MCPClient } from "@mastra/mcp";
import type { TribalKbConfig } from "../../src/connectors/connector-writes/types.ts";
import { connectorSpawn } from "../../src/connectors/lazy-mesh/keys.ts";
import { listLazyMeshClientTools } from "../../src/connectors/lazy-mesh/tool-map.ts";
import { createConnectorDispatcher } from "../../src/connectors/registry.ts";
import { makeEgressSink } from "../../src/egress/egress-ledger.ts";
import { createBeforeStateRunner } from "../../src/engine/before-state.ts";
import { NO_POLICY_OVERLAY, ToolExecutor } from "../../src/engine/executor.ts";
import type { ActionResult, PlannedAction } from "../../src/engine/types.ts";
import { LocalIndex } from "../../src/index/local-index.ts";

const dir = process.argv[2];
if (dir === undefined || dir === "") throw new Error("usage: connector-write-probe.ts <dir>");

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;

interface ProbeWrite {
  readonly server: string;
  readonly tool: string;
  readonly type: string;
  readonly input: Record<string, unknown>;
}

/** B1: the five comment writes. */
const COMMENTS: readonly ProbeWrite[] = [
  {
    server: "jira",
    tool: "jira_comment_add",
    type: "jira.comment.add",
    input: { issueKey: "NIM-1", body: "Looks good" },
  },
  {
    server: "confluence",
    tool: "confluence_comment_add",
    type: "confluence.comment.add",
    input: { pageId: "123", storageHtml: "<p>Looks good</p>" },
  },
  {
    server: "gitlab",
    tool: "gitlab_issue_note_create",
    type: "gitlab.issue.note.create",
    input: { projectPath: "group/repo", issueIid: 7, body: "Looks good" },
  },
  {
    server: "gitlab",
    tool: "gitlab_mr_note_create",
    type: "gitlab.mr.note.create",
    input: { projectPath: "group/repo", mergeRequestIid: 9, body: "Looks good" },
  },
  {
    server: "github",
    tool: "github_issue_comment_create",
    type: "github.issue.comment.create",
    input: { owner: "o", repo: "r", issueNumber: 42, body: "Looks good" },
  },
];

/** B2: the eleven issue writes whose connector host is configurable (Linear's is not). */
const ISSUES: readonly ProbeWrite[] = [
  {
    server: "jira",
    tool: "jira_issue_create",
    type: "jira.issue.create",
    input: { projectKey: "NIM", summary: "Login fails", description: "Steps" },
  },
  {
    server: "jira",
    tool: "jira_issue_update",
    type: "jira.issue.update",
    input: { issueKey: "NIM-1", summary: "Login fails on Safari" },
  },
  {
    server: "jira",
    tool: "jira_issue_transition",
    type: "jira.issue.transition",
    input: { issueKey: "NIM-1", transitionId: "31" },
  },
  {
    server: "gitlab",
    tool: "gitlab_issue_create",
    type: "gitlab.issue.create",
    input: {
      projectPath: "group/repo",
      title: "Broken",
      labels: ["bug", "ui"],
      assigneeIds: [12],
    },
  },
  {
    server: "gitlab",
    tool: "gitlab_issue_labels_add",
    type: "gitlab.issue.labels.add",
    input: { projectPath: "group/repo", issueIid: 7, labels: ["bug"] },
  },
  {
    server: "gitlab",
    tool: "gitlab_issue_assignees_add",
    type: "gitlab.issue.assignees.add",
    input: { projectPath: "group/repo", issueIid: 7, assigneeUsernames: ["alice"] },
  },
  {
    server: "gitlab",
    tool: "gitlab_issue_state_set",
    type: "gitlab.issue.state.set",
    input: { projectPath: "group/repo", issueIid: 7, stateEvent: "close" },
  },
  {
    server: "github",
    tool: "github_issue_create",
    type: "github.issue.create",
    input: { owner: "o", repo: "r", title: "Login fails", body: "Steps" },
  },
  {
    server: "github",
    tool: "github_issue_labels_add",
    type: "github.issue.labels.add",
    input: { owner: "o", repo: "r", issueNumber: 42, labels: ["bug"] },
  },
  {
    server: "github",
    tool: "github_issue_assignees_add",
    type: "github.issue.assignees.add",
    input: { owner: "o", repo: "r", issueNumber: 42, assignees: ["alice"] },
  },
  {
    server: "github",
    tool: "github_issue_state_set",
    type: "github.issue.state.set",
    input: { owner: "o", repo: "r", issueNumber: 42, state: "closed" },
  },
];

/**
 * B3: the Confluence page writes (Confluence is the only B3 connector whose host is configurable).
 * The permitted update and appends target space ENG (B3's review fix 4, kept); page 124's first PUT
 * is answered 409; since connectors 0.5.0 the before read carries `ancestors`, so page 778 (KB
 * space, not under the KB parent) is allowed and page 777 (under the KB parent 4242) must be
 * refused by the KB-child guard before any write.
 */
const PAGES: readonly ProbeWrite[] = [
  {
    server: "confluence",
    tool: "confluence_page_create",
    type: "confluence.page.create",
    input: { spaceKey: "ENG", title: "New page", storageHtml: "<p>new</p>", parentPageId: "55" },
  },
  {
    server: "confluence",
    tool: "confluence_page_update",
    type: "confluence.page.update",
    input: { pageId: "123", versionNumber: 7, title: "Runbook v2", storageHtml: "<p>replaced</p>" },
  },
  {
    server: "confluence",
    tool: "confluence_page_append",
    type: "confluence.page.append",
    input: { pageId: "123", storageHtml: "<p>appended</p>" },
  },
  {
    server: "confluence",
    tool: "confluence_page_append",
    type: "confluence.page.append",
    input: { pageId: "124", storageHtml: "<p>more</p>" },
  },
  {
    server: "confluence",
    tool: "confluence_page_append",
    type: "confluence.page.append",
    input: { pageId: "778", storageHtml: "<p>team note</p>" },
  },
  {
    server: "confluence",
    tool: "confluence_page_append",
    type: "confluence.page.append",
    input: { pageId: "777", storageHtml: "<p>under the KB parent</p>" },
  },
];

/** The KB destination the pages suite configures (the door passes the real one). */
const PAGES_KB: TribalKbConfig = { confluence: { spaceKey: "KB", parentPageId: "4242" } };

const suite = process.argv[3] ?? "comments";
const SUITES: Readonly<Record<string, readonly ProbeWrite[]>> = {
  comments: COMMENTS,
  issues: ISSUES,
  pages: PAGES,
};
const WRITES = Object.hasOwn(SUITES, suite) ? SUITES[suite] : undefined;
if (WRITES === undefined) throw new Error(`unknown suite ${suite}`);
const kb: TribalKbConfig | undefined = suite === "pages" ? PAGES_KB : undefined;
const SERVERS = suite === "pages" ? ["confluence"] : ["jira", "confluence", "gitlab", "github"];

const db = new Database(join(dir, "index.db"));
LocalIndex.ensureSchema(db);
const index = new LocalIndex(db);
const client = new MCPClient({
  id: "connector-write-probe",
  servers: Object.fromEntries(SERVERS.map((id) => [id, { ...connectorSpawn(id), env }])),
  timeout: 60_000,
});

let approve = true;
const consents: Array<{ type: string | undefined; details: Record<string, unknown> | undefined }> =
  [];
const runs: Array<{
  type: string;
  approved: boolean;
  status: ActionResult["status"];
  reason?: string;
}> = [];
try {
  const dispatcher = createConnectorDispatcher({
    listTools: () => listLazyMeshClientTools(client),
    getToolsEpoch: () => 0,
  });
  const executor = new ToolExecutor(
    {
      requestApproval: async (_prompt, details, actionType) => {
        consents.push({ type: actionType, details });
        return { approved: approve, answerSource: "human" as const };
      },
    },
    index,
    dispatcher,
    undefined,
    makeEgressSink(db),
    NO_POLICY_OVERLAY,
    () => "personal",
    // The door executor's shape, with a cap generous enough for a slow CI runner.
    { beforeState: createBeforeStateRunner({ timeoutMs: 30_000, guardContext: () => ({ kb }) }) },
  );
  for (const approved of [true, false]) {
    approve = approved;
    for (const w of WRITES) {
      const action: PlannedAction = {
        type: w.type,
        origin: "model",
        payload: { mcpToolId: `${w.server}_${w.tool}`, input: w.input },
      };
      const out = await executor.execute(action); // NOSONAR S9382: one write at a time, so the parent can assert the request order
      runs.push({
        type: w.type,
        approved,
        status: out.status,
        ...(out.status === "rejected" && suite === "pages" ? { reason: out.reason } : {}),
      });
    }
  }
  // Pin the real shape a before-read reply has (plan R4): the dispatcher hands back the tool's
  // MCP CallToolResult as is. The comments suite only (its parent asserts this read).
  const raw = (
    suite !== "comments"
      ? {}
      : await dispatcher.dispatch({
          type: "github.before.read",
          payload: {
            mcpToolId: "github_github_issue_get",
            input: { owner: "o", repo: "r", issueNumber: 42 },
          },
        })
  ) as { content?: Array<{ type?: unknown; text?: unknown }>; isError?: unknown };

  /** The first text part parsed as JSON, or a marker saying why it could not be. */
  const parseFirstText = (): unknown => {
    const text = raw.content?.[0]?.text;
    if (typeof text !== "string") return "(no text part)";
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return "(not JSON)";
    }
  };
  const parsed = parseFirstText();
  const replyShape = {
    keys: Object.keys(raw).sort((a, b) => a.localeCompare(b)),
    contentTypes: (raw.content ?? []).map((c) => c.type),
    firstTextTitle:
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)["title"]
        : parsed,
  };
  const egress = db
    .query("SELECT method, result_status AS resultStatus FROM egress_ledger ORDER BY id")
    .all() as Array<{ method: string; resultStatus: string }>;
  process.stdout.write(
    `\nCONNECTOR_WRITE_PROBE ${JSON.stringify({ runs, consents, egress, replyShape })}\n`,
  );
} finally {
  await client.disconnect().catch(() => {});
  index.close();
}
