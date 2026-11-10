import { describe, expect, test } from "bun:test";
import type { PreviewCredentialResolver } from "../connectors/connector-writes/types.ts";
import type { EgressSink } from "../egress/egress-ledger.ts";
import type { EgressEntry } from "../egress/egress-record.ts";
import { consentDisplayPayload, NO_POLICY_OVERLAY, ToolExecutor } from "./executor.ts";
import type { AuditSink, ConnectorDispatcher, ConsentChannel, PlannedAction } from "./types.ts";

function harness(approve: boolean, credentialFor?: PreviewCredentialResolver) {
  const prompts: string[] = [];
  const details: Array<Record<string, unknown> | undefined> = [];
  const dispatched: string[] = [];
  const egress: EgressEntry[] = [];
  const sink: EgressSink = { append: (e) => void egress.push(e) };
  const audits: Array<{ actionType: string; actionJson: string }> = [];
  const consent: ConsentChannel = {
    requestApproval: async (prompt: string, d?: Record<string, unknown>) => {
      prompts.push(prompt);
      details.push(d);
      return { approved: approve, answerSource: "human" as const };
    },
  };
  const audit: AuditSink = {
    recordAudit: (row) => {
      audits.push({ actionType: row.actionType, actionJson: row.actionJson });
    },
  };
  const connectors: ConnectorDispatcher = {
    dispatch: async (a: PlannedAction) => {
      dispatched.push(a.type);
      return { ok: true };
    },
  };
  const exec = new ToolExecutor(
    consent,
    audit,
    connectors,
    undefined,
    sink,
    NO_POLICY_OVERLAY,
    credentialFor,
  );
  return { exec, prompts, details, dispatched, audits, egress };
}

