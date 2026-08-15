---
name: nimbus-http-write-surface
description: >
  The local HTTP API write surface + the `WRITE_ROUTE_ALLOWLIST` / bearer-auth /
  per-token rate-limit / audit-on-rejection pipeline that protects it (invariant `I13`).
  Use when adding/modifying an HTTP `POST`/`PUT`/`DELETE` handler, debating whether a
  route belongs on the local socket vs the HTTP API, wiring a CI integration that feeds
  the index, touching `http-server.ts`/`http-write-routes.ts`/`http-auth.ts`/
  `http-rate-limit.ts`, or hitting a 503 `write_surface_disabled` / a wrong
  WRITE_ROUTE_ALLOWLIST count assertion. Consult before any code that lets an external
  process write into the gateway over HTTP — the API is read-only except the sanctioned
  `POST /v1/deployments` carve-out.
---

# Nimbus HTTP Write Surface (I13)

## Why This Skill Exists

Before Phase 5 T4 PR 3b, the read-only HTTP API (`nimbus serve`) was structurally read-only: a single `SQLITE_OPEN_READONLY` handle backed every route. T4 PR 3b carved out a narrow write surface for post-deploy annotation (`POST /v1/deployments`) so CI can feed DORA metrics directly. That carve-out is **the only HTTP write path Nimbus accepts**, and the discipline that keeps it that way is invariant `I13`. Adding a second write route is a security boundary change, not a routine handler addition.

This skill is the rule a contributor consults **before** adding any HTTP `POST` / `PUT` / `DELETE` handler.

## Where It Lives

| File | Role |
|---|---|
| [`packages/gateway/src/ipc/http-write-routes.ts`](../../packages/gateway/src/ipc/http-write-routes.ts) | `WRITE_ROUTE_ALLOWLIST` (frozen, compile-time) + `dispatchWriteRoute` — the single dispatcher every HTTP write goes through |
| [`packages/gateway/src/ipc/http-server.ts`](../../packages/gateway/src/ipc/http-server.ts) | Where POST requests are routed to `dispatchWriteRoute`; opens **at most one** writable `Database` handle (the read handle stays `SQLITE_OPEN_READONLY`) |
| [`packages/gateway/src/ipc/http-auth.ts`](../../packages/gateway/src/ipc/http-auth.ts) | `requireBearer` + `tokenFingerprint` — reads the expected token from the `http_api.deployment_token` vault key; constant-time compare via `constantTimeStringEqual` (invariant `I10`) |
| [`packages/gateway/src/ipc/http-rate-limit.ts`](../../packages/gateway/src/ipc/http-rate-limit.ts) | Per-token sliding-window rate limiter (default 60 req/min); surfaces `X-RateLimit-*` headers |
| [`packages/gateway/src/security-invariants.test.ts`](../../packages/gateway/src/security-invariants.test.ts) | Three I13 sub-assertions — see "Enforcement" below |
| [`packages/gateway/openapi/v1.yaml`](../../packages/gateway/openapi/v1.yaml) | Hand-authored OpenAPI schema; **the schema must list every allowlisted write route** — see "OpenAPI drift" below |

## The Allowlist

Fourteen entries (the CI deploy-annotation route + the SCIM provisioning surface added in Phase 6 Slice 3 + the admin-console anchor-policy write surface added in Phase 6 Slice 4 + the ChatOps Teams inbound surface added in Phase 6 Slice 5 + the two web-clipper routes added in Phase 6 Slice 9 + the four research-brief routes added in Spine S1):

```typescript
export const WRITE_ROUTE_ALLOWLIST: readonly string[] = Object.freeze([
  "POST /v1/deployments",
  "POST /scim/v2/Users",
  "PATCH /scim/v2/Users/{id}",
  "DELETE /scim/v2/Users/{id}",
  "PUT /v1/admin/policy",
  "POST /v1/messaging/teams/events",
  "POST /v1/clips",
  "POST /v1/clips/pair/confirm",
  "POST /v1/briefs",
  "POST /v1/briefs/{id}/sources",
  "POST /v1/briefs/{id}/run",
  "POST /v1/briefs/{id}/save",
]);
```

