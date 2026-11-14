/**
 * Phase 28 AD5a, Task 7: the executor's approval prompt, the desktop's details and the audit row for an
 * outside agent's call of a user-MCP tool (D-6; I42). The call block comes before the verbatim input and
 * the proposer block stays last; a model-origin or owner call of the same tool is byte-identical to what it
 * was; the audit row projects the new field to the definition hash alone and OMITS the key whenever the
 * action carries no approved call.
 */
import { describe, expect, test } from "bun:test";

import {
  consentDisplayPayload,
  formatConsentPrompt,
  NO_POLICY_OVERLAY,
  ToolExecutor,
} from "./executor.ts";
import type {
  AgentProposer,
  AuditSink,
  ConnectorDispatcher,
  ConsentChannel,
  PlannedAction,
  UserMcpCallFacts,
} from "./types.ts";

const PROPOSER: AgentProposer = {
  door: "agent",
  captureId: "cap_0123456789abcdef0123456789abcdef",
  label: "agent",
  labelSource: "declared",
  summary: "add a note",
  createdAt: 0,
  expiresAt: 60_000,
};

const SHA = `3fa9c1d2e4b7${"0".repeat(52)}`;

const FACTS: UserMcpCallFacts = {
  serviceId: "mcp_notes",
  tool: "append",
  registeredAt: Date.UTC(2026, 10, 1),
  readPaths: ["/data/notes"],
  netHosts: [],
  writePaths: [],
  approval: {
    approvedAt: Date.UTC(2026, 10, 5),
    definitionSha256: SHA,
    description: "adds a note",
  },
};

const INPUT = { text: "hello" };

const base: PlannedAction = {
  type: "mcp_notes.append",
  origin: "agent",
  proposer: PROPOSER,
  payload: { mcpToolId: "mcp_notes_append", input: INPUT },
};
const APPROVED: PlannedAction = { ...base, userMcpCall: FACTS };
const LEGACY: PlannedAction = { ...base, userMcpCall: { ...FACTS, approval: null } };

describe("the prompt", () => {
  test("approved: the call block sits between the origin line and the input, the proposer block is last", () => {
    const lines = formatConsentPrompt(APPROVED).split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "Action requires your approval",
      "",
      "Type: mcp_notes.append",
      "Requested by: an outside agent (unverified)",
      "",
    ]);
    expect(lines[5]).toBe(
      "User MCP server: mcp_notes (third-party code you registered on 2026-11-01T00:00:00.000Z)",
    );
    const inputAt = lines.indexOf("Input (verbatim, exactly what will be sent):");
    const beforeStateAt = lines.indexOf("No before-state is available for a user MCP tool.");
    expect(beforeStateAt).toBeGreaterThan(5);
    expect(inputAt).toBeGreaterThan(beforeStateAt);
    expect(lines[inputAt - 1]).toBe("");
    expect(lines.at(-3)).toBe("");
    expect(lines.at(-2)).toStartWith("Proposed by an outside agent (UNVERIFIED label");
    expect(lines.at(-1)).toBe("Agent's summary (UNVERIFIED): add a note");
    expect(lines).toContain(
      "Approved for outside agents on 2026-11-05T00:00:00.000Z, definition 3fa9c1d2e4b7",
    );
  });

  test("legacy: the same block with the not-approved line", () => {
    const text = formatConsentPrompt(LEGACY);
    expect(text).toContain("Not approved for outside agents by name.");
    expect(text).not.toContain("Tool description");
    expect(text).toContain("User MCP server: mcp_notes");
  });

  test("an agent action with no call facts (no door wired) keeps today's prompt exactly", () => {
    expect(formatConsentPrompt(base).split("\n")).toEqual([
      "Action requires your approval",
      "",
      "Type: mcp_notes.append",
      "Requested by: an outside agent (unverified)",
      "",
      "Input (verbatim, exactly what will be sent):",
      JSON.stringify(INPUT, null, 2).split("\n")[0] ?? "",
      ...JSON.stringify(INPUT, null, 2).split("\n").slice(1),
      "",
      ...formatConsentPrompt(base).split("\n").slice(-2),
    ]);
  });

  test("a model-origin and an owner call of the same tool are byte-identical to before", () => {
    const { proposer: _p, ...noProposer } = base;
    const model = { ...noProposer, origin: "model" as const };
    expect(formatConsentPrompt(model)).toBe(
      [
        "Action requires your approval",
        "",
        "Type: mcp_notes.append",
        "Requested by: the model",
        "",
        `Details: ${JSON.stringify({ mcpToolId: "mcp_notes_append", input: INPUT })}`,
      ].join("\n"),
    );
    const { origin: _o, ...owner } = noProposer;
    expect(formatConsentPrompt(owner)).toBe(
      [
        "Action requires your approval",
        "",
        "Type: mcp_notes.append",
        "",
        `Details: ${JSON.stringify({ mcpToolId: "mcp_notes_append", input: INPUT })}`,
      ].join("\n"),
    );
  });

  test("call facts on a model-origin or origin-less action are inert: nothing is rendered", () => {
    const { proposer: _p, ...noProposer } = base;
    const withFacts = { ...noProposer, origin: "model" as const, userMcpCall: FACTS };
    const without = { ...noProposer, origin: "model" as const };
    expect(formatConsentPrompt(withFacts)).toBe(formatConsentPrompt(without));
    const { origin: _o, ...ownerFacts } = withFacts;
    expect(formatConsentPrompt(ownerFacts)).not.toContain("User MCP server:");
  });
});

