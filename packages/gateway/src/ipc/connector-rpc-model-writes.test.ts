import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { toStandardSchema } from "@mastra/core/schema";

import {
  getModelWriteEnablement,
  isObsidianWriteGrantApproved,
  setModelWriteEnablement,
  writesEnabledBy,
} from "../connectors/connector-writes/enablement-store.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { isModelOfferableRow } from "../connectors/connector-writes/model-offerable.ts";
import { createModelWriteToolSource } from "../connectors/connector-writes/model-write-source.ts";
import { previewTemplateKeys, row, withPreview } from "../connectors/connector-writes/types.ts";
import type { LazyConnectorMesh } from "../connectors/lazy-mesh/mesh.ts";
import { mcpClientToolKey } from "../connectors/lazy-mesh/tool-map.ts";
import { dbRun } from "../db/write.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { buildConnectorWriteAgentTools } from "../engine/connector-write-agent-tools.ts";
import { NO_POLICY_OVERLAY, ToolExecutor } from "../engine/executor.ts";
import { serviceOf } from "../engine/service-of.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import { createMockVault } from "../vault/mock.ts";
import { ConnectorRpcError, dispatchConnectorRpc } from "./connector-rpc.ts";
import {
  handleConnectorWritesDisable,
  handleConnectorWritesEnable,
  handleConnectorWritesStatus,
  type ModelWritesDeps,
} from "./connector-rpc-handlers/model-writes.ts";

let db: Database;
let localIndex: LocalIndex;

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
});
afterEach(() => db.close());

type Policy = { capabilitiesDisabled: ReadonlySet<string> };
const OPEN: Policy = { capabilitiesDisabled: new Set<string>() };
const LOCKED: Policy = { capabilitiesDisabled: new Set(["connector_write_model_access"]) };

function executor(approve: boolean, prompts: string[] = []): ToolExecutor {
  return new ToolExecutor(
    {
      requestApproval: async (prompt: string) => {
        prompts.push(prompt);
        return approve;
      },
    },
    localIndex,
    { dispatch: async () => ({}) },
    undefined,
    NULL_EGRESS_SINK,
    NO_POLICY_OVERLAY,
  );
}

async function call(
  method: string,
  params: unknown,
  opts: { policy?: () => Policy | undefined; exec?: ToolExecutor } = {},
): Promise<unknown> {
  const r = await dispatchConnectorRpc({
    method,
    params,
    vault: createMockVault(),
    localIndex,
    openUrl: async () => {},
    syncScheduler: undefined,
    getEnforcedPolicy: (opts.policy ?? (() => OPEN)) as never,
    ...(opts.exec === undefined ? {} : { toolExecutor: opts.exec }),
  });
  if (r.kind !== "hit") throw new Error("miss");
  return r.value;
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorRpcError);
    return (e as ConnectorRpcError).message;
  }
  throw new Error("expected a refusal");
}

