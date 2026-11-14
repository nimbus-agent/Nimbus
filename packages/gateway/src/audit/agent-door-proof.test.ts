/**
 * Phase 28 AD4 (Task 5): the reader behind `audit.proveByProposer` and `audit.listByDoor`. One
 * fixture database per case, every row written through the real `appendAuditEntry`,
 * `appendEgressEntry`, `pruneEgress` and the real executor, so the shapes are the production ones.
 * What the reader may conclude: these proposals were recorded, the owner's gate decided this many,
 * and the two ledgers agree capture by capture. What it may not: which program sent them.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { appendBootMarker } from "../egress/egress-boot-marker.ts";
import { THIS_BINARY_COVERAGE } from "../egress/egress-coverage.ts";
import { appendEgressEntry, makeEgressSink } from "../egress/egress-ledger.ts";
import { pruneEgress } from "../egress/egress-prune.ts";
import { agentRequestContext } from "../engine/agent-request-context.ts";
import { createBeforeStateRunner, isBeforeReadActionType } from "../engine/before-state.ts";
import { NO_POLICY_OVERLAY, ToolExecutor } from "../engine/executor.ts";
import { escapeUnverifiedLine } from "../engine/proposer-block.ts";
import type { PlannedAction } from "../engine/types.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import {
  classifyAuditRow,
  listByDoor,
  MISMATCH_CODES,
  type MismatchCode,
  type ProposerProof,
  proveByProposer,
} from "./agent-door-proof.ts";

const OK_CHAIN = { ok: true } as const;
const T0 = 1_000_000;

let db: Database;
beforeEach(() => {
  db = openMigratedMemoryDb();
  setSystemTime(new Date(T0 - 10));
  appendBootMarker(db, THIS_BINARY_COVERAGE, T0 - 10);
});
afterEach(() => {
  setSystemTime();
  db.close();
});

const idOf = (n: number): string => `cap_${n.toString(16).padStart(32, "0")}`;
const WRITE = "slack.message.post";

interface Opts {
  readonly label?: string | null;
  readonly connection?: string;
  readonly actionType?: string;
}

/** The `capture.submit` row, shaped as `writeSubmittedCapture` writes it. */
function submit(id: string, at: number, o: Opts = {}): void {
  appendAuditEntry(db, {
    actionType: "capture.submit",
    hitlStatus: "not_required",
    actionJson: JSON.stringify({
      captureId: id,
      kind: "action",
      actionType: o.actionType ?? WRITE,
      basis: "approved",
      payloadBytes: 10,
      clientLabel: o.label === undefined ? "claude-desktop" : o.label,
      connection: o.connection ?? "conn-1",
      outcome: "proposed",
    }),
    timestamp: at,
    sessionId: o.connection ?? "conn-1",
  });
}

/** A refused submit, as `refuseAudited` writes it (no capture id). */
function refusedSubmit(at: number, label: string | null, connection = "conn-1"): void {
  appendAuditEntry(db, {
    actionType: "capture.submit",
    hitlStatus: "rejected",
    actionJson: JSON.stringify({
      kind: "action",
      clientLabel: label,
      connection,
      outcome: "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
    }),
    timestamp: at,
    sessionId: connection,
  });
}

function accept(id: string, at: number, o: Opts & { readonly preVersion?: boolean } = {}): void {
  const label = o.label === undefined ? "claude-desktop" : o.label;
  appendAuditEntry(db, {
    actionType: "capture.action.accept",
    hitlStatus: "not_required",
    actionJson: JSON.stringify(
      o.preVersion === true
        ? { captureId: id, actionType: o.actionType ?? WRITE, basis: "approved" }
        : {
            captureId: id,
            actionType: o.actionType ?? WRITE,
            basis: "approved",
            door: "agent",
            clientLabel: label,
            labelSource: "declared",
            connection: o.connection ?? "conn-1",
          },
    ),
    timestamp: at,
    sessionId: "owner-cli",
  });
}

function outcome(id: string, at: number, state: "executed" | "rejected" | "failed"): void {
  appendAuditEntry(db, {
    actionType: "capture.action.outcome",
    hitlStatus: "not_required",
    actionJson: JSON.stringify({ captureId: id, actionType: WRITE, outcome: state }),
    timestamp: at,
    sessionId: "owner-cli",
  });
}

function expire(id: string, at: number): void {
  appendAuditEntry(db, {
    actionType: "capture.action.expire",
    hitlStatus: "not_required",
    actionJson: JSON.stringify({ captureId: id, expiredAt: at, outcome: "expired" }),
    timestamp: at,
    sessionId: "gateway-boot",
  });
}

function reject(id: string, at: number): void {
  appendAuditEntry(db, {
    actionType: "capture.reject",
    hitlStatus: "rejected",
    actionJson: JSON.stringify({ captureId: id, kind: "action", outcome: "rejected" }),
    timestamp: at,
    sessionId: "owner-cli",
  });
}

