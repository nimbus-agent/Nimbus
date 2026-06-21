# Apple Mail + macOS Calendar Connector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a single first-party MCP connector (`apple`) that indexes iCloud Mail (IMAP) and iCloud Calendar (CalDAV) into the local index and exposes four HITL-gated write tools (calendar create/delete, mail send, mail save-to-draft).

**Architecture:** One AGPL package `packages/mcp-connectors/apple` (stdio MCP server). Mail reuses the shared `imap-tool-kit` + the gateway's existing `fetchImapMessages` / `mapImapLikeMessageToItem`. Calendar adds the codebase's first CalDAV path: a pure in-repo iCalendar build/parse module + an injectable `CalDavClient` whose real (network) implementation is confined to the coverage-excluded `server.ts`. Writes ride the **generic** email/calendar dispatch path (like `imap_mail_send`), protected by the **existing** executor I2 HITL gate — no connector-write-registry / I26 work (see spec §6.2).

**Tech Stack:** Bun + TypeScript 6 strict · `@modelcontextprotocol/sdk` · `imapflow` + `nodemailer` (reused via the shared kit) · `tsdav` (CalDAV transport, confined to `server.ts` + a gateway factory) · in-repo iCalendar parse/build (no parser dependency).

**Design spec:** [`docs/superpowers/specs/2026-06-21-slice9-apple-mail-calendar-design.md`](../specs/2026-06-21-slice9-apple-mail-calendar-design.md)

## Global Constraints

- **No `any`** — `unknown` for external data; TS strict; `exactOptionalPropertyTypes` is on (omit optional keys, never assign `undefined`).
- **No plaintext credentials** — creds reach the connector only as env vars injected by the lazy-mesh spawner; never logged/IPC'd/written.
- **Coverage floor (CI-Linux authoritative):** every NEW non-`server.ts` / non-`tools.ts` file under `packages/{gateway,cli,sdk}` must clear **≥85% line / ≥80% branch**. Keep real network clients in `server.ts` (excluded); keep pure logic in separately-tested modules.
- **Credentials:** iCloud-specific. Vault keys `apple.icloud_email`, `apple.icloud_app_password` (the single app-specific password authenticates IMAP+SMTP+CalDAV). Endpoints are fixed constants: IMAP `imap.mail.me.com:993` (TLS), SMTP `smtp.mail.me.com:587` (STARTTLS), CalDAV bootstrap `https://caldav.icloud.com`.
- **Env var names** injected into the connector: `APPLE_ICLOUD_EMAIL`, `APPLE_ICLOUD_APP_PASSWORD`.
- **Item types:** `apple:email` (reuses the email IndexItem shape) and `apple:event` (new `event` type; index is type-agnostic → no migration).
- **PII bounds:** mail = headers + attachment METADATA + ≤2000-char preview (never bodies/bytes); calendar = summary/start/end/location/organizer/status/recurrence + ≤2000-char notes preview + attendee emails.
- **Writes ride the generic path** — `payload.mcpToolId = "apple_*"`, `action.type` = the existing generic HITL action. **No** `apple-write-tools.ts`, **no** `connector-write-registry.ts` / D20 / `SECURITY-INVARIANTS.md` edits.
- **Forced sender:** `apple_mail_send` + `apple_mail_draft_create` force `From` to the authenticated `apple.icloud_email`.
- **Recurrence:** server-side via CalDAV `<C:expand>`; NO client-side RRULE engine. Overridden occurrences key on `<UID>:<RECURRENCE-ID>`.
- **Platform:** cross-platform, no OS gate.
- **Merge hygiene:** the 9 registration sites (Phase H) collide with the in-flight Workday branch — rebase apple onto main AFTER Workday lands; resolve those sites last. Do not co-merge.
- **Commit discipline:** one commit per task (TDD: test → impl → green → commit). Branch `dev/asafgolombek/slice9-apple-mail-calendar`. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Controller-runs-tests caveat:** if implementer subagents are denied Bash/git, they edit files only; the controller runs `bun test` / `tsc` / commits.

---

## Phase A — Connector package scaffold + mail tools

### Task A1: Scaffold the `apple` connector package

**Files:**
- Create: `packages/mcp-connectors/apple/package.json`
- Create: `packages/mcp-connectors/apple/tsconfig.json`
- Modify: root `package.json` (workspaces array)

**Interfaces:**
- Produces: a buildable workspace package `@nimbus-dev/mcp-apple` (name mirrors siblings — verify the exact `name` convention from `packages/mcp-connectors/imap/package.json`).

- [ ] **Step 1: Copy the imap package manifest as the template.** Read `packages/mcp-connectors/imap/package.json` and `tsconfig.json`. Create `packages/mcp-connectors/apple/package.json` with the same shape, changing only `name` (→ the apple equivalent, e.g. `@nimbus-dev/mcp-apple`), `description` ("iCloud Mail (IMAP) + iCloud Calendar (CalDAV) connector"), and keeping `imapflow` + `nodemailer` deps (mail reuse). Create `tsconfig.json` identical to imap's.

- [ ] **Step 2: Register the workspace.** In root `package.json` `workspaces` array, add `"packages/mcp-connectors/apple",` adjacent to the other mcp-connectors entries (after `"packages/mcp-connectors/imap"` is fine; order is not significant).

- [ ] **Step 3: Install + verify the workspace resolves.**

Run: `bun install`
Expected: completes; `packages/mcp-connectors/apple` linked. (If a subagent lacks Bash, controller runs this.)

- [ ] **Step 4: Commit.**

```bash
git add packages/mcp-connectors/apple/package.json packages/mcp-connectors/apple/tsconfig.json package.json bun.lock
git commit -m "feat(apple): scaffold iCloud Mail+Calendar connector package"
```

### Task A2: Mail core re-exports + Drafts APPEND interface

**Files:**
- Create: `packages/mcp-connectors/apple/src/apple-mail-core.ts`
- Test: `packages/mcp-connectors/apple/test/apple-mail-core.test.ts`

