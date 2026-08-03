# Notion + Confluence full-body indexing — design

> **Status:** design approved 2026-08-03 · **Slot:** Spine S1 (Local Brain) · **Schema:** none (V48 substrate only)
> **Follows:** [`2026-08-02-full-body-store-design.md`](./2026-08-02-full-body-store-design.md) (the `item.body` store, merged as #1023 + #1032)

## Problem

Notion and Confluence index **nothing but a title and a URL**. Both connectors pass a
literal empty string as the body:

| Site | Today |
| --- | --- |
| [`connectors/notion-sync.ts:201`](../../../packages/gateway/src/connectors/notion-sync.ts) | `bodyPreview: ""` |
| [`connectors/confluence-sync.ts:141`](../../../packages/gateway/src/connectors/confluence-sync.ts) | `bodyPreview: ""` |

This is not a truncation problem that the full-body store already solved — there is no text
in the index at all. Keyword search over `item_fts` can only match a Notion page by its
title, and the three shipped implicit-knowledge agents (`why`, `glossary`, `decisions`) see
nothing when they read `item.body` for these services.

It also makes an already-published claim false. [`docs/roadmap.md`](../../roadmap.md) Wave 5
states that `nimbus glossary` "extracts and indexes domain-specific terminology from Slack
threads + **Confluence/Notion pages** + Linear/Jira ticket bodies…". The Confluence/Notion
half has never been true and cannot have been — those rows have no body to mine.

Notion and Confluence are where teams write decisions and definitions down. Fixing them
compounds three agents that already ship rather than adding a fourth.

## Goal

`notion:page` and `confluence:page` rows carry real page text in `item.body`, up to the
16 KiB `BODY_MAX_PROSE` cap they are already entitled to, with `item.body_complete`
reporting the truth in every path — including the paths where we deliberately fetch less
than the whole page.

**Non-goals.** Gmail and Outlook (same class — they index ~200-char provider snippets — and
the natural follow-up, but not this slice). Embeddings, which deliberately still read the
512-char `body_preview` so embedding egress stays flat; two source-scanning guards enforce
that and neither is touched here. Any new `nimbus.toml` section.

## Substrate (already merged, V48)

- `item.body` — up to `BODY_MAX_PROSE` (16 KiB) for types in `PROSE_HEAVY_TYPES`,
  `BODY_MAX_DEFAULT` (512) otherwise. Caps in
  [`index/body-caps.ts`](../../../packages/gateway/src/index/body-caps.ts).
- `item.body_complete` — 1 only when a connector passed `body:` **and** the text fit the cap.
- `upsertIndexedItem` takes **either** legacy `bodyPreview?: string` **or** `body?: string`;
  supplying both is a type error.
- **Both target types are already in `PROSE_HEAVY_TYPES`** — verified at
  [`embedding/routing.ts:14-15`](../../../packages/gateway/src/embedding/routing.ts)
  (`notion:page`, `confluence:page`). No routing change is needed; they get 16 KiB the
  moment a `body:` is passed.

Verified clean of the known silent-no-op traps:

- Neither connector uses `MappedRow<S,T>` (which hardcodes `bodyPreview: string` and would
  structurally block a `body:`). Both build an inline object literal at the call site.
- `upsertIndexedItemForSync` → `upsertIndexedItem` clamps exactly once, at
  [`item-store.ts:80-85`](../../../packages/gateway/src/index/item-store.ts), with no hidden
  `.slice()` anywhere on the path. The Jira/Zoom class of bug is not present here.

## The cost asymmetry

This is the finding that shapes the whole design. The two connectors are not comparable.

**Confluence is nearly free.** `confluenceFetchSearchPageBatch` already sends
`expand=history.lastUpdated,space,version`
([`confluence-sync.ts:169`](../../../packages/gateway/src/connectors/confluence-sync.ts)).
Adding `body.storage` costs **zero extra requests** — the same CQL search call returns a
fatter payload. Storage format is XHTML and
[`string/html-plain-text.ts`](../../../packages/gateway/src/string/html-plain-text.ts)
already exists.

**Notion is an N+1.** `POST /v1/search` returns page objects with `properties` but no
content whatsoever. Bodies require `GET /v1/blocks/{page_id}/children`, paginated, once per
page — and again per nested container block. A 1,000-page workspace goes from ~10 requests
per sync to ~1,000+.

Two existing behaviours make that dangerous rather than merely slow:

1. `ctx.rateLimiter.acquire("notion")` is called **once per sync**
   ([`notion-sync.ts:255`](../../../packages/gateway/src/connectors/notion-sync.ts)), before
   the pagination loop — not per request. Adding N per-page fetches under that would be
   effectively unthrottled.
2. A 429 **throws** (`notion-sync.ts:111`), aborting the whole sync. The cursor is only
   returned on success, so the next run restarts from the same watermark and redoes
   everything. A workspace large enough to hit the limit mid-walk would loop forever and
   index nothing.

## Design

### Confluence — expand, don't re-fetch

1. Add `body.storage` to the existing `expand` parameter.
2. Reduce the search batch `limit` from 50 to **25**. Twenty-five pages of storage XHTML is
   already a 1–2 MB response; 50 risks Atlassian truncating or rejecting the expand. This
   doubles the request count of a Confluence sync (still ~2 requests per 50 pages) and is
   the only cost Confluence pays.
3. A new pure helper `confluenceBodyText(row)` reads `row.body.storage.value` and converts
   XHTML to plain text.

A Confluence page's entire body arrives in one shot, so `body_complete` is honest with no
extra machinery: a page under 16 KiB is genuinely complete.

**Storage-format noise is accepted.** Confluence macros survive as
`<ac:structured-macro>` markup; stripping tags keeps the inner text, so macro parameter
values appear as prose. That is noise, not corruption, and it is the text a human sees on
the page. Code macros wrap content in `<![CDATA[…]]>`, which the naive tag stripper partly
swallows — acceptable, and code blocks are not what the glossary/decisions agents mine.
`body.export_view` would render macros properly but is markedly more expensive server-side
and is not reliably available on the search endpoint's `expand`; `body.storage` is the
standard, cheap, always-available choice.

### Notion — a budgeted, resumable block walk

A new module `connectors/notion-page-body.ts` owns the walk, keeping `notion-sync.ts` from
bloating. It exports:

```ts
export const NOTION_BODY_FETCH_BUDGET_PER_SYNC = 200;

export type NotionPageBodyResult = { text: string; truncated: boolean };

export async function fetchNotionPageText(
  deps: { accessToken: string; rateLimiter: ProviderRateLimiter; budget: { left: number } },
  pageId: string,
): Promise<NotionPageBodyResult>;
```

**Walk shape.** `GET /v1/blocks/{id}/children?page_size=100`, paginated via `start_cursor`.
Text comes from each block's `rich_text[].plain_text` (Notion supplies `plain_text` on every
rich-text item — simpler and more faithful than re-walking `text.content`).

