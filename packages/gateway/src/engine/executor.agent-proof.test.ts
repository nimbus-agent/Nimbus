/**
 * Phase 28 AD4 (Tasks 1 and 2): an outside agent's action names the door and the proposer in BOTH
 * ledgers. The audit row's projection comes first and survives the 4 KiB cap; the before-state
 * read, the prepare read and the change-set discard of the same run name the same capture; the
 * egress row's `source_id` is `agent:<captureId>` and the client's label never enters a hashed
 * field; a malformed capture id throws before EITHER row is written; and a non-agent action
 * writes byte-identical rows to what it wrote before this change.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  SYNTH_PREPARE_IDS,
  SYNTH_REPLY,
  synthBoundRow,
} from "../connectors/connector-writes/bound-fixtures.test-helpers.ts";
import { IAC_DISCARD } from "../connectors/connector-writes/iac-limits.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { PREPARE_TOOL_IDS } from "../connectors/connector-writes/prepare-tools.ts";
import type { ConnectorWriteRow } from "../connectors/connector-writes/types.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { verifyAuditChain } from "../db/audit-verify.ts";
import { appendEgressEntry, makeEgressSink } from "../egress/egress-ledger.ts";
import { verifyEgressChain } from "../egress/egress-verify.ts";
import { LocalIndex } from "../index/local-index.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { createBeforeStateRunner, isBeforeReadActionType } from "./before-state.ts";
import type { BoundWriteCapabilities, SettledWrite } from "./bound-write-capabilities.ts";
import { NO_POLICY_OVERLAY, ToolExecutor, type WriteTable } from "./executor.ts";
import type { AgentProposer, ConfirmedApprovalRequest, PlannedAction } from "./types.ts";

const CAPTURE_ID = `cap_${"ab12".repeat(8)}`;
const OTHER_ID = `cap_${"cd34".repeat(8)}`;

let db: Database;
beforeEach(() => {
  db = openMigratedMemoryDb();
});
afterEach(() => {
  db.close();
});

function proposerOf(label: string | null, captureId = CAPTURE_ID): AgentProposer {
  return {
    door: "agent",
    captureId,
    label,
    labelSource: "declared",
    summary: "SUMMARY-MARKER",
    createdAt: 0,
    expiresAt: 60_000,
  };
}

const INPUT = { projectKey: "ENG", summary: "Fix login" };

function agentAction(
  type = "jira.issue.create",
  tool = "jira_issue_create",
  input: Record<string, unknown> = INPUT,
  label: string | null = "claude-desktop",
  captureId = CAPTURE_ID,
): PlannedAction {
  return {
    type,
    origin: "agent",
    proposer: proposerOf(label, captureId),
    payload: { mcpToolId: tool, input },
  };
}

interface Rig {
  readonly exec: ToolExecutor;
  readonly dispatched: PlannedAction[];
}

function rig(
  opts: {
    readonly reply?: (a: PlannedAction) => unknown;
    readonly table?: readonly ConnectorWriteRow[];
    readonly withBefore?: boolean;
    readonly writeTable?: WriteTable;
    readonly capabilities?: BoundWriteCapabilities;
    readonly approve?: boolean;
  } = {},
): Rig {
  const dispatched: PlannedAction[] = [];
  const confirmedReq: ConfirmedApprovalRequest[] = [];
  const exec = new ToolExecutor(
    {
      requestApproval: async () => ({
        approved: opts.approve ?? true,
        answerSource: "human" as const,
      }),
      requestConfirmedApproval: async (req: ConfirmedApprovalRequest) => {
        confirmedReq.push(req);
        return {
          approved: opts.approve ?? true,
          typed: req.confirmText,
          answerSource: "human" as const,
        };
      },
    },
    { recordAudit: (e) => appendAuditEntry(db, { ...e, timestamp: e.timestamp }) },
    {
      dispatch: async (a) => {
        dispatched.push(a);
        return opts.reply === undefined ? { ok: true } : opts.reply(a);
      },
      ...(opts.capabilities === undefined ? {} : { boundWriteCapabilities: opts.capabilities }),
    },
    undefined,
    makeEgressSink(db),
    NO_POLICY_OVERLAY,
    () => "team",
    opts.withBefore === true
      ? { beforeState: createBeforeStateRunner({ rows: opts.table ?? CONNECTOR_WRITE_ROWS }) }
      : {},
    opts.writeTable,
  );
  return { exec, dispatched };
}

interface AuditRow {
  action_type: string;
  hitl_status: string;
  action_json: string;
  session_id: string | null;
}
interface EgressRow {
  source_type: string;
  source_id: string | null;
  method: string;
  payload_summary: string;
  hitl_status: string;
  result_status: string;
}
const auditRows = (): AuditRow[] =>
  db
    .query("SELECT action_type, hitl_status, action_json, session_id FROM audit_log ORDER BY id")
    .all() as AuditRow[];
const egressRows = (): EgressRow[] =>
  db
    .query(
      "SELECT source_type, source_id, method, payload_summary, hitl_status, result_status FROM egress_ledger ORDER BY id",
    )
    .all() as EgressRow[];

const prefixOf = (type: string, p: AgentProposer): string =>
  `{"action":{"type":${JSON.stringify(type)},"proposer":${JSON.stringify({
    door: p.door,
    captureId: p.captureId,
    label: p.label,
    labelSource: p.labelSource,
  })},`;

describe("Task 1 - the audit row's proposer projection", () => {
  test("the row holds door, captureId, label and labelSource, in that order, before the payload", async () => {
    const { exec } = rig();
    expect((await exec.execute(agentAction())).status).toBe("ok");
    const [row] = auditRows();
    expect(
      row?.action_json.startsWith(prefixOf("jira.issue.create", proposerOf("claude-desktop"))),
    ).toBe(true);
    const parsed = JSON.parse(row?.action_json ?? "{}") as { action: Record<string, unknown> };
    expect(Object.keys(parsed.action)).toEqual(["type", "proposer", "origin", "payload"]);
    expect(Object.keys(parsed.action["proposer"] as object)).toEqual([
      "door",
      "captureId",
      "label",
      "labelSource",
    ]);
    // The agent's summary stays out of the chain; only the label joined the projection.
    expect(row?.action_json).not.toContain("SUMMARY-MARKER");
  });

  test("a null label is recorded as null (never the word 'unlabelled')", async () => {
    const { exec } = rig();
    await exec.execute(agentAction("jira.issue.create", "jira_issue_create", INPUT, null));
    expect(auditRows()[0]?.action_json).toContain('"label":null,"labelSource":"declared"');
  });

  test("a 100-unit label of quotes, backslashes and astral characters plus a 5,000-unit input still leaves the capture id and label readable in the cut row", async () => {
    const astral = String.fromCodePoint(0x1f600);
    const label = `${'"\\'.repeat(20)}${astral.repeat(30)}`;
    expect(label.length).toBe(100);
    const { exec } = rig();
    await exec.execute(
      agentAction(
        "jira.issue.create",
        "jira_issue_create",
        { ...INPUT, body: "y".repeat(5000) },
        label,
      ),
    );
    const json = auditRows()[0]?.action_json ?? "";
    expect(json.endsWith("…[truncated]")).toBe(true);
    expect(json.startsWith(prefixOf("jira.issue.create", proposerOf(label)))).toBe(true);
  });

  test("a model-origin action and an owner action write the same rows as before this change", async () => {
    for (const origin of [undefined, "model"] as const) {
      const { exec } = rig();
      await exec.execute({
        type: "jira.issue.create",
        ...(origin === undefined ? {} : { origin }),
        payload: { mcpToolId: "jira_issue_create", input: INPUT },
      });
    }
    const input = '"input":{"projectKey":"[REDACTED]","summary":"Fix login"}';
    const payload = `"payload":{"mcpToolId":"jira_issue_create",${input}}`;
    expect(auditRows().map((r) => r.action_json)).toEqual([
      `{"action":{"type":"jira.issue.create",${payload}},"answerSource":"human"}`,
      `{"action":{"type":"jira.issue.create","origin":"model",${payload}},"answerSource":"human"}`,
    ]);
    expect(auditRows().every((r) => r.session_id === null)).toBe(true);
    const summary = `{"mcpToolId":"jira_issue_create",${input}}`;
    expect(egressRows()).toEqual([
      {
        source_type: "task",
        source_id: null,
        method: "jira.issue.create",
        payload_summary: summary,
        hitl_status: "approved",
        result_status: "authorized",
      },
      {
        source_type: "task",
        source_id: null,
        method: "jira.issue.create",
        payload_summary: summary,
        hitl_status: "approved",
        result_status: "authorized",
      },
    ]);
  });
});

describe("Task 2 - the egress row of an agent action and its sub-steps", () => {
  test("the write's egress row is task / agent:<captureId> and its summary starts with the label", async () => {
    const { exec } = rig();
    await exec.execute(agentAction());
    expect(egressRows()).toEqual([
      expect.objectContaining({
        source_type: "task",
        source_id: `agent:${CAPTURE_ID}`,
        hitl_status: "approved",
        result_status: "authorized",
      }),
    ]);
    expect(
      egressRows()[0]?.payload_summary.startsWith('{"agent":{"label":"claude-desktop"},'),
    ).toBe(true);
  });

  test("a declined write is ledgered blocked under the same capture", async () => {
    const { exec } = rig({ approve: false });
    expect((await exec.execute(agentAction())).status).toBe("rejected");
    expect(egressRows()).toEqual([
      expect.objectContaining({
        source_id: `agent:${CAPTURE_ID}`,
        hitl_status: "rejected",
        result_status: "blocked",
      }),
    ]);
  });

  test("a before-state read: every audit row and every egress row of the run names the capture", async () => {
    const reply = (a: PlannedAction): unknown =>
      isBeforeReadActionType(a.type)
        ? {
            key: "NIM-1",
            fields: { summary: "Fix", status: { name: "Open" }, issuetype: { name: "Bug" } },
          }
        : { url: "https://x" };
    const { exec, dispatched } = rig({ withBefore: true, reply });
    const action = agentAction("jira.comment.add", "jira_comment_add", {
      issueKey: "NIM-1",
      body: "hello",
    });
    expect((await exec.execute(action)).status).toBe("ok");
    expect(dispatched.map((a) => a.type)).toEqual(["jira.before.read", "jira.comment.add"]);
    const audits = auditRows();
    expect(audits.map((r) => r.action_type)).toEqual(["jira.before.read", "jira.comment.add"]);
    expect(
      audits[0]?.action_json.startsWith(
        `{"onBehalfOf":{"door":"agent","captureId":"${CAPTURE_ID}"},"action":{"type":"jira.before.read"`,
      ),
    ).toBe(true);
    // The read carries no proposer or origin of its own: it is attributed, not impersonated.
    expect(audits[0]?.action_json).not.toContain('"proposer"');
    expect(audits[0]?.action_json).not.toContain('"origin"');
    expect(
      audits[1]?.action_json.startsWith(prefixOf("jira.comment.add", proposerOf("claude-desktop"))),
    ).toBe(true);
    expect(egressRows().map((r) => r.source_id)).toEqual([
      `agent:${CAPTURE_ID}`,
      `agent:${CAPTURE_ID}`,
    ]);
    expect(
      egressRows()[0]?.payload_summary.startsWith('{"agent":{"label":"claude-desktop"},'),
    ).toBe(true);
  });

  test("the SAME write as a model-origin action leaves its before-state rows unattributed", async () => {
    const reply = (a: PlannedAction): unknown =>
      isBeforeReadActionType(a.type)
        ? {
            key: "NIM-1",
            fields: { summary: "Fix", status: { name: "Open" }, issuetype: { name: "Bug" } },
          }
        : { url: "https://x" };
    const { exec } = rig({ withBefore: true, reply });
    await exec.execute({
      type: "jira.comment.add",
      origin: "model",
      payload: { mcpToolId: "jira_comment_add", input: { issueKey: "NIM-1", body: "hello" } },
    });
    expect(auditRows().some((r) => r.action_json.includes("onBehalfOf"))).toBe(false);
    expect(egressRows().every((r) => r.source_id === null)).toBe(true);
  });

  test("a bound write: the prepare read names the capture in both ledgers", async () => {
    const row = synthBoundRow(3);
    const { exec } = rig({
      reply: (a) => (a.type.endsWith(".write.prepare") ? SYNTH_REPLY : { applied: true }),
      writeTable: { rows: [row], prepareToolIds: SYNTH_PREPARE_IDS },
    });
    const action: PlannedAction = {
      type: "iac.terraform.apply",
      origin: "agent",
      proposer: proposerOf("claude-desktop"),
      payload: { mcpToolId: "iac_synth_apply", input: { dir: "prod" } },
    };
    expect((await exec.execute(action)).status).toBe("ok");
    const audits = auditRows();
    expect(audits).toHaveLength(2);
    expect(audits[1]?.action_type).toBe("iac.terraform.apply");
    const prepare = audits.find((r) => r.action_type.endsWith(".write.prepare"));
    expect(
      prepare?.action_json.startsWith(
        `{"onBehalfOf":{"door":"agent","captureId":"${CAPTURE_ID}"},"action":{"type":`,
      ),
    ).toBe(true);
    expect(egressRows().map((r) => r.source_id)).toEqual([
      `agent:${CAPTURE_ID}`,
      `agent:${CAPTURE_ID}`,
    ]);
  });

  test("a discard of an unused change set: its audit and egress rows name the capture", async () => {
    const arn =
      "arn:aws:cloudformation:eu-west-1:123456789012:changeSet/nimbus-x/00000000-0000-0000-0000-000000000000";
    const capabilities: BoundWriteCapabilities = {
      preflight: async () => ({ ok: true, release: () => undefined }),
      settle: async (): Promise<SettledWrite> => ({
        values: { changeSetId: arn },
        fields: [{ label: "Stack", value: "prod-stack" }],
        plan: {
          lines: ["Deletes: 0, Replaces: 0, Creates: 1, Updates: 0"],
          text: "x",
          bytes: 1,
          sha256: "b".repeat(64),
          changeCount: 1,
          deleteCount: 0,
        },
        cleanup: async () => undefined,
      }),
    };
    const { exec, dispatched } = rig({
      approve: false,
      capabilities,
      writeTable: { rows: CONNECTOR_WRITE_ROWS, prepareToolIds: PREPARE_TOOL_IDS },
      reply: (a) =>
        a.type.endsWith(".write.prepare") ? { changeSetId: "arn:forged" } : { ok: true },
    });
    const action: PlannedAction = {
      type: "iac.cloudformation.deploy",
      origin: "agent",
      proposer: proposerOf("claude-desktop"),
      payload: {
        mcpToolId: "iac_iac_cloudformation_deploy",
        input: { stackName: "prod-stack", templateBody: "Resources: {}\n" },
      },
    };
    expect((await exec.execute(action)).status).toBe("rejected");
    expect(dispatched.some((a) => a.type === IAC_DISCARD.actionType)).toBe(true);
    const discard = auditRows().find((r) => r.action_type === IAC_DISCARD.actionType);
    expect(
      discard?.action_json.startsWith(
        `{"onBehalfOf":{"door":"agent","captureId":"${CAPTURE_ID}"},"action":{"type":`,
      ),
    ).toBe(true);
    const ledger = egressRows();
    expect(ledger.length).toBeGreaterThanOrEqual(3);
    expect(ledger.every((r) => r.source_id === `agent:${CAPTURE_ID}`)).toBe(true);
  });

  test("no row of one capture is attributed to another", async () => {
    const reply = (a: PlannedAction): unknown =>
      isBeforeReadActionType(a.type)
        ? {
            key: "NIM-1",
            fields: { summary: "Fix", status: { name: "Open" }, issuetype: { name: "Bug" } },
          }
        : { url: "https://x" };
    const { exec } = rig({ withBefore: true, reply });
    const input = { issueKey: "NIM-1", body: "hello" };
    await exec.execute(agentAction("jira.comment.add", "jira_comment_add", input, "a", CAPTURE_ID));
    await exec.execute(agentAction("jira.comment.add", "jira_comment_add", input, "b", OTHER_ID));
    expect(egressRows().map((r) => r.source_id)).toEqual([
      `agent:${CAPTURE_ID}`,
      `agent:${CAPTURE_ID}`,
      `agent:${OTHER_ID}`,
      `agent:${OTHER_ID}`,
    ]);
  });
});

describe("Task 2 - a malformed capture id writes neither row", () => {
  for (const bad of [
    "cap_ad1",
    "cap_AbC-123_xyz",
    `cap_${"A".repeat(32)}`,
    `${CAPTURE_ID}x`,
    "",
    "x|y",
  ]) {
    test(`'${bad}' throws before the audit row and the egress row; nothing is dispatched`, async () => {
      const { exec, dispatched } = rig();
      await expect(
        exec.execute(agentAction("jira.issue.create", "jira_issue_create", INPUT, "x", bad)),
      ).rejects.toThrow();
      expect(auditRows()).toEqual([]);
      expect(egressRows()).toEqual([]);
      expect(dispatched).toEqual([]);
    });
  }
});

describe("Task 2 - the label never enters a hashed egress field", () => {
  test("a label holding | quotes backslashes control and astral characters leaves source_id and the hash input untouched", async () => {
    const label = `a|b"c\\d${String.fromCodePoint(0x1f600)}${String.fromCodePoint(0x1b)}\n|agent:cap_x`;
    const { exec } = rig();
    await exec.execute(agentAction("jira.issue.create", "jira_issue_create", INPUT, label));
    const [row] = egressRows();
    expect(row?.source_id).toBe(`agent:${CAPTURE_ID}`);
    expect(row?.source_id).not.toContain("|");
    const other = rig();
    await other.exec.execute(agentAction("jira.issue.create", "jira_issue_create", INPUT, "plain"));
    const hashes = db
      .query(
        "SELECT source_id, destination, method, hitl_status, result_status FROM egress_ledger ORDER BY id",
      )
      .all();
    expect(hashes[0]).toEqual(hashes[1]);
  });

  test("the summary stays within 256 units (plus the truncation marker) and keeps the 48-unit label cut", async () => {
    const label = "L".repeat(100);
    const { exec } = rig();
    await exec.execute(
      agentAction(
        "jira.issue.create",
        "jira_issue_create",
        { ...INPUT, body: "z".repeat(900) },
        label,
      ),
    );
    const summary = egressRows()[0]?.payload_summary ?? "";
    expect(summary.startsWith(`{"agent":{"label":"${"L".repeat(48)}"}`)).toBe(true);
    expect(summary).not.toContain("L".repeat(49));
    expect(summary.length).toBeLessThanOrEqual(256 + "…[truncated]".length);
  });
});

describe("Task 2 - rows written before this change still verify beside rows written after it", () => {
  test("verifyAuditChain and verifyEgressChain pass over old-style and new-style rows together", async () => {
    // An old-style pair, exactly as the previous code wrote it.
    appendAuditEntry(db, {
      actionType: "jira.issue.create",
      hitlStatus: "approved",
      actionJson:
        '{"action":{"type":"jira.issue.create","origin":"agent","proposer":{"door":"agent","captureId":"cap_old"},"payload":{}},"answerSource":"human"}',
      timestamp: 1,
    });
    appendEgressEntry(db, {
      timestamp: 1,
      sourceType: "task",
      sourceId: null,
      destination: "jira",
      method: "jira.issue.create",
      payloadSummary: "{}",
      hitlStatus: "approved",
      resultStatus: "authorized",
    });
    const { exec } = rig();
    await exec.execute(agentAction());
    await exec.execute({
      type: "jira.issue.create",
      origin: "model",
      payload: { mcpToolId: "jira_issue_create", input: INPUT },
    });
    expect(verifyAuditChain(new LocalIndex(db), { fromId: 0 })).toMatchObject({
      ok: true,
      verifiedRows: 3,
    });
    expect(verifyEgressChain(db)).toMatchObject({ ok: true, verifiedRows: 3 });
  });
});
