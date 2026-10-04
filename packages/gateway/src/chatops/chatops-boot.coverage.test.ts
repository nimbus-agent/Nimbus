/**
 * Branches of `buildChatopsBoot` that `chatops-boot.test.ts` leaves unexercised. Every message here
 * enters through the Teams events surface, whose `onActivity` awaits the whole handling chain —
 * so each test awaits the real pipeline to completion instead of polling for a side effect.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { listEgress } from "../egress/egress-verify.ts";
import { EgressAppendFailedError } from "../egress/model-egress.ts";
import type { PlannedAction } from "../engine/types.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import type { ChatopsChannelBinding } from "../policy/types.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { buildChatopsBoot, type ChatopsBoot, type ChatopsBootDeps } from "./chatops-boot.ts";
import type { RunChatopsTool } from "./chatops-tool-runner.ts";
import type { ScimMatch } from "./identity-mapper.ts";
import type { SocketLike } from "./transport/slack-socket-adapter.ts";

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

let db: Database;
// Bun 1.3 never fires a test's timeout while the event loop is otherwise idle, so a regression that
// leaves a delivery awaiting an approval nobody gives would hang the WHOLE run instead of failing
// this test. A no-op interval keeps the loop alive so the per-test timeout can fire.
let keepAlive: ReturnType<typeof setInterval> | undefined;
beforeEach(() => {
  keepAlive = setInterval(() => {}, 1_000);
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => {
  clearInterval(keepAlive);
  db.close();
});

const CHANNEL = "19:conv-pay";

function policyWith(channels: Record<string, ChatopsChannelBinding>): EnforcedPolicy {
  return {
    retentionDays: 30,
    retentionMinDays: 0,
    hitlRequired: new Set<string>(),
    quorum: new Map(),
    capabilitiesDisabled: new Set(),
    chatops: {
      channels: new Map(Object.entries(channels)),
      ownership: new Map([
        ["payment-service", "alice@acme.com"],
        ["*", "oncall@acme.com"],
      ]),
    },
  };
}

const DEFAULT_CHANNELS: Record<string, ChatopsChannelBinding> = {
  [CHANNEL]: { namespace: "project:pay", unmapped: "refuse", notify: [] },
};

type Post = { platform: string; channel: string; text: string };

interface Harness {
  readonly boot: ChatopsBoot;
  readonly posts: Post[];
  readonly audits: { actionType: string; hitlStatus: string; actionJson: string }[];
  readonly dispatched: PlannedAction[];
  readonly logs: string[];
  /** Mutable SCIM directory, keyed by email — tests may deprovision an entry mid-flow. */
  readonly scim: Map<string, ScimMatch>;
  /** Teams user id → the email `teams_user_info` returns for it. */
  readonly emails: Map<string, string>;
  /** Resolves with the next approval card posted. */
  nextCard(): Promise<Post>;
  deliver(userId: string, text: string, channel?: string): Promise<void>;
}

let activitySeq = 0;