/** The real executor, writing the gate row and the ledger row of the agent's write (and its before-read). */
async function dispatch(
  id: string,
  at: number,
  o: Opts & { readonly approve?: boolean; readonly withBefore?: boolean } = {},
): Promise<void> {
  setSystemTime(new Date(at));
  const exec = new ToolExecutor(
    {
      requestApproval: async () => ({
        approved: o.approve ?? true,
        answerSource: "human" as const,
      }),
    },
    { recordAudit: (e) => appendAuditEntry(db, e) },
    {
      dispatch: async (a) =>
        isBeforeReadActionType(a.type)
          ? {
              key: "NIM-1",
              fields: { summary: "s", status: { name: "Open" }, issuetype: { name: "Bug" } },
            }
          : { ok: true },
    },
    undefined,
    makeEgressSink(db),
    NO_POLICY_OVERLAY,
    () => "team",
    o.withBefore === true
      ? { beforeState: createBeforeStateRunner({ rows: CONNECTOR_WRITE_ROWS }) }
      : {},
  );
  const jira = o.withBefore === true;
  const action: PlannedAction = {
    type: jira ? "jira.comment.add" : (o.actionType ?? WRITE),
    origin: "agent",
    proposer: {
      door: "agent",
      captureId: id,
      label: o.label === undefined ? "claude-desktop" : o.label,
      labelSource: "declared",
      summary: "s",
      createdAt: 0,
      expiresAt: 1,
    },
    payload: jira
      ? { mcpToolId: "jira_comment_add", input: { issueKey: "NIM-1", body: "hi" } }
      : { mcpToolId: "slack_message_post", input: { text: "hi" } },
  };
  await exec.execute(action);
}

/** One complete, correct history of an executed proposal. */
async function executed(
  n: number,
  at: number,
  o: Opts & { withBefore?: boolean } = {},
): Promise<string> {
  const id = idOf(n);
  submit(id, at, o);
  accept(id, at + 10, o);
  await dispatch(id, at + 20, o);
  outcome(id, at + 30, "executed");
  return id;
}

function prove(extra: Partial<Parameters<typeof proveByProposer>[1]> = {}): ProposerProof {
  return proveByProposer(db, { audit: OK_CHAIN, egress: OK_CHAIN, ...extra });
}
const codesOf = (p: ProposerProof): MismatchCode[] => p.completeness.mismatches.map((m) => m.code);

describe("classifyAuditRow - the anchored match", () => {
  const ID = idOf(1);
  const gate = (extraInput: string): string =>
    `{"action":{"type":"slack.message.post","proposer":{"door":"agent","captureId":"${ID}","label":"x","labelSource":"declared"},"origin":"agent","payload":{"mcpToolId":"slack_message_post","input":${extraInput}}},"answerSource":"human"}`;

  test("a gateway-written agent row is an agent row with its capture, label and source", () => {
    expect(classifyAuditRow("slack.message.post", gate("{}"))).toMatchObject({
      door: "agent",
      subStep: false,
      captureId: ID,
      label: "x",
      labelSource: "declared",
    });
  });

  test("a proposer object FORGED inside an input is not an agent row", () => {
    const forged = `{"action":{"type":"slack.message.post","payload":{"mcpToolId":"slack_message_post","input":{"proposer":{"door":"agent","captureId":"${ID}","label":"x","labelSource":"declared"}}}},"answerSource":"human"}`;
    expect(classifyAuditRow("slack.message.post", forged).door).toBe("other");
    // Even a forged copy of the whole prefix (an input object that spells it out) is not at the anchor.
    const spelled = `{"action":{"type":"slack.message.post","payload":{"mcpToolId":"m","input":{"action":{"type":"x","proposer":{"door":"agent","captureId":"${ID}","label":"x","labelSource":"declared"}}}}}}`;
    expect(classifyAuditRow("slack.message.post", spelled).door).toBe("other");
    const nested = `{"action":{"type":"x","payload":{"a":"{\\"action\\":{\\"type\\":\\"x\\",\\"proposer\\":{\\"door\\":\\"agent\\"}}}"}}}`;
    expect(classifyAuditRow("x", nested).door).toBe("other");
  });

  test("a row cut by the audit cap is still classified from its prefix", () => {
    const cut = `${gate(`{"body":"${"y".repeat(5000)}"}`).slice(0, 4096)}…[truncated]`;
    expect(classifyAuditRow("slack.message.post", cut)).toMatchObject({
      door: "agent",
      captureId: ID,
    });
  });

  test("the label and its escapes decode exactly (quotes, backslashes, astral, lone surrogates)", () => {
    const label = `"\\${String.fromCodePoint(0x1f600)}${String.fromCharCode(0xd800)}x`;
    const row = `{"action":{"type":"t","proposer":${JSON.stringify({ door: "agent", captureId: ID, label, labelSource: "kit" })},"payload":{}}}`;
    expect(classifyAuditRow("t", row)).toMatchObject({ door: "agent", label, labelSource: "kit" });
  });

  test("a sub-step row names its capture; a model, a workflow and an owner row are told apart", () => {
    expect(
      classifyAuditRow(
        "jira.before.read",
        `{"onBehalfOf":{"door":"agent","captureId":"${ID}"},"action":{"type":"jira.before.read","payload":{}}}`,
      ),
    ).toMatchObject({ door: "agent", subStep: true, captureId: ID });
    expect(
      classifyAuditRow(
        "t",
        `{"action":{"type":"t","origin":"model","payload":{}},"answerSource":"human"}`,
      ).door,
    ).toBe("model");
    expect(
      classifyAuditRow(
        "t",
        `{"action":{"type":"t","provenance":{"kind":"owner_workflow","workflowId":"w"},"payload":{}}}`,
      ).door,
    ).toBe("workflow");
    expect(classifyAuditRow("t", `{"action":{"type":"t","payload":{}}}`).door).toBe("other");
    expect(classifyAuditRow("t", "not json at all").door).toBe("other");
  });

  test("the pre-AD4 two-field projection is an agent row without a label", () => {
    const old = `{"action":{"type":"t","proposer":{"door":"agent","captureId":"${ID}"},"origin":"agent","payload":{}}}`;
    expect(classifyAuditRow("t", old)).toMatchObject({
      door: "agent",
      captureId: ID,
      legacyProjection: true,
    });
  });

  test("a malformed capture id in an agent-shaped row is not an agent row", () => {
    const bad = `{"action":{"type":"t","proposer":{"door":"agent","captureId":"cap_x","label":null,"labelSource":"declared"},"payload":{}}}`;
    expect(classifyAuditRow("t", bad).door).toBe("other");
  });
});

