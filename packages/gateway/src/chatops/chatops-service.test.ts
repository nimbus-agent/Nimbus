import { describe, expect, test } from "bun:test";
import { ChatopsService } from "./chatops-service.ts";
import type { ChatTransport } from "./transport/transport.ts";
import type { ChatMessage, ChatPlatform } from "./types.ts";

class FakeTransport implements ChatTransport {
  starts = 0;
  stops = 0;
  private up = false;
  private handler?: (m: ChatMessage) => Promise<void>;
  constructor(
    readonly platform: ChatPlatform,
    /** A lifecycle step that REJECTS (after counting the call) instead of succeeding. */
    private readonly failures: { readonly start?: Error; readonly stop?: Error } = {},
  ) {}
  onMessage(h: (m: ChatMessage) => Promise<void>): void {
    this.handler = h;
  }
  connected(): boolean {
    return this.up;
  }
  async start(): Promise<void> {
    this.starts++;
    if (this.failures.start !== undefined) throw this.failures.start;
    this.up = true;
  }
  async stop(): Promise<void> {
    this.stops++;
    if (this.failures.stop !== undefined) throw this.failures.stop;
    this.up = false;
  }
  async deliver(m: ChatMessage): Promise<void> {
    await this.handler?.(m);
  }
}

function makeService() {
  const slack = new FakeTransport("slack");
  const teams = new FakeTransport("teams");
  const handled: ChatMessage[] = [];
  const svc = new ChatopsService({
    enabled: true,
    transports: [slack, teams],
    handleMessage: async (m) => {
      handled.push(m);
    },
    channelsForPlatform: (p) => (p === "slack" ? 2 : 1),
    testParse: (text) => ({ kind: "read", query: text }),
    nowMs: () => 4_242,
  });
  return { svc, slack, teams, handled };
}

function serviceWith(transports: readonly ChatTransport[]): ChatopsService {
  return new ChatopsService({
    enabled: true,
    transports,
    handleMessage: async () => {},
    channelsForPlatform: () => 0,
    testParse: (text) => ({ kind: "read", query: text }),
  });
}

const msg: ChatMessage = {
  platform: "slack",
  channelId: "C1",
  userId: "U1",
  text: "@nimbus hi",
  ts: "1.1",
  addressedToBot: true,
};

describe("ChatopsService", () => {
  test("status reflects transport connected() + channel counts", async () => {
    const { svc, slack } = makeService();
    let s = svc.status();
    expect(s.enabled).toBe(true);
    expect(s.platforms).toEqual([
      { name: "slack", connected: false, channels: 2 },
      { name: "teams", connected: false, channels: 1 },
    ]);
    expect(s.lastEventAt).toBeUndefined();

    await svc.start();
    s = svc.status();
    expect(s.platforms[0]?.connected).toBe(true);
    expect(slack.connected()).toBe(true);
  });

  test("start()/stop() call each transport once", async () => {
    const { svc, slack, teams } = makeService();
    await svc.start();
    await svc.start(); // idempotent
    expect(slack.starts).toBe(1);
    expect(teams.starts).toBe(1);
    await svc.stop();
    expect(slack.stops).toBe(1);
    expect(teams.stops).toBe(1);
  });

  test("delivered message reaches handleMessage and stamps lastEventAt", async () => {
    const { svc, slack, handled } = makeService();
    await svc.start();
    await slack.deliver(msg);
    expect(handled).toEqual([msg]);
    expect(svc.status().lastEventAt).toBe(4_242);
  });

  test("testParse delegates", () => {
    const { svc } = makeService();
    expect(svc.testParse("who's on call?")).toEqual({ kind: "read", query: "who's on call?" });
  });

  // start() is sequential on purpose (the S9382 suppression on its loop): a concurrent start would
  // bring a later transport live even though start() reports failure.
  test("start() fails fast: a failed start keeps later transports from starting", async () => {
    const slack = new FakeTransport("slack", { start: new Error("socket open failed") });
    const teams = new FakeTransport("teams");
    const svc = serviceWith([slack, teams]);
    await expect(svc.start()).rejects.toThrow("socket open failed");
    expect(slack.starts).toBe(1);
    expect(teams.starts).toBe(0);
    expect(teams.connected()).toBe(false);
  });

  // stop() is concurrent on purpose: a transport that fails to stop must not leave the others
  // running, and the failure is still reported.
  test("stop() stops every transport even if an earlier one fails, and rejects", async () => {
    const slack = new FakeTransport("slack", { stop: new Error("close failed") });
    const teams = new FakeTransport("teams");
    const svc = serviceWith([slack, teams]);
    await svc.start();
    await expect(svc.stop()).rejects.toThrow("close failed");
    expect(slack.stops).toBe(1);
    expect(teams.stops).toBe(1);
    expect(teams.connected()).toBe(false);
  });
});