describe("connector.writesEnable", () => {
  test("an approved enable writes the row; the prompt names every write and the fixed sentence", async () => {
    const prompts: string[] = [];
    const out = await call(
      "connector.writesEnable",
      { service: "github", wave: 3 },
      { exec: executor(true, prompts) },
    );
    const expected = writesEnabledBy("github", 3);
    expect(out).toEqual({ service: "github", maxWave: 3, writes: expected.length });
    expect(getModelWriteEnablement(db, "github")?.maxWave).toBe(3);
    expect(prompts).toHaveLength(1);
    const p = prompts[0] ?? "";
    expect(p).toContain("Service: github");
    expect(p).toContain("Up to wave: 3");
    // B1 templates the comment write, B2 the four issue writes and C1 the pull request close and C2 the branch, pull request create and update: the owner approves all nine.
    for (const r of expected) {
      const tag = isModelOfferableRow(r) ? "(new: offered after you approve)" : "(not offered yet)";
      expect(p).toContain(`${r.toolId}  ${r.actionType}  wave ${r.wave}  ${tag}`);
    }
    expect(expected.filter(isModelOfferableRow).map((r) => r.toolId)).toEqual([
      "github_issue_create",
      "github_issue_comment_create",
      "github_issue_labels_add",
      "github_issue_assignees_add",
      "github_issue_state_set",
      "github_pr_close",
      "github_branch_create",
      "github_pr_create",
      "github_pr_update",
    ]);
    expect(p).toContain("Each call will still ask you before it runs.");
  });

  test("the wave defaults to 3, and a re-enable with another wave replaces the row (O4)", async () => {
    await call("connector.writesEnable", { service: "github" }, { exec: executor(true) });
    expect(getModelWriteEnablement(db, "github")?.maxWave).toBe(3);
    const prompts: string[] = [];
    await call(
      "connector.writesEnable",
      { service: "github", wave: 2 },
      { exec: executor(true, prompts) },
    );
    expect(prompts).toHaveLength(1);
    expect(getModelWriteEnablement(db, "github")?.maxWave).toBe(2);
  });

  test("a declined enable writes nothing and says so", async () => {
    const msg = await refusal(
      call("connector.writesEnable", { service: "github" }, { exec: executor(false) }),
    );
    expect(msg).toContain("ERR_CONNECTOR_WRITES_DECLINED");
    expect(getModelWriteEnablement(db, "github")).toBeUndefined();
  });

  test("the gate decision is audited", async () => {
    await call("connector.writesEnable", { service: "github" }, { exec: executor(true) });
    const rows = db
      .query("SELECT action_type FROM audit_log WHERE action_type = 'connector.writes.enable'")
      .all();
    expect(rows.length).toBeGreaterThan(0);
  });

  test("a policy that forbids it refuses BEFORE any prompt, read live on every call", async () => {
    const prompts: string[] = [];
    let locked = false;
    const policy = () => (locked ? LOCKED : OPEN);
    const exec = executor(true, prompts);
    await call("connector.writesEnable", { service: "github" }, { exec, policy });
    locked = true; // applied after boot
    const msg = await refusal(
      call("connector.writesEnable", { service: "github" }, { exec, policy }),
    );
    expect(msg).toContain("ERR_CONNECTOR_WRITES_POLICY");
    expect(prompts).toHaveLength(1);
  });

  test("an absent policy fails closed", async () => {
    const prompts: string[] = [];
    const msg = await refusal(
      call(
        "connector.writesEnable",
        { service: "github" },
        { exec: executor(true, prompts), policy: () => undefined },
      ),
    );
    expect(msg).toContain("ERR_CONNECTOR_WRITES_POLICY");
    expect(prompts).toHaveLength(0);
  });

  test("bad waves and unknown services are refused before any prompt", async () => {
    const prompts: string[] = [];
    const exec = executor(true, prompts);
    for (const wave of [5, 1, "abc", "3", 2.5, null]) {
      await refusal(call("connector.writesEnable", { service: "github", wave }, { exec }));
    }
    for (const service of ["mcp_x", "ext_y", "email", "", 7, undefined]) {
      const msg = await refusal(call("connector.writesEnable", { service }, { exec }));
      expect(msg).toContain("ERR_CONNECTOR_WRITES_UNKNOWN_SERVICE");
    }
    expect(prompts).toHaveLength(0);
    expect(getModelWriteEnablement(db, "github")).toBeUndefined();
  });

  test("it requires a toolExecutor", async () => {
    await refusal(call("connector.writesEnable", { service: "github" }));
  });
});

describe("connector.writesDisable and writesStatus", () => {
  test("disable needs no approval, is idempotent, and works under a locked policy", async () => {
    await call("connector.writesEnable", { service: "github" }, { exec: executor(true) });
    const policy = () => LOCKED;
    expect(await call("connector.writesDisable", { service: "github" }, { policy })).toEqual({
      removed: true,
    });
    expect(await call("connector.writesDisable", { service: "github" }, { policy })).toEqual({
      removed: false,
    });
  });

  test("disable refuses a missing or empty service", async () => {
    for (const service of [undefined, "", 42]) {
      expect(await refusal(call("connector.writesDisable", { service }))).toContain(
        "ERR_CONNECTOR_WRITES_UNKNOWN_SERVICE",
      );
    }
  });

  test("status lists every eligible service, sorted, with policyAllows", async () => {
    await call("connector.writesEnable", { service: "github", wave: 2 }, { exec: executor(true) });
    const s = (await call("connector.writesStatus", {})) as {
      policyAllows: boolean;
      services: Array<{ service: string; enabled: boolean; maxWave?: number; writes: number }>;
    };
    expect(s.policyAllows).toBe(true);
    const names = s.services.map((x) => x.service);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).toContain("kubernetes");
    expect(s.services.find((x) => x.service === "github")).toMatchObject({
      enabled: true,
      maxWave: 2,
    });
    expect(s.services.find((x) => x.service === "kubernetes")?.enabled).toBe(false);
    // Since D1 argocd's two wave-4 writes have a reader and a confirm text: offerable, but a
    // service that is not enabled has nothing approved, so both await approval.
    expect(s.services.find((x) => x.service === "argocd")).toMatchObject({
      enabled: false,
      writes: 2,
      offerable: 0,
      awaitingApproval: 2,
    });
    // The approved enable covered the five offerable github writes (B1's comment, B2's issues).
    expect(s.services.find((x) => x.service === "github")).toMatchObject({
      offerable: 5,
      awaitingApproval: 0,
    });
    const locked = (await call("connector.writesStatus", {}, { policy: () => undefined })) as {
      policyAllows: boolean;
    };
    expect(locked.policyAllows).toBe(false);
  });
});