describe("proveByProposer - counts", () => {
  test("a correct history of one executed proposal: counts per label, ledgers agree, completeness ok", async () => {
    await executed(1, T0);
    const p = prove();
    expect(p.labelsVerified).toBe(false);
    expect(p.completeness.status).toBe("ok");
    expect(p.completeness.mismatches).toEqual([]);
    expect(p.completeness.checkedCaptures).toBe(1);
    expect(p.groups).toEqual([
      {
        label: "claude-desktop",
        labelSource: "declared",
        proposed: 1,
        refusedAtSubmit: 0,
        approved: 1,
        declined: 0,
        executed: 1,
        failed: 0,
        expired: 0,
        waiting: 0,
        dispatches: 1,
        connections: 1,
      },
    ]);
  });

  test("a mixed history: declined, rejected at the prompt, expired, waiting, failed, with sub-steps - all agree", async () => {
    await executed(1, T0, { withBefore: true });
    // Declined from the queue.
    submit(idOf(2), T0 + 100);
    reject(idOf(2), T0 + 110);
    // The owner said no at the prompt: a rejected gate row and a blocked ledger row.
    submit(idOf(3), T0 + 200);
    accept(idOf(3), T0 + 210);
    await dispatch(idOf(3), T0 + 220, { approve: false });
    outcome(idOf(3), T0 + 230, "rejected");
    // Expired.
    submit(idOf(4), T0 + 300);
    expire(idOf(4), T0 + 400);
    // Still waiting.
    submit(idOf(5), T0 + 500);
    // Failed after an approval (the connector threw is not modelled; the outcome row is).
    submit(idOf(6), T0 + 600);
    accept(idOf(6), T0 + 610);
    await dispatch(idOf(6), T0 + 620);
    outcome(idOf(6), T0 + 630, "failed");
    // A refused submit.
    refusedSubmit(T0 + 700, "claude-desktop");
    const p = prove();
    expect(codesOf(p)).toEqual([]);
    expect(p.completeness.status).toBe("ok");
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0]).toMatchObject({
      label: "claude-desktop",
      proposed: 6,
      refusedAtSubmit: 1,
      approved: 2,
      declined: 2,
      executed: 1,
      failed: 1,
      expired: 1,
      waiting: 1,
      dispatches: 2,
      connections: 1,
    });
  });

  test("two labels, a null label, and connections counted per label", async () => {
    await executed(1, T0, { label: "a", connection: "c1" });
    await executed(2, T0 + 100, { label: "a", connection: "c2" });
    await executed(3, T0 + 200, { label: null, connection: "c3" });
    const p = prove();
    expect(p.groups.map((g) => [g.label, g.proposed, g.connections])).toEqual([
      [null, 1, 1],
      ["a", 2, 2],
    ]);
    expect(p.completeness.status).toBe("ok");
  });

  test("every label is escaped for display by the approval prompt's own function", async () => {
    const nasty = `evil\n${String.fromCharCode(0x1b)}[2J"x\\`;
    await executed(1, T0, { label: nasty });
    const p = prove();
    expect(p.groups[0]?.label).toBe(escapeUnverifiedLine(nasty));
    expect(p.groups[0]?.label).not.toContain("\n");
    expect(p.groups[0]?.label).not.toContain(String.fromCharCode(0x1b));
  });

  test("--proposer keeps the groups whose label is the declared one and hides no mismatch", async () => {
    await executed(1, T0, { label: "a" });
    await executed(2, T0 + 100, { label: 'q"b' });
    expect(prove({ byLabel: "a" }).groups.map((g) => g.label)).toEqual(["a"]);
    expect(prove({ byLabel: 'q"b' }).groups).toHaveLength(1);
    // ONE form: the argument is the label as declared, so its escaped form is what is compared.
    expect(prove({ byLabel: escapeUnverifiedLine('q"b') }).groups).toHaveLength(0);
    expect(prove({ byLabel: "nobody" }).groups).toEqual([]);
    db.run("DELETE FROM egress_ledger WHERE source_id = ?", [`agent:${idOf(2)}`]);
    expect(codesOf(prove({ byLabel: "a" }))).not.toEqual([]);
  });

  test("the window selects the events counted; a submit row older than the window does not break the check", async () => {
    await executed(1, T0);
    const p = prove({ sinceMs: T0 + 15 });
    expect(p.completeness.status).toBe("ok");
    expect(p.groups[0]).toMatchObject({ proposed: 0, approved: 1, executed: 1, dispatches: 1 });
  });

  test("a forged proposer object inside an owner action's input is not counted", async () => {
    setSystemTime(new Date(T0));
    const exec = new ToolExecutor(
      { requestApproval: async () => ({ approved: true, answerSource: "human" as const }) },
      { recordAudit: (e) => appendAuditEntry(db, e) },
      { dispatch: async () => ({ ok: true }) },
      undefined,
      makeEgressSink(db),
      NO_POLICY_OVERLAY,
      () => "team",
    );
    await exec.execute({
      type: WRITE,
      payload: {
        mcpToolId: "slack_message_post",
        input: {
          action: {
            type: "x",
            proposer: {
              door: "agent",
              captureId: idOf(9),
              label: "forged",
              labelSource: "declared",
            },
          },
          text: "hi",
          proposer: { door: "agent", captureId: idOf(9), label: "forged", labelSource: "declared" },
        },
      },
    });
    const p = prove();
    expect(p.groups).toEqual([]);
    expect(p.completeness.checkedCaptures).toBe(0);
    expect(listByDoor(db, { door: "agent" }).rows).toEqual([]);
    expect(listByDoor(db, { door: "other" }).rows).toHaveLength(1);
  });
});

