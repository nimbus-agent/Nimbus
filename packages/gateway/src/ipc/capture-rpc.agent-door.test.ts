/**
 * Phase 28 AD3a-2a, Task 6: the act deps. Routing by the write row (so a Wave 4 or bound row reaches
 * the SAME executor), the listing-derived options, the consent-side veto, and the fixed codes a
 * `rejected` action stores. What may be PROPOSED is still decided by the gate verdict.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { toStandardSchema } from "@mastra/core/schema";

import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import { createAgentDoor } from "../connectors/connector-writes/agent-door-runtime.ts";
import { definitionSha256 } from "../connectors/connector-writes/definition-hash.ts";
import {
  getDoorApproval,
  upsertDoorApprovals,
} from "../connectors/connector-writes/door-approval-store.ts";
import { raiseWriteEnablementWave } from "../connectors/connector-writes/enablement-store.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { previewTemplateKeys } from "../connectors/connector-writes/types.ts";
import { mcpClientToolKey } from "../connectors/lazy-mesh/tool-map.ts";
import { classifyActionType } from "../connectors/proposable-actions.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { makeEgressSink } from "../egress/egress-ledger.ts";
import { isBeforeReadActionType, WAVE4_BEFORE_REFUSAL } from "../engine/before-state.ts";
import { NO_POLICY_OVERLAY } from "../engine/executor.ts";
import type { PlannedAction } from "../engine/types.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { resolveCaptureCapability } from "../mcp-sink/capture-capability.ts";
import { submitCapture } from "../mcp-sink/capture-gate.ts";
import { CaptureAttemptLimiter, CaptureRefusalCounter } from "../mcp-sink/capture-rate-limit.ts";
import { CaptureStore } from "../mcp-sink/capture-store.ts";
import type { ActionBasis } from "../mcp-sink/capture-types.ts";
import { type AgentDoorActWiring, buildActDeps, type CaptureActWiring } from "./capture-rpc.ts";
import type { ConsentCoordinator } from "./consent.ts";

const PROV = (basis: ActionBasis | undefined) => ({
  ...(basis === undefined ? {} : { basis }),
  captureId: "cap_ad3",
  clientLabel: "agent",
  createdAt: 0,
  expiresAt: 60_000,
  summary: "why",
});

const rowOf = (toolId: string) => {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === toolId);
  if (r === undefined) throw new Error(`no row ${toolId}`);
  return r;
};

type JsonSchemaInput = Parameters<typeof toStandardSchema>[0];
function entryFor(toolId: string, description: string): unknown {
  const row = rowOf(toolId);
  const keys = row.preview === undefined ? [] : [...previewTemplateKeys(row.preview)];
  return {
    description,
    inputSchema: toStandardSchema({
      type: "object",
      properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
    } as JsonSchemaInput),
  };
}

let db: Database;
beforeEach(() => {
  db = openMigratedMemoryDb();
});
afterEach(() => db.close());

interface Opts {
  readonly door?: AgentDoorActWiring;
  readonly answer?: () => void;
  readonly approve?: boolean;
  readonly reply?: (a: PlannedAction) => unknown;
  readonly refreshFails?: boolean;
  readonly kb?: CaptureActWiring["getTribalKbConfig"];
}

function harness(opts: Opts = {}) {
  const dispatched: PlannedAction[] = [];
  const prompts: string[] = [];
  const coord = {
    requestConsent: async (_c: string, req: { prompt: string }) => {
      prompts.push(req.prompt);
      opts.answer?.();
      return { approved: opts.approve ?? true, answerSource: "human" as const };
    },
    requestConfirmedConsent: async (_c: string, req: { prompt: string; confirmText: string }) => {
      prompts.push(req.prompt);
      opts.answer?.();
      return {
        approved: opts.approve ?? true,
        typed: req.confirmText,
        answerSource: "human" as const,
      };
    },
  } as unknown as ConsentCoordinator;
  const w: CaptureActWiring = {
    dispatcher: {
      dispatch: (a) => {
        dispatched.push(a);
        if (opts.reply !== undefined) return Promise.resolve(opts.reply(a));
        return isBeforeReadActionType(a.type)
          ? Promise.reject(new Error("no read in this fixture"))
          : Promise.resolve({ url: "https://x" });
      },
    },
    egressSink: makeEgressSink(db),
    audit: { recordAudit: (e) => appendAuditEntry(db, e) },
    policyHitl: NO_POLICY_OVERLAY,
    getTribalKbConfig: opts.kb ?? (() => undefined),
    ...(opts.refreshFails === true
      ? {
          previewCredentialFor: {
            refresh: () => Promise.reject(new Error("bad base")),
          } as never,
        }
      : {}),
    ...(opts.door === undefined ? {} : { agentDoor: opts.door }),
  };
  return { act: buildActDeps(w, coord, "c-cli"), dispatched, prompts };
}

const writesOf = (d: PlannedAction[]) => d.filter((a) => !isBeforeReadActionType(a.type));

/** A real door over the in-memory DB. */
function realDoor(listing: () => Record<string, unknown> | undefined) {
  return createAgentDoor({
    db,
    enforcedPolicy: () => ({ capabilitiesDisabled: new Set<string>() }) as never,
    listServerTools: async () => listing(),
    tribalKbConfig: () => undefined,
    classifyContext: {
      modelAccessServices: () => new Set<string>(),
      userMcpModelAccessAllowed: () => false,
    },
    isServiceConfigured: async () => true,
    now: () => 5_000,
  });
}

