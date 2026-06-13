import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../types.ts";
import {
  BoundedDedupeSet,
  computeBackoffMs,
  dedupeKey,
  SlackEventNormalizer,
  SlackSocketAdapter,
  type SocketLike,
} from "./slack-socket-adapter.ts";

describe("Slack adapter helpers", () => {
  test("normalizes a message event to a ChatMessage", () => {
    const n = new SlackEventNormalizer();
    const m = n.normalize({
      type: "events_api",
      payload: {
        event: { type: "app_mention", channel: "C1", user: "U1", text: "<@U0> hi", ts: "1.2" },
      },
    });
    expect(m).toEqual({
      platform: "slack",
      channelId: "C1",
      userId: "U1",
      text: "<@U0> hi",
      ts: "1.2",
      addressedToBot: true,
    });
  });

  test("plain channel message → ChatMessage with addressedToBot=false", () => {
    const n = new SlackEventNormalizer();
    const m = n.normalize({
      type: "events_api",
      payload: {
        event: { type: "message", channel: "C1", user: "U1", text: "how do I deploy?", ts: "1.2" },
      },
    });
    expect(m).toEqual({
      platform: "slack",
      channelId: "C1",
      userId: "U1",
      text: "how do I deploy?",
      ts: "1.2",
      addressedToBot: false,
    });
  });

  test("app_mention → addressedToBot=true", () => {
    const n = new SlackEventNormalizer();
    const m = n.normalize({
      type: "events_api",
      payload: {
        event: { type: "app_mention", channel: "C1", user: "U1", text: "<@B> hi", ts: "1.3" },
      },
    });
    expect(m?.addressedToBot).toBe(true);
  });

  test("bot/subtype messages are skipped (feedback-loop guard)", () => {
    const n = new SlackEventNormalizer();
    expect(
      n.normalize({
        type: "events_api",
        payload: {
          event: { type: "message", subtype: "bot_message", channel: "C1", text: "x", ts: "1" },
        },
      }),
    ).toBeUndefined();
    expect(
      n.normalize({
        type: "events_api",
        payload: { event: { type: "message", bot_id: "B9", channel: "C1", text: "x", ts: "1" } },
      }),
    ).toBeUndefined();
  });

  test("non-message/mention events normalize to undefined", () => {
    const n = new SlackEventNormalizer();
    expect(n.normalize({ type: "hello" })).toBeUndefined();
    expect(n.normalize(null)).toBeUndefined();
    // a `message` event missing text → undefined (type-guard short-circuit)
    expect(
      n.normalize({ type: "events_api", payload: { event: { type: "message", channel: "C1" } } }),
    ).toBeUndefined();
    // an unrelated event type (reaction_added) → undefined
    expect(
      n.normalize({
        type: "events_api",
        payload: { event: { type: "reaction_added", channel: "C1", text: "x", ts: "1" } },
      }),
    ).toBeUndefined();
  });

  test("app_mention with a non-string field normalizes to undefined (type-guard short-circuit)", () => {
    const n = new SlackEventNormalizer();
    // channel present but not a string → the `||` guard returns undefined
    expect(
      n.normalize({
        type: "events_api",
        payload: { event: { type: "app_mention", channel: 42, user: "U1", text: "hi", ts: "1.2" } },
      }),
    ).toBeUndefined();
    // ts missing → also undefined
    expect(
      n.normalize({
        type: "events_api",
        payload: { event: { type: "app_mention", channel: "C1", user: "U1", text: "hi" } },
      }),
    ).toBeUndefined();
  });

  test("dedupeKey is stable for (channel, ts)", () => {
    expect(dedupeKey("C1", "1.2")).toBe(dedupeKey("C1", "1.2"));
    expect(dedupeKey("C1", "1.2")).not.toBe(dedupeKey("C1", "1.3"));
  });

  test("backoff grows then caps", () => {
    expect(computeBackoffMs(0)).toBeLessThan(computeBackoffMs(3));
    expect(computeBackoffMs(100)).toBeLessThanOrEqual(60_000 + 400);
    expect(computeBackoffMs(100)).toBeGreaterThanOrEqual(60_000);
  });
});

describe("BoundedDedupeSet (review S1)", () => {
  test("inserting max+1 distinct keys evicts the oldest", () => {
    const set = new BoundedDedupeSet(1000);
    for (let i = 0; i < 1000; i++) expect(set.add(`k${i}`)).toBe(true);
    expect(set.add("k0")).toBe(false); // still present (oldest live key)
    expect(set.add("k1000")).toBe(true); // overflow → evicts the oldest key (k0)
    expect(set.size).toBe(1000);
    expect(set.add("k0")).toBe(true); // k0 was evicted → re-processable
    expect(set.add("k1000")).toBe(false); // k1000 still deduped
  });
});

