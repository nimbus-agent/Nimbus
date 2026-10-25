/**
 * The test the act door's first draft lacked (spec § 6.3): the action `buildActDeps` constructs,
 * dispatched through the REAL `createConnectorDispatcher` over a tool map keyed EXACTLY as the mesh
 * lists tools (`<server>_<tool>`), reaches the right tool for a first-party and a user-MCP type.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { createConnectorDispatcher } from "../../../src/connectors/registry.ts";
import { appendAuditEntry } from "../../../src/db/audit-chain.ts";
import { makeEgressSink } from "../../../src/egress/egress-ledger.ts";
import { NO_POLICY_OVERLAY } from "../../../src/engine/executor.ts";
import { openMigratedMemoryDb } from "../../../src/index/migrated-db-template.ts";
import { buildActDeps } from "../../../src/ipc/capture-rpc.ts";
import type { ConsentCoordinator } from "../../../src/ipc/consent.ts";

const PROV = { captureId: "cap_1", clientLabel: null, createdAt: 0, expiresAt: 1, summary: "s" };
const approve = { requestConsent: () => Promise.resolve(true) } as unknown as ConsentCoordinator;

function meshTools(calls: Array<[string, unknown]>) {
  const tool = (key: string) => ({
    execute: (input: unknown) => {
      calls.push([key, input]);
      return Promise.resolve({ ok: key });
    },
  });
  const keys = [
    "slack_slack_message_post",
    "slack_slack_chat_post",
    "obsidian_obsidian_append_to_daily_note",
    "google_drive_gdrive_file_create",
    "apple_apple_mail_send",
    "jira_jira_issue_create",
  ];
  return Object.fromEntries(keys.map((k) => [k, tool(k)]));
}

const openDbs: Array<ReturnType<typeof openMigratedMemoryDb>> = [];
function trackedDb() {
  const db = openMigratedMemoryDb();
  openDbs.push(db);
  return db;
}
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function makeAct(
  dispatcher: ReturnType<typeof createConnectorDispatcher>,
  db: ReturnType<typeof openMigratedMemoryDb>,
) {
  return buildActDeps(
    {
      dispatcher,
      egressSink: makeEgressSink(db),
      audit: { recordAudit: (e) => appendAuditEntry(db, e) },
      policyHitl: NO_POLICY_OVERLAY,
    },
    approve,
    "c-cli",
  );
}

describe("act door routing through the real dispatcher", () => {
  test.each([
    ["slack.message.post", "slack_slack_message_post"],
    ["jira.issue.create", "jira_jira_issue_create"],
    ["google_drive.file.create", "google_drive_gdrive_file_create"],
    ["apple.mail.send", "apple_apple_mail_send"],
  ])("%s resolves to %s with the stored input", async (type, key) => {
    const db = trackedDb();
    const calls: Array<[string, unknown]> = [];
    const dispatcher = createConnectorDispatcher({
      listTools: () => Promise.resolve(meshTools(calls)),
    });
    const act = makeAct(dispatcher, db);
    expect(await act.execute(type, { text: "hi" }, PROV)).toMatchObject({ status: "ok" });
    expect(calls).toEqual([[key, { text: "hi" }]]);
  });

  test("obsidian.note.append routes to the obsidian server's mesh key (mesh-only server)", async () => {
    const db = trackedDb();
    const calls: Array<[string, unknown]> = [];
    const dispatcher = createConnectorDispatcher({
      listTools: () => Promise.resolve(meshTools(calls)),
    });
    const act = makeAct(dispatcher, db);
    const input = { vault_id: "v1", text: "hi" };
    expect(await act.execute("obsidian.note.append", input, PROV)).toMatchObject({ status: "ok" });
    expect(calls).toEqual([["obsidian_obsidian_append_to_daily_note", input]]);
  });

  test("the obsidian bare id never resolves under another server's action type", async () => {
    const calls: Array<[string, unknown]> = [];
    const dispatcher = createConnectorDispatcher({
      listTools: () => Promise.resolve(meshTools(calls)),
    });
    await expect(
      dispatcher.dispatch({
        type: "slack.message.post",
        payload: { mcpToolId: "obsidian_append_to_daily_note", input: {} },
      }),
    ).rejects.toThrow(/^Tool not found$/);
    expect(calls).toEqual([]);
  });

  test("a user-MCP type resolves only its own server's key", async () => {
    const db = trackedDb();
    const calls: Array<[string, unknown]> = [];
    const userTools = {
      mcp_echo_echo: {
        execute: (i: unknown) => {
          calls.push(["mcp_echo_echo", i]);
          return Promise.resolve("ok");
        },
      },
    };
    const dispatcher = createConnectorDispatcher({
      listTools: () => Promise.resolve({}),
      listUserMcpTools: (s) => Promise.resolve(s === "mcp_echo" ? userTools : undefined),
    });
    const act = makeAct(dispatcher, db);
    await act.execute("mcp_echo.echo", { text: "hi" }, PROV);
    expect(calls).toEqual([["mcp_echo_echo", { text: "hi" }]]);
  });

  test("RED-PROOF premise: dispatching by type alone (the first draft) finds no tool", async () => {
    const calls: Array<[string, unknown]> = [];
    const dispatcher = createConnectorDispatcher({
      listTools: () => Promise.resolve(meshTools(calls)),
    });
    await expect(
      dispatcher.dispatch({ type: "slack.message.post", payload: { input: {} } }),
    ).rejects.toThrow("Tool not found");
  });

  test("user-MCP dispatch by type alone is refused - the act door must pass mcpToolId (I42 pairing)", async () => {
    const calls: Array<[string, unknown]> = [];
    const userTools = {
      mcp_echo_echo: {
        execute: (i: unknown) => {
          calls.push(["mcp_echo_echo", i]);
          return Promise.resolve("ok");
        },
      },
    };
    const dispatcher = createConnectorDispatcher({
      listTools: () => Promise.resolve({}),
      listUserMcpTools: (s) => Promise.resolve(s === "mcp_echo" ? userTools : undefined),
    });
    await expect(
      dispatcher.dispatch({ type: "mcp_echo.echo", payload: { input: { text: "hi" } } }),
    ).rejects.toThrow("ERR_USER_MCP_ACTION_MISMATCH");
    expect(calls).toEqual([]);
  });
});