**Depth.** Recurse **only** into pure container blocks — `column_list`, `column`, `toggle`,
`synced_block` — and only when `has_children` is true, to a maximum depth of 2. Containers
are the blocks that hold text but carry none of their own: a two-column page returns
essentially nothing without recursion, and toggle-structured FAQ pages are exactly the
"definitions" shape the glossary agent wants. `child_page` and `child_database` are never
followed — they are separate items the search walk already indexes in their own right, and
following them would double-index and blow the budget.

**Budget.** `rateLimiter.acquire("notion")` moves to **per request**, and every request
decrements a per-sync budget of 200. Nested-container requests draw on the same budget as
top-level ones, so a pathological page cannot starve the rest of the workspace.

**Rate limit.** [`sync/rate-limiter.ts:103`](../../../packages/gateway/src/sync/rate-limiter.ts)
raises notion from `requestsPerMinute: 30` to **120** (burst unchanged at 5). Notion's
documented allowance is an average of ~3 requests/second ≈ 180/min; 30 was a safe default
when a sync made ~10 requests, but at a 200-request budget it would mean a ~7-minute sync.
At 120 a full-budget pass is ~100 seconds, still comfortably under the published ceiling.
This is a shared table, so the change is scoped to the single `notion` row and affects no
other provider's quota.

### Skip-if-fresh

Before spending budget on a page, a local read checks whether we already have it:

```
body_complete = 1 AND modified_at == <this page's last_edited_time>
  -> skip the block fetch entirely, and skip the upsert (it would be a no-op write)
```

This is a SQLite read, not an API call. It is what makes repeated passes cheap: pass 5 of a
backfill re-walks search but re-fetches only the pages it has not already completed.

### Convergence

A budget-exhausted pass returns `hasMore: false` with the watermark **unadvanced**, and
Notion's existing 5-minute `defaultIntervalMs` carries the next pass:

```
pass 1: search walk, 200 bodies fetched, 800 pending  -> hasMore:false, watermark PINNED
  ...5 min...
pass 2: search walk, skip 200 complete, fetch 200     -> hasMore:false, watermark PINNED
  ...
pass 5: budget not exhausted                          -> watermark ADVANCES; incremental
```

