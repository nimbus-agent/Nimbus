import { describe, expect, test } from "bun:test";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import type { AgentProposer } from "../engine/types.ts";

const AGENT_PROPOSER: AgentProposer = {
  door: "agent",
  captureId: "cap_1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
  label: null,
  labelSource: "declared",
  summary: "s",
  createdAt: 0,
  expiresAt: 1,
};

describe("I20 — a delegated approval is honored only from a live, identity-valid delegate", () => {
  test("I20 (Wave 4, D0a): a delegate's approval of a type-to-confirm write counts only with typed text equal to the confirm text; a path that cannot carry text falls back to the local owner", async () => {
    const { NO_POLICY_OVERLAY, ToolExecutor } = await import("../engine/executor.ts");
    const MERGE = {
      type: "github.pr.merge",
      payload: { mcpToolId: "github_pr_merge", input: { owner: "a", repo: "b", pullNumber: 7 } },
    };
    const TEXT = "github/merge a/b#7";
    const run = async (
      remoteConfirmed:
        | undefined
        | (() => Promise<
            | { kind: "answered"; peerId: string; approved: boolean; typed?: string }
            | { kind: "timeout" }
          >),
    ) => {
      let ownerTyped = 0;
      let plainRemote = 0;
      const dispatched: string[] = [];
      const exec = new ToolExecutor(
        {
          requestApproval: async () => ({ approved: true, answerSource: "human" as const }),
          requestConfirmedApproval: async (req) => {
            ownerTyped += 1;
            return { approved: true, typed: req.confirmText, answerSource: "human" as const };
          },
        },
        { recordAudit: () => {} },
        {
          dispatch: async (a) => {
            dispatched.push(a.type);
            return {};
          },
        },
        {
          store: {
            activeDelegateFor: (_k, _v, peer) => peer === "peer-1",
            activeDelegateePeer: () => "peer-1",
          },
          isOperatorValid: () => true,
          requestRemote: async () => {
            plainRemote += 1;
            return { kind: "answered", peerId: "peer-1", approved: true };
          },
          ...(remoteConfirmed === undefined ? {} : { requestRemoteConfirmed: remoteConfirmed }),
        },
        NULL_EGRESS_SINK,
        NO_POLICY_OVERLAY,
      );
      const res = await exec.execute(MERGE);
      return { res, ownerTyped, plainRemote, dispatched };
    };
    // No way to carry text: the plain delegate is NEVER asked and the owner types it.
    const none = await run(undefined);
    expect(none.plainRemote).toBe(0);
    expect(none.ownerTyped).toBe(1);
    // A delegate that approves without the exact text is declined.
    const wrong = await run(async () => ({
      kind: "answered",
      peerId: "peer-1",
      approved: true,
      typed: "github/merge a/b#8",
    }));
    expect(wrong.res.status).toBe("rejected");
    expect(wrong.dispatched).toEqual([]);
    expect(wrong.ownerTyped).toBe(0);
    const bare = await run(async () => ({ kind: "answered", peerId: "peer-1", approved: true }));
    expect(bare.res.status).toBe("rejected");
    // The exact text approves, through the unchanged scope and identity checks.
    const right = await run(async () => ({
      kind: "answered",
      peerId: "peer-1",
      approved: true,
      typed: TEXT,
    }));
    expect(right.res.status).toBe("ok");
    expect(right.ownerTyped).toBe(0);
    // A non-delegate peer is not honored even with the exact text: the owner types it.
    const forged = await run(async () => ({
      kind: "answered",
      peerId: "peer-eve",
      approved: true,
      typed: TEXT,
    }));
    expect(forged.ownerTyped).toBe(1);
    expect(forged.dispatched).toEqual(["github.pr.merge"]);
  });

  test("forged peer / invalid identity / timeout all fall back to the local owner", async () => {
    const { resolveDelegatedApproval } = await import("../engine/delegated-approval.ts");
    const base = { isActiveDelegate: (p: string) => p === "peer:bob", isOperatorValid: () => true };
    const forged = await resolveDelegatedApproval({
      ...base,
      requestRemote: async () => ({ kind: "answered", peerId: "peer:eve", approved: true }),
    });
    const badId = await resolveDelegatedApproval({
      ...base,
      isOperatorValid: () => false,
      requestRemote: async () => ({ kind: "answered", peerId: "peer:bob", approved: true }),
    });
    expect(forged).toBe("fallback_to_owner");
    expect(badId).toBe("fallback_to_owner");
  });

  test("I20: a delegate never approves registry.add, extension.*, pack.install or connector.writes.enable: the delegate is not consulted and the owner is prompted", async () => {
    const { NO_POLICY_OVERLAY, ToolExecutor } = await import("../engine/executor.ts");
    for (const type of [
      "registry.add",
      "extension.install",
      "extension.run",
      "extension.autoUpdate",
      "extension.migrate",
      "extension.eval",
      "pack.install",
      "connector.writes.enable",
      // Phase 28 AD3a-1: the same type with the agent door's payload is never delegated either (I3).
      "connector.writes.enable#agent",
    ]) {
      let prompts = 0;
      let remote = 0;
      const exec = new ToolExecutor(
        {
          requestApproval: async () => {
            prompts += 1;
            return { approved: false, answerSource: "human" as const };
          },
        },
        { recordAudit: () => {} },
        { dispatch: async () => ({}) },
        {
          store: {
            activeDelegateFor: () => true,
            activeDelegateePeer: () => "peer-1",
          },
          isOperatorValid: () => true,
          requestRemote: async () => {
            remote += 1;
            return { kind: "answered", peerId: "peer-1", approved: true };
          },
        },
        NULL_EGRESS_SINK,
        NO_POLICY_OVERLAY,
      );
      const [realType = type] = type.split("#");
      const payload = type.endsWith("#agent")
        ? { door: "agent", service: "github", maxWave: 3, writes: [] }
        : {};
      const res = await exec.execute({ type: realType, payload });
      expect(res.status, type).toBe("rejected");
      expect(remote, type).toBe(0);
      expect(prompts, type).toBe(1);
    }
  });
  test('I20: an origin "model" or "agent" action is never delegated; a payload.origin has no effect', async () => {
    const { NO_POLICY_OVERLAY, ToolExecutor } = await import("../engine/executor.ts");
    const run = async (action: {
      type: string;
      payload: Record<string, unknown>;
      origin?: "model" | "agent";
      proposer?: AgentProposer;
    }) => {
      let prompts = 0;
      let remote = 0;
      const exec = new ToolExecutor(
        {
          requestApproval: async () => {
            prompts += 1;
            return { approved: true, answerSource: "human" as const };
          },
        },
        { recordAudit: () => {} },
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
      await exec.execute(action);
      return { prompts, remote };
    };
    expect(await run({ type: "email.send", payload: {}, origin: "model" })).toEqual({
      prompts: 1,
      remote: 0,
    });
    // Phase 28 AD1: the agent origin falls back exactly like the model's.
    expect(
      await run({ type: "email.send", payload: {}, origin: "agent", proposer: AGENT_PROPOSER }),
    ).toEqual({
      prompts: 1,
      remote: 0,
    });
    expect(await run({ type: "email.send", payload: { origin: "model" } })).toEqual({
      prompts: 0,
      remote: 1,
    });
  });
});
