import { describe, expect, test } from "bun:test";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { consentDisplayPayload, NO_POLICY_OVERLAY, ToolExecutor } from "./executor.ts";
import type { PlannedAction } from "./types.ts";

/**
 * `extension.install` with a dependency plan: the rendered plan (`planText`) is the prompt body,
 * printed after the Details line and never inside it, and it never reaches the audit row.
 */

const PLAN_TEXT = [
  "This install adds 2 packages:",
  "  com.example.dep@1.2.0 (com.example.tool needs ^1.0.0) — registry main",
  "All packages together: network: none · read: none · write: none",
].join("\n");

const BASE_PAYLOAD = { id: "com.example.tool", version: "1.0.0", sourceRegistry: "main" };

function capture(): {
  prompts: string[];
  details: Array<Record<string, unknown> | undefined>;
  auditJson: string[];
  exec: ToolExecutor;
} {
  const prompts: string[] = [];
  const details: Array<Record<string, unknown> | undefined> = [];
  const auditJson: string[] = [];
  const exec = new ToolExecutor(
    {
      requestApproval: async (prompt: string, d?: Record<string, unknown>) => {
        prompts.push(prompt);
        details.push(d);
        return false;
      },
    },
    { recordAudit: (row: { actionJson: string }) => auditJson.push(row.actionJson) },
    { dispatch: async () => ({}) },
    undefined,
    NULL_EGRESS_SINK,
    NO_POLICY_OVERLAY,
  );
  return { prompts, details, auditJson, exec };
}

describe("extension.install consent with a plan", () => {
  test("planText is printed after Details and not inside it", async () => {
    const h = capture();
    const action: PlannedAction = {
      type: "extension.install",
      payload: { ...BASE_PAYLOAD, planText: PLAN_TEXT },
    };
    await h.exec.execute(action);
    expect(h.prompts[0]).toBe(
      `Action requires your approval\n\nType: extension.install\n\nDetails: ${JSON.stringify(BASE_PAYLOAD)}\n\n${PLAN_TEXT}`,
    );
    expect(JSON.stringify(h.details[0])).not.toContain("planText");
    expect(consentDisplayPayload(action)).toEqual(BASE_PAYLOAD);
    expect(h.auditJson).toHaveLength(1);
    expect(h.auditJson[0]).not.toContain("planText");
    expect(h.auditJson[0]).not.toContain("This install adds");
    expect(h.auditJson[0]).toContain("com.example.tool");
  });

  test("a request without planText prints exactly as before", async () => {
    const h = capture();
    await h.exec.execute({ type: "extension.install", payload: BASE_PAYLOAD });
    expect(h.prompts[0]).toBe(
      `Action requires your approval\n\nType: extension.install\n\nDetails: ${JSON.stringify(BASE_PAYLOAD)}`,
    );
  });

  test("a non-string planText stays in the Details line", async () => {
    const h = capture();
    await h.exec.execute({ type: "extension.install", payload: { ...BASE_PAYLOAD, planText: 5 } });
    expect(h.prompts[0]).toContain('"planText":5');
  });
});