describe("the approved set (V84): synthetic templated rows through the handlers' rows seam", () => {
  // No real wave-2/3 row has a template yet, so only synthetic rows can be offerable here.
  const T = { target: "{name}", summary: "s", fields: [] };
  const SYNC = withPreview(row("argocd_app_sync", "argocd.app.sync", "write", 2), T);
  const ROLLBACK = withPreview(row("argocd_app_rollback", "argocd.app.rollback", "write", 3), T);
  const BARE = row("argocd_app_delete", "argocd.app.delete", "write", 2);
  const ROWS = [SYNC, ROLLBACK, BARE];

  function deps(exec?: ToolExecutor): ModelWritesDeps {
    return {
      db,
      toolExecutor: exec,
      getEnforcedPolicy: () => OPEN,
      now: () => 5,
      rows: ROWS,
    };
  }

  type Status = {
    services: Array<{ service: string; offerable: number; awaitingApproval: number }>;
  };

  test("a pre-V84 opt-in offers nothing; status names the writes awaiting approval", () => {
    dbRun(
      db,
      "INSERT INTO connector_write_enablement (service, max_wave, enabled_at) VALUES ('argocd', 3, 1)",
    );
    const s = handleConnectorWritesStatus(deps()) as Status;
    expect(s.services.find((x) => x.service === "argocd")).toMatchObject({
      offerable: 0,
      awaitingApproval: 2,
    });
  });

  test("enable marks each write by state and stores exactly the offerable ids it listed", async () => {
    // An earlier opt-in approved only the sync.
    setModelWriteEnablement(db, "argocd", 2, 1, ["argocd_app_sync"]);
    const prompts: string[] = [];
    await handleConnectorWritesEnable(
      { service: "argocd", wave: 3 },
      deps(executor(true, prompts)),
    );
    const p = prompts[0] ?? "";
    expect(p).toContain("argocd_app_sync  argocd.app.sync  wave 2  (offered to the model)");
    expect(p).toContain(
      "argocd_app_rollback  argocd.app.rollback  wave 3  (new: offered after you approve)",
    );
    expect(p).toContain("argocd_app_delete  argocd.app.delete  wave 2  (not offered yet)");
    expect(getModelWriteEnablement(db, "argocd")?.approvedToolIds).toEqual(
      new Set(["argocd_app_rollback", "argocd_app_sync"]),
    );
    // Stored sorted.
    expect(db.query("SELECT approved_tool_ids FROM connector_write_enablement").get()).toEqual({
      approved_tool_ids: '["argocd_app_rollback","argocd_app_sync"]',
    });
    const s = handleConnectorWritesStatus(deps()) as Status;
    expect(s.services.find((x) => x.service === "argocd")).toMatchObject({
      offerable: 2,
      awaitingApproval: 0,
    });
  });

  test("a declined re-enable leaves the earlier approved set untouched", async () => {
    setModelWriteEnablement(db, "argocd", 2, 1, ["argocd_app_sync"]);
    await refusal(
      handleConnectorWritesEnable({ service: "argocd", wave: 3 }, deps(executor(false))),
    );
    expect([...(getModelWriteEnablement(db, "argocd")?.approvedToolIds ?? [])]).toEqual([
      "argocd_app_sync",
    ]);
  });
});

describe("C0: a templated send is never offered or approved (OR-W34-1)", () => {
  const T = { target: "{to}", summary: "s", fields: [] };
  const SEND = withPreview(row("gmail_message_send", "gmail.message.send", "mesh", 2), T);
  const DRAFT = withPreview(row("gmail_draft_create", "gmail.draft.create", "mesh", 2), T);

  test("enable lists the send as not offered and never stores it as approved", async () => {
    const prompts: string[] = [];
    await handleConnectorWritesEnable(
      { service: "gmail", wave: 3 },
      {
        db,
        toolExecutor: executor(true, prompts),
        getEnforcedPolicy: () => OPEN,
        now: () => 5,
        rows: [SEND, DRAFT],
      },
    );
    const p = prompts[0] ?? "";
    expect(p).toContain("gmail_message_send  gmail.message.send  wave 2  (not offered yet)");
    expect(p).toContain(
      "gmail_draft_create  gmail.draft.create  wave 2  (new: offered after you approve)",
    );
    expect(getModelWriteEnablement(db, "gmail")?.approvedToolIds).toEqual(
      new Set(["gmail_draft_create"]),
    );
  });
});

