import { describe, expect, test } from "bun:test";
import { ChatopsService } from "./chatops-service.ts";
import type { ChatTransport } from "./transport/transport.ts";
import type { ChatMessage, ChatPlatform } from "./types.ts";

class FakeTransport implements ChatTransport {
  starts = 0;
  stops = 0;
  private up = false;
  private handler?: (m: ChatMessage) => Promise<void>;
  constructor(readonly platform: ChatPlatform) {}
  onMessage(h: (m: ChatMessage) => Promise<void>): void {
    this.handler = h;
  }
  connected(): boolean {
    return this.up;
  }
  async start(): Promise<void> {
    this.starts++;
    this.up = true;
  }
  async stop(): Promise<void> {
    this.stops++;
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
});