**Interfaces:**
- Consumes: `packages/mcp-connectors/shared/imap-mail-core.ts` (`capPreview`, `clampLimit`, `formatAddress`, `PREVIEW_MAX_CHARS`, `PREVIEW_FETCH_BYTES`, `MailAddress`) and `packages/mcp-connectors/imap/src/imap-core.ts` types (`ImapClient`, `SmtpMailer`, `ImapMessageMeta`, `SendMailInput`, `SendMailResult`).
- Produces:
  - re-exports of the shared mail types/helpers under this module (so connector files import from one place);
  - `export interface DraftAppender { appendDraft(input: DraftInput): Promise<DraftResult>; }`
  - `export interface DraftInput { readonly to: string; readonly subject: string; readonly body: string; readonly cc?: string; readonly bcc?: string; }`
  - `export interface DraftResult { readonly uid: number | null; readonly mailbox: string; }`

- [ ] **Step 1: Write the failing test.** Assert the module re-exports `capPreview`/`formatAddress` and that the `DraftInput`/`DraftResult`/`DraftAppender` types are usable (compile-time + a trivial fake implementing `DraftAppender` returns a `DraftResult`).

```ts
import { describe, expect, it } from "bun:test";
import { capPreview, type DraftAppender } from "../src/apple-mail-core.ts";

describe("apple-mail-core", () => {
  it("re-exports capPreview (caps at 2000)", () => {
    expect(capPreview("a".repeat(5000)).length).toBe(2000);
  });
  it("DraftAppender shape is implementable", async () => {
    const fake: DraftAppender = {
      appendDraft: async () => ({ uid: 7, mailbox: "Drafts" }),
    };
    expect(await fake.appendDraft({ to: "x@y.z", subject: "s", body: "b" })).toEqual({
      uid: 7,
      mailbox: "Drafts",
    });
  });
});
```

- [ ] **Step 2: Run → fail** (`bun test packages/mcp-connectors/apple/test/apple-mail-core.test.ts`). Expected: module not found.

- [ ] **Step 3: Implement.** Re-export the shared symbols; declare `DraftInput`/`DraftResult`/`DraftAppender`.

```ts
// Helpers + client/mailer types come ONLY from the shared connector toolkit
// (packages/mcp-connectors/shared/*) — NEVER cross-import a sibling connector's
// src (e.g. ../../imap/src/...): that breaks per-workspace tsc/bundling output.
export {
  capPreview,
  clampLimit,
  formatAddress,
  PREVIEW_FETCH_BYTES,
  PREVIEW_MAX_CHARS,
} from "../../shared/imap-mail-core.ts";
// The shared kit already defines the structural client/mailer/message contracts
// the connector must satisfy (EmailReadClient/EmailSendMailer/EmailMessageMeta).
export type {
  EmailMessageMeta,
  EmailReadClient,
  EmailSendMailer,
} from "../../shared/imap-tool-kit.ts";

export interface DraftInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly cc?: string;
  readonly bcc?: string;
}
export interface DraftResult {
  readonly uid: number | null;
  readonly mailbox: string;
}
export interface DraftAppender {
  appendDraft(input: DraftInput): Promise<DraftResult>;
}
```

