/**
 * In-process integration test for the ChatOps slice: wires the REAL components together (signed-
 * policy resolvers → identity mapper → command parser → intent router → owner-routed approval via
 * the real I20 `resolveDelegatedApproval` → reply dispatcher) behind mock transports, and drives
 * messages through the ChatopsService lifecycle. This proves Tasks 2–10 compose correctly.
 *
 * Scope note: this stops short of a Gateway subprocess. Populating `chatopsRpcCtx` +
 * `resolveTeamsEventsSurface` in `platform/assemble.ts` (so a running gateway reaches this graph,
 * incl. executor-gate + lazy-mesh connector invocation + team-vault bot tokens) is the remaining
 * boot-wiring step, tracked for follow-up.
 */
import { describe, expect, test } from "bun:test";
import { resolveDelegatedApproval } from "../engine/delegated-approval.ts";
import { resolveChannelBinding, resolveOwner } from "../policy/chatops-policy.ts";
import { parsePolicyToml } from "../policy/policy-toml.ts";
import { ApprovalPresenter } from "./approval-presenter.ts";
import { runWithChatopsApprovalContext } from "./chatops-request-context.ts";
import { ChatopsService } from "./chatops-service.ts";
import { ChatopsIdentityMapper, type ScimMatch } from "./identity-mapper.ts";
import { IntentRouter } from "./intent-router.ts";
import { ReplyDispatcher } from "./reply-dispatcher.ts";
import type { ChatTransport } from "./transport/transport.ts";
import type { ChatMessage, ChatPlatform } from "./types.ts";

const POLICY_TOML = `
[policy]
version=1
org="acme"
[policy.retention]
min_days=7
[policy.chatops.channel."C0"]
namespace="project:pay"
unmapped="refuse"
notify=["C_ALERT"]
[policy.chatops.ownership]
"payment-service"="alice@acme.com"
"*"="oncall@acme.com"
`;

// SCIM roster (Slice 3 seam): email → identity.
const SCIM: Record<string, ScimMatch> = {
  "bob@acme.com": {
    externalId: "ext-bob",
    email: "bob@acme.com",
    active: true,
    issuer: "https://idp",
  },
  "alice@acme.com": {
    externalId: "ext-alice",
    email: "alice@acme.com",
    active: true,
    issuer: "https://idp",
  },
};
// Slack userId → email (the connector lookup, cached by the mapper).
const SLACK_EMAILS: Record<string, string> = { U_BOB: "bob@acme.com", U_ALICE: "alice@acme.com" };
const OWNER_CHANNELS: Record<string, string> = {
  "alice@acme.com": "C_ALICE",
  "bob@acme.com": "C_BOB",
};

class MockTransport implements ChatTransport {
  private handler?: (m: ChatMessage) => Promise<void>;
  private up = false;
  constructor(readonly platform: ChatPlatform) {}
  onMessage(h: (m: ChatMessage) => Promise<void>): void {
    this.handler = h;
  }
  connected(): boolean {
    return this.up;
  }
  async start(): Promise<void> {
    this.up = true;
  }
  async stop(): Promise<void> {
    this.up = false;
  }
  async deliver(m: ChatMessage): Promise<void> {
    await this.handler?.(m);
  }
}

interface Harness {
  slack: MockTransport;
  svc: ChatopsService;
  posts: { channelId: string; text: string }[];
  refusals: { reason: string }[];
  executed: string[];
  presenter: ApprovalPresenter;
}

