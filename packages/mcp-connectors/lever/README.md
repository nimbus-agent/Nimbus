# Lever Connector

## What this is

First-party Nimbus MCP connector for [Lever](https://www.lever.co). Indexes the
company's published **job postings** as `lever:posting` items in the local index
and exposes three read-only tools to the Nimbus agent (`lever_list`,
`lever_get`, `lever_search`). Useful for answering recruiting questions — "which
backend roles are open?", "find the posting for the staff SRE position" —
without leaving Nimbus.

v1 indexes job postings only. Opportunities and candidates are deliberately
deferred (candidate PII; out of scope for v1).

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set lever.api_key <your-lever-api-key>
nimbus ask "Which backend engineering roles are open on Lever?"
```

Create an API key in Lever under **Settings → Integrations and API → API
credentials**.

Lever uses HTTP **Basic** auth where the API key is the **username** and the
password is **empty**, so the request header is
`Authorization: Basic base64(<api_key>:)` — note the trailing colon (the empty
password). The key is never logged.

The Gateway injects `lever.api_key` as `LEVER_API_KEY` at spawn time; the
connector itself never touches the vault. The gateway-side syncable
(`packages/gateway/src/connectors/lever-sync.ts`) walks
`GET /v1/postings?limit=100` — the `{ data, hasNext, next }` envelope —
following the `next` offset cursor while `hasNext` is true (capped at 20 pages),
and upserts each posting with metadata `{ posting_id, text, state, team,
department, location, commitment, level, tags, hosted_url, apply_url, req_code,
created_at, updated_at, canonical_url }`.

Note: `createdAt` and `updatedAt` are **epoch milliseconds** and are stored
verbatim (no parse, no ×1000). The `categories.*` sub-fields
(`team` / `department` / `location` / `commitment` / `level`) are flattened to
the top level. The `canonical_url` is the posting's `hostedUrl`. `tags` is stored
as the array of tag strings.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `lever.api_key` | yes | Lever API key, sent as the Basic-auth username with an empty password (`Authorization: Basic base64(<api_key>:)`). Never logged. |

The API host is fixed at `https://api.lever.co` (no host override key — it is a
SaaS host).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `lever_list` | List the company's job postings (`GET /v1/postings?limit=100`). |
| `lever_get` | Fetch one posting by id (`GET /v1/postings/{id}`). |
| `lever_search` | Substring search across the postings (text/title, state, team, department, location, tags). |

All three tools are read-only; `hitlRequired` is intentionally empty.
Opportunities and candidates are deliberately deferred (candidate PII; out of
scope for v1); v1 indexes job postings only.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