**Why not `hasMore: true`.** The scheduler treats `hasMore` as an immediate continuation and
`queue.unshift`s the job to the **front** of the queue
([`sync/scheduler.ts:573,589-591`](../../../packages/gateway/src/sync/scheduler.ts)). A
Notion backfill needing twenty passes would re-unshift itself after each one and starve
Slack, Jira, GitHub and every other connector for the duration. Pinning the watermark and
waiting for the ordinary 5-minute tick backfills at ~2,400 pages/hour, needs no scheduler
change, and cannot starve anything. Fixing continuation fairness in the scheduler is a
worthwhile separate change with its own blast radius; it is not this slice.

**The pin condition is "budget exhausted", deliberately not "anything incomplete".** A page
the integration lacks permission to read fails every time. If incompleteness pinned the
watermark, that one page would pin it forever and force a full workspace re-walk every five
minutes in perpetuity. Such a page indexes title-only with `body_complete = 0` and does not
block convergence — `nimbus index rebody` remains the way to retry it deliberately.

### Error handling

A per-page body fetch **never throws**. Any non-OK response returns the text gathered so far
with `truncated: true`; the page still upserts with its title and URL, so the worst case is
exactly today's behaviour for that page and never worse. A **429 additionally zeroes the
remaining budget**, so the pass backs off rather than spending 200 requests discovering it
is rate-limited. The 429 still calls `rateLimiter.penalise("notion", 60_000)` as today.

The existing throw-on-429 in the *search* call is unchanged — the search walk is cheap,
bounded, and a failure there genuinely means the sync cannot proceed.

### The honesty flag

`body_complete` is computed solely as `raw.length <= cap`
([`item-store.ts:85`](../../../packages/gateway/src/index/item-store.ts)), so a connector
cannot express "I passed a body, but I knowingly did not fetch all of it". Budget-truncated
Notion pages need exactly that: their text may be well under 16 KiB while being an
incomplete rendering of the page. Writing `body_complete = 1` there would be a false claim
in the exact column the previous slice added for honesty, and would make
`nimbus index rebody` consider the page done and never retry it.

`IndexedItemBodyInput` gains a third field on the `body` arm only:

```ts
export type IndexedItemBodyInput =
  | { bodyPreview?: string; body?: undefined; bodyTruncated?: undefined }
  | { body: string; bodyPreview?: undefined; bodyTruncated?: boolean };
```

```ts
const bodyComplete = declaredFull && raw.length <= cap && row.bodyTruncated !== true ? 1 : 0;
```

The union's existing "do not relax this" comment block is **updated** to cover the new arm,
not contradicted — the discriminated-union property it defends is preserved: a caller still
cannot pass `bodyPreview` and `body` together, and cannot pass `bodyTruncated` alongside
`bodyPreview`.

### Related fix: pre-truncation defeats the completeness check

`plainTextPreviewFromHtml(raw, maxLen)` slices to `maxLen` **before** the store sees the
text. When called with `BODY_MAX_PROSE`, the store then evaluates `raw.length <= cap` against
already-clipped text and concludes the body is complete — the same silent-no-op class that
bit Jira and Zoom in the previous slice.

[`bitbucket-sync.ts:138`](../../../packages/gateway/src/connectors/bitbucket-sync.ts) does
exactly this. It is latent today (bitbucket emits only `type: "pr"`, which is not in
`PROSE_HEAVY_TYPES`, so it receives the 512-char `BODY_MAX_DEFAULT` and a 16 KiB pre-clip
still exceeds it → `body_complete = 0`, correct by accident). It activates the moment
`bitbucket:pr` is added to `PROSE_HEAVY_TYPES`.

So Confluence must not pre-truncate. `string/html-plain-text.ts` gains a non-truncating
`plainTextFromHtml(raw): string`, `plainTextPreviewFromHtml` is redefined in terms of it, and
the bitbucket call site is switched to the non-truncating form so the store does the clamping
and the completeness verdict. One line of blast radius, in a file this slice already edits.

### `nimbus index rebody`

`REBODY_IMPROVABLE_SERVICES`
([`ipc/index-rebody-rpc.ts:167`](../../../packages/gateway/src/ipc/index-rebody-rpc.ts))
goes from nine services to eleven, adding `confluence` and `notion` in sorted position. It is
an **inclusion** list — absence means "cannot improve", so leaving it unedited would have
`rebody` refuse to promise a fix it can now actually deliver.

