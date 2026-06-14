# Mendeley Connector

## What this is

First-party Nimbus MCP connector for [Mendeley](https://www.mendeley.com). Indexes
the bibliographic **references** from a Mendeley library as `mendeley:reference`
items in the local index and exposes three read-only tools to the Nimbus agent
(`mendeley_list`, `mendeley_get`, `mendeley_search`). Useful for answering research
questions — "what did I save about machine learning?", "find my reference with DOI 10.1145/…" — without leaving Nimbus.

v1 indexes bibliographic reference metadata only. Document PDF contents and binary
attachments are never fetched or parsed — metadata only.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth mendeley
nimbus ask "What references did I save about retrieval-augmented generation?"
```

Authorization is via **Elsevier OAuth2**: the connector opens your browser to the
Elsevier login flow, and on consent, the access token is stored in the Vault
and never logged. User-supplied client credentials are required:

- Register an app at <https://dev.mendeley.com/myapps.html>
- Set your app's `NIMBUS_OAUTH_MENDELEY_CLIENT_ID` and
  `NIMBUS_OAUTH_MENDELEY_CLIENT_SECRET` environment variables
  (or use `nimbus vault set` to store them)
- Run `nimbus connector auth mendeley` to authorize

The Gateway injects the OAuth tokens into the connector process at spawn time;
the connector itself never touches the vault.

The gateway-side syncable (`packages/gateway/src/connectors/mendeley-sync.ts`)
walks the Mendeley API (`GET /reference?view=all&limit=50&sort=modified`) — a
single forward pass per cycle, incrementing the offset while a full page comes back
(capped at 20 pages) — and upserts each reference with metadata `{ id, title,
authors, year, source, doctype, keywords, doi, url, abstract }`. The abstract is
truncated to 500 characters; PDFs and attachments are never fetched.

Note: Timestamp fields are converted from ISO-8601 to epoch-milliseconds on index.
`authors` is reduced to a formatted author-list string; `keywords` are stored as a
string array; and the abstract is truncated.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `mendeley.oauth` | yes (after auth) | Elsevier OAuth2 token bundle (access + refresh), stored in the Vault after `nimbus connector auth mendeley`. The client id/secret are NOT stored here — they are read from the `NIMBUS_OAUTH_MENDELEY_CLIENT_ID`/`_SECRET` environment variables at token-exchange time. |

The API host is fixed at `https://api.mendeley.com` (no host override key — it is
a SaaS host).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `mendeley_list` | List the library's references (`GET /reference?view=all&...`). |
| `mendeley_get` | Fetch one reference by its ID (`GET /reference/{id}`). |
| `mendeley_search` | Substring search across references (title, authors, source, keywords, DOI, abstract). |

All three tools are read-only; `hitlRequired` is intentionally empty.
v1 indexes bibliographic reference metadata only; PDF contents are never fetched.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
