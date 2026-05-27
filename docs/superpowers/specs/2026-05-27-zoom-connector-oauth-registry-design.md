# Design — Zoom 3-legged OAuth connector + OAuth provider registry

**Date:** 2026-05-27
**Branch:** `dev/asafgolombek/connector-buildout-rest`
**Status:** Approved design — ready for implementation planning

## Summary

Add a **Zoom connector** (the first new 3-legged authorization-code OAuth connector
since Google/Microsoft/Slack/Notion) indexing **scheduled meetings** (`zoom:meeting`)
and **cloud-recording transcripts** (`zoom:transcript`).

Because 3-legged OAuth currently lives as three parallel per-provider code paths
(token exchange, refresh, get-valid-token) with a `switch`/bespoke-function per
provider, we first **consolidate those four providers behind one data-driven
registry**, then add Zoom as a fifth registry entry. The registry refactor is done
**first, in isolation, with zero behavior change**, using the existing six auth test
files as the regression net — this is the explicit reason for doing the
generalization now rather than cloning the Notion path (the test-coverage investment
exists precisely to make this kind of security-sensitive refactor safe).

Read-only, `hitlRequired: []`. AI Companion summaries, meeting writes, and
calendar-event linking are explicitly deferred.

## Goals / Non-goals

**Goals**
- One `OAUTH_PROVIDERS` registry that expresses every existing provider's quirks as
  data + two narrow hooks, with no change to any provider's wire behavior or to any
  public function signature.
- Zoom user-level OAuth (authorize → consent → token, with rotating refresh tokens).
- `zoom:meeting` from `GET /v2/users/me/meetings?type=scheduled`.
- `zoom:transcript` from cloud-recording VTT transcripts (`GET /v2/users/me/recordings`).
- Granular GA scopes from the start.

**Non-goals (deferred)**
- AI Companion meeting summaries (plan-gated, newer, separate API).
- Meeting create/update/delete writes (Phase 6, HITL).
- Calendar-event linking.
- Webinars, chat, phone, contacts.
- Generalizing beyond what the five providers need (YAGNI on hypothetical providers).

## Background — current state (grounded in the tree)

- **Provider union** `OAuthProvider = "google" | "microsoft" | "slack" | "notion"`
  (`auth/pkce.ts:4`).
- **Token exchange:** generic form (`exchangePkceAuthorizationCode`, google/MS) ·
  Slack `oauth.v2.access` (response nested under `authed_user`, success is
  `ok:true` not HTTP status) · Notion HTTP-Basic-header + JSON body + `Notion-Version`
  header, no `expires_in` (synthetic 24 h expiry).
- **Refresh:** `refreshAccessToken` (google/MS, `provider: "google"|"microsoft"`) ·
  `refreshSlackUserToken` · `refreshNotionToken`.
- **Get-valid-token (gateway-side, 120 s margin, refresh-and-persist):**
  `getValidVaultOAuthAccessToken` (`oauth-vault-tokens.ts`, google/MS — consumed by
  `getValidGoogleAccessToken` in `google-access-token.ts` and
  `microsoftOAuthAccessFromConfig`) · `getValidNotionAccessToken`
  (`notion-access-token.ts`) · `getValidSlackAccessToken` (`slack-access-token.ts`).
- **Per-service vault-key mirroring (google/microsoft only):** after a PKCE flow
  `connectorAuthOAuthPkce` (`connector-rpc-handlers/auth.ts`) copies the shared
  `google.oauth`/`microsoft.oauth` token to a per-service key via
  `writePerServiceOAuthKey`; google connectors read via `resolveGoogleOAuthVaultKey`
  (per-service key preferred, else legacy shared key).
- **Spawn-time token injection:** `credential-orchestration.ts` spawns an OAuth MCP
  connector only when its `<provider>.oauth` secret is set; `connector-spawns.ts`
  resolves a fresh access token (refresh-at-spawn) and injects it as env. The
  MCP-process-token-expiry concern is therefore a non-issue (lazy-mesh respawns;
  every cycle re-resolves).
- **Safety net:** `auth/*.test.ts` — `pkce.test.ts` (exercises public `runPKCEFlow`
  + `refreshAccessToken`, incl. "no token in thrown error" assertions),
  `google-access-token.test.ts`, `notion-access-token.test.ts`,
  `slack-access-token.test.ts`, `oauth-vault-tokens.test.ts`,
  `oauth-vault-scopes.test.ts`.
- **Static gate:** D11 `VAULT_KEY_ALLOW_LIST` in
  `scripts/structure-audit/check-nimbus-invariants.ts` (must list any file
  constructing a `.oauth` vault key).