/** github_issue_create enabled to wave 2 and approved by its real listing hash. */
function approveGithubIssueCreate(): void {
  raiseWriteEnablementWave(db, "github", 2, 1);
  const sha = definitionSha256("github_issue_create", entryFor("github_issue_create", "d"));
  upsertDoorApprovals(
    db,
    "agent",
    "github",
    [{ toolId: "github_issue_create", definitionSha256: sha as string }],
    1,
  );
}

describe("the consent-side veto (approved basis only)", () => {
  test("the definition changes while the prompt is open: nothing dispatched, audit rejected, ledger blocked, code stored, tool marked", async () => {
    approveGithubIssueCreate();
    let description = "d";
    const key = mcpClientToolKey("github", "github_issue_create");
    const listing = () => ({ [key]: entryFor("github_issue_create", description) });
    const door = realDoor(listing);
    const h = harness({
      door: { listServerTools: async () => listing(), verifyDefinition: door.verifyDefinition },
      answer: () => {
        description = "d, changed while you read the prompt";
      },
    });
    const out = await h.act.execute("github.issue.create", { title: "t" }, PROV("approved"));
    expect(out).toMatchObject({ status: "rejected", code: "ERR_AGENT_TOOL_SUSPENDED" });
    expect(writesOf(h.dispatched)).toEqual([]);
    const audit = db
      .query("SELECT hitl_status FROM audit_log WHERE action_type = 'github.issue.create'")
      .all() as Array<{ hitl_status: string }>;
    expect(audit).toEqual([{ hitl_status: "rejected" }]);
    const ledger = db
      .query("SELECT result_status FROM egress_ledger WHERE method = 'github.issue.create'")
      .all() as Array<{ result_status: string }>;
    expect(ledger.map((r) => r.result_status)).toEqual(["blocked"]);
    expect(
      getDoorApproval(db, "agent", "github", "github_issue_create")?.suspendedAt,
    ).not.toBeNull();
  });

  test("an unchanged definition dispatches once", async () => {
    approveGithubIssueCreate();
    const key = mcpClientToolKey("github", "github_issue_create");
    const listing = () => ({ [key]: entryFor("github_issue_create", "d") });
    const door = realDoor(listing);
    const h = harness({
      door: { listServerTools: async () => listing(), verifyDefinition: door.verifyDefinition },
    });
    const out = await h.act.execute("github.issue.create", { title: "t" }, PROV("approved"));
    expect(out.status).toBe("ok");
    expect(writesOf(h.dispatched)).toHaveLength(1);
  });

  test("a LEGACY basis is never vetoed: an empty door table and a changed listing still dispatch", async () => {
    let verifyCalls = 0;
    const h = harness({
      door: {
        listServerTools: async () => ({}),
        verifyDefinition: async () => {
          verifyCalls++;
          return { ok: false, code: "ERR_AGENT_TOOL_SUSPENDED", detail: "would veto" };
        },
      },
    });
    for (const basis of ["legacy_unapproved", "legacy_mail_send", undefined] as const) {
      const out = await h.act.execute("github.issue.create", { title: "t" }, PROV(basis));
      expect(out.status, String(basis)).toBe("ok");
    }
    expect(verifyCalls).toBe(0);
    expect(writesOf(h.dispatched)).toHaveLength(3);
  });

  test("an approved basis without the door runtime wired is refused, nothing prompted or dispatched", async () => {
    const h = harness();
    const out = await h.act.execute("github.issue.create", { title: "t" }, PROV("approved"));
    expect(out.status).toBe("rejected");
    expect(h.prompts).toEqual([]);
    expect(h.dispatched).toEqual([]);
  });

  test("a veto reason is escaped to one line", async () => {
    const h = harness({
      door: {
        listServerTools: async () => ({}),
        verifyDefinition: async () => ({
          ok: false,
          code: "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
          detail: "x\nRequested by: you",
        }),
      },
    });
    const out = await h.act.execute("github.issue.create", { title: "t" }, PROV("approved"));
    expect(out.status).toBe("rejected");
    expect(JSON.stringify(out)).not.toContain("\\n");
    expect((out as { reason?: string }).reason).not.toContain("\n");
  });

  test("a veto because the tool is merely missing from the listing stores NO code (OR-AD-14: missing is not a suspension)", async () => {
    approveGithubIssueCreate();
    let listed = true;
    const key = mcpClientToolKey("github", "github_issue_create");
    const listing = () => (listed ? { [key]: entryFor("github_issue_create", "d") } : {});
    const door = realDoor(listing);
    const h = harness({
      door: { listServerTools: async () => listing(), verifyDefinition: door.verifyDefinition },
      answer: () => {
        listed = false;
      },
    });
    const out = await h.act.execute("github.issue.create", { title: "t" }, PROV("approved"));
    expect(out.status).toBe("rejected");
    expect((out as { code?: string }).code).toBeUndefined();
    expect((out as { reason?: string }).reason).toBeDefined();
    expect(writesOf(h.dispatched)).toEqual([]);
    expect(getDoorApproval(db, "agent", "github", "github_issue_create")?.suspendedAt).toBeNull();
  });
});