describe("proveByProposer - the completeness check", () => {
  async function healthy(): Promise<string> {
    return executed(1, T0, { withBefore: true });
  }

  test("a deleted egress row of the write is a mismatch (audit_row_without_egress_row)", async () => {
    const id = await healthy();
    db.run("DELETE FROM egress_ledger WHERE source_id = ? AND method = ?", [
      `agent:${id}`,
      "jira.comment.add",
    ]);
    const p = prove();
    expect(codesOf(p)).toContain("audit_row_without_egress_row");
    expect(p.completeness.status).toBe("indeterminate");
    expect(p.completeness.causes).toContain("mismatch");
  });

  test("a deleted audit row is a mismatch (egress_row_without_audit_row)", async () => {
    const id = await healthy();
    db.run("DELETE FROM audit_log WHERE action_type = 'jira.comment.add' AND action_json LIKE ?", [
      `%${id}%`,
    ]);
    expect(codesOf(prove())).toContain("egress_row_without_audit_row");
  });

  test("a flipped status is a mismatch (status_differs)", async () => {
    const id = await healthy();
    db.run(
      "UPDATE egress_ledger SET hitl_status = 'rejected', result_status = 'blocked' WHERE source_id = ? AND method = ?",
      [`agent:${id}`, "jira.comment.add"],
    );
    expect(codesOf(prove())).toContain("status_differs");
  });

  test("a blocked row beside an approval is a mismatch (result_status_differs)", async () => {
    const id = await healthy();
    db.run(
      "UPDATE egress_ledger SET result_status = 'blocked' WHERE source_id = ? AND method = ?",
      [`agent:${id}`, "jira.comment.add"],
    );
    expect(codesOf(prove())).toContain("result_status_differs");
  });

  test("a duplicated dispatch is a mismatch (duplicate_dispatch)", async () => {
    const id = await healthy();
    appendEgressEntry(db, {
      timestamp: T0 + 25,
      sourceType: "task",
      sourceId: `agent:${id}`,
      destination: "jira",
      method: "jira.comment.add",
      payloadSummary: "{}",
      hitlStatus: "approved",
      resultStatus: "authorized",
    });
    expect(codesOf(prove())).toContain("duplicate_dispatch");
  });

  test("an accepted proposal with no outcome, older than the newest boot marker, is a mismatch (missing_outcome)", async () => {
    const id = idOf(1);
    submit(id, T0);
    accept(id, T0 + 10);
    await dispatch(id, T0 + 20);
    appendBootMarker(db, THIS_BINARY_COVERAGE, T0 + 5_000);
    expect(codesOf(prove())).toContain("missing_outcome");
  });

  test("the same proposal with no outcome yet, accepted after the newest boot marker, is merely in flight", async () => {
    const id = idOf(1);
    submit(id, T0);
    accept(id, T0 + 10);
    await dispatch(id, T0 + 20);
    const p = prove();
    expect(codesOf(p)).toEqual([]);
    expect(p.completeness.status).toBe("ok");
  });

  test("a changed label is a mismatch (label_changed)", async () => {
    const id = await healthy();
    db.run(
      'UPDATE audit_log SET action_json = replace(action_json, \'"label":"claude-desktop"\', \'"label":"someone-else"\') WHERE action_type = \'jira.comment.add\'',
    );
    expect(codesOf(prove())).toContain("label_changed");
    void id;
  });

  test("a credential-shaped label is compared after the same redaction, so it is not a false mismatch", async () => {
    const label = `sk-${"a".repeat(30)}`;
    await executed(1, T0, { label });
    const p = prove();
    expect(codesOf(p)).toEqual([]);
    expect(p.completeness.status).toBe("ok");
  });

  test("executed without an approved gate row, and rejected beside one, are mismatches", async () => {
    // executed, but the owner's gate said no.
    const a = idOf(1);
    submit(a, T0);
    accept(a, T0 + 10);
    await dispatch(a, T0 + 20, { approve: false });
    outcome(a, T0 + 30, "executed");
    // rejected, but the gate approved.
    const b = idOf(2);
    submit(b, T0 + 100);
    accept(b, T0 + 110);
    await dispatch(b, T0 + 120);
    outcome(b, T0 + 130, "rejected");
    const codes = codesOf(prove());
    expect(codes).toContain("executed_without_approval");
    expect(codes).toContain("rejected_with_approval");
  });

  test("a second accept or a second outcome is a mismatch", async () => {
    const id = await executed(1, T0);
    accept(id, T0 + 40);
    outcome(id, T0 + 50, "executed");
    const codes = codesOf(prove());
    expect(codes).toContain("duplicate_accept");
    expect(codes).toContain("duplicate_outcome");
  });

  test("an egress agent row with no audit gate row at all is a mismatch, even with no accept row", () => {
    appendEgressEntry(db, {
      timestamp: T0,
      sourceType: "task",
      sourceId: `agent:${idOf(7)}`,
      destination: "slack",
      method: WRITE,
      payloadSummary: "{}",
      hitlStatus: "approved",
      resultStatus: "authorized",
    });
    expect(codesOf(prove())).toContain("egress_row_without_audit_row");
  });

  test("a gate row with no accept row is a mismatch (accept_missing)", async () => {
    submit(idOf(1), T0);
    await dispatch(idOf(1), T0 + 20);
    expect(codesOf(prove())).toContain("accept_missing");
  });

  test("the twelve codes are the whole vocabulary", () => {
    expect(MISMATCH_CODES).toHaveLength(12);
    expect(new Set<string>(MISMATCH_CODES)).toEqual(
      new Set<string>([
        "accept_missing",
        "audit_row_without_egress_row",
        "duplicate_accept",
        "duplicate_dispatch",
        "duplicate_outcome",
        "egress_row_without_audit_row",
        "executed_without_approval",
        "label_changed",
        "missing_outcome",
        "rejected_with_approval",
        "result_status_differs",
        "status_differs",
      ]),
    );
  });

  test("an accept just BEFORE the window with its dispatch inside it, egress row deleted, is a mismatch", async () => {
    const id = idOf(1);
    submit(id, T0);
    accept(id, T0 + 10);
    await dispatch(id, T0 + 100);
    outcome(id, T0 + 110, "executed");
    db.run("DELETE FROM egress_ledger WHERE source_id = ?", [`agent:${id}`]);
    const p = prove({ sinceMs: T0 + 50 });
    expect(codesOf(p)).toContain("audit_row_without_egress_row");
  });

  test("a proposal accepted before this version is not checked, counted, and never a mismatch", async () => {
    const id = idOf(1);
    submit(id, T0);
    accept(id, T0 + 10, { preVersion: true });
    await dispatch(id, T0 + 20);
    outcome(id, T0 + 30, "executed");
    db.run("DELETE FROM egress_ledger WHERE source_id = ?", [`agent:${id}`]);
    const p = prove();
    expect(p.completeness.status).toBe("ok");
    expect(p.completeness.notChecked.preVersionCaptures).toBe(1);
    expect(p.completeness.checkedCaptures).toBe(0);
  });
});

