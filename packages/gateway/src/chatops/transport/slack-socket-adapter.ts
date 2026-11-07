import {
  SLACK_CONFIRM_BLOCK_ID,
  SLACK_CONFIRM_CALLBACK_ID,
  SLACK_CONFIRM_INPUT_ACTION_ID,
  SLACK_CONFIRM_OPEN_ACTION,
  SLACK_CONFIRM_REJECT_ACTION,
} from "../confirm-card.ts";
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
    const eventType = event?.["type"];
    // Accept @-mentions (→ commands) and plain channel messages (→ ambient tribal-only). A
    // `message` with a subtype (e.g. bot_message/message_changed) or a bot_id is the bot's own
    // post or an edit — never ingest it (review §1.1 feedback-loop guard).
    if (eventType !== "app_mention" && eventType !== "message") return undefined;
    if (
      eventType === "message" &&
      (event?.["subtype"] !== undefined || event?.["bot_id"] !== undefined)
    ) {
      return undefined;
    }
    const channel = event?.["channel"];
    const user = event?.["user"];
    const text = event?.["text"];
    const ts = event?.["ts"];
    if (typeof channel !== "string" || typeof text !== "string" || typeof ts !== "string") {
      return undefined;
    }
    return {
      platform: "slack",
      channelId: channel,
      userId: typeof user === "string" ? user : "",
      text,
      ts,
      addressedToBot: eventType === "app_mention",
    };
  }
}

/** An interactive Slack envelope the typed-confirmation flow cares about (Phase 9.7 D0c). */
export type SlackInteractive =
  | {
      readonly kind: "open";
      readonly requestId: string;
      readonly userId: string;
      readonly triggerId: string;
    }
  | { readonly kind: "reject"; readonly requestId: string; readonly userId: string }
  | {
      readonly kind: "submit";
      readonly requestId: string;
      readonly userId: string;
      /** Verbatim from the input block; absent when the payload carried no string value. */
      readonly typed?: string;
    };

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Pure parse of a Socket Mode `interactive` envelope into the three confirm events; `undefined` for
 * anything else or for a frame with a missing or mistyped field. The user id is the connection-
 * authenticated `payload.user.id`, never text. `typed` is read from the input block's `value` and
 * passed on verbatim: nothing here trims, normalises or compares it (static D41).
 */
export function parseSlackInteractive(frame: unknown): SlackInteractive | undefined {
  const f = rec(frame);
  if (f?.["type"] !== "interactive") return undefined;
  const payload = rec(f["payload"]);
  if (payload === undefined) return undefined;
  const userId = nonEmptyString(rec(payload["user"])?.["id"]);
  if (userId === undefined) return undefined;
  if (payload["type"] === "block_actions") return parseBlockActions(payload, userId);
  if (payload["type"] === "view_submission") return parseViewSubmission(payload, userId);
  return undefined;
}

/** A Confirm or Reject button click on the confirm card. */
function parseBlockActions(
  payload: Record<string, unknown>,
  userId: string,
): SlackInteractive | undefined {
  const actions = payload["actions"];
  const first = Array.isArray(actions) ? rec(actions[0]) : undefined;
  const requestId = nonEmptyString(first?.["value"]);
  if (requestId === undefined) return undefined;
  if (first?.["action_id"] === SLACK_CONFIRM_REJECT_ACTION) {
    return { kind: "reject", requestId, userId };
  }
  if (first?.["action_id"] !== SLACK_CONFIRM_OPEN_ACTION) return undefined;
  const triggerId = nonEmptyString(payload["trigger_id"]);
  return triggerId === undefined ? undefined : { kind: "open", requestId, userId, triggerId };
}

/** The confirm modal's submission; `typed` is passed on verbatim (static D41). */
function parseViewSubmission(
  payload: Record<string, unknown>,
  userId: string,
): SlackInteractive | undefined {
  const view = rec(payload["view"]);
  if (view?.["callback_id"] !== SLACK_CONFIRM_CALLBACK_ID) return undefined;
  const requestId = nonEmptyString(view["private_metadata"]);
  if (requestId === undefined) return undefined;
  const values = rec(rec(view["state"])?.["values"]);
  const input = rec(rec(values?.[SLACK_CONFIRM_BLOCK_ID])?.[SLACK_CONFIRM_INPUT_ACTION_ID]);
  if (input === undefined) return undefined;
  const value = input["value"];
  return {
    kind: "submit",
    requestId,
    userId,
    ...(typeof value === "string" ? { typed: value } : {}),
  };
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
  private interactiveHandler?: (i: SlackInteractive) => Promise<void>;
  private socket: SocketLike | undefined;
  private stopped = false;
  private attempt = 0;

  constructor(private readonly deps: SlackSocketDeps) {}

  onMessage(handler: (m: ChatMessage) => Promise<void>): void {
    this.handler = handler;
  }

  /** Wire the typed-confirmation handler (Phase 9.7 D0c) before start(). */
  onInteractive(handler: (i: SlackInteractive) => Promise<void>): void {
    this.interactiveHandler = handler;
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

  stop(): Promise<void> {
    // Nothing here awaits, but `close()` is the injected socket's and may throw: `Promise.try`
    // keeps that a rejection for the caller, exactly as it was when this method was `async`.
    return Promise.try(() => {
      this.stopped = true;
      this.socket?.close();
      this.socket = undefined;
    });
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
    const interactive = parseSlackInteractive(frame);
    if (interactive !== undefined) {
      // Deduped by envelope id (a distinct key prefix): Slack redelivers an unacked envelope.
      const envelopeId = (frame as Record<string, unknown>)["envelope_id"];
      if (typeof envelopeId === "string" && !this.dedupe.add(`interactive ${envelopeId}`)) return;
      if (this.interactiveHandler !== undefined) await this.interactiveHandler(interactive);
      return;
    }
    const msg = this.normalizer.normalize(frame);
    if (msg === undefined) return;
    if (!this.dedupe.add(dedupeKey(msg.channelId, msg.ts))) return; // already processed
    if (this.handler !== undefined) await this.handler(msg);
  }
}
