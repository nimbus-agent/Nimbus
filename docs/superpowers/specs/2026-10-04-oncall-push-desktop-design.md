# On-call pushed brief, PR 3: desktop panel — design

**Date:** 2026-10-04 · **Status:** draft for review · **Roadmap:** Phase 17 W2, the last of three PRs
**Branch:** `dev/asaf/oncall-push-desktop`, cut from `origin/main` at `131d0af0` (after #1600 and release #1601).
This spec never lands on `main`. It is stripped before the implementation PR.
**Builds on:** PR 1 (#1592): `oncall-push/`, `pushed_brief` (V64), `oncall.pushed*` IPC, the `oncall.briefPushed`
gateway event. PR 2 (#1600): the ChatOps sink, `push-headline.ts`, `delivery_json.chatops`.

## 1. Purpose

PR 1 stores a brief for every new P1 assigned to the local owner and announces it with a gateway event. PR 2 posts a
headline to the team's channel. PR 3 gives the owner a screen in the desktop app where pushed briefs appear the moment
they are stored, can be read in full, and show where each one was delivered.

### Agreed understanding (2026-10-04)

| | |
|---|---|
| Why now | The desktop app has no release vehicle until Phase 13 (signed installers, still "Planned"). PR 3 is built now so that Phase 13 ships with the panel already in place. It reaches users who build the app from source until then. |
| Placement | Its own page, `/oncall`, with an "On-call" sidebar entry that shows a dot while there is a brief newer than the last one seen. |
| Brief view | The stored markdown, shown verbatim as preformatted text. No markdown renderer and no new dependency. |
| Liveness | Event-driven: the panel refetches when an `oncall.briefPushed` gateway event arrives. A 60 s poll is the backstop. |
| Allowlist | `oncall.pushedList` and `oncall.pushedGet` join `ALLOWED_METHODS` (105 → 107). `oncall.pushedRetry` stays CLI-only. |
| Out of scope | The `nimbus doctor` warning for a ChatOps sink that cannot post, and escaping the existing `@nimbus agent` replies. Neither touches the desktop, and the escape fix is a ChatOps security change that gets its own PR. Also out: a retry button, a markdown renderer, OS notifications from the desktop, and the VS Code extension. |

## 2. Architecture

### 2.1 Approaches considered

- **A. Event-driven with a slow poll backstop (chosen).** The panel subscribes to the existing `gateway://notification`
  stream and refetches on `gateway.event` with `kind: "oncall.briefPushed"`. A 60 s poll covers events missed while
  the bridge reconnects.
  - The Tauri bridge already forwards EVERY gateway notification as `gateway://notification`
    (`gateway_bridge.rs` `run_read_loop`), so no Rust event plumbing is needed.
- **B. Poll only.** This is what `AuditFeed` does: `useIpcQuery` at 10 s. It is the simplest, but up to 10 s late, and
  it ignores the event PR 1 built for this panel.
- **C. A dedicated Tauri event.** `classify_notification` would re-emit `oncall://brief-pushed`, as it does for
  `connector.healthChanged`. That adds Rust code and tests for no gain over A.

### 2.2 Components

| Unit | Change |
|---|---|
| `ui/src-tauri/src/gateway_bridge.rs` | `"oncall.pushedGet"` and `"oncall.pushedList"` are added to `ALLOWED_METHODS` in sorted position. Neither is in `NO_TIMEOUT_METHODS`. |
| `gateway/src/ipc/oncall-push-rpc.ts` | `PushedBriefSummary` gains `service: string \| null`, and so `PushedBriefDetail` gains it too. |
| `gateway/src/oncall-push/push-headline.ts` (or a sibling) | A shared `resolvePushService(row, incident)` returns the brief's `binding.nimbusServiceId`, then the incident's PagerDuty service id, then `null`. Empty strings fall through. The ChatOps headline uses the same resolver, with `"unknown service"` as its own display fallback, so the desktop and Slack name a service identically. |
| `gateway/src/oncall-push/push-store.ts` | A list query that LEFT JOINs `item` (`i.id = pb.incident_id AND i.type = 'incident'`) and returns the incident title and PagerDuty service id with each row. `summarize` then makes no per-row query (today it already makes one per row for the title). The service id is read as `CASE WHEN json_valid(i.metadata) THEN json_extract(i.metadata, '$.pagerduty_service_id') END`. A bare `json_extract` RAISES on malformed JSON, and in a projection one bad `item.metadata` row would fail the whole list. A pushed row whose incident was pruned from `item` still lists, with `title` and `service` both null. `incidentTitle` stays for `pushedGet`. |
| `cli` `nimbus oncall pushed list` | Each line becomes `<ISO time>  <status>  <incident id>  [<service>]  <title>`. The bracketed service is omitted entirely when null, so the line reads exactly as it does today. |
| `ui/src/ipc/types.ts` | `PushedBriefList` = `{ enabled: boolean; identity: "resolved" \| "unresolved"; briefs: PushedBriefSummary[] }`. `PushedBriefSummary` = `{ incidentId; status: "ok" \| "failed"; createdAt; retriedAt: number \| null; title: string \| null; service: string \| null }`. `PushedBriefDetail` adds `briefMarkdown: string \| null; failureCode: string \| null; delivery: Record<string, { outcome: string; reason?: string; at: number }>`. |
| `ui/src/providers/OncallBriefsProvider.tsx` (new) | Mounted ONCE in `RootLayout`, around the sidebar and the outlet. It owns the single list query and the single event subscription below, and exposes them through `useOncallBriefs()` (context). The sidebar dot and the page read the same state, so one event causes one refetch, not two. `useOncallBriefs()` outside the provider throws, which is a programming error caught by tests. |
| `ui/src/hooks/useOncallBriefs.ts` (new) | The provider's implementation. It wraps `useIpcQuery<PushedBriefList>("oncall.pushedList", 60_000, { limit: 50 })` and subscribes to `gateway://notification` through `createIpcClient().subscribe()` (the same stream; the pattern `ConnectorsPanel` uses, and the one `src/ipc/__mocks__/client.ts`'s `subscribeMock` covers in tests). It calls `refetch()` only for `method === "gateway.event"` with `params.kind === "oncall.briefPushed"`. A malformed `params` is ignored, never thrown, and it is narrowed from `unknown` (no `any`). It also exposes `lastPushed: { incidentId: string; seq: number } \| null`, where `seq` increments on every matching event, so a consumer can react to an event for one id without opening a second subscription. Reconnects need nothing extra: `useIpcQuery` reruns when `connectionState` returns to `connected`. |
| `ui/src/pages/Oncall.tsx` (new) | The page: `BriefList` on the left, `BriefDetail` on the right. The selection is the `id` URL search param. With none and at least one brief, the page writes the newest id into the URL with `setSearchParams(..., { replace: true })`, so reload and back/forward keep the selection without adding a history entry. While the page is mounted, an effect calls `markPushedSeen(newest.createdAt)` whenever the newest brief changes, not only on mount, so a brief that arrives while you are looking at the page never lights the sidebar dot. |
| `ui/src/components/oncall/BriefList.tsx` (new) | One row per brief: title (or the incident id when the title is null), service, status, and age. The selected row is highlighted. |
| `ui/src/components/oncall/BriefDetail.tsx` (new) | Fetches `oncall.pushedGet { incidentId }` for the selection through `useIpcQuery` (60 s). Switching selection changes the params, and `useIpcQuery`'s generation counter already drops a response that arrives after a newer request, so rapid clicks never show a stale brief. It opens NO subscription of its own: it calls `refetch()` when the provider's `lastPushed` changes and names its `incidentId`, which covers a retry that turned `failed` into `ok`. It renders the markdown verbatim and the `DeliveryStrip`. A failed row shows its `failureCode` and the command `nimbus oncall pushed <id> --retry`. |
| `ui/src/components/oncall/DeliveryStrip.tsx` (new) | One chip per sink present in `delivery`, in a fixed order (`event`, `toast`, `chatops`, then any others alphabetically): the outcome plus its reason. An absent sink renders nothing. |
| `ui/src/store/slices/oncall.ts` (new) | `lastSeenPushedAt: number` (0 initially) and `markPushedSeen(createdAt)`, which only ever moves forward. `lastSeenPushedAt` joins `WHITELISTED_PERSIST_KEYS`. |
| `ui/src/components/chrome/Sidebar.tsx` | A new `ENTRIES` row, `{ to: "/oncall", icon: "☎", label: "On-call" }`, after Dashboard. It shows a dot when the newest brief's `createdAt > lastSeenPushedAt`. The newest brief comes from `useOncallBriefs()`, the provider's context. The dot carries an accessible label ("new pushed brief"), not colour alone. |
| `ui/src/components/chrome/NavItem.tsx` | Today `badge` is `number` only. It gains `dot?: boolean`, rendered as a small accent dot plus a visually hidden "new pushed brief" text. The numeric badge is unchanged, and a `badge > 0` takes precedence over `dot` when both are set. |
| `ui/src/App.tsx` | `<Route path="oncall" element={<Oncall />} />`. |

### 2.3 Data flow

```text
push run stores a row
  └─ emitGatewayEvent("oncall.briefPushed", { incidentId, status })        // PR 1, id + status only
       └─ gateway.event broadcast → Tauri bridge → "gateway://notification"
            └─ useOncallBriefs: kind matches → refetch oncall.pushedList     // list + sidebar dot update
                 └─ BriefDetail (if that id is selected): refetch oncall.pushedGet
```

The brief body travels only in the `oncall.pushedGet` response, fetched when a brief is opened. The event never carries
it, which is PR 1's rule.

### 2.4 Invariants

- **I7 (Tauri allowlist).** Two read-only methods are added. Neither is RCE-class: they read stored briefs and
  delivery outcomes, and write nothing.
  - `oncall.pushedRetry`, which spawns an agent run, stays off the list. A test asserts it is absent by name.
  - The Rust test asserts the count (107) AND both names. The new entries go between `"llm.unloadModel"` and
    `"policy.show"`, in the list's sorted order.
  - `packages/gateway/src/security-invariants.test.ts` ALSO pins the size: its I7 test "allowlist_exact_size assertion
    is 105" greps the Rust file for `assert_eq!(ALLOWED_METHODS.len(), 105)`. It moves to 107, and gains a named
    assertion that `oncall.pushedRetry` is absent. (Found in review; the first draft listed only the Rust test.)
  - `ipc/allowlist-resolves.test.ts` checks that every allowlisted method resolves to a live handler. It covers the
    two new entries with no change, because both are already routed.
  - The I7 prose ledger in `docs/SECURITY-INVARIANTS.md` re-derives its enumeration, not just its count, as does the
    `nimbus-tauri-allowlist` skill if it restates either.
- **I8 (CSP).** Unchanged. The markdown is a React text child inside a `<pre>`, with no `dangerouslySetInnerHTML` and
  no link parsing, so a URL in a brief shows as text.
- **LAN.** The `oncall` namespace stays in `FORBIDDEN_OVER_LAN`. Adding a method to the Tauri allowlist does not make
  it LAN-reachable.
- No new invariant, static rule, egress class, IPC method or migration.

## 3. Failure handling

| Situation | Shown |
|---|---|
| Gateway offline | The existing `GatewayOfflineBanner`. The page keeps its last data and shows no error of its own. |
| `pushedList` or `pushedGet` RPC error (e.g. an older gateway answering `Method not found`) | An inline error with the message and the CLI fallback, `nimbus oncall pushed`. |
| `enabled: false` | Empty state, matching `nimbus oncall pushed`'s `PUSH_OFF_HINT` (`cli/src/commands/oncall-pushed.ts`): "On-call push is off. Set [oncall.push] enabled = true in nimbus.toml." |
| `identity: "unresolved"` (with `enabled: true`) | Empty state, matching `nimbus doctor`'s `doctorPrintOncallPush` (`cli/src/commands/doctor-core.ts`): "On-call push is enabled but your identity is unresolved, so no incident can be selected. Set [user] me_person_id in nimbus.toml or `git config user.email`." |
| Enabled, identity resolved, no rows | "No pushed briefs yet." |
| `pushedGet` returns `{ brief: null }` for the selection | "This brief was pruned (older than `retention_days`)." The selection is cleared from the URL. |
| A row with `title: null` | The list shows the incident id. |

## 4. Testing

**Contract: the one test that binds the two packages.**
- A gateway test builds real rows: the demo seed plus `fireDemoPage` for an `ok` row, and a forced `failed` row
  produced through the real runner with a refusing dispatch.
- It calls the real `dispatchOncallPushRpc` for `oncall.pushedList` and `oncall.pushedGet`, normalises the volatile
  fields (times, session ids), and asserts the result equals the committed fixture
  `packages/ui/test/fixtures/oncall-pushed.json`.
- The desktop tests load that same file. A gateway shape change fails the gateway test until the fixture is
  regenerated, and the desktop tests then run against the new shape.
- It reads a JSON file, never source, so the IPC-only dependency rule holds.

**Gateway (`bun test`).**
- `resolvePushService`: a mapped service, the PagerDuty fallback, `null`, and empty strings.
- `PushStore` list query:
  - One `item` row with malformed `metadata` does not fail the list. That row's `service` is null and every other row
    is intact. Red-proved by dropping the `json_valid` guard.
  - A pushed row whose incident is gone from `item` still lists, with `title` and `service` null.
- CLI `pushed list`: the `[service]` segment appears when the service is non-null. When it is null the line is
  byte-identical to today's format.
- `pushedList` rows carry `service`. The ChatOps headline still renders the same service as before (PR 2's tests stay
  green).

**Rust (`gateway_bridge.rs` tests).**
- `ALLOWED_METHODS.len() == 107`.
- `is_method_allowed("oncall.pushedList")` and `is_method_allowed("oncall.pushedGet")`.
- `!is_method_allowed("oncall.pushedRetry")`.
- Neither new method is no-timeout.

**Desktop (vitest + Testing Library, under `packages/ui/test/`).**
- `useOncallBriefs`:
  - An `oncall.briefPushed` notification causes exactly one refetch.
  - Another `gateway.event` kind, `connector.healthChanged`, `params: null`, and `params` without `kind` cause none.
  - Red-proved by removing the kind filter.
- `Oncall` page:
  - The list renders from the fixture, and the newest brief is auto-selected.
  - `?id=` selects a brief.
  - The detail shows the markdown verbatim.
  - A brief containing `<img src=x onerror=alert(1)>` renders as literal text, and the DOM gains no `img`.
  - A failed row shows its code and the retry command, with no retry button.
  - There are three empty states (disabled, unresolved, none), the pruned state, and the RPC-error state.
- `DeliveryStrip`: the fixed order, outcome and reason; an absent sink renders nothing; and no "undefined" text ever
  appears.
- Live arrival while `/oncall` is open: the list updates, `lastSeenPushedAt` advances to the new brief, and the
  sidebar dot stays off.
- URL: `/oncall` with briefs becomes `/oncall?id=<newest>` through a REPLACE, so history length is unchanged. A pruned
  `?id=` is removed.
- Rapid selection: resolving `pushedGet` for A after B was selected never shows A's brief.
- `BriefDetail` refetches when `lastPushed` names its id, and not for another id.
- `NavItem`: `dot` renders a dot and its hidden label. `badge > 0` wins over `dot`. Existing badge tests are unchanged.
- Sidebar dot:
  - It is shown when the newest `createdAt > lastSeenPushedAt`, and hidden after `/oncall` mounts.
  - `markPushedSeen` never moves backwards.
  - The value survives a store rehydrate.
- Partialize: `lastSeenPushedAt` is persisted, and the existing forbidden-key scrub still holds.
- Every new test is red-proved by reverting its fix.

## 5. Documentation

- `docs/SECURITY-INVARIANTS.md` I7: the allowlist ledger, 105 → 107, with the enumeration re-derived.
- `docs/architecture.md`: the oncall-push section gains the desktop panel, and its Not-shipped list drops it.
- `docs/cli-reference.md`: `nimbus oncall pushed` mentions the desktop page, and `list` mentions the `service` column.
- `docs/CHANGELOG.md` and the roadmap "Pushed incident brief" row (PR 3 of 3).
- `CLAUDE.md` / `GEMINI.md`: the Status sentence for the on-call push, kept byte-identical.
- The `nimbus-tauri-allowlist` skill, if it restates the count or the list.

## 6. Decisions and follow-ups

- **No retry button.** `oncall.pushedRetry` starts an agent run on the owner's behalf. The renderer sits behind the I7
  XSS boundary, and a retry is one CLI command away. The detail view prints that command.
- **No copy buttons, for now** (review § 3.3, deferred). The brief and the retry command are plain, selectable text:
  nothing in the app sets `user-select: none`. A copy button needs the clipboard from inside the Tauri webview, which
  is its own permissions question (the `clipboard-manager` plugin or a webview Clipboard API check per platform).
  It is worth doing once, for every screen, not inside this PR.
- **No markdown renderer** (decided 2026-10-04). Preformatted text needs no dependency and no CSP review, and it
  matches the CLI. A renderer can come later as its own change, reusable by other screens.
- **Follow-ups, not in this PR:**
  - A `nimbus doctor` warning when `chatops_namespace` is set but ChatOps is disabled or the namespace has no notify
    channels. `doctorPrintOncallPush` (`cli/src/commands/doctor-core.ts`) already reads `oncall.pushedList`, so the
    warning extends that check rather than adding a new one.
  - Escaping the existing `@nimbus agent …` ChatOps replies with `escapeSlackText`.
  - An assembly-level test driving a real P1 through the booted ChatOps graph, deferred from PR 2.

## 7. Review dispositions (2026-10-04)

From `2026-10-04-oncall-push-desktop-design-review.md`. Each claim was checked against `origin/main` at `131d0af0`.

| Review item | Disposition |
|---|---|
| Q1 dot lights while on `/oncall` | **Fixed.** `markPushedSeen` runs whenever the newest brief changes while the page is mounted, not only on mount (§ 2.2), and a test covers it (§ 4). |
| Q2 URL sync | **Fixed.** The page writes the newest id into the URL with `replace: true` (§ 2.2). |
| Q3 CLI `list` format | **Fixed.** `[<service>]` sits before the title and is omitted when null, so null rows print exactly as today (§ 2.2, § 4). |
| Q4 `BriefDetail` subscription | **Fixed, differently from the suggestion.** The review proposed a second, direct subscription in `BriefDetail`, read through `(n.params as any)`. That reopens the double-subscription the provider exists to prevent, and `any` is a Non-Negotiable. The provider instead exposes `lastPushed`, and `BriefDetail` refetches when it names its id. Stale responses are already handled by `useIpcQuery`'s generation counter (`hooks/useIpcQuery.ts`). |
| § 3.1 N+1 queries | **Fixed, with a correction.** A joined list query was adopted. The suggested `json_extract(i.metadata, …)` in the projection would RAISE on one malformed `metadata` row and fail the whole list, so it is guarded with `json_valid` (§ 2.2), with a test (§ 4). |
| § 3.2 `NavItem` | **Fixed.** Verified that `badge` is `number` only (`NavItem.tsx:8`). `NavItem` gains `dot` (§ 2.2). |
| § 3.3 copy buttons | **Deferred** (§ 6). The text is already selectable: nothing in `ui/src` sets `user-select: none`. Clipboard access from the Tauri webview is its own permissions decision, best made once for the whole app. |
| § 4 edge-case table | **No change, except one confirmation.** Reconnect is verified: `useIpcQuery`'s effect depends on `connectionState`, so it re-runs when the gateway returns to `connected`. Every other row is already covered by § 3 and § 4. |
| § 5 security checklist | **One real gap fixed:** `security-invariants.test.ts` pins `ALLOWED_METHODS.len() == 105` by grepping the Rust file. The first draft missed it (§ 2.4). The sorted insertion point (between `llm.unloadModel` and `policy.show`) is verified. The remaining items restate the spec. |
| § 6 next steps | Steps 1 and 3 are done above. Step 2 is the next stage. |