describe("wiring", () => {
  test("the executor the connector dispatcher builds is gate-only: NULL_EGRESS_SINK, stub dispatcher", () => {
    const src = readFileSync(join(import.meta.dir, "server", "dispatchers.ts"), "utf8");
    const at = src.indexOf("export async function tryDispatchConnectorRpc(");
    const body = src.slice(at, src.indexOf("export async function tryDispatchDiagnosticsRpc(", at));
    expect(body).toContain("NULL_EGRESS_SINK");
    expect(body).toContain("stubDispatcher");
    expect(body).toContain("getEnforcedPolicy");
  });

  test("the handler calls gate(), never execute()", () => {
    const src = readFileSync(
      join(import.meta.dir, "connector-rpc-handlers", "model-writes.ts"),
      "utf8",
    );
    expect(src).toContain(".gate(");
    expect(src).not.toMatch(/\.execute\(/);
  });
});

describe("re-consent on the real B1 and B2 rows (V84; B1 and B2 Task 5)", () => {
  type Status = {
    services: Array<{ service: string; offerable: number; awaitingApproval: number }>;
  };
  const statusOf = async (service: string) => {
    const s = (await call("connector.writesStatus", {})) as Status;
    return s.services.find((x) => x.service === service);
  };

  /** The model door over the production source, with each real row listed by its template keys. */
  async function doorTools(): Promise<string[]> {
    const listing = (service: string): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const r of CONNECTOR_WRITE_ROWS) {
        if (serviceOf(r.actionType) !== service || r.preview === undefined) continue;
        const properties: Record<string, Record<string, never>> = {};
        for (const k of previewTemplateKeys(r.preview)) properties[k] = {};
        out[mcpClientToolKey(service, r.toolId)] = {
          description: r.toolId,
          inputSchema: toStandardSchema({ type: "object", properties }),
        };
      }
      return out;
    };
    const src = createModelWriteToolSource({
      db,
      enforcedPolicy: () => OPEN as unknown as EnforcedPolicy,
      listServerTools: async (service) => listing(service),
      toolsEpoch: () => 0,
      warn: () => {},
    });
    const tools = await buildConnectorWriteAgentTools(
      src,
      () => ({ execute: async () => ({ status: "ok", result: {} }) }),
      (_s, _t, d) => d,
      new Set(),
    );
    return Object.keys(tools).sort((a, b) => a.localeCompare(b));
  }

  /** An executor that records the enable prompt's details (the payload it was shown). */
  function recordingExecutor(seen: Array<Record<string, unknown> | undefined>): ToolExecutor {
    return new ToolExecutor(
      {
        requestApproval: async (_p: string, details?: Record<string, unknown>) => {
          seen.push(details);
          return true;
        },
      },
      localIndex,
      { dispatch: async () => ({}) },
      undefined,
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
    );
  }

  const statesOf = (d: Record<string, unknown> | undefined): Record<string, string> => {
    const writes = (d?.["writes"] ?? []) as Array<{ toolId: string; state: string }>;
    return Object.fromEntries(writes.map((w) => [w.toolId, w.state]));
  };

  test("Slack: an opt-in from before B1 offers nothing until the owner re-approves the two posts", async () => {
    // Before B1 no Slack write was offerable, so the opt-in approved none (V84 approved set []).
    setModelWriteEnablement(db, "slack", 2, 1, []);
    expect(await statusOf("slack")).toMatchObject({ offerable: 0, awaitingApproval: 2 });
    expect((await doorTools()).filter((n) => n.startsWith("slack__"))).toEqual([]);
    const seen: Array<Record<string, unknown> | undefined> = [];
    await call(
      "connector.writesEnable",
      { service: "slack", wave: 2 },
      { exec: recordingExecutor(seen) },
    );
    expect(seen).toHaveLength(1);
    expect(statesOf(seen[0])).toEqual({
      slack_message_post: "newly_offerable",
      slack_message_post_dm: "newly_offerable",
    });
    expect(await statusOf("slack")).toMatchObject({ offerable: 2, awaitingApproval: 0 });
    expect((await doorTools()).filter((n) => n.startsWith("slack__"))).toEqual([
      "slack__slack_message_post",
      "slack__slack_message_post_dm",
    ]);
  });

  test("GitHub: an opt-in from before B1 offers nothing until the owner re-approves all five writes", async () => {
    setModelWriteEnablement(db, "github", 2, 1, []);
    expect(await statusOf("github")).toMatchObject({ offerable: 0, awaitingApproval: 5 });
    expect((await doorTools()).filter((n) => n.startsWith("github__"))).toEqual([]);
    const seen: Array<Record<string, unknown> | undefined> = [];
    await call(
      "connector.writesEnable",
      { service: "github", wave: 2 },
      { exec: recordingExecutor(seen) },
    );
    expect(statesOf(seen[0])).toEqual({
      github_issue_create: "newly_offerable",
      github_issue_comment_create: "newly_offerable",
      github_issue_labels_add: "newly_offerable",
      github_issue_assignees_add: "newly_offerable",
      github_issue_state_set: "newly_offerable",
    });
    expect(await statusOf("github")).toMatchObject({ offerable: 5, awaitingApproval: 0 });
    expect((await doorTools()).filter((n) => n.startsWith("github__"))).toEqual([
      "github__github_issue_assignees_add",
      "github__github_issue_comment_create",
      "github__github_issue_create",
      "github__github_issue_labels_add",
      "github__github_issue_state_set",
    ]);
  });

  test("GitHub: a B1 opt-in (the comment approved) keeps the comment and offers none of the four issue writes until re-approved (B2)", async () => {
    setModelWriteEnablement(db, "github", 2, 1, ["github_issue_comment_create"]);
    expect(await statusOf("github")).toMatchObject({ offerable: 1, awaitingApproval: 4 });
    expect((await doorTools()).filter((n) => n.startsWith("github__"))).toEqual([
      "github__github_issue_comment_create",
    ]);
    const seen: Array<Record<string, unknown> | undefined> = [];
    await call(
      "connector.writesEnable",
      { service: "github", wave: 2 },
      { exec: recordingExecutor(seen) },
    );
    expect(seen).toHaveLength(1);
    expect(statesOf(seen[0])).toEqual({
      github_issue_create: "newly_offerable",
      github_issue_comment_create: "already_approved",
      github_issue_labels_add: "newly_offerable",
      github_issue_assignees_add: "newly_offerable",
      github_issue_state_set: "newly_offerable",
    });
    expect(await statusOf("github")).toMatchObject({ offerable: 5, awaitingApproval: 0 });
    expect((await doorTools()).filter((n) => n.startsWith("github__"))).toEqual([
      "github__github_issue_assignees_add",
      "github__github_issue_comment_create",
      "github__github_issue_create",
      "github__github_issue_labels_add",
      "github__github_issue_state_set",
    ]);
  });

  test("Jira: a B1 opt-in (the comment approved) has three issue writes awaiting approval (B2)", async () => {
    setModelWriteEnablement(db, "jira", 2, 1, ["jira_comment_add"]);
    expect(await statusOf("jira")).toMatchObject({ offerable: 1, awaitingApproval: 3 });
    expect((await doorTools()).filter((n) => n.startsWith("jira__"))).toEqual([
      "jira__jira_comment_add",
    ]);
    const seen: Array<Record<string, unknown> | undefined> = [];
    await call(
      "connector.writesEnable",
      { service: "jira", wave: 2 },
      { exec: recordingExecutor(seen) },
    );
    expect(statesOf(seen[0])).toEqual({
      jira_issue_create: "newly_offerable",
      jira_issue_update: "newly_offerable",
      jira_comment_add: "already_approved",
      jira_issue_transition: "newly_offerable",
    });
    expect(await statusOf("jira")).toMatchObject({ offerable: 4, awaitingApproval: 0 });
    expect((await doorTools()).filter((n) => n.startsWith("jira__"))).toEqual([
      "jira__jira_comment_add",
      "jira__jira_issue_create",
      "jira__jira_issue_transition",
      "jira__jira_issue_update",
    ]);
  });

  test("Notion: a B1 opt-in (the comment approved) has the three page writes awaiting approval (B3)", async () => {
    setModelWriteEnablement(db, "notion", 2, 1, ["notion_comment_create"]);
    expect(await statusOf("notion")).toMatchObject({ offerable: 1, awaitingApproval: 3 });
    expect((await doorTools()).filter((n) => n.startsWith("notion__"))).toEqual([
      "notion__notion_comment_create",
    ]);
    const seen: Array<Record<string, unknown> | undefined> = [];
    await call(
      "connector.writesEnable",
      { service: "notion", wave: 2 },
      { exec: recordingExecutor(seen) },
    );
    expect(seen).toHaveLength(1);
    expect(statesOf(seen[0])).toEqual({
      notion_page_create: "newly_offerable",
      notion_page_update: "newly_offerable",
      notion_block_append: "newly_offerable",
      notion_comment_create: "already_approved",
    });
    expect(await statusOf("notion")).toMatchObject({ offerable: 4, awaitingApproval: 0 });
    expect((await doorTools()).filter((n) => n.startsWith("notion__"))).toEqual([
      "notion__notion_block_append",
      "notion__notion_comment_create",
      "notion__notion_page_create",
      "notion__notion_page_update",
    ]);
  });

  test("Confluence: a B1 opt-in (the comment approved) has the three page writes awaiting approval (B3)", async () => {
    setModelWriteEnablement(db, "confluence", 2, 1, ["confluence_comment_add"]);
    expect(await statusOf("confluence")).toMatchObject({ offerable: 1, awaitingApproval: 3 });
    const seen: Array<Record<string, unknown> | undefined> = [];
    await call(
      "connector.writesEnable",
      { service: "confluence", wave: 2 },
      { exec: recordingExecutor(seen) },
    );
    expect(statesOf(seen[0])).toEqual({
      confluence_page_create: "newly_offerable",
      confluence_page_update: "newly_offerable",
      confluence_comment_add: "already_approved",
      confluence_page_append: "newly_offerable",
    });
    expect(await statusOf("confluence")).toMatchObject({ offerable: 4, awaitingApproval: 0 });
    expect((await doorTools()).filter((n) => n.startsWith("confluence__"))).toEqual([
      "confluence__confluence_comment_add",
      "confluence__confluence_page_append",
      "confluence__confluence_page_create",
      "confluence__confluence_page_update",
    ]);
  });

  test("Gmail, Outlook and Apple enabled before B3: the draft (and, since B4a, the calendar create) await approval, nothing is offered", async () => {
    for (const [service, awaiting] of [
      ["gmail", 1],
      ["outlook", 2],
      ["apple", 2],
    ] as const) {
      setModelWriteEnablement(db, service, 2, 1, []);
      expect(await statusOf(service), service).toMatchObject({
        offerable: 0,
        awaitingApproval: awaiting,
      });
      expect(
        (await doorTools()).filter((n) => n.startsWith(`${service}__`)),
        service,
      ).toEqual([]);
    }
  });

  for (const [service, draft, calendar] of [
    ["outlook", "outlook_draft_create", "outlook_calendar_create"],
    ["apple", "apple_mail_draft_create", "apple_calendar_event_create"],
  ] as const) {
    test(`B4a: a ${service} opt-in approved at B3 (the draft) has the calendar create awaiting approval`, async () => {
      setModelWriteEnablement(db, service, 2, 1, [draft]);
      expect(await statusOf(service)).toMatchObject({ offerable: 1, awaitingApproval: 1 });
      expect((await doorTools()).filter((n) => n.startsWith(`${service}__`))).toEqual([
        `${service}__${draft}`,
      ]);
      const seen: Array<Record<string, unknown> | undefined> = [];
      await call("connector.writesEnable", { service, wave: 2 }, { exec: recordingExecutor(seen) });
      expect(seen).toHaveLength(1);
      expect(statesOf(seen[0])).toEqual({
        [draft]: "already_approved",
        [calendar]: "newly_offerable",
      });
      expect(await statusOf(service)).toMatchObject({ offerable: 2, awaitingApproval: 0 });
      expect((await doorTools()).filter((n) => n.startsWith(`${service}__`))).toEqual(
        [`${service}__${calendar}`, `${service}__${draft}`].sort((a, b) => a.localeCompare(b)),
      );
    });
  }

  test("B4a: a google_drive opt-in made earlier approved nothing offerable; the file create awaits approval", async () => {
    setModelWriteEnablement(db, "google_drive", 2, 1, []);
    expect(await statusOf("google_drive")).toMatchObject({ offerable: 0, awaitingApproval: 1 });
    expect((await doorTools()).filter((n) => n.startsWith("google_drive__"))).toEqual([]);
    const seen: Array<Record<string, unknown> | undefined> = [];
    await call(
      "connector.writesEnable",
      { service: "google_drive", wave: 2 },
      { exec: recordingExecutor(seen) },
    );
    expect(statesOf(seen[0])).toEqual({ gdrive_file_create: "newly_offerable" });
    expect(await statusOf("google_drive")).toMatchObject({ offerable: 1, awaitingApproval: 0 });
    expect((await doorTools()).filter((n) => n.startsWith("google_drive__"))).toEqual([
      "google_drive__gdrive_file_create",
    ]);
  });

  test("B4b: an obsidian opt-in from before B4b offers nothing and grants no write; a REAL approved enable turns both on", async () => {
    setModelWriteEnablement(db, "obsidian", 2, 1, []);
    expect(await statusOf("obsidian")).toMatchObject({ offerable: 0, awaitingApproval: 1 });
    expect((await doorTools()).filter((n) => n.startsWith("obsidian__"))).toEqual([]);
    expect(isObsidianWriteGrantApproved(db)).toBe(false);
    const seen: Array<Record<string, unknown> | undefined> = [];
    // The real handler over the real rows (no `rows` seam): the approval the owner gives.
    await call(
      "connector.writesEnable",
      { service: "obsidian", wave: 2 },
      { exec: recordingExecutor(seen) },
    );
    expect(statesOf(seen[0])).toEqual({ obsidian_append_to_daily_note: "newly_offerable" });
    expect(await statusOf("obsidian")).toMatchObject({ offerable: 1, awaitingApproval: 0 });
    expect((await doorTools()).filter((n) => n.startsWith("obsidian__"))).toEqual([
      "obsidian__obsidian_append_to_daily_note",
    ]);
    // Review finding 7: the accessor the Obsidian spawn reads is now true...
    expect(isObsidianWriteGrantApproved(db)).toBe(true);
    // ...and a declined re-enable cannot turn it off by accident, while a disable does.
    await refusal(
      call("connector.writesEnable", { service: "obsidian", wave: 2 }, { exec: executor(false) }),
    );
    expect(isObsidianWriteGrantApproved(db)).toBe(true);
    await call("connector.writesDisable", { service: "obsidian" });
    expect(isObsidianWriteGrantApproved(db)).toBe(false);
  });
});

