import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import type { EgressEntry } from "../egress/egress-record.ts";
import { listEgress } from "../egress/egress-verify.ts";
import type { PlannedAction } from "../engine/types.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import type { ChatopsChannelBinding } from "../policy/types.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { buildChatopsBoot, type ChatopsBootDeps, emailFromUserInfo } from "./chatops-boot.ts";
import type { RunChatopsTool } from "./chatops-tool-runner.ts";
import type { SocketLike } from "./transport/slack-socket-adapter.ts";

/**
 * Minimal in-memory NimbusVault (mirrors `policy/anchor-keypair.test.ts`'s `FakeVault`). Only
 * `get`/`set` are exercised by `ensureChannelSalt`.
 */
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

/** Real, migrated in-memory index DB + a fresh FakeVault per test — `buildChatopsBoot` now
 *  REQUIRES both (I29 chatops-class ledgering, salted channel hashing). */
let db: Database;
let vault: NimbusVault;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  vault = new FakeVault();
});
afterEach(() => {
  db.close();
});

const SLACK_EMAILS: Record<string, string> = {
  U_BOB: "bob@acme.com",
  U_ALICE: "alice@acme.com",
};
const SCIM: Record<string, { externalId: string; email: string; active: boolean; issuer: string }> =
  {
    "bob@acme.com": { externalId: "ext-bob", email: "bob@acme.com", active: true, issuer: "idp" },
    "alice@acme.com": {
      externalId: "ext-alice",
      email: "alice@acme.com",
      active: true,
      issuer: "idp",
    },
  };