describe("the desktop's details", () => {
  test("an approved call carries userMcp (sanitised); a call with no facts carries none", () => {
    const d = consentDisplayPayload(APPROVED);
    expect(d?.["userMcp"]).toMatchObject({
      serviceId: "mcp_notes",
      approved: true,
      definitionSha12: "3fa9c1d2e4b7",
    });
    expect(JSON.stringify(d)).not.toContain(SHA);
    expect(Object.hasOwn(consentDisplayPayload(base) ?? {}, "userMcp")).toBe(false);
  });

  test("a payload key named userMcp never wins over the gateway's", () => {
    const d = consentDisplayPayload({
      ...APPROVED,
      payload: { mcpToolId: "mcp_notes_append", input: INPUT, userMcp: "forged" },
    });
    expect((d?.["userMcp"] as { approved?: boolean } | undefined)?.approved).toBe(true);
  });
});

function harness(): {
  exec: ToolExecutor;
  audits: Array<{ actionType: string; actionJson: string }>;
  egress: Array<Record<string, unknown>>;
} {
  const audits: Array<{ actionType: string; actionJson: string }> = [];
  const egress: Array<Record<string, unknown>> = [];
  const consent: ConsentChannel = {
    requestApproval: async () => ({ approved: true, answerSource: "human" as const }),
  };
  const audit: AuditSink = {
    recordAudit: (e) => audits.push({ actionType: e.actionType, actionJson: e.actionJson }),
  };
  const connectors: ConnectorDispatcher = { dispatch: async () => ({ ok: true }) };
  const exec = new ToolExecutor(
    consent,
    audit,
    connectors,
    undefined,
    { append: (e) => egress.push(e as unknown as Record<string, unknown>) },
    NO_POLICY_OVERLAY,
    () => "team",
  );
  return { exec, audits, egress };
}

function actionOf(h: ReturnType<typeof harness>): Record<string, unknown> {
  const row = h.audits.find((a) => a.actionType === "mcp_notes.append");
  return (JSON.parse(row?.actionJson ?? "{}") as { action: Record<string, unknown> }).action;
}

describe("the audit row", () => {
  test("an approved call: the hash only, placed after the proposer, nothing else of the facts", async () => {
    const h = harness();
    expect((await h.exec.execute(APPROVED)).status).toBe("ok");
    const action = actionOf(h);
    expect(Object.keys(action)).toEqual(["type", "proposer", "userMcp", "origin", "payload"]);
    expect(action["userMcp"]).toEqual({ definitionSha256: SHA });
    const raw = h.audits.map((a) => a.actionJson).join("\n");
    expect(raw).not.toContain("adds a note");
    expect(raw).not.toContain("/data/notes");
    expect(Object.hasOwn(action, "userMcpCall")).toBe(false);
  });

  test("a legacy call: the key is OMITTED and the row is exactly today's", async () => {
    const h = harness();
    expect((await h.exec.execute(LEGACY)).status).toBe("ok");
    const action = actionOf(h);
    expect(Object.keys(action)).toEqual(["type", "proposer", "origin", "payload"]);
    expect(Object.hasOwn(action, "userMcp")).toBe(false);
    expect(Object.hasOwn(action, "userMcpCall")).toBe(false);
  });

  test("facts on a model-origin action never reach the row: no userMcp key, no facts", async () => {
    const h = harness();
    const { proposer: _p, ...noProposer } = APPROVED;
    expect((await h.exec.execute({ ...noProposer, origin: "model" })).status).toBe("ok");
    const action = actionOf(h);
    expect(Object.keys(action)).toEqual(["type", "origin", "payload"]);
  });

  test("a call with no facts: the row is byte-identical to the legacy one", async () => {
    const a = harness();
    const b = harness();
    await a.exec.execute(base);
    await b.exec.execute(LEGACY);
    expect(a.audits.find((x) => x.actionType === "mcp_notes.append")?.actionJson).toBe(
      b.audits.find((x) => x.actionType === "mcp_notes.append")?.actionJson,
    );
  });

  test("the dispatcher still receives only the gateway's key and the input", async () => {
    const seen: PlannedAction[] = [];
    const h = harness();
    const exec = new ToolExecutor(
      { requestApproval: async () => ({ approved: true, answerSource: "human" as const }) },
      { recordAudit: () => undefined },
      {
        dispatch: async (a) => {
          seen.push(a);
          return { ok: true };
        },
      },
      undefined,
      { append: () => undefined },
      NO_POLICY_OVERLAY,
      () => "team",
    );
    void h;
    await exec.execute(APPROVED);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.payload).toEqual({ mcpToolId: "mcp_notes_append", input: INPUT });
  });
});
