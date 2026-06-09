import { describe, expect, test } from "bun:test";
import { IntentRouter } from "./intent-router.ts";
import type { ChatMessage } from "./types.ts";

function baseDeps() {
  const audits: { reason: string }[] = [];
  const replies: { text: string }[] = [];
  const gated: { actionType: string }[] = [];
  return {
    audits,
    replies,
    gated,
    deps: {
      knownActions: new Set(["deployment.rollback"]),
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
    expect(replies.length).toBe(1);
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
});
