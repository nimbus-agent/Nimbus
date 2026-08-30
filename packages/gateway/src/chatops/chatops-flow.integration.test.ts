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
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildChatopsAgentInvoker } from "../agent-runs/agent-chatops-invoke.ts";
import { listEgress } from "../egress/egress-verify.ts";
import { resolveDelegatedApproval } from "../engine/delegated-approval.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { resolveChannelBinding, resolveOwner } from "../policy/chatops-policy.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import { parsePolicyToml } from "../policy/policy-toml.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { ApprovalPresenter } from "./approval-presenter.ts";
import { buildChatopsBoot, type ChatopsBootDeps } from "./chatops-boot.ts";
import { runWithChatopsApprovalContext } from "./chatops-request-context.ts";
import { ChatopsService } from "./chatops-service.ts";
import type { RunChatopsTool } from "./chatops-tool-runner.ts";
import { ChatopsIdentityMapper, type ScimMatch } from "./identity-mapper.ts";
import { IntentRouter } from "./intent-router.ts";
import { ReplyDispatcher } from "./reply-dispatcher.ts";
import type { SocketLike } from "./transport/slack-socket-adapter.ts";
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

/**
 * Task 9: the end-to-end seam. Everything above stops at a hand-built `IntentRouter` and
 * deliberately passes an empty `permittedAgents` (see the comment on `buildHarness` above) — it
 * proves the read/write intents compose, not that an `agent <name> ...` command reaches a real
 * agent through the REAL production boot wiring (`buildChatopsBoot`'s `routerFor`). A unit test on
 * each side of that seam already existed and stayed green while the seam itself was two
 * placeholder `new Set()`s — this section drives a message through `buildChatopsBoot` itself, with
 * `EXTERNAL_AGENT_NAMES` wired for real and `bindAgentInvoker` bound to the real
 * `buildChatopsAgentInvoker`, so a regression that reintroduces either placeholder fails here even
 * if `intent-router.test.ts` and `agent-chatops-invoke.test.ts` both stay green.
 */

/** Minimal in-memory NimbusVault — mirrors `chatops-boot.test.ts`'s `FakeVault`. Only `get`/`set`
 *  are exercised by `ensureChannelSalt`. */
class FakeVault implements NimbusVault {
  private readonly store = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }
  set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
  delete(_key: string): Promise<void> {
    throw new Error("delete must not be called by this boot path");
  }
  listKeys(_prefix?: string): Promise<string[]> {
    throw new Error("listKeys must not be called by this boot path");
  }
}

/** Minimal fake Slack Socket Mode transport — mirrors `chatops-boot.test.ts`'s `FakeSocket`. */
class FakeSocket implements SocketLike {
  private msgCb: ((raw: string) => void) | undefined;
  onMessage(cb: (raw: string) => void): void {
    this.msgCb = cb;
  }
  onClose(_cb: () => void): void {}
  send(_raw: string): void {}
  close(): void {}
  emit(frame: unknown): void {
    this.msgCb?.(JSON.stringify(frame));
  }
}

function e2eMention(channel: string, user: string, text: string, ts: string): unknown {
  return {
    type: "events_api",
    envelope_id: `env-${ts}`,
    payload: { event: { type: "app_mention", channel, user, text, ts } },
  };
}

