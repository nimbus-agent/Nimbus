import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  claimProposal,
  claimUndo,
  deleteProposalsForRecords,
  executedCount,
  finishProposal,
  finishUndo,
  getProposal,
  getProposalByAction,
  isAdvisory,
  listProposals,
  PROPOSAL_TTL_MS,
  type ProposalDraft,
  STALE_EXECUTING_MS,
  setAdvisory,
  supersedeProposal,
  syncProposals,
} from "./proposal-store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

const draft = (n: number, over: Partial<ProposalDraft> = {}): ProposalDraft => ({
  id: `prp_${String(n).padStart(16, "0")}`,
  kind: "ack",
  toolId: "pd_incident_acknowledge",
  input: { incidentId: `P${String(n)}` },
  evidence: { rule: "open" },
  confidence: null,
  reversibility: "irreversible",
  ...over,
});

const REC = "inc_0123456789abcdef";
const T0 = 1_000_000;

const sync = (
  db: Database,
  drafts: ProposalDraft[],
  over: { now?: number; revive?: boolean; version?: number; recordId?: string } = {},
) =>
  syncProposals(db, {
    recordId: over.recordId ?? REC,
    version: over.version ?? 1,
    drafts,
    nowMs: over.now ?? T0,
    revive: over.revive ?? false,
  });

describe("syncProposals", () => {
  test("inserts proposed rows with the TTL, the input and the evidence as JSON", () => {
    const db = freshDb();
    sync(db, [draft(1)]);
    const row = getProposal(db, draft(1).id);
    expect(row).toMatchObject({
      record_id: REC,
      record_version: 1,
      kind: "ack",
      tool_id: "pd_incident_acknowledge",
      status: "proposed",
      reversibility: "irreversible",
      confidence: null,
      created_at_ms: T0,
      expires_at_ms: T0 + PROPOSAL_TTL_MS,
      action_id: null,
      captured_json: null,
    });
    expect(JSON.parse(row?.input_json ?? "")).toEqual({ incidentId: "P1" });
    expect(JSON.parse(row?.evidence_json ?? "")).toEqual({ rule: "open" });
  });

  test("re-deriving the same proposal keeps its expiry and updates the record version and evidence", () => {
    const db = freshDb();
    sync(db, [draft(1)]);
    sync(db, [draft(1, { evidence: { rule: "newer" }, confidence: 60 })], {
      now: T0 + 1000,
      version: 2,
    });
    const row = getProposal(db, draft(1).id);
    expect(row).toMatchObject({
      record_version: 2,
      status: "proposed",
      expires_at_ms: T0 + PROPOSAL_TTL_MS,
      confidence: 60,
    });
    expect(listProposals(db, REC)).toHaveLength(1);
  });

  test("a proposed row no longer derived is superseded; an empty derivation supersedes them all", () => {
    const db = freshDb();
    sync(db, [draft(1), draft(2)]);
    const out = sync(db, [draft(2)], { now: T0 + 1 });
    expect(out.superseded).toBe(1);
    expect(getProposal(db, draft(1).id)?.status).toBe("superseded");
    expect(getProposal(db, draft(2).id)?.status).toBe("proposed");
    expect(sync(db, [], { now: T0 + 2 }).superseded).toBe(1);
    expect(getProposal(db, draft(2).id)?.status).toBe("superseded");
  });

  test("another record's proposals are never touched", () => {
    const db = freshDb();
    sync(db, [draft(1)]);
    sync(db, [draft(2)], { recordId: "inc_fedcba9876543210" });
    sync(db, [], { now: T0 + 1 });
    expect(getProposal(db, draft(2).id)?.status).toBe("proposed");
  });

  test("a proposed row past its TTL expires, for every record", () => {
    const db = freshDb();
    sync(db, [draft(1)]);
    sync(db, [draft(2)], { recordId: "inc_fedcba9876543210" });
    const out = sync(db, [draft(2)], {
      now: T0 + PROPOSAL_TTL_MS,
      recordId: "inc_fedcba9876543210",
    });
    expect(out.expired).toBe(2);
    expect(getProposal(db, draft(1).id)?.status).toBe("expired");
    expect(getProposal(db, draft(2).id)?.status).toBe("expired");
  });

  test("an expired, superseded, denied or failed row is revived ONLY by a listing (revive), with a fresh TTL", () => {
    const db = freshDb();
    sync(db, [draft(1), draft(2), draft(3), draft(4)]);
    for (const [n, to] of [
      [1, "expired"],
      [2, "superseded"],
    ] as const) {
      db.run("UPDATE incident_proposal SET status = ? WHERE id = ?", [to, draft(n).id]);
    }
    for (const [n, to] of [
      [3, "denied"],
      [4, "failed"],
    ] as const) {
      db.run("UPDATE incident_proposal SET status = 'executing', action_id = ? WHERE id = ?", [
        `act_${String(n)}`,
        draft(n).id,
      ]);
      expect(finishProposal(db, draft(n).id, to, T0)).toBe(true);
    }
    const all = [draft(1), draft(2), draft(3), draft(4)];
    sync(db, all, { now: T0 + 5 });
    expect(all.map((d) => getProposal(db, d.id)?.status)).toEqual([
      "expired",
      "superseded",
      "denied",
      "failed",
    ]);
    sync(db, all, { now: T0 + 10, revive: true });
    expect(all.map((d) => getProposal(db, d.id)?.status)).toEqual([
      "proposed",
      "proposed",
      "proposed",
      "proposed",
    ]);
    expect(getProposal(db, draft(1).id)?.expires_at_ms).toBe(T0 + 10 + PROPOSAL_TTL_MS);
  });

  test("executing and executed rows are never revived or rewritten", () => {
    const db = freshDb();
    sync(db, [draft(1), draft(2)]);
    expect(claimProposal(db, draft(1).id, "act_a", T0 + 1)).toEqual({ ok: true });
    expect(claimProposal(db, draft(2).id, "act_b", T0 + 1)).toEqual({ ok: true });
    finishProposal(db, draft(2).id, "executed", T0 + 2, { on: "true" });
    sync(db, [draft(1, { evidence: "x" }), draft(2, { evidence: "x" })], {
      now: T0 + 3,
      revive: true,
      version: 9,
    });
    expect(getProposal(db, draft(1).id)).toMatchObject({ status: "executing", record_version: 1 });
    expect(getProposal(db, draft(2).id)).toMatchObject({
      status: "executed",
      record_version: 1,
      evidence_json: '{"rule":"open"}',
    });
  });

  test("an executing row older than the stale bound fails at the next sync (a crashed gateway)", () => {
    const db = freshDb();
    sync(db, [draft(1)]);
    claimProposal(db, draft(1).id, "act_a", T0 + 1);
    expect(sync(db, [draft(1)], { now: T0 + STALE_EXECUTING_MS }).staleExecuting).toBe(0);
    const out = sync(db, [draft(1)], { now: T0 + 2 + STALE_EXECUTING_MS });
    expect(out.staleExecuting).toBe(1);
    expect(getProposal(db, draft(1).id)?.status).toBe("failed");
  });
});