> **Monorepo isolation (review #1):** do NOT import from `../../imap/src/*`. Apple's read client + mailer only need to satisfy the SHARED structural types `EmailReadClient` / `EmailSendMailer` (consumed by `registerEmailConnectorTools`), which live in `shared/imap-tool-kit.ts` and are importable. The real `server.ts` clients (Task D1) implement those structural types directly and copy any imapflow-specific shaping (`toMessageMeta`/`previewFetchQuery`) locally — `server.ts` is coverage-excluded, so the small copy is acceptable and keeps package boundaries clean. If a genuinely shared helper emerges, move it INTO `shared/imap-tool-kit.ts`, never cross-import a sibling package.

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit.** `feat(apple): mail-core re-exports + Drafts appender interface`

### Task A3: Register mail read tools + send via the shared kit, + the draft tool

**Files:**
- Create: `packages/mcp-connectors/apple/src/tools.ts`
- Test: `packages/mcp-connectors/apple/test/tools.test.ts`

**Interfaces:**
- Consumes: `registerEmailConnectorTools`, `EmailReadClient`, `EmailSendMailer` from `packages/mcp-connectors/shared/imap-tool-kit.ts`; `DraftAppender`, `formatAddress` from `./apple-mail-core.ts`. (Apple's `client`/`mailer` are typed as `EmailReadClient`/`EmailSendMailer` — no imap-package import.)
- Produces:
  - `registerAppleTools(server, { client, mailer, draftAppender, calendar }): void` — registers mail tools (prefix `apple`) + the draft tool + (Phase C) calendar tools.
  - `export const APPLE_TOOL_NAMES = ["apple_list","apple_get","apple_search","apple_mail_send","apple_mail_draft_create","apple_calendar_list","apple_calendar_event_create","apple_calendar_event_delete"] as const;`

> This task wires ONLY the mail half; the calendar params are added in Task C3. Split so a reviewer can gate mail independently.

- [ ] **Step 1: Write the failing test.** Build a stub MCP server that records registered tool names; assert the four mail tool names register and that `apple_mail_send` forces the `From` to the authenticated address (the mailer fake records what it received; the kit doesn't set From — From-forcing is done by the *real mailer* in `server.ts`, so here assert the send tool calls `mailer.send` with the caller's `to/subject/body` and returns the mailer result). Also assert `apple_mail_draft_create` calls `draftAppender.appendDraft` and returns `{uid,mailbox}`.

```ts
import { describe, expect, it } from "bun:test";
import { registerAppleTools } from "../src/tools.ts";

function stubServer() {
  const tools: Record<string, (input: unknown) => Promise<unknown>> = {};
  return {
    server: { tool: (name: string, _desc: string, _schema: unknown, cb: (i: unknown) => Promise<unknown>) => { tools[name] = cb; } },
    tools,
  };
}

describe("registerAppleTools (mail)", () => {
  it("registers mail tools + draft tool and routes to injected client/mailer/draftAppender", async () => {
    const { server, tools } = stubServer();
    const sent: unknown[] = [];
    const drafted: unknown[] = [];
    registerAppleTools(server as never, {
      client: { list: async () => [], get: async () => null, search: async () => [] },
      mailer: { send: async (i) => { sent.push(i); return { messageId: "m1", accepted: ["x@y.z"], rejected: [] }; } },
      draftAppender: { appendDraft: async (i) => { drafted.push(i); return { uid: 3, mailbox: "Drafts" }; } },
    });
    expect(typeof tools.apple_mail_send).toBe("function");
    expect(typeof tools.apple_mail_draft_create).toBe("function");
    await tools.apple_mail_send({ to: "x@y.z", subject: "s", body: "b" });
    expect(sent).toHaveLength(1);
    const draftRes = await tools.apple_mail_draft_create({ to: "x@y.z", subject: "s", body: "b" });
    expect(drafted).toHaveLength(1);
    expect(draftRes).toMatchObject({ item: { uid: 3, mailbox: "Drafts" } });
  });
});
```

> Match the exact `server.tool(...)` signature the shared kit uses by reading `imap-tool-kit.ts` lines ~184-278 (it may use a Zod schema arg). Mirror it precisely in the stub + impl.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `tools.ts`.** Call `registerEmailConnectorTools({ server, toolPrefix: "apple", descriptions, client, mailer, formatAddr: formatAddress })` (mirror `imap/src/tools.ts`), then register `apple_mail_draft_create` (Zod schema `{ to, subject, body, cc?, bcc? }`) that calls `draftAppender.appendDraft` and returns `{ item: result }` via the kit's JSON-result helper. Export `APPLE_TOOL_NAMES`. Descriptions copied/adapted from imap's (the no-body/metadata-only contract for read tools; "Requires Gateway HITL email.send"/"email.draft.create" for the writes).

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit.** `feat(apple): mail read/send/draft tools via shared kit`

---

## Phase B — Pure iCalendar build/parse (the new building block)

### Task B1: `ics.ts` — line unfolding + VEVENT property parse (server-expanded objects)

**Files:**
- Create: `packages/mcp-connectors/apple/src/ics.ts`
- Test: `packages/mcp-connectors/apple/test/ics.test.ts`

**Interfaces:**
- Produces:
  - `export interface ParsedEvent { readonly uid: string; readonly recurrenceId: string | null; readonly summary: string | null; readonly description: string | null; readonly location: string | null; readonly start: string | null; readonly end: string | null; readonly allDay: boolean; readonly status: string | null; readonly organizer: string | null; readonly attendees: readonly string[]; readonly rrule: string | null; readonly dtstamp: string | null; }`
  - `export function parseICalendar(ics: string): ParsedEvent[]` — unfolds folded lines (RFC 5545 §3.1: a CRLF followed by space/tab continues the previous line), splits VEVENT blocks, extracts properties. Multiple VEVENTs (master + RECURRENCE-ID overrides, or expanded occurrences) → one `ParsedEvent` each. Attendees: collect every `ATTENDEE` line's `mailto:` value. `allDay` = `DTSTART;VALUE=DATE`. Unknown/malformed block → skipped (never throws).

- [ ] **Step 1: Write failing tests** with real fixtures: (a) a single timed VEVENT with attendees/location/description; (b) an all-day event (`DTSTART;VALUE=DATE:20260601`); (c) a folded `DESCRIPTION` spanning 3 physical lines → unfolded to one string; (d) two VEVENTs where the second carries `RECURRENCE-ID` → two `ParsedEvent`s, second has `recurrenceId !== null`; (e) a block missing `UID` → skipped; (f) escaped commas/semicolons in `SUMMARY` (`\,` `\;` `\n`) → unescaped.

```ts
import { describe, expect, it } from "bun:test";
import { parseICalendar } from "../src/ics.ts";

const TIMED = [
  "BEGIN:VCALENDAR","BEGIN:VEVENT","UID:abc-1","SUMMARY:Standup \\, daily",
  "DTSTART:20260601T090000Z","DTEND:20260601T091500Z","LOCATION:Room 4",
  "ORGANIZER:mailto:boss@icloud.com","ATTENDEE:mailto:a@icloud.com","ATTENDEE:mailto:b@icloud.com",
  "STATUS:CONFIRMED","END:VEVENT","END:VCALENDAR",
].join("\r\n");

describe("parseICalendar", () => {
  it("parses a timed event with attendees + unescapes SUMMARY", () => {
    const [e] = parseICalendar(TIMED);
    expect(e).toMatchObject({
      uid: "abc-1", summary: "Standup , daily", location: "Room 4",
      start: "20260601T090000Z", end: "20260601T091500Z",
      organizer: "boss@icloud.com", attendees: ["a@icloud.com", "b@icloud.com"],
      allDay: false, recurrenceId: null, status: "CONFIRMED",
    });
  });
});
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `parseICalendar`** (unfold → block-split on `BEGIN:VEVENT`/`END:VEVENT` → per-property parse with param stripping + value unescaping). Pure; no I/O.
- [ ] **Step 4: Run → pass** (add the all-day, folded, RECURRENCE-ID, missing-UID, escaping cases until green).
- [ ] **Step 5: Commit.** `feat(apple): pure iCalendar VEVENT parser`

### Task B2: `ics.ts` — VEVENT builder for writes

**Files:**
- Modify: `packages/mcp-connectors/apple/src/ics.ts`
- Test: `packages/mcp-connectors/apple/test/ics.test.ts`

**Interfaces:**
- Produces: `export interface BuildEventInput { readonly uid: string; readonly summary: string; readonly start: string; readonly end: string; readonly description?: string; readonly location?: string; readonly attendees?: readonly string[]; }` and `export function buildVEvent(input: BuildEventInput, now: string): string` — emits a valid `VCALENDAR>VEVENT` string: required `UID`/`DTSTAMP`(=`now`)/`DTSTART`/`DTEND`/`SUMMARY`, optional `DESCRIPTION`/`LOCATION`/`ATTENDEE` (each `mailto:`), with proper escaping (`,`→`\,`, `;`→`\;`, newline→`\n`) and CRLF line endings. `now` injected (no `Date.now()` in the pure module).

- [ ] **Step 1: Write failing test** — `buildVEvent` round-trips through `parseICalendar` (build → parse → fields match); SUMMARY with a comma is escaped then un-escaped back; DTSTAMP equals the injected `now`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `buildVEvent`.**
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit.** `feat(apple): pure iCalendar VEVENT builder`

---

## Phase C — CalDAV core + calendar tools (connector side)

### Task C1: `caldav-core.ts` — `CalDavClient` interface + pure selection/normalization

**Files:**
- Create: `packages/mcp-connectors/apple/src/caldav-core.ts`
- Test: `packages/mcp-connectors/apple/test/caldav-core.test.ts`

**Interfaces:**
- Consumes: `ParsedEvent` from `./ics.ts`.
- Produces:
  - `export interface CalendarRef { readonly url: string; readonly displayName: string; }`
  - `export interface EventWindow { readonly startUtc: string; readonly endUtc: string; }`
  - `export interface CalDavClient { listCalendars(): Promise<CalendarRef[]>; listEvents(cal: CalendarRef, window: EventWindow): Promise<{ href: string; event: ParsedEvent }[]>; putEvent(cal: CalendarRef, uid: string, ics: string): Promise<{ href: string }>; deleteEvent(href: string): Promise<void>; }`
  - `export function selectCalendars(all: CalendarRef[], cfg: { include?: readonly string[]; exclude?: readonly string[] }): CalendarRef[]` — include wins if present (subset match on displayName), else all minus exclude. Pure, tested.
  - `export function clampInstances<T>(rows: readonly T[], max: number): T[]` — caps returned events per calendar (default cap applied by caller).

- [ ] **Step 1: Write failing test** for `selectCalendars` (include subset; exclude; both empty → all) and `clampInstances` (caps at max; under-max passthrough).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** the interface + the two pure helpers.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit.** `feat(apple): CalDAV client interface + pure calendar selection`

### Task C2: Calendar tool handlers (read + write) over an injected `CalDavClient`

**Files:**
- Create: `packages/mcp-connectors/apple/src/calendar-tools.ts`
- Test: `packages/mcp-connectors/apple/test/calendar-tools.test.ts`

**Interfaces:**
- Consumes: `CalDavClient`, `selectCalendars`, `clampInstances` from `./caldav-core.ts`; `buildVEvent` from `./ics.ts`.
- Produces: `registerAppleCalendarTools(server, { calendar: CalDavClient, now: () => string, config }): void` registering:
  - `apple_calendar_list` (read): list events across selected calendars within a window arg → returns `{ items: ViewEvent[] }` (capped notes preview ≤2000, attendee emails included).
  - `apple_calendar_event_create` (write): args `{ calendar?, summary, start, end, description?, location?, attendees? }` → `buildVEvent` (uid = a generated stable id; inject via `now`/uid arg to stay pure-testable) → `calendar.putEvent` → `{ uid, href }`.
  - `apple_calendar_event_delete` (write): args `{ href }` → `calendar.deleteEvent` → `{ deleted: true }`.

- [ ] **Step 1: Write failing test** with a fake `CalDavClient`: list returns 2 events → tool returns capped views with attendees; create calls `putEvent` with an ICS that parses back to the input; delete calls `deleteEvent(href)`. Assert the notes preview is capped at 2000.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** the three handlers (cap previews via `capPreview` from `apple-mail-core`).
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit.** `feat(apple): calendar list + create/delete tool handlers`

### Task C3: Wire calendar tools into `registerAppleTools`

**Files:**
- Modify: `packages/mcp-connectors/apple/src/tools.ts`
- Test: `packages/mcp-connectors/apple/test/tools.test.ts`

- [ ] **Step 1: Extend the test** — `registerAppleTools` now also requires a `calendar: CalDavClient` + `now` and registers all 8 `APPLE_TOOL_NAMES`. Assert all 8 names register and `apple_calendar_event_create`/`_delete` route to the fake client.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — call `registerAppleCalendarTools(...)` inside `registerAppleTools`.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit.** `feat(apple): combine mail + calendar tool registration`

---

## Phase D — Connector server.ts (real clients) + manifest + README

### Task D1: `server.ts` — real IMAP/SMTP/Drafts + real CalDAV via tsdav

**Files:**
- Create: `packages/mcp-connectors/apple/src/server.ts`
- Modify: `packages/mcp-connectors/apple/package.json` (add `tsdav` dep)

> `server.ts` is **coverage-excluded** — no unit test; correctness is by construction + the contract test (Task I2) loading `APPLE_TOOL_NAMES` and the integration smoke.

- [ ] **Step 1: `bun add` safety pre-flight for `tsdav`.** In `packages/mcp-connectors/apple`, run `bun add tsdav`. Verify: license is permissive (MIT/ISC/Apache), it builds under Bun, and it exposes a CalDAV client supporting calendar discovery + a `calendar-query` REPORT with **`expand`** + time-range. Smoke: `bun -e "import { DAVClient } from 'tsdav'; console.log(typeof DAVClient)"`. **If tsdav does not fit** (no Bun support / no expand), fall back to raw `fetch` PROPFIND/REPORT in `server.ts` + `fast-xml-parser` (run the same safety check) — the `CalDavClient` interface isolates the choice; nothing else changes.

- [ ] **Step 2: Implement `server.ts`.** Mirror `imap/src/server.ts`: read env (`APPLE_ICLOUD_EMAIL`, `APPLE_ICLOUD_APP_PASSWORD`) via `requireProcessEnv`. Construct:
  - An `EmailReadClient` over `imapflow` against `imap.mail.me.com:993` (TLS). **Copy** the imapflow message-shaping helpers (`toMessageMeta`/`previewFetchQuery`) from `imap/src/server.ts` INTO this file — do NOT cross-import `../../imap/src/*` (review #1; `server.ts` is coverage-excluded so the copy is acceptable).
  - An `EmailSendMailer` over `nodemailer` against `smtp.mail.me.com:587` (STARTTLS, `secure:false`), **`from` pinned to `APPLE_ICLOUD_EMAIL`** (the forced sender; ignore any caller `From`).
  - A `DraftAppender` that IMAP-`APPEND`s a built RFC822 message (From pinned) to the `Drafts` mailbox (imapflow `append`).
  - A `CalDavClient` over tsdav using a **two-phase client** (review #2): (1) instantiate a *bootstrap* `DAVClient({ serverUrl: "https://caldav.icloud.com", credentials: { username: email, password: appPw }, authMethod: "Basic", defaultAccountType: "caldav" })` and `login()` → fetch the principal + `calendar-home-set`; (2) instantiate the *working* `DAVClient` targeting the resolved `p##-caldav.icloud.com` calendar-home URL and run all list/`expand`/PUT/DELETE against it, so Basic auth is applied to the resolved host on every request (never relying on transparent cross-host redirects). Inject `now = () => new Date().toISOString()`.
  Then `registerAppleTools(server, { client, mailer, draftAppender, calendar, now })` and `await server.connect(new StdioServerTransport())`.

- [ ] **Step 3: Typecheck** the package: `cd packages/mcp-connectors/apple && bunx tsc --noEmit`. Expected: clean.
- [ ] **Step 4: Commit.** `feat(apple): real IMAP/SMTP/Drafts + CalDAV server (tsdav)`

### Task D2: Extension manifest + README (public-tier sections)

**Files:**
- Create: `packages/mcp-connectors/apple/nimbus.extension.json`
- Create: `packages/mcp-connectors/apple/README.md`

- [ ] **Step 1:** Copy `imap/nimbus.extension.json` → adapt id/name/description/tools list (the 8 `APPLE_TOOL_NAMES`, with the four writes flagged as HITL where the manifest expresses that — mirror how imap flags `imap_mail_send`).
- [ ] **Step 2:** Write `README.md` with the public-tier H2 sections that `audit:package-readmes` requires (read an existing connector README + the `connector-readme-public-tier-audit` convention). Document: app-specific-password setup (Apple ID → Sign-In & Security → App-Specific Passwords), the fixed iCloud endpoints, the 8 tools, the HITL writes, and the metadata-only privacy contract.
- [ ] **Step 3:** Run `bun run audit:package-readmes`. Expected: passes for `apple`.
- [ ] **Step 4: Commit.** `docs(apple): extension manifest + connector README`

---

## Phase E — Gateway: mail sync (reuse)

### Task E1: `apple-sync.ts` mail half via the reused imap engine

**Files:**
- Create: `packages/gateway/src/connectors/apple-sync.ts`
- Test: `packages/gateway/src/connectors/apple-sync.test.ts`

**Interfaces:**
- Consumes: `createImapSyncable`/`runImapLikeSync` building blocks, `ImapConnectionConfig`, `ImapMessageFetcher`, `fetchImapMessages` (`_lib/imap-client.ts`), `mapImapLikeMessageToItem` (`imap-email-mapping.ts`), `Syncable`/`SyncContext`/`SyncResult`.
- Produces: `export type AppleSyncableOptions = { ensureAppleMcpRunning: () => Promise<void>; fetchMessages: ImapMessageFetcher; fetchEvents: AppleEventFetcher; };` and `export function createAppleSyncable(options): Syncable` with `serviceId: "apple"`. This task wires the **mail** half only; calendar is added in Task F3.
- `loadMailConfig(ctx): Promise<ImapConnectionConfig | null>` — reads vault `apple.icloud_email` + `apple.icloud_app_password`, returns config with fixed host `imap.mail.me.com`, port 993, `secure:true`, `mailbox` from config (default INBOX). Returns null when creds absent.

- [ ] **Step 1: Write failing test** — `createAppleSyncable` with a fake `fetchMessages` returning two `ImapMessageInput`s and a no-op `fetchEvents`; run `sync(ctx, null)` against a real in-memory SQLite (`createMemoryIndexDb`); assert two `apple:email` rows land via `mapImapLikeMessageToItem("apple", …)` with correct `external_id` (message-id) and ≤2000 preview. Mirror `imap-sync.test.ts`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** the mail half: `runImapLikeSync(ctx, cursor, { serviceId:"apple", ensureRunning, loadConfig: loadMailConfig, fetchMessages, maxMessages, pass1Cursor, mapMessage: (m, s) => mapImapLikeMessageToItem("apple", m, { syncedAt: s }) })`. Leave a typed `fetchEvents` option unused-yet (calendar in F3).
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit.** `feat(apple): gateway mail sync (reuses imap engine)`

---

## Phase F — Gateway: calendar sync

### Task F1: `_lib/ical-parse.ts` — gateway-side VEVENT parse (sync)

**Files:**
- Create: `packages/gateway/src/connectors/_lib/ical-parse.ts`
- Test: `packages/gateway/src/connectors/_lib/ical-parse.test.ts`

> Dependency rule: the gateway must NOT import from `packages/mcp-connectors/*`. This is the gateway-side twin of the connector's `ics.ts` parser (exactly as the gateway's `_lib/imap-client.ts` re-implements `capPreview`/parsing rather than importing the connector's). Keep it minimal — it only parses **server-expanded concrete VEVENTs**.

**Interfaces:**
- Produces: `export interface ParsedCalendarEvent { uid; recurrenceId; summary; description; location; start; end; allDay; status; organizer; attendees; rrule; dtstamp; }` (same shape as the connector `ParsedEvent`) and `export function parseExpandedCalendar(ics: string): ParsedCalendarEvent[]`.

- [ ] **Step 1: Write failing tests** — reuse the Task B1 fixtures (timed, all-day, folded, RECURRENCE-ID, missing-UID, escaping). Same assertions.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** the parser (port of B1; keep ≥85% line / ≥80% branch — the fixtures must hit the all-day, override, skip, and escape branches).
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit.** `feat(apple): gateway-side iCalendar parser for sync`

### Task F2: `apple-event-mapping.ts` — `ParsedCalendarEvent` → `MappedRow<"apple","event">`

**Files:**
- Create: `packages/gateway/src/connectors/apple-event-mapping.ts`
- Test: `packages/gateway/src/connectors/apple-event-mapping.test.ts`

**Interfaces:**
- Consumes: `ParsedCalendarEvent` (`_lib/ical-parse.ts`); `MappedRow` (`mapped-row.ts`).
- Produces: `export function mapAppleEventToItem(ev: ParsedCalendarEvent, ctx: { calendar: string; syncedAt: number }): MappedRow<"apple","event"> | null`.
  - `externalId` = `ev.recurrenceId ? \`${ev.uid}:${ev.recurrenceId}\` : ev.uid`; null when `uid` empty.
  - `type:"event"`, `title` = summary (clamped 256) or `"(untitled event)"`, `bodyPreview` = `capPreview(description ?? "")` (≤2000 — gateway has its own `capPreview` in `_lib/imap-client.ts`; reuse or replicate), `modifiedAt` = parse `dtstamp`→`start`→`syncedAt`, `url:null`, `canonicalUrl:null`, `metadata` = `{ uid, calendar, start, end, allDay, location, organizer, status, recurrence: rrule, attendees }`, `syncedAt`.

- [ ] **Step 1: Write failing tests** — a timed event → correct row + metadata incl. attendees; an override event → `external_id` `uid:recurrenceId`; a no-UID event → null; a 5000-char description → 2000-char preview.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit.** `feat(apple): event item mapping`

### Task F3: Calendar fetch (injectable transport) + wire into `createAppleSyncable`

**Files:**
- Create: `packages/gateway/src/connectors/_lib/apple-caldav-fetch.ts`
- Modify: `packages/gateway/src/connectors/apple-sync.ts`
- Test: `packages/gateway/src/connectors/_lib/apple-caldav-fetch.test.ts`, extend `apple-sync.test.ts`

**Interfaces:**
- Produces:
  - `export type AppleEventFetcher = (config: AppleCalConfig, window: { startUtc: string; endUtc: string }) => Promise<{ ok: true; events: { calendar: string; ics: string }[] } | { ok: false; error: string }>;`
  - `export function fetchAppleCalendarEvents(config, window, transport = defaultCalDavTransport): Promise<...>` — `transport` is the injectable network seam (returns raw expanded ICS per calendar); the function never throws (catch → `{ok:false}`), mirroring `fetchImapMessages`. The real `defaultCalDavTransport` (tsdav, network) is the only thin uncovered bit; tests inject a fake transport returning fixture ICS.
  - `loadCalConfig(ctx): Promise<AppleCalConfig | null>` (vault creds + fixed `caldav.icloud.com` + window/selection config).

- [ ] **Step 1: Write failing tests** — (a) `fetchAppleCalendarEvents` with a fake transport returning two-calendars-of-ICS → `{ok:true, events:[...]}`; a throwing transport → `{ok:false,error}`. (b) Extend `apple-sync.test.ts`: `sync()` now also upserts `apple:event` rows (fake `fetchEvents` returns fixture ICS; assert events parsed via `parseExpandedCalendar` + mapped via `mapAppleEventToItem` land in SQLite alongside the emails).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `fetchAppleCalendarEvents` + the calendar half of `createAppleSyncable.sync` (after the mail pass: ensure running → load cal config → rate-limit acquire → fetch events → for each: `parseExpandedCalendar` → `mapAppleEventToItem` → `upsertIndexedItemForSync`). Cap via `max_instances_per_calendar`.
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit.** `feat(apple): gateway calendar sync (events indexed)`

---

## Phase G — Embedding routing

### Task G1: Route `apple:email` to 1536-dim

**Files:**
- Modify: `packages/gateway/src/embedding/routing.ts`
- Test: `packages/gateway/src/embedding/routing.test.ts` (or the existing PROSE_HEAVY test)

- [ ] **Step 1: Write/extend the failing test** — assert `PROSE_HEAVY_TYPES.has("apple:email") === true` and `PROSE_HEAVY_TYPES.has("apple:event") === false` (events stay 384-dim).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — add `"apple:email",` to `PROSE_HEAVY_TYPES` (next to `imap:email`/`fastmail:email`).
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit.** `feat(apple): route apple:email to 1536-dim embeddings`

---

## Phase H — Registration sites (the 9)

> One commit for the whole phase is acceptable (it's a single "register the connector" deliverable), but TDD each edit against the catalog/registry drift tests. Read each file's current state before editing (line numbers drift). These sites collide with Workday — see Global Constraints.

### Task H1: Catalog + secrets manifest + rate-limiter + keys

**Files:**
- Modify: `packages/gateway/src/connectors/connector-catalog.ts` (`CONNECTOR_SERVICE_IDS` += `"apple"`; `CONNECTOR_SYNC_INTERVAL_MS` += `apple: MIN5`; `OAUTH_UNSUPPORTED_DETAILS` += `apple: "uses an Apple ID + app-specific password for iCloud Mail (IMAP/SMTP) + Calendar (CalDAV); set via connector.auth apple"`)
- Modify: `packages/gateway/src/connectors/connector-secrets-manifest.ts` (`apple: ["apple.icloud_email", "apple.icloud_app_password"]`)
- Modify: `packages/gateway/src/sync/rate-limiter.ts` (`Provider` union += `"apple"`; `DEFAULT_QUOTAS` += `apple: { requestsPerMinute: 60, burstSize: 10 }`)
- Modify: `packages/gateway/src/connectors/lazy-mesh/keys.ts` (`apple: "mesh:apple"`)

- [ ] **Step 1:** Run the existing catalog/secrets drift + manifest tests to see them pass pre-edit, then add entries. Find each region by reading the file (don't trust stale line numbers).
- [ ] **Step 2:** Run `bun test packages/gateway/src/connectors/connector-catalog.test.ts` + secrets-manifest test + `rate-limiter.test.ts`. Expected: green (some tests assert counts — update count assertions if any).
- [ ] **Step 3: Commit.** `feat(apple): register service id, secrets, quota, mesh key`

### Task H2: Spawn + mesh + credential orchestration (standalone connector)

**Files:**
- Modify: `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts` — add `export async function ensureAppleMcp(ctx)` mirroring `ensureMendeleyMcp`, but gated on the app-password secret and injecting BOTH env vars:

```ts
export async function ensureAppleMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.apple;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) { ctx.scheduleLazyDisconnect(slotKey); return; }
  const email = await readConnectorSecret(ctx.vault, "apple", "icloud_email");
  const appPw = await readConnectorSecret(ctx.vault, "apple", "icloud_app_password");
  if (email === null || email === "" || appPw === null || appPw === "") return;
  ctx.setLazyClient(slotKey, new MCPClient({
    id: `nimbus-apple-${randomUUID()}`,
    servers: { apple: wrap(
      { command: "bun", args: [mcpConnectorServerScript("apple")],
        env: extensionProcessEnv({ APPLE_ICLOUD_EMAIL: email, APPLE_ICLOUD_APP_PASSWORD: appPw }) },
      "apple", ctx) },
  }));
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}
```

- Modify: `packages/gateway/src/connectors/lazy-mesh/mesh.ts` — import `ensureAppleMcp`; add `async ensureAppleRunning() { return ensureAppleMcp(this.spawnContext); }`; add `{ map: await list(LAZY_MESH.apple), name: "apple" }` to `collectBuiltInToolMaps`.
- Modify: `packages/gateway/src/connectors/lazy-mesh/credential-orchestration.ts` — add `ensureAppleMcp` to the `CredentialSpawners` type + `defaultSpawners`; add `await ensureIfConnectorSecretSet(ctx, "apple", "icloud_app_password", () => spawners.ensureAppleMcp(ctx));` to `ensureCredentialConnectorsRunning`.

- [ ] **Step 1: Write/extend tests** — mirror the mendeley spawn/orchestration tests: `ensureAppleMcp` no-ops when creds absent; spawns (sets a lazy client) when both secrets present (use a fake vault + fake MCPClient seam as the mendeley test does); `ensureCredentialConnectorsRunning` invokes `ensureAppleMcp` via the spawners record.
- [ ] **Step 2: Run → fail, then implement, then → pass.**
- [ ] **Step 3: Commit.** `feat(apple): lazy-mesh spawn + credential orchestration`

### Task H3: Sync registration

**Files:**
- Modify: `packages/gateway/src/platform/assemble-sync-registrations.ts` — import `createAppleSyncable` + the real fetchers (`fetchImapMessages`, `fetchAppleCalendarEvents`); register:

```ts
syncScheduler.register(
  createAppleSyncable({
    ensureAppleMcpRunning: () => connectorMesh.ensureAppleRunning(),
    fetchMessages: fetchImapMessages,
    fetchEvents: fetchAppleCalendarEvents,
  }),
);
```

- [ ] **Step 1: Extend the assemble test** (`assemble.test.ts` or the sync-registrations test) to assert the `apple` syncable is registered.
- [ ] **Step 2: Run → fail → implement → pass.**
- [ ] **Step 3: Commit.** `feat(apple): register the apple syncable`

---

## Phase I — HITL enforcement + connector contract test

### Task I1: Executor-level HITL test for the four apple write actions

**Files:**
- Test: `packages/gateway/src/engine/executor-apple-writes.test.ts` (or extend `executor.test.ts`)

> No production code — this proves the **existing** I2 gate covers apple's writes on the generic path (spec §6.3).
>
> **Dispatch routing confirmed (review #3):** the generic dispatcher (`connectors/registry.ts` ~line 67) resolves the connector tool as `payload.mcpToolId ?? action.type` against the live mesh tool map, and the executor gate (`executor.ts:262`) keys on `action.type` alone. There is **no** tool-id→action-type map and **no** per-service dispatch allowlist that apple must join — so **no Phase-H mapping is required** for the write path (this directly answers the reviewer's "add a mapping if needed"). Mirroring imap is structurally sufficient: `email.send`/`email.draft.create`/`calendar.event.create`/`calendar.event.delete` are already in `HITL_REQUIRED_BACKING`, and dispatch is `mcpToolId`-based.
>
> **Scope note:** like the five sibling email connectors, the *end-to-end invocation surface* (a conversational-agent / chatops / planner path that builds a write `PlannedAction` with `payload.mcpToolId` set and runs it through `executor.execute`) is a pre-existing, connector-agnostic concern and is **out of scope** for this slice. This slice delivers the connector, its tools, and executor-level HITL gating — exactly the surface imap ships. The action `{ type, payload: { mcpToolId, input } }` shape used in Step 1 is the contract every such surface must produce.

- [ ] **Step 1: Write the test** — for each of `email.send`, `email.draft.create`, `calendar.event.create`, `calendar.event.delete`: build a `ToolExecutor` with a consent coordinator stub that records the prompt and a dispatcher stub that records dispatch; call `executor.execute({ type, payload: { mcpToolId: "apple_…", input: {…} } })`; assert (a) consent was prompted BEFORE dispatch, (b) on approval it dispatches, (c) on rejection it returns `{status:"rejected"}` and never dispatches. Mirror `executor.test.ts` HITL cases.
- [ ] **Step 2: Run → it should PASS immediately** (the gate already covers these action types) — if it fails, the action type is missing from `HITL_REQUIRED_BACKING` (it isn't) or the harness is wrong; fix the test, not prod.
- [ ] **Step 3: Commit.** `test(apple): executor HITL gate fires for all four write actions`

### Task I2: Connector contract test (tool surface + no-body invariant)

**Files:**
- Test: `packages/mcp-connectors/apple/test/contract.test.ts`

- [ ] **Step 1: Write the test** — register all tools against a stub server with fake clients; assert the registered tool names exactly equal `APPLE_TOOL_NAMES`; assert `apple_list`/`apple_get` outputs contain only headers + attachment metadata + a ≤2000 preview (never a `body`/bytes field); assert `apple_calendar_list` caps notes at 2000 and includes attendee emails.
- [ ] **Step 2: Run → fail → implement (if any view-shaping gaps) → pass.**
- [ ] **Step 3: Commit.** `test(apple): connector contract + metadata-only invariant`

---

## Phase J — Docs + ship gate

### Task J1: CHANGELOG + roadmap row

**Files:**
- Modify: `docs/CHANGELOG.md` (dated entry: apple connector — iCloud Mail+Calendar, 4 HITL writes, cross-platform; per the `connector-docs-changelog-convention`, log here, NOT the CLAUDE.md/GEMINI.md status line)
- Modify: `docs/roadmap.md` — check the "Apple Mail + macOS Calendar" row `[x]`, with the dated delivered note + the macOS-only-relaxed annotation.

- [ ] **Step 1:** Add the CHANGELOG entry + flip the roadmap row.
- [ ] **Step 2:** `bun run audit:doc-refs` (+ `lint:markdown` if connector docs touched). Expected: pass.
- [ ] **Step 3: Commit.** `docs(apple): CHANGELOG + roadmap delivery note`

### Task J2: Ship gate (no push-and-see)

**Files:** none (verification only)

- [ ] **Step 1:** `bun run preflight` (FULL, all-package tsc). Fix any failure before proceeding.
- [ ] **Step 2:** Docker-Linux coverage-floor: build lcov + `check.ts` (authoritative). Confirm every NEW gateway file (`apple-sync.ts`, `apple-event-mapping.ts`, `_lib/ical-parse.ts`, `_lib/apple-caldav-fetch.ts`) clears ≥85% line / ≥80% branch. Add tests or exclude only true glue.
- [ ] **Step 3:** `bun run audit:invariants` (D-checks) + `bun run audit:package-readmes`. Expected: pass (no new invariant; apple is NOT in the D20 write-tool list — confirm the audit doesn't flag `apple_*` strings anywhere, since they're only generic-path tool ids in the connector + payload).
- [ ] **Step 4:** Whole-branch `/code-review`. Address findings.
- [ ] **Step 5:** Only then push + open PR (do NOT co-merge with Workday; rebase onto main after Workday lands and re-resolve the 9 sites).

---

## Self-review notes (coverage of spec)

- Spec §3 topology → Phases A–D. §4 creds/endpoints → A1/D1/H1. §5.1 mail → A2/A3/E1. §5.2 calendar + recurrence → B/C/F. §6.1 forced sender → A3/D1. §6.2/§6.3 generic-path writes + HITL test (no I26) → I1. §7 embedding → G1. §8 platform (no gate) → nothing to do (verified by absence). §9 registration → H. §10 testing → tests throughout + J2. §11 out-of-scope → respected (no update tool, no IDLE, no client RRULE engine). §12 risks → D1 (auth-on-redirect, tsdav fallback), F-phase (injectable transport for coverage).
- **Resolved (review #1):** no cross-package `src` imports. Apple's client/mailer types come from the SHARED `imap-tool-kit.ts` (`EmailReadClient`/`EmailSendMailer`/`EmailMessageMeta`); `server.ts` copies imapflow shaping locally (it's coverage-excluded). Genuinely shared helpers move INTO `shared/`, never a sibling-package import.
- **Resolved (review #2):** tsdav uses a two-phase client — bootstrap-discover then re-instantiate against the resolved `p##-caldav.icloud.com` calendar-home host — so Basic auth is applied to the resolved host on every request (D1 Step 2).

---

## Plan-review resolutions (2026-06-21)

From `2026-06-21-slice9-apple-mail-calendar-review.md` — all three **fixed**, none deferred:

1. **Cross-package relative imports (A2/D1)** → **Fixed.** The plan no longer imports `../../imap/src/*`. Apple's client/mailer types come from the shared `imap-tool-kit.ts` (`EmailReadClient`/`EmailSendMailer`/`EmailMessageMeta`), which the kit already defines and which are importable from the shared location; the real `server.ts` copies the imapflow shaping helpers locally (coverage-excluded). Reviewer's "redefine locally or move to the shared toolkit" — adopted the shared-toolkit form for types, local copy for the imapflow-specific `server.ts` helpers.
2. **tsdav principal-host redirect (D1)** → **Fixed.** Adopted the reviewer's two-phase `DAVClient`: bootstrap-discover the `calendar-home-set`, then construct a working `DAVClient` targeting the resolved `p##-caldav.icloud.com` URL for all subsequent ops (Basic auth re-applied to the resolved host; no reliance on transparent redirects).
3. **Generic dispatch mapping for writes (I1)** → **Verified; no change needed.** Traced the real runtime path: the dispatcher resolves the tool by `payload.mcpToolId ?? action.type` (`connectors/registry.ts` ~line 67) and the gate keys on `action.type` (`executor.ts:262`). There is **no** tool-id→action-type map and **no** per-service dispatch allowlist — so the reviewer's conditional ("if explicit mapping required, add it in Phase H") resolves to **not required**; mirroring imap is structurally sufficient. Added an explicit confirmation + a scope note to Task I1 (the end-to-end write-invocation *surface* is a pre-existing, connector-agnostic concern shared with the five sibling email connectors, out of scope for this slice — which delivers the connector + tools + executor-level gating exactly as imap does).