describe("proveByProposer - the egress prune", () => {
  async function pruned(before: number, ranAt: number): Promise<{ old: string; recent: string }> {
    const old = await executed(1, T0);
    // A boot after the cutoff, so a window that starts at the first surviving row is still covered.
    appendBootMarker(db, THIS_BINARY_COVERAGE, T0 + 6_000);
    const recent = await executed(2, T0 + 10_000);
    setSystemTime(new Date(ranAt));
    pruneEgress(db, before, ranAt);
    return { old, recent };
  }

  test("audit rows older than the prune's CUTOFF are not checked, counted; newer rows are checked", async () => {
    const { recent } = await pruned(T0 + 5_000, T0 + 20_000);
    const p = prove();
    expect(codesOf(p)).toEqual([]);
    expect(p.completeness.status).toBe("ok");
    expect(p.completeness.notChecked.prunedGateRows).toBeGreaterThan(0);
    expect(p.completeness.checkedCaptures).toBe(1);
    void recent;
  });

  test("a row NEWER than the cutoff but older than the tombstone's own timestamp IS checked", async () => {
    const { recent } = await pruned(T0 + 5_000, T0 + 20_000);
    // The recent capture's gate row (T0 + 10_020) is after the cutoff and before the tombstone.
    db.run("DELETE FROM egress_ledger WHERE source_id = ?", [`agent:${recent}`]);
    expect(codesOf(prove())).toContain("audit_row_without_egress_row");
  });

  test("a tombstone whose summary does not parse exempts nothing", async () => {
    await pruned(T0 + 5_000, T0 + 20_000);
    db.run("UPDATE egress_ledger SET payload_summary = 'garbage' WHERE source_type = 'prune'");
    expect(codesOf(prove())).toContain("audit_row_without_egress_row");
    db.run(
      "UPDATE egress_ledger SET payload_summary = '{\"before\":\"x\"}' WHERE source_type = 'prune'",
    );
    expect(codesOf(prove())).toContain("audit_row_without_egress_row");
  });

  test("a cutoff later than the tombstone's own timestamp is treated as that timestamp", async () => {
    await pruned(T0 + 5_000, T0 + 20_000);
    db.run("UPDATE egress_ledger SET payload_summary = ? WHERE source_type = 'prune'", [
      JSON.stringify({ before: T0 + 999_999_999, prunedCount: 1 }),
    ]);
    const p = prove();
    // Clamped to the run time (T0 + 20_000): both captures are older, so both are exempt.
    expect(p.completeness.checkedCaptures).toBe(0);
  });
});