function enforcedWith(channels: Record<string, ChatopsChannelBinding>): EnforcedPolicy {
  return {
    retentionDays: 30,
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

class FakeSocket implements SocketLike {
  private msgCb: ((raw: string) => void) | undefined;
  readonly sent: string[] = [];
  onMessage(cb: (raw: string) => void): void {
    this.msgCb = cb;
  }
  onClose(_cb: () => void): void {}
  send(raw: string): void {
    this.sent.push(raw);
  }
  close(): void {}
  emit(frame: unknown): void {
    this.msgCb?.(JSON.stringify(frame));
  }
}

function mention(channel: string, user: string, text: string, ts: string): unknown {
  return {
    type: "events_api",
    envelope_id: `env-${ts}`,
    payload: { event: { type: "app_mention", channel, user, text, ts } },
  };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Harness {
  socket: FakeSocket;
  posts: { platform: string; channel: string; text: string; serviceUrl?: string }[];
  dispatched: PlannedAction[];
  audits: { actionType: string; hitlStatus: string; actionJson: string }[];
  /** Recording fake for `ChatopsBootDeps.egressSink` (now required — I29 fix 3). */
  egressEntries: EgressEntry[];
  /**
   * A SINGLE ordered log that both `egressSink.append` and `dispatcher.dispatch` push onto as
   * they happen (I29 fix 3). Two SEPARATE arrays (or a length check on either) cannot detect a
   * regression that calls `dispatch()` before `egressSink.append()` — both would still end up
   * length 1 either way. Only a single shared, order-preserving log can prove append-before-
   * dispatch, which is the actual I29 guarantee under test.
   */
  order: string[];
  boot: Awaited<ReturnType<typeof buildChatopsBoot>>;
}

async function buildHarness(overrides?: Partial<ChatopsBootDeps>): Promise<Harness> {
  const socket = new FakeSocket();
  const posts: Harness["posts"] = [];
  const dispatched: PlannedAction[] = [];
  const audits: Harness["audits"] = [];
  const egressEntries: EgressEntry[] = [];
  const order: string[] = [];

  const runTool: RunChatopsTool = (platform, toolId, args, opts) => {
    if (toolId === "slack_socket_open") return Promise.resolve({ url: "wss://fake" });
    if (toolId === "slack_user_info") {
      const user = (args as { user: string }).user;
      const email = SLACK_EMAILS[user];
      return Promise.resolve(email === undefined ? { user: {} } : { user: { profile: { email } } });
    }
    if (toolId === "slack_chat_post" || toolId === "teams_chat_post") {
      const a = args as { channel?: string; conversationId?: string; text: string };
      posts.push({
        platform,
        channel: a.channel ?? a.conversationId ?? "",
        text: a.text,
        ...(opts?.serviceUrl === undefined ? {} : { serviceUrl: opts.serviceUrl }),
      });
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
    policyGate: {
      enforced: () =>
        enforcedWith({
          C0: { namespace: "project:pay", unmapped: "refuse", notify: ["C_ALERT"] },
        }),
    },
    identity: {
      findScimByEmail: (email) => SCIM[email],
      isOperatorValid: () => true,
    },
    runTool,
    db,
    vault,
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
        order.push("dispatch");
        dispatched.push(action);
        return Promise.resolve({ rolledBack: true });
      },
    },
    // Recording fake, not NULL_EGRESS_SINK: this executor is dispatch-capable, so the default
    // harness proves the sink is actually consulted (see the I29 fix-3 regression test below).
    egressSink: {
      append: (entry) => {
        order.push("egress");
        egressEntries.push(entry);
      },
    },
    socketFactory: () => socket,
    log: () => {},
    ...overrides,
  };

  const boot = await buildChatopsBoot(deps);
  boot.bindAskEngine((query, namespace) =>
    Promise.resolve(`[${namespace}] answer to: ${query} → oncall = alice`),
  );
  return { socket, posts, dispatched, audits, egressEntries, order, boot };
}

describe("buildChatopsBoot — full production graph", () => {
  test("read: mapped user gets an engine answer in the originating channel", async () => {
    const h = await buildHarness();
    await h.boot.service.start();
    h.socket.emit(mention("C0", "U_BOB", "@nimbus who is on call for payment-service?", "1"));
    await until(() => h.posts.length === 1);
    expect(h.posts[0]?.channel).toBe("C0");
    expect(h.posts[0]?.text).toContain("project:pay");
    expect(h.posts[0]?.text).toContain("oncall = alice");
    await h.boot.service.stop();
  });

  test("write: owner-routed card → owner approves → dispatched + audit approved", async () => {
    const h = await buildHarness();
    await h.boot.service.start();
    h.socket.emit(
      mention(
        "C0",
        "U_BOB",
        "@nimbus run deployment.rollback service=payment-service version=v1.4",
        "2",
      ),
    );
    await until(() => h.posts.some((p) => p.text.includes("Approval needed")));
    const card = h.posts.find((p) => p.text.includes("Approval needed"));
    expect(card?.channel).toBe("C0"); // server-derived originating channel (no DMs in scope)
    expect(card?.text).toContain("alice@acme.com");

    h.socket.emit(mention("C0", "U_ALICE", "@nimbus approve", "3"));
    await until(() => h.dispatched.length === 1);
    expect(h.dispatched[0]?.type).toBe("deployment.rollback");
    expect(h.dispatched[0]?.payload).toEqual({ service: "payment-service", version: "v1.4" });
    const gateRow = h.audits.find((a) => a.actionType === "deployment.rollback");
    expect(gateRow?.hitlStatus).toBe("approved");
    await until(() => h.posts.some((p) => p.text.includes("approved & executed")));
    await h.boot.service.stop();
  });

  test("write: owner rejects → no dispatch + audit rejected", async () => {
    const h = await buildHarness();
    await h.boot.service.start();
    h.socket.emit(
      mention("C0", "U_BOB", "@nimbus run deployment.rollback service=payment-service", "4"),
    );
    await until(() => h.posts.some((p) => p.text.includes("Approval needed")));
    h.socket.emit(mention("C0", "U_ALICE", "@nimbus reject", "5"));
    await until(() => h.audits.some((a) => a.actionType === "deployment.rollback"));
    expect(h.dispatched).toHaveLength(0);
    expect(h.audits.find((a) => a.actionType === "deployment.rollback")?.hitlStatus).toBe(
      "rejected",
    );
    await until(() => h.posts.some((p) => p.text.includes("rejected")));
    await h.boot.service.stop();
  });

  test("write: NON-owner approve click is not honored (I20) → falls back + rejects fail-closed", async () => {
    const h = await buildHarness();
    await h.boot.service.start();
    h.socket.emit(
      mention("C0", "U_BOB", "@nimbus run deployment.rollback service=payment-service", "6"),
    );
    await until(() => h.posts.some((p) => p.text.includes("Approval needed")));
    // bob (requester, not the owner) clicks approve — I20 must refuse to honor it and the
    // default local-consent fallback (no approver bound) fails closed.
    h.socket.emit(mention("C0", "U_BOB", "@nimbus approve", "7"));
    await until(() => h.audits.some((a) => a.actionType === "deployment.rollback"));
    expect(h.dispatched).toHaveLength(0);
    expect(h.audits.find((a) => a.actionType === "deployment.rollback")?.hitlStatus).toBe(
      "rejected",
    );
    await h.boot.service.stop();
  });

  test("unmapped user under refuse mode → refusal reply + refusal audit row", async () => {
    const h = await buildHarness();
    await h.boot.service.start();
    h.socket.emit(mention("C0", "U_EVE", "@nimbus who is on call?", "8"));
    await until(() => h.audits.some((a) => a.actionType === "chatops.refusal"));
    const refusal = h.audits.find((a) => a.actionType === "chatops.refusal");
    expect(refusal?.hitlStatus).toBe("not_required");
    expect(refusal?.actionJson).toContain("unmapped_user");
    await until(() => h.posts.some((p) => p.text.includes("not enrolled")));
    await h.boot.service.stop();
  });

  test("unbound channel → bot stays silent (fail-closed)", async () => {
    const h = await buildHarness();
    await h.boot.service.start();
    h.socket.emit(mention("C_UNBOUND", "U_BOB", "@nimbus hello", "9"));
    // Give the pipeline a beat; nothing may be posted or audited.
    await new Promise((r) => setTimeout(r, 50));
    expect(h.posts).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
    await h.boot.service.stop();
  });

  test("I23: every operational post lands in the originating channel or a policy notify channel", async () => {
    const h = await buildHarness();
    await h.boot.service.start();
    h.socket.emit(mention("C0", "U_BOB", "@nimbus status of payment-service?", "10"));
    h.socket.emit(
      mention("C0", "U_BOB", "@nimbus run deployment.rollback service=payment-service", "11"),
    );
    await until(() => h.posts.some((p) => p.text.includes("Approval needed")));
    h.socket.emit(mention("C0", "U_ALICE", "@nimbus approve", "12"));
    await until(() => h.posts.some((p) => p.text.includes("approved & executed")));
    expect(h.posts.every((p) => p.channel === "C0" || p.channel === "C_ALERT")).toBe(true);
    await h.boot.service.stop();
  });

  test("isSenderMapped distinguishes enrolled from unmapped senders (Slice 6c intercept gate)", async () => {
    const h = await buildHarness();
    await h.boot.service.start();
    expect(await h.boot.isSenderMapped("slack", "U_BOB")).toBe(true);
    expect(await h.boot.isSenderMapped("slack", "U_EVE")).toBe(false);
    await h.boot.service.stop();
  });

  test("rpcCtx: status reflects transports; testParse parses a known write", async () => {
    const h = await buildHarness();
    expect(h.boot.rpcCtx.status().enabled).toBe(true);
    expect(h.boot.rpcCtx.status().platforms.map((p) => p.name)).toEqual(["slack"]);
    const parsed = h.boot.rpcCtx.testParse("run deployment.rollback service=payment-service") as {
      kind: string;
      actionType?: string;
    };
    expect(parsed.kind).toBe("write");
    expect(parsed.actionType).toBe("deployment.rollback");
  });

  test("teams surface: records the activity serviceUrl and threads it into replies", async () => {
    const h = await buildHarness({
      cfg: {
        enabled: true,
        slackEnabled: false,
        teamsEnabled: true,
        botVaultEntry: "chatops-bot",
        identityCacheTtlSeconds: 900,
        teamsBotAppId: "app-1",
      },
      policyGate: {
        enforced: () =>
          enforcedWith({
            "19:conv": { namespace: "project:pay", unmapped: "public-read", notify: [] },
          }),
      },
      validateTeamsJwt: (header) => Promise.resolve(header === "Bearer good"),
    });
    await h.boot.service.start();
    const surface = h.boot.teamsSurface;
    expect(surface).toBeDefined();
    expect(surface?.teamsBotAppId).toBe("app-1");
    expect(await surface?.validateBotJwt("Bearer bad", 0)).toBe(false);
    await surface?.onActivity({
      type: "message",
      id: "a1",
      serviceUrl: "https://smba.example/emea/",
      from: { id: "T_USER" },
      conversation: { id: "19:conv" },
      text: "<at>nimbus</at> what changed today?",
    });
    await until(() => h.posts.length === 1);
    expect(h.posts[0]?.platform).toBe("teams");
    expect(h.posts[0]?.channel).toBe("19:conv");
    expect(h.posts[0]?.serviceUrl).toBe("https://smba.example/emea/");
    await h.boot.service.stop();
  });

  test("teams surface is absent when no JWT validator is wired (fail-closed)", async () => {
    const h = await buildHarness({
      cfg: {
        enabled: true,
        slackEnabled: true,
        teamsEnabled: true,
        botVaultEntry: "chatops-bot",
        identityCacheTtlSeconds: 900,
        teamsBotAppId: "app-1",
      },
    });
    expect(h.boot.teamsSurface).toBeUndefined();
  });

  test("slack socket open with no url → fail-closed throw (never connects to a bogus endpoint)", async () => {
    // The slack transport's `openSocket` unwraps `slack_socket_open`; an empty url is rejected so
    // the adapter never opens a socket to a bogus endpoint.
    const h = await buildHarness({
      runTool: ((platform, toolId) => {
        if (toolId === "slack_socket_open") return Promise.resolve({ url: "" });
        throw new Error(`unexpected tool ${toolId} (${platform})`);
      }) as RunChatopsTool,
    });
    await expect(h.boot.service.start()).rejects.toThrow(/returned no socket url/);
    await h.boot.service.stop();
  });

  test("rpcCtx start/stop drive the underlying service lifecycle", async () => {
    const h = await buildHarness();
    await h.boot.rpcCtx.start();
    expect(h.boot.rpcCtx.status().platforms.map((p) => p.name)).toEqual(["slack"]);
    await h.boot.rpcCtx.stop();
    // After stop the slack socket adapter reports disconnected.
    expect(h.boot.rpcCtx.status().platforms[0]?.connected).toBe(false);
  });

  test("read before bindAskEngine → the default not-available placeholder is posted", async () => {
    // The askEngine local starts as a placeholder; a read that arrives before index.ts late-binds
    // the engine must still reply (with the placeholder) rather than throw.
    const socket = new FakeSocket();
    const posts: { channel: string; text: string }[] = [];
    const runTool: RunChatopsTool = (_p, toolId, args) => {
      if (toolId === "slack_socket_open") return Promise.resolve({ url: "wss://fake" });
      if (toolId === "slack_user_info") {
        const user = (args as { user: string }).user;
        const email = SLACK_EMAILS[user];
        return Promise.resolve(
          email === undefined ? { user: {} } : { user: { profile: { email } } },
        );
      }
      if (toolId === "slack_chat_post") {
        const a = args as { channel: string; text: string };
        posts.push({ channel: a.channel, text: a.text });
        return Promise.resolve({ ok: true });
      }
      throw new Error(`unexpected ${toolId}`);
    };
    const boot = await buildChatopsBoot({
      cfg: {
        enabled: true,
        slackEnabled: true,
        teamsEnabled: false,
        botVaultEntry: "chatops-bot",
        identityCacheTtlSeconds: 900,
        teamsBotAppId: "",
      },
      policyGate: {
        enforced: () =>
          enforcedWith({ C0: { namespace: "project:pay", unmapped: "refuse", notify: [] } }),
      },
      identity: { findScimByEmail: (email) => SCIM[email], isOperatorValid: () => true },
      runTool,
      db,
      vault,
      audit: { recordAudit: () => {} },
      dispatcher: { dispatch: () => Promise.resolve({}) },
      egressSink: NULL_EGRESS_SINK,
      socketFactory: () => socket,
      log: () => {},
    });
    // Intentionally NOT calling boot.bindAskEngine — exercise the default askEngine placeholder.
    await boot.service.start();
    socket.emit(mention("C0", "U_BOB", "@nimbus who is on call for payment-service?", "30"));
    await until(() => posts.length === 1);
    expect(posts[0]?.text).toContain("not available yet");
    await boot.service.stop();
  });

  test("local-consent fallback: a bound approver honors the non-delegate write (line 193)", async () => {
    // A non-owner click is not honored as a delegate (I20); the executor then falls back to the
    // bound local consent channel. Binding an approve-returning consent drives the dispatch.
    const h = await buildHarness();
    h.boot.bindLocalConsent(() => Promise.resolve(true));
    await h.boot.service.start();
    h.socket.emit(
      mention("C0", "U_BOB", "@nimbus run deployment.rollback service=payment-service", "31"),
    );
    await until(() => h.posts.some((p) => p.text.includes("Approval needed")));
    // bob (requester, not owner) approves → delegate refused → local fallback approves → dispatch.
    h.socket.emit(mention("C0", "U_BOB", "@nimbus approve", "32"));
    await until(() => h.dispatched.length === 1);
    expect(h.dispatched[0]?.type).toBe("deployment.rollback");
    expect(h.audits.find((a) => a.actionType === "deployment.rollback")?.hitlStatus).toBe(
      "approved",
    );
    await h.boot.service.stop();
  });

  test("I29 fix 3: a chatops-approved dispatch appends a real egress row, not a silent NULL sink", async () => {
    // ChatopsBootDeps.egressSink is now REQUIRED (dropped the `?? NULL_EGRESS_SINK` default) —
    // this proves the executor actually calls the sink it was handed, wired into a real dispatch.
    const h = await buildHarness();
    h.boot.bindLocalConsent(() => Promise.resolve(true));
    await h.boot.service.start();
    h.socket.emit(
      mention("C0", "U_BOB", "@nimbus run deployment.rollback service=payment-service", "31b"),
    );
    await until(() => h.posts.some((p) => p.text.includes("Approval needed")));
    h.socket.emit(mention("C0", "U_BOB", "@nimbus approve", "32b"));
    await until(() => h.dispatched.length === 1);
    expect(h.egressEntries).toHaveLength(1);
    expect(h.egressEntries[0]?.method).toBe("deployment.rollback");
    expect(h.egressEntries[0]?.resultStatus).toBe("authorized");
    // The actual I29 guarantee is ORDER, not just that both happened: append-before-dispatch.
    // Waiting on `h.dispatched.length === 1` alone (as the old version of this test did) passes
    // whether the append happened before OR after the dispatch — it can't detect a regression that
    // calls `dispatcher.dispatch()` before `egressSink.append()`. A single shared, order-preserving
    // log can: it must read exactly `["egress", "dispatch"]`, never the reverse.
    expect(h.order).toEqual(["egress", "dispatch"]);
    await h.boot.service.stop();
  });

  test("a reply through the booted chatops posts AND ledgers exactly one row", async () => {
    // Task 4: every outbound post now goes through `buildLedgeredChatPosts` (I29 `chatops`
    // class) rather than the raw connector post directly — a reply that previously left no
    // trace in the egress ledger now appends exactly one row before it posts.
    const h = await buildHarness();
    await h.boot.replyTo({ kind: "originating", platform: "slack", channelId: "C1" }, "hi");

    // The post half: exactly one post, to the expected channel — proved directly rather than
    // only indirectly via the harness's runTool throwing on an unexpected tool id.
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.channel).toBe("C1");

    // The ledger half.
    const rows = listEgress(db, { limit: 10 });
    expect(rows.length).toBe(1);
    expect(rows[0]?.sourceType).toBe("chatops");
    expect(rows[0]?.method).toBe("chatops.reply");
  });

  test("identity disabled (no identity dep) → isOperatorValid fallback is false (?? false)", async () => {
    // With `identity` absent the mapper resolves everyone unmapped AND the executor's
    // isOperatorValid seam returns the `?? false` fallback — a write can never be honored.
    // `identity` is omitted entirely (exactOptionalPropertyTypes forbids an explicit `undefined`).
    const socket = new FakeSocket();
    const dispatched: PlannedAction[] = [];
    const audits: Harness["audits"] = [];
    const runTool: RunChatopsTool = (_p, toolId, args) => {
      if (toolId === "slack_socket_open") return Promise.resolve({ url: "wss://fake" });
      if (toolId === "slack_user_info") {
        const user = (args as { user: string }).user;
        const email = SLACK_EMAILS[user];
        return Promise.resolve(
          email === undefined ? { user: {} } : { user: { profile: { email } } },
        );
      }
      if (toolId === "slack_chat_post") return Promise.resolve({ ok: true });
      throw new Error(`unexpected ${toolId}`);
    };
    const boot = await buildChatopsBoot({
      cfg: {
        enabled: true,
        slackEnabled: true,
        teamsEnabled: false,
        botVaultEntry: "chatops-bot",
        identityCacheTtlSeconds: 900,
        teamsBotAppId: "",
      },
      policyGate: {
        enforced: () =>
          enforcedWith({ C0: { namespace: "project:pay", unmapped: "refuse", notify: [] } }),
      },
      runTool,
      db,
      vault,
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
          return Promise.resolve({});
        },
      },
      egressSink: NULL_EGRESS_SINK,
      socketFactory: () => socket,
      log: () => {},
    });
    boot.bindAskEngine((q, ns) => Promise.resolve(`[${ns}] ${q}`));
    await boot.service.start();
    socket.emit(
      mention("C0", "U_BOB", "@nimbus run deployment.rollback service=payment-service", "33"),
    );
    // Unmapped requester under refuse mode → refusal, never a card / dispatch.
    await until(() => audits.some((a) => a.actionType === "chatops.refusal"));
    expect(dispatched).toHaveLength(0);
    await boot.service.stop();
  });

  test("user lookup throw is caught + logged → user treated as unmapped (line 169)", async () => {
    const logs: string[] = [];
    const h = await buildHarness({
      log: (m) => logs.push(m),
      runTool: ((_p, toolId) => {
        if (toolId === "slack_socket_open") return Promise.resolve({ url: "wss://fake" });
        if (toolId === "slack_user_info") return Promise.reject(new Error("rate limited"));
        if (toolId === "slack_chat_post") return Promise.resolve({ ok: true });
        throw new Error(`unexpected ${toolId}`);
      }) as RunChatopsTool,
    });
    await h.boot.service.start();
    h.socket.emit(mention("C0", "U_BOB", "@nimbus who is on call?", "34"));
    await until(() => logs.some((l) => l.includes("user lookup failed")));
    expect(logs.some((l) => l.includes("rate limited"))).toBe(true);
    await h.boot.service.stop();
  });

  test("user lookup returns a non-JSON content envelope → unwrap falls back to raw text (line 77)", async () => {
    // unwrapToolResult tries JSON.parse(textBlock.text); a non-JSON text body hits the catch and
    // returns the raw string, which emailFromUserInfo then reads as a non-object → unmapped.
    const h = await buildHarness({
      runTool: ((_p, toolId) => {
        if (toolId === "slack_socket_open") return Promise.resolve({ url: "wss://fake" });
        if (toolId === "slack_user_info") {
          return Promise.resolve({ content: [{ text: "this is not json" }] });
        }
        if (toolId === "slack_chat_post") return Promise.resolve({ ok: true });
        throw new Error(`unexpected ${toolId}`);
      }) as RunChatopsTool,
    });
    await h.boot.service.start();
    h.socket.emit(mention("C0", "U_BOB", "@nimbus who is on call?", "35"));
    // Non-JSON → raw string → not an object → emailless → unmapped → refusal under refuse mode.
    await until(() => h.audits.some((a) => a.actionType === "chatops.refusal"));
    expect(h.audits.map((a) => a.actionType)).toContain("chatops.refusal");
    await h.boot.service.stop();
  });

  test("teams onActivity without serviceUrl/conversationId → no serviceUrl recorded (lines 323-324)", async () => {
    const h = await buildHarness({
      cfg: {
        enabled: true,
        slackEnabled: false,
        teamsEnabled: true,
        botVaultEntry: "chatops-bot",
        identityCacheTtlSeconds: 900,
        teamsBotAppId: "app-1",
      },
      policyGate: {
        enforced: () =>
          enforcedWith({
            "19:conv": { namespace: "project:pay", unmapped: "public-read", notify: [] },
          }),
      },
      validateTeamsJwt: () => Promise.resolve(true),
    });
    await h.boot.service.start();
    const surface = h.boot.teamsSurface;
    expect(surface).toBeDefined();
    // An activity lacking serviceUrl (and one lacking conversation.id) must skip the map write but
    // still forward to the adapter — exercising the false side of the typeof guards.
    await surface?.onActivity({
      type: "message",
      id: "a0",
      from: { id: "T_USER" },
      conversation: { id: "19:conv" },
      text: "<at>nimbus</at> hi",
    });
    await surface?.onActivity({
      type: "message",
      id: "a1",
      serviceUrl: "https://smba.example/emea/",
      from: { id: "T_USER" },
      text: "<at>nimbus</at> hi",
    });
    // public-read namespace → a read reply still posts (default serviceUrl resolver returns none).
    await until(() => h.posts.length >= 1);
    await h.boot.service.stop();
  });

  test("user lookup tolerates an MCP content-envelope result (unwrapToolResult)", async () => {
    // Slack `users.info` can arrive wrapped in an MCP `{ content: [{ text: "<json>" }] }` envelope;
    // the boot must unwrap it before reading the profile email. A successful unwrap → mapped user →
    // engine answer posted (no refusal audit row).
    const localPosts: { channel: string; text: string }[] = [];
    const h = await buildHarness({
      runTool: ((_platform, toolId, args) => {
        if (toolId === "slack_socket_open") return Promise.resolve({ url: "wss://fake" });
        if (toolId === "slack_user_info") {
          const user = (args as { user: string }).user;
          const email = SLACK_EMAILS[user];
          return Promise.resolve({
            content: [
              {
                text: JSON.stringify(
                  email === undefined ? { user: {} } : { user: { profile: { email } } },
                ),
              },
            ],
          });
        }
        if (toolId === "slack_chat_post") {
          const a = args as { channel: string; text: string };
          localPosts.push({ channel: a.channel, text: a.text });
          return Promise.resolve({ ok: true });
        }
        throw new Error(`unexpected tool ${toolId}`);
      }) as RunChatopsTool,
    });
    await h.boot.service.start();
    h.socket.emit(mention("C0", "U_BOB", "@nimbus who is on call for payment-service?", "20"));
    await until(() => localPosts.length === 1);
    expect(localPosts[0]?.channel).toBe("C0");
    expect(h.audits.find((a) => a.actionType === "chatops.refusal")).toBeUndefined();
    await h.boot.service.stop();
  });

  test("a failed egress-ledger append on the reply post does not crash the process — logs at `error` instead (fix 4, design §13.1)", async () => {
    const logErrorCalls: { fields: Record<string, unknown>; msg: string }[] = [];
    const h = await buildHarness({
      logError: (fields, msg) => {
        logErrorCalls.push({ fields, msg });
      },
    });
    await h.boot.service.start();
    db.close(); // make the reply post's ledger append fail (mirrors chatops-egress.test.ts)
    // Before fix 4 this propagated all the way to the process's `unhandledRejection` handler and
    // took the whole gateway down — the crash trace fix 4's doc comment names. If the fix regresses,
    // this `emit` throws synchronously inside `FakeSocket.emit` (the un-awaited `void this.onFrame`
    // rejection surfaces there in bun:test) rather than merely timing out.
    h.socket.emit(mention("C0", "U_BOB", "@nimbus who is on call for payment-service?", "40"));
    await until(() => logErrorCalls.length === 1);
    // Fail-closed: the append happens BEFORE the post, so a failed append means nothing posted.
    expect(h.posts.length).toBe(0);
    expect(logErrorCalls[0]?.msg).toContain("egress ledger append failed");
    // Unhashed, per §13.1 — the log is not the ledger and carries a different threat model.
    expect(logErrorCalls[0]?.fields["channelId"]).toBe("C0");
    expect(logErrorCalls[0]?.fields["postKind"]).toBe("reply");
    expect(logErrorCalls[0]?.fields["platform"]).toBe("slack");
    expect(logErrorCalls[0]?.fields["err"]).toBeInstanceOf(Error);
    db = new Database(":memory:"); // so afterEach's close() is valid
    await h.boot.service.stop();
  });

  test("a failed approval-card append leaves no resolvable pending approval (regression: containment must not leave stale pending state)", async () => {
    // Fails exactly the FIRST `.run()` (the approval card's INSERT — nothing is posted before it
    // for a write command) and behaves normally after, so the SAME boot/db survives to prove what
    // happens to a later, unrelated message — unlike `db.close()`, which breaks every future
    // append and cannot show a "recovered" channel's behavior.
    let armed = true;
    const flakyDb = {
      query: (sql: string) => db.query(sql),
      run: (sql: string, params?: unknown[]) => {
        if (armed) {
          armed = false;
          throw new Error("simulated egress-ledger append failure");
        }
        return params === undefined ? db.run(sql) : db.run(sql, params as never);
      },
      exec: (sql: string) => db.exec(sql),
      close: () => db.close(),
    } as unknown as Database;

    const logErrorCalls: { fields: Record<string, unknown>; msg: string }[] = [];
    const h = await buildHarness({
      db: flakyDb,
      logError: (fields, msg) => {
        logErrorCalls.push({ fields, msg });
      },
    });
    await h.boot.service.start();
    h.socket.emit(
      mention(
        "C0",
        "U_BOB",
        "@nimbus run deployment.rollback service=payment-service version=v1.4",
        "50",
      ),
    );
    await until(() => logErrorCalls.length === 1);
    // Fail-closed: append-before-post means the owner was never shown a card.
    expect(logErrorCalls[0]?.fields["postKind"]).toBe("approvalCard");
    expect(h.posts.some((p) => p.text.includes("Approval needed"))).toBe(false);

    // The regression this guards against: before the fix, `pendingCardByChannel` still held the
    // entry set just before the failed post, so a mapped owner's "approve" for a card that was
    // never shown still found it "live" and silently resolved/consumed it there. That specific
    // write was always doomed regardless of this fix (the same `EgressAppendFailedError` also
    // propagates, uncaught, through `resolveDelegatedApproval`'s `requestRemote()` call and fails
    // THAT request closed before this second message is even sent) — so the connector
    // dispatcher's call count alone is zero in both the fixed and unfixed states and cannot, by
    // itself, distinguish them. The distinguishing, revert-sensitive signal is what happens to
    // the *second* message: unfixed, the stale entry makes it match the live-card branch and
    // return silently with no reply; fixed, it falls through to ordinary command routing (a plain
    // "read" query, since "approve" alone is not a `run …` command) and gets a normal reply.
    // Assert both: the safety invariant, and the discriminator that actually red-proves the fix.
    h.socket.emit(mention("C0", "U_ALICE", "@nimbus approve", "51"));
    await until(() => h.posts.some((p) => p.channel === "C0" && p.text.includes("approve")));
    expect(h.dispatched).toHaveLength(0); // the connector dispatcher's call count — the invariant

    await h.boot.service.stop();
  });
});

