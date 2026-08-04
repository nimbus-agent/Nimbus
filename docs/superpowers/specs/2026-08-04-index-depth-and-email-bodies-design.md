# Enforced index depth + Gmail/Outlook full bodies — design

> **Status:** design approved 2026-08-04 · **Slot:** Spine S1 (Local Brain) · **Schema:** V49
> **Follows:** [`2026-08-03-notion-confluence-full-body-design.md`](./2026-08-03-notion-confluence-full-body-design.md) (merged #1039)

## Problem

Two problems, and the second is why the first finally has to be fixed.

### 1. A documented privacy control does nothing

`nimbus connector reindex <svc> --depth metadata_only` strips an existing connector's bodies, and
[`docs/cli-reference.md`](../../cli-reference.md) states: *"The depth is persisted as the
connector's default for subsequent delta syncs."*

It is not. `getDepthForService`
([`sync/scheduler.ts:290-297`](../../../packages/gateway/src/sync/scheduler.ts)) is called from
exactly one place — `rowToStatus`, which builds the status display. No sync path and no write path
consults it. `SyncContext` ([`sync/types.ts:7-41`](../../../packages/gateway/src/sync/types.ts))
has no `depth` field at all, so a connector *cannot* honour it even if it wanted to.

The observable consequence: a user sets `metadata_only`, the reindex strips their bodies, and the
next delta sync writes them straight back. The off switch is decorative. This is the same class of
defect as the Confluence `rebody` scope corrected in #1039 — a surface promising something the code
does not do — and it currently affects all twelve body-migrated connectors.

### 2. Gmail and Outlook index ~200-character provider snippets

Both were named as the follow-up in #1039's spec and are in the same position Notion and Confluence
were, minus the routing question:

| Connector | Today | Already in `PROSE_HEAVY_TYPES`? |
| --- | --- | --- |
| [`_lib/gmail/api.ts:174`](../../../packages/gateway/src/connectors/_lib/gmail/api.ts) | `bodyPreview: preview` — Gmail's `snippet`, ~200 chars | **yes** (`routing.ts:12`) |
| [`outlook-sync.ts:65`](../../../packages/gateway/src/connectors/outlook-sync.ts) | `bodyPreview: preview` — Graph's `bodyPreview`, ~255 chars | **yes** (`routing.ts:13`) |

Both are entitled to the 16 KiB `BODY_MAX_PROSE` cap and receive 512. Email is where a large share
of decisions and definitions actually live, so this compounds `why` / `glossary` / `decisions` a
third time.

Indexing whole inboxes is also precisely what makes problem 1 unacceptable to ship alongside.

## Goal

`metadata_only` genuinely suppresses body content on every sync for every connector, and
`gmail:email` / `outlook:email` carry real message text in `item.body`.

**Non-goals.** IMAP and Fastmail email (same class, obvious next consumers of the trimmer, but not
this slice). A real summariser — see § Depth semantics. Any new `nimbus.toml` section: the control
already exists.

## The cost picture

Neither connector has Notion's N+1 problem. Both are Confluence-class.

**Gmail already fetches each message individually.** `fetchMessageMetadata`
([`_lib/gmail/api.ts:67-80`](../../../packages/gateway/src/connectors/_lib/gmail/api.ts)) issues a
per-message `GET /messages/{id}` and explicitly sets `format=metadata`, which returns headers and
`snippet` and deliberately omits the payload body. Switching to `format=full` returns the body in
that **same** call — zero extra requests, and `messages.get` costs 5 quota units at either format.
The cost is bandwidth and parsing, not quota.

**Outlook may already be paying for the body and discarding it.** The delta call is
`${GRAPH}/me/messages/delta?$top=50` ([`outlook-sync.ts:102`](../../../packages/gateway/src/connectors/outlook-sync.ts))
with no `$select`, so Graph returns the default message property set, which includes `body`. The
`GraphMessage` type simply never declared the field.

## Design

### Depth enforcement at the store chokepoint

Enforcement goes in **one** place, not in ninety connectors.

1. `SyncContext` gains `depth: ReindexDepth`.
2. The scheduler already computes it (`getDepthForService`); it now also puts it on the context it
   builds for each sync run — once per sync, not once per item.

3. `upsertIndexedItemForSync` coerces the caller's body input according to that depth before
   delegating to `upsertIndexedItem`.

Coercion at the store is the whole point: a connector cannot forget, a *new* connector inherits the
behaviour for free, and there is a single site to audit. This is the same chokepoint posture as I29's
ledger append, without needing a new invariant — the property is "no body escapes the store above
the configured depth", and it is enforced structurally rather than by convention.

`upsertIndexedItem` (the non-sync entry point) is deliberately **not** changed. It has callers that
are not connector syncs, and depth is a connector-sync concept.

### Depth semantics

The three levels map exactly onto the store's existing `IndexedItemBodyInput` union, so this is a
coercion rather than new machinery:

| Depth | Coercion | Stored |
| --- | --- | --- |
| `metadata_only` | write `body` **and** `body_preview` as NULL explicitly | neither column holds text; `body_complete = 0` |
| `summary` | force the `bodyPreview` arm | clamped 512, never claims completeness |
| `full` | pass through unchanged | per-type cap (16 KiB for prose types) |

**`metadata_only` must null both columns, and must do it explicitly rather than by omission.** Two
reasons, both load-bearing:

1. A 512-character preview of an email body is message content. Leaving `body_preview` populated
   while calling the mode "metadata only" would leak exactly what the user asked to suppress. This
   also matches what the existing reindex path already does —
   [`reindex.ts:63`](../../../packages/gateway/src/connectors/reindex.ts) nulls `body`,
   `body_preview` and `body_complete` together — so enforcement and reindex agree instead of
   drifting.

2. Simply *omitting* the body input does not produce an empty body. `upsertIndexedItem` computes
   `const raw = row.body ?? row.bodyPreview ?? row.title`
   ([`item-store.ts:88`](../../../packages/gateway/src/index/item-store.ts)), so dropping both arms
   falls through to the **title** and the store would write the title as the body. The coercion must
   therefore set the columns, not withhold the input.

A `summary`-depth connector that passed `body:` is downgraded to `bodyPreview:`, which is exactly
the pre-V48 behaviour and already well covered by the store's tests.

**`summary` is a 512-char prefix, not a generated summary.** `cli-reference.md` describes it as a
"first-N-tokens summary", which overstates it — there is no summariser and this slice does not add
one. The doc gets corrected to describe the prefix. Building a real summariser is a separate slice
with its own cost question (it would mean an LLM call per item).

### The default flip, and the migration that makes it real

`connector-depth-v21-sql.ts` declares `depth TEXT NOT NULL DEFAULT 'summary'`. Rows therefore hold
`'summary'` **materialised** — they are not NULL falling through to a code default. Changing
`getDepthForService`'s fallback alone would change nothing for any existing install, and every one of
them would regress from 16 KiB bodies to 512-char previews the moment enforcement landed.

So **V49** backfills:

```sql
UPDATE sync_state SET depth = 'full' WHERE depth = 'summary';
```

`metadata_only` and `full` rows are untouched.

**Why backfilling `summary` does not override anyone's choice.** Depth has never been enforced for
body content. A user who set `summary` received full bodies regardless, so a stored `summary` carries
no expressed intent about bodies — it is indistinguishable from the column default and has always
behaved as `full`. Backfilling preserves exactly the behaviour those installs have observed.
`metadata_only` is different: its reindex genuinely stripped bodies, so it *is* expressed intent. It
is left alone and finally becomes enforced on every sync, which is the privacy win this slice exists
for.

**New rows** get `'full'` by changing the one insert that omits the column
([`local-index.ts:736`](../../../packages/gateway/src/index/local-index.ts)) to write it explicitly,
and `getDepthForService`'s fallback likewise. The column's `DEFAULT 'summary'` is left in place with
a comment marking it superseded: SQLite cannot alter a column default in place, and rebuilding
`sync_state` (the V46 `glossary_term` treatment) is disproportionate when two code sites fully
determine the value. No code path relies on the column default after this.

### Gmail — `format=full` and a MIME walk

`fetchMessageMetadata` requests `format=full`. The response's `payload` is a MIME tree, so a new pure
module walks it:

- **Respect container semantics.** `multipart/alternative` means "pick one representation" — prefer
  the `text/plain` child, else `text/html` decoded and run through the existing non-truncating
  `plainTextFromHtml` (`string/html-plain-text.ts`). `multipart/mixed` and `multipart/related` mean
  "a sequence" — concatenate their text parts in order. Taking only the first text part regardless of
  container would silently drop body text on any message that interleaves prose with inline parts,
  which is the exact class of silent truncation this workstream exists to eliminate; it would be a
  smaller version of the Teams `body_complete` bug fixed in #1039.

- Part bodies are **base64url** (`-`/`_`, not `+`/`/`) — decode accordingly, not with plain base64.
- Skip parts carrying an `attachmentId`: Gmail does not inline attachment bytes there, and indexing
  filenames is not the goal.

- Bound the recursion depth and total parts visited, for the same reason the Notion walk is bounded —
  a malformed or hostile tree must not be able to spin.

`MessagePayload` currently declares only `mimeType` and `headers`; it gains `body?: { data?: string;
attachmentId?: string }` and `parts?: MessagePayload[]`.

`format=full` also returns headers the connector already asks for individually, so the
`metadataHeaders` parameters are dropped as redundant rather than left as dead query string.

### Outlook — declare the field, and ask for it explicitly

`GraphMessage` gains `body?: { contentType?: string; content?: string }`. `contentType` is usually
`html`, so the content goes through `plainTextFromHtml`; `text` is taken as-is.

The delta request adds an explicit `$select` that includes `body` alongside the fields already read
(`id,subject,bodyPreview,receivedDateTime,lastModifiedDateTime,webLink,from`).

**Why `$select` even though the default set should already include `body`:** this cannot be verified
without a live tenant. If `body` already arrives, `$select` costs nothing and documents intent; if it
does not, `$select` is what makes the feature work. Relying on an unverified default is the failure
mode to avoid. `$select` on a delta query must be set on the **initial** request — the `@odata.nextLink`
and `@odata.deltaLink` carry it forward, so it must not be re-appended to a followed link.

**Existing installs must be reset automatically, via a cursor-prefix bump.** A stored
`@odata.deltaLink` encodes the projection of the query that minted it, so an install upgrading into
this slice keeps following a link created *without* `body` and keeps receiving body-less responses.

The mechanism is one character. Outlook's cursor carries a version prefix,
`CURSOR_PREFIX = "nimbus-outl1:"` ([`outlook-sync.ts:16`](../../../packages/gateway/src/connectors/outlook-sync.ts)).
`decodeMicrosoftGraphDeltaCursor` returns `undefined` when the prefix does not match, and the sync
does `nextUrl = dec?.nextUrl ?? null`, so an undecodable cursor falls through to the **initial**
request URL — precisely where `$select` lives. Bumping the prefix to `nimbus-outl2:` therefore forces
exactly one fresh delta, with the new projection, on the next scheduled sync, with no new machinery
and no error path.

**This reverses an earlier decision in this document, and the reason is worth recording.** The first
draft treated Outlook like Notion and Confluence in #1039: new bodies apply going forward, `rebody`
recovers the backlog, documented in the release notes. That analogy is wrong. For Notion and
Confluence, *newly synced items got bodies immediately* and `rebody` only addressed already-indexed
rows. For Outlook, a stuck delta projection means **even brand-new messages arrive body-less, for
ever** — the feature is not merely incomplete for the backlog, it is off. Shipping that behind a
release-note instruction most users will not read is the same "surface promises what the code does
not do" pattern this slice exists to correct.

The one-time cost — a full mailbox delta re-walk, now with `body` on every page — is the honest price
of the feature and belongs in the release notes as a heads-up rather than as an instruction the user
must act on.

**Gmail is genuinely the #1039 case and keeps that treatment.** Switching to `format=full` affects
every message fetched from that point on, including new ones, so the feature works immediately;
only already-indexed messages keep their snippets until a `rebody`. No cursor bump, and `rebody`
remains the documented recovery path — which is why `gmail` joins `REBODY_IMPROVABLE_SERVICES`.

### The quoted-tail trimmer

A shared pure module, `string/email-quoted-text.ts`, because IMAP and Fastmail are the obvious next
consumers and this logic must not be duplicated per connector.

Email is heavily self-duplicating: a twenty-message thread quoted in every reply stores the same
paragraphs twenty times, spends each reply's 16 KiB cap on text already indexed, and skews term
frequency for the glossary agent.

**It removes a quoted TAIL — it does not cut at the first marker.** This distinction is the whole
correctness argument. A real quoted reply chain runs, by construction, from its marker to the end of
the message. An inline quotation does not: it is followed by more of the author's own prose. So the
rule is:

> Find the earliest marker such that **everything from that marker to the end of the message** is
> quoted lines, attribution lines, header-block lines, signature, or blank. Cut there. If no marker
> satisfies that, return the body unchanged.

Cutting at the first marker instead would destroy exactly the messages worth reading:

```text
Here's my take.                 <-- survives either way

> quoting the spec             <-- inline quote, NOT a tail
> more spec

Actually I disagree because Z.  <-- LOST by first-marker; kept by tail rule
```

A never-return-empty fallback does not save that case, because the text above the marker is
non-empty — which is why the tail rule, not the fallback, has to do the work.

**Markers** (each valid only as the start of a qualifying tail):

- a run of lines beginning `>` (any nesting depth),
- `On <date>, <someone> wrote:` and its localised variants — **including when the client has wrapped
  it across lines**, which mobile and narrow-viewport clients routinely do:

  ```text
  On Mon, Aug 3, 2026 at 4:32 PM User
  <user@example.com> wrote:
  ```

  Line-at-a-time matching fails both halves — the first does not end in `wrote:`, the second does not
  begin with `On` — and the failure is worse than it looks: the backward walk stops at the
  unrecognised continuation line, the boundary check then rejects it as a non-marker, and the trimmer
  returns the body **completely untrimmed**. So a whole class of clients silently gets no trimming at
  all. A normalisation pre-pass joins an opener to a following line that closes it (bounded to two
  continuation lines) before the walk runs,

- `-----Original Message-----`,
- Outlook's `________________________________` divider,
- an Outlook-style inline header block — two or more of `From:` / `Sent:` / `To:` / `Subject:` /
  `Cc:` on consecutive lines. Outlook frequently emits these with no divider above them. Requiring
  **two or more adjacent** fields keeps a single `From: ...` line inside a pasted log from
  triggering it, and the tail rule means even a real header block mid-message is ignored,

- a signature delimiter: a line consisting of exactly `--` followed by a single space (the trailing
  space is part of the convention and must not be trimmed away when matching).

**Remaining risk, accepted.** A message whose genuine final paragraph is itself entirely a quotation —
"here is the paragraph I object to:" followed by only the quote — loses that quote. The author's own
words above it survive. The never-return-empty fallback still applies for the degenerate case where
the whole body is quoted. The function is pure, so this is cheap to pin with a corpus of awkward
shapes rather than argued about.

## Fallout

- `gmail` and `outlook` join `REBODY_IMPROVABLE_SERVICES`. Gmail is bounded-window, so `rebody`
  becomes genuinely useful for it — the current comment in
  [`ipc/index-rebody-rpc.ts`](../../../packages/gateway/src/ipc/index-rebody-rpc.ts) says re-syncing
  Gmail "costs little AND recovers nothing", which stops being true. The membership table gains two
  verified rows.

- Accounting moves **12 full → 14 full**, 1 partial, 2 inert, everywhere it is stated
  (`docs/CHANGELOG.md`, `docs/roadmap.md`, `docs/cli-reference.md`). Dated CHANGELOG entries stay
  historical; the correction goes in the new dated entry.

- `docs/cli-reference.md`'s depth table is corrected: `summary` is a 512-char prefix, and depth is now
  enforced on every sync rather than at reindex time only.

## Testing

| Area | Case |
| --- | --- |
| Depth | `metadata_only` writes no body even when the connector passes `body:` — asserted by reading the column |
| Depth | `metadata_only` leaves `body_preview` NULL too, not just `body` |
| Depth | `metadata_only` does **not** store the title as the body (the `?? row.title` fallback trap) |
| Depth | `summary` downgrades a `body:` caller to 512 with `body_complete = 0` |
| Depth | `full` passes through at the per-type cap |
| Depth | depth is read once per sync, not once per item (assert query count or inject a counting stub) |
| Depth | a connector that passes `bodyPreview:` is unaffected at every depth |
| V49 | `summary` rows become `full`; `metadata_only` and `full` rows are untouched |
| V49 | migration is idempotent on re-run |
| Gmail | multipart `text/plain` preferred over a sibling `text/html` |
| Gmail | `text/html`-only message is stripped to text |
| Gmail | nested `multipart/alternative` inside `multipart/mixed` resolves |
| Gmail | base64url payload with `-`/`_` decodes correctly (a plain-base64 decode would corrupt it) |
| Gmail | a part with `attachmentId` is skipped |
| Gmail | recursion/visit bound holds on a pathological tree |
| Outlook | `contentType: html` is stripped; `text` passes through |
| Outlook | `$select` is present on the initial delta request and NOT re-appended to a followed `nextLink` |
| Outlook | a message with no `body` still indexes title-only |
| Trimmer | each marker form cuts at the right place when it starts a genuine tail |
| Trimmer | **an inline `>` quote followed by more prose is NOT cut** — the reply below it survives |
| Trimmer | an Outlook `From:`/`Sent:`/`To:`/`Subject:` block at the tail is cut |
| Trimmer | a single `From:` line inside a pasted log does not trigger the header-block marker |
| Trimmer | a header block mid-message, with prose below it, is not cut |
| Trimmer | no marker → body unchanged |
| Trimmer | a wholly-quoted body falls back to the untrimmed text rather than returning empty |
| Outlook | a body-less response on a pre-upgrade delta link degrades to title-only rather than erroring |

## Risks

| Risk | Mitigation |
| --- | --- |
| Backfilling `summary`→`full` overrides a user who did mean "less" | Depth was never enforced for bodies, so no such user ever received less; behaviour is preserved, not changed. `metadata_only` — the only level that ever did anything — is untouched |
| Enforcement silently truncates an install whose row is not backfilled | The migration and the two code sites are the same change; a test asserts a fresh connector resolves to `full` |
| `$select` on Outlook's delta breaks pagination | Set on the initial request only; a test asserts it is absent from followed links |
| Gmail `format=full` responses are much larger | Bandwidth only — quota cost is unchanged at 5 units. Attachment bytes are not inlined |
| The trimmer cuts real content | The tail rule is the mitigation: a marker only counts when everything below it to the end of the message is quoted/attribution/signature, so inline quotations followed by more prose are untouched. Never-return-empty covers the wholly-quoted degenerate case. Pure function, pinned by a corpus of awkward shapes |
| Existing Outlook installs see no bodies after upgrade | Their stored delta link encodes the pre-`$select` projection. Documented as requiring one `nimbus index rebody --service outlook`, which is why outlook joins the improvable list here. Must be stated in the release notes or the feature reads as broken |
| Depth enforcement changes every connector's write path | It is one coercion at one site, behind existing store tests; `full` (the post-migration default) is a pass-through, so the common path is unchanged |
