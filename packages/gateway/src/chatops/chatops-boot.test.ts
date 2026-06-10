import { describe, expect, test } from "bun:test";
import type { PlannedAction } from "../engine/types.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import type { ChatopsChannelBinding } from "../policy/types.ts";
import { buildChatopsBoot, type ChatopsBootDeps } from "./chatops-boot.ts";
import type { RunChatopsTool } from "./chatops-tool-runner.ts";
import type { SocketLike } from "./transport/slack-socket-adapter.ts";

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
  boot: ReturnType<typeof buildChatopsBoot>;
}

function buildHarness(overrides?: Partial<ChatopsBootDeps>): Harness {
  const socket = new FakeSocket();
  const posts: Harness["posts"] = [];
  const dispatched: PlannedAction[] = [];
  const audits: Harness["audits"] = [];

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
    socketFactory: () => socket,
    log: () => {},
    ...overrides,
  };

  const boot = buildChatopsBoot(deps);
  boot.bindAskEngine((query, namespace) =>
    Promise.resolve(`[${namespace}] answer to: ${query} → oncall = alice`),
  );
  return { socket, posts, dispatched, audits, boot };
}

describe("buildChatopsBoot — full production graph", () => {
  test("read: mapped user gets an engine answer in the originating channel", async () => {
    const h = buildHarness();
    await h.boot.service.start();
    h.socket.emit(mention("C0", "U_BOB", "@nimbus who is on call for payment-service?", "1"));
    await until(() => h.posts.length === 1);
    expect(h.posts[0]?.channel).toBe("C0");
    expect(h.posts[0]?.text).toContain("project:pay");
    expect(h.posts[0]?.text).toContain("oncall = alice");
    await h.boot.service.stop();
  });

  test("write: owner-routed card → owner approves → dispatched + audit approved", async () => {
    const h = buildHarness();
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
    const h = buildHarness();
    await h.boot.service.start();
    h.socket.emit(
      mention("C0", "U_BOB", "@nimbus run deployment.rollback service=payment-service", "4"),
    );
    await until(() => h.posts.some((p) => p.text.includes("Approval needed")));
    h.socket.emit(mention("C0", "U_ALICE", "@nimbus reject", "5"));
    await until(() => h.audits.some((a) => a.actionType === "deployment.rollback"));
    expect(h.dispatched.length).toBe(0);
    expect(h.audits.find((a) => a.actionType === "deployment.rollback")?.hitlStatus).toBe(
      "rejected",
    );
    await until(() => h.posts.some((p) => p.text.includes("rejected")));
    await h.boot.service.stop();
  });

  test("write: NON-owner approve click is not honored (I20) → falls back + rejects fail-closed", async () => {
    const h = buildHarness();
    await h.boot.service.start();
    h.socket.emit(
      mention("C0", "U_BOB", "@nimbus run deployment.rollback service=payment-service", "6"),
    );
    await until(() => h.posts.some((p) => p.text.includes("Approval needed")));
    // bob (requester, not the owner) clicks approve — I20 must refuse to honor it and the
    // default local-consent fallback (no approver bound) fails closed.
    h.socket.emit(mention("C0", "U_BOB", "@nimbus approve", "7"));
    await until(() => h.audits.some((a) => a.actionType === "deployment.rollback"));
    expect(h.dispatched.length).toBe(0);
    expect(h.audits.find((a) => a.actionType === "deployment.rollback")?.hitlStatus).toBe(
      "rejected",
    );
    await h.boot.service.stop();
  });

  test("unmapped user under refuse mode → refusal reply + refusal audit row", async () => {
    const h = buildHarness();
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
    const h = buildHarness();
    await h.boot.service.start();
    h.socket.emit(mention("C_UNBOUND", "U_BOB", "@nimbus hello", "9"));
    // Give the pipeline a beat; nothing may be posted or audited.
    await new Promise((r) => setTimeout(r, 50));
    expect(h.posts.length).toBe(0);
    expect(h.audits.length).toBe(0);
    await h.boot.service.stop();
  });

  test("I23: every operational post lands in the originating channel or a policy notify channel", async () => {
    const h = buildHarness();
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

  test("rpcCtx: status reflects transports; testParse parses a known write", async () => {
    const h = buildHarness();
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
    const h = buildHarness({
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

  test("teams surface is absent when no JWT validator is wired (fail-closed)", () => {
    const h = buildHarness({
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
});
