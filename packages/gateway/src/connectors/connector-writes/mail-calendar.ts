// packages/gateway/src/connectors/connector-writes/mail-calendar.ts
import { type ConnectorWriteRow, row } from "./types.ts";

export const MAIL_CALENDAR_ROWS: readonly ConnectorWriteRow[] = [
  row("gmail_draft_create", "gmail.draft.create", "mesh", 2),
  row("apple_mail_draft_create", "apple.mail.draft.create", "mesh", 2),
  row("outlook_draft_create", "outlook.draft.create", "mesh", 2),
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