describe("proveByProposer - causes of indeterminate", () => {
  test("a failed audit chain, a failed egress chain and no boot marker each make it indeterminate with their own cause", async () => {
    await executed(1, T0);
    expect(prove({ audit: { ok: false, reason: "x" } }).completeness.causes).toEqual([
      "audit_chain_broken",
    ]);
    expect(prove({ egress: { ok: false, reason: "y" } }).completeness.causes).toEqual([
      "egress_chain_broken",
    ]);
    db.run("DELETE FROM egress_ledger WHERE source_type = 'boot'");
    const p = prove();
    expect(p.completeness.status).toBe("indeterminate");
    expect(p.completeness.causes).toEqual(["coverage_none"]);
  });

  test("a scan over the row cap is cut and indeterminate", async () => {
    await executed(1, T0);
    await executed(2, T0 + 100);
    const p = prove({ maxRows: 3 });
    expect(p.scanCut).toBe(true);
    expect(p.completeness.status).toBe("indeterminate");
    expect(p.completeness.causes).toContain("scan_cut");
  });

  test("an unreadable lifecycle row is indeterminate; a cut outcome row is still read", async () => {
    const id = await executed(1, T0);
    appendAuditEntry(db, {
      actionType: "capture.action.accept",
      hitlStatus: "not_required",
      actionJson: `{"captureId":"${idOf(5)}",oops`,
      timestamp: T0 + 40,
    });
    const p = prove();
    expect(p.completeness.causes).toContain("unreadable_row");
    expect(p.completeness.unreadableRows).toBe(1);
    void id;
  });

  test("a cut outcome row (the audit cap) still counts as its outcome", async () => {
    const id = idOf(1);
    submit(id, T0);
    accept(id, T0 + 10);
    await dispatch(id, T0 + 20);
    appendAuditEntry(db, {
      actionType: "capture.action.outcome",
      hitlStatus: "not_required",
      actionJson: `{"captureId":"${id}","actionType":"${WRITE}","outcome":"executed","outcomeRef":"https://x/${"p".repeat(4100)}…[truncated]`,
      timestamp: T0 + 30,
    });
    const p = prove();
    expect(p.completeness.unreadableRows).toBe(0);
    expect(p.groups[0]?.executed).toBe(1);
    expect(p.completeness.status).toBe("ok");
  });
});

describe("rows written between AD1 and AD4 (the two-field projection)", () => {
  test("they are agent rows without a label, and their capture is not checked", () => {
    const id = idOf(1);
    submit(id, T0);
    accept(id, T0 + 10, { preVersion: true });
    appendAuditEntry(db, {
      actionType: WRITE,
      hitlStatus: "approved",
      actionJson: `{"action":{"type":"${WRITE}","proposer":{"door":"agent","captureId":"${id}"},"origin":"agent","payload":{}},"answerSource":"human"}`,
      timestamp: T0 + 20,
    });
    outcome(id, T0 + 30, "executed");
    const p = prove();
    expect(p.completeness.status).toBe("ok");
    expect(p.completeness.notChecked.preVersionCaptures).toBe(1);
    const rows = listByDoor(db, { door: "agent" }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ captureId: id, subStep: false });
    expect(rows[0]).not.toHaveProperty("label");
  });

  test("a refused submit is counted under its label and connection, in the window only", () => {
    refusedSubmit(T0, "refused-label", "conn-9");
    refusedSubmit(T0 + 5_000, "refused-label", "conn-10");
    const p = prove({ untilMs: T0 + 1_000 });
    expect(p.groups).toMatchObject([
      { label: "refused-label", refusedAtSubmit: 1, connections: 1, proposed: 0 },
    ]);
  });
});

describe("listByDoor", () => {
  test("the three doors and the rest, each row carrying the capture and the escaped label", async () => {
    await executed(1, T0, { label: "agent-a", withBefore: true });
    setSystemTime(new Date(T0 + 500));
    const exec = new ToolExecutor(
      { requestApproval: async () => ({ approved: true, answerSource: "human" as const }) },
      { recordAudit: (e) => appendAuditEntry(db, e) },
      { dispatch: async () => ({ ok: true }) },
      undefined,
      makeEgressSink(db),
      NO_POLICY_OVERLAY,
      () => "team",
    );
    await exec.execute({
      type: WRITE,
      origin: "model",
      payload: { mcpToolId: "slack_message_post", input: {} },
    });
    await exec.execute({ type: WRITE, payload: { mcpToolId: "slack_message_post", input: {} } });
    const agent = listByDoor(db, { door: "agent" });
    expect(agent.labelsVerified).toBe(false);
    expect(agent.rows.map((r) => [r.actionType, r.captureId, r.subStep])).toEqual([
      ["jira.comment.add", idOf(1), false],
      ["jira.before.read", idOf(1), true],
    ]);
    expect(agent.rows[0]?.label).toBe("agent-a");
    expect(listByDoor(db, { door: "model" }).rows).toHaveLength(1);
    expect(listByDoor(db, { door: "workflow" }).rows).toHaveLength(0);
    expect(listByDoor(db, { door: "other" }).rows.length).toBeGreaterThanOrEqual(1);
  });

  test("--proposer narrows to one label, the window and the limit bound the answer, a scan over the cap is flagged", async () => {
    await executed(1, T0, { label: "a" });
    await executed(2, T0 + 1_000, { label: "b" });
    expect(listByDoor(db, { door: "agent", byLabel: "b" }).rows.map((r) => r.captureId)).toEqual([
      idOf(2),
    ]);
    expect(
      listByDoor(db, { door: "agent", sinceMs: T0 + 500 }).rows.map((r) => r.captureId),
    ).toEqual([idOf(2)]);
    expect(listByDoor(db, { door: "agent", limit: 1 }).rows).toHaveLength(1);
    const cut = listByDoor(db, { door: "other", maxScan: 2 });
    expect(cut.scanCut).toBe(true);
  });
});

