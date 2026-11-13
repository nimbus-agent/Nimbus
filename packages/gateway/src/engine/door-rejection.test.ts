import { describe, expect, test } from "bun:test";

import { COMMIT_INPUT_REFUSALS } from "../connectors/connector-writes/commit-limits.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import type { ConnectorWriteRow } from "../connectors/connector-writes/types.ts";
import { WAVE4_BEFORE_REFUSAL } from "./before-state.ts";
import { classifyDoorRejection, DOOR_REJECTION_CODES } from "./door-rejection.ts";
import { PREPARE_REFUSALS } from "./prepare-step.ts";

const row = (pred: (r: ConnectorWriteRow) => boolean): ConnectorWriteRow => {
  const r = CONNECTOR_WRITE_ROWS.find(pred);
  if (r === undefined) throw new Error("fixture row missing");
  return r;
};
const GUARDED = row((r) => r.before?.guard !== undefined && r.wave < 4);
const WAVE4_UNBOUND = row((r) => r.wave === 4 && r.bound === undefined);
const WAVE2 = row((r) => r.wave === 2 && r.before?.guard === undefined && r.bound === undefined);
const BOUND = row((r) => r.bound !== undefined);

describe("classifyDoorRejection", () => {
  test("a row's own guard reason is a guard refusal", () => {
    expect(classifyDoorRejection(GUARDED, GUARDED.before?.guard?.reason)).toBe(
      "ERR_ACTION_GUARD_REFUSED",
    );
  });

  test("another row's guard reason is not this row's", () => {
    const other = row((r) => r.before?.guard !== undefined && r !== GUARDED);
    expect(other.before?.guard?.reason).not.toBe(GUARDED.before?.guard?.reason);
    expect(classifyDoorRejection(GUARDED, other.before?.guard?.reason)).toBeUndefined();
  });

  test("an unread current state refuses a Wave 4 row only", () => {
    expect(classifyDoorRejection(WAVE4_UNBOUND, WAVE4_BEFORE_REFUSAL)).toBe(
      "ERR_ACTION_BEFORE_STATE_UNREADABLE",
    );
    expect(classifyDoorRejection(WAVE2, WAVE4_BEFORE_REFUSAL)).toBeUndefined();
  });

  test("a fixed bound refusal is a prepare refusal for a bound row only", () => {
    for (const reason of [PREPARE_REFUSALS.failed, COMMIT_INPUT_REFUSALS.filesInvalid]) {
      if (reason === undefined) continue;
      expect(classifyDoorRejection(BOUND, reason), reason).toBe("ERR_ACTION_PREPARE_REFUSED");
      expect(classifyDoorRejection(WAVE2, reason), reason).toBeUndefined();
    }
  });

  test("a plain decline, a mistyped confirmation, a non-human answer and an absent reason store no code", () => {
    for (const reason of [
      "User declined consent gate.",
      "the confirmation did not match",
      "the approval did not come from a person",
      "",
      undefined,
    ]) {
      for (const r of [GUARDED, WAVE4_UNBOUND, WAVE2, BOUND, undefined]) {
        expect(classifyDoorRejection(r, reason), String(reason)).toBeUndefined();
      }
    }
  });

  test("the codes are a subset of the capture sink's reject codes", async () => {
    const { ACTION_REJECT_CODES } = await import("../mcp-sink/capture-types.ts");
    for (const c of DOOR_REJECTION_CODES) expect(ACTION_REJECT_CODES).toContain(c);
  });
});
