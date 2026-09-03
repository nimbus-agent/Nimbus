import { describe, expect, test } from "bun:test";
import { IntentRouter } from "./intent-router.ts";
import type { ChatMessage } from "./types.ts";

function baseDeps() {
  const audits: { reason: string }[] = [];
  const replies: { text: string }[] = [];
  const gated: { actionType: string }[] = [];
  const agentCalls: { agent: string; params: unknown }[] = [];
  return {
    audits,
    replies,
    gated,
    agentCalls,
    deps: {
      knownActions: new Set(["deployment.rollback"]),
      permittedAgents: new Set(["why"]),
      resolveBinding: (_ch: string) => ({
        namespace: "project:pay",
        unmapped: "refuse" as const,
        notify: [],
      }),
      resolveIdentity: async (_p: "slack" | "teams", _u: string) => ({
        kind: "mapped" as const,
        identity: { externalId: "ext-bob", email: "bob@acme.com", issuer: "https://idp" },
      }),
      resolveOwner: (_resource: string) => ({ kind: "owner" as const, email: "alice@acme.com" }),
      ownerExternalIdFor: (_email: string) => "ext-alice",
      askEngine: async (_query: string, _ns: string) => "answer: pagerduty oncall = alice",
      runGatedWrite: async (actionType: string) => {
        gated.push({ actionType });
        return { approved: true };
      },
      runAgent: async (agent: string, params: unknown) => {
        agentCalls.push({ agent, params });
        return { ok: true as const, markdown: "## Gaps\nnone" };
      },
      reply: async (text: string) => {
        replies.push({ text });
      },
      auditRefusal: (reason: string) => {
        audits.push({ reason });
      },
    },
  };
}

const msg = (text: string): ChatMessage => ({
  platform: "slack",
  channelId: "C0",
  userId: "U_BOB",
  text,
  ts: "1.1",
  addressedToBot: true,
});

