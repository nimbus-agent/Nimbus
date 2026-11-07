import type { ChatMessage } from "../types.ts";
import { BoundedDedupeSet } from "./slack-socket-adapter.ts";
import type { ChatTransport } from "./transport.ts";

export function normalizeTeamsActivity(activity: unknown): ChatMessage | undefined {
  if (activity === null || typeof activity !== "object") return undefined;
  const a = activity as Record<string, unknown>;
  if (a["type"] !== "message") return undefined;
  const from = a["from"] as Record<string, unknown> | undefined;
  const conv = a["conversation"] as Record<string, unknown> | undefined;
  const userId = from?.["id"];
  const channelId = conv?.["id"];
  const text = a["text"];
  const id = a["id"];
  if (
    typeof userId !== "string" ||
    typeof channelId !== "string" ||
    typeof text !== "string" ||
    typeof id !== "string"
  ) {
    return undefined;
  }
  // Teams webhooks deliver messages already routed to the bot (the bot is a conversation member),
  // so they're treated as addressed-to-bot — preserving today's command-routing behavior.
  return { platform: "teams", channelId, userId, text, ts: id, addressedToBot: true };
}

/** A typed-confirmation card submit (Phase 9.7 D0c): an Action.Submit of the Adaptive Card. */
export interface TeamsConfirmSubmit {
  readonly requestId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly approved: boolean;
  /** `value.typed` verbatim when it is a string, else the empty string. Never compared here (D41). */
  readonly typed: string;
}

/**
 * Pure parse of a Teams card submit: a `message` activity whose `value` object carries a string
 * `nimbusConfirm` (the request id) and a `verdict` of `approve` or `reject`. Such an activity
 * usually has no `text`, which is why `normalizeTeamsActivity` drops it. `undefined` otherwise.
 */
export function parseTeamsConfirmSubmit(activity: unknown): TeamsConfirmSubmit | undefined {
  if (activity === null || typeof activity !== "object") return undefined;
  const a = activity as Record<string, unknown>;
  if (a["type"] !== "message") return undefined;
  const value = a["value"];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const requestId = v["nimbusConfirm"];
  const verdict = v["verdict"];
  if (typeof requestId !== "string" || requestId === "") return undefined;
  if (verdict !== "approve" && verdict !== "reject") return undefined;
  const userId = (a["from"] as Record<string, unknown> | undefined)?.["id"];
  const conversationId = (a["conversation"] as Record<string, unknown> | undefined)?.["id"];
  if (typeof userId !== "string" || typeof conversationId !== "string") return undefined;
  return {
    requestId,
    userId,
    conversationId,
    approved: verdict === "approve",
    typed: typeof v["typed"] === "string" ? v["typed"] : "",
  };
}

/**
 * Teams transport is webhook-driven (push), not a held socket: Microsoft POSTs activities to the
 * I13 `/v1/messaging/teams/events` route, which (after Bot Framework JWT validation) calls
 * `onActivity`. `start()`/`stop()` just gate whether activities are dispatched.
 */
export class TeamsWebhookAdapter implements ChatTransport {
  readonly platform = "teams" as const;
  private handler?: (m: ChatMessage) => Promise<void>;
  private confirmHandler?: (s: TeamsConfirmSubmit) => Promise<void>;
  private readonly seenSubmits = new BoundedDedupeSet();
  private running = false;

  onMessage(handler: (m: ChatMessage) => Promise<void>): void {
    this.handler = handler;
  }

  /** Wire the typed-confirmation submit handler (Phase 9.7 D0c) before start(). */
  onConfirmSubmit(handler: (s: TeamsConfirmSubmit) => Promise<void>): void {
    this.confirmHandler = handler;
  }

  connected(): boolean {
    return this.running;
  }

  start(): Promise<void> {
    this.running = true;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.running = false;
    return Promise.resolve();
  }

  /** Called by the HTTP route after Bot Framework JWT validation. */
  async onActivity(activity: unknown): Promise<void> {
    if (!this.running) return;
    const submit = parseTeamsConfirmSubmit(activity);
    if (submit !== undefined) {
      // Deduped on the activity id: a redelivered submit must not reach the handler twice.
      const id = (activity as Record<string, unknown>)["id"];
      if (typeof id === "string" && !this.seenSubmits.add(id)) return;
      if (this.confirmHandler !== undefined) await this.confirmHandler(submit);
      return;
    }
    const msg = normalizeTeamsActivity(activity);
    if (msg === undefined) return;
    if (this.handler !== undefined) await this.handler(msg);
  }
}