async function bootTeams(
  overrides: Partial<ChatopsBootDeps> & { channels?: Record<string, ChatopsChannelBinding> } = {},
): Promise<Harness> {
  const posts: Post[] = [];
  const audits: Harness["audits"] = [];
  const dispatched: PlannedAction[] = [];
  const logs: string[] = [];
  const scim = new Map<string, ScimMatch>([
    ["bob@acme.com", { externalId: "ext-bob", email: "bob@acme.com", active: true, issuer: "idp" }],
    [
      "alice@acme.com",
      { externalId: "ext-alice", email: "alice@acme.com", active: true, issuer: "idp" },
    ],
  ]);
  const emails = new Map<string, string>([
    ["T_BOB", "bob@acme.com"],
    ["T_ALICE", "alice@acme.com"],
  ]);
  let cardWaiter: ((p: Post) => void) | undefined;

  const runTool: RunChatopsTool = (platform, toolId, args) => {
    if (toolId === "teams_user_info") {
      const email = emails.get((args as { userId: string }).userId);
      return Promise.resolve(email === undefined ? {} : { mail: email });
    }
    if (toolId === "teams_chat_post" || toolId === "slack_chat_post") {
      const a = args as { conversationId?: string; channel?: string; text: string };
      const post = { platform, channel: a.conversationId ?? a.channel ?? "", text: a.text };
      posts.push(post);
      if (post.text.includes("Approval needed") && cardWaiter !== undefined) {
        const w = cardWaiter;
        cardWaiter = undefined;
        w(post);
      }
      return Promise.resolve({ ok: true });
    }
    throw new Error(`unexpected tool ${toolId}`);
  };

  const { channels, ...depOverrides } = overrides;
  const deps: ChatopsBootDeps = {
    cfg: {
      enabled: true,
      slackEnabled: false,
      teamsEnabled: true,
      botVaultEntry: "chatops-bot",
      identityCacheTtlSeconds: 900,
      teamsBotAppId: "bot-app",
    },
    policyGate: { enforced: () => policyWith(channels ?? DEFAULT_CHANNELS) },
    identity: {
      findScimByEmail: (email) => scim.get(email),
      isOperatorValid: () => true,
    },
    runTool,
    db,
    vault: new FakeVault(),
    audit: {
      recordAudit: (e) =>
        audits.push({
          actionType: e.actionType,
          hitlStatus: e.hitlStatus,
          actionJson: e.actionJson,
        }),
    },
    dispatcher: {
      dispatch: (action) => {
        dispatched.push(action);
        return Promise.resolve({ rolledBack: true });
      },
    },
    egressSink: { append: () => {} },
    validateTeamsJwt: () => Promise.resolve(true),
    log: (m) => logs.push(m),
    ...depOverrides,
  };
  const boot = await buildChatopsBoot(deps);
  await boot.service.start();
  return {
    boot,
    posts,
    audits,
    dispatched,
    logs,
    scim,
    emails,
    nextCard: () =>
      new Promise<Post>((resolve) => {
        cardWaiter = resolve;
      }),
    deliver: async (userId, text, channel = CHANNEL) => {
      const surface = boot.teamsSurface;
      if (surface === undefined) throw new Error("teams surface not wired");
      activitySeq += 1;
      await surface.onActivity({
        type: "message",
        id: `act-${activitySeq}`,
        serviceUrl: "https://smba.example/emea/",
        from: { id: userId },
        conversation: { id: channel },
        text,
      });
    },
  };
}

