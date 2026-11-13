import { describe, expect, test } from "bun:test";
import {
  buildConnectorWritePreview,
  type ConnectorWritePreview,
} from "../connectors/connector-writes/preview.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import {
  consentDisplayPayload,
  formatConsentPrompt,
  NO_POLICY_OVERLAY,
  ToolExecutor,
} from "./executor.ts";
import type { AgentProposer, PlannedAction } from "./types.ts";

const LINE = "Requested by: the model";
const PROPOSER: AgentProposer = {
  door: "agent",
  captureId: "cap_abc123",
  label: "client",
  labelSource: "declared",
  summary: "a summary",
  createdAt: 1_700_000_000_000,
  expiresAt: 1_700_086_400_000,
};

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

describe("formatConsentPrompt — a GitHub write on a GitHub Enterprise Server", () => {
  const write: PlannedAction = {
    type: "github.issue.comment.create",
    origin: "model",
    payload: {
      mcpToolId: "github_issue_comment_create",
      input: { owner: "acme", repo: "web", issueNumber: 7, body: "hello" },
    },
  };
  const ghes = () => ({ credential: "personal" as const, instance: "ghe.example.com" });

  test("the model door's prompt shows Instance after Credential, and Requested by: the model", () => {
    const lines = formatConsentPrompt(write, ghes).split("\n");
    const at = lines.indexOf("Credential: personal");
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe("Instance: ghe.example.com");
    expect(lines).toContain(LINE);
  });

  test("without the instance the prompt is the one it always was (no Instance line)", () => {
    expect(formatConsentPrompt(write, () => "personal")).not.toContain("Instance:");
    expect(formatConsentPrompt(write)).not.toContain("Instance:");
  });

  test("the desktop's details carry the instance in the typed destination", () => {
    const d = consentDisplayPayload(write, ghes);
    expect(d?.["destination"]).toEqual({
      service: "github",
      credential: "personal",
      instance: "ghe.example.com",
    });
  });
});

describe("executor — origin model", () => {
  function make(origin: boolean | "agent") {
    let remote = 0;
    let prompts = 0;
    const audits: string[] = [];
    const exec = new ToolExecutor(
      {
        requestApproval: async () => {
          prompts += 1;
          return { approved: true, answerSource: "human" as const };
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
    const action: PlannedAction =
      origin === "agent"
        ? { type: "email.send", payload: {}, origin: "agent", proposer: PROPOSER }
        : origin
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
  test("I20: an agent-origin action never reaches the delegate either; the local owner is prompted", async () => {
    const h = make("agent");
    expect((await h.exec.execute(h.action)).status).toBe("ok");
    expect(h.counts()).toEqual({ remote: 0, prompts: 1 });
    expect(h.audits[0]).toContain('"origin":"agent"');
  });
  test("a forged payload.origin changes nothing: the delegate still answers", async () => {
    const h = make(false);
    await h.exec.execute(h.action);
    expect(h.counts()).toEqual({ remote: 1, prompts: 0 });
  });
});

describe("consentDisplayPayload — origin model (the desktop's details)", () => {
  test("a typed preview carries requestedBy: model and stays a preview", () => {
    const d = consentDisplayPayload({
      type: "argocd.app.sync",
      payload: { name: "web" },
      origin: "model",
    });
    expect(d?.["kind"]).toBe("connector-write");
    expect(d?.["target"]).toBe("web");
    expect(d?.["requestedBy"]).toBe("model");
  });
  test("no origin: the typed preview has no requestedBy", () => {
    const d = consentDisplayPayload({ type: "argocd.app.sync", payload: { name: "web" } });
    expect(d?.["kind"]).toBe("connector-write");
    expect(d !== undefined && Object.hasOwn(d, "requestedBy")).toBe(false);
  });
  test("generic details gain requestedBy: model; a payload's own value never wins", () => {
    const d = consentDisplayPayload({
      type: "jira.issue.create",
      payload: { a: 1, requestedBy: "owner" },
      origin: "model",
    });
    expect(d).toEqual({ a: 1, requestedBy: "model" });
  });
  test("a payload posing as a preview is still wrapped when the model asked", () => {
    const d = consentDisplayPayload({
      type: "jira.issue.create",
      payload: { kind: "connector-write", actionType: "jira.issue.create" },
      origin: "model",
    });
    expect(d?.["kind"]).toBeUndefined();
    expect(d?.["requestedBy"]).toBe("model");
    expect(d?.["payload"]).toEqual({ kind: "connector-write", actionType: "jira.issue.create" });
  });
  test("a payload-less model action still says who asked", () => {
    expect(consentDisplayPayload({ type: "jira.issue.create", origin: "model" })).toEqual({
      requestedBy: "model",
    });
  });
  test("payload.origin is not an origin: no requestedBy is added", () => {
    expect(
      consentDisplayPayload({ type: "jira.issue.create", payload: { origin: "model" } }),
    ).toEqual({ origin: "model" });
  });
  test("the CLI's Details line stays the payload (the Requested by line says it once)", () => {
    const p = formatConsentPrompt({
      type: "jira.issue.create",
      payload: { a: 1 },
      origin: "model",
    });
    expect(p).toContain('Details: {"a":1}');
  });
});

describe("one typed preview per gate", () => {
  test("an already-built preview is used by both display functions", () => {
    const action: PlannedAction = { type: "argocd.app.sync", payload: { name: "web" } };
    const built = buildConnectorWritePreview(action);
    if (built === undefined) throw new Error("argocd.app.sync must have a preview");
    const preview: ConnectorWritePreview = { ...built, target: "PREBUILT" };
    expect(formatConsentPrompt(action, undefined, preview)).toContain("Target:  PREBUILT");
    expect(consentDisplayPayload(action, undefined, preview)?.["target"]).toBe("PREBUILT");
  });
  test("the gate builds the preview once: the credential resolver is read once", async () => {
    let reads = 0;
    let shown: { prompt: string; details: Record<string, unknown> | undefined } | undefined;
    const exec = new ToolExecutor(
      {
        requestApproval: async (prompt, details) => {
          shown = { prompt, details };
          return { approved: false, answerSource: "human" as const };
        },
      },
      { recordAudit: () => undefined },
      { dispatch: async () => ({}) },
      undefined,
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
      () => {
        reads += 1;
        return "personal";
      },
    );
    const r = await exec.execute({
      type: "looker.datagroup.trigger",
      payload: { datagroupId: "dg1" },
      origin: "model",
    });
    expect(r.status).toBe("rejected");
    expect(reads).toBe(1);
    expect(shown?.prompt).toContain("Credential: personal");
    expect(shown?.prompt).toContain(LINE);
    expect(shown?.details?.["destination"]).toEqual({ service: "looker", credential: "personal" });
    expect(shown?.details?.["requestedBy"]).toBe("model");
  });
});