describe("a crashed undo is released", () => {
  test("an undoing row older than the stale bound goes back to NULL at the next sync, so the undo can be retried", () => {
    const db = freshDb();
    sync(db, [draft(1)]);
    claimProposal(db, draft(1).id, "act_a", T0);
    finishProposal(db, draft(1).id, "executed", T0 + 1, { on: "true" });
    expect(claimUndo(db, "act_a", T0 + 2)).toBe(true);
    expect(sync(db, [draft(1)], { now: T0 + 2 + STALE_EXECUTING_MS }).staleUndoing).toBe(0);
    expect(getProposal(db, draft(1).id)?.undo_status).toBe("undoing");
    const out = sync(db, [draft(1)], { now: T0 + 3 + STALE_EXECUTING_MS });
    expect(out.staleUndoing).toBe(1);
    expect(getProposal(db, draft(1).id)?.undo_status).toBeNull();
    expect(claimUndo(db, "act_a", T0 + 4 + STALE_EXECUTING_MS)).toBe(true);
  });
});

describe("claimProposal: one statement decides, so two claims never both win", () => {
  test("two concurrent claims of one proposal: exactly one wins, the other is busy", async () => {
    const db = freshDb();
    sync(db, [draft(1)]);
    const results = await Promise.all([
      Promise.resolve().then(() => claimProposal(db, draft(1).id, "act_one", T0 + 1)),
      Promise.resolve().then(() => claimProposal(db, draft(1).id, "act_two", T0 + 1)),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "busy" });
    expect(getProposal(db, draft(1).id)?.status).toBe("executing");
  });

  test("the reasons: missing, expired (past the TTL or already expired), stale (any other status)", () => {
    const db = freshDb();
    expect(claimProposal(db, "prp_nope", "act_x", T0)).toEqual({ ok: false, reason: "missing" });
    sync(db, [draft(1), draft(2), draft(3)]);
    expect(claimProposal(db, draft(1).id, "act_1", T0 + PROPOSAL_TTL_MS)).toEqual({
      ok: false,
      reason: "expired",
    });
    db.run("UPDATE incident_proposal SET status = 'expired' WHERE id = ?", [draft(2).id]);
    expect(claimProposal(db, draft(2).id, "act_2", T0)).toEqual({ ok: false, reason: "expired" });
    db.run("UPDATE incident_proposal SET status = 'superseded' WHERE id = ?", [draft(3).id]);
    expect(claimProposal(db, draft(3).id, "act_3", T0)).toEqual({ ok: false, reason: "stale" });
  });

  test("a claimed proposal cannot be claimed again, nor superseded; finish needs executing", () => {
    const db = freshDb();
    sync(db, [draft(1)]);
    expect(claimProposal(db, draft(1).id, "act_a", T0 + 1).ok).toBe(true);
    expect(claimProposal(db, draft(1).id, "act_b", T0 + 1)).toEqual({ ok: false, reason: "busy" });
    expect(supersedeProposal(db, draft(1).id, T0 + 2)).toBe(false);
    expect(finishProposal(db, draft(1).id, "executed", T0 + 3, { s: "v" })).toBe(true);
    expect(finishProposal(db, draft(1).id, "failed", T0 + 4)).toBe(false);
    const row = getProposal(db, draft(1).id);
    expect(row).toMatchObject({ status: "executed", action_id: "act_a" });
    expect(JSON.parse(row?.captured_json ?? "")).toEqual({ s: "v" });
    expect(getProposalByAction(db, "act_a")?.id).toBe(draft(1).id);
    expect(getProposalByAction(db, "act_zz")).toBeNull();
  });

  test("a finish without captured values stores NULL, and supersede moves only a proposed row", () => {
    const db = freshDb();
    sync(db, [draft(1), draft(2)]);
    claimProposal(db, draft(1).id, "act_a", T0);
    finishProposal(db, draft(1).id, "denied", T0 + 1);
    expect(getProposal(db, draft(1).id)).toMatchObject({ status: "denied", captured_json: null });
    expect(supersedeProposal(db, draft(2).id, T0 + 1)).toBe(true);
    expect(supersedeProposal(db, draft(2).id, T0 + 2)).toBe(false);
  });
});

