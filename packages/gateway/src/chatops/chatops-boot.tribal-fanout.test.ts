import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import type { ChatopsChannelBinding } from "../policy/types.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { buildChatopsBoot } from "./chatops-boot.ts";
import type { RunChatopsTool } from "./chatops-tool-runner.ts";
import type { SocketLike } from "./transport/slack-socket-adapter.ts";
import type { ChatMessage } from "./types.ts";

/** Minimal in-memory NimbusVault (mirrors `chatops-boot.test.ts`'s `FakeVault`). */
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

const SLACK_EMAILS: Record<string, string> = { U_BOB: "bob@acme.com" };
const SCIM: Record<string, { externalId: string; email: string; active: boolean; issuer: string }> =
  { "bob@acme.com": { externalId: "ext-bob", email: "bob@acme.com", active: true, issuer: "idp" } };

function enforcedWith(channels: Record<string, ChatopsChannelBinding>): EnforcedPolicy {
  return {
    retentionDays: 30,
    hitlRequired: new Set<string>(),
    quorum: new Map(),
    capabilitiesDisabled: new Set(),
    chatops: {
      channels: new Map(Object.entries(channels)),
      ownership: new Map([["*", "oncall@acme.com"]]),
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

function slackEvent(event: Record<string, unknown>, ts: string): unknown {
  return { type: "events_api", envelope_id: `env-${ts}`, payload: { event } };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function buildBoot() {
  const socket = new FakeSocket();
  const inbound: ChatMessage[] = [];
  const posts: { channel: string; text: string }[] = [];
  const runTool: RunChatopsTool = (_p, toolId, args) => {
    if (toolId === "slack_socket_open") return Promise.resolve({ url: "wss://fake" });
    if (toolId === "slack_user_info") {
      const user = (args as { user: string }).user;
      const email = SLACK_EMAILS[user];
      return Promise.resolve(email === undefined ? { user: {} } : { user: { profile: { email } } });
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
        enforcedWith({ C0: { namespace: "project:pay", unmapped: "public-read", notify: [] } }),
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
    onInboundMessage: async (m) => void inbound.push(m),
  });
  boot.bindAskEngine((q, ns) => Promise.resolve(`[${ns}] ${q}`));
  return { socket, inbound, posts, boot };
}

describe("chatops Slice 6c fan-out seam (real buildChatopsBoot)", () => {
  test("ambient message: onInboundMessage fires but the IntentRouter does NOT (no post)", async () => {
    const h = await buildBoot();
    await h.boot.service.start();
    h.socket.emit(
      slackEvent(
        {
          type: "message",
          channel: "C0",
          user: "U_BOB",
          text: "how do I deploy the gateway?",
          ts: "1",
        },
        "1",
      ),
    );
    await until(() => h.inbound.length === 1);
    expect(h.inbound[0]?.addressedToBot).toBe(false);
    // stop() drains any in-flight handleMessage; the ambient path returns immediately after
    // onInboundMessage (no router call), so once drained an operational post can never appear.
    await h.boot.service.stop();
    expect(h.posts).toHaveLength(0);
  });

  test("addressed message: onInboundMessage fires AND the IntentRouter replies", async () => {
    const h = await buildBoot();
    await h.boot.service.start();
    h.socket.emit(
      slackEvent(
        {
          type: "app_mention",
          channel: "C0",
          user: "U_BOB",
          text: "@nimbus who is on call?",
          ts: "2",
        },
        "2",
      ),
    );
    await until(() => h.posts.length === 1);
    expect(h.inbound.some((m) => m.addressedToBot)).toBe(true);
    expect(h.posts[0]?.channel).toBe("C0");
    await h.boot.service.stop();
  });
});