## Design

### 1. OAuth provider registry (`auth/oauth-registry.ts`, new)

One descriptor per provider:

```ts
type ClientSecretMode = "none" | "optional" | "required";

interface OAuthProviderDescriptor {
  id: OAuthProvider;                 // union gains "zoom"
  vaultKey: string;                  // "google.oauth" | … | "zoom.oauth"
  authorizeUrl: string;
  tokenUrl: string;
  usesPkce: boolean;                 // google/MS/slack/zoom = true, notion = false
  clientSecret: ClientSecretMode;    // google "optional", MS/slack "none", notion/zoom "required"
  secretPlacement: "body" | "basic_header";  // google body, notion/zoom basic_header
  bodyFormat: "form" | "json";       // notion "json", rest "form"
  tokenHeaders?: Record<string, string>;     // notion: { "Notion-Version": "2022-06-28" }
  mirrorPerService: boolean;         // google/MS true, rest false
  clientIdFromConfig(): string;
  clientSecretFromConfig?(): string;
  emptyClientIdHelp: string;
  emptyClientSecretHelp?: string;
  // the only genuinely per-provider logic — two narrow hooks:
  buildAuthorizeParams(a: AuthorizeArgs): Record<string, string>;
  parseTokenResponse(json: unknown, requestedScopes: string[]): PKCEResult;
  isTokenSuccess?(json: unknown, httpOk: boolean): boolean;   // slack: ok:true; default httpOk
}

export const OAUTH_PROVIDERS: Record<OAuthProvider, OAuthProviderDescriptor> = { … };
```

Generic engine functions consume the descriptor and replace the bespoke per-provider
functions:

- `runPKCEFlow(options)` — **unchanged signature**. Internals: descriptor lookup by
  `options.provider`; the existing port-binding/callback-server logic is kept
  verbatim; authorize URL from `buildAuthorizeParams`; one generic
  `exchangeAuthorizationCode(descriptor, …)`; persist to `descriptor.vaultKey`.
  Deletes `runSlackOAuthOnLocalPort`, `runNotionOAuthOnLocalPort`, the three
  `build*AuthorizeUrl`, and the three `exchange*` helpers.
- `refreshAccessToken(refreshToken, provider, clientId, ctx)` — signature **widened**
  to `provider: OAuthProvider` (backward-compatible). Descriptor-driven.
  `refreshSlackUserToken`/`refreshNotionToken` collapse into it; their (1–2 each)
  consumers migrate.
- `getValidVaultAccessToken({ provider, vault, vaultKey?, clientId, clientSecret? })`
  — the single "read vault → 120 s margin → refresh-and-persist → return access
  token" body. The four public resolvers (`getValidGoogleAccessToken`,
  `getValidNotionAccessToken`, `getValidSlackAccessToken`,
  `microsoftOAuthAccessFromConfig`) **keep their signatures** and delegate to it.
  Google keeps its own `resolveGoogleOAuthVaultKey` (per-service-key logic stays
  google-specific; only token validity delegates).
  - **Single-flight refresh lock (critical for rotating tokens).** A module-level
    in-memory `Map<vaultKey, Promise<string>>` coalesces concurrent near-expiry
    refreshes for the *same* token: the first caller performs the HTTP refresh +
    persist; concurrent callers await the same in-flight promise instead of issuing a
    second refresh. This prevents refresh-token reuse, which Zoom punishes by
    invalidating the entire token chain (forcing manual re-auth). The two concurrent
    paths that motivate it are the gateway-side sync cycle and spawn-time token
    injection both calling `getValid<Provider>AccessToken`. The lock lives in the
    generic resolver so **all five providers** benefit (it's a latent gap for
    Microsoft/Slack/Notion rotation too, just less punishing than Zoom). Net-new code,
    transparent to the single-threaded existing tests; lands in PR-1 with the resolver.
  - **Uniform refresh; no `hasRefreshFlow` flag.** All five providers have a refresh
    flow today (Notion rotates too via `refreshNotionToken`; its missing `expires_in`
    is handled as a synthetic 24 h expiry in its `parseTokenResponse`). Refresh
    persistence is `refresh_token ?? old` (a provider that omits a new refresh token
    keeps the existing one); `parseStoredOAuthTokens` already requires a stored refresh
    token. A `hasRefreshFlow` descriptor flag would be `true` for all five — speculative
    — so it is **deferred** until a genuinely non-refreshable provider is added.

