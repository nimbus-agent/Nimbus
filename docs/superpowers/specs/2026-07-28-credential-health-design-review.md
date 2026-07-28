# Design Review: Credential Health

This document contains a design review of the [credential-health-design.md](./2026-07-28-credential-health-design.md) specification, detailing open questions, suggestions, and potential improvements.

**Response:** [`2026-07-28-credential-health-design-review-response.md`](./2026-07-28-credential-health-design-review-response.md) — all six points accepted and applied.

---

## 1. Open Questions

### 1.1. Classification of Non-Auth API Errors (e.g., HTTP 400 / 404)

The proposed classifier logic is:

```text
auth-failure : HTTP 401 | 403, or a provider body matching the known
               auth-rejection set (invalid_grant, invalid_client, ...)
transient    : network error | HTTP 408 | 429 | 5xx
ok           : anything else that returned data
```

* **The Question**: How are HTTP 400 (Bad Request) or HTTP 404 (Not Found) errors handled if they do *not* contain one of the specific strings in the `auth-rejection` set?
* **Impact**: If a connector's active probe (`<name>_list` at `limit=1`) fails with a 400 due to a schema validation change or a missing optional parameter, it doesn't return successful data, nor is it a transient network error, nor is it a 401/403. Under the current rules, would it fall into `unknown` or be incorrectly classified as `ok` because it is "anything else"?
* **Suggestion**: Define an explicit fallback category for client/api errors that are neither auth failures nor transient network errors (e.g., mapping them to `unknown` or a specific API configuration error state).

### 1.2. Mapping Auth Failures to Specific `vault_key` Rows

For connectors that consume multiple vault keys (e.g., a Client ID, Client Secret, and a Token):

* **The Question**: If a sync or active probe fails with a 401/403, how does the writer determine which specific `vault_key` is `dead`?
* **Impact**: If a connector uses 3 credentials, does a single auth failure mark all 3 credentials as `dead`, or only the primary token?
* **Suggestion**: Clarify the mapping strategy. If a connector invocation fails, all Vault keys configured and used for that sync attempt should probably transition to `dead` (or at least share the status), unless the classifier can distinguish a client-secret failure from a token expiry failure.

### 1.3. Definition of the Staleness Threshold for `last_checked_at`

The status reader transitions status to `UNKNOWN (stale)` if `last_checked_at older than stale`.

* **The Question**: What is the default staleness threshold (e.g., 7 days, 14 days)? Is it configurable via `nimbus.toml`?
* **Suggestion**: Define a sensible default (e.g., 7 days) and specify if it can be configured alongside the 30-day warning window.

---

## 2. Improvements & Suggestions

### 2.1. HTML Error Body Sanitization for `detail`

Providers behind enterprise SSO, API gateways (like Cloudflare), or misconfigured reverse proxies often return large HTML pages (e.g., 502 Bad Gateway or 403 Forbidden pages) instead of JSON.

* **The Risk**: Capping `detail` at 256 bytes on a raw HTML response will store useless snippets like `<!DOCTYPE html><html><head><title>...`.
* **Improvement**: If the response `Content-Type` is HTML or starts with `<html`, extract the text content of the `<title>` tag or `<body>` header, or strip HTML tags before capping at 256 bytes.

### 2.2. Interactive Prompting for Declared Expiry

Since opaque tokens require manual expiration tracking via `nimbus creds expires <vault_key> <ISO-date>`:

* **Improvement**: Integrate this metadata entry into the `nimbus connector auth` interactive CLI flow. After a user configures an opaque token, prompt them:
  > *"Does this credential have a known expiration date? [YYYY-MM-DD / Enter to skip]:"*
  This captures the metadata at creation time rather than relying on the user remembering to run the command separately later.

### 2.3. Active Probe Timeout Safeguards

Some connectors talk to slow or poorly responsive self-hosted instances (e.g., an on-premise Jira or Gitlab instance).

* **Improvement**: Active probes must execute with a strict, short timeout (e.g., max 10-15 seconds) so that a single hung host does not block the entire concurrency queue or lock the CLI.