// ---- AD4 fix round: a bounded, window-aware read ------------------------------------------------

/** Raw rows (no chain): the reader never verifies the chain, the caller does. Fast enough for tens of thousands. */
function bulkOldHistory(captures: number, at: number): void {
  const insertAudit = db.prepare(
    "INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp, row_hash, prev_hash) VALUES (?, 'not_required', ?, ?, 'h', 'p')",
  );
  db.transaction(() => {
    for (let i = 0; i < captures; i += 1) {
      const id = idOf(1_000_000 + i);
      const t = at + i;
      insertAudit.run(
        "capture.submit",
        JSON.stringify({
          captureId: id,
          kind: "action",
          actionType: WRITE,
          clientLabel: "old-agent",
          connection: "c-old",
          outcome: "proposed",
        }),
        t,
      );
      insertAudit.run(
        "capture.action.accept",
        JSON.stringify({
          captureId: id,
          actionType: WRITE,
          door: "agent",
          clientLabel: "old-agent",
          labelSource: "declared",
          connection: "c-old",
        }),
        t,
      );
      insertAudit.run(
        "capture.action.outcome",
        JSON.stringify({ captureId: id, actionType: WRITE, outcome: "executed" }),
        t,
      );
    }
  })();
  insertAudit.finalize();
}

describe("proveByProposer - the read is bounded by the window's own captures", () => {
  const OLD_CAPTURES = 20_000; // 60,000 audit rows
  const CAP = 500;

  test("60,000 old rows outside --since consume no budget: the recent, correct history is ok", async () => {
    bulkOldHistory(OLD_CAPTURES, 1_000);
    await executed(1, T0);
    const p = prove({ sinceMs: T0 - 5, maxRows: CAP });
    expect(p.scanCut).toBe(false);
    expect(p.scanCutSides).toEqual([]);
    expect(p.completeness.status).toBe("ok");
    expect(p.completeness.checkedCaptures).toBe(1);
    // The old captures are neither counted nor checked.
    expect(p.groups.map((g) => g.label)).toEqual(["claude-desktop"]);
    expect(p.groups[0]).toMatchObject({ proposed: 1, approved: 1, executed: 1, dispatches: 1 });
  });

  test("the same history with a deleted recent egress row reports the mismatch, not a cut", async () => {
    bulkOldHistory(OLD_CAPTURES, 1_000);
    const id = await executed(1, T0);
    db.run("DELETE FROM egress_ledger WHERE source_id = ?", [`agent:${id}`]);
    const p = prove({ sinceMs: T0 - 5, maxRows: CAP });
    expect(codesOf(p)).toContain("audit_row_without_egress_row");
    expect(p.scanCut).toBe(false);
  });

  test("with no --since the window is all history and the cap is a real limit, naming the audit side", async () => {
    bulkOldHistory(OLD_CAPTURES, 1_000);
    await executed(1, T0);
    const p = prove({ maxRows: CAP });
    expect(p.scanCut).toBe(true);
    expect(p.scanCutSides).toEqual(["audit"]);
    expect(p.completeness.status).toBe("indeterminate");
    expect(p.completeness.causes).toContain("scan_cut");
  });

  test("a window that itself selects more rows than the cap is cut, and the egress side is named when it is the one", async () => {
    await executed(1, T0);
    await executed(2, T0 + 100);
    const audit = prove({ sinceMs: T0 - 5, maxRows: 4 });
    expect(audit.scanCutSides).toContain("audit");
    expect(audit.completeness.causes).toContain("scan_cut");
    db.run("DELETE FROM audit_log WHERE action_type LIKE 'capture.%'");
    const egress = prove({ sinceMs: T0 - 5, maxRows: 1 });
    expect(egress.scanCutSides).toContain("egress");
  });

  test("a capture whose accept row is older than the window but whose outcome is inside it is still counted", async () => {
    const id = idOf(1);
    submit(id, T0);
    accept(id, T0 + 10);
    await dispatch(id, T0 + 20);
    outcome(id, T0 + 300, "executed");
    const p = prove({ sinceMs: T0 + 200 });
    expect(p.groups[0]).toMatchObject({ executed: 1, approved: 0 });
  });

  test("an unreadable row older than the window is not this window's problem", async () => {
    appendAuditEntry(db, {
      actionType: "capture.action.accept",
      hitlStatus: "not_required",
      actionJson: `{"captureId":"${idOf(5)}",oops`,
      timestamp: T0 - 500,
    });
    await executed(1, T0);
    expect(prove({ sinceMs: T0 - 5 }).completeness.unreadableRows).toBe(0);
    expect(prove().completeness.unreadableRows).toBe(1);
  });
});