**Behavior-preservation specifics**
- Slack `ok:true` success → `isTokenSuccess` hook (default = HTTP ok).
- Slack `authed_user` nesting + Notion synthetic-24 h expiry → each provider's
  `parseTokenResponse`.
- Notion `Notion-Version` + JSON body → `tokenHeaders` + `bodyFormat:"json"`.
- The secret-free token-error summary (`oauthTokenEndpointErrorSummary`) is preserved
  in the generic exchange — keeps the pkce.test "no token in thrown errors"
  assertions green.

### 2. Zoom auth wiring

**Descriptor `OAUTH_PROVIDERS.zoom`:**
`authorizeUrl=https://zoom.us/oauth/authorize`, `tokenUrl=https://zoom.us/oauth/token`,
`usesPkce=true`, `clientSecret="required"`, `secretPlacement="basic_header"`,
`bodyFormat="form"`, standard `parseTokenResponse` (no hook), `mirrorPerService=false`,
`vaultKey="zoom.oauth"`. Rotating refresh tokens are handled by the generic
refresh-and-persist (`refresh_token ?? old`) — verified by an explicit test.

**Config (`config.ts`):** `oauthZoomClientId` ← `NIMBUS_OAUTH_ZOOM_CLIENT_ID`,
`oauthZoomClientSecret` ← `NIMBUS_OAUTH_ZOOM_CLIENT_SECRET`.

**Help (`oauth-env-help-messages.ts` + CLI duplicate):**
`ZOOM_OAUTH_CLIENT_ID_HELP` + `ZOOM_OAUTH_CLIENT_SECRET_HELP` (Zoom Marketplace →
User-managed General app → OAuth → localhost redirect → copy Client ID + Secret).

**`connector.auth` (`connector-rpc-handlers/auth.ts`):** Zoom is not a PAT handler →
falls through to `connectorAuthOAuthPkce`; add a `zoom` case to
`oauthClientConfigForProvider` and extend the client-secret supply branch to pass
`Config.oauthZoomClientSecret`. No per-service mirroring.

**Gateway-side resolver (`auth/zoom-access-token.ts`, new):**
`getValidZoomAccessToken(vault)` — same shape as `slack-access-token.ts`, delegating
to `getValidVaultAccessToken` with the zoom descriptor. Used by the sync handler and
spawn injection.

**Spawn / orchestration / sandbox:** `connector-spawns.ts ensureZoomMcp` injects
`ZOOM_TOKEN`; `credential-orchestration.ts` adds
`ensureIfConnectorSecretSet(ctx, "zoom", "oauth", () => spawners.ensureZoomMcp(ctx))`;
`first-party-manifests.ts` sandbox network `["api.zoom.us", "zoom.us"]`.

**Catalog:** `oauthProfileForService("zoom") → { provider: "zoom", defaultScopes:
["user:read:user", "meeting:read:list_meetings",
"cloud_recording:read:list_user_recordings"] }` (granular GA scopes; classic
`meeting:read`/`recording:read` are the documented fallback if a granular name has
drifted — **verify exact strings against live Zoom docs at implementation**). Add the
catalog entry, `CONNECTOR_VAULT_SECRET_KEYS` (`zoom.oauth`), rate-limiter bucket, sync
interval, and `"zoom"` to the `ConnectorServiceId` union.

### 3. Sync handler, mappers, MCP server

**Item types:** `zoom:meeting` (sparse → local MiniLM) · `zoom:transcript` (prose →
**added to `PROSE_HEAVY_TYPES` as `"zoom:transcript"`**).

**`connectors/zoom-sync.ts`** — per cycle:
1. `getValidZoomAccessToken(ctx.vault)` once (refresh + persist rotated token). No
   token → `syncNoopResult`.
2. **Walk A — meetings:** `GET /v2/users/me/meetings?type=scheduled&page_size=100`,
   follow `next_page_token`, `MAX_PAGES=20`; map via `mapZoomMeetingToItem`.
