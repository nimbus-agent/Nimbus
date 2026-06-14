// Type-only module: NO executable runtime logic. It is exact-path-excluded from the coverage floor
// in scripts/coverage-floor/exclusions.ts (a type-only file emits no SF: lcov record). Adding runtime
// logic here would silently bypass the floor — put runtime logic in a separate, covered module.
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
