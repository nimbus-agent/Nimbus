/**
 * Spec § 5.4 door isolation: on an owner turn `runAsk` builds TWO executors — the ask executor
 * (plan path and user-MCP tools) and the connector-write door's. Only the door's carries the
 * before-state runner, so only a door prompt reads a write's current state. Driven through the
 * real `runAsk` with the `beforeStateRows` seam (a SYNTHETIC row: no production row has a reader).
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@mastra/core/agent";

import { row, withBefore, withPreview } from "../connectors/connector-writes/types.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import {
  agentRequestContext,
  getAgentRequestConnectorWriteExecutor,
  getAgentRequestUserMcpExecutor,
} from "./agent-request-context.ts";
import { type RunAskParams, runAsk } from "./run-ask.ts";
import type { ConnectorDispatcher, PlannedAction } from "./types.ts";

const stubBase = join(tmpdir(), "nimbus-run-ask-before-state-test");
const stubPaths: PlatformPaths = {
  configDir: join(stubBase, "cfg"),
  dataDir: join(stubBase, "data"),
  logDir: join(stubBase, "logs"),
  socketPath: join(stubBase, "gateway.sock"),
  extensionsDir: join(stubBase, "ext"),
  tempDir: join(stubBase, "tmp"),
  sandboxDir: join(stubBase, "sandbox"),
};

const ROW = withBefore(
  withPreview(row("jira_issue_update", "jira.issue.update", "mesh", 2), {
    target: "{issueKey}",
    summary: "Update {issueKey}",
    fields: [{ key: "summary", label: "Summary", kind: "text" }],
  }),
  {
    tool: "jira_issue_get",
    argKeys: ["issueKey"],
    args: (input) => ({ issueKey: input["issueKey"] }),
    select: () => [{ label: "Summary", value: "old" }],
  },
);

const WRITE: PlannedAction = {
  type: "jira.issue.update",
  origin: "model",
  payload: { mcpToolId: "jira_jira_issue_update", input: { issueKey: "NIM-1", summary: "new" } },
};

type Exec = { execute(a: PlannedAction): Promise<unknown> };

function harness() {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  // A non-empty index, so the turn reaches the agent rather than the empty-index guidance.
  db.run(
    "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES ('x:1', 'x', 'note', '1', 't', 1, 1)",
  );
  const localIndex = new LocalIndex(db);
  const dispatched: string[] = [];
  const details: Array<Record<string, unknown> | undefined> = [];
  const held: { ask: Exec | undefined; door: Exec | undefined } = {
    ask: undefined,
    door: undefined,
  };
  const consentCoordinator: ConsentCoordinator = {
    async requestConsent(_clientId, req): Promise<boolean> {
      details.push(req.details as Record<string, unknown> | undefined);
      return true;
    },
    rejectAllPending(): void {},
    pendingCount(): number {
      return 0;
    },
  };
  const dispatcher: ConnectorDispatcher = {
    async dispatch(action): Promise<unknown> {
      dispatched.push(action.type);
      return { ok: true };
    },
  };
  const agent = {
    generate: async () => {
      held.ask = getAgentRequestUserMcpExecutor();
      held.door = getAgentRequestConnectorWriteExecutor();
      return { text: "agent reply" };
    },
  } as unknown as Agent;
  const params: RunAskParams = {
    input: "update NIM-1",
    stream: false,
    clientId: "owner-client-9",
    paths: stubPaths,
    consentCoordinator,
    localIndex,
    dispatcher,
    egressSink: { append: () => {} },
    getTribalKbConfig: () => undefined,
    sendChunk: () => {},
    conversationalAgent: agent,
    classify: async () => ({ intent: "unknown", entities: {}, requiresHITL: false, confidence: 0 }),
    offerUserMcpTools: true,
    offerConnectorWriteTools: true,
    beforeStateRows: [ROW],
  };
  return { params, dispatched, details, held, close: () => localIndex.close() };
}

describe("runAsk — only the door's executor reads the before-state", () => {
  test("the door executor reads first and shows it; the ask executor runs no read", async () => {
    const h = harness();
    await agentRequestContext.run({}, () => runAsk(h.params));
    const { ask, door } = h.held;
    if (ask === undefined || door === undefined) throw new Error("both executors must be set");

    await door.execute(WRITE);
    expect(h.dispatched).toEqual(["jira.before.read", "jira.issue.update"]);
    expect(h.details[0]?.["before"]).toEqual({
      status: "ok",
      fields: [{ label: "Summary", value: "old" }],
    });

    h.dispatched.length = 0;
    await ask.execute(WRITE);
    expect(h.dispatched).toEqual(["jira.issue.update"]);
    expect(h.details[1]?.["before"]).toBeUndefined();
    h.close();
  });
});
