import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { toStandardSchema } from "@mastra/core/schema";

import {
  getModelWriteEnablement,
  setModelWriteEnablement,
  writesEnabledBy,
} from "../connectors/connector-writes/enablement-store.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { isModelOfferableRow } from "../connectors/connector-writes/model-offerable.ts";
import { createModelWriteToolSource } from "../connectors/connector-writes/model-write-source.ts";
import { previewTemplateKeys, row, withPreview } from "../connectors/connector-writes/types.ts";
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
    // B1 templates the comment write: it is the one row the owner approves now.
    for (const r of expected) {
      const tag = isModelOfferableRow(r) ? "(new: offered after you approve)" : "(not offered yet)";
      expect(p).toContain(`${r.toolId}  ${r.actionType}  wave ${r.wave}  ${tag}`);
    }
    expect(expected.filter(isModelOfferableRow).map((r) => r.toolId)).toEqual([
      "github_issue_comment_create",
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
    // Covered but not offerable: argocd's writes have previews but are wave 4 with no reader.
    expect(s.services.find((x) => x.service === "argocd")).toMatchObject({
      enabled: false,
      writes: 2,
      offerable: 0,
    });
    // The approved enable covered the one offerable github write (B1's comment row).
    expect(s.services.find((x) => x.service === "github")).toMatchObject({
      offerable: 1,
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

describe("re-consent on the real B1 rows (V84, Task 5)", () => {
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

  test("GitHub: one write awaits approval (the comment); its other wave-2 rows are not offerable", async () => {
    setModelWriteEnablement(db, "github", 2, 1, []);
    expect(await statusOf("github")).toMatchObject({ offerable: 0, awaitingApproval: 1 });
    expect((await doorTools()).filter((n) => n.startsWith("github__"))).toEqual([]);
    const seen: Array<Record<string, unknown> | undefined> = [];
    await call(
      "connector.writesEnable",
      { service: "github", wave: 2 },
      { exec: recordingExecutor(seen) },
    );
    expect(statesOf(seen[0])).toEqual({
      github_issue_create: "not_offerable",
      github_issue_comment_create: "newly_offerable",
      github_issue_labels_add: "not_offerable",
      github_issue_assignees_add: "not_offerable",
      github_issue_state_set: "not_offerable",
    });
    expect(await statusOf("github")).toMatchObject({ offerable: 1, awaitingApproval: 0 });
    expect((await doorTools()).filter((n) => n.startsWith("github__"))).toEqual([
      "github__github_issue_comment_create",
    ]);
  });
});