async function e2eUntil(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("e2eUntil: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function e2eEnforcedPolicy(): EnforcedPolicy {
  return {
    retentionDays: 30,
    hitlRequired: new Set<string>(),
    quorum: new Map(),
    capabilitiesDisabled: new Set(),
    chatops: {
      channels: new Map([
        ["C0", { namespace: "project:pay", unmapped: "refuse" as const, notify: [] }],
      ]),
      ownership: new Map([["*", "oncall@acme.com"]]),
    },
  };
}

describe("ChatOps end-to-end: real buildChatopsBoot wires an agent command through", () => {
  let db: Database;
  let socket: FakeSocket;
  let posts: { channel: string; text: string }[];

  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    socket = new FakeSocket();
    posts = [];
  });
  afterEach(() => {
    db.close();
  });

  /**
   * The real production boot graph (`buildChatopsBoot`), not a hand-built `IntentRouter`. `llm`
   * is documentation-only here: `ChatopsBootDeps` carries no LLM concept at all, so "no LLM
   * configured" is entirely a property of the invoker each test binds afterward
   * (`buildChatopsAgentInvoker({ router: undefined, ... })`) — this parameter exists only so a
   * reader of the test below sees the intent stated, not inferred.
   */
  async function bootForTest(opts: {
    readonly db: Database;
    readonly llm?: "none";
  }): Promise<Awaited<ReturnType<typeof buildChatopsBoot>>> {
    const runTool: RunChatopsTool = (_platform, toolId, args) => {
      if (toolId === "slack_socket_open") return Promise.resolve({ url: "wss://fake" });
      if (toolId === "slack_user_info") {
        const user = (args as { user: string }).user;
        return Promise.resolve(
          user === "U_BOB"
            ? { user: { profile: { email: "bob@acme.com" } } }
            : { user: { profile: {} } },
        );
      }
      if (toolId === "slack_chat_post") {
        const a = args as { channel: string; text: string };
        posts.push({ channel: a.channel, text: a.text });
        return Promise.resolve({ ok: true });
      }
      throw new Error(`unexpected tool ${toolId}`);
    };

    const deps: ChatopsBootDeps = {
      cfg: {
        enabled: true,
        slackEnabled: true,
        teamsEnabled: false,
        botVaultEntry: "chatops-bot",
        identityCacheTtlSeconds: 900,
        teamsBotAppId: "",
      },
      policyGate: { enforced: e2eEnforcedPolicy },
      identity: {
        findScimByEmail: (email) =>
          email === "bob@acme.com"
            ? { externalId: "ext-bob", email, active: true, issuer: "idp" }
            : undefined,
        isOperatorValid: () => true,
      },
      runTool,
      db: opts.db,
      vault: new FakeVault(),
      audit: { recordAudit: () => {} },
      dispatcher: { dispatch: () => Promise.resolve({ rolledBack: true }) },
      egressSink: { append: () => {} },
      socketFactory: () => socket,
      log: () => {},
    };

    const boot = await buildChatopsBoot(deps);
    await boot.service.start();
    return boot;
  }

  async function deliverMessage(
    boot: Awaited<ReturnType<typeof buildChatopsBoot>>,
    text: string,
  ): Promise<void> {
    void boot; // the message reaches the boot's router via the shared fake socket, not a direct call
    socket.emit(e2eMention("C0", "U_BOB", text, `${Date.now()}`));
    await e2eUntil(() => posts.length > 0);
  }

  function postedText(): string | undefined {
    return posts.at(-1)?.text;
  }

  test("end to end: a channel message runs an agent, posts a brief, and ledgers ONE row", async () => {
    const boot = await bootForTest({ db });
    boot.bindAgentInvoker(buildChatopsAgentInvoker({ db, router: undefined }));

    await deliverMessage(boot, "@nimbus agent glossary term=SLO");

    expect(postedText()).toContain("## Gaps");
    const rows = listEgress(db, { limit: 10 });
    // ONE row, from PR 1's post appender. NOT two: the invoker deliberately appends nothing.
    expect(rows.length).toBe(1);
    expect(rows[0]?.method).toBe("chatops.agentBrief");

    await boot.service.stop();
  });

  test("the brief posts on a gateway with no LLM configured", async () => {
    const boot = await bootForTest({ db, llm: "none" });
    boot.bindAgentInvoker(buildChatopsAgentInvoker({ db, router: undefined }));

    await deliverMessage(boot, "@nimbus agent glossary term=SLO");

    expect(postedText()).toContain("## Gaps");

    await boot.service.stop();
  });
});