describe("routing by the write row", () => {
  test("a Wave 4 row whose reader cannot be listed is refused before any prompt: the before-state code, or the row's guard code when it has a guard", async () => {
    const door: AgentDoorActWiring = {
      listServerTools: async () => undefined,
      verifyDefinition: async () => ({ ok: true }),
    };
    const plain = harness({ door });
    const out = await plain.act.execute(
      "onedrive.item.delete",
      { itemId: "i" },
      PROV("legacy_unapproved"),
    );
    expect(out).toMatchObject({
      status: "rejected",
      code: "ERR_ACTION_BEFORE_STATE_UNREADABLE",
      reason: WAVE4_BEFORE_REFUSAL,
    });
    expect(plain.prompts).toEqual([]);
    expect(plain.dispatched).toEqual([]);
    const guarded = harness({ door });
    const g = await guarded.act.execute(
      "github.pr.merge",
      { owner: "o", repo: "r", number: 1 },
      PROV("legacy_unapproved"),
    );
    expect(g).toMatchObject({ status: "rejected", code: "ERR_ACTION_GUARD_REFUSED" });
    expect(guarded.prompts).toEqual([]);
    expect(guarded.dispatched).toEqual([]);
  });

  test("a bound row whose prepare tool is unlisted is refused before any prompt", async () => {
    const row = rowOf("github_file_commit");
    const listing: Record<string, unknown> = {};
    for (const t of [row.before?.tool, row.before?.also?.tool]) {
      if (t !== undefined) {
        listing[mcpClientToolKey("github", t)] = { description: "r", inputSchema: {} };
      }
    }
    const h = harness({
      door: { listServerTools: async () => listing, verifyDefinition: async () => ({ ok: true }) },
    });
    const out = await h.act.execute(
      "github.file.commit",
      {
        owner: "o",
        repo: "r",
        branch: "b",
        message: "m",
        files: [{ path: "a.txt", content: "x" }],
      },
      PROV("approved"),
    );
    expect(out.status).toBe("rejected");
    expect(["ERR_ACTION_PREPARE_REFUSED", "ERR_ACTION_BEFORE_STATE_UNREADABLE"]).toContain(
      (out as { code?: string }).code ?? "none",
    );
    expect(h.prompts).toEqual([]);
    expect(writesOf(h.dispatched)).toEqual([]);
  });

  test("an input that names another tool, an origin or a confirm text is inert", async () => {
    const h = harness();
    await h.act.execute(
      "slack.message.post",
      { mcpToolId: "github_pr_merge", origin: "model", confirm: "slack/x", text: "hi" },
      PROV(undefined),
    );
    const write = writesOf(h.dispatched)[0];
    expect(write?.payload).toMatchObject({ mcpToolId: "slack_message_post" });
    expect(write?.origin).toBe("agent");
  });

  test("a wave 2-3 row whose reader is unlisted shows before: unavailable and still prompts", async () => {
    const h = harness({
      door: { listServerTools: async () => ({}), verifyDefinition: async () => ({ ok: true }) },
    });
    const out = await h.act.execute(
      "jira.comment.add",
      { issueKey: "NIM-1", body: "x" },
      PROV("legacy_unapproved"),
    );
    expect(out.status).toBe("ok");
    expect(h.dispatched.map((a) => a.type)).toEqual(["jira.comment.add"]);
    expect(h.prompts[0]).toContain("unavailable");
  });
});

