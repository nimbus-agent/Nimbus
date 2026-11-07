// packages/gateway/src/connectors/connector-writes/model-offerable.ts
import type { ConnectorWriteRow } from "./types.ts";

/**
 * Owner ruling OR-W34-1 (spec § 15, 2026-11-06; OR-B3w-1 for Outlook): no mail send is ever offered
 * to the model, whatever template or reader it later gets. The model writes drafts; the owner
 * sends. Keyed by tool id, a row's identity. The sends stay reachable on the other doors.
 */
export const MODEL_NEVER_OFFERED_TOOL_IDS: ReadonlySet<string> = Object.freeze(
  new Set([
    "gmail_message_send",
    "gmail_draft_send",
    "fastmail_mail_send",
    "imap_mail_send",
    "protonmail_mail_send",
    "apple_mail_send",
    "outlook_mail_send",
  ]),
);

/**
 * M1: whether the MODEL may be offered this write now. A row in {@link MODEL_NEVER_OFFERED_TOOL_IDS}
 * never is. Otherwise the row must have a typed preview template AND (be in wave 2-3, or have a
 * `before` reader OR a `bound` prepare step, AND a `confirm` target: spec § 5.4 makes the current
 * state mandatory on a wave-4 prompt, a bound write's prepared facts stand in for it, and § 15.4
 * makes type-to-confirm mandatory on every door). The door's
 * listing, its per-call recheck, `status` and the enable prompt all use this one function.
 */
export function isModelOfferableRow(row: ConnectorWriteRow): boolean {
  if (MODEL_NEVER_OFFERED_TOOL_IDS.has(row.toolId)) return false;
  return (
    row.preview !== undefined &&
    (row.wave < 4 ||
      ((row.before !== undefined || row.bound !== undefined) && row.confirm !== undefined))
  );
}