describe("undo is claimed once", () => {
  function executed(db: Database): void {
    sync(db, [draft(1)]);
    claimProposal(db, draft(1).id, "act_a", T0);
    finishProposal(db, draft(1).id, "executed", T0 + 1, { on: "true" });
  }

  test("exactly one of two concurrent undos claims; a retry after a declined undo is possible; undone is final", async () => {
    const db = freshDb();
    executed(db);
    const got = await Promise.all([
      Promise.resolve().then(() => claimUndo(db, "act_a", T0 + 2)),
      Promise.resolve().then(() => claimUndo(db, "act_a", T0 + 2)),
    ]);
    expect(got.filter(Boolean)).toHaveLength(1);
    expect(finishUndo(db, "act_a", "retry", T0 + 3)).toBe(true);
    expect(getProposal(db, draft(1).id)?.undo_status).toBeNull();
    expect(claimUndo(db, "act_a", T0 + 4)).toBe(true);
    expect(finishUndo(db, "act_a", "undone", T0 + 5)).toBe(true);
    expect(getProposal(db, draft(1).id)).toMatchObject({
      undo_status: "undone",
      undone_at_ms: T0 + 5,
    });
    expect(claimUndo(db, "act_a", T0 + 6)).toBe(false);
    expect(finishUndo(db, "act_a", "undone", T0 + 7)).toBe(false);
  });

  test("only an executed action can be undone", () => {
    const db = freshDb();
    sync(db, [draft(1)]);
    claimProposal(db, draft(1).id, "act_a", T0);
    expect(claimUndo(db, "act_a", T0 + 1)).toBe(false);
    expect(claimUndo(db, "act_unknown", T0 + 1)).toBe(false);
  });
});

describe("counts, erasure, advisory", () => {
  test("executedCount counts executed proposals of one record only", () => {
    const db = freshDb();
    sync(db, [draft(1), draft(2)]);
    claimProposal(db, draft(1).id, "act_a", T0);
    finishProposal(db, draft(1).id, "executed", T0);
    claimProposal(db, draft(2).id, "act_b", T0);
    finishProposal(db, draft(2).id, "failed", T0);
    expect(executedCount(db, REC)).toBe(1);
    expect(executedCount(db, "inc_fedcba9876543210")).toBe(0);
  });

  test("deleteProposalsForRecords deletes the named records' proposals (in chunks) and nothing else", () => {
    const db = freshDb();
    sync(db, [draft(1)]);
    sync(db, [draft(2)], { recordId: "inc_fedcba9876543210" });
    const many = Array.from({ length: 600 }, (_, i) => `inc_${String(i).padStart(16, "0")}`);
    expect(deleteProposalsForRecords(db, [REC, ...many])).toBe(1);
    expect(listProposals(db, REC)).toEqual([]);
    expect(listProposals(db, "inc_fedcba9876543210")).toHaveLength(1);
    expect(deleteProposalsForRecords(db, [])).toBe(0);
  });

  test("advisory is off by default and set/clear round-trips", () => {
    const db = freshDb();
    expect(isAdvisory(db)).toBe(false);
    setAdvisory(db, true, T0);
    expect(isAdvisory(db)).toBe(true);
    setAdvisory(db, false, T0 + 1);
    expect(isAdvisory(db)).toBe(false);
    expect(
      (db.query("SELECT count(*) AS n FROM incident_engine_state").get() as { n: number }).n,
    ).toBe(1);
  });
});
