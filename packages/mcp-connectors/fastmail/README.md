# Fastmail (JMAP) Connector

## What this is

Nimbus MCP connector for **Fastmail** over native **JMAP** (the Tier-4 EMAIL
connector class). It indexes the user's Fastmail mailbox as `fastmail:email`
items and can send mail behind a Human-in-the-Loop (HITL) consent gate. JMAP is
Fastmail's JSON-over-HTTPS protocol — more efficient than IMAP (one batched
request fetches the recent message list and all their headers at once).

By design this connector indexes **headers + a short plain-text body preview +
attachment metadata only**:

- **Headers** — subject, from, to/cc, received date, message-id (from the JMAP
  `Email/get` envelope properties).
- **Body preview** — a single capped (~2 KB / 2000 chars) plain-text excerpt.
  The JMAP fetch sets `maxBodyValueBytes`, so the server truncates the body
  value before it crosses the wire.
- **Attachment metadata** — filename, size, and mimetype (from the
  `attachments` body-part list).

It **never** downloads or parses attachment bytes and never fetches the full
message body. The attachment `blobId` download URL is never dereferenced.

## Install

Bundled with Nimbus — no separate install required. Uses native JMAP over HTTPS
(no extra runtime dependencies beyond the MCP SDK).

## Quickstart

Authentication is a single Fastmail API token (create one under Fastmail
Settings → Privacy & Security → API tokens, with mail read/write scope).
Configure the connector, then query or send:

```bash
nimbus connector auth fastmail
nimbus ask "Summarize my unread Fastmail from this week"
```

JMAP is contacted over HTTPS at `api.fastmail.com` (the session and API
endpoints), which is the only host on the connector's sandbox network
allow-list. An optional base-URL override supports JMAP-compatible hosts.

## Tools

- `fastmail_list` — list recent emails (headers + attachment metadata + preview).
- `fastmail_get` — fetch one email by JMAP id (headers + attachment metadata + preview).
- `fastmail_search` — full-text search (JMAP `Email/query` text filter).
- `fastmail_mail_send` — send a new email via JMAP EmailSubmission. Requires
  Gateway HITL `email.send`.

## See also

- [Email Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
