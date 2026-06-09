import type { ChatMessage } from "../types.ts";
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
  return { platform: "teams", channelId, userId, text, ts: id };
}

/**
 * Teams transport is webhook-driven (push), not a held socket: Microsoft POSTs activities to the
 * I13 `/v1/messaging/teams/events` route, which (after Bot Framework JWT validation) calls
 * `onActivity`. `start()`/`stop()` just gate whether activities are dispatched.
 */
export class TeamsWebhookAdapter implements ChatTransport {
  readonly platform = "teams" as const;
  private handler?: (m: ChatMessage) => Promise<void>;
  private running = false;

  onMessage(handler: (m: ChatMessage) => Promise<void>): void {
    this.handler = handler;
  }

  connected(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  /** Called by the HTTP route after Bot Framework JWT validation. */
  async onActivity(activity: unknown): Promise<void> {
    if (!this.running) return;
    const msg = normalizeTeamsActivity(activity);
    if (msg === undefined) return;
    if (this.handler !== undefined) await this.handler(msg);
  }
}
