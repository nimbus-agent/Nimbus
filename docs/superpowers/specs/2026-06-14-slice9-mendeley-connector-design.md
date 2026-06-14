# Design — Mendeley connector (Phase 6 Slice 9, sub-project A)

**Date:** 2026-06-14
**Branch / worktree:** `dev/asafgolombek/phase6-slice9-deferred-phase5`
**Status:** approved design, pre-plan
**Roadmap row:** Phase 6 → Slice 9 (Deferred from Phase 5) → Browser & Reading → **Mendeley**

## Context

Slice 9 ("Deferred from Phase 5") bundles six independent deliverables (Mendeley,
Workday, GitOps writes, ML writes, Apple Mail/Calendar, web clipper). Per the
brainstorming scope assessment it is decomposed into per-deliverable sub-projects,
each with its own spec → plan → implementation cycle (mirroring how Slice 7 was
split into waves 7a/7b/7c). **This spec covers sub-project A: Mendeley**, chosen
first because it is read-only and therefore collision-free with the in-flight,
unmerged Slice 7c branch.

## Goal

A **read-only** first-party MCP connector that indexes the **metadata** of the
user's Mendeley library documents (title, authors, year, abstract, DOI/identifiers
for papers, PDFs, and citations) into the local index as **`reference`** items —
the same item type the shipped Zotero connector uses — so `nimbus search` treats
both reference managers uniformly (the `service` field distinguishes
`mendeley` vs `zotero`). Implemented as a Zotero-style clone: a thin MCP server
stub plus a gateway-side sync handler and mapper.

### Non-goals (MVP)

- Annotations / highlights.
- Folders / groups organization.
- **Full-text PDF attachment extraction** — only document metadata is indexed;
  binary PDF attachments are never fetched, downloaded, or parsed.
- Any write path (read-only connector).
- Live-API credential verification (build to the documented API shape, per the
  established connector-buildout cadence).

## Decisions (resolved during brainstorming)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Item type | Reuse **`reference`** | Same domain as Zotero; unifies search; near-identical mapper. The roadmap's proposed `research_paper` predates Zotero shipping `reference`. |
| Index scope | **Documents only** | Smallest clean MVP, mirrors Zotero's top-level-items approach; annotations/folders can be a later wave. |
| Auth | **OAuth2 provider** (`mendeley.oauth`, authorization-code) | Mendeley/Elsevier offers no personal API key (unlike Zotero); reading the user's own library requires authorization-code. |
| Embedding routing | **Not prose-heavy** (mirror `zotero:reference`) | Consistency with Zotero; abstracts are length-capped; local MiniLM is sufficient. |
| Migration | **None** | Item `type` is a free per-connector string (`MappedRow<S,T>`); the items table is generic; Zotero introduced `reference` with zero migration. |

## Architecture

### Auth — OAuth2 provider (the one real delta vs. Zotero)

- Add `"mendeley"` to the exhaustive `OAuthProvider` union and an `OAUTH_PROVIDERS`
  descriptor:
  - authorize URL `https://api.mendeley.com/oauth/authorize`
  - token URL `https://api.mendeley.com/oauth/token`
  - `response_type=code`, scope `all`
  - `clientSecret: "required"`, `secretPlacement: "basic_header"`,
    `usesPkce: false` (Elsevier confidential client)
- Secret manifest: `mendeley: ["mendeley.oauth"]`. Only the resulting OAuth token
  blob is stored in Vault. User connects via `nimbus connector auth mendeley`.
- **Client credentials are user-supplied, not bundled.** Because Mendeley/Elsevier
  is a confidential client, the user registers their own Elsevier developer
  application and supplies the credentials via environment variables —
  `NIMBUS_OAUTH_MENDELEY_CLIENT_ID` and `NIMBUS_OAUTH_MENDELEY_CLIENT_SECRET` —
  exactly mirroring the confidential Notion/Zoom providers. There is **no central
  first-party auth proxy** and **no client secret baked into the (AGPL, local-first)
  client**; the secret is read from the environment only at token-exchange time and
  is never persisted to Vault, logs, or config. `Config.oauthMendeleyClientId` /
  `Config.oauthMendeleyClientSecret` expose them, with help-message constants in
  `auth/oauth-env-help-messages.ts`.
