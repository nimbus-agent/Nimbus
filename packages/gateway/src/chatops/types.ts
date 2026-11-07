// packages/gateway/src/chatops/types.ts

/** Which chat platform a message arrived on. */
export type ChatPlatform = "slack" | "teams";

/** A normalized inbound message (after the transport adapter strips platform envelope). */
export interface ChatMessage {
  readonly platform: ChatPlatform;
  /** Platform channel id (Slack channel id / Teams conversation id). */
  readonly channelId: string;
  /** Platform-asserted (signature/connection-authenticated) user id - NEVER from message text. */
  readonly userId: string;
  /** Raw message text including the `@nimbus` mention. */
  readonly text: string;
  /** Platform message timestamp/id - used as the idempotency key with channelId. */
  readonly ts: string;
  /** true if the message @-mentions the bot (routes to IntentRouter); false = ambient (tribal-only). */
  readonly addressedToBot: boolean;
}

/** Result of parsing a message: either a free-form read, a structured write, or an agent command. */
export type ParsedCommand =
  | { readonly kind: "read"; readonly query: string }
  | {
      readonly kind: "write";
      /** The HITL action type, e.g. "deployment.rollback". */
      readonly actionType: string;
      /** Parsed `k=v` args. */
      readonly args: Readonly<Record<string, string>>;
      /** The resource the write targets (for owner resolution), e.g. "payment-service". */
      readonly resource: string;
    }
  | {
      readonly kind: "agent";
      /** The permitted agent name, e.g. "why". */
      readonly agent: string;
      /** Coerced `k=v` params — validated later by `dispatchAgentsRpc`, not here. */
      readonly params: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: "refused"; readonly reason: RefusalReason; readonly detail: string };

/** A resolved Nimbus identity for a chat user. */
export interface ChatIdentity {
  readonly externalId: string;
  readonly email: string;
  /** Issuer for the operator-validity check (I18). */
  readonly issuer: string;
}

/** Stable, server-derived reply destination (never a caller-supplied raw channel). */
export type ReplyTarget =
  | { readonly kind: "originating"; readonly platform: ChatPlatform; readonly channelId: string }
  | { readonly kind: "namespaceNotify"; readonly namespace: string };

export type RefusalReason =
  | "unbound_channel"
  | "unmapped_user"
  | "unknown_action"
  | "ambiguous_command"
  | "no_owner"
  | "ambiguous_owner"
  | "not_authorized"
  | "unknown_agent"
  | "bad_agent_params";

/**
 * The interactive part of an approval card (Phase 9.7 D0c). Built by `confirm-card.ts` from fixed
 * templates, never from caller data; the post adapter forwards each field verbatim as the
 * connector's `blocks` / `attachments` argument.
 */
export interface ChatCard {
  /** Slack Block Kit blocks (the post tool's `blocks` argument). */
  readonly slackBlocks?: readonly object[];
  /** One Teams attachment, `{contentType: "application/vnd.microsoft.card.adaptive", content}`. */
  readonly teamsAttachment?: object;
}