Entries are `"<METHOD> <PATH>"` strings. The deployment route is exact-match; the SCIM item routes use a `{id}` placeholder matched by a regex in `resolveRoute` (the only sanctioned path-templating). `dispatchWriteRoute` selects the per-route bearer token (deployment → `http_api.deployment_token`; SCIM → `identity.scim.bearer`) and audit action type (`deployment.annotation_rejected` vs `scim.provision_rejected`). It rejects anything not resolvable to an entry; unknown paths return 404, known paths on the wrong method return 405 with `Allow` header. SCIM **GET** roster reads are not writes — they go through the bearer-checked `dispatchScimRead` read path, off this surface.

The fourteen routes do **not** all share one auth model — see the block comment above `WRITE_ROUTE_ALLOWLIST` in `http-write-routes.ts` for the live source of truth:

| Route | Auth model |
|---|---|
| `POST /v1/deployments` | Bearer token (`http_api.deployment_token`) |
| `POST /scim/v2/Users` · `PATCH …/{id}` · `DELETE …/{id}` | Bearer token (`identity.scim.bearer`) |
| `PUT /v1/admin/policy` (Slice 4) | Bearer token (the admin token); signs the org policy with the Vault-only anchor key |
| `POST /v1/messaging/teams/events` (Slice 5) | Bot Framework JWT validated in-route — **not** a static bearer |
| `POST /v1/clips` · `POST /v1/clips/pair/confirm` (Slice 9) | Web-clipper bearer minted only behind a live owner-opened pairing window (`I30`); the token is Vault-stored + revocable |
| `POST /v1/briefs` · `…/{id}/sources` · `…/{id}/run` · `…/{id}/save` (S1) | The same labeled clipper token, verified in-route |

The deployment/SCIM/policy rows are the static-bearer routes; the teams-events route is the lone validated-JWT route; the clip and brief routes use the pairing-window one-time-token mint (`I30`).

## Enforcement (the I13 test triple)

[`security-invariants.test.ts`](../../packages/gateway/src/security-invariants.test.ts) carries three assertions:

1. **`http-server.ts` imports `dispatchWriteRoute`** from `./http-write-routes.ts`. A second dispatcher cannot exist; the import is the proof.
2. **`http-server.ts` opens at most one writable `Database` handle** — counted by source-grep. Any second writable handle is a structural regression because it bypasses the dispatcher.
3. **`WRITE_ROUTE_ALLOWLIST.length === 14`** and contains exactly the deployment route + the three `/scim/v2/Users` routes + the admin-policy route + the teams-events route + the two `/v1/clips` routes + the four `/v1/briefs` routes (grep `toHaveLength(14)` in `security-invariants.test.ts` — the assertion moves as the file grows). Adding an entry **requires updating this assertion in the same commit** — the count is the integrity check, not just decoration.

## Request Flow

Every accepted write goes through this pipeline in `dispatchWriteRoute`:

1. **Allowlist lookup** — `"<METHOD> <PATH>"` must be in `WRITE_ROUTE_ALLOWLIST`. Unknown → 404; known path, wrong method → 405.
2. **Bearer auth** — `requireBearer(req, { expectedToken })`. Three outcomes:
   - `surfaceDisabled`: vault key `http_api.deployment_token` not set → 503 `write_surface_disabled` (no audit row — surface is structurally off).
   - `!ok`: bad / missing token → 401 `unauthorized` + audit row.
   - `ok`: continue with `auth.fingerprint` (SHA-256 prefix of the token, for forensic tagging).
