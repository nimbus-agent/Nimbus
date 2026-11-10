/**
 * B2a: a before-state guard refuses a write INSIDE the door executor's `gate()`, before any prompt
 * (I53). A door-shaped `ToolExecutor` (no delegation, a fixture runner) over a recording consent
 * channel, dispatcher and audit sink, and the REAL egress sink over a `LocalIndex` schema. The rows
 * are SYNTHETIC: no production row carries a guard in B2a.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import {
  type BeforeStateReader,
  type ConnectorWriteRow,
  row,
  withBefore,
  withConfirm,
  withPreview,
} from "../connectors/connector-writes/types.ts";
import { makeEgressSink } from "../egress/egress-ledger.ts";
import { LocalIndex } from "../index/local-index.ts";
import { ConsentDisconnectedError } from "../ipc/consent.ts";
import {
  createBeforeStateRunner,
  isBeforeReadActionType,
  WAVE4_BEFORE_REFUSAL,
} from "./before-state.ts";
import { NO_POLICY_OVERLAY, ToolExecutor } from "./executor.ts";
import type { AuditSink, ConnectorDispatcher, ConsentChannel, PlannedAction } from "./types.ts";

const GUARD_REASON = "the model cannot update this issue; ask the owner";

/** Allows only when the read's reply says `{ open: true }`; applies when `summary` is set. */
const READER: BeforeStateReader = {
  tool: "jira_issue_get",
  argKeys: ["issueKey", "summary"],
  args: (input) => ({ issueKey: input["issueKey"] }),
  select: () => [{ label: "Status", value: "open" }],
  guard: {
    reason: GUARD_REASON,
    appliesTo: (picked) => picked["summary"] !== undefined,
    allows: (reply) => (reply as { open?: unknown } | undefined)?.open === true,
  },
};

const ROW: ConnectorWriteRow = withBefore(
  withPreview(row("jira_issue_update", "jira.issue.update", "mesh", 2), {
    target: "{issueKey}",
    summary: "Update {issueKey}",
    fields: [{ key: "summary", label: "Summary", kind: "text" }],
  }),
  READER,
);

const WRITE: PlannedAction = {
  type: "jira.issue.update",
  origin: "model",
  payload: { mcpToolId: "jira_jira_issue_update", input: { issueKey: "NIM-1", summary: "new" } },
};

let db: Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

interface Recorded {
  prompts: string[];
  dispatched: PlannedAction[];
  audits: Array<{ actionType: string; hitlStatus: string; actionJson: string }>;
}

function harness(opts: {
  readReply?: unknown;
  withRunner?: boolean;
  consent?: (prompt: string, details?: Record<string, unknown>, type?: string) => Promise<boolean>;
  rows?: readonly ConnectorWriteRow[];
}) {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const ledger = db;
  const rec: Recorded = { prompts: [], dispatched: [], audits: [] };
  const consent: ConsentChannel = {
    requestApproval: async (prompt, details, type) => {
      rec.prompts.push(prompt);
      return {
        approved: opts.consent === undefined ? true : await opts.consent(prompt, details, type),
        answerSource: "human" as const,
      };
    },
  };
  const audit: AuditSink = {
    recordAudit: (r) => {
      rec.audits.push({
        actionType: r.actionType,
        hitlStatus: r.hitlStatus,
        actionJson: r.actionJson,
      });
    },
  };
  const connectors: ConnectorDispatcher = {
    dispatch: async (a) => {
      rec.dispatched.push(a);
      if (!isBeforeReadActionType(a.type)) return { updated: true };
      if (opts.readReply instanceof Error) throw opts.readReply;
      return opts.readReply;
    },
  };
  const exec = new ToolExecutor(
    consent,
    audit,
    connectors,
    undefined,
    makeEgressSink(ledger),
    NO_POLICY_OVERLAY,
    undefined,
    opts.withRunner === false ? undefined : createBeforeStateRunner({ rows: opts.rows ?? [ROW] }),
  );
  const egress = (): Array<{ method: string; result_status: string; hitl_status: string }> =>
    ledger
      .query("SELECT method, result_status, hitl_status FROM egress_ledger ORDER BY id")
      .all() as Array<{ method: string; result_status: string; hitl_status: string }>;
  return { exec, rec, egress };
}

