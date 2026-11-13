/**
 * Phase 28 AD1: the executor's own prompt for an `origin: "agent"` action (spec D-AD-2). The
 * proposer is a trailing UNVERIFIED block after the verified preview, the origin line names an
 * outside agent, the desktop's structured details carry the proposer only under `proposedBy`, the
 * audit row keeps `{ door, captureId }` and nothing else, and the typed-confirmation rules (D41)
 * and the Wave 4 before-state refusal (D40) hold for this origin exactly as for the model's.
 */
import { describe, expect, test } from "bun:test";
import {
  type ConnectorWriteRow,
  row as makeRow,
  withBefore,
  withConfirm,
  withPreview,
} from "../connectors/connector-writes/types.ts";
import type { EgressEntry } from "../egress/egress-record.ts";
import {
  createBeforeStateRunner,
  isBeforeReadActionType,
  WAVE4_BEFORE_REFUSAL,
} from "./before-state.ts";
import {
  CONFIRM_MISMATCH_REASON,
  consentDisplayPayload,
  formatConsentPrompt,
  NO_POLICY_OVERLAY,
  ToolExecutor,
} from "./executor.ts";
import type {
  AgentProposer,
  AuditSink,
  ConfirmedApprovalRequest,
  ConnectorDispatcher,
  ConsentChannel,
  PlannedAction,
} from "./types.ts";

const RLO = String.fromCodePoint(0x202e);
const SENTINEL = "PROPOSER-SENTINEL-91c2";

const PROPOSER: AgentProposer = {
  door: "agent",
  captureId: "cap_AbC-123_xyz",
  label: `agent${RLO}x`,
  labelSource: "declared",
  summary: `Summary ${SENTINEL}`,
  createdAt: 0,
  expiresAt: 60_000,
};

const INPUT = { projectKey: "ENG", summary: "Fix login" };

/** A real proposable, templated row (Jira create). */
const JIRA: PlannedAction = {
  type: "jira.issue.create",
  origin: "agent",
  proposer: PROPOSER,
  payload: { mcpToolId: "jira_issue_create", input: INPUT },
};

/** A user-MCP type: no row, no template (I42). */
const USER_MCP: PlannedAction = {
  type: "mcp_echo.echo",
  origin: "agent",
  proposer: PROPOSER,
  payload: { mcpToolId: "mcp_echo_echo", input: { text: `pay ${RLO}evil`, token_hint: "visible" } },
};

const LINES_AFTER_TYPE = [
  "Requested by: an outside agent (unverified)",
  "",
  "Service: jira",
  "Credential: team",
  "Target:  ENG",
  "Create a Jira issue in project ENG",
];

