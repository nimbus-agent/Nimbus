# HTTP API Token Scopes (PR 1) — Plan Review

**Date:** 2026-08-06
**Subject File:** [`2026-08-06-http-agents-pr1-token-scopes.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/http-agents/docs/superpowers/plans/2026-08-06-http-agents-pr1-token-scopes.md)

---

## 1. Open Questions & Plan Clarifications

### Q1.1: Route Matching and Static Route Keys in `HTTP_ROUTE_AUTH`
* **Context:** The `HTTP_ROUTE_AUTH` table keys routes using shapes like `PATCH /scim/v2/Users/:id`, `POST /v1/briefs/:id/sources`, and `GET /v1/briefs/*`.
* **Concern:** When checking scopes in the dispatcher:
  ```ts
  const auth = HTTP_ROUTE_AUTH[routeKey];
  ```
  If `routeKey` is the raw request path (e.g. `POST /v1/briefs/123/sources`), it will fail to match the table key `POST /v1/briefs/:id/sources` via a direct dictionary lookup.
* **Recommendation:** Clarify how `routeKey` is derived. If `routeKey` is the static route template/constant matching the registered route definition, confirm that both the HTTP server and the write routes dispatcher expose this static template. If it is matched against the raw URL path, we need to document or provide a pattern/wildcard matching helper instead of a direct dictionary lookup.

### Q1.2: Scope Input Validation vs. Silent Fallback
* **Context:** The plan specifies:
  > `"clip.pair passes only RECOGNISED scopes to the window"`
  > `"An empty result falls back to LEGACY_SCOPES"`
* **Concern:** If an operator typos a scope name (e.g., `--scopes clipp,agents` or `--scopes telepathy`), the invalid scopes are silently dropped. If the resulting filtered set is empty, it silently falls back to `LEGACY_SCOPES` (`["clip", "briefs"]`). This means a typo could silently grant a token credentials it wasn't intended to have (e.g. `briefs` when they only wanted `agents` but misspelled it).
* **Recommendation:** Instead of silent filtering and fallback, both the CLI and the gateway IPC handler should fail fast and throw a validation error if any requested scope is not a valid `ApiScope`. This prevents accidental misconfigurations or over-privileged tokens.

---

## 2. Suggestions & Improvements

### Suggestion 2.1: Robustness of the Route Literal Scanner
* **Context:** The completeness test parses `http-server.ts` using Regexes:
  ```ts
  /path\s*===\s*"(\/[^"]*)"/g
  /path\.startsWith\("(\/[^"]*)"\)/g
  ```
* **Concern:** If future routes are defined using string interpolation, different formatting, or different patterns (e.g. `path.includes(...)` or regex tests), the scanner will silently miss them, making the completeness guard check fail-open for those routes.
* **Improvement:** Add a comment in `http-route-auth.test.ts` warning developers that any router matching logic changes in `http-server.ts` must be accompanied by updates to the source scanner. Additionally, consider having the test check for other occurrences of `path` routing keywords to assert no unscanned route patterns exist.