describe("the before-state guard inside gate() (B2a)", () => {
  test("allows false (the read succeeded, the issue is not open) -> refused: no prompt, no write dispatched, rejected with the fixed reason, egress blocked after the read", async () => {
    const { exec, rec, egress } = harness({ readReply: { open: false } });
    const out = await exec.execute(WRITE);
    expect(out).toEqual({ status: "rejected", reason: GUARD_REASON });
    expect(rec.prompts).toEqual([]);
    expect(rec.dispatched.map((a) => a.type)).toEqual(["jira.before.read"]);
    expect(rec.audits.map((a) => [a.actionType, a.hitlStatus])).toEqual([
      ["jira.before.read", "not_required"],
      ["jira.issue.update", "rejected"],
    ]);
    const writeAudit = JSON.parse(rec.audits[1]?.actionJson ?? "{}") as Record<string, unknown>;
    expect(writeAudit["hitlRejectReason"]).toBe(GUARD_REASON);
    expect(egress()).toEqual([
      { method: "jira.before.read", result_status: "authorized", hitl_status: "not_required" },
      { method: "jira.issue.update", result_status: "blocked", hitl_status: "rejected" },
    ]);
  });

  test("a read that FAILS (the dispatcher throws) under an applicable guard is refused the same way (fail closed)", async () => {
    const { exec, rec, egress } = harness({ readReply: new Error("Tool not found") });
    expect(await exec.execute(WRITE)).toEqual({ status: "rejected", reason: GUARD_REASON });
    expect(rec.prompts).toEqual([]);
    expect(rec.dispatched.map((a) => a.type)).toEqual(["jira.before.read"]);
    expect(egress().map((e) => e.result_status)).toEqual(["authorized", "blocked"]);
  });

  test("the door's unlisted-reader option under an applicable guard: refused, nothing read or dispatched", async () => {
    const { exec, rec, egress } = harness({ readReply: { open: true } });
    const out = await exec.execute(WRITE, { beforeReaderUnlisted: true });
    expect(out).toEqual({ status: "rejected", reason: GUARD_REASON });
    expect(rec.prompts).toEqual([]);
    expect(rec.dispatched).toEqual([]);
    expect(egress()).toEqual([
      { method: "jira.issue.update", result_status: "blocked", hitl_status: "rejected" },
    ]);
  });

  test("allowed: the prompt is shown as today, and on approval the write is dispatched once", async () => {
    const { exec, rec, egress } = harness({ readReply: { open: true } });
    expect(await exec.execute(WRITE)).toEqual({ status: "ok", result: { updated: true } });
    expect(rec.prompts).toHaveLength(1);
    expect(rec.prompts[0]).toContain("Before:\n  Status: open");
    expect(rec.dispatched.map((a) => a.type)).toEqual(["jira.before.read", "jira.issue.update"]);
    expect(egress().map((e) => e.result_status)).toEqual(["authorized", "authorized"]);
  });

  test("not applicable (no summary): the prompt as today, even when the read would not allow", async () => {
    const { exec, rec } = harness({ readReply: { open: false } });
    const out = await exec.execute({
      ...WRITE,
      payload: { mcpToolId: "jira_jira_issue_update", input: { issueKey: "NIM-1" } },
    });
    expect(out.status).toBe("ok");
    expect(rec.prompts).toHaveLength(1);
  });

  test("an executor without a runner never refuses this way: the plain prompt", async () => {
    const { exec, rec } = harness({ readReply: { open: false }, withRunner: false });
    expect(await exec.execute(WRITE)).toEqual({ status: "ok", result: { updated: true } });
    expect(rec.prompts).toHaveLength(1);
    expect(rec.dispatched.map((a) => a.type)).toEqual(["jira.issue.update"]);
  });

  test("a user decline and a consent disconnect keep their own reasons beside the guard", async () => {
    const declined = harness({ readReply: { open: true }, consent: async () => false });
    expect(await declined.exec.execute(WRITE)).toEqual({
      status: "rejected",
      reason: "User declined consent gate.",
    });
    db?.close();
    const gone = harness({
      readReply: { open: true },
      consent: async () => {
        throw new ConsentDisconnectedError();
      },
    });
    expect(await gone.exec.execute(WRITE)).toEqual({
      status: "rejected",
      reason: "client disconnected",
    });
  });

  test("any other error from the prompt path still propagates (the catch is narrow)", async () => {
    const { exec } = harness({
      readReply: { open: true },
      consent: async () => {
        throw new Error("consent channel broke");
      },
    });
    await expect(exec.execute(WRITE)).rejects.toThrow("consent channel broke");
  });
});