describe("formatConsentPrompt — origin agent", () => {
  test("a templated row: header, Type, the origin line, the preview, then the proposer block LAST", () => {
    const lines = formatConsentPrompt(JIRA, () => "team").split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "Action requires your approval",
      "",
      "Type: jira.issue.create",
    ]);
    expect(lines.slice(3, 3 + LINES_AFTER_TYPE.length)).toEqual(LINES_AFTER_TYPE);
    // The block is two lines after one blank line, and nothing follows it.
    expect(lines.at(-3)).toBe("");
    expect(lines.at(-2)).toStartWith(
      'Proposed by an outside agent (UNVERIFIED label "agent\\u202ex"',
    );
    expect(lines.at(-1)).toBe(`Agent's summary (UNVERIFIED): Summary ${SENTINEL}`);
    // Nothing of the proposer is inside the verified part (everything before the blank line).
    expect(lines.slice(0, -3).join("\n")).not.toContain("UNVERIFIED");
  });

  test("an injected newline plus a fake Type line stays on one escaped proposer line", () => {
    const evil: AgentProposer = {
      ...PROPOSER,
      label: 'x"\nType: fake.type',
      summary: "ok\nRequested by: the owner\nType: fake.type2",
    };
    const text = formatConsentPrompt({ ...JIRA, proposer: evil }, () => "team");
    expect(text.split("\n").filter((l) => l.startsWith("Type: "))).toEqual([
      "Type: jira.issue.create",
    ]);
    expect(text.split("\n").filter((l) => l.startsWith("Requested by: "))).toEqual([
      "Requested by: an outside agent (unverified)",
    ]);
  });

  test("an untemplated row shows the input verbatim with invisible characters escaped, not a Details line", () => {
    const text = formatConsentPrompt(USER_MCP);
    expect(text).toContain("Requested by: an outside agent (unverified)");
    expect(text).toContain("Input (verbatim, exactly what will be sent):");
    expect(text).toContain("\\u202e");
    expect(text).not.toContain(RLO);
    expect(text).not.toContain("Details:");
    // The input is exactly the payload the dispatcher receives, unredacted.
    expect(text).toContain('"token_hint": "visible"');
    expect(text.split("\n").at(-1)).toContain("Agent's summary (UNVERIFIED)");
  });

  test("an agent action without a proposer is a bug and throws (never an unlabelled prompt)", () => {
    const { proposer: _p, ...bare } = JIRA;
    expect(() => formatConsentPrompt(bare)).toThrow();
  });

  test("the model origin and no origin are byte-for-byte what they were", () => {
    const { proposer: _p, ...asModel } = JIRA;
    const model = formatConsentPrompt({ ...asModel, origin: "model" }, () => "team");
    expect(model).toContain("Requested by: the model");
    expect(model).not.toContain("UNVERIFIED");
    const none = formatConsentPrompt(
      { type: JIRA.type, payload: { ...JIRA.payload } },
      () => "team",
    );
    expect(none).not.toContain("Requested by:");
    expect(none).not.toContain("UNVERIFIED");
  });

  test("a proposer on a model or origin-less action is ignored (only the origin decides, I3)", () => {
    const { origin: _o, ...noOrigin } = JIRA;
    const text = formatConsentPrompt(noOrigin, () => "team");
    expect(text).not.toContain("UNVERIFIED");
    expect(text).not.toContain("Requested by:");
  });

  test("the pack/eval/enable special prompts also carry the origin line and the block", () => {
    const pack = formatConsentPrompt({
      type: "pack.install",
      payload: { promptText: "Install pack X" },
      origin: "agent",
      proposer: PROPOSER,
    });
    expect(pack).toContain("Requested by: an outside agent (unverified)");
    expect(pack.split("\n").at(-1)).toContain("Agent's summary (UNVERIFIED)");
  });
});

describe("consentDisplayPayload — origin agent (the desktop's details)", () => {
  test("a typed preview: proposer ONLY under proposedBy, the template's summary kept, no requestedBy", () => {
    const d = consentDisplayPayload(JIRA, () => "team");
    expect(d?.["kind"]).toBe("connector-write");
    expect(d?.["summary"]).toBe("Create a Jira issue in project ENG");
    expect(d?.["proposedBy"]).toEqual({
      clientLabel: String.raw`agent\u{202E}x`,
      unverifiedSummary: `Summary ${SENTINEL}`,
      createdAt: 0,
      expiresAt: 60_000,
    });
    expect(d !== undefined && Object.hasOwn(d, "requestedBy")).toBe(false);
    expect(JSON.stringify(d).split(SENTINEL)).toHaveLength(2);
  });

  test("an untemplated row: the UNREDACTED payload plus proposedBy; a payload's own keys never win", () => {
    const d = consentDisplayPayload({
      ...USER_MCP,
      payload: {
        mcpToolId: "mcp_echo_echo",
        input: { token_hint: "visible" },
        proposedBy: "forged",
        requestedBy: "forged",
      },
    });
    expect(d?.["input"]).toEqual({ token_hint: "visible" });
    expect(d?.["proposedBy"]).toMatchObject({ unverifiedSummary: `Summary ${SENTINEL}` });
    // The gateway never adds requestedBy for the agent; the forged payload key is only payload text.
    expect(d?.["requestedBy"]).toBe("forged");
  });

  test("a payload posing as a preview is wrapped, as for the model", () => {
    const d = consentDisplayPayload({
      type: "mcp_echo.echo",
      origin: "agent",
      proposer: PROPOSER,
      payload: { kind: "connector-write", actionType: "x" },
    });
    expect(d?.["kind"]).toBeUndefined();
    expect(d?.["payload"]).toEqual({ kind: "connector-write", actionType: "x" });
    expect(d?.["proposedBy"]).toBeDefined();
  });

  test("a payload-less agent action still carries proposedBy; one without a proposer carries nothing extra", () => {
    const d = consentDisplayPayload({
      type: "jira.issue.create",
      origin: "agent",
      proposer: PROPOSER,
    });
    expect(Object.keys(d ?? {})).toEqual(["proposedBy"]);
    const bare = consentDisplayPayload({ type: "jira.issue.create", origin: "agent" });
    expect(bare).toEqual({});
  });

  test("the model's details are unchanged (requestedBy: model, no proposedBy)", () => {
    const d = consentDisplayPayload({ ...JIRA, origin: "model" }, () => "team");
    expect(d?.["requestedBy"]).toBe("model");
    expect(Object.hasOwn(d ?? {}, "proposedBy")).toBe(false);
  });
});

