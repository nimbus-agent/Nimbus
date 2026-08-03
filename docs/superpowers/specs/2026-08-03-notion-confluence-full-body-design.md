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

/** `capped` = permanently truncated (per-page request cap). `errored` = retry next pass. */
export type NotionPageBodyOutcome = "complete" | "capped" | "errored";

export type NotionPageBodyResult = { text: string; outcome: NotionPageBodyOutcome };

export async function fetchNotionPageText(
  deps: { accessToken: string; rateLimiter: ProviderRateLimiter; budget: { left: number } },
  pageId: string,
): Promise<NotionPageBodyResult>;
```

**Walk shape.** `GET /v1/blocks/{id}/children?page_size=100`, paginated via `start_cursor`.
Text comes from each block's `rich_text[].plain_text` (Notion supplies `plain_text` on every
rich-text item — simpler and more faithful than re-walking `text.content`).

**Depth.** Recurse into **any** block with `has_children`, to a maximum depth of 3, with
exactly two exclusions: `child_page` and `child_database`. Those two are separate items the
search walk already indexes in their own right, so following them would double-index and blow
the budget.

The rule is deliberately *not* "pure container blocks only" (`column_list`, `column`,
`toggle`, `synced_block`). Carrying text of its own and having children worth fetching are
independent properties, and conflating them loses real content: `bulleted_list_item`,
`numbered_list_item`, `to_do`, `callout` and `quote` all carry their own `rich_text` **and**
routinely hold nested children. Nested bullets are among the most common structures in a
Notion decision doc, and a containers-only rule would silently drop every sub-bullet. When a
block both has text and has children, both are collected: its own `rich_text` first, then its
children's.

**Why 3 and not 2.** Depth is a cycle guard, not the cost bound — the per-page request cap
below is what actually bounds cost, and it applies identically at either depth. Given that,
depth 2 was simply too shallow to be worth the content it lost: `toggle` → list → sub-list is
an ordinary Notion structure and sits at depth 3, as does `table` → `table_row` → cell text
and two levels of bullet nesting. At depth 2 every such page is permanently `capped`, and
because `capped` is permanent it is then skipped forever with its sub-lists never indexed.
Raising to 3 is never worse on the completeness verdict — a page that completes at depth 2
still completes at depth 3, and a page too deep for 3 was already capped at 2 — it only
spends more of the budget on pages it can now finish. A limit is still needed at all because
`synced_block` references can in principle form a cycle.

**Text extraction is not uniformly `rich_text`.** Most blocks carry their text at
`block[block.type].rich_text`, but two shapes do not, and both are worth having: a `table_row`
holds `cells`, a two-dimensional array of rich-text arrays, and media blocks (`image`, `file`,
`video`, `bookmark`) carry a `caption` with no `rich_text` at all. Tables in particular are a
common way to write a glossary — exactly the content the downstream agents want — so a
`rich_text`-only extractor would return nothing for a page built around one.

**Two bounds, and only one of them can truncate a page.**
`rateLimiter.acquire("notion")` moves to **per request**. Every request decrements a per-sync
budget of `NOTION_BODY_FETCH_BUDGET_PER_SYNC = 200`, and any single page's walk is capped at
`NOTION_BODY_REQUESTS_PER_PAGE_MAX = 10` — necessary once list items are recursed into, since
a list-heavy page could otherwise cost dozens of requests and dominate a whole pass.

The global budget is checked **before starting a page, never during it**: if fewer than
`NOTION_BODY_REQUESTS_PER_PAGE_MAX` requests remain, the pass stops and the page is left
untouched for the next one. A page that is started can therefore always afford to finish.

This is a deliberate invariant, not an incidental ordering: it means **truncation only ever
has permanent causes** — the per-page request cap, or the store's 16 KiB clamp. It is never
caused by the transient global budget. So a truncated page is truncated identically on every
future pass, and re-fetching it can never gain anything. Without this rule the two causes are
indistinguishable in the stored row, and the retryable case (budget) and the permanent case
(page too big) have to be told apart after the fact — which is exactly the trap described
under *Skip-if-fresh* below.

**The connector records the verdict.** Every page it actually attempts is upserted with
`metadata.bodyFetch` set to `"complete"` or `"capped"`. A page it never attempts, and a page
whose fetch errored, carry no `bodyFetch` key at all — so errors retry on the next pass,
which is what we want.

**Rate limit.** [`sync/rate-limiter.ts:103`](../../../packages/gateway/src/sync/rate-limiter.ts)
raises notion from `requestsPerMinute: 30` to **120** (burst unchanged at 5). Notion's
documented allowance is an average of ~3 requests/second ≈ 180/min; 30 was a safe default
when a sync made ~10 requests, but at a 200-request budget it would mean a ~7-minute sync.
At 120 a full-budget pass is ~100 seconds, still comfortably under the published ceiling.
This is a shared table, so the change is scoped to the single `notion` row and affects no
other provider's quota.

### Skip-if-fresh (Notion only)

Before spending budget on a page, a local read checks whether we already have everything we
are ever going to fetch for it:

```
modified_at == isoMs(<this page's last_edited_time>)
  AND json_extract(metadata, '$.bodyFetch') IS NOT NULL
  -> skip the block fetch entirely, and skip the upsert (it would be a no-op write)
```

This is a SQLite read, not an API call. It is what makes repeated passes cheap: pass 5 of a
backfill re-walks search but re-fetches only the pages it has not already completed.

**Confluence has no skip-if-fresh and does not need one.** Its body arrives inside the search
payload that the sync already pays for, so skipping saves neither a request nor bandwidth.
The check exists solely to protect the Notion per-page fetch budget.

**Why this keys on `metadata.bodyFetch` and not on `body_complete`, and why that is
load-bearing rather than an optimisation.** A page whose text genuinely exceeds 16 KiB, or
whose block tree exceeds the per-page request cap, is stored with `body_complete = 0` —
correct and permanent, since re-fetching can never improve it. A `body_complete = 1` check
alone would therefore never skip such a page, and every pass would re-fetch its whole block
tree forever. That is not merely wasted quota: **if a workspace holds more than
`NOTION_BODY_FETCH_BUDGET_PER_SYNC / NOTION_BODY_REQUESTS_PER_PAGE_MAX` such pages, the budget
is exhausted on every pass, the watermark is pinned on every pass, and Notion never converges
to incremental sync** — it re-walks the entire workspace every five minutes in perpetuity.
This check is what makes the convergence guarantee above actually hold.

A length heuristic (`length(body) >= BODY_MAX_PROSE`) was considered as a way to detect the
16 KiB case without a metadata key, and rejected on two counts. It cannot see the per-page-cap
case at all, since such a page is usually well under the cap. And it is off by one against
`clampBody` ([`body-caps.ts:24-31`](../../../packages/gateway/src/index/body-caps.ts)), which
drops one extra unit when the cut would split a surrogate pair — so a clamped body can be
exactly `cap - 1` long, and a `>= cap` test would silently fail to skip precisely the pages
most likely to contain emoji or other non-BMP text. An explicit verdict written by the
connector that knows why it stopped is both narrower and more honest than inferring the reason
from a length.

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

**A pinned pass logs.** The sync reports success with `hasMore: false` on every pass, so
nothing otherwise distinguishes "converged" from "still working through a 10,000-page
workspace" — a backfill that takes hours is completely invisible. A budget-stopped pass emits
one `ctx.logger.info` naming the service and the count upserted. Deliberately a log line and
not sync telemetry: `sync_telemetry` already records `hadMore`, and adding a distinct
"pinned" signal there would be a schema change for an operability nicety.

**The pin condition is "the budget stopped the pass", deliberately not "anything incomplete".**
Two kinds of page are permanently incomplete: one the integration lacks permission to read,
and one whose block tree exceeds the per-page request cap. If incompleteness pinned the
watermark, either kind would pin it forever and force a full workspace re-walk every five
minutes in perpetuity. Both index with `body_complete = 0` and neither blocks convergence —
`nimbus index rebody` remains the way to retry them deliberately.

### Error handling

A per-page body fetch **never throws**. Any non-OK response returns the text gathered so far
with `outcome: "errored"`; the page still upserts with its title, URL and whatever text was
recovered, so the worst case is exactly today's behaviour for that page and never worse. A
**429 additionally zeroes the remaining budget**, so the pass backs off rather than spending
200 requests discovering it is rate-limited. The 429 still calls
`rateLimiter.penalise("notion", 60_000)` as today.

`"errored"` is deliberately a distinct outcome from `"capped"`, not a flavour of truncation.
Both set `bodyTruncated: true` and so both write `body_complete = 0`, but only `"capped"`
records `metadata.bodyFetch`. An error is a transient condition — a network blip, a 429, a
permission that gets granted tomorrow — and must be retried on the next pass; a cap is a
permanent property of the page and must never be retried. Collapsing the two would either
strand errored pages forever or re-fetch capped pages forever, depending on which way it
collapsed.

The existing throw-on-429 in the *search* call is unchanged — the search walk is cheap,
bounded, and a failure there genuinely means the sync cannot proceed.

### The honesty flag

`body_complete` is computed solely as `raw.length <= cap`
([`item-store.ts:85`](../../../packages/gateway/src/index/item-store.ts)), so a connector
cannot express "I passed a body, but I knowingly did not fetch all of it". Notion pages with
outcome `"capped"` or `"errored"` need exactly that: their text may be well under 16 KiB
while being an incomplete rendering of the page. Writing `body_complete = 1` there would be a
false claim in the exact column the previous slice added for honesty, and would make
`nimbus index rebody` consider the page done and never retry it. The connector therefore
passes `bodyTruncated: outcome !== "complete"`.

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
| Notion | recursion through a container (`column_list` → `column` → text) |
| Notion | `toggle` → `bulleted_list_item` → sub-bullet resolves fully at depth 3 |
| Notion | a `table` → `table_row` yields its `cells` text, joined |
| Notion | an image/file `caption` is indexed when the block has no `rich_text` |
| Notion | recursion into a `bulleted_list_item` that has children collects **both** its own text and its sub-bullets, in order |
| Notion | `child_page` / `child_database` are **not** followed |
| Notion | depth is capped at 3 — a fourth level is not requested, and the page reports `capped` |
| Notion | a page is never **started** when fewer than `NOTION_BODY_REQUESTS_PER_PAGE_MAX` requests remain — asserted by counting fetches, so budget can never truncate a page mid-walk |
| Notion | per-page cap hit → `truncated` → `body_complete = 0` **and** `metadata.bodyFetch = "capped"`, asserted by **reading the columns**, not by trusting the call |
| Notion | a `"capped"` page with unchanged `modified_at` is skipped on the next pass — the regression test for the perpetual-re-fetch trap |
| Notion | >200 capped pages still converge: the watermark advances rather than pinning every pass |
| Notion | watermark pinned when the budget stops the pass; advanced when it does not |
| Notion | 429 mid-walk → page indexes title-only, **no** `metadata.bodyFetch` key, remaining budget zeroed, **sync still succeeds** |
| Notion | an errored page is retried on the next pass (absence of `bodyFetch` is the retry signal) |
| Notion | a non-429 error mid-walk does not pin the watermark |
| Notion | `bodyFetch = "complete"` + unchanged `modified_at` → zero fetches, zero upserts |
| Notion | changed `modified_at` re-fetches even when `bodyFetch` is present |
| Store | `bodyTruncated: true` forces `body_complete = 0` even for text under the cap |
| Store | passing `bodyPreview` + `bodyTruncated` together is a type error |
| html | `plainTextFromHtml` does not truncate; `plainTextPreviewFromHtml` still does |
| rebody | `confluence` and `notion` are no longer in `cannotImprove` |

## Deferred, with triggers

Two review findings are real but deliberately not addressed in this slice. Each is recorded
with the concrete condition that should reopen it.

### Search-walk amplification on large workspaces

Because the watermark is pinned until the backlog drains, every pass re-walks the search
result set from the beginning. The re-walk is cheap **per page** — skip-if-fresh is a SQLite
read, not an API call — but the search requests themselves are real, and they are quadratic in
workspace size:

```
passes           = N / BUDGET
search reqs/pass = N / 100          (page_size = 100)
total search     = N² / (100 · BUDGET)
```

| Workspace | Body requests | Search requests | Amplification |
| --- | --- | --- | --- |
| 1,000 pages | 1,000 | 50 | 1.05× |
| 10,000 pages | 10,000 | 5,000 | 1.5× |
| 50,000 pages | 50,000 | 125,000 | 3.5× |

Acceptable to ~10,000 pages, poor beyond it. **The obvious fix — persisting a search
`start_cursor` across passes — is not safe.** Notion's `/v1/search` sorts by
`last_edited_time` descending, so the result set reorders whenever anyone edits a page. A
cursor resumed five minutes later indexes into a set that has shifted underneath it, silently
skipping or duplicating pages. Notion's search also accepts no `last_edited_time` filter (only
an `object` type filter and a sort), so the walk cannot be narrowed server-side either. A
correct fix needs a locally persisted backlog queue keyed by page id, which is a schema change
and its own design.

**Trigger to reopen:** a real workspace above ~10,000 pages, or an observed initial backfill
that does not converge within a day.

### Confluence batch-size fallback

The review suggests retrying a failed batch at a smaller `limit` (10 or 5) when a fattened
`body.storage` payload provokes a timeout or 502/504. Not implemented: this is a speculative
failure with no observation behind it, `limit=25` with a body expand is ordinary Atlassian
usage, and an adaptive-retry path adds branches that each need ≥80% coverage to defend a
hypothesis.

Worth being explicit about the failure mode we are accepting, since it is pre-existing and
this change makes it marginally more likely: a non-OK Confluence search response **throws**,
aborting the sync without advancing the cursor, so the next scheduled tick retries the same
request. A persistent 5xx on one batch means that connector stops making progress — it is not
silent, and it is not data loss, but it is a stall.

**Trigger to reopen:** any observed timeout or 502/504 from the expanded search. The fix is
then a single one-shot retry of that batch at `limit=10`, not general adaptive sizing.

## Risks

| Risk | Mitigation |
| --- | --- |
| Confluence `expand=body.storage` behaves differently against a live Cloud instance than against the mocked search response | The `expand` mechanism itself is already exercised by the existing `history.lastUpdated,space,version` expand; the batch limit drop to 25 is the hedge against payload rejection. Verified against mocks in CI; a live discrepancy shows up as an empty body, which degrades to today's behaviour, not to a failure |
| The notion rate-limit bump (30 → 120) is wrong for some workspace or plan tier | 120 is a third under Notion's documented ~180/min. A 429 still penalises for 60s and now also zeroes the pass budget, so the failure mode is a slower backfill, not an aborted sync |
| A very large workspace takes many passes to backfill | By design, and bounded: ~2,400 pages/hour with no effect on other connectors. Progress is visible via `body_complete` counts through `nimbus index rebody --dry-run`. Search-request amplification above ~10,000 pages is quantified and deferred — see [§ Deferred](#search-walk-amplification-on-large-workspaces) |
| A page's text is missed below depth 3 | Recursion follows any `has_children` block to three levels, which covers `toggle` → list → sub-list and `table` → `table_row`. What remains uncaptured is genuinely deep nesting, and such a page reports `capped`, so it is visible as `body_complete = 0` rather than silently wrong |
| `metadata.bodyFetch` makes `metadata` load-bearing for sync control flow, not just display | It is a connector-owned key on a connector-owned row, read by exactly one query in the same connector. It stays well inside the 64 KB `RAW_META_MAX_BYTES` limit and is invisible to every other consumer |