3. **Rate limit** — `ctx.rateLimiter.check(auth.fingerprint, route.maxRequestsPerWindow)`. The limit is **per-route**: `MAX_REQUESTS_PER_WINDOW_DEFAULT` (60/min) for the control-plane routes, `MAX_REQUESTS_PER_WINDOW_CLIP` (20/min) for `POST /v1/clips` (it pays for that route's raised body cap). A route limit may only *tighten* the server-configured limit, never loosen it. On miss → 429 + `Retry-After` + audit row. On hit, the response always carries `X-RateLimit-{Limit,Remaining,Reset}` — reporting the limit that actually applied.
4. **Body parse** — `Content-Length` is checked against the route's own cap, `route.maxBodyBytes`, **before** the body is read; the streaming length cap then re-checks `bodyBytes.byteLength` against the same value. The cap is `MAX_BODY_BYTES_DEFAULT` (8 KiB) for every control-plane route and `MAX_BODY_BYTES_ARTICLE` (1 MiB) for `POST /v1/clips` alone, which carries the readable text of a whole page. UTF-8 decode is `{ fatal: true }`. JSON parse failures → 400 `invalid_json` + audit row.
5. **Service allowlist (per-route)** — for `POST /v1/deployments`, the body's `service` field must be in `ctx.knownServices()`. Unknown → 400 `unknown_service` + audit row (with `known_services` hint truncated to 25 entries).
6. **Route handler** — currently `dispatchDeploymentRpc("deployment.annotate", parsed, …)`. The handler writes its own success audit (do **not** double-write).
7. **Rejection audit** — any non-2xx path calls `recordRejection(ctx, { tokenFingerprint, resultCode, reason, … })`, which appends a `deployment.annotation_rejected` row via `appendAuditEntry` (BLAKE3-chained, tamper-evident). The audit write is best-effort — wrapped in `try { … } catch { /* silent */ }` so a corrupted chain or full disk **cannot** fingerprint the rejection path.

## Forbidden Categories

These can **never** become HTTP write surfaces, no matter the bearer auth quality:

| Category | Reason |
|---|---|
| `vault.*` writes | Same posture as I7 — credentials never leave the local socket. |
| `engine.ask` / agent surfaces | Inbound prompts via HTTP are a prompt-injection multiplier; the only LLM entry points are the local socket + Tauri allowlist. |
| Anything that bypasses `ToolExecutor` for a destructive action | Would regress I2 (HITL frozen set) silently. |
| Anything that opens its own `Database` handle | Regresses the "at most one writable handle in `http-server.ts`" sub-assertion. |

## Adding a New HTTP Write Route — Checklist

When a new POST/PUT/DELETE genuinely needs to live on the HTTP API (not the IPC socket):

- [ ] Confirm the action is **not** in the forbidden categories above. If destructive, it must go through `ToolExecutor` first and only become an HTTP surface for already-approved automation flows (CI annotation patterns).
- [ ] Add `"<METHOD> <PATH>"` to `WRITE_ROUTE_ALLOWLIST` in `http-write-routes.ts`.
- [ ] **Bump the `length` assertion** in `security-invariants.test.ts` (`expect(WRITE_ROUTE_ALLOWLIST.length).toBe(N)`). The count *is* the integrity check.
- [ ] Add an `if (key === "<METHOD> <PATH>")` branch in `dispatchWriteRoute` that calls the route's handler. Route handlers throw typed errors (e.g. `DeploymentRpcError`) so the dispatcher can map them to `400 invalid_<field>` audit rows.
- [ ] Decide whether the handler writes its own success audit (current pattern for `dispatchDeploymentRpc`). If yes, **do not double-write** in the dispatcher.
- [ ] Add the route to [`packages/gateway/openapi/v1.yaml`](../../packages/gateway/openapi/v1.yaml). If you forget, `bun run audit:openapi-drift` (CI gate from Phase 5 T4 PR 1) will fail — the OpenAPI schema is the single source of truth for the published API surface.
- [ ] The route must use the existing `ctx.writeDb` — never call `new Database(path, { readonly: false })` from a route handler.
- [ ] Set both per-route bounds explicitly on the resolver's `ResolvedRoute`: `maxBodyBytes` (use `MAX_BODY_BYTES_DEFAULT` — 8 KiB — unless the payload genuinely can't fit, and raise only with documented justification) and `maxRequestsPerWindow` (use `MAX_REQUESTS_PER_WINDOW_DEFAULT` — 60/min). They are required fields, so a new route can't silently inherit someone else's bounds; a raised cap must come with a tightened rate limit.
- [ ] Verify the bearer-auth + rate-limit + audit-on-rejection pattern still wraps the new route — `dispatchWriteRoute` does this by construction, but a handler that throws after auth must still surface a `recordRejection` call.
- [ ] Update [`docs/cli-reference.md`](../../docs/cli-reference.md) §"CI/CD" (or a new section) and [`docs/SECURITY.md`](../../docs/SECURITY.md) §"IPC Surface" if the boundary description changes.
- [ ] Update the `WRITE_ROUTE_ALLOWLIST` entry list in this skill and in [`docs/SECURITY-INVARIANTS.md`](../../docs/SECURITY-INVARIANTS.md) §I13.

