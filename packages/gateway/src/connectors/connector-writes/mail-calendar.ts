// packages/gateway/src/connectors/connector-writes/mail-calendar.ts
import {
  type ConnectorWritePreviewTemplate,
  type ConnectorWriteRow,
  type PreviewFieldTemplate,
  row,
  textField,
  withPreview,
} from "./types.ts";

// Drafts (B3, plan R7): a draft sends nothing, but it is not treated as lower risk: it stays HITL,
// wave 2, never delegable and ledgered. Every recipient is its own labelled line (Bcc marked
// hidden), so the owner sees each address verbatim; display names and look-alike domains are shown,
// not resolved, and a distribution list cannot be told from a person. The draft persists in the
// owner's mailbox and can be sent later from the mail client without Nimbus. The connectors send no
// Cc or Bcc header when the key is unset.

/** The recipient and subject lines every draft row shows, then its body line. */
function draftFields(bodyLabel: string): PreviewFieldTemplate[] {
  return [
    textField("to", "To"),
    textField("cc", "Cc", "(not set: none)"),
    textField("bcc", "Bcc (hidden from the other recipients)", "(not set: none)"),
    textField("subject", "Subject"),
    textField("body", bodyLabel),
  ];
}

/** A draft template addressed to `{to}` in `mailbox`; nothing is sent. */
function draftTemplate(
  mailbox: string,
  fields: readonly PreviewFieldTemplate[],
): ConnectorWritePreviewTemplate {
  return {
    target: "{to}",
    summary: `Save ${mailbox} draft addressed to {to}; nothing is sent`,
    fields,
  };
}

export const MAIL_CALENDAR_ROWS: readonly ConnectorWriteRow[] = [
  // Gmail and iCloud send the body as `text/plain`.
  withPreview(
    row("gmail_draft_create", "gmail.draft.create", "mesh", 2),
    draftTemplate("a Gmail", draftFields("Body (plain text)")),
  ),
  withPreview(
    row("apple_mail_draft_create", "apple.mail.draft.create", "mesh", 2),
    draftTemplate("an iCloud Mail", draftFields("Body (plain text)")),
  ),
  // Outlook: registered only when the token holds `Mail.ReadWrite`; the connector defaults
  // `contentType` to text. An HTML body is shown as text (never rendered or fetched), so a remote
  // image in it is visible verbatim; it would load when the draft is opened (B3r refuses it).
  withPreview(
    row("outlook_draft_create", "outlook.draft.create", "mesh", 2),
    draftTemplate("an Outlook", [
      ...draftFields("Body (shown as text, never rendered)"),
      textField("contentType", "Format", "text"),
    ]),
  ),
  row("outlook_calendar_create", "outlook.calendar.create", "mesh", 2),
  row("apple_calendar_event_create", "apple.calendar.event.create", "mesh", 2),
  row("outlook_calendar_delete", "outlook.calendar.delete", "mesh", 3),
  row("apple_calendar_event_delete", "apple.calendar.event.delete", "mesh", 3),
  row("gmail_draft_send", "gmail.draft.send", "mesh", 3),
  row("gmail_message_send", "gmail.message.send", "mesh", 3),
  row("outlook_mail_send", "outlook.mail.send", "mesh", 3),
  row("fastmail_mail_send", "fastmail.mail.send", "mesh", 3),
  row("imap_mail_send", "imap.mail.send", "mesh", 3),
  row("protonmail_mail_send", "protonmail.mail.send", "mesh", 3),
  row("apple_mail_send", "apple.mail.send", "mesh", 3),
];
