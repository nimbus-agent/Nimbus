import { describe, expect, test } from "bun:test";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { formatConsentPrompt, NO_POLICY_OVERLAY, ToolExecutor } from "./executor.ts";
import type { PlannedAction } from "./types.ts";

const LINE = "Requested by: the model";

describe("formatConsentPrompt — origin model", () => {
  test("a generic Details prompt carries the line after Type", () => {
    const p = formatConsentPrompt({
      type: "jira.issue.create",
      payload: { a: 1 },
      origin: "model",
    });
    expect(p).toContain(`Type: jira.issue.create\n${LINE}`);
    expect(p).toContain("Details:");
  });
  test("a typed preview prompt carries the line", () => {
    const p = formatConsentPrompt({
      type: "argocd.app.sync",
      payload: { name: "web" },
      origin: "model",
    });
    expect(p).toContain(LINE);
    expect(p).toContain("Target:  web");
  });
  test("pack.install and extension.eval special prompts carry the line", () => {
    const pack = formatConsentPrompt({
      type: "pack.install",
      payload: { promptText: "Install pack X" },
      origin: "model",
    });
    expect(pack).toContain(LINE);
    const ev = formatConsentPrompt({
      type: "extension.eval",
      payload: { extensions: [{ id: "a", version: "1.0.0", cases: 2 }] },
      origin: "model",
    });
    expect(ev).toContain(LINE);
  });
  test("no origin: no line; payload.origin is not an origin", () => {
    expect(formatConsentPrompt({ type: "jira.issue.create", payload: {} })).not.toContain(LINE);
    expect(
      formatConsentPrompt({ type: "jira.issue.create", payload: { origin: "model" } }),
    ).not.toContain(LINE);
  });
});

describe("executor — origin model", () => {
  function make(origin: boolean) {
    let remote = 0;
    let prompts = 0;
    const audits: string[] = [];
    const exec = new ToolExecutor(
      {
        requestApproval: async () => {
          prompts += 1;
          return true;
        },
      },
      { recordAudit: (r) => audits.push(r.actionJson) },
      { dispatch: async () => ({}) },
      {
        store: { activeDelegateFor: () => true, activeDelegateePeer: () => "peer-1" },
        isOperatorValid: () => true,
        requestRemote: async () => {
          remote += 1;
          return { kind: "answered", peerId: "peer-1", approved: true };
        },
      },
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
    );
    const action: PlannedAction = origin
      ? { type: "email.send", payload: {}, origin: "model" }
      : { type: "email.send", payload: { origin: "model" } };
    return { exec, action, counts: () => ({ remote, prompts }), audits };
  }
  test("an in-scope delegate is not consulted: the local owner is prompted", async () => {
    const h = make(true);
    expect((await h.exec.execute(h.action)).status).toBe("ok");
    expect(h.counts()).toEqual({ remote: 0, prompts: 1 });
    expect(h.audits[0]).toContain('"origin":"model"');
  });
  test("a forged payload.origin changes nothing: the delegate still answers", async () => {
    const h = make(false);
    await h.exec.execute(h.action);
    expect(h.counts()).toEqual({ remote: 1, prompts: 0 });
  });
});