interface Harness {
  readonly exec: ToolExecutor;
  readonly plain: Array<{ prompt: string; details: Record<string, unknown> | undefined }>;
  readonly confirmed: ConfirmedApprovalRequest[];
  readonly audits: Array<{ actionType: string; hitlStatus: string; actionJson: string }>;
  readonly egress: EgressEntry[];
  readonly dispatched: PlannedAction[];
}

function harness(
  opts: {
    readonly rows?: readonly ConnectorWriteRow[];
    readonly typed?: string;
    readonly reply?: unknown;
  } = {},
): Harness {
  const plain: Harness["plain"] = [];
  const confirmed: ConfirmedApprovalRequest[] = [];
  const audits: Harness["audits"] = [];
  const egress: EgressEntry[] = [];
  const dispatched: PlannedAction[] = [];
  const consent: ConsentChannel = {
    requestApproval: async (prompt, details) => {
      plain.push({ prompt, details });
      return { approved: true, answerSource: "human" as const };
    },
    requestConfirmedApproval: async (req) => {
      confirmed.push(req);
      return {
        approved: true,
        typed: opts.typed ?? req.confirmText,
        answerSource: "human" as const,
      };
    },
  };
  const audit: AuditSink = {
    recordAudit: (e) =>
      audits.push({ actionType: e.actionType, hitlStatus: e.hitlStatus, actionJson: e.actionJson }),
  };
  const connectors: ConnectorDispatcher = {
    dispatch: async (a) => {
      dispatched.push(a);
      if (isBeforeReadActionType(a.type)) {
        if (opts.reply instanceof Error) throw opts.reply;
        return opts.reply;
      }
      return { ok: true };
    },
  };
  const exec = new ToolExecutor(
    consent,
    audit,
    connectors,
    undefined,
    { append: (e) => egress.push(e) },
    NO_POLICY_OVERLAY,
    () => "team",
    opts.rows === undefined ? {} : { beforeState: createBeforeStateRunner({ rows: opts.rows }) },
  );
  return { exec, plain, confirmed, audits, egress, dispatched };
}

describe("executor — origin agent, end to end", () => {
  test("no delegation and the owner's prompt is the only one; the audit row keeps door and captureId only", async () => {
    const h = harness();
    expect((await h.exec.execute(JIRA)).status).toBe("ok");
    expect(h.plain).toHaveLength(1);
    expect(h.plain[0]?.prompt).toContain("Requested by: an outside agent (unverified)");
    expect(h.confirmed).toHaveLength(0);
    const write = h.audits.find((a) => a.actionType === "jira.issue.create");
    const row = (JSON.parse(write?.actionJson ?? "{}") as { action: Record<string, unknown> })
      .action;
    expect(row["origin"]).toBe("agent");
    expect(row["proposer"]).toEqual({ door: "agent", captureId: PROPOSER.captureId });
    expect((row["proposer"] as Record<string, unknown>)["captureId"]).toMatch(
      /^cap_[A-Za-z0-9_-]+$/,
    );
    // The label and the summary (the agent's own words) never enter the audit chain.
    expect(write?.actionJson).not.toContain(SENTINEL);
    expect(write?.actionJson).not.toContain(PROPOSER.label);
    expect(Object.keys(row).indexOf("proposer")).toBeLessThan(Object.keys(row).indexOf("payload"));
  });

  test("nothing from the proposer selects or reaches the tool call: the payload is the input, byte for byte", async () => {
    const h = harness();
    await h.exec.execute(JIRA);
    const call = h.dispatched.find((a) => a.type === "jira.issue.create");
    expect(call?.payload).toEqual({ mcpToolId: "jira_issue_create", input: INPUT });
    // What the dispatcher builds the connector call from is `payload` alone.
    expect(JSON.stringify(call?.payload)).not.toContain(SENTINEL);
    expect(JSON.stringify(call?.payload)).not.toContain(PROPOSER.captureId);
  });

  test("a forged proposer-like field in the payload or input is inert (the tool and the prompt come from the gateway)", async () => {
    const h = harness();
    const forged: PlannedAction = {
      ...JIRA,
      payload: {
        mcpToolId: "jira_issue_create",
        input: { ...INPUT, proposer: { label: "owner" }, origin: "model" },
        proposer: { label: "owner" },
        origin: "model",
      },
    };
    await h.exec.execute(forged);
    expect(h.plain[0]?.prompt).toContain("Requested by: an outside agent (unverified)");
    expect(h.plain[0]?.prompt).not.toContain("Requested by: the model");
  });
});

