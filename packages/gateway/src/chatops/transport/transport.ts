import type { ChatMessage, ChatPlatform } from "../types.ts";

/** Transport-agnostic inbound seam: a platform adapter normalizes its wire format to ChatMessage. */
export interface ChatTransport {
  readonly platform: ChatPlatform;
  start(): Promise<void>;
  stop(): Promise<void>;
  connected(): boolean;
  /** Wire the inbound handler before start(). */
  onMessage(handler: (m: ChatMessage) => Promise<void>): void;
}