describe("the Obsidian opt-in restarts the Obsidian connector (B4b, I15)", () => {
  function obsidianDeps(
    exec: ToolExecutor | undefined,
    seen: Array<boolean | undefined>,
  ): ModelWritesDeps {
    return {
      db,
      toolExecutor: exec,
      getEnforcedPolicy: () => OPEN,
      now: () => 9,
      // Records whether the opt-in row existed at the moment of the restart.
      onObsidianGrantChanged: () => {
        seen.push(getModelWriteEnablement(db, "obsidian") !== undefined);
        return Promise.resolve();
      },
    };
  }

  test("an approved enable obsidian restarts once, AFTER the row is written", async () => {
    const seen: Array<boolean | undefined> = [];
    await handleConnectorWritesEnable(
      { service: "obsidian", wave: 2 },
      obsidianDeps(executor(true), seen),
    );
    expect(seen).toEqual([true]);
  });

  test("a declined enable restarts nothing", async () => {
    const seen: Array<boolean | undefined> = [];
    await refusal(
      handleConnectorWritesEnable({ service: "obsidian" }, obsidianDeps(executor(false), seen)),
    );
    expect(seen).toEqual([]);
  });

  test("disable obsidian restarts after the row is gone, even when there was none", async () => {
    const seen: Array<boolean | undefined> = [];
    setModelWriteEnablement(db, "obsidian", 2, 1, ["obsidian_append_to_daily_note"]);
    expect(
      await handleConnectorWritesDisable({ service: "obsidian" }, obsidianDeps(undefined, seen)),
    ).toEqual({ removed: true });
    expect(
      await handleConnectorWritesDisable({ service: "obsidian" }, obsidianDeps(undefined, seen)),
    ).toEqual({ removed: false });
    expect(seen).toEqual([false, false]);
  });

  test("enabling or disabling another service restarts nothing", async () => {
    const seen: Array<boolean | undefined> = [];
    await handleConnectorWritesEnable({ service: "github" }, obsidianDeps(executor(true), seen));
    await handleConnectorWritesDisable({ service: "github" }, obsidianDeps(undefined, seen));
    expect(seen).toEqual([]);
  });

  test("dispatchConnectorRpc wires the restart to the mesh's restartObsidian", async () => {
    let restarts = 0;
    const connectorMesh = {
      iacPathDepsForEnable: () => undefined,
      restartObsidian: () => {
        restarts += 1;
        return Promise.resolve();
      },
    } as unknown as LazyConnectorMesh;
    const run = (method: string, exec?: ToolExecutor) =>
      dispatchConnectorRpc({
        method,
        params: { service: "obsidian" },
        vault: createMockVault(),
        localIndex,
        openUrl: async () => {},
        syncScheduler: undefined,
        connectorMesh,
        getEnforcedPolicy: () => OPEN,
        ...(exec === undefined ? {} : { toolExecutor: exec }),
      });
    await run("connector.writesEnable", executor(true));
    await run("connector.writesDisable");
    expect(restarts).toBe(2);
  });

  test("isObsidianWriteGrantApproved: only an obsidian opt-in that approved the append", () => {
    expect(isObsidianWriteGrantApproved(db)).toBe(false);
    setModelWriteEnablement(db, "obsidian", 2, 1, []);
    expect(isObsidianWriteGrantApproved(db)).toBe(false);
    setModelWriteEnablement(db, "github", 2, 1, ["obsidian_append_to_daily_note"]);
    expect(isObsidianWriteGrantApproved(db)).toBe(false);
    setModelWriteEnablement(db, "obsidian", 2, 1, ["obsidian_append_to_daily_note"]);
    expect(isObsidianWriteGrantApproved(db)).toBe(true);
  });
});