/** Yields to the event loop until `done()` holds, a bounded number of times — never a sleep. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
  if (!done()) throw new Error("condition never became true");
}

function refusals(h: Harness): { reason: string; detail: string; channelId: string }[] {
  return h.audits
    .filter((a) => a.actionType === "chatops.refusal")
    .map((a) => JSON.parse(a.actionJson) as { reason: string; detail: string; channelId: string });
}

describe("agent commands through the boot wiring", () => {
  test("before an invoker is bound, an agent command is refused with the not-available detail", async () => {
    const h = await bootTeams();
    await h.deliver("T_BOB", "@nimbus agent expert topicOrFile=redis");
    expect(refusals(h)).toEqual([
      {
        reason: "bad_agent_params",
        detail: "Agent commands are not available yet.",
        channelId: CHANNEL,
      },
    ]);
    expect(h.posts.map((p) => p.text)).toEqual(["Agent commands are not available yet."]);
  });

  test("a non-glossary agent's params reach the invoker unclamped", async () => {
    const h = await bootTeams();
    const seen: { agent: string; params: unknown }[] = [];
    h.boot.bindAgentInvoker((agent, params) => {
      seen.push({ agent, params });
      return Promise.resolve({ ok: true, markdown: "## Experts\n\n- alice" });
    });
    await h.deliver("T_BOB", "@nimbus agent expert topicOrFile=redis limit=50");
    // `limit` is above the glossary clamp (20); only glossary is ever clamped.
    expect(seen).toEqual([{ agent: "expert", params: { topicOrFile: "redis", limit: 50 } }]);
    expect(h.posts.at(-1)?.text).toContain("- alice");
    // The brief went out as an agent brief, not a generic reply.
    expect(listEgress(db, { limit: 10 }).map((e) => e.method)).toEqual(["chatops.agentBrief"]);
  });

  test("an invoker failure is refused with the invoker's own detail and posts no brief", async () => {
    const h = await bootTeams();
    h.boot.bindAgentInvoker(() => Promise.resolve({ ok: false, detail: "limit must be <= 100" }));
    await h.deliver("T_BOB", "@nimbus agent expert topicOrFile=redis");
    expect(refusals(h)).toEqual([
      { reason: "bad_agent_params", detail: "limit must be <= 100", channelId: CHANNEL },
    ]);
    expect(h.posts.map((p) => p.text)).toEqual(["limit must be <= 100"]);
    expect(listEgress(db, { limit: 10 }).map((e) => e.method)).toEqual(["chatops.reply"]);
  });
});

describe("user lookup tolerance", () => {
  test("a non-object tool result resolves to no email (unmapped), never a crash", async () => {
    for (const raw of [null, "bob@acme.com"]) {
      const h = await bootTeams({
        runTool: (_p, toolId, args) => {
          if (toolId === "teams_user_info") return Promise.resolve(raw);
          if (toolId === "teams_chat_post") {
            const a = args as { text: string };
            return Promise.resolve({ ok: true, echoed: a.text });
          }
          throw new Error(`unexpected tool ${toolId}`);
        },
      });
      await h.deliver("T_BOB", "@nimbus who is on call?");
      expect(refusals(h).map((r) => r.reason)).toEqual(["unmapped_user"]);
      // Handled as "no email", not as a lookup that threw.
      expect(h.logs).toEqual([]);
    }
  });

  test("a content envelope with no text block is read as the raw result itself", async () => {
    const h = await bootTeams({
      runTool: (_p, toolId) => {
        if (toolId === "teams_user_info") {
          // No `text` block to unwrap, so the mail on the raw object is what identifies the user.
          return Promise.resolve({
            content: [{ type: "image", data: "..." }],
            mail: "bob@acme.com",
          });
        }
        if (toolId === "teams_chat_post") return Promise.resolve({ ok: true });
        throw new Error(`unexpected tool ${toolId}`);
      },
    });
    let asked: string | undefined;
    h.boot.bindAskEngine((query) => {
      asked = query;
      return Promise.resolve("answer");
    });
    await h.deliver("T_BOB", "@nimbus who is on call?");
    expect(refusals(h)).toEqual([]);
    expect(asked).toBe("who is on call?");
  });

  test("a non-Error thrown by the lookup is logged verbatim and the user is unmapped", async () => {
    const h = await bootTeams({
      runTool: (_p, toolId) => {
        if (toolId === "teams_user_info") return Promise.reject("graph throttled");
        if (toolId === "teams_chat_post") return Promise.resolve({ ok: true });
        throw new Error(`unexpected tool ${toolId}`);
      },
    });
    await h.deliver("T_BOB", "@nimbus who is on call?");
    expect(h.logs).toEqual(["chatops: teams user lookup failed: graph throttled"]);
    expect(refusals(h).map((r) => r.reason)).toEqual(["unmapped_user"]);
  });
});

describe("write routing edges", () => {
  test("an owner with no active Nimbus identity is refused before any card is posted", async () => {
    const h = await bootTeams();
    const noIdentity = {
      reason: "no_owner",
      detail: "Owner 'oncall@acme.com' has no Nimbus identity.",
      channelId: CHANNEL,
    };
    // `checkout` falls to the `*` owner, oncall@acme.com, who has no SCIM entry at all...
    await h.deliver("T_BOB", "@nimbus run deployment.rollback service=checkout");
    expect(refusals(h)).toEqual([noIdentity]);
    // ...and a deactivated SCIM entry counts the same as none.
    h.scim.set("oncall@acme.com", {
      externalId: "ext-oncall",
      email: "oncall@acme.com",
      active: false,
      issuer: "idp",
    });
    await h.deliver("T_BOB", "@nimbus run deployment.rollback service=checkout");
    expect(refusals(h)).toEqual([noIdentity, noIdentity]);
    expect(h.posts.some((p) => p.text.includes("Approval needed"))).toBe(false);
    expect(h.dispatched).toHaveLength(0);
  });

  test("an unmapped user's approve does not spend the card; the owner's later click still does", async () => {
    const h = await bootTeams();
    const card = h.nextCard();
    const write = h.deliver("T_BOB", "@nimbus run deployment.rollback service=payment-service");
    await card;

    await h.deliver("T_EVE", "approve"); // no email for T_EVE → unmapped
    expect(h.dispatched).toHaveLength(0);

    await h.deliver("T_ALICE", "approve");
    await write;
    expect(h.dispatched.map((a) => a.type)).toEqual(["deployment.rollback"]);
    expect(h.audits.find((a) => a.actionType === "deployment.rollback")?.hitlStatus).toBe(
      "approved",
    );
  });

  test("a card post that fails never clears a NEWER card pending in the same channel", async () => {
    // The first card's post is held open so a second write can register its own card in the
    // channel BEFORE the first post fails; that failure may only clear its OWN pending entry.
    const emails = new Map([
      ["T_BOB", "bob@acme.com"],
      ["T_ALICE", "alice@acme.com"],
    ]);
    let failFirstCard: ((e: Error) => void) | undefined;
    let cardPosts = 0;
    const h = await bootTeams({
      runTool: (_platform, toolId, args) => {
        if (toolId === "teams_user_info") {
          const email = emails.get((args as { userId: string }).userId);
          return Promise.resolve(email === undefined ? {} : { mail: email });
        }
        if (toolId === "teams_chat_post") {
          if ((args as { text: string }).text.includes("Approval needed")) {
            cardPosts += 1;
            if (cardPosts === 1) {
              return new Promise((_resolve, reject) => {
                failFirstCard = reject;
              });
            }
          }
          return Promise.resolve({ ok: true });
        }
        throw new Error(`unexpected tool ${toolId}`);
      },
    });

    const write1 = h.deliver(
      "T_BOB",
      "@nimbus run deployment.rollback service=payment-service env=prod",
    );
    await until(() => failFirstCard !== undefined);
    const write2 = h.deliver(
      "T_BOB",
      "@nimbus run deployment.rollback service=payment-service env=staging",
    );
    await until(() => cardPosts === 2);

    failFirstCard?.(new Error("teams 503"));
    await expect(write1).rejects.toThrow("teams 503");

    // The owner's approve still finds the SECOND card live and resolves it.
    await h.deliver("T_ALICE", "approve");
    await until(() => h.dispatched.length === 1);
    await write2;
    expect(h.dispatched.map((a) => a.payload)).toEqual([
      { service: "payment-service", env: "staging" },
    ]);
  });

  test("an owner deprovisioned between click and honor is not honored (live SCIM check)", async () => {
    const h = await bootTeams();
    // A second account bound to the owner's externalId, still active, does the clicking.
    h.emails.set("T_ALICE_ALT", "alice.alt@acme.com");
    h.scim.set("alice.alt@acme.com", {
      externalId: "ext-alice",
      email: "alice.alt@acme.com",
      active: true,
      issuer: "idp",
    });
    const card = h.nextCard();
    const write = h.deliver("T_BOB", "@nimbus run deployment.rollback service=payment-service");
    await card;
    // The ownership email's identity is deactivated while the card is pending.
    h.scim.set("alice@acme.com", {
      externalId: "ext-alice",
      email: "alice@acme.com",
      active: false,
      issuer: "idp",
    });
    await h.deliver("T_ALICE_ALT", "approve");
    await write;
    // Not honored → local-owner fallback → no approver bound → fail-closed reject.
    expect(h.dispatched).toHaveLength(0);
    expect(h.audits.find((a) => a.actionType === "deployment.rollback")?.hitlStatus).toBe(
      "rejected",
    );
  });
});

describe("command interception", () => {
  test("an intercepted command never reaches the router", async () => {
    const intercepted: string[] = [];
    const h = await bootTeams({
      interceptCommand: (m) => {
        intercepted.push(m.text);
        return Promise.resolve(true);
      },
    });
    let asked = false;
    h.boot.bindAskEngine(() => {
      asked = true;
      return Promise.resolve("answer");
    });
    await h.deliver("T_BOB", "@nimbus tribal capture 42");
    expect(intercepted).toEqual(["@nimbus tribal capture 42"]);
    expect(asked).toBe(false);
    expect(h.posts).toHaveLength(0);
  });

  test("a declined interception falls through to the router", async () => {
    const h = await bootTeams({ interceptCommand: () => Promise.resolve(false) });
    h.boot.bindAskEngine((query, namespace) => Promise.resolve(`[${namespace}] ${query}`));
    await h.deliver("T_BOB", "@nimbus what changed?");
    expect(h.posts.map((p) => p.text)).toEqual(["[project:pay] what changed?"]);
  });
});

describe("message-seam error containment", () => {
  test("an error that is not an egress-append failure still propagates", async () => {
    const errors: unknown[] = [];
    const h = await bootTeams({ logError: (fields) => errors.push(fields) });
    h.boot.bindAskEngine(() => Promise.reject(new Error("engine exploded")));
    await expect(h.deliver("T_BOB", "@nimbus what changed?")).rejects.toThrow("engine exploded");
    expect(errors).toEqual([]);
  });

  test("an egress failure without chatops context is contained and logged with the message's channel", async () => {
    const errors: { fields: Readonly<Record<string, unknown>>; msg: string }[] = [];
    const h = await bootTeams({ logError: (fields, msg) => errors.push({ fields, msg }) });
    // E.g. a model-class append failing inside the ask path: no chatops post kind or channel.
    const cause = new Error("SQLITE_BUSY");
    h.boot.bindAskEngine(() => Promise.reject(new EgressAppendFailedError(cause)));
    await h.deliver("T_BOB", "@nimbus what changed?");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.msg).toBe(
      "chatops: outbound post blocked — egress ledger append failed, nothing was posted",
    );
    expect(errors[0]?.fields["channelId"]).toBe(CHANNEL);
    expect(errors[0]?.fields["postKind"]).toBe("unknown");
    expect(errors[0]?.fields["platform"]).toBe("teams");
    expect(h.posts).toHaveLength(0);
  });

  test("without a logError dep the failure falls back to the plain log", async () => {
    const h = await bootTeams();
    h.boot.bindAskEngine(() =>
      Promise.reject(new EgressAppendFailedError(new Error("disk full"), { chatopsPostKind: 7 })),
    );
    await h.deliver("T_BOB", "@nimbus what changed?");
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toStartWith("chatops: outbound post blocked");
    expect(h.logs[0]).toContain(`"postKind":"unknown"`);
    expect(h.logs[0]).toContain(`"channelId":"${CHANNEL}"`);
  });
});

describe("boot surface members", () => {
  test("replyTo a namespace notifies each policy notify channel of that namespace exactly once", async () => {
    const h = await bootTeams({
      channels: {
        [CHANNEL]: { namespace: "project:pay", unmapped: "refuse", notify: ["C_ALERT", "C_OPS"] },
        "19:conv-pay-2": { namespace: "project:pay", unmapped: "refuse", notify: ["C_ALERT"] },
        "19:conv-other": { namespace: "project:other", unmapped: "refuse", notify: ["C_OTHER"] },
      },
    });
    await h.boot.replyTo({ kind: "namespaceNotify", namespace: "project:pay" }, "deploy frozen");
    expect(h.posts).toEqual([
      { platform: "slack", channel: "C_ALERT", text: "deploy frozen" },
      { platform: "slack", channel: "C_OPS", text: "deploy frozen" },
    ]);
    expect(listEgress(db, { limit: 10 }).map((e) => e.method)).toEqual([
      "chatops.reply",
      "chatops.reply",
    ]);
  });

  test("requestOwnerApproval rejects until a local approver is bound, then delegates to it", async () => {
    const h = await bootTeams();
    await expect(h.boot.requestOwnerApproval("capture?", { id: 1 })).rejects.toThrow(
      "chatops: no local approver bound",
    );
    const asked: { prompt: string; details: unknown }[] = [];
    h.boot.bindLocalConsent((prompt, details) => {
      asked.push({ prompt, details });
      return Promise.resolve(true);
    });
    expect(await h.boot.requestOwnerApproval("capture?", { id: 1 })).toBe(true);
    expect(asked).toEqual([{ prompt: "capture?", details: { id: 1 } }]);
  });

  test("stop() stops the service's transports", async () => {
    const h = await bootTeams();
    expect(h.boot.service.status().platforms).toEqual([
      { name: "teams", connected: true, channels: 1 },
    ]);
    await h.boot.stop();
    expect(h.boot.service.status().platforms).toEqual([
      { name: "teams", connected: false, channels: 1 },
    ]);
  });
});

describe("slack transport wiring", () => {
  class ClosableSocket implements SocketLike {
    private closeCb: (() => void) | undefined;
    onMessage(_cb: (raw: string) => void): void {}
    onClose(cb: () => void): void {
      this.closeCb = cb;
    }
    send(_raw: string): void {}
    close(): void {}
    fireClose(): void {
      this.closeCb?.();
    }
  }

  function slackDeps(over: Partial<ChatopsBootDeps>): ChatopsBootDeps {
    return {
      cfg: {
        enabled: true,
        slackEnabled: true,
        teamsEnabled: false,
        botVaultEntry: "chatops-bot",
        identityCacheTtlSeconds: 900,
        teamsBotAppId: "",
      },
      policyGate: { enforced: () => policyWith(DEFAULT_CHANNELS) },
      runTool: () => Promise.resolve({ url: "wss://fake" }),
      db,
      vault: new FakeVault(),
      audit: { recordAudit: () => {} },
      dispatcher: { dispatch: () => Promise.resolve({ rolledBack: true }) },
      egressSink: { append: () => {} },
      log: () => {},
      ...over,
    };
  }

  test("an injected scheduleReconnect is what re-opens a dropped socket", async () => {
    const sockets: ClosableSocket[] = [];
    let opens = 0;
    const scheduled: { ms: number; fn: () => void }[] = [];
    const boot = await buildChatopsBoot(
      slackDeps({
        runTool: (_p, toolId) => {
          if (toolId === "slack_socket_open") opens += 1;
          return Promise.resolve({ url: "wss://fake" });
        },
        socketFactory: () => {
          const s = new ClosableSocket();
          sockets.push(s);
          return s;
        },
        scheduleReconnect: (ms, fn) => scheduled.push({ ms, fn }),
      }),
    );
    await boot.service.start();
    expect(opens).toBe(1);
    sockets[0]?.fireClose();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ms).toBeGreaterThan(0);
    scheduled[0]?.fn();
    // `start()` is re-entered asynchronously; wait for the replacement socket by condition, not by
    // a hand-counted number of microtask hops that an extra `await` inside `start()` would break.
    await until(() => sockets.length === 2);
    expect(opens).toBe(2);
    expect(sockets).toHaveLength(2);
    await boot.stop();
  });

  test("without a socketFactory the boot still builds (the real factory is only used on start)", async () => {
    const boot = await buildChatopsBoot(slackDeps({}));
    expect(boot.service.status()).toEqual({
      enabled: true,
      platforms: [{ name: "slack", connected: false, channels: 1 }],
    });
    expect(boot.teamsSurface).toBeUndefined();
  });
});
