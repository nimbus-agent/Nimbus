/**
 * Child-process half of `test/integration/connectors/connector-write-comments.integration.test.ts`.
 *
 * Runs the B1 comment writes for Jira, Confluence, GitLab (issue and MR notes) and GitHub through
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
 * argv[2]: a throwaway directory for the index database.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { MCPClient } from "@mastra/mcp";
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

/** The five writes: server key, tool, action type and input. */
const WRITES: ReadonlyArray<{
  server: string;
  tool: string;
  type: string;
  input: Record<string, unknown>;
}> = [
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

const db = new Database(join(dir, "index.db"));
LocalIndex.ensureSchema(db);
const index = new LocalIndex(db);
const client = new MCPClient({
  id: "connector-write-probe",
  servers: {
    jira: { ...connectorSpawn("jira"), env },
    confluence: { ...connectorSpawn("confluence"), env },
    gitlab: { ...connectorSpawn("gitlab"), env },
    github: { ...connectorSpawn("github"), env },
  },
  timeout: 60_000,
});

let approve = true;
const consents: Array<{ type: string | undefined; details: Record<string, unknown> | undefined }> =
  [];
const runs: Array<{ type: string; approved: boolean; status: ActionResult["status"] }> = [];
try {
  const dispatcher = createConnectorDispatcher({
    listTools: () => listLazyMeshClientTools(client),
    getToolsEpoch: () => 0,
  });
  const executor = new ToolExecutor(
    {
      requestApproval: async (_prompt, details, actionType) => {
        consents.push({ type: actionType, details });
        return approve;
      },
    },
    index,
    dispatcher,
    undefined,
    makeEgressSink(db),
    NO_POLICY_OVERLAY,
    () => "personal",
    // The door executor's shape, with a cap generous enough for a slow CI runner.
    createBeforeStateRunner({ timeoutMs: 30_000 }),
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
      runs.push({ type: w.type, approved, status: out.status });
    }
  }
  // Pin the real shape a before-read reply has (plan R4): the dispatcher hands back the tool's
  // MCP CallToolResult as is.
  const raw = (await dispatcher.dispatch({
    type: "github.before.read",
    payload: {
      mcpToolId: "github_github_issue_get",
      input: { owner: "o", repo: "r", issueNumber: 42 },
    },
  })) as { content?: Array<{ type?: unknown; text?: unknown }>; isError?: unknown };
  const replyShape = {
    keys: Object.keys(raw).sort((a, b) => a.localeCompare(b)),
    contentTypes: (raw.content ?? []).map((c) => c.type),
    firstTextIsJson: typeof raw.content?.[0]?.text === "string",
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
