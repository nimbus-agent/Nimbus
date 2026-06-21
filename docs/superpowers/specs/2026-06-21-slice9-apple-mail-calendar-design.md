# Phase 6 Slice 9 (Sub-project E) — Apple Mail + macOS Calendar connector — Design

**Date:** 2026-06-21
**Status:** Design / awaiting review
**Roadmap item:** Phase 6 → "Deferred from Phase 5" → Email & Calendar (macOS-only) → *Apple Mail + macOS Calendar*
**Branch:** `dev/asafgolombek/slice9-apple-mail-calendar`
**Siblings:** Mendeley (#631, read-only), GitOps/ML writes (#700, I26/D20 write path), Workday (sub-project B, in flight on a parallel branch — shares the registration sites; **do not co-merge**).

---

## 1. Summary

A single first-party MCP connector, service id **`apple`**, that indexes the user's **iCloud Mail** (over IMAP) and **iCloud Calendar** (over CalDAV) into the local index, and exposes four HITL-gated write tools (create/delete calendar event, send mail, save mail draft). It reuses the existing shared email tool kit for the mail side and introduces the codebase's first CalDAV/iCalendar client for the calendar side.

The connector is **cross-platform**: although the roadmap labels the item "macOS-only," the chosen transport (IMAP/SMTP/CalDAV to iCloud) is pure network protocol with no native macOS dependency — that is precisely the point of the roadmap's "via local IMAP (no Bridge required)" phrasing. See §8.

**No new security invariant and no new migration.** All four write actions already exist in the I2 HITL frozen set; the connector's write tool ids extend the **existing I26** connector-write registry (so federated peers fail-closed). New item types are registered without a schema change (the index is type-agnostic).

---

## 2. Decisions (from brainstorming)

| # | Question | Decision |
|---|---|---|
| Q1 | Credential / identity model | **iCloud-specific, one app-specific password.** Fixed iCloud endpoints; one Vault secret pair (Apple ID + a single app-specific password) reused across IMAP, SMTP, and CalDAV. |
| Q2 | Read/indexing scope | **Broad / configurable.** Mail: user-selectable mailbox set (default INBOX; Sent/Archive/etc. addable). Calendar: per-calendar selection + configurable time window + recurrence expansion controls. |
| Q3 | Write tools | **Four:** `apple_calendar_event_create`, `apple_calendar_event_delete`, `apple_mail_send`, `apple_mail_draft_create` (IMAP APPEND to Drafts, no send). |
| Q4 | Preview / PII bounds | **Capped, attendees indexed.** Mail keeps the imap contract (headers + attachment metadata + ≤2000-char preview; never full bodies/attachment bytes). Calendar indexes summary/time/location/organizer/status/recurrence + ≤2000-char notes preview; attendee emails stored in metadata. Email → 1536-dim; events → 384-dim. |
| Q5 | Platform stance | **Cross-platform, no OS gate.** Roadmap "macOS-only" label is relaxed because the transport has no native dependency. |

---

## 3. Topology & package

- New AGPL package **`packages/mcp-connectors/apple`** (stdio MCP server, mirroring `packages/mcp-connectors/imap`).
- Mail tool surface reuses the shared kit `packages/mcp-connectors/shared/imap-tool-kit.ts` `registerEmailConnectorTools({ toolPrefix: "apple", ... })`, which yields `apple_list` / `apple_get` / `apple_search` / `apple_mail_send`. The Drafts APPEND tool (`apple_mail_draft_create`) is registered alongside (the shared kit does not cover APPEND).
- Calendar adds a new **injectable `CalDavClient`** interface plus pure ICS build/parse helpers.
- **Coverage-floor structural rule:** the real socket clients (`ImapFlow`, `nodemailer` transport, the CalDAV transport) live in `server.ts` (coverage-excluded, exactly like `imap/server.ts`). All pure logic — ICS build/parse, item mapping, mailbox/calendar selection, window/recurrence math, address formatting — lives in separately-testable modules that must clear **≥85% line / ≥80% branch**.

### Module sketch (`packages/mcp-connectors/apple/src/`)
- `server.ts` — MCP bootstrap + real `ImapFlow`/`nodemailer`/CalDAV-transport clients (coverage-excluded).
- `apple-mail-core.ts` — IMAP/SMTP client interface + `formatAddress` (thin; mirrors `imap-core.ts`; may largely reuse `shared/imap-mail-core.ts`).
- `caldav-core.ts` — `CalDavClient` interface (list calendars, list events in window, put event, delete event) + result types.
- `ics.ts` — pure VEVENT build (`buildVEvent`) and parse (`parseVEvent` → normalized event record); the only genuinely new building block.
- `tools.ts` — registers the mail tools (via shared kit) + the calendar read tools + the four write tools; exports `APPLE_TOOL_NAMES`.

---

## 4. Credentials & endpoints

- **Vault secret keys** (in `connector-secrets-manifest.ts` `CONNECTOR_VAULT_SECRET_KEYS.apple`): `apple.icloud_email`, `apple.icloud_app_password`. Two keys only — the same app-password authenticates all three protocols.
- **Endpoints are fixed constants** in the connector (not config):
  - IMAP `imap.mail.me.com:993` (implicit TLS).
  - SMTP `smtp.mail.me.com:587` (STARTTLS).
  - CalDAV bootstrap `https://caldav.icloud.com` → principal discovery (`current-user-principal` → `calendar-home-set`), which returns a per-account `p##-caldav.icloud.com` calendar-home host. The client issues subsequent **authenticated** requests directly to that discovered host and **re-applies the `Authorization: Basic` header on every request** — it does not rely on transparent 30x redirect-following (many HTTP clients strip auth headers on a cross-host redirect). See §12.
- Credentials are injected into the connector process as env vars by the lazy-mesh credential orchestrator (no plaintext on disk / IPC / logs — Non-Negotiable #3).

---

## 5. Read / sync scope & item types

### 5.1 Mail → `apple:email`
- Reuses the imap email IndexItem shape (`imap-email-mapping.ts` is the reference): `type` `"email"`; `external_id` = RFC `message-id` when present, else `<mailbox>:<uidValidity>:<uid>`; `title` = subject (clamped); `bodyPreview` = ≤2000-char plain-text preview; `metadata` = `{ mailbox, uid, uidValidity, messageId, from[], to[], cc[], participants[], attachments[{filename,sizeBytes,mimeType}], attachmentCount }`.
- **Config** `[connectors.apple]`: `mailboxes` (string[], default `["INBOX"]`); per-mailbox recent-N cap (mirrors imap `clampLimit`, 1–200).
- **Privacy contract (unchanged from imap):** headers + attachment **metadata** + capped preview only. Never the full body, never attachment bytes.

### 5.2 Calendar → `apple:event`
- New item type `apple:event` (item `type` `"event"`). The index is type-agnostic, so **no migration** — registration is limited to the type union / embedding routing / any read allowlists. *(Planning will confirm whether an `event` type already exists from a Google/Outlook Calendar connector and reuse it if so.)*
- `external_id` = iCalendar `UID` (stable across syncs and across the create/delete write path).
- `title` = `SUMMARY`; `bodyPreview` = ≤2000-char `DESCRIPTION`/notes preview; `modifiedAt` from `DTSTAMP`/`LAST-MODIFIED` else event start.
- `metadata` (flat): `{ uid, calendar, start, end, allDay, location, organizer, status, recurrence, attendees[] }` where `attendees[]` carries email + (optional) display name + partstat.
- **Config** `[connectors.apple]`: `calendars` include/exclude selector (default = all calendars under the principal); `window_past_days` (default 90) + `window_future_days` (default 365); `max_instances_per_calendar` safety cap (default e.g. 1000) bounding returned events per sync.
- **Recurrence handling (server-side expansion).** The connector requests expanded occurrences from iCloud via the CalDAV `calendar-query` REPORT with `<C:time-range>` + `<C:expand>`, so the server returns concrete per-occurrence VEVENTs with `RRULE`/`EXDATE`/`RECURRENCE-ID` overrides **already applied** (modified instances reflect their new time; deleted instances are absent). This deliberately avoids a client-side RRULE/timezone engine (see §11). `external_id` for an expanded occurrence is `<UID>` for a single event and `<UID>:<RECURRENCE-ID>` for a specific occurrence, so an overridden instance is a distinct, stable item. **Fallback:** if `<C:expand>` proves unreliable for a given calendar, index the master VEVENT once with its `RRULE`/`EXDATE` preserved verbatim in `metadata.recurrence` (unexpanded) and parse any server-returned override VEVENTs (those carrying `RECURRENCE-ID`) as distinct `<UID>:<RECURRENCE-ID>` items.

---

## 6. Write tools, HITL & invariants

### 6.1 Tools → HITL action types

| Tool | Mechanism | HITL action (already in `HITL_REQUIRED_BACKING`) |
|---|---|---|
| `apple_calendar_event_create` | CalDAV `PUT` a new VEVENT `.ics` to the target calendar collection | `calendar.event.create` |
| `apple_calendar_event_delete` | CalDAV `DELETE` the event resource (by href/UID) | `calendar.event.delete` |
| `apple_mail_send` | SMTP send (compose → HITL preview → send) | `email.send` |
| `apple_mail_draft_create` | IMAP `APPEND` to the Drafts mailbox (no send) | `email.draft.create` |

- **No new I2 frozen-set entries.** All four action types already exist in `engine/executor.ts` `HITL_REQUIRED_BACKING` (added earlier for Gmail/Outlook/IMAP + Google/Outlook Calendar). The executor consent gate fires on `action.type` only (I3); `apple_*` tool ids never appear in the gate.
- `apple_mail_send` reuses the exact HITL path the existing `imap_mail_send` uses (`email.send`).
- **Forced sender.** iCloud SMTP rejects a `From` that does not match the authenticated account (`554 5.7.1 …`). `apple_mail_send` therefore **forces the envelope/`From` sender to `apple.icloud_email`** and ignores any caller-supplied `From` — mirroring the existing `NodemailerMailer` (`from = this.from = authenticated user`). Same for the `apple_mail_draft_create` APPEND (the drafted message's `From` is set to the authenticated address).

### 6.2 I26 extension (federated-peer write confinement)

The federated invoke gate (`federation/invoke-gate.ts` `answerFederatedInvoke`) fail-closes any tool id for which the injected `isWriteForbiddenToolId` predicate returns true — currently wired to `isConnectorWriteToolId` (= warehouse/BI ∪ GitOps/ML). The Apple write tool ids are **not** in that union today, so to keep I26 ("connector write actions execute only behind the LOCAL owner's HITL gate; the federated peer invoke gate fail-closed rejects any write-classified tool id … the union `isConnectorWriteToolId`") honest, they must join it.

**Wiring:**
- New SSoT `packages/gateway/src/connectors/apple-write-tools.ts` exporting `APPLE_WRITES` (the four `ConnectorWrite` records via the `w()` helper), `isAppleWriteToolId`, `appleWriteByActionType` — mirroring `gitops-ml-write-tools.ts`.
- `connector-write-registry.ts`: add `...APPLE_WRITES` to `CONNECTOR_WRITES`, OR `isAppleWriteToolId(id)` into `isConnectorWriteToolId`, and `appleWriteByActionType` into `connectorWriteByActionType`.

> **Action-type collision caveat (resolved in planning):** the four action types are *generic* (`email.send`, etc.) and may already be the dispatch key for imap/gmail/outlook. The connector-write registry's `BY_ACTION_TYPE` map is for credential-aware dispatch routing; the Apple write *tool ids* are distinct (`apple_*`). Planning will read the existing generic email/calendar dispatch path **and** the gitops/ml write dispatch path (2–3 real call sites) to decide whether `apple_*` writes route through the generic executor path or the connector-write dispatch path, and to ensure no `BY_ACTION_TYPE` key collision. The I26 federation-confinement requirement (tool ids in `isConnectorWriteToolId`) holds regardless.

### 6.3 Triple rule (one commit)

Because this **extends I26** (not a new invariant), the triple lands together:
1. **Wiring** — `apple-write-tools.ts` + the `connector-write-registry.ts` union edits.
2. **Docs** — update the **I26** row in `docs/SECURITY-INVARIANTS.md` (and the matching line in CLAUDE.md/GEMINI.md only if its I26 prose enumerates groups; per convention connector *deliveries* are logged in `docs/CHANGELOG.md`, not the status line).
3. **Test** — `packages/gateway/src/security-invariants.test.ts`: assert each `apple_*` write id is write-forbidden by `isConnectorWriteToolId`, and (HITL) that the gate fires for each of the four action types before dispatch.
4. **Static D20** — add `apple-write-tools.ts` to the allowed write-tool-id sites in `scripts/structure-audit/check-nimbus-invariants.ts` so the confinement check passes.

---

## 7. Embedding routing & PII bounds

- Add **`apple:email`** to `PROSE_HEAVY_TYPES` (`embedding/routing.ts`) → 1536-dim (OpenAI when configured; MiniLM fallback otherwise), matching `imap:email` / `fastmail:email`.
- **`apple:event`** is *not* added → routes to the 384-dim MiniLM default (same as `google_meet:meeting`).
- Preview caps as in §5: ≤2000 chars for both the mail preview and the event notes preview; attendee emails are indexed (parity with how Google/Outlook calendar items index attendees, enabling people-graph linking).

---

## 8. Platform stance

No OS gate. There is **no precedent** for an OS-gated connector in the codebase (no `process.platform`/`darwin` checks in `connectors/`, and no platform field on the connector catalog/manifest), and the transport has no native macOS dependency. The connector is available and tested on macOS, Windows, and Linux via the normal 3-OS CI matrix. The spec records the relaxation of the roadmap's "macOS-only" label so the roadmap row can be annotated accordingly on delivery.

---

## 9. Registration sites (the 9)

Each grounded by reading the live `imap` / `mendeley` registration during planning:

1. `connectors/connector-catalog.ts` — `CONNECTOR_SERVICE_IDS` (`"apple"`), `CONNECTOR_SYNC_INTERVAL_MS` (`apple: MIN5`), `OAUTH_UNSUPPORTED_DETAILS` (app-password explanation).
2. `connectors/connector-secrets-manifest.ts` — `CONNECTOR_VAULT_SECRET_KEYS.apple` (the two keys in §4).
3. `connectors/lazy-mesh/keys.ts` — connector key entry.
4. `connectors/lazy-mesh/connector-spawns.ts` — spawn function mapping the two Vault secrets → connector env (`APPLE_ICLOUD_EMAIL`, `APPLE_ICLOUD_APP_PASSWORD`).
5. `connectors/lazy-mesh/mesh.ts` — ensure/collect wiring.
6. `connectors/lazy-mesh/credential-orchestration.ts` — conditional spawn when the app-password secret is set.
7. `sync/rate-limiter.ts` — `Provider` union + `DEFAULT_QUOTAS.apple` (e.g. `{ requestsPerMinute: 60, burstSize: 10 }`).
8. `platform/assemble-sync-registrations.ts` — register the apple syncable (`createAppleSyncable`) producing both `apple:email` and `apple:event` items.
9. Root `package.json` — `"packages/mcp-connectors/apple"` workspace entry (bun.lock regenerates).

> **Merge hygiene:** sites 1–9 overlap exactly with the in-flight Workday branch. Apple must be **rebased onto main after Workday lands** and those sites re-resolved; do not co-merge.

---

## 10. Testing

- **Connector contract tests:** tool surface (`APPLE_TOOL_NAMES`), preview ≤2000 cap, no-full-body / no-attachment-bytes invariant, ICS build/parse round-trip.
- **Pure-logic unit tests:** `ics.ts`, mapping, mailbox/calendar selection, window + recurrence-expansion math, address formatting — to clear the coverage floor.
- **HITL enforcement test:** the gate fires for all four write action types before connector dispatch.
- **I26 test:** each `apple_*` write id is rejected by `isConnectorWriteToolId` (federated-peer fail-closed).
- **Sync integration test:** real SQLite + injected `ImapClient`/`CalDavClient` (no sockets), asserting `apple:email` + `apple:event` items land with the right shapes and embedding routing.
- **Pre-first-push gate (no push-and-see):** full `bun run preflight` + the Docker-Linux coverage-floor check (authoritative for new non-`server.ts`/`tools.ts` files) + a whole-branch `/code-review` + `audit:package-readmes` (public-tier README sections).

---

## 11. Out of scope (YAGNI)

- `calendar.event.update` (roadmap scopes create/delete only).
- CardDAV / contacts.
- Attachment bytes; full message bodies.
- Native EventKit / Mail.app / local-store access (the IMAP/CalDAV transport is deliberate).
- Non-iCloud IMAP/CalDAV hosts (the generic `imap` connector already covers arbitrary IMAP).
- **A client-side RRULE/timezone recurrence engine** — recurrence is expanded server-side via CalDAV `<C:expand>` (§5.2); the connector does not synthesize occurrences itself.
- **Real-time push (IMAP IDLE / CalDAV push).** Sync is periodic pull on the `MIN5` interval (§9); the lazy-mesh idle-disconnect model makes a persistent IDLE socket impractical.

---

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| First CalDAV/ICS code in the repo; correctness of recurrence handling | Offload recurrence to iCloud via CalDAV `<C:expand>` (no client-side RRULE engine — §5.2); keep ICS build/parse pure + heavily unit-tested with override/EXDATE fixtures; bound results with `max_instances_per_calendar`; inject the CalDAV transport so tests never hit a socket. |
| CalDAV auth dropped on the cross-host redirect to `p##-caldav.icloud.com` | Re-apply `Authorization: Basic` on every request to the discovered calendar-home host; do not depend on transparent redirect-following (§4). |
| iCloud SMTP rejects a mismatched `From` | Force the sender to the authenticated `apple.icloud_email` in send + draft (§6.1). |
| New npm dep(s) for CalDAV transport / ICS parsing | Run the `bun add` dependency-safety pre-flight in planning; prefer a small, maintained lib for transport and keep parse/build logic in-repo (testable, fewer surprises). |
| Coverage floor on a network-heavy connector | Real clients confined to coverage-excluded `server.ts`; all logic in tested modules (the proven imap pattern). |
| Merge conflicts on the 9 shared sites with Workday | Rebase after Workday lands; resolve sites last. |
| iCloud per-account CalDAV host redirect | Resolve the calendar-home host via principal discovery from the `caldav.icloud.com` bootstrap, then address that host directly (see the auth row above). |

---

## 13. Definition of done

- `apple` connector indexes iCloud Mail + Calendar; four write tools gated by the existing HITL actions.
- I26 extended (wiring + docs + test + static D20) in one commit; security-invariants suite green.
- `apple:email` routed 1536-dim; `apple:event` 384-dim.
- Cross-platform; full `preflight` + Docker coverage-floor + `/code-review` clean before first push.
- `docs/CHANGELOG.md` entry; roadmap row checked with the macOS-only-relaxed note.

---

## 14. Review resolutions (2026-06-21)

From `2026-06-21-slice9-apple-mail-calendar-design-review.md` — all four **fixed** inline:

1. **iCloud SMTP `From` validation** → **Fixed (§6.1).** `apple_mail_send` (and the draft APPEND) force the sender to the authenticated `apple.icloud_email`, ignoring any caller `From`. This is already the existing `NodemailerMailer` behavior; the spec now makes it explicit.
2. **Auth propagation across the CalDAV cross-host redirect** → **Fixed (§4, §12).** The client addresses the discovered `p##-caldav.icloud.com` host directly and re-applies `Authorization: Basic` on every request rather than relying on transparent 30x following (which can strip auth headers).
3. **Recurrence exceptions (`RECURRENCE-ID` / `EXDATE`)** → **Fixed by design change (§5.2, §11, §12).** Adopted **server-side `<C:expand>`** so iCloud applies overrides/exclusions and returns concrete occurrences; a client-side RRULE/timezone engine is explicitly out of scope. Overridden occurrences key on `<UID>:<RECURRENCE-ID>`. A documented fallback indexes the unexpanded master + server-returned override VEVENTs.
4. **IMAP IDLE vs pull** → **Fixed (§11).** Real-time IMAP IDLE / CalDAV push is explicitly out of scope; sync is periodic pull on `MIN5`.
