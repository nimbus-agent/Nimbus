# Greenhouse Connector

## What this is

First-party Nimbus MCP connector for [Greenhouse](https://www.greenhouse.io).
Indexes the company's Greenhouse Harvest **job openings** as `greenhouse:job`
items in the local index and exposes three read-only tools to the Nimbus agent
(`greenhouse_list`, `greenhouse_get`, `greenhouse_search`). Useful for answering
recruiting questions — "which engineering jobs are open?", "find the job for the
staff SRE requisition" — without leaving Nimbus.

v1 indexes job openings only. Candidates and applications are deliberately
deferred (candidate PII; out of scope for v1).

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set greenhouse.api_key <your-harvest-api-key>
nimbus ask "Which engineering jobs are open in Greenhouse?"
```

Create a Harvest API key in Greenhouse under **Configure → Dev Center → API
Credential Management**, granting it the **Job** GET permissions.

Greenhouse uses HTTP **Basic** auth where the Harvest API key is the **username**
and the password is **empty**, so the request header is
`Authorization: Basic base64(<api_key>:)` — note the trailing colon (the empty
password). The key is never logged.

The Gateway injects `greenhouse.api_key` as `GREENHOUSE_API_KEY` at spawn time;
the connector itself never touches the vault. The gateway-side syncable
(`packages/gateway/src/connectors/greenhouse-sync.ts`) walks
`GET /v1/jobs?per_page=100&page=N` — a **bare JSON array** (NOT an envelope) —
incrementing `page` from 1 while the returned array is a full page of 100 (a
short or empty page is the last page; capped at 20 pages), and upserts each job
with metadata `{ job_id, name, status, requisition_id, confidential,
department_names, office_names, office_locations, opened_at, closed_at,
created_at, updated_at, canonical_url }`.

Note: `created_at` / `updated_at` (and `opened_at` / `closed_at`) are **ISO-8601
strings** parsed to epoch milliseconds. The `canonical_url` is **null** — the
Harvest API exposes no per-job public URL without a board token (deferred).
`department_names` is `departments[].name`; `office_names` is `offices[].name`
and `office_locations` is `offices[].location.name`.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `greenhouse.api_key` | yes | Greenhouse Harvest API key, sent as the Basic-auth username with an empty password (`Authorization: Basic base64(<api_key>:)`). Never logged. |

The API host is fixed at `https://harvest.greenhouse.io` (no host override key —
it is a SaaS host).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `greenhouse_list` | List the company's job openings (`GET /v1/jobs?per_page=100`). |
| `greenhouse_get` | Fetch one job by id (`GET /v1/jobs/{id}`). |
| `greenhouse_search` | Substring search across the jobs (name, status, requisition id, department + office names/locations). |

All three tools are read-only; `hitlRequired` is intentionally empty. Candidates
and applications are deliberately deferred (candidate PII; out of scope for v1);
v1 indexes job openings only.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