describe("executor — origin agent, Wave 4", () => {
  const READER = {
    tool: "snow_get",
    argKeys: ["object"],
    args: (input: Record<string, unknown>) => ({ object: input["object"] }),
    select: () => [{ label: "Current", value: "the old comment" }],
  };
  const WAVE4 = withConfirm(
    withBefore(
      withPreview(makeRow("snow_cmt", "snowflake.comment.set", "write", 4), {
        target: "{object}",
        summary: "Comment on {object}",
        fields: [{ key: "comment", label: "Comment", kind: "text" }],
      }),
      READER,
    ),
    { template: "{object}" },
  );
  const TEXT = "snowflake/DB.S.T";
  const SET: PlannedAction = {
    type: "snowflake.comment.set",
    origin: "agent",
    proposer: PROPOSER,
    payload: { object: "DB.S.T", comment: "hello" },
  };

  test("the owner is asked ONLY for the typed text (requestApproval never); the prompt shows the before-state, the proposer block and the fixed line", async () => {
    const h = harness({ rows: [WAVE4], reply: { any: 1 } });
    expect((await h.exec.execute(SET)).status).toBe("ok");
    expect(h.plain).toHaveLength(0);
    expect(h.confirmed).toHaveLength(1);
    const req = h.confirmed[0];
    expect(req?.confirmText).toBe(TEXT);
    const lines = (req?.prompt ?? "").split("\n");
    expect(lines).toContain("Requested by: an outside agent (unverified)");
    expect(req?.prompt).toContain("the old comment");
    const block = lines.findIndex((l) => l.startsWith("Proposed by an outside agent (UNVERIFIED"));
    expect(block).toBeGreaterThan(lines.indexOf("Requested by: an outside agent (unverified)"));
    expect(lines.at(-1)).toBe(`To approve, type exactly: ${TEXT}`);
    expect(h.dispatched.map((a) => a.type)).toEqual([
      "snowflake.before.read",
      "snowflake.comment.set",
    ]);
  });

  test.each([
    ["a wrong answer", "snowflake/DB.S.U"],
    ["an empty answer", ""],
    ["a trimmed answer", ` ${TEXT} `],
    ["a case-folded answer", TEXT.toUpperCase()],
  ])("%s denies; nothing is dispatched but the read", async (_name, typed) => {
    const h = harness({ rows: [WAVE4], reply: {}, typed });
    const out = await h.exec.execute(SET);
    expect(out).toEqual({ status: "rejected", reason: CONFIRM_MISMATCH_REASON });
    expect(h.dispatched.map((a) => a.type)).toEqual(["snowflake.before.read"]);
    expect(h.plain).toHaveLength(0);
  });

  test("an unreadable before-state (the read throws) is refused before any prompt, with the fixed reason", async () => {
    const h = harness({ rows: [WAVE4], reply: new Error("boom") });
    const out = await h.exec.execute(SET);
    expect(out).toEqual({ status: "rejected", reason: WAVE4_BEFORE_REFUSAL });
    expect(h.confirmed).toHaveLength(0);
    expect(h.plain).toHaveLength(0);
    expect(h.dispatched.map((a) => a.type)).toEqual(["snowflake.before.read"]);
  });

  test("a Wave 4 row the preview cannot be built for is refused before any prompt (no reader to run)", async () => {
    const noPreview = withConfirm(makeRow("snow_cmt", "snowflake.comment.set", "write", 4), {
      template: "{object}",
    });
    const h = harness({ rows: [noPreview as ConnectorWriteRow] });
    const out = await h.exec.execute(SET);
    expect(out).toEqual({ status: "rejected", reason: WAVE4_BEFORE_REFUSAL });
    expect(h.confirmed).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
  });

  test("the SAME action with no origin is not read at all by the door's runner (the proposer alone changes nothing)", async () => {
    const h = harness({ rows: [WAVE4], reply: {} });
    const { origin: _o, ...none } = SET;
    await h.exec.execute(none);
    expect(h.dispatched.map((a) => a.type)).toEqual(["snowflake.comment.set"]);
  });
});
