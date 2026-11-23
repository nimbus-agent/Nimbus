import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { ConnectorWriteRow } from "../connectors/connector-writes/types.ts";
import {
  claimProposal,
  claimUndo,
  finishProposal,
  finishUndo,
  type ProposalDraft,
  syncProposals,
} from "../incident/proposal-store.ts";
import type { Remediation } from "../incident/remediation.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { latestUndoableActionId, undoOrLatest } from "./incident-undo.ts";

const REC = "inc_0123456789abcdef";
const rowWith = (toolId: string, cls: "reversible" | "irreversible"): ConnectorWriteRow =>
  ({
    toolId,
    reversibility:
      cls === "reversible"
        ? { class: "reversible", inverse: "x", invert: () => ({}) }
        : { class: "irreversible", reason: "r" },
  }) as unknown as ConnectorWriteRow;
const ROWS = [rowWith("rev_tool", "reversible"), rowWith("irrev_tool", "irreversible")];

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

function run(db: Database, n: number, toolId: string, at: number, captured: boolean): string {
  const id = `prp_${String(n).padStart(16, "0")}`;
  const draft: ProposalDraft = {
    id,
    kind: "k",
    toolId,
    input: {},
    evidence: {},
    confidence: null,
    reversibility: "reversible",
  };
  syncProposals(db, { recordId: REC, version: 1, drafts: [draft], nowMs: 1, revive: false });
  const actionId = `act_${String(n).padStart(16, "0")}`;
  expect(claimProposal(db, id, actionId, 2)).toEqual({ ok: true });
  finishProposal(db, id, "executed", at, captured ? { k: "v" } : undefined);
  return actionId;
}

describe("latestUndoableActionId", () => {
  test("is undefined with no history", () => {
    expect(latestUndoableActionId(freshDb(), ROWS)).toBeUndefined();
  });

  test("takes the newest executed reversible action by its stable executed time", () => {
    const db = freshDb();
    const older = run(db, 1, "rev_tool", 100, true);
    const newer = run(db, 2, "rev_tool", 200, true);
    expect(latestUndoableActionId(db, ROWS)).toBe(newer);
    // A later touch of the older row (a re-listing moves updated_at_ms) does not change the order.
    db.run("UPDATE incident_proposal SET updated_at_ms = 9999 WHERE action_id = ?", [older]);
    expect(latestUndoableActionId(db, ROWS)).toBe(newer);
  });

  test("skips an irreversible row, one with no before-state, an undone one and an undoing one", () => {
    const db = freshDb();
    const good = run(db, 1, "rev_tool", 100, true);
    run(db, 2, "irrev_tool", 200, true);
    run(db, 3, "rev_tool", 300, false);
    const undone = run(db, 4, "rev_tool", 400, true);
    expect(claimUndo(db, undone, 410)).toBe(true);
    expect(latestUndoableActionId(db, ROWS)).toBe(good);
    expect(finishUndo(db, undone, "undone", 420)).toBe(true);
    expect(latestUndoableActionId(db, ROWS)).toBe(good);
    // A failed undo goes back to NULL and the action is a candidate again.
    const retry = run(db, 5, "rev_tool", 500, true);
    claimUndo(db, retry, 510);
    finishUndo(db, retry, "retry", 520);
    expect(latestUndoableActionId(db, ROWS)).toBe(retry);
  });

  test("only an executed run stamps executed_at_ms", () => {
    const db = freshDb();
    const id = "prp_0000000000000009";
    syncProposals(db, {
      recordId: REC,
      version: 1,
      drafts: [
        {
          id,
          kind: "k",
          toolId: "rev_tool",
          input: {},
          evidence: {},
          confidence: null,
          reversibility: "reversible",
        },
      ],
      nowMs: 1,
      revive: false,
    });
    claimProposal(db, id, "act_0000000000000009", 2);
    finishProposal(db, id, "denied", 50);
    expect(db.query("SELECT executed_at_ms AS t FROM incident_proposal").get()).toEqual({
      t: null,
    });
  });
});

describe("undoOrLatest", () => {
  const fake = (calls: string[]): Pick<Remediation, "undo"> => ({
    undo: async (p) => {
      calls.push(`${p.actionId} ${p.clientId}`);
      return { actionId: p.actionId, status: "undone", nonHuman: false };
    },
  });

  test("a named id passes straight through", async () => {
    const calls: string[] = [];
    await undoOrLatest(fake(calls), freshDb(), "act_0123456789abcdef", "c1");
    expect(calls).toEqual(["act_0123456789abcdef c1"]);
  });

  test("no id with no history is a refusal that runs nothing", () => {
    const calls: string[] = [];
    expect(() => undoOrLatest(fake(calls), freshDb(), undefined, "c1")).toThrow(
      /no executed reversible action/,
    );
    expect(calls).toEqual([]);
  });

  test("a malformed id is refused, never treated as no id", () => {
    for (const bad of ["", 5, null, "x".repeat(65)]) {
      expect(() => undoOrLatest(fake([]), freshDb(), bad, "c1")).toThrow(/non-empty string/);
    }
  });
});
