import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { RemoteApprovalOutcome } from "./delegated-approval.ts";
import { DelegationStore } from "./delegation-store.ts";
import { HITL_REQUIRED, isUserMcpActionType, NO_POLICY_OVERLAY, ToolExecutor } from "./executor.ts";
import type { AuditSink, ConnectorDispatcher, ConsentChannel, PlannedAction } from "./types.ts";

/**
 * I42 — every call to a user-registered MCP server's tool needs the LOCAL owner's approval.
 *
 * A user MCP server runs arbitrary owner-approved code and its tools are not enumerable ahead of
 * time, so no frozen-set entry can name them. The gate derives the requirement from the action
 * TYPE's service prefix alone (I3) and ORs it with I2 — so it can only ever tighten.
 */

const USER_MCP = "mcp_echo.echo";

function harness(approve: boolean): {
  prompts: string[];
  dispatched: string[];
  audits: Array<{ actionType: string; hitlStatus: string }>;
  consent: ConsentChannel;
  audit: AuditSink;
  connectors: ConnectorDispatcher;
} {
  const prompts: string[] = [];
  const dispatched: string[] = [];
  const audits: Array<{ actionType: string; hitlStatus: string }> = [];
  return {
    prompts,
    dispatched,
    audits,
    consent: {
      requestApproval: async (prompt: string) => {
        prompts.push(prompt);
        return approve;
      },
    },
    audit: {
      recordAudit: (row) => {
        audits.push({ actionType: row.actionType, hitlStatus: row.hitlStatus });
      },
    },
    connectors: {
      dispatch: async (a: PlannedAction) => {
        dispatched.push(a.type);
        return { ok: true };
      },
    },
  };
}

describe("isUserMcpActionType", () => {
  test("names user-MCP action types by their service prefix", () => {
    expect(isUserMcpActionType("mcp_echo.echo")).toBe(true);
    expect(isUserMcpActionType("mcp_a_b.x_y")).toBe(true);
  });

  test("rejects everything else", () => {
    expect(isUserMcpActionType("connector.addMcp")).toBe(false);
    expect(isUserMcpActionType("github.pr_list")).toBe(false);
    // The pattern needs at least one character after the prefix.
    expect(isUserMcpActionType("mcp_.x")).toBe(false);
    // Case-sensitive: the stored ids are lowercase.
    expect(isUserMcpActionType("MCP_X.y")).toBe(false);
  });
});

describe("I42 — the executor gate requires HITL for a user-MCP action", () => {
  test("precondition: the action type is NOT in the frozen set and no policy claims it", () => {
    // Without this, the prompts below could be I2's doing rather than I42's.
    expect(HITL_REQUIRED.has(USER_MCP)).toBe(false);
  });

  test("denial: consent requested once, rejected, never dispatched", async () => {
    const h = harness(false);
    const exec = new ToolExecutor(
      h.consent,
      h.audit,
      h.connectors,
      undefined,
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
    );
    const res = await exec.execute({ type: USER_MCP, payload: { text: "hi" } });
    expect(res.status).toBe("rejected");
    expect(h.prompts).toHaveLength(1);
    expect(h.dispatched).toEqual([]);
    expect(h.audits).toEqual([{ actionType: USER_MCP, hitlStatus: "rejected" }]);
  });

  test("approval: dispatched once with an approved audit row", async () => {
    const h = harness(true);
    const exec = new ToolExecutor(
      h.consent,
      h.audit,
      h.connectors,
      undefined,
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
    );
    const res = await exec.execute({ type: USER_MCP, payload: { text: "hi" } });
    expect(res.status).toBe("ok");
    expect(h.prompts).toHaveLength(1);
    expect(h.dispatched).toEqual([USER_MCP]);
    expect(h.audits).toEqual([{ actionType: USER_MCP, hitlStatus: "approved" }]);
  });

  test("control: an ordinary ungated action does not prompt", async () => {
    const h = harness(false);
    const exec = new ToolExecutor(
      h.consent,
      h.audit,
      h.connectors,
      undefined,
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
    );
    const res = await exec.execute({ type: "search.run", payload: {} });
    expect(res.status).toBe("ok");
    expect(h.prompts).toEqual([]);
  });
});

describe("I42 — a delegate (I20) never approves a user-MCP action", () => {
  for (const [scopeKind, scopeValue] of [
    ["action_type", USER_MCP],
    ["service", "mcp_echo"],
  ] as const) {
    test(`an active ${scopeKind}-scoped delegate is bypassed; the LOCAL owner is asked`, async () => {
      const db = new Database(":memory:");
      runIndexedSchemaMigrations(db, 35);
      const store = new DelegationStore(db);
      store.create({
        delegatePeer: "peer:bob",
        scopeKind,
        scopeValue,
        expiresAt: 9e15,
        nowMs: 1,
      });
      // Precondition: the store really does report a live delegate, so a fallback is I42's doing.
      expect(store.activeDelegateePeer(USER_MCP, "mcp_echo", Date.now())).toBe("peer:bob");

      let remoteCalls = 0;
      const h = harness(false);
      const exec = new ToolExecutor(
        h.consent,
        h.audit,
        h.connectors,
        {
          store,
          isOperatorValid: () => true,
          requestRemote: async (): Promise<RemoteApprovalOutcome> => {
            remoteCalls += 1;
            return { kind: "answered", peerId: "peer:bob", approved: true };
          },
        },
        NULL_EGRESS_SINK,
        NO_POLICY_OVERLAY,
      );
      const res = await exec.execute({ type: USER_MCP, payload: {} });
      expect(remoteCalls).toBe(0);
      expect(h.prompts).toHaveLength(1);
      expect(res.status).toBe("rejected");
      expect(h.dispatched).toEqual([]);
      db.close();
    });
  }
});