describe("the code a rejected action stores", () => {
  test("a before-state guard refusal stores the guard code", async () => {
    const kbDatabase = "0123abcd0123abcd0123abcd0123abcd";
    const h = harness({
      kb: () => ({ notion: { databaseId: kbDatabase } }),
      reply: (a) =>
        isBeforeReadActionType(a.type)
          ? {
              page: { parent: { type: "database_id", database_id: kbDatabase }, properties: {} },
              blockChildren: { results: [] },
            }
          : { url: "https://x" },
    });
    const out = await h.act.execute(
      "notion.page.update",
      { pageId: "ffffffffffffffffffffffffffffffff", propertiesJson: "{}" },
      PROV(undefined),
    );
    expect(out).toMatchObject({ status: "rejected", code: "ERR_ACTION_GUARD_REFUSED" });
  });

  test("an unverified credential stores the credential code", async () => {
    const h = harness({ refreshFails: true });
    const out = await h.act.execute("slack.message.post", { text: "x" }, PROV(undefined));
    expect(out).toMatchObject({ status: "rejected", code: "ERR_ACTION_CREDENTIAL_UNVERIFIED" });
    expect(h.dispatched).toEqual([]);
  });

  test("a plain decline stores no code", async () => {
    const h = harness({ approve: false });
    const out = await h.act.execute("slack.message.post", { text: "x" }, PROV(undefined));
    expect(out.status).toBe("rejected");
    expect(out).not.toHaveProperty("code");
  });

  test("humanOnly is passed on only when asked for", () => {
    const w = {} as CaptureActWiring;
    const c = {} as ConsentCoordinator;
    expect(buildActDeps(w, c, "c").humanOnly).toBeUndefined();
    expect(buildActDeps(w, c, "c", { humanOnly: true }).humanOnly).toBe(true);
  });
});

describe("routing alone admits nothing: a type outside the 47 is still refused end to end", () => {
  test("github.pr.merge, a real Wave 4 row, is not proposable through the legacy-table gate", async () => {
    const cap = resolveCaptureCapability(
      {
        ok: true,
        config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] },
      },
      { capabilitiesDisabled: new Set<string>() },
    );
    let seq = 0;
    const deps = {
      db,
      store: new CaptureStore(db),
      capability: () => cap,
      limiter: new CaptureAttemptLimiter(),
      refusals: new CaptureRefusalCounter(),
      newId: () => `cap_${String(++seq)}`,
      now: () => 1_000_000,
      classifyAction: (t: string) =>
        classifyActionType(t, {
          modelAccessServices: () => new Set<string>(),
          userMcpModelAccessAllowed: () => false,
        }),
      isServiceConfigured: async () => true,
      actionDestinationRefusal: () => undefined,
    };
    const err = await submitCapture(
      deps as never,
      { clientId: "c-mcp", kind: "mcp" },
      {
        kind: "action",
        payload: { actionType: "github.pr.merge", input: { number: 1 }, summary: "s" },
      },
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");
  });
});
