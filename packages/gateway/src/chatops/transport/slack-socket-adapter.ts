import type { ChatMessage } from "../types.ts";
import type { ChatTransport } from "./transport.ts";

export function dedupeKey(channelId: string, ts: string): string {
  return `${channelId} ${ts}`;
}

/** Exponential backoff with deterministic jitter, capped at 60s. */
export function computeBackoffMs(attempt: number): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));
  // deterministic jitter by attempt index (no Math.random — see harness constraints)
  const jitter = (attempt % 5) * 100;
  return base + jitter;
}

/**
 * A bounded, insertion-ordered dedupe set (review S1). Caps memory regardless of uptime: on overflow
 * the oldest key is evicted (FIFO). Slack redelivers only recent events on reconnect, so a
 * 1000-key window comfortably covers the retry horizon; no time-based expiry is needed.
 */
export class BoundedDedupeSet {
  private readonly seen = new Set<string>();
  private readonly queue: string[] = [];
  constructor(private readonly max = 1000) {}

  /** Returns true if `key` is new (and records it); false if it was already seen. */
  add(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.queue.push(key);
    if (this.queue.length > this.max) {
      const evicted = this.queue.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    return true;
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  get size(): number {
    return this.seen.size;
  }
}

export class SlackEventNormalizer {
  normalize(frame: unknown): ChatMessage | undefined {
    if (frame === null || typeof frame !== "object") return undefined;
    const f = frame as Record<string, unknown>;
    if (f["type"] !== "events_api") return undefined;
    const payload = f["payload"] as Record<string, unknown> | undefined;
    const event = payload?.["event"] as Record<string, unknown> | undefined;
    if (event?.["type"] !== "app_mention") return undefined;
    const channel = event["channel"];
    const user = event["user"];
    const text = event["text"];
    const ts = event["ts"];
    if (
      typeof channel !== "string" ||
      typeof user !== "string" ||
      typeof text !== "string" ||
      typeof ts !== "string"
    ) {
      return undefined;
    }
    return { platform: "slack", channelId: channel, userId: user, text, ts };
  }
}

/** A minimal WebSocket-like seam so the adapter loop is unit-testable without a real socket. */
export interface SocketLike {
  onMessage(cb: (raw: string) => void): void;
  onClose(cb: () => void): void;
  send(raw: string): void;
  close(): void;
}

export interface SlackSocketDeps {
  /** Calls the connector `slack_socket_open` tool → `{ url }` (cloud call stays in the connector). */
  readonly openSocket: () => Promise<{ url: string }>;
  /** Opens a socket to `url`. Defaults to a Bun WebSocket wrapper; injected as a fake in tests. */
  readonly socketFactory: (url: string) => SocketLike;
  /** Schedule a reconnect attempt (injected in tests; defaults to setTimeout). */
  readonly scheduleReconnect?: (ms: number, fn: () => void) => void;
}

/**
 * Slack Socket Mode adapter (decision (b): adapter-owned WS; the connector provides a short-lived
 * `apps.connections.open` URL). Wires: open → normalize → dedupe → handler, with envelope acks and
 * reconnect/backoff. Cloud calls stay in the connector; only the socket lifecycle is here.
 */
export class SlackSocketAdapter implements ChatTransport {
  readonly platform = "slack" as const;
  private readonly dedupe = new BoundedDedupeSet();
  private readonly normalizer = new SlackEventNormalizer();
  private handler?: (m: ChatMessage) => Promise<void>;
  private socket: SocketLike | undefined;
  private stopped = false;
  private attempt = 0;

  constructor(private readonly deps: SlackSocketDeps) {}

  onMessage(handler: (m: ChatMessage) => Promise<void>): void {
    this.handler = handler;
  }

  connected(): boolean {
    return this.socket !== undefined && !this.stopped;
  }

  async start(): Promise<void> {
    this.stopped = false;
    const { url } = await this.deps.openSocket();
    const socket = this.deps.socketFactory(url);
    this.socket = socket;
    this.attempt = 0;
    socket.onMessage((raw) => {
      void this.onFrame(raw, socket);
    });
    socket.onClose(() => {
      this.socket = undefined;
      if (this.stopped) return;
      const delay = computeBackoffMs(this.attempt++);
      const schedule = this.deps.scheduleReconnect ?? ((ms, fn) => setTimeout(fn, ms));
      schedule(delay, () => {
        void this.start();
      });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.socket?.close();
    this.socket = undefined;
  }

  private async onFrame(raw: string, socket: SocketLike): Promise<void> {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    // Ack the envelope so Slack does not redeliver (Socket Mode requires an ack per envelope).
    if (frame !== null && typeof frame === "object") {
      const envelopeId = (frame as Record<string, unknown>)["envelope_id"];
      if (typeof envelopeId === "string") {
        socket.send(JSON.stringify({ envelope_id: envelopeId }));
      }
    }
    const msg = this.normalizer.normalize(frame);
    if (msg === undefined) return;
    if (!this.dedupe.add(dedupeKey(msg.channelId, msg.ts))) return; // already processed
    if (this.handler !== undefined) await this.handler(msg);
  }
}