3. **Walk B — recordings/transcripts:** `GET /v2/users/me/recordings?from=&to=&page_size=100`.
   Endpoint requires `from`/`to`, ≤1-month window: initial sync walks back
   `initialSyncDepthDays` (default 30) in ≤30-day windows; incremental syncs one
   window since the last cursor. For each `meetings[].recording_files[]` with
   `file_type==="TRANSCRIPT"`:
   - **Skip-if-exists (avoid re-downloading immutable VTTs).** Transcripts are
     immutable once generated, so before the second fetch, check whether a
     `zoom:transcript` row with `external_id = <meeting_uuid>:<recording_file_id>`
     already exists — a one-line read via `itemPrimaryKey("zoom", externalId)` +
     `SELECT id FROM item WHERE id = ?` (reads are not subject to I14). If present,
     skip the download. This makes the window-replay-on-error case cheap, not just
     correct.
   - **Download + parse.** Otherwise second fetch of `download_url` with
     `Authorization: Bearer <token>` (**header only — never `?access_token=` in the
     URL; no token-bearing URL is ever logged**), VTT→plaintext, map via
     `mapZoomTranscriptToItem`.
   **Dedupe:** a recording's parent meeting also upserts a `zoom:meeting` row under the
   same `external_id = String(id)`, so past recorded meetings (missed by the
   scheduled-only Walk A) still get a meeting row.
4. **Rate limiting.** Every Zoom HTTP call — the meetings list, the recordings list,
   *and* each per-file transcript `download_url` fetch — goes through
   `ctx.rateLimiter.acquire("zoom")` first (the wiz-sync convention). A `429 Too Many
   Requests` mid-walk (including mid-download) is a **graceful break**: stop the walk,
   keep the cursor unadvanced, and let the next sync cycle re-window from where it left
   off — never a hard sync failure. Per-request exponential backoff / `Retry-After`
   honoring is **deferred** (no existing connector does it; a cross-connector
   429/`Retry-After` policy is a separate enhancement).
5. Single-pass `nimbus-zoom1:` cursor encoding the windowing state. First-page
   http/parse error → pass-cursor-empty (keep prior cursor); later-page errors break
   — standard convention. Because the cursor is not advanced on a mid-window break, the
   next cycle replays that window; the `external_id` dedupe makes replay idempotent and
   the skip-if-exists check makes it cheap.

**Mappers (pure, unit-tested without HTTP):**
- `zoom-meeting-mapping.ts` `mapZoomMeetingToItem`: `external_id = String(id)` (skip
  if missing/non-numeric); title `topic` else `Meeting <id>`; `start_time`
  ISO→epoch-ms via local `parseIsoMs`; metadata `{ meeting_id, uuid, host_id, topic,
  type, start_time, duration_min, timezone, agenda, join_url, created_at,
  canonical_url }`; `canonical_url`/`url = join_url`.
- `zoom-transcript-mapping.ts` `mapZoomTranscriptToItem`:
  `external_id = <meeting_uuid>:<recording_file_id>` (stable, idempotent); title
  `Transcript — <topic>` else `Transcript <id>`; bodyPreview = first ~280 chars;
  **full transcript text stored**; links via `meeting_id`/`meeting_uuid` in metadata;
  `recording_start` ISO→epoch-ms; `canonical_url = play_url` else null. The VTT→text
  helper (strip `WEBVTT` header, cue indices, `HH:MM:SS.mmm --> …` lines, blanks;
  **strip inline tags via `/<[^>]+>/g` — covers `<v Speaker>` voice tags, `<b>`/`<i>`/`<c>`
  styling; merge multi-line cue text into a single block**; collapse whitespace) is a
  small pure function, fixture-tested with a tags + multi-line-cue VTT sample.

**MCP server `packages/mcp-connectors/zoom/src/server.ts`:** read-only
`zoom_list`/`zoom_get`/`zoom_search` over meetings + recordings; Bearer auth via
injected `ZOOM_TOKEN`; `hitlRequired: []`.

### 4. Testing

- `oauth-registry.test.ts` — per-descriptor: authorize-URL params, exchange request
  shape (form vs JSON, Basic-header vs body secret), refresh, `parseTokenResponse`
  (Slack `authed_user`/`ok`; Notion synthetic expiry) + a "no secret in thrown error"
  assertion mirrored from `pkce.test.ts`. Plus a **single-flight test**: two concurrent
  near-expiry `getValidVaultAccessToken` calls for the same `vaultKey` trigger exactly
  one refresh HTTP call (asserts the coalescing lock).
- The six existing `auth/*.test.ts` stay green unchanged = behavior-preservation net.
- `zoom-access-token.test.ts` — valid passthrough, near-expiry refresh, **rotating
  refresh-token persistence** (new refresh token written back, old discarded),
  missing-config error.
- `zoom-meeting-mapping.test.ts`, `zoom-transcript-mapping.test.ts` (VTT fixture
  **including `<v Speaker>` voice tags, inline styling, and a multi-line cue**,
  missing-id skip, dedupe external_id stability).
