import { describe, expect, test } from "bun:test";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import type { RemoteApprovalOutcome } from "./delegated-approval.ts";
import {
  consentDisplayPayload,
  formatConsentPrompt,
  HITL_REQUIRED,
  NO_POLICY_OVERLAY,
  ToolExecutor,
} from "./executor.ts";
import type { PlannedAction } from "./types.ts";

/**
 * `extension.eval` — the owner's one approval to evaluate installed extensions. A frozen-set member
 * (I2) no delegate approves (I20); its prompt names each extension, its version and its case count,
 * and states the fixed no-network / no-credentials fact.
 */

const EVAL_ACTION: PlannedAction = {
  type: "extension.eval",
  payload: {
    extensions: [
      { id: "com.example.a", version: "1.2.0", cases: 3 },
      { id: "com.example.b", version: "0.4.1", cases: 12 },
    ],
    fromRenderer: false,
    extra: "dropped",
  },
};

function harness(delegate: boolean): {
  prompts: string[];
  details: Array<Record<string, unknown> | undefined>;
  remote: () => number;
  exec: ToolExecutor;
} {
  const prompts: string[] = [];
  const details: Array<Record<string, unknown> | undefined> = [];
  let remote = 0;
  const exec = new ToolExecutor(
    {
      requestApproval: async (p: string, d?: Record<string, unknown>) => {
        prompts.push(p);
        details.push(d);
        return false;
      },
    },
    { recordAudit: () => {} },
    { dispatch: async () => ({}) },
    delegate
      ? {
          store: { activeDelegateFor: () => true, activeDelegateePeer: () => "peer:bob" },
          isOperatorValid: () => true,
          requestRemote: async (): Promise<RemoteApprovalOutcome> => {
            remote += 1;
            return { kind: "answered", peerId: "peer:bob", approved: true };
          },
        }
      : undefined,
    NULL_EGRESS_SINK,
    NO_POLICY_OVERLAY,
  );
  return { prompts, details, remote: () => remote, exec };
}

describe("extension.eval consent", () => {
  test("is HITL-required", () => {
    expect(HITL_REQUIRED.has("extension.eval")).toBe(true);
  });

  test("the display payload keeps extensions unredacted, adds network none and drops other fields", () => {
    expect(consentDisplayPayload(EVAL_ACTION)).toEqual({
      extensions: [
        { id: "com.example.a", version: "1.2.0", cases: 3 },
        { id: "com.example.b", version: "0.4.1", cases: 12 },
      ],
      network: "none",
    });
  });

  test("the prompt lists id@version (N cases) per extension and the fixed line, with no Details line", () => {
    expect(formatConsentPrompt(EVAL_ACTION)).toBe(
      [
        "Action requires your approval",
        "",
        "Type: extension.eval",
        "",
        "com.example.a@1.2.0 (3 cases)",
        "com.example.b@0.4.1 (12 cases)",
        "",
        "runs with no network and no credentials",
      ].join("\n"),
    );
  });

  test("a malformed extensions payload falls back to the generic format", () => {
    const text = formatConsentPrompt({ type: "extension.eval", payload: { extensions: "x" } });
    expect(text).toContain("Details:");
  });

  test("a delegate is never consulted: the owner is prompted once", async () => {
    const h = harness(true);
    const res = await h.exec.execute(EVAL_ACTION);
    expect(res.status).toBe("rejected");
    expect(h.remote()).toBe(0);
    expect(h.prompts).toHaveLength(1);
    expect(JSON.stringify(h.details[0])).toContain("com.example.a");
  });
});