describe("IntentRouter", () => {
  test("unbound channel → ignored (no reply, no audit)", async () => {
    const { deps, replies } = baseDeps();
    const r = new IntentRouter({ ...deps, resolveBinding: () => undefined });
    await r.handle(msg("@nimbus hi"));
    expect(replies).toEqual([]);
  });

  test("read → engine answer replied", async () => {
    const { deps, replies } = baseDeps();
    await new IntentRouter(deps).handle(msg("@nimbus who's on call?"));
    expect(replies[0]?.text).toContain("oncall = alice");
  });

  test("write → owner-gated, executed on approval", async () => {
    const { deps, gated } = baseDeps();
    await new IntentRouter(deps).handle(
      msg("@nimbus run deployment.rollback service=payment-service version=v1.4"),
    );
    expect(gated).toEqual([{ actionType: "deployment.rollback" }]);
  });

  test("unmapped user in refuse channel → refusal audited + replied", async () => {
    const { deps, audits, replies } = baseDeps();
    const r = new IntentRouter({ ...deps, resolveIdentity: async () => ({ kind: "unmapped" }) });
    await r.handle(msg("@nimbus who's on call?"));
    expect(audits.map((a) => a.reason)).toContain("unmapped_user");
    expect(replies).toHaveLength(1);
  });

  test("write with no resolvable owner → refusal audited (no_owner)", async () => {
    const { deps, audits } = baseDeps();
    const r = new IntentRouter({ ...deps, resolveOwner: () => ({ kind: "none" }) });
    await r.handle(msg("@nimbus run deployment.rollback service=payment-service version=v1.4"));
    expect(audits.map((a) => a.reason)).toContain("no_owner");
  });

  test("write with ambiguous ownership → refusal audited (ambiguous_owner)", async () => {
    const { deps, audits } = baseDeps();
    const r = new IntentRouter({ ...deps, resolveOwner: () => ({ kind: "ambiguous" }) });
    await r.handle(msg("@nimbus run deployment.rollback service=payment-service version=v1.4"));
    expect(audits.map((a) => a.reason)).toContain("ambiguous_owner");
  });

  test("write whose owner has no Nimbus identity → refusal audited (no_owner)", async () => {
    const { deps, audits, gated } = baseDeps();
    const r = new IntentRouter({ ...deps, ownerExternalIdFor: () => undefined });
    await r.handle(msg("@nimbus run deployment.rollback service=payment-service version=v1.4"));
    expect(audits.map((a) => a.reason)).toContain("no_owner");
    expect(gated).toEqual([]);
  });

  test("refused parse (unknown action) for a mapped user → refusal audited", async () => {
    const { deps, audits } = baseDeps();
    await new IntentRouter(deps).handle(msg("@nimbus run deployment.nuke service=x"));
    expect(audits.map((a) => a.reason)).toContain("unknown_action");
  });

  test("unmapped user issuing a read in a public-read channel → answered (no refusal)", async () => {
    const { deps, replies, audits } = baseDeps();
    const r = new IntentRouter({
      ...deps,
      resolveBinding: () => ({ namespace: "project:pay", unmapped: "public-read", notify: [] }),
      resolveIdentity: async () => ({ kind: "unmapped" }),
    });
    await r.handle(msg("@nimbus who's on call?"));
    expect(replies[0]?.text).toContain("oncall = alice");
    expect(audits).toEqual([]);
  });

  test("an unmapped user is refused AND no agent runs, even under public-read", async () => {
    const { deps, replies, agentCalls } = baseDeps();
    const r = new IntentRouter({
      ...deps,
      resolveBinding: () => ({ namespace: "project:pay", unmapped: "public-read", notify: [] }),
      resolveIdentity: async () => ({ kind: "unmapped" }),
    });
    await r.handle(msg("@nimbus agent why ref=a.ts"));
    // Asserting the refusal alone would pass against an implementation that refused AFTER running.
    expect(agentCalls).toHaveLength(0);
    expect(replies).toContainEqual({ text: "You are not enrolled for this channel." });
  });

  test("a mapped user gets the agent brief posted", async () => {
    const { deps, replies, agentCalls } = baseDeps();
    await new IntentRouter(deps).handle(msg("@nimbus agent why ref=a.ts"));
    expect(agentCalls).toEqual([{ agent: "why", params: { ref: "a.ts" } }]);
    expect(replies[0]?.text).toContain("## Gaps");
  });

  test("a mapped user's bad agent params are refused, and the refusal is driven by runAgent's ok:false — not a success path misread as one", async () => {
    const { deps, replies, audits } = baseDeps();
    // FIX 5 (whole-branch review): the original stub here did not record into `agentCalls`, so
    // `expect(agentCalls).toEqual([])` passed regardless of whether `runAgent` was even called —
    // `IntentRouter.handle` in fact ALWAYS calls `deps.runAgent` for an `agent` command (params
    // validation happens one layer down, inside the real `dispatchAgentsRpc`/`agentInvoker`, which
    // this stub stands in for), so a "the agent never ran" claim at THIS layer was never true and
    // never checkable by that assertion. This stub records its own call instead, so the test
    // asserts something that can actually fail: `runAgent` was called exactly once with the
    // parsed args, and its `ok: false` result — not a thrown error, not a silently-ignored one —
    // is what drives the refusal reply and audit below.
    const calls: { agent: string; params: unknown }[] = [];
    const r = new IntentRouter({
      ...deps,
      runAgent: async (agent, params) => {
        calls.push({ agent, params });
        return { ok: false as const, detail: "bad params" };
      },
    });
    await r.handle(msg("@nimbus agent why ref=a.ts"));
    expect(calls).toEqual([{ agent: "why", params: { ref: "a.ts" } }]);
    expect(audits.map((a) => a.reason)).toContain("bad_agent_params");
    expect(replies[0]?.text).toBe("bad params");
  });

  test("an unbound channel stays silent for an agent command too", async () => {
    const { deps, replies, agentCalls } = baseDeps();
    const r = new IntentRouter({ ...deps, resolveBinding: () => undefined });
    await r.handle(msg("@nimbus agent why ref=a.ts"));
    expect(replies).toEqual([]);
    expect(agentCalls).toEqual([]);
  });
});