describe("the Obsidian enable prompt names the folders it may write (B4b Task B3)", () => {
  // The real append row has no template until B4b Task B4, so a synthetic offerable one stands in.
  const T = { target: "{vault_id}", summary: "s", fields: [] };
  const APPEND = withPreview(
    row("obsidian_append_to_daily_note", "obsidian.note.append", "write", 2),
    T,
  );
  const SCOPE = { roots: ["/n"], notes: ["/n/v/YYYY-MM-DD.md"], skipped: [] };

  function deps(exec: ToolExecutor, over: Partial<ModelWritesDeps> = {}): ModelWritesDeps {
    return {
      db,
      toolExecutor: exec,
      getEnforcedPolicy: () => OPEN,
      now: () => 3,
      rows: [APPEND],
      obsidianWriteScope: () => SCOPE,
      ...over,
    };
  }

  test("the prompt shows the roots and the vaults when the append is offerable", async () => {
    const prompts: string[] = [];
    await handleConnectorWritesEnable(
      { service: "obsidian", wave: 2 },
      deps(executor(true, prompts)),
    );
    const p = prompts[0] ?? "";
    expect(p).toContain("sandbox WRITE ONE FILE per vault: today's daily note");
    expect(p).toContain("Daily notes it may write (one file a day):\n  /n/v/YYYY-MM-DD.md");
    expect(p).toContain("Nothing else in a vault becomes writable");
    expect(isObsidianWriteGrantApproved(db)).toBe(true);
  });

  test("a scope that throws: the prompt still names the widening, folders unknown", async () => {
    const prompts: string[] = [];
    await handleConnectorWritesEnable(
      { service: "obsidian", wave: 2 },
      deps(executor(true, prompts), {
        obsidianWriteScope: () => {
          throw new Error("EACCES");
        },
      }),
    );
    expect(prompts[0]).toContain("(the files are not known to this gateway process)");
  });

  test("no scope is read when the append is not offerable", async () => {
    let reads = 0;
    const prompts: string[] = [];
    await handleConnectorWritesEnable(
      { service: "obsidian", wave: 2 },
      deps(executor(true, prompts), {
        rows: [row("obsidian_append_to_daily_note", "obsidian.note.append", "write", 2)],
        obsidianWriteScope: () => {
          reads += 1;
          return SCOPE;
        },
      }),
    );
    expect(reads).toBe(0);
    expect(prompts[0]).not.toContain("sandbox WRITE");
    expect(isObsidianWriteGrantApproved(db)).toBe(false);
  });

  test("dispatchConnectorRpc reads the scope from the mesh", async () => {
    let reads = 0;
    const connectorMesh = {
      iacPathDepsForEnable: () => undefined,
      restartObsidian: () => Promise.resolve(),
      obsidianWriteScope: () => {
        reads += 1;
        return SCOPE;
      },
    } as unknown as LazyConnectorMesh;
    const r = await dispatchConnectorRpc({
      method: "connector.writesEnable",
      params: { service: "obsidian", wave: 2 },
      vault: createMockVault(),
      localIndex,
      openUrl: async () => {},
      syncScheduler: undefined,
      connectorMesh,
      getEnforcedPolicy: () => OPEN,
      toolExecutor: executor(true),
    });
    expect(r.kind).toBe("hit");
    // The real append row is not offerable yet (its template lands in Task B4): no scope read.
    expect(reads).toBe(
      isModelOfferableRow(
        CONNECTOR_WRITE_ROWS.find((x) => x.toolId === "obsidian_append_to_daily_note") ?? APPEND,
      )
        ? 1
        : 0,
    );
  });
});

