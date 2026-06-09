import { AsyncLocalStorage } from "node:async_hooks";

/** Per-write owner-routing context, set before `executor.gate()` and read by `requestRemote`. */
export interface ChatopsApprovalContext {
  readonly ownerEmail: string;
  readonly ownerExternalId: string;
  readonly originatingChannelId: string;
  readonly requesterExternalId: string;
  /** Human-readable action summary for the card. */
  readonly actionLabel: string;
}

const storage = new AsyncLocalStorage<ChatopsApprovalContext>();

export function runWithChatopsApprovalContext<T>(ctx: ChatopsApprovalContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getChatopsApprovalContext(): ChatopsApprovalContext | undefined {
  return storage.getStore();
}
