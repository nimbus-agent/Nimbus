/**
 * Phase 28 AD1: one door maker. `buildModelWriteExecutor` (the model door) and
 * `buildAgentWriteExecutor` (the MCP act door) are one-line calls of the same private maker, so the
 * two doors cannot drift on delegation (none), the before-state runner (the door's: it reads for an
 * outside origin only) or the KB-child guards (a KB accessor that throws refuses a KB-capable row).
 */
import { describe, expect, test } from "bun:test";
import { KNOWLEDGE_BASE_CHILD_REFUSAL } from "../connectors/connector-writes/model-write-refusals.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { ConsentCoordinatorImpl } from "../ipc/consent.ts";
import type { JsonRpcNotification } from "../ipc/jsonrpc.ts";
import { isBeforeReadActionType } from "./before-state.ts";
import { NO_POLICY_OVERLAY } from "./executor.ts";
import { buildAgentWriteExecutor, buildModelWriteExecutor } from "./run-ask.ts";
import type { AgentProposer, AuditSink, PlannedAction } from "./types.ts";

const PROPOSER: AgentProposer = {
  door: "agent",
  captureId: "cap_d001d001d001d001d001d001d001d001",
  label: "client",
  labelSource: "declared",
  summary: "why",
  createdAt: 0,
  expiresAt: 60_000,
};

const JIRA_REPLY = {
  key: "NIM-1",
  fields: { summary: "Fix login", status: { name: "In Progress" }, issuetype: { name: "Bug" } },
};
const NOTION_ID = "1a2b3c4d5e6f7a8b9c0d112233445566";
const NOTION_REPLY = {
  page: {
    object: "page",
    parent: { type: "page_id", page_id: "p" },
    properties: { Name: { id: "title", type: "title", title: [{ plain_text: "Runbook" }] } },
  },
  blockChildren: { results: [], has_more: false },
};

const COMMENT: PlannedAction = {
  type: "jira.comment.add",
  payload: { mcpToolId: "jira_comment_add", input: { issueKey: "NIM-1", body: "hello" } },
};
const PAGE_UPDATE: PlannedAction = {
  type: "notion.page.update",
  payload: {
    mcpToolId: "notion_page_update",
    input: { pageId: NOTION_ID, propertiesJson: '{"Status":{"select":{"name":"Done"}}}' },
  },
};

interface Fixture {
  readonly executor: ReturnType<typeof buildAgentWriteExecutor>;
  readonly prompts: string[];
  readonly dispatched: PlannedAction[];
}

type Door = "model" | "agent";

function fixture(door: Door, kb: () => undefined = () => undefined): Fixture {
  const prompts: string[] = [];
  const dispatched: PlannedAction[] = [];
  const coordinator: ConsentCoordinatorImpl = new ConsentCoordinatorImpl(
    () => (n: JsonRpcNotification) => {
      const params = n.params as Record<string, unknown>;
      prompts.push(String(params["prompt"]));
      queueMicrotask(() =>
        coordinator.handleRespond("c1", { requestId: String(params["requestId"]), approved: true }),
      );
    },
  );
  const audit: AuditSink = { recordAudit: () => {} };
  const dispatcher = {
    dispatch: async (a: PlannedAction) => {
      dispatched.push(a);
      if (!isBeforeReadActionType(a.type)) return { url: "https://x" };
      return a.type === "notion.before.read" ? NOTION_REPLY : JIRA_REPLY;
    },
  };
  const common = {
    clientId: "c1",
    consentCoordinator: coordinator,
    dispatcher,
    egressSink: NULL_EGRESS_SINK,
    policyHitl: NO_POLICY_OVERLAY,
    previewCredentialFor: () => "team" as const,
    getTribalKbConfig: kb,
  };
  const executor =
    door === "agent"
      ? buildAgentWriteExecutor({ ...common, audit })
      : buildModelWriteExecutor({ ...common, localIndex: audit as never });
  return { executor, prompts, dispatched };
}

const withOrigin = (door: Door, a: PlannedAction): PlannedAction =>
  door === "agent" ? { ...a, origin: "agent", proposer: PROPOSER } : { ...a, origin: "model" };

/** The verified part of a prompt: without the origin line and without the proposer block. */
function verified(prompt: string): string {
  return prompt
    .split("\n")
    .filter((l) => !l.startsWith("Requested by: "))
    .join("\n")
    .split("\n\nProposed by an outside agent")[0] as string;
}

describe("the two doors are one maker", () => {
  test("the same fixture yields the same verified preview, with the before-state, on both doors", async () => {
    const model = fixture("model");
    const agent = fixture("agent");
    expect((await model.executor.execute(withOrigin("model", COMMENT))).status).toBe("ok");
    expect((await agent.executor.execute(withOrigin("agent", COMMENT))).status).toBe("ok");
    expect(model.prompts).toHaveLength(1);
    expect(agent.prompts).toHaveLength(1);
    expect(verified(agent.prompts[0] as string)).toBe(verified(model.prompts[0] as string));
    expect(agent.prompts[0]).toContain("Fix login");
    expect(agent.prompts[0]).toContain("Requested by: an outside agent (unverified)");
    expect(model.prompts[0]).toContain("Requested by: the model");
    // One read, then the write, on both.
    expect(agent.dispatched.map((a) => a.type)).toEqual(["jira.before.read", "jira.comment.add"]);
    expect(model.dispatched.map((a) => a.type)).toEqual(["jira.before.read", "jira.comment.add"]);
  });

  test("an action with no origin gets no before-state read from either door's runner (readsEveryOrigin is the workflow's alone)", async () => {
    for (const door of ["model", "agent"] as const) {
      const f = fixture(door);
      expect((await f.executor.execute(COMMENT)).status).toBe("ok");
      expect(
        f.dispatched.map((a) => a.type),
        door,
      ).toEqual(["jira.comment.add"]);
      expect(f.prompts[0], door).not.toContain("Fix login");
    }
  });

  test("a KB accessor that throws refuses a KB-capable page update before any prompt, on both doors (fail closed)", async () => {
    const throwing = (): undefined => {
      throw new Error("kb unreadable");
    };
    for (const door of ["model", "agent"] as const) {
      const f = fixture(door, throwing);
      const out = await f.executor.execute(withOrigin(door, PAGE_UPDATE));
      expect(out, door).toEqual({ status: "rejected", reason: KNOWLEDGE_BASE_CHILD_REFUSAL });
      expect(f.prompts, door).toEqual([]);
      expect(
        f.dispatched.map((a) => a.type),
        door,
      ).toEqual(["notion.before.read"]);
    }
  });

  test("no delegation: an agent-origin write is approved by the accepting session's channel alone", async () => {
    const f = fixture("agent");
    await f.executor.execute(withOrigin("agent", COMMENT));
    // The consent coordinator was the only approver asked (the builder takes no delegation input).
    expect(f.prompts).toHaveLength(1);
  });
});
