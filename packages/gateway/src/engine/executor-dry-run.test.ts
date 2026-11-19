/**
 * Phase 17 remediation dry run (I57 (b), static D46(c)): `ToolExecutor.readBeforeOnly` runs a row's before-state
 * reads through the executor's own gate and NEVER gates, prompts for or dispatches the write. A door-shaped
 * executor over a recording consent channel, dispatcher and audit sink, and the real egress sink.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import {
  type BeforeStateReader,
  type ConnectorWriteRow,
  row,
  withBefore,
  withPreview,
} from "../connectors/connector-writes/types.ts";
import { makeEgressSink } from "../egress/egress-ledger.ts";
import { LocalIndex } from "../index/local-index.ts";
import { createBeforeStateRunner, isBeforeReadActionType } from "./before-state.ts";
import {
  DRY_RUN_BOUND_REASON,
  DRY_RUN_MISMATCH_REASON,
  DRY_RUN_NOT_BUILT_REASON,
  NO_POLICY_OVERLAY,
  ToolExecutor,
} from "./executor.ts";
import type { AuditSink, ConnectorDispatcher, ConsentChannel, PlannedAction } from "./types.ts";

const GUARD_REASON = "the guard refuses this target";

const READER: BeforeStateReader = {
  tool: "jira_issue_get",
  argKeys: ["issueKey", "summary"],
  args: (input) => ({ issueKey: input["issueKey"] }),
  select: () => [{ label: "Status", value: "open" }],
  guard: {
    reason: GUARD_REASON,
    appliesTo: (picked) => picked["summary"] === "guarded",
    allows: () => false,
  },
};

const READ_ROW: ConnectorWriteRow = withBefore(
  withPreview(row("jira_issue_update", "jira.issue.update", "mesh", 2), {
    target: "{issueKey}",
    summary: "Update {issueKey}",
    fields: [{ key: "summary", label: "Summary", kind: "text" }],
  }),
  READER,
);

const NO_READER_ROW: ConnectorWriteRow = withPreview(
  row("jira_comment_add", "jira.comment.add", "mesh", 2),
  { target: "{issueKey}", summary: "Comment on {issueKey}", fields: [] },
);

const WRITE: PlannedAction = {
  type: "jira.issue.update",
  payload: { mcpToolId: "jira_jira_issue_update", input: { issueKey: "NIM-1", summary: "new" } },
};

let db: Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function harness(opts: {
  dryRun?: boolean;
  readReply?: unknown;
  rows?: readonly ConnectorWriteRow[];
}) {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const ledger = db;
  const prompts: string[] = [];
  const dispatched: PlannedAction[] = [];
  const audits: Array<[string, string]> = [];
  const consent: ConsentChannel = {
    requestApproval: async (prompt) => {
      prompts.push(prompt);
      return { approved: true, answerSource: "human" as const };
    },
  };
  const audit: AuditSink = {
    recordAudit: (r) => {
      audits.push([r.actionType, r.hitlStatus]);
    },
  };
  const connectors: ConnectorDispatcher = {
    dispatch: async (a) => {
      dispatched.push(a);
      if (!isBeforeReadActionType(a.type)) return { updated: true };
      if (opts.readReply instanceof Error) throw opts.readReply;
      return opts.readReply ?? { status: "open" };
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
    {
      beforeState: createBeforeStateRunner({
        readsEveryOrigin: true,
        rows: opts.rows ?? [READ_ROW, NO_READER_ROW],
      }),
      ...(opts.dryRun === false ? {} : { dryRun: true }),
    },
  );
  const egress = (): string[] =>
    (
      ledger.query("SELECT method FROM egress_ledger ORDER BY id").all() as Array<{
        method: string;
      }>
    ).map((r) => r.method);
  return { exec, prompts, dispatched, audits, egress };
}

describe("ToolExecutor.readBeforeOnly (remediation dry run)", () => {
  test("an executor not built for dry runs refuses and reads nothing", async () => {
    const h = harness({ dryRun: false });
    expect(await h.exec.readBeforeOnly(WRITE)).toEqual({
      status: "refused",
      reason: DRY_RUN_NOT_BUILT_REASON,
    });
    expect(h.dispatched).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  test("runs only the before read through the gate: no prompt, the write never dispatched or audited", async () => {
    const h = harness({});
    const out = await h.exec.readBeforeOnly(WRITE);
    expect(out).toMatchObject({ status: "ok" });
    expect(h.prompts).toEqual([]);
    expect(h.dispatched.map((a) => a.type)).toEqual(["jira.before.read"]);
    expect(h.audits).toEqual([["jira.before.read", "not_required"]]);
    expect(h.egress()).toHaveLength(1);
  });

  test("the caller's object is not mutated", async () => {
    const h = harness({});
    const planned = structuredClone(WRITE);
    await h.exec.readBeforeOnly(planned);
    expect(planned).toEqual(WRITE);
  });

  test("a failed read is the preview's own `unavailable`, and the write is still never dispatched", async () => {
    const h = harness({ readReply: new Error("boom") });
    expect(await h.exec.readBeforeOnly(WRITE)).toEqual({ status: "unavailable", reason: "failed" });
    expect(h.dispatched.map((a) => a.type)).toEqual(["jira.before.read"]);
  });

  test("a guard that refuses is returned as a refusal, with no prompt", async () => {
    const h = harness({});
    const guarded: PlannedAction = {
      ...WRITE,
      payload: {
        mcpToolId: "jira_jira_issue_update",
        input: { issueKey: "NIM-1", summary: "guarded" },
      },
    };
    expect(await h.exec.readBeforeOnly(guarded)).toEqual({
      status: "refused",
      reason: GUARD_REASON,
    });
    expect(h.prompts).toEqual([]);
    expect(h.dispatched.every((a) => isBeforeReadActionType(a.type))).toBe(true);
  });

  test("a row without a before reader, or a type the table does not know, is `no_reader` and reads nothing", async () => {
    const h = harness({});
    const noReader: PlannedAction = {
      type: "jira.comment.add",
      payload: { mcpToolId: "jira_jira_comment_add", input: { issueKey: "NIM-1" } },
    };
    expect(await h.exec.readBeforeOnly(noReader)).toEqual({ status: "no_reader" });
    expect(await h.exec.readBeforeOnly({ type: "nowhere.write", payload: {} })).toEqual({
      status: "no_reader",
    });
    expect(h.dispatched).toEqual([]);
  });

  test("a payload naming another row's tool is refused before any read", async () => {
    const h = harness({});
    const mismatched: PlannedAction = {
      type: "jira.issue.update",
      payload: { mcpToolId: "jira_jira_comment_add", input: { issueKey: "NIM-1" } },
    };
    expect(await h.exec.readBeforeOnly(mismatched)).toEqual({
      status: "refused",
      reason: DRY_RUN_MISMATCH_REASON,
    });
    expect(h.dispatched).toEqual([]);
  });

  test("a bound row and a row that refuses every door are refused before any read or child", async () => {
    const h = harness({ rows: CONNECTOR_WRITE_ROWS });
    expect(
      await h.exec.readBeforeOnly({
        type: "iac.terraform.apply",
        payload: { mcpToolId: "iac_iac_terraform_apply", input: { workingDirectory: "/x" } },
      }),
    ).toEqual({ status: "refused", reason: DRY_RUN_BOUND_REASON });
    const pulumi = await h.exec.readBeforeOnly({
      type: "iac.pulumi.up",
      payload: { mcpToolId: "iac_iac_pulumi_up", input: {} },
    });
    expect(pulumi.status).toBe("refused");
    expect(h.dispatched).toEqual([]);
    expect(h.prompts).toEqual([]);
  });
});
