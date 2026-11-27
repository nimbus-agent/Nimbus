// The undo's fresh-state vet over a before-state runner (`before-state-vet.ts`), and the reversibility rules it
// applies (`undoFreshRefusal`): the end-to-end undo is pinned in `incident/remediation-flag-writes.test.ts`.
import { describe, expect, test } from "bun:test";

import {
  undoFreshRefusal,
  undoNeedsFreshRead,
} from "../connectors/connector-writes/reversibility.ts";
import type { BeforeStateOutcome, BeforeStateRunner } from "./before-state.ts";
import { VET_FAILED_REASON, vettedBeforeStateRunner } from "./before-state-vet.ts";
import type { PlannedAction } from "./types.ts";

const ACTION: PlannedAction = { type: "unleash.feature.toggle", payload: {} };
const OK: BeforeStateOutcome = { status: "ok", fields: [] };
const OPS = { gate: async () => "proceed" as const, dispatch: async () => ({}) };

/** A runner that reports `capture` (when given) to its observer and returns `out`. */
function fake(out: BeforeStateOutcome | undefined, capture?: Record<string, string>) {
  return (onCaptured: (a: PlannedAction, c: Readonly<Record<string, string>>) => void) =>
    ({
      rows: [],
      async read(action) {
        if (capture !== undefined) onCaptured(action, capture);
        return out;
      },
    }) satisfies BeforeStateRunner;
}

describe("vettedBeforeStateRunner", () => {
  test("without a vet it is the runner itself, and the observer is still told", async () => {
    const seen: unknown[] = [];
    const runner = vettedBeforeStateRunner(
      fake(OK, { k: "v" }),
      (_a, c) => seen.push(c),
      undefined,
    );
    expect(await runner.read(ACTION, OPS)).toBe(OK);
    expect(seen).toEqual([{ k: "v" }]);
  });

  test("the vet sees the fresh capture, or undefined when nothing was captured, and may refuse", async () => {
    const vetted: unknown[] = [];
    const vet = (_a: PlannedAction, c: Readonly<Record<string, string>> | undefined) => {
      vetted.push(c);
      return c === undefined ? "not read" : undefined;
    };
    const seen: unknown[] = [];
    const ok = vettedBeforeStateRunner(fake(OK, { k: "v" }), (_a, c) => seen.push(c), vet);
    expect(await ok.read(ACTION, OPS)).toBe(OK);
    const unread = vettedBeforeStateRunner(fake(undefined), () => {}, vet);
    expect(await unread.read(ACTION, OPS)).toEqual({ status: "refused", reason: "not read" });
    expect(vetted).toEqual([{ k: "v" }, undefined]);
    expect(seen).toEqual([{ k: "v" }]);
  });

  test("a guard's refusal passes through unvetted; a vet that throws fails closed", async () => {
    const refused: BeforeStateOutcome = { status: "refused", reason: "guard" };
    let calls = 0;
    const counting = () => {
      calls += 1;
      return undefined;
    };
    expect(await vettedBeforeStateRunner(fake(refused), () => {}, counting).read(ACTION, OPS)).toBe(
      refused,
    );
    expect(calls).toBe(0);
    const throwing = () => {
      throw new Error("boom");
    };
    expect(await vettedBeforeStateRunner(fake(OK), () => {}, throwing).read(ACTION, OPS)).toEqual({
      status: "refused",
      reason: VET_FAILED_REASON,
    });
  });
});

describe("undoFreshRefusal", () => {
  const INPUT = { projectId: "web", featureName: "f", environment: "production", enabled: true };
  test("only a conditionally reversible row is judged again", () => {
    expect(undoNeedsFreshRead("unleash_feature_toggle")).toBe(true);
    expect(undoNeedsFreshRead("split_kill")).toBe(false);
    expect(undoFreshRefusal("split_kill", {}, undefined)).toBeUndefined();
  });
  test("the Unleash undo: refused unread or with no active strategy now; runs with one, or as a no-op", () => {
    expect(undoFreshRefusal("unleash_feature_toggle", INPUT, undefined)).toContain(
      "could not be read again",
    );
    expect(
      undoFreshRefusal("unleash_feature_toggle", INPUT, { enabled: "false", activeStrategy: "no" }),
    ).toContain("a fresh read of the target does not show that");
    expect(
      undoFreshRefusal("unleash_feature_toggle", INPUT, {
        enabled: "false",
        activeStrategy: "yes",
      }),
    ).toBeUndefined();
    expect(
      undoFreshRefusal("unleash_feature_toggle", INPUT, { enabled: "true", activeStrategy: "no" }),
    ).toBeUndefined();
  });
});
