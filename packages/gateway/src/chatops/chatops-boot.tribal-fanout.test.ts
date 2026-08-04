import { describe, expect, test } from "bun:test";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import type { ChatopsChannelBinding } from "../policy/types.ts";
import { buildChatopsBoot } from "./chatops-boot.ts";
import type { RunChatopsTool } from "./chatops-tool-runner.ts";
import type { SocketLike } from "./transport/slack-socket-adapter.ts";
import type { ChatMessage } from "./types.ts";

const SLACK_EMAILS: Record<string, string> = { U_BOB: "bob@acme.com" };
const SCIM: Record<string, { externalId: string; email: string; active: boolean; issuer: string }> =
  { "bob@acme.com": { externalId: "ext-bob", email: "bob@acme.com", active: true, issuer: "idp" } };

function enforcedWith(channels: Record<string, ChatopsChannelBinding>): EnforcedPolicy {
  return {
    retentionDays: 30,
    hitlRequired: new Set<string>(),
    quorum: new Map(),
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

function buildBoot() {
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
  const boot = buildChatopsBoot({
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
    const h = buildBoot();
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
    const h = buildBoot();
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
