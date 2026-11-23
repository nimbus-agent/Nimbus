import { describe, expect, test } from "bun:test";
import type { CuSession } from "../cu-session.ts";
import type { BrowserLane, CuActionClass, CuOutcome } from "../cu-types.ts";
import { hitlStatusForOutcome, terminationForRefusedVerdict } from "./action-audit.ts";
import { buildBrowserActionInput } from "./browser-input.ts";
import type { CuActionKind } from "./kinds.ts";

const sessionWith = (reason: string | undefined): CuSession => ({ reason }) as unknown as CuSession;

describe("hitlStatusForOutcome", () => {
  test("a null classification on an actuated outcome never claims an approval", () => {
    expect(hitlStatusForOutcome("actuated", null)).toBe("rejected");
    expect(hitlStatusForOutcome("failed_after_approval", "actuating")).toBe("approved");
    expect(hitlStatusForOutcome("actuated", "observing")).toBe("not_required");
  });

  test("an unrecognised classification or outcome throws instead of guessing", () => {
    expect(() => hitlStatusForOutcome("actuated", "bogus" as unknown as CuActionClass)).toThrow(
      "unrecognised CuActionClass",
    );
    expect(() => hitlStatusForOutcome("bogus" as unknown as CuOutcome, null)).toThrow(
      "unrecognised CuOutcome",
    );
  });
});

describe("terminationForRefusedVerdict", () => {
  test("budget and wall-clock map to their own outcomes", () => {
    expect(terminationForRefusedVerdict("budget", sessionWith(undefined))).toEqual({
      outcome: "terminated_budget",
      terminationReason: "budget",
    });
    expect(terminationForRefusedVerdict("wall_clock", sessionWith(undefined))).toEqual({
      outcome: "terminated_wall_clock",
      terminationReason: "wall_clock",
    });
  });

  test("an already-closed session records its real reason, never a guess", () => {
    expect(terminationForRefusedVerdict("closed", sessionWith("terminated_policy"))).toEqual({
      outcome: "terminated_policy",
      terminationReason: "terminated_policy",
    });
    expect(terminationForRefusedVerdict("closed", sessionWith("owner"))).toEqual({
      outcome: "terminated_budget",
      terminationReason: "owner",
    });
    expect(terminationForRefusedVerdict("closed", sessionWith(undefined))).toEqual({
      outcome: "terminated_budget",
      terminationReason: null,
    });
  });
});

describe("buildBrowserActionInput", () => {
  const lane = { currentOrigin: () => "https://a.example" } as unknown as BrowserLane;

  test("a terminal kind on a browser lane is a lane mismatch, not an unknown kind", async () => {
    await expect(
      buildBrowserActionInput(lane, { sessionId: "s", kind: "terminal_write" }),
    ).rejects.toThrow("ERR_CU_LANE_KIND_MISMATCH");
  });

  test("an unrecognised kind throws", async () => {
    await expect(
      buildBrowserActionInput(lane, { sessionId: "s", kind: "bogus" as unknown as CuActionKind }),
    ).rejects.toThrow("unrecognised action kind");
  });

  test("download reads like read: no node, no target origin", async () => {
    expect(await buildBrowserActionInput(lane, { sessionId: "s", kind: "download" })).toEqual({
      kind: "download",
      node: null,
      currentOrigin: "https://a.example",
      targetOrigin: null,
    });
  });
});
