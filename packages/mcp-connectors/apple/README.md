# iCloud Mail + Calendar Connector

## What this is

Nimbus MCP connector for **iCloud Mail** (IMAP/SMTP) and **iCloud Calendar**
(CalDAV). It indexes your iCloud Mail as `apple:email` items and your iCloud
Calendar events as `apple:event` items, and can send mail, save drafts, and
create or delete calendar events — all behind a Human-in-the-Loop (HITL)
consent gate.

### iCloud Mail — what is indexed

By design this connector indexes **headers + a short plain-text body preview +
attachment metadata only**:

- **Headers** — subject, from, to/cc, date, message-id (from the IMAP `ENVELOPE`).
- **Body preview** — a single capped (~2 KB / 2000 chars) plain-text excerpt.
- **Attachment metadata** — filename, size, and mimetype (from `BODYSTRUCTURE`).

It **never** downloads or parses attachment bytes and never fetches the full
message body. There is no surface to request `BODY[]` or an attachment part.

### iCloud Calendar — what is indexed

Calendar events are indexed as:

- **Summary, start/end, location, organizer, status** — from the CalDAV
  `VEVENT` (expanded server-side for recurring events; no client-side RRULE
  engine).
- **Attendee emails** — all `ATTENDEE` lines from each event.
- **Notes preview** — a capped (~2 KB / 2000 chars) excerpt of the event
  `DESCRIPTION`. Full descriptions are never returned.
- **Recurrence** — expanded server-side via CalDAV `<C:expand>`; overridden
  occurrences key on `<UID>:<RECURRENCE-ID>`.

### Forced sender

`apple_mail_send` and `apple_mail_draft_create` always set `From` to the
authenticated iCloud email address. Callers cannot supply a different `From`.

## Install

Bundled with Nimbus — no separate install required.

### Prerequisites — app-specific password

iCloud Mail and CalDAV require an **app-specific password** (your main Apple ID
password is not accepted). To generate one:

1. Sign in at [appleid.apple.com](https://appleid.apple.com).
2. Go to **Sign-In & Security** → **App-Specific Passwords**.
3. Click **+** (Generate an App-Specific Password).
4. Label it (e.g. "Nimbus") and copy the generated password.

Store it in Nimbus with:

```bash
nimbus connector auth apple
```

Nimbus will prompt for your iCloud email and the app-specific password. The
single app-specific password authenticates all three protocols: IMAP, SMTP,
and CalDAV.

### Fixed iCloud endpoints

The connector uses Apple's published fixed endpoints — no per-tenant
host/port configuration:

| Protocol | Host | Port | TLS |
|----------|------|------|-----|
| IMAP (read + drafts) | `imap.mail.me.com` | 993 | TLS |
| SMTP (send) | `smtp.mail.me.com` | 587 | STARTTLS |
| CalDAV (calendar) | `caldav.icloud.com` | 443 | HTTPS (bootstrap); resolved to `p##-caldav.icloud.com` after principal discovery |

## Quickstart

```bash
nimbus connector auth apple
nimbus ask "Summarize my unread iCloud mail from this week"
nimbus ask "What meetings do I have next week in my iCloud Calendar?"
```

## Tools

### Mail read tools (no HITL)

- `apple_list` — list recent iCloud Mail messages (headers + attachment
  metadata + ≤2000-char preview). Never returns full bodies or attachment bytes.
- `apple_get` — fetch one message by uid (headers + attachment metadata +
  ≤2000-char preview).
- `apple_search` — substring search over message headers (subject/from/to).

### Mail write tools (HITL-gated)

- `apple_mail_send` — send a new email via iCloud SMTP. Requires Gateway HITL
  `email.send`. `From` is always pinned to the authenticated iCloud email.
- `apple_mail_draft_create` — save a draft to the iCloud Mail Drafts folder
  via IMAP APPEND. Requires Gateway HITL `email.draft.create`. `From` is always
  pinned to the authenticated iCloud email.

### Calendar read tools (no HITL)

- `apple_calendar_list` — list events across iCloud Calendar within a UTC time
  window. Returns summary, start/end, location, organizer, attendee emails, and
  a ≤2000-char notes preview. Never returns full event descriptions beyond the
  capped preview.

### Calendar write tools (HITL-gated)

- `apple_calendar_event_create` — create a new event in iCloud Calendar via
  CalDAV PUT. Requires Gateway HITL `calendar.event.create`.
- `apple_calendar_event_delete` — delete an event from iCloud Calendar via
  CalDAV DELETE by href. Requires Gateway HITL `calendar.event.delete`.

### Privacy contract

All tools enforce a **metadata-only / ≤2000-char preview** contract:
mail bodies, attachment bytes, and full calendar descriptions are never
returned, stored, or transmitted beyond the capped preview.

## See also

- [Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)
- [Apple app-specific passwords](https://support.apple.com/en-us/102654)

## License

AGPL-3.0
