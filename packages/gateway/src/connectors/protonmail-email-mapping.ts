import { type ImapMessageInput, mapImapLikeMessageToItem } from "./imap-email-mapping.ts";
import type { MappedRow } from "./mapped-row.ts";

/**
 * ProtonMail (via ProtonMail Bridge) speaks plain IMAP/SMTP on the loopback
 * interface, so it reuses the IMAP message-input shape ({@link ImapMessageInput})
 * and the {@link imapExternalId} helper — the only difference from `imap:email`
 * is the service literal. HEADERS + capped PREVIEW + attachment METADATA only;
 * NEVER attachment bytes or a full body.
 */
export type ProtonmailMappedRow = MappedRow<"protonmail", "email">;
export type { ImapMessageInput as ProtonmailMessageInput } from "./imap-email-mapping.ts";

export interface ProtonmailMappingContext {
  readonly syncedAt: number;
}

/**
 * Pure mapper: a ProtonMail-Bridge IMAP message view → a `protonmail:email`
 * IndexedItem. ProtonMail Bridge speaks plain IMAP, so this is the shared IMAP
 * mapper core ({@link mapImapLikeMessageToItem}) with the `protonmail` service
 * literal. Stores HEADERS + capped PREVIEW + attachment METADATA only; returns
 * null when the message carries no id basis.
 */
export function mapProtonmailEmailToItem(
  input: ImapMessageInput,
  ctx: ProtonmailMappingContext,
): ProtonmailMappedRow | null {
  return mapImapLikeMessageToItem("protonmail", input, ctx);
}
