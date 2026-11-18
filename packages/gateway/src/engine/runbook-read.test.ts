import { describe, expect, test } from "bun:test";

import { isRunbookReadActionType, runbookReadActionType } from "./runbook-read.ts";

describe("the runbook read action type (IC6)", () => {
  test("is <service>.runbook.read and is recognised only with a service in front", () => {
    expect(runbookReadActionType("argocd")).toBe("argocd.runbook.read");
    expect(isRunbookReadActionType("argocd.runbook.read")).toBe(true);
    expect(isRunbookReadActionType(".runbook.read")).toBe(false);
    expect(isRunbookReadActionType("argocd.before.read")).toBe(false);
    expect(isRunbookReadActionType("argocd.runbook.read.x")).toBe(false);
  });
});
