// packages/gateway/src/connectors/connector-writes/mail-calendar.ts
import {
  arrayAt,
  beforeReplyJson,
  excerptHead,
  requiredStringAt,
  stringAt,
} from "./before-select.ts";
import {
  selectAppleEventDelete,
  selectOutlookEventDelete,
  singleIdArgs,
} from "./delete-readers.ts";
import {
  type BeforeStateField,
  type ConnectorWritePreviewTemplate,
  type ConnectorWriteRow,
  type PreviewFieldTemplate,
  row,
  textField,
  withBefore,
  withConfirm,
  withPreview,
} from "./types.ts";

// Drafts (B3, plan R7): a draft sends nothing, but it is not treated as lower risk: it stays HITL,
// wave 2, never delegable and ledgered. Every recipient is its own labelled line (Bcc marked
// hidden), so the owner sees each address verbatim; display names and look-alike domains are shown,
// not resolved, and a distribution list cannot be told from a person. The draft persists in the
// owner's mailbox and can be sent later from the mail client without Nimbus. The connectors send no
// Cc or Bcc header when the key is unset.
//
// Calendar event creates (B4a, plan R2/R7): every attendee is shown in full on one line, like a
// draft's recipients: Outlook's comma string verbatim, iCloud's array as compact JSON. There is no
// attendee bound (owner ruling OR-B4-2); display names and look-alike domains are shown, not
// resolved, and a distribution list cannot be told from a person. Invitations: Microsoft Graph
// `POST /me/events` with attendees sends the invitations when the event is created ("When you
// create an event that includes attendees, the server sends invitations to all attendees",
// https://learn.microsoft.com/en-us/graph/api/user-post-events), so the Outlook summary says it
// does. iCloud: the connector PUTs a VEVENT with `ATTENDEE` lines and no `ORGANIZER`; RFC 6638
// section 3 schedules only an object that names an organizer, but whether iCloud's CalDAV server
// sends invitations for such a PUT is not established, so the iCloud summary says it "may". The
// calendar creates have no before-state (nothing exists yet; a conflicting-event read is neither
// cheap nor bounded). They stay wave 2, HITL, never delegable and ledgered.

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

/** Whether `message` carries `INBOX` / `UNREAD` in its `labelIds`; `undefined` when it lists none. */
function messageLabels(message: unknown): readonly string[] | undefined {
  const labels = arrayAt(message, ["labelIds"]);
  if (labels === undefined) return undefined;
  return labels.filter((l): l is string => typeof l === "string");
}

/** The first `Subject` header of a Gmail message (`format: metadata`), if it has one. */
function messageSubject(message: unknown): string | undefined {
  const headers = arrayAt(message, ["payload", "headers"]);
  if (headers === undefined) return undefined;
  for (const h of headers) {
    const name = stringAt(h, ["name"]);
    if (name !== undefined && name.toLowerCase() === "subject") return stringAt(h, ["value"]);
  }
  return undefined;
}

/**
 * Gmail `gmail_thread_read` (before-state, `format: metadata`) for an archive: the thread the owner
 * is about to remove from the inbox. A thread with no message in the inbox reads "no (already
 * archived)"; a thread that lists no messages, or whose messages carry no label list, throws, so the
 * prompt reads `unavailable (failed)` rather than a state it could not read.
 */