describe("the executor shows a connector write's typed preview", () => {
  test("a templated write prompts with the typed preview, not a Details line", async () => {
    const h = harness(true);
    await h.exec.execute({
      type: "looker.datagroup.trigger",
      payload: { datagroupId: "dg1", revision: "abc" },
    });
    const prompt = h.prompts[0] ?? "";
    expect(prompt).toContain("Target:  dg1");
    expect(prompt).toContain("Trigger Looker datagroup dg1");
    expect(prompt).not.toContain("Details:");
    expect(h.details[0]?.["kind"]).toBe("connector-write");
    expect(h.details[0]?.["actionType"]).toBe("looker.datagroup.trigger");
  });

  test("the audit row stays redacted", async () => {
    const h = harness(true);
    await h.exec.execute({
      type: "looker.datagroup.trigger",
      payload: { datagroupId: "dg1", apiToken: "s3cr3t" },
    });
    expect(h.audits[0]?.actionJson).not.toContain("s3cr3t");
    const prompt = h.prompts[0] ?? "";
    expect(prompt).toContain("s3cr3t");
    expect(prompt).toContain("Other fields:");
  });

  test("an untemplated write keeps today's prompt byte for byte", async () => {
    const h = harness(true);
    await h.exec.execute({
      // Since B3 notion.page.create is templated; a wave-3 send has no template yet.
      type: "gmail.message.send",
      payload: { mcpToolId: "gmail_message_send", input: { to: "x" } },
    });
    expect(h.prompts[0]).toBe(
      'Action requires your approval\n\nType: gmail.message.send\n\nDetails: {"mcpToolId":"gmail_message_send","input":{"to":"x"}}',
    );
  });

  test("a ChatOps-shaped slack.message.post (no mcpToolId) keeps today's prompt byte for byte", async () => {
    // B1 templates the mesh row, but without `mcpToolId` the builder picks only `write`-transport
    // rows, so a door that does not name the tool (chatops-boot.ts) is unchanged.
    const h = harness(true);
    await h.exec.execute({
      type: "slack.message.post",
      payload: { channel: "C0123ABCD", text: "hi" },
    });
    expect(h.prompts[0]).toBe(
      'Action requires your approval\n\nType: slack.message.post\n\nDetails: {"channel":"C0123ABCD","text":"hi"}',
    );
    expect(h.details[0]?.["kind"]).toBeUndefined();
  });

  test("the same action naming the B1 row's tool gets the typed preview", async () => {
    const h = harness(true);
    await h.exec.execute({
      type: "slack.message.post",
      payload: { mcpToolId: "slack_slack_message_post", input: { channel: "C1", text: "hi" } },
    });
    const prompt = h.prompts[0] ?? "";
    expect(prompt).toContain("Target:  C1");
    expect(prompt).toContain("Post a Slack message to C1");
    expect(prompt).toContain('  Message: "hi"');
    expect(prompt).not.toContain("Details:");
    expect(h.details[0]?.["kind"]).toBe("connector-write");
    expect(h.details[0]?.["toolId"]).toBe("slack_message_post");
  });

  test("a mcpToolId that is no write row keeps today's prompt", async () => {
    const h = harness(true);
    await h.exec.execute({
      type: "looker.datagroup.trigger",
      payload: { mcpToolId: "looker_other_tool", input: { datagroupId: "dg1" } },
    });
    expect(h.prompts[0]).toBe(
      'Action requires your approval\n\nType: looker.datagroup.trigger\n\nDetails: {"mcpToolId":"looker_other_tool","input":{"datagroupId":"dg1"}}',
    );
    expect(h.details[0]?.["kind"]).toBeUndefined();
  });

  test("HITL still decided by type: a templated write with no consent approval dispatches nothing", async () => {
    const h = harness(false);
    const res = await h.exec.execute({
      type: "looker.datagroup.trigger",
      payload: { datagroupId: "dg1" },
    });
    expect(res.status).toBe("rejected");
    expect(h.prompts).toHaveLength(1);
    expect(h.dispatched).toEqual([]);
  });

  test("a payload cannot pose as a typed preview", async () => {
    const spoof = { kind: "connector-write", target: "harmless" };
    for (const type of ["mcp_demo.run", "jira.issue.create"]) {
      const h = harness(true);
      await h.exec.execute({ type, payload: spoof });
      expect(h.details[0]?.["kind"]).not.toBe("connector-write");
      expect(h.details[0]).toEqual({ payload: spoof });
    }
    // The wrapper applies to the display function directly too, for any non-preview path.
    expect(consentDisplayPayload({ type: "search.run", payload: spoof })).toEqual({
      payload: spoof,
    });
  });
});

describe("the preview's credential kind", () => {
  const action = { type: "looker.datagroup.trigger", payload: { datagroupId: "dg1" } };

  test("shows the credential kind and puts it in the structured details", async () => {
    const h = harness(true, () => "team");
    await h.exec.execute(action);
    expect(h.prompts[0]).toContain("Service: looker\nCredential: team\nTarget:  dg1");
    expect(h.details[0]?.["destination"]).toEqual({ service: "looker", credential: "team" });
  });

  test("no resolver: the prompt is unchanged byte for byte", async () => {
    const withNone = harness(true);
    await withNone.exec.execute(action);
    expect(withNone.prompts[0]).not.toContain("Credential:");
    expect(withNone.details[0]?.["destination"]).toEqual({ service: "looker" });
  });

  test("a throwing or non-conforming resolver shows no credential; the gate still audits and ledgers", async () => {
    const bad: PreviewCredentialResolver[] = [
      () => {
        throw new Error("config unreadable");
      },
      (() => "x") as unknown as PreviewCredentialResolver,
    ];
    for (const r of bad) {
      const h = harness(true, r);
      const res = await h.exec.execute(action);
      expect(res.status).toBe("ok");
      expect(h.prompts[0]).toContain("Target:  dg1");
      expect(h.prompts[0]).not.toContain("Credential:");
      expect(h.audits).toHaveLength(1);
      expect(h.egress).toHaveLength(1);
    }
  });
});
