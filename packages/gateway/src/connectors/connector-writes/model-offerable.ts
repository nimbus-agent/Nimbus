// packages/gateway/src/connectors/connector-writes/model-offerable.ts
import type { ConnectorWriteRow } from "./types.ts";

/**
 * Why a row is never offered to the model, keyed by tool id (a row's identity). The seven mail
 * sends are owner ruling OR-W34-1 (spec § 15, 2026-11-06; OR-B3w-1 for Outlook): no mail send is
 * ever offered, whatever template or reader it later gets. The model writes drafts; the owner
 * sends. The sends stay reachable on the other doors. `bitbucket_pr_merge` is D1 round-1 fix 8.
 */
export const MODEL_NEVER_OFFERED_REASONS: Readonly<Record<string, string>> = Object.freeze({
  gmail_message_send: "mail sends are never offered to the model (OR-W34-1)",
  gmail_draft_send: "mail sends are never offered to the model (OR-W34-1)",
  fastmail_mail_send: "mail sends are never offered to the model (OR-W34-1)",
  imap_mail_send: "mail sends are never offered to the model (OR-W34-1)",
  protonmail_mail_send: "mail sends are never offered to the model (OR-W34-1)",
  apple_mail_send: "mail sends are never offered to the model (OR-W34-1)",
  outlook_mail_send: "mail sends are never offered to the model (OR-B3w-1)",
  bitbucket_pr_merge:
    "the Bitbucket merge exposes no head-commit precondition the connector can send, so a merge cannot be tied to the commit the owner reviewed (D1 round-1 fix 8)",
});

/** The tool ids of {@link MODEL_NEVER_OFFERED_REASONS}: a row in this set is never offered. */
export const MODEL_NEVER_OFFERED_TOOL_IDS: ReadonlySet<string> = Object.freeze(
  new Set(Object.keys(MODEL_NEVER_OFFERED_REASONS)),
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