- `zoom-sync` integration (fake server): meetings pagination, recordings
  date-windowing, transcript second-fetch via Bearer **header**, "no transcript
  files" → zero transcript items, http-error→pass-cursor-empty, an assertion that no
  logged line contains a token-bearing URL, **skip-if-exists** (a pre-seeded
  `zoom:transcript` row suppresses the download fetch), **429 graceful break** (a 429
  mid-walk stops the walk without advancing the cursor and without throwing), and that
  the download fetch is gated by `ctx.rateLimiter.acquire("zoom")`.
- routing test: `isProseHeavy("zoom","transcript") === true`.
- D11: add `auth/oauth-registry.ts` + `auth/zoom-access-token.ts` to
  `VAULT_KEY_ALLOW_LIST`. Sandbox manifest I15 covered by the first-party-manifests
  test.

Coverage gates: `test:coverage:mcp` ≥70% (MCP server); new gateway files default
≥85%; auth refactor under the existing auth-test coverage.

## PR decomposition

1. **PR-1 — OAuth provider registry refactor.** `oauth-registry.ts` + migrate
   google/MS/slack/notion. Public signatures unchanged; all six auth tests + new
   registry tests green. **No Zoom.** Pure, isolated, behavior-preserving.
2. **PR-2 — Zoom auth + meetings.** Zoom descriptor; Config; help; `connector.auth`
   wiring; `zoom-access-token.ts`; catalog/secrets/rate-limiter/`ConnectorServiceId`;
   spawn injection + orchestration + sandbox manifest; `zoom-sync.ts` Walk A;
   `zoom-meeting-mapping.ts`; MCP server (meetings); tests; docs.
3. **PR-3 — Zoom transcripts.** Recordings walk (date-windowing) + VTT parse +
   `zoom-transcript-mapping.ts` + `"zoom:transcript"` in `PROSE_HEAVY_TYPES` + dedupe
   parent-meeting upsert + MCP recordings tools; tests; docs.

Each PR ends with the full local gate set green (`bun run preflight`,
`audit:invariants`, `audit:package-readmes`, `check-doc-references`). Nothing pushed
until the user says so; one (or more) PRs opened at the end on the user's go-ahead.

**Docs per PR:** `docs/CHANGELOG.md` under `### 2026-05-27`; roadmap Zoom row (line
504) `[ ]`→`[x]`; `nimbus-file-map` rows; `docs/cli-reference.md`
(`nimbus connector auth zoom`); `docs/architecture.md` connector/item-type tables. No
CLAUDE.md/GEMINI.md status-line edits (connector-docs convention).

## Risks / open items

- **Exact Zoom scope strings + recording/transcript field names** must be verified
  against current Zoom developer docs at implementation time (docs are JS-rendered;
  not fetchable here). Granular GA scope names are the primary; classic scopes are the
  fallback.
- **Recordings date-window** semantics (≤1-month) add windowing state to the cursor —
  more complex than the simple cursor walks; covered by an integration test.
- **Refactor blast radius** (PR-1) touches the security-sensitive OAuth path; mitigated
  by keeping all public signatures and relying on the six existing auth tests as the
  regression net, landing the refactor with no Zoom code.
- **Transcript availability:** only cloud-recorded + transcribed meetings produce
  `zoom:transcript`; "none" is normal, not an error.

## Review dispositions (2026-05-27)

Design review (`…-design-review.md`) raised five points; dispositions:

1. **Single-flight refresh lock** — ✅ fixed. Coalescing lock in the generic
   `getValidVaultAccessToken` keyed by `vaultKey` (§1); the critical safeguard for
   Zoom's chain-invalidating rotation; lands in PR-1, benefits all five providers.
2. **`hasRefreshFlow` flag** — ⛔ deferred (YAGNI: all five providers refresh today);
   the underlying missing/rotated-refresh handling is now stated explicitly in §1
   (`refresh_token ?? old`; `parseStoredOAuthTokens` requires a stored refresh token).
3. **VTT inline tags + multi-line cues** — ✅ fixed. Parser strips `/<[^>]+>/g`
   (incl. `<v Speaker>`) and merges multi-line cues (§3 mapper + fixture in §4).
4. **Download rate limiting** — ◐ partial. Fixed: every Zoom fetch incl. the per-file
   download goes through `ctx.rateLimiter.acquire("zoom")`, and a 429 is a graceful
   break (§3). Deferred: bespoke per-request backoff/`Retry-After` (no connector does
   it; cross-connector policy is a separate enhancement).
5. **Re-downloading unchanged VTTs on window replay** — ✅ fixed. Skip-if-exists check
   on the transcript `external_id` before the download (§3), exploiting transcript
   immutability; makes the (correct-by-dedupe) replay path cheap.