- The sync handler obtains a fresh access token via a thin
  `getValidMendeleyAccessToken(ctx.vault)` wrapper over the shared
  `getValidVaultAccessToken` (identical shape to `getValidNotionAccessToken`),
  which performs refresh-on-expiry. Refresh concurrency is handled by that shared
  accessor — not re-implemented here — and per-connector syncs are scheduler-
  serialized, so Mendeley introduces no new concurrent-refresh risk.
- **Coupling cost:** the exhaustive `OAuthProvider` union forces co-edits in
  `auth/oauth-registry.ts`, `auth/auth.ts`, `config/config.ts`, and
  `auth/oauth-env-help-messages.ts` (two new help constants) — the documented
  union-widening coupling.

### Data flow & mapping

`platform/assemble-sync-registrations.ts` registers `createMendeleySyncable` →
`connectors/mendeley-sync.ts`:

1. Load the OAuth token; if absent, return a no-op sync result (Zotero parity).
2. `GET https://api.mendeley.com/documents?view=all&limit=500` with
   `Authorization: Bearer <token>` and
   `Accept: application/vnd.mendeley-document.1+json`.
3. Incremental syncs pass `modified_since=<ISO>` as the cursor. The exact ISO
   format Mendeley accepts (millisecond precision vs. seconds, trailing `Z`) must be
   pinned against the Mendeley API docs during planning and locked with a mocked
   request assertion in `mendeley-sync.test.ts` to prevent serialization drift
   (deferred to implementation).
4. Each document → `connectors/mendeley-reference-mapping.ts` →
   `MappedRow<"mendeley","reference">` → `upsertIndexedItemForSync`.

Fields mapped: `title`, `authors` → `creators`, `year`, `abstract` (length-capped),
`identifiers.doi`, `source`/`publication`, `websites[0]` → url, `keywords`/`tags`,
`last_modified` → `modifiedAt`. Reuses `connectorFetch` accounting,
the `syncPassCursor*` helpers, the `reference` row shape, and the
`deriveTitle` / abstract-truncation logic ported from the Zotero mapper.

### Known integration detail — pagination

Mendeley paginates via the **`Link` response header** (`rel="next"` marker),
**not** offset/page params. The shared `connectorFetch` helper discards response
headers. **Resolution:** `mendeley-sync.ts` uses a focused, rate-limit-aware fetch
that reads the `Link` header to follow `rel="next"`, bounded by a `MAX_PAGES` cap
(like Zotero's page loop), leaving the shared helper untouched (no scope creep onto
the other ~80 connectors). This is the single place Mendeley deviates from a pure
Zotero clone.

The RFC 5988 `Link` parser must tolerate casing, surrounding whitespace, and
quoting variations and handle both absolute and relative next-URLs; the plan must
include explicit test arms for these variations (deferred to implementation —
code-level detail, not a spec decision).

## Wiring sites (type-coupled set)

**New files:**

- `packages/mcp-connectors/mendeley/{server.ts, search-filter.ts,
  nimbus.extension.json, package.json, tsconfig.json, README.md, test/}`
- `packages/gateway/src/connectors/{mendeley-sync.ts, mendeley-reference-mapping.ts}`

**Edited files:**

- `connectors/connector-catalog.ts` — add `mendeley` to the list, `MIN10` interval,
  auth description.
- `connectors/connector-secrets-manifest.ts` — `mendeley: ["mendeley.oauth"]`.
- `connectors/lazy-mesh/first-party-manifests.ts` — manifest with
  `network: ["api.mendeley.com"]`.
