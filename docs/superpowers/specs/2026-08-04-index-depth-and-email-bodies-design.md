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
| `metadata_only` | drop the body input entirely | no body; `body_complete = 0` |
| `summary` | force the `bodyPreview` arm | clamped 512, never claims completeness |
| `full` | pass through unchanged | per-type cap (16 KiB for prose types) |

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

- Prefer the `text/plain` part; fall back to `text/html` decoded then run through the existing
  non-truncating `plainTextFromHtml` (`string/html-plain-text.ts`).
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

### The quoted-tail trimmer

A shared pure module, `string/email-quoted-text.ts`, because IMAP and Fastmail are the obvious next
consumers and this logic must not be duplicated per connector.

Email is heavily self-duplicating: a twenty-message thread quoted in every reply stores the same
paragraphs twenty times, spends each reply's 16 KiB cap on text already indexed, and skews term
frequency for the glossary agent. The trimmer cuts at:

- a run of lines beginning `>` (any nesting depth),
- `On <date>, <someone> wrote:` (and the common localised/wrapped variants),
- `-----Original Message-----`,
- Outlook's `________________________________` divider,
- a trailing `-- ` signature delimiter.

It returns the text **above** the first such marker. It is deliberately conservative: when no marker
matches, the body is returned unchanged.

**The risk is cutting real content**, e.g. a message quoting a `>` code block before adding its own
prose. That is accepted, with two mitigations: the trimmer never returns empty (if trimming would
leave nothing, the untrimmed body is used), and it is a pure function, so it is cheap to test against
a corpus of awkward shapes.

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
| Trimmer | each marker form cuts at the right place |
| Trimmer | no marker → body unchanged |
| Trimmer | trimming to empty falls back to the untrimmed body |
| Trimmer | a `>` inside a fenced code block before real prose — documents the accepted failure |

## Risks

| Risk | Mitigation |
| --- | --- |
| Backfilling `summary`→`full` overrides a user who did mean "less" | Depth was never enforced for bodies, so no such user ever received less; behaviour is preserved, not changed. `metadata_only` — the only level that ever did anything — is untouched |
| Enforcement silently truncates an install whose row is not backfilled | The migration and the two code sites are the same change; a test asserts a fresh connector resolves to `full` |
| `$select` on Outlook's delta breaks pagination | Set on the initial request only; a test asserts it is absent from followed links |
| Gmail `format=full` responses are much larger | Bandwidth only — quota cost is unchanged at 5 units. Attachment bytes are not inlined |
| The trimmer cuts real content | Conservative markers, never-return-empty fallback, pure and heavily tested. Accepted and documented rather than hidden |
| Depth enforcement changes every connector's write path | It is one coercion at one site, behind existing store tests; `full` (the post-migration default) is a pass-through, so the common path is unchanged |
