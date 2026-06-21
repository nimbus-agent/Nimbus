# Workday Connector

## What this is

First-party Nimbus MCP connector for [Workday](https://www.workday.com). Indexes
HR data from a Workday tenant as four item types in the local index:
`workday:worker` (org chart / employee directory), `workday:time_off` (approved
and pending time-off requests), `workday:job_posting` (open requisitions), and
`workday:report` (admin-configured RaaS custom reports).

The connector is **read-only**. It applies a **directory-safe PII allowlist** —
only name, title, department, manager, location, employment status, and effective
dates are indexed. Compensation, SSN, home address, and leave reasons are never
fetched or stored.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth workday
nimbus ask "Who is out of office this week?"
nimbus ask "What engineering roles are open?"
```

Authorization is via **Workday OAuth2** (client-credentials flow). The connector
opens the Workday tenant's authorization endpoint; on consent, the access token is
stored in the Vault and never logged. Required credentials:

- Obtain a Workday OAuth2 client ID and secret for your tenant (Workday Studio →
  Integration System → OAuth 2.0 Clients)
- Set the following environment variables (or use `nimbus vault set`):

| Variable | Purpose |
| --- | --- |
| `NIMBUS_OAUTH_WORKDAY_CLIENT_ID` | OAuth2 client ID |
| `NIMBUS_OAUTH_WORKDAY_CLIENT_SECRET` | OAuth2 client secret |
| `NIMBUS_WORKDAY_TENANT_HOST` | Workday API host (e.g. `wd2-impl-services1.workday.com`) |
| `NIMBUS_WORKDAY_TENANT` | Workday tenant name (e.g. `acme_dpt5`) |

- Run `nimbus connector auth workday` to complete the OAuth flow.

The Gateway injects credentials into the connector process at spawn time; the
connector itself never touches the Vault directly.

**Optional — RaaS custom reports**

Admin-defined Workday RaaS reports can be declared in `nimbus.toml`. Each report
is fetched and indexed as a `workday:report` item. The report URL must be on the
same host as `NIMBUS_WORKDAY_TENANT_HOST` (a same-host guard prevents credential
forwarding to arbitrary URLs).

```toml
[[connectors.workday.reports]]
label   = "Headcount by Department"
url     = "https://wd2-impl-services1.workday.com/ccx/service/customreport2/acme_dpt5/headcount_by_dept"
key_field = "department"
fields  = ["department", "headcount", "as_of_date"]
```

Each `[[connectors.workday.reports]]` entry requires:

| Field | Required | Purpose |
| --- | --- | --- |
| `label` | yes | Human-readable name for the report (used as the indexed item title) |
| `url` | yes | Full RaaS URL; must share the same origin as `NIMBUS_WORKDAY_TENANT_HOST` |
| `key_field` | yes | The field whose value becomes the indexed item's unique key |
| `fields` | yes | List of field names to index from the report rows |

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `workday.oauth` | yes (after auth) | Workday OAuth2 token bundle (access + refresh), stored in the Vault after `nimbus connector auth workday`. |

Tools exposed (live, read-only — workers only):

| Tool | Purpose |
| --- | --- |
| `workday_list` | List Workday workers (`GET /workers?limit=100`). |
| `workday_get` | Fetch one worker by ID (`GET /workers/{id}`). |
| `workday_search` | Substring search across the first page of workers. |

Time-off, job postings, and admin-configured RaaS reports are **indexed by the
Gateway sync** (and surfaced via `nimbus search`), not exposed as separate MCP
tools — so the four `workday:*` item types above come from the sync, while the
connector's live tool surface is the three worker tools listed here. No tool
requires HITL (read-only connector).
PII is filtered to directory-safe fields only — compensation, SSN, home address,
and leave reasons are never indexed.

> **Scope of the allowlist:** the PII allowlist governs what is written to the
> local **index** (and embeddings) by the background sync. The three live MCP
> read tools (`workday_list`/`get`/`search`) call the Workday API directly and
> return its raw response to the agent (envelope-wrapped), so they are bounded
> by what the Workday API itself exposes for the authenticated client, not by
> this index-side allowlist.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