The doc comment immediately above it (`index-rebody-rpc.ts:31-37`) currently reads
*"Notion/Confluence are full-scan (expensive) AND cannot complete — the worst combination,
which is exactly why the dry-run result surfaces `cannotImprove`…"*. That becomes false with
this slice and **must be rewritten in the same commit**. Its replacement records what is
still true: both remain full-scan, Confluence now completes in one pass, and Notion completes
over several budgeted passes.

## Accounting

The full-body-store slice's connector accounting is **10 full / 1 partial / 2 inert**. This
slice makes it **12 full / 1 partial / 2 inert**. The "twelve connectors" claim was wrong once
before and had to be retracted, so every surface stating a number is corrected precisely:

| Surface | Change |
| --- | --- |
| [`docs/roadmap.md:912`](../../roadmap.md) | full-body-store entry: 10 → 12 full, naming Notion + Confluence |
| [`docs/roadmap.md:1118`](../../roadmap.md) | Wave 5 `nimbus glossary` — the "Confluence/Notion pages" claim becomes true; annotate with the date it became true |
| [`docs/CHANGELOG.md:47`](../../CHANGELOG.md) | the full-body table's "Full body @ 16 KiB (10)" row → (12) |
| [`docs/CHANGELOG.md:18`](../../CHANGELOG.md) | "nine services" → eleven, with the two new names |
| [`docs/cli-reference.md:2125`](../../cli-reference.md) | "that list is nine services" → eleven, with the two new names |
| [`2026-08-02-full-body-store-design.md`](./2026-08-02-full-body-store-design.md) | **append** a dated follow-up note to § Post-implementation correction — that section is a historical record and is not rewritten |
| `docs/CHANGELOG.md` | new dated delivery entry, per the connector-docs convention |

## Testing

Both existing test files live at `packages/gateway/src/connectors/{notion,confluence}-sync.test.ts`
and import `connector-sync-test-helpers.ts` from the **same directory** — not
`../../test/helpers/` — so extending them in place does not drag never-type-checked files
into the `src/**/*` tsconfig graph. New connector tests go in these files.

`notion-page-body.ts` is a new file under `packages/gateway/src/` and therefore needs **≥80%
line and branch** coverage.

Cases:

| Area | Case |
| --- | --- |
| Confluence | `body.storage.value` XHTML → plain text lands in `item.body` |
| Confluence | macro markup (`<ac:structured-macro>`) strips to its inner text, does not corrupt |
| Confluence | missing/empty `body.storage` → page still indexes, title-only |
| Confluence | a >16 KiB body clamps to the cap and reports `body_complete = 0` |
| Notion | multi-page block pagination via `start_cursor` concatenates in order |
| Notion | container recursion at depth 2 (`column_list` → `column` → text) |
| Notion | `child_page` / `child_database` are **not** followed |
| Notion | depth is capped at 2 — a third level is not requested |
| Notion | budget exhaustion → `truncated` → `body_complete = 0`, asserted by **reading the column**, not by trusting the call |
| Notion | watermark pinned when the budget is exhausted; advanced when it is not |
| Notion | 429 mid-walk → page indexes title-only, remaining budget zeroed, **sync still succeeds** |
| Notion | a non-429 error mid-walk does not pin the watermark |
| Notion | already-complete + unchanged `modified_at` → zero fetches, zero upserts |
| Store | `bodyTruncated: true` forces `body_complete = 0` even for text under the cap |
| Store | passing `bodyPreview` + `bodyTruncated` together is a type error |
| html | `plainTextFromHtml` does not truncate; `plainTextPreviewFromHtml` still does |
| rebody | `confluence` and `notion` are no longer in `cannotImprove` |

## Risks

| Risk | Mitigation |
| --- | --- |
| Confluence `expand=body.storage` behaves differently against a live Cloud instance than against the mocked search response | The `expand` mechanism itself is already exercised by the existing `history.lastUpdated,space,version` expand; the batch limit drop to 25 is the hedge against payload rejection. Verified against mocks in CI; a live discrepancy shows up as an empty body, which degrades to today's behaviour, not to a failure |
| The notion rate-limit bump (30 → 120) is wrong for some workspace or plan tier | 120 is a third under Notion's documented ~180/min. A 429 still penalises for 60s and now also zeroes the pass budget, so the failure mode is a slower backfill, not an aborted sync |
| A very large workspace takes many passes to backfill | By design, and bounded: ~2,400 pages/hour with no effect on other connectors. Progress is visible via `body_complete` counts through `nimbus index rebody --dry-run` |
| `notion-page-body.ts` recursion misses text in an unanticipated container block type | The container set is explicit and small; an unlisted container's own `rich_text` still indexes, only its children are missed. Widening the set later is additive |
