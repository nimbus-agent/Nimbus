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

A **read-only** first-party MCP connector that indexes the user's Mendeley library
documents (papers, PDFs, citations) into the local index as **`reference`** items —
the same item type the shipped Zotero connector uses — so `nimbus search` treats
both reference managers uniformly (the `service` field distinguishes
`mendeley` vs `zotero`). Implemented as a Zotero-style clone: a thin MCP server
stub plus a gateway-side sync handler and mapper.

### Non-goals (MVP)

- Annotations / highlights.
- Folders / groups organization.
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
- Secret manifest: `mendeley: ["mendeley.oauth"]`. Token blob stored in Vault.
  User connects via `nimbus connect mendeley`.
- The sync handler obtains a fresh access token via a
  `getValidMendeleyAccessToken(ctx.vault)` accessor (mirrors
  `getValidNotionAccessToken`), refreshing on expiry.
- **Coupling cost:** the exhaustive `OAuthProvider` union forces co-edits in
  `auth/oauth-registry.ts`, `auth/auth.ts`, `config/config.ts`, and
  `auth/oauth-env-help-messages.ts` (the documented union-widening coupling).

### Data flow & mapping

`platform/assemble-sync-registrations.ts` registers `createMendeleySyncable` →
`connectors/mendeley-sync.ts`:

1. Load the OAuth token; if absent, return a no-op sync result (Zotero parity).
2. `GET https://api.mendeley.com/documents?view=all&limit=500` with
   `Authorization: Bearer <token>` and
   `Accept: application/vnd.mendeley-document.1+json`.
3. Incremental syncs pass `modified_since=<ISO>` as the cursor.
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