## Removing or Renaming a Route

- [ ] Delete the allowlist entry, the dispatcher branch, and the OpenAPI path. **Decrement** the count assertion.
- [ ] If the removal was security-driven (route turned out to be a vector), add a comment near the count assertion locking in the absence — same pattern Tauri allowlist uses for `extension.install`.
- [ ] Audit the BLAKE3 chain (`nimbus audit verify`) — confirm the route never produced rows that downstream code depends on parsing.

## OpenAPI Drift

[`scripts/structure-audit/check-openapi-drift.ts`](../../scripts/structure-audit/check-openapi-drift.ts) compares `v1.yaml`'s declared paths against `READ_ONLY_HTTP_ROUTES` (and, by transitivity, against the live handler set). It's wired as `bun run audit:openapi-drift` and runs in the structure-audit CI gate. The write surface is small enough that drift here means *someone added a route and forgot the schema* — easy to fix, but the gate catches it before merge.

## Anti-Patterns

| Anti-pattern | Why it's bad | What to do instead |
|---|---|---|
| Adding a POST handler directly in `http-server.ts` and skipping `dispatchWriteRoute` | Bypasses the allowlist, bearer auth, rate limiting, and audit-on-rejection in one shot. This is the exact failure I13 prevents | Route every write through `dispatchWriteRoute`; add the allowlist entry first |
| Opening a second writable `Database` handle "for performance" | Defeats sub-assertion 2 of the invariant test and reintroduces silent-write paths that bypass `dbRun` (I14) | Use `ctx.writeDb`. If write throughput is genuinely the bottleneck, that's a `db/write.ts` change, not a new handle |
| Adding a route to `WRITE_ROUTE_ALLOWLIST` without updating the count assertion | Test fails immediately, but if `--no-verify` ships the commit, the integrity gate is gone | Always update both in the same diff. The count is the audit trail |
| Loosening the 8 KiB body cap to support "richer" payloads | DoS surface — the cap exists so an unauthenticated probe can't fill the audit chain or exhaust memory before bearer auth runs | Keep payloads small. If the route genuinely needs more, raise the cap with justification in the PR and add a corresponding rate-limit tightening. **Sanctioned exception:** `POST /v1/clips` carries a whole readable article, so it runs at `MAX_BODY_BYTES_ARTICLE` = 1 MiB (issue #771 — the 8 KiB cap 413'd every real page). It satisfies the rule via `MAX_REQUESTS_PER_WINDOW_CLIP` = 20/min, which holds the worst-case burst to ~20 MiB/min — below the ~60 MiB/min the shared 60/min limit would have allowed. Note the clip token is verified *after* `parseBody`, so those two bounds are what cap pre-auth work on that route |
| Suppressing the rejection audit because "rate-limit rejections are noisy" | The audit chain is the only forensic trail; suppression makes brute-force probes invisible | Tune the rate limit threshold instead; the audit row is the structural protection |
| Logging the bearer token (or even the full fingerprint) to stderr | Bearer token must never appear in logs (`*.token` redact pattern). The 8-hex `tokenFingerprint` is the only safe identifier | Use `auth.fingerprint`; the redact rules cover the rest |

## Reading the Audit

`deployment.annotation_rejected` rows carry `{ token_fingerprint, source_ip, result_code, reason, service?, external_id? }`. Brute-force probes show up as runs of 401s with the same (or rotating) fingerprints; pattern-match `reason` to distinguish unauthorized / rate_limited / invalid_json / unknown_service / invalid_<field> / payload_too_large / internal_error. Success rows live in the `deployment.annotated` action type with the matching `external_id`.

## See Also

- [`docs/SECURITY-INVARIANTS.md`](../../docs/SECURITY-INVARIANTS.md) §I13 — canonical invariant statement
- [`docs/SECURITY.md`](../../docs/SECURITY.md) §"IPC Surface" — boundary description
- [`docs/architecture.md`](../../docs/architecture.md) §"Security Model" — threat-to-mitigation table
- `nimbus-tauri-allowlist` skill — parallel pattern for the renderer-callable surface (I7)
- `nimbus-security-invariants` skill — the triple rule (production wiring + docs + test) that all the invariants follow
- `nimbus-cicd-data-layer` skill — pair with this skill when authoring new DORA / preflight / deploy-annotation surfaces