describe("D1: the Wave 4 writes are new to an earlier opt-in until it is re-run at --wave 4", () => {
  type Write = { toolId: string; wave: number; offerable: boolean; state: string };

  test("an opt-in at wave 3 offers none of Argo CD's two Wave 4 writes; enabling at wave 4 lists them as new, and approving offers them by name", async () => {
    await call("connector.writesEnable", { service: "argocd", wave: 3 }, { exec: executor(true) });
    expect(getModelWriteEnablement(db, "argocd")?.approvedToolIds.size).toBe(0);
    const prompts: string[] = [];
    await call(
      "connector.writesEnable",
      { service: "argocd", wave: 4 },
      { exec: executor(true, prompts) },
    );
    expect(prompts[0]).toContain("argocd_app_sync");
    expect(prompts[0]).toContain("(new: offered after you approve)");
    const e = getModelWriteEnablement(db, "argocd");
    expect(e?.maxWave).toBe(4);
    expect([...(e?.approvedToolIds ?? [])].sort((a, b) => a.localeCompare(b))).toEqual([
      "argocd_app_rollback",
      "argocd_app_sync",
    ]);
  });

  test("the enable payload marks each Wave 4 write newly_offerable on a first approval and already_approved on a re-run; the Bitbucket merge is never offerable", async () => {
    const seen: Array<{ writes: Write[] }> = [];
    const exec = new ToolExecutor(
      {
        requestApproval: async () => true,
      },
      localIndex,
      { dispatch: async () => ({}) },
      undefined,
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
    );
    const original = exec.gate.bind(exec);
    exec.gate = async (action) => {
      seen.push(action.payload as { writes: Write[] });
      return original(action);
    };
    await call("connector.writesEnable", { service: "jenkins", wave: 4 }, { exec });
    await call("connector.writesEnable", { service: "jenkins", wave: 4 }, { exec });
    expect(seen[0]?.writes.map((w) => [w.toolId, w.wave, w.state])).toEqual([
      ["jenkins_build_trigger", 4, "newly_offerable"],
      ["jenkins_build_abort", 4, "newly_offerable"],
    ]);
    expect(seen[1]?.writes.map((w) => w.state)).toEqual(["already_approved", "already_approved"]);

    await call("connector.writesEnable", { service: "bitbucket", wave: 4 }, { exec });
    const bb = seen[2]?.writes ?? [];
    expect(bb).toHaveLength(1);
    expect(bb[0]).toMatchObject({
      toolId: "bitbucket_pr_merge",
      offerable: false,
      state: "not_offerable",
    });
    expect(getModelWriteEnablement(db, "bitbucket")?.approvedToolIds.size).toBe(0);
  });

  test("status counts: Jenkins at wave 3 has 0 offerable and 2 awaiting; at wave 4, approved, 2 offerable", async () => {
    type Status = {
      services: Array<{
        service: string;
        offerable: number;
        awaitingApproval: number;
        writes: number;
      }>;
    };
    await call("connector.writesEnable", { service: "jenkins", wave: 3 }, { exec: executor(true) });
    let s = (await call("connector.writesStatus", {})) as Status;
    expect(s.services.find((x) => x.service === "jenkins")).toMatchObject({
      writes: 0,
      offerable: 0,
      awaitingApproval: 0,
    });
    await call("connector.writesEnable", { service: "jenkins", wave: 4 }, { exec: executor(true) });
    s = (await call("connector.writesStatus", {})) as Status;
    expect(s.services.find((x) => x.service === "jenkins")).toMatchObject({
      writes: 2,
      offerable: 2,
      awaitingApproval: 0,
    });
  });
});