class FakeSocket implements SocketLike {
  msgCb?: (raw: string) => void;
  closeCb?: () => void;
  readonly sent: string[] = [];
  closed = false;
  onMessage(cb: (raw: string) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  send(raw: string): void {
    this.sent.push(raw);
  }
  close(): void {
    this.closed = true;
  }
  emit(raw: string): void {
    this.msgCb?.(raw);
  }
}

function appMentionFrame(envelopeId: string, ts: string): string {
  return JSON.stringify({
    type: "events_api",
    envelope_id: envelopeId,
    payload: { event: { type: "app_mention", channel: "C1", user: "U1", text: "<@U0> hi", ts } },
  });
}

describe("SlackSocketAdapter", () => {
  test("open → ack envelope → normalize → dedupe → handler", async () => {
    const sock = new FakeSocket();
    const got: ChatMessage[] = [];
    const adapter = new SlackSocketAdapter({
      openSocket: async () => ({ url: "wss://example/socket" }),
      socketFactory: () => sock,
    });
    adapter.onMessage(async (m) => {
      got.push(m);
    });
    await adapter.start();
    expect(adapter.connected()).toBe(true);

    sock.emit(appMentionFrame("env-1", "1.2"));
    await Promise.resolve();
    expect(sock.sent).toEqual([JSON.stringify({ envelope_id: "env-1" })]);
    expect(got).toHaveLength(1);

    // duplicate (same channel+ts) is acked but not re-handled
    sock.emit(appMentionFrame("env-2", "1.2"));
    await Promise.resolve();
    expect(got).toHaveLength(1);

    await adapter.stop();
    expect(adapter.connected()).toBe(false);
    expect(sock.closed).toBe(true);
  });

  test("malformed JSON frame is ignored (no throw)", async () => {
    const sock = new FakeSocket();
    const adapter = new SlackSocketAdapter({
      openSocket: async () => ({ url: "wss://x" }),
      socketFactory: () => sock,
    });
    adapter.onMessage(async () => {});
    await adapter.start();
    sock.emit("not json");
    await Promise.resolve();
    expect(sock.sent).toEqual([]);
  });

  test("a non-object JSON frame is not acked and does not throw", async () => {
    const sock = new FakeSocket();
    const adapter = new SlackSocketAdapter({
      openSocket: async () => ({ url: "wss://x" }),
      socketFactory: () => sock,
    });
    adapter.onMessage(async () => {});
    await adapter.start();
    // valid JSON but not an object → skips the ack block (frame === object guard false)
    sock.emit("123");
    await Promise.resolve();
    expect(sock.sent).toEqual([]);
    await adapter.stop();
  });

  test("an object frame without envelope_id is processed but not acked", async () => {
    const sock = new FakeSocket();
    const got: ChatMessage[] = [];
    const adapter = new SlackSocketAdapter({
      openSocket: async () => ({ url: "wss://x" }),
      socketFactory: () => sock,
    });
    adapter.onMessage(async (m) => {
      got.push(m);
    });
    await adapter.start();
    // app_mention with no envelope_id → no ack (typeof envelopeId !== "string"), still handled
    sock.emit(
      JSON.stringify({
        type: "events_api",
        payload: {
          event: { type: "app_mention", channel: "C1", user: "U1", text: "hi", ts: "1.9" },
        },
      }),
    );
    await Promise.resolve();
    expect(sock.sent).toEqual([]);
    expect(got).toHaveLength(1);
    await adapter.stop();
  });

  test("a non-mention frame is acked but yields no handler call (msg undefined)", async () => {
    const sock = new FakeSocket();
    const got: ChatMessage[] = [];
    const adapter = new SlackSocketAdapter({
      openSocket: async () => ({ url: "wss://x" }),
      socketFactory: () => sock,
    });
    adapter.onMessage(async (m) => {
      got.push(m);
    });
    await adapter.start();
    sock.emit(JSON.stringify({ type: "events_api", envelope_id: "e1", payload: {} }));
    await Promise.resolve();
    expect(sock.sent).toEqual([JSON.stringify({ envelope_id: "e1" })]);
    expect(got).toHaveLength(0);
    await adapter.stop();
  });

  test("a valid mention with no handler registered is deduped without throwing", async () => {
    const sock = new FakeSocket();
    // intentionally do NOT call adapter.onMessage → this.handler stays undefined
    const adapter = new SlackSocketAdapter({
      openSocket: async () => ({ url: "wss://x" }),
      socketFactory: () => sock,
    });
    await adapter.start();
    sock.emit(appMentionFrame("e2", "2.0"));
    await Promise.resolve();
    expect(sock.sent).toEqual([JSON.stringify({ envelope_id: "e2" })]);
    await adapter.stop();
  });

  test("onClose after stop() does not schedule a reconnect", async () => {
    let scheduled = 0;
    const sock = new FakeSocket();
    const adapter = new SlackSocketAdapter({
      openSocket: async () => ({ url: "wss://x" }),
      socketFactory: () => sock,
      scheduleReconnect: (_ms, fn) => {
        scheduled++;
        fn();
      },
    });
    adapter.onMessage(async () => {});
    await adapter.start();
    await adapter.stop(); // sets stopped = true
    sock.closeCb?.(); // close arriving after stop → the `if (this.stopped) return` guard
    await Promise.resolve();
    expect(scheduled).toBe(0);
  });

  test("close schedules a reconnect via the injected scheduler", async () => {
    let scheduled = 0;
    const sockets: FakeSocket[] = [];
    const adapter = new SlackSocketAdapter({
      openSocket: async () => ({ url: "wss://x" }),
      socketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      scheduleReconnect: (_ms, fn) => {
        scheduled++;
        fn();
      },
    });
    adapter.onMessage(async () => {});
    await adapter.start();
    sockets[0]?.closeCb?.();
    await Promise.resolve();
    expect(scheduled).toBe(1);
    expect(sockets.length).toBe(2); // reconnected
    await adapter.stop();
  });
});