describe("a Wave 4 model write whose current state cannot be read is refused inside gate() (D1)", () => {
  /** An unguarded Wave 4 row: the generic rule, not a guard, refuses. */
  const { guard: _guard, ...NO_GUARD_READER } = READER;
  const WAVE4_ROW: ConnectorWriteRow = withConfirm(
    withBefore(
      withPreview(row("jira_issue_update", "jira.issue.update", "mesh", 4), {
        target: "{issueKey}",
        summary: "Update {issueKey}",
        fields: [{ key: "summary", label: "Summary", kind: "text" }],
      }),
      NO_GUARD_READER,
    ),
    { template: "update {summary}" },
  );

  test("a failed read: no prompt, no write dispatched, rejected with the fixed reason, audited, egress blocked", async () => {
    const { exec, rec, egress } = harness({
      readReply: new Error("boom"),
      rows: [WAVE4_ROW],
    });
    expect(await exec.execute(WRITE)).toEqual({ status: "rejected", reason: WAVE4_BEFORE_REFUSAL });
    expect(rec.prompts).toEqual([]);
    expect(rec.dispatched.map((a) => a.type)).toEqual(["jira.before.read"]);
    const writeAudit = JSON.parse(rec.audits[1]?.actionJson ?? "{}") as Record<string, unknown>;
    expect(writeAudit["hitlRejectReason"]).toBe(WAVE4_BEFORE_REFUSAL);
    expect(egress()).toEqual([
      { method: "jira.before.read", result_status: "authorized", hitl_status: "not_required" },
      { method: "jira.issue.update", result_status: "blocked", hitl_status: "rejected" },
    ]);
  });

  test("control: with a readable state the refusal is not the Wave 4 one (the plain channel cannot type the confirmation, so the write itself stops later)", async () => {
    const { exec, rec } = harness({ readReply: { open: true }, rows: [WAVE4_ROW] });
    const out = await exec.execute(WRITE);
    expect(out).not.toEqual({ status: "rejected", reason: WAVE4_BEFORE_REFUSAL });
    expect(rec.dispatched.map((x) => x.type)).toEqual(["jira.before.read"]);
  });
});

describe("a Wave 4 model write with no typed preview is refused inside gate() (D1)", () => {
  const NO_PREVIEW_ROW: ConnectorWriteRow = withConfirm(
    row("github_file_commit", "github.file.commit", "mesh", 4),
    {
      template: "commit {owner}/{repo}",
    },
  );
  const COMMIT = (model: boolean): PlannedAction => ({
    type: "github.file.commit",
    ...(model ? { origin: "model" as const } : {}),
    payload: { mcpToolId: "github_file_commit", input: { owner: "o", repo: "r" } },
  });

  test("origin model: no prompt, audited rejection, blocked egress row, nothing dispatched", async () => {
    const { exec, rec, egress } = harness({ rows: [NO_PREVIEW_ROW] });
    expect(await exec.execute(COMMIT(true))).toEqual({
      status: "rejected",
      reason: WAVE4_BEFORE_REFUSAL,
    });
    expect(rec.prompts).toEqual([]);
    expect(rec.dispatched).toEqual([]);
    expect(rec.audits.map((a) => [a.actionType, a.hitlStatus])).toEqual([
      ["github.file.commit", "rejected"],
    ]);
    expect(egress()).toEqual([
      { method: "github.file.commit", result_status: "blocked", hitl_status: "rejected" },
    ]);
  });

  test("a non-model origin is unchanged: not refused with the Wave 4 reason", async () => {
    const { exec, rec } = harness({ rows: [NO_PREVIEW_ROW] });
    const out = await exec.execute(COMMIT(false));
    expect(out).not.toEqual({ status: "rejected", reason: WAVE4_BEFORE_REFUSAL });
    expect(rec.dispatched.map((a) => a.type)).not.toContain("github.before.read");
  });
});
