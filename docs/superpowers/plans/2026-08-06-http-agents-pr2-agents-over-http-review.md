# Review of HTTP agents PR2 plan (Agents over HTTP)

Here are the open questions, suggestions, and potential improvements identified during the review of [2026-08-06-http-agents-pr2-agents-over-http.md](./2026-08-06-http-agents-pr2-agents-over-http.md).

**Disposition (2026-08-06):** item 4 is **fixed** in the plan (Tasks 5-7); items 1-3 are **deferred**
with reasoning recorded in the plan's _Reviewed and deferred_ section.

## Key Strengths

- **Totality & Type Safety:** Map-based validation (`EGRESS_BEARING_CLIENT_KINDS` being total over `ClientKind`) is an excellent pattern that compile-locks the requirement and prevents silent failures on future additions.
- **Strict Concurrency Limits:** Using a synchronous reservation phase (`admit()`) before the asynchronous dispatch is highly robust against race conditions under concurrent requests.
- **Strict Memory Bounding:** Bounding the Map sizes (`MAX_RETAINED_TERMINAL_AGENT_RUNS = 16`, `MAX_EXPIRED_AGENT_TOMBSTONES = 256`) guarantees that even without active/background interval sweeping, memory consumption is strictly capped.

---

## Open Questions & Design Suggestions

### 1. `whyPeek` Route Design

- **Context:** The plan excludes `agents.whyPeek` because it is synchronous, returning a payload directly instead of emitting a brief.
- **Suggestion:** For future compatibility and completeness of the HTTP surface, we should consider a dedicated inline route like `POST /v1/agents/why-peek` which executes synchronously and returns `200 OK` with the payload directly, rather than returning a `202 Accepted` with a `runId`.
- **Disposition — DEFERRED.** New surface the approved design does not contain (§1 enumerates five routes), with no consumer yet. It also carries an unresolved sub-question: `resolveHttpAgentMethod` maps a path segment to `agents.<segment>` with no translation table, so a hyphenated `why-peek` path needs a second mapping — the exact drift shape the derivation exists to avoid. Decide with the browser panel's requirements in hand.

### 2. Run Details in Polling Response

- **Context:** The current design returns `status`, `brief`, `findings`, and `failureReason` when polling a run.
- **Suggestion:** Consider exposing `createdAtMs` and `expiresAtMs` (or a derived `ttlRemainingMs`) in the response body of `GET /v1/agents/runs/{id}`. This would allow HTTP clients to display a remaining lifetime countdown or warn users when a run is close to expiring.
- **Disposition — DEFERRED.** `handleBriefGet` does not expose them either, so omission is the surface's precedent; response fields are purely additive, so deferring costs nothing. A run reaches a terminal state in seconds against a ten-minute TTL, so the countdown would show a number that never matters. The question did surface a real gap, now fixed: the plan gave no rationale for 10 minutes vs briefs' 30, and now records one.

### 3. Future Scope Separation for Write Actions

- **Context:** The current plan introduces the `agents` API scope for all read-only agents over HTTP.
- **Question:** If future HTTP endpoints support writable agent behaviors (such as triggering remote code or writing to connected cloud services), will they reuse the `agents` scope or introduce a separate `agents:write` scope? Establishing the naming convention/hierarchy now (e.g. `agents:read` vs `agents:write`) might prevent scope inflation down the road.
- **Disposition — DEFERRED, as a decision rather than a postponement.** `API_SCOPES` shipped in PR 1 as five flat capability names with no `:` separator; `parseEntry` drops unrecognised scopes, so a rename would silently strip `agents` from every token minted since. Most decisively, the split would not be the enforcement boundary: built-in agents are structurally read-only, and a write-capable agent is gated by the executor's consent gate (`I2`), which no token scope can bypass or configure away. Reopens only when a write-capable agent surface is designed, with the HITL interaction settled first.

### 4. Client Resiliency to Concurrency Refusals

- **Context:** The concurrency cap returns a `429` status code with `error: "busy"`.
- **Suggestion:** Include a `Retry-After` header (e.g., standard HTTP practice) indicating when the client should try again, or at least document how client libraries should handle the backoff when encountering this specific `429` limit versus the general token rate limiter.
- **Disposition — ACCEPTED, fixed in Tasks 5-7.** Verified against source: `checkRateLimit` (`ipc/http-write-routes.ts:558-568`) already sends `Retry-After` on the _other_ 429 this same route can produce, so the plan shipped one endpoint with two 429s of which only one honoured the header contract. The header now carries a small constant (`AGENT_BUSY_RETRY_AFTER_SECONDS = 1`) rather than the run-expiry distance — a slot frees when a run _finishes_ (seconds), not when it _expires_ (ten minutes), so an expiry-derived value would be misleading, not conservative. The expiry distance moves into the body as an upper bound, and is `null` (omitted) when every occupied slot is an in-flight reservation, since nothing on the clock bounds that wait. A cross-check test asserts both 429s from this route carry the header.