describe("a request's own session id cannot write the reserved range", () => {
  test("an unrelated action run under sessionId agent:<real capture> is not in that capture's proof", async () => {
    const id = await executed(1, T0);
    const before = JSON.stringify(prove());
    setSystemTime(new Date(T0 + 500));
    const exec = new ToolExecutor(
      { requestApproval: async () => ({ approved: true, answerSource: "human" as const }) },
      { recordAudit: (e) => appendAuditEntry(db, e) },
      { dispatch: async () => ({ ok: true }) },
      undefined,
      makeEgressSink(db),
      NO_POLICY_OVERLAY,
      () => "team",
    );
    await agentRequestContext.run({ sessionId: `agent:${id}` }, () =>
      exec.execute({ type: WRITE, payload: { mcpToolId: "slack_message_post", input: {} } }),
    );
    const stored = db
      .query<{ source_id: string | null }, []>(
        "SELECT source_id FROM egress_ledger WHERE source_type = 'task' ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(stored?.source_id).toBe(`session:agent:${id}`);
    const after = prove();
    expect(JSON.stringify(after)).toBe(before);
    expect(after.completeness.status).toBe("ok");
    expect(after.groups[0]?.dispatches).toBe(1);
  });

  test("a stray malformed row in the reserved range is reported, and never makes another capture indeterminate", async () => {
    await executed(1, T0);
    for (const forged of ["agent:x", "agent:", `agent:${idOf(1)}|x`, `agent:${idOf(1)}x`]) {
      appendEgressEntry(db, {
        timestamp: T0 + 600,
        sourceType: "task",
        sourceId: forged,
        destination: "slack",
        method: WRITE,
        payloadSummary: "{}",
        hitlStatus: "approved",
        resultStatus: "authorized",
      });
    }
    const p = prove();
    expect(p.completeness.status).toBe("ok");
    expect(p.completeness.mismatches).toEqual([]);
    expect(p.completeness.foreignRows).toBe(4);
    expect(p.completeness.causes).toEqual([]);
    expect(p.groups[0]?.dispatches).toBe(1);
  });

  test("a well-formed stray row names its capture and is a mismatch for that capture only", async () => {
    const id = await executed(1, T0);
    await executed(2, T0 + 100);
    appendEgressEntry(db, {
      timestamp: T0 + 600,
      sourceType: "task",
      sourceId: `agent:${id}`,
      destination: "slack",
      method: "slack.other.thing",
      payloadSummary: "{}",
      hitlStatus: "approved",
      resultStatus: "authorized",
    });
    const p = prove();
    expect(p.completeness.mismatches.length).toBeGreaterThan(0);
    expect(p.completeness.mismatches.every((m) => m.captureId === id)).toBe(true);
    expect(codesOf(p)).toContain("egress_row_without_audit_row");
  });
});

describe("--proposer matches ONE form, and prove and audit --door agree", () => {
  test("one argument cannot select two labels: the escaped form of A is the raw text of B", async () => {
    const labelA = 'a"b';
    const labelB = String.raw`a\"b`; // escapeUnverifiedLine(labelA) === labelB
    expect(escapeUnverifiedLine(labelA)).toBe(labelB);
    await executed(1, T0, { label: labelA });
    await executed(2, T0 + 100, { label: labelB });
    expect(prove({ byLabel: labelA }).groups.map((g) => g.label)).toEqual([
      escapeUnverifiedLine(labelA),
    ]);
    expect(prove({ byLabel: labelB }).groups.map((g) => g.label)).toEqual([
      escapeUnverifiedLine(labelB),
    ]);
    const doorA = listByDoor(db, { door: "agent", byLabel: labelA }).rows.map((r) => r.captureId);
    const doorB = listByDoor(db, { door: "agent", byLabel: labelB }).rows.map((r) => r.captureId);
    expect(doorA).toEqual([idOf(1)]);
    expect(doorB).toEqual([idOf(2)]);
  });

  test("a credential-shaped label is grouped and matched by the same (redacted) value in both views", async () => {
    const raw = `agent ghp_${"a".repeat(30)}`;
    await executed(1, T0, { label: raw });
    const p = prove();
    expect(p.groups).toHaveLength(1);
    const shown = p.groups[0]?.label;
    expect(shown).not.toContain("ghp_");
    expect(p.completeness.status).toBe("ok");
    const listed = listByDoor(db, { door: "agent" }).rows.find((r) => !r.subStep);
    expect(listed?.label).toBe(shown);
    // The declared (raw) label finds the same capture in both commands.
    expect(prove({ byLabel: raw }).groups.map((g) => g.label)).toEqual([shown ?? null]);
    expect(listByDoor(db, { door: "agent", byLabel: raw }).rows.map((r) => r.captureId)).toContain(
      idOf(1),
    );
  });

  test("totalGroups counts every group of the window, before --proposer filters", async () => {
    await executed(1, T0, { label: "a" });
    await executed(2, T0 + 100, { label: "b" });
    await executed(3, T0 + 200, { label: null });
    const p = prove({ byLabel: "nobody" });
    expect(p.groups).toEqual([]);
    expect(p.totalGroups).toBe(3);
    expect(prove({ byLabel: "a" }).totalGroups).toBe(3);
  });

  test("the completeness result stays unfiltered by --proposer", async () => {
    await executed(1, T0, { label: "a" });
    const id = await executed(2, T0 + 100, { label: "b" });
    db.run("DELETE FROM egress_ledger WHERE source_id = ?", [`agent:${id}`]);
    const p = prove({ byLabel: "a" });
    expect(p.groups.map((g) => g.label)).toEqual(["a"]);
    expect(p.completeness.mismatches.map((m) => m.captureId)).toEqual([id]);
    expect(p.completeness.status).toBe("indeterminate");
  });
});