function buildHarness(): Harness {
  const policy = parsePolicyToml(POLICY_TOML).chatops;
  const posts: { channelId: string; text: string }[] = [];
  const refusals: { reason: string }[] = [];
  const executed: string[] = [];

  const mapper = new ChatopsIdentityMapper({
    lookupEmail: async (_p, userId) => SLACK_EMAILS[userId],
    findScimByEmail: (email) => SCIM[email],
    isOperatorValid: () => true,
    nowMs: () => 1_000_000,
    ttlSeconds: 900,
  });

  // I23 — the ONLY operational post path. Destinations are server-derived (originating / notify).
  const dispatcher = new ReplyDispatcher({
    post: async (_platform, channelId, text) => {
      posts.push({ channelId, text });
    },
    notifyChannelsFor: (ns) =>
      resolveChannelBinding(policy, "C0")?.namespace === ns ? ["C_ALERT"] : [],
  });

  // Owner-routed approval card uses its OWN bounded post (owner DM/channel) — still server-derived.
  const presenter = new ApprovalPresenter({
    post: async (channelId, text) => {
      posts.push({ channelId, text });
    },
    ownerChannelFor: (email) => OWNER_CHANNELS[email],
  });

  const ownerExternalIdFor = (email: string): string | undefined => SCIM[email]?.externalId;

  const router = new IntentRouter({
    knownActions: new Set(["deployment.rollback"]),
    // This integration harness exercises the read/write intents; agent-intent routing is covered
    // by intent-router.test.ts, so no agent is permitted here.
    permittedAgents: new Set(),
    runAgent: () =>
      Promise.resolve({
        ok: false as const,
        detail: "Agent commands are not wired in this harness.",
      }),
    resolveBinding: (ch) => resolveChannelBinding(policy, ch),
    resolveIdentity: (p, u) => mapper.resolve(p, u),
    resolveOwner: (resource) => resolveOwner(policy, resource),
    ownerExternalIdFor,
    askEngine: async (query, ns) => `[${ns}] answer to: ${query} → oncall = alice`,
    runGatedWrite: async (actionType, args, owner, requesterExternalId, originatingChannelId) => {
      // Faithful I20 path: set the owner-routing ALS context, then resolve via the real executor seam.
      const decision = await runWithChatopsApprovalContext(
        {
          ownerEmail: owner.email,
          ownerExternalId: owner.externalId,
          originatingChannelId,
          requesterExternalId,
          actionLabel: `${actionType} ${JSON.stringify(args)}`,
        },
        () =>
          resolveDelegatedApproval({
            requestRemote: () => presenter.requestApproval(),
            isActiveDelegate: (peerId) => peerId === owner.externalId, // the resolved resource owner
            isOperatorValid: () => true,
          }),
      );
      if (decision === "approved") {
        executed.push(actionType);
        return { approved: true };
      }
      return { approved: false };
    },
    reply: async (text) => {
      // server-derived ReplyTarget: the originating channel (I23).
      await dispatcher.send({ kind: "originating", platform: "slack", channelId: "C0" }, text);
    },
    auditRefusal: (reason) => {
      refusals.push({ reason });
    },
  });

  const slack = new MockTransport("slack");
  const svc = new ChatopsService({
    enabled: true,
    transports: [slack],
    handleMessage: (m) => router.handle(m),
    channelsForPlatform: () => 1,
    testParse: () => ({ kind: "read", query: "" }),
  });
  return { slack, svc, posts, refusals, executed, presenter };
}

const msg = (userId: string, text: string): ChatMessage => ({
  platform: "slack",
  channelId: "C0",
  userId,
  text,
  ts: `${Math.floor(performance.now())}.${userId}`,
  addressedToBot: true,
});

describe("ChatOps end-to-end flow (in-process integration)", () => {
  test("read: mapped user gets an engine answer in the originating channel", async () => {
    const h = buildHarness();
    await h.svc.start();
    await h.slack.deliver(msg("U_BOB", "@nimbus who's on call for payment-service?"));
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.channelId).toBe("C0");
    expect(h.posts[0]?.text).toContain("oncall = alice");
  });

  test("write: owner-routed card → approve → connector action executed", async () => {
    const h = buildHarness();
    await h.svc.start();
    const p = h.slack.deliver(
      msg("U_BOB", "@nimbus run deployment.rollback service=payment-service version=v1.4"),
    );
    // Card posts to the owner channel; resolve the click once the pending entry exists.
    await Promise.resolve();
    await Promise.resolve();
    const cardPost = h.posts.find((x) => x.channelId === "C_ALICE");
    expect(cardPost).toBeDefined();
    h.presenter.resolveClick({
      requestId: h.presenter.lastRequestId(),
      approverExternalId: "ext-alice",
      approved: true,
    });
    await p;
    expect(h.executed).toEqual(["deployment.rollback"]);
    expect(h.posts.at(-1)?.text).toContain("approved");
    // I23: every post went to a server-derived channel (owner card or originating reply).
    expect(h.posts.every((x) => x.channelId === "C_ALICE" || x.channelId === "C0")).toBe(true);
  });

  test("write: owner rejects → not executed, rejection replied", async () => {
    const h = buildHarness();
    await h.svc.start();
    const p = h.slack.deliver(
      msg("U_BOB", "@nimbus run deployment.rollback service=payment-service version=v1.4"),
    );
    await Promise.resolve();
    await Promise.resolve();
    h.presenter.resolveClick({
      requestId: h.presenter.lastRequestId(),
      approverExternalId: "ext-alice",
      approved: false,
    });
    await p;
    expect(h.executed).toEqual([]);
    expect(h.posts.at(-1)?.text).toContain("rejected");
  });

  test("unmapped user in a refuse channel → refusal audited + replied", async () => {
    const h = buildHarness();
    await h.svc.start();
    await h.slack.deliver(msg("U_GHOST", "@nimbus who's on call?"));
    expect(h.refusals.map((r) => r.reason)).toContain("unmapped_user");
    expect(h.posts.some((x) => x.channelId === "C0")).toBe(true);
  });

  test("I23: no operational post ever targets an out-of-policy channel", async () => {
    const h = buildHarness();
    await h.svc.start();
    await h.slack.deliver(msg("U_BOB", "@nimbus who's on call?"));
    const allowed = new Set(["C0", "C_ALERT", "C_ALICE", "C_BOB"]);
    expect(h.posts.every((x) => allowed.has(x.channelId))).toBe(true);
  });
});