export function selectGmailThreadArchive(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  requiredStringAt(j, ["id"]);
  const messages = arrayAt(j, ["messages"]);
  if (messages === undefined || messages.length === 0) throw new Error("before reply: no messages");
  let inInbox = 0;
  let unread = 0;
  for (const m of messages) {
    const labels = messageLabels(m);
    if (labels === undefined) throw new Error("before reply: a message lists no labels");
    if (labels.includes("INBOX")) inInbox++;
    if (labels.includes("UNREAD")) unread++;
  }
  const total = messages.length;
  const subject = messageSubject(messages[0]);
  return [
    { label: "Subject", value: subject === undefined ? "(no subject)" : excerptHead(subject) },
    { label: "Messages", value: String(total) },
    {
      label: "Unread",
      value: unread === 0 ? "no" : `yes: ${String(unread)} of ${String(total)} messages`,
    },
    {
      label: "In the inbox",
      value:
        inInbox === 0
          ? "no (already archived)"
          : `yes: ${String(inInbox)} of ${String(total)} messages`,
    },
  ];
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
  // `contentType` to text. An HTML body is shown as text (never rendered or fetched), and since B3r
  // both doors refuse one that would load remote content when the draft is opened (a body with
  // `contentType` present and not exactly "text" is scanned as Outlook HTML; plain links stay).
  withPreview(
    row("outlook_draft_create", "outlook.draft.create", "mesh", 2),
    draftTemplate("an Outlook", [
      ...draftFields("Body (shown as text, never rendered)"),
      textField("contentType", "Format", "text"),
    ]),
  ),
  // Outlook: registered only when the token holds `Calendars.ReadWrite`. The connector sends
  // `start`/`end` as `{ dateTime, timeZone }` with `timeZone` defaulting to "UTC", the body as
  // `contentType: "Text"`, and splits `attendees` on `,` (each `type: "required"`). The doors refuse
  // a time carrying its own offset or `Z` (`calendarRefusal`), so the Time zone line is the zone
  // Graph applies.
  withPreview(row("outlook_calendar_create", "outlook.calendar.create", "mesh", 2), {
    target: "{subject}",
    summary:
      "Create an Outlook calendar event; Outlook emails an invitation to every attendee listed",
    fields: [
      textField("subject", "Title"),
      textField("startDateTime", "Start (in the time zone below)"),
      textField("endDateTime", "End (in the time zone below)"),
      textField("timeZone", "Time zone", "UTC"),
      textField(
        "attendees",
        "Attendees (each is emailed an invitation when the event is created)",
        "(not set: no one is invited)",
      ),
      textField("body", "Description (plain text)", "(not set: none)"),
    ],
  }),
  // iCloud: a CalDAV PUT of one VEVENT. `DTSTART`, `DTEND` and `UID` are emitted verbatim, so the
  // doors accept only `YYYYMMDDTHHMMSSZ` times (UTC, owner ruling OR-B4-6), and refuse a line
  // break or control character in any text field or attendee (`calendarRefusal`). With `calendar`
  // unset the connector uses the first calendar its include/exclude settings select; with `uid`
  // unset it generates one.
  withPreview(row("apple_calendar_event_create", "apple.calendar.event.create", "mesh", 2), {
    target: "{summary}",
    summary:
      "Create an iCloud Calendar event; iCloud may email an invitation to every attendee listed",
    fields: [
      textField("summary", "Title"),
      textField("start", "Start (iCalendar time; a trailing Z means UTC)"),
      textField("end", "End (iCalendar time; a trailing Z means UTC)"),
      textField(
        "calendar",
        "Calendar",
        "(not set: the first calendar the connector's settings select)",
      ),
      textField(
        "attendees",
        "Attendees (each may be emailed an invitation)",
        "(not set: no one is invited)",
      ),
      textField("location", "Location", "(not set: none)"),
      textField("description", "Description (plain text)", "(not set: none)"),
      textField("uid", "Event id (UID)", "(not set: generated by the connector)"),
    ],
  }),
  // Spec § 15, OR-W34-3: the calendar deletes are irreversible, so wave 4.
  // D1: each delete is shown beside the event it removes; the full id or href is in the preview
  // beside the 8 characters the owner types.
  withConfirm(
    withBefore(
      withPreview(row("outlook_calendar_delete", "outlook.calendar.delete", "mesh", 4), {
        target: "{eventId}",
        summary: "Delete Outlook calendar event {eventId}; Nimbus cannot undo it",
        fields: [textField("eventId", "Event id")],
      }),
      {
        tool: "outlook_calendar_get",
        argKeys: ["eventId"],
        args: singleIdArgs("eventId", "eventId"),
        select: selectOutlookEventDelete,
      },
    ),
    { template: "delete {eventId:tail8}" },
  ),
  withConfirm(
    withBefore(
      withPreview(row("apple_calendar_event_delete", "apple.calendar.event.delete", "mesh", 4), {
        target: "{href}",
        summary: "Delete iCloud calendar event {href}; Nimbus cannot undo it",
        fields: [textField("href", "Event href")],
      }),
      {
        tool: "apple_calendar_event_get",
        argKeys: ["href"],
        args: singleIdArgs("href", "href"),
        select: selectAppleEventDelete,
      },
    ),
    { template: "delete {href:tail8}" },
  ),
  // Phase 10 SA2: a Gmail thread archive removes the `INBOX` label from every message of the thread
  // (`users.threads.modify`); nothing is deleted and the thread is found again under All Mail. The
  // connector lists the tool only when the token holds `gmail.modify` (or the full-mailbox scope),
  // so an existing Gmail connection must be re-authorised. The before-state reads the thread's
  // subject, size, unread count and whether any message is still in the inbox. Withheld from the MCP
  // act door (`not_yet_offered`): that door shows no before-state.
  withBefore(
    withPreview(row("gmail_thread_archive", "gmail.thread.archive", "mesh", 2), {
      target: "{threadId}",
      summary: "Archive Gmail thread {threadId}: remove it from the inbox; nothing is deleted",
      fields: [textField("threadId", "Thread id")],
    }),
    {
      tool: "gmail_thread_read",
      argKeys: ["threadId"],
      args: (input) => {
        const id = input["threadId"];
        return typeof id === "string" && id !== ""
          ? { threadId: id, format: "metadata" }
          : undefined;
      },
      select: selectGmailThreadArchive,
    },
  ),
  row("gmail_draft_send", "gmail.draft.send", "mesh", 3),
  row("gmail_message_send", "gmail.message.send", "mesh", 3),
  // No template, so the model is never offered it (B3w W3, owner ruling OR-B3w-1); the act door's
  // verbatim prompt shows every recipient; both doors refuse an HTML body that loads remote
  // content (B3w).
  row("outlook_mail_send", "outlook.mail.send", "mesh", 3),
  row("fastmail_mail_send", "fastmail.mail.send", "mesh", 3),
  row("imap_mail_send", "imap.mail.send", "mesh", 3),
  row("protonmail_mail_send", "protonmail.mail.send", "mesh", 3),
  row("apple_mail_send", "apple.mail.send", "mesh", 3),
];