- `connectors/lazy-mesh/phase3-config.ts` — oauth-presence-gated spawn config.
- `platform/assemble-sync-registrations.ts` — register `createMendeleySyncable`.
- `auth/oauth-registry.ts`, `auth/auth.ts`, `config/config.ts`,
  `auth/oauth-env-help-messages.ts` — `OAuthProvider` union coupling.
- `docs/CHANGELOG.md` — connector delivery entry (per the connector-docs convention).
- `docs/roadmap.md` — check off the Mendeley row.

**Explicitly NOT touched:** `embedding/routing.ts` (not prose-heavy), the
`engine/executor.ts` HITL frozen set, `security-invariants.test.ts`, and any
migration file.

## Collision analysis vs. the unmerged Slice 7c branch

Mendeley is **read-only**, so it introduces no HITL action types, no `executor.ts`
change, no new invariant, and no migration. It therefore touches **none** of the
high-risk files Slice 7c is sitting on (`executor.ts`, `security-invariants.test.ts`,
the static invariant audit, invariant-count prose). Mendeley merges cleanly
regardless of when 7c lands. Any overlap is limited to additive
catalog/registration wiring (e.g. the connector list), which is trivially mergeable.

## Error handling

Mirror Zotero:

- Missing OAuth token → no-op sync result.
- First-page HTTP error → empty pass-cursor result (`syncPassCursorHttpEmpty`).
- First-page parse error → empty pass-cursor result (`syncPassCursorParseEmpty`).
- Subsequent-page failure → break the loop, return what was upserted.
- Malformed document objects → skipped by the mapper (returns `null`).

## Testing & coverage

Mirror the Zotero connector's test layers:

- `mendeley-reference-mapping.test.ts` — unit, including malformed-input arms.
- `mendeley-sync.test.ts` — fetch faked at the HTTP boundary, covering Link-header
  pagination, the `modified_since` cursor, and the http/parse-error arms.
- connector `test/sandbox.test.ts` + `test/search-filter.test.ts`.
- Registration assertions in `first-party-manifests`, `phase3-config`,
  `connector-catalog` test suites.

**Coverage-floor watch:** the true-coverage baseline is `{}`, so every new file must
clear the ≥80% line+branch floor (Docker-Linux-authoritative `audit:coverage-floor`)
before the first push.

## Risks

- **Elsevier API access** — registering a Mendeley OAuth app may be gated. We build
  to the documented API shape without live verification (per connector cadence) and
  pin the reference behavior in the implementation plan. Flagging, not blocking.
- **Link-header pagination** — the one deviation from the Zotero clone; covered by
  the dedicated fetch path above and its test arm.

## Definition of done

- `nimbus connect mendeley` completes the OAuth flow and stores the token in Vault.
- A sync indexes the user's documents as `mendeley` / `reference` items, searchable
  via `nimbus search`.
- All new files clear the coverage floor; full `bun run preflight` parity is green
  before the first push.
- `docs/CHANGELOG.md` records the delivery; the roadmap Mendeley row is checked off.

## Review triage (2026-06-14)

Reviewer feedback in `2026-06-14-slice9-mendeley-connector-design-review.md`:

- **1A — full-text PDF extraction non-goal — FIXED.** Goal reworded to "metadata";
  added to Non-goals.
- **1B — confidential-client credential supply — FIXED.** Auth section now states
  client id/secret are user-supplied via `NIMBUS_OAUTH_MENDELEY_CLIENT_ID/_SECRET`
  env vars (no proxy, no baked secret, never in Vault), mirroring Notion/Zoom; the
  connect command corrected to `nimbus connector auth mendeley`.
- **2A — Link parser robustness — DEFERRED to plan.** Implementation/test detail;
  pagination section now requires variation test arms.
- **2B — exact `modified_since` format — DEFERRED to plan.** Must be pinned against
  Mendeley docs and locked with a mocked request assertion.
- **2C — concurrent token refresh — DEFERRED (not Mendeley-scoped).** Refresh lives
  in the shared `getValidVaultAccessToken`; Mendeley inherits it and syncs are
  scheduler-serialized, so no new risk is introduced.
