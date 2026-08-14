# Incident attribution — design review

**Date:** 2026-08-14  
**Reviewer:** AI Assistant (Antigravity)  
**Target Doc:** [2026-08-14-incident-attribution-design.md](./2026-08-14-incident-attribution-design.md)

---

## Suggestions & Open Questions

### 1. Rate Limiting for memoized `/users/{id}` lookups

* **The Issue:** Section 5.3 outlines a 3-step ladder for resolving PagerDuty user IDs to emails, ending in a fallback of `GET /users/{id}` (memoized, capped at 25 requests per sync run). While 25 requests is small, executing these fetches concurrently or without control could violate PagerDuty's API limits or cause spikes.
* **Recommendation:** Ensure the design explicitly mandates that fallback `GET /users/{id}` fetches also call and await `ctx.rateLimiter.acquire("pagerduty")` before calling the API. Additionally, any network exceptions (e.g., 404 for deleted users, 403 for unauthorized scopes) should fail gracefully, increment the `unattributed_actors` counter, and not abort the entire sync run.

### 2. The Offset-Pagination "Same Timestamp" Loop Risk

* **The Issue:** PagerDuty uses offset pagination (`limit` and `offset`) sorted by `updated_at:asc`. If a huge batch of incidents (e.g., more than `maxPagesPerSync * PAGE_SIZE`, or 2000+ incidents) gets modified at the exact same millisecond (such as a bulk automated update/resolution/migration), `maxUpdated` will not advance at the end of the sync run.
* **The Risk:** In the next sync iteration, the cursor will start with `since = maxUpdated` and `offset = 0`, fetching the exact same first 2000 incidents and getting stuck in a loop.
* **Recommendation:** Consider how to handle or document this limitation. A simple mitigation is to carry over the `offset` in the cursor if the sync was truncated (`hasMore = true`) *and* `maxUpdated` equals the incoming cursor's `lastUpdated`. Alternatively, document this as an acceptable edge-case constraint given the `maxPagesPerSync` defaults.

### 3. Graph Populator ID Mappings (UUID vs. Graph Entity ID)

* **The Issue:** Section 5.4 uses shorthand for relation creation: 
  * `for each assignee_emails entry → resolve → upsertGraphRelation(person, incident, "assigned", now)`
* **Clarification:** `resolvePersonForSync` returns a `person.id` (a UUID string from the `person` table). However, `upsertGraphRelation` requires `from_id` and `to_id` to refer to `graph_entity.id` values (SHA-256 strings generated via `deterministicGraphEntityId`).
* **Recommendation:** Make it explicit that the populator must first upsert a `person` type `graph_entity` using the resolved person UUID as the `externalId`:
  ```typescript
  const personEntityId = upsertGraphEntity(db, {
    type: "person",
    externalId: resolvedPersonId,
    label: personDisplayName(db, resolvedPersonId) ?? email,
  });
  ```
  And then link `personEntityId` to the `incidentEntityId`.

### 4. Sentry `assignedTo` format differences

* **The Issue:** Sentry's `assignedTo` payload is indeed typically structured as:
  ```json
  {"type": "user", "id": "...", "name": "...", "email": "..."}
  ```
  However, on some self-hosted Sentry instances or with tokens having restricted scopes, `email` might be omitted from public member representations or replaced by a generic username/ID representation.
* **Recommendation:** In the implementation of `syncErrorIssueGraph` (PR 2), ensure the parser safely extracts the email only after validating its existence, cased-insensitivity, and format, falling back to a structured null (no edge emitted) rather than risking type-errors or parsing failures on a `undefined` email value.