describe("emailFromUserInfo", () => {
  test("slack: reads user.profile.email; empty/missing → undefined", () => {
    expect(emailFromUserInfo("slack", { user: { profile: { email: "a@b.com" } } })).toBe("a@b.com");
    expect(emailFromUserInfo("slack", { user: { profile: { email: "" } } })).toBeUndefined();
    expect(emailFromUserInfo("slack", { user: {} })).toBeUndefined();
    expect(emailFromUserInfo("slack", null)).toBeUndefined();
    expect(emailFromUserInfo("slack", "not-an-object")).toBeUndefined();
  });

  test("teams: reads mail / userPrincipalName from the top object or items/value lists", () => {
    expect(emailFromUserInfo("teams", { mail: "t@b.com" })).toBe("t@b.com");
    expect(emailFromUserInfo("teams", { userPrincipalName: "upn@b.com" })).toBe("upn@b.com");
    expect(emailFromUserInfo("teams", { value: [{ mail: "v@b.com" }] })).toBe("v@b.com");
    expect(emailFromUserInfo("teams", { items: [{ userPrincipalName: "i@b.com" }] })).toBe(
      "i@b.com",
    );
    // Empty lists / no email anywhere → undefined.
    expect(emailFromUserInfo("teams", { value: [], items: [] })).toBeUndefined();
    expect(emailFromUserInfo("teams", { other: "x" })).toBeUndefined();
    expect(emailFromUserInfo("teams", undefined)).toBeUndefined();
  });
});
