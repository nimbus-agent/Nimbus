# Notion + Confluence Full-Body Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `notion:page` and `confluence:page` index real page bodies in `item.body` instead of the empty string they write today, with `item.body_complete` telling the truth in every path.

**Architecture:** Confluence adds `body.storage` to a search `expand` it already sends — zero extra API requests. Notion has no body in its search response at all, so it needs a per-page block walk, which is bounded by two limits (a per-sync request budget and a per-page request cap) arranged so that truncation only ever has *permanent* causes. A connector-written `metadata.bodyFetch` verdict lets later passes skip pages that can never improve, which is what makes a large-workspace backfill converge instead of re-fetching forever.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict, `bun:sqlite`, `bun:test`, Biome.

**Design spec:** [`../specs/2026-08-03-notion-confluence-full-body-design.md`](../specs/2026-08-03-notion-confluence-full-body-design.md)
**Review folded in:** [`../specs/2026-08-03-notion-confluence-full-body-design-review.md`](../specs/2026-08-03-notion-confluence-full-body-design-review.md)

## Global Constraints

- **No `any`.** External JSON is `unknown`, narrowed with `asRecord` / `stringField`. TypeScript strict mode is non-negotiable.
- **New files under `packages/gateway/src/` need ≥80% line AND branch coverage.** Only `notion-page-body.ts` is new.
- **Connector tests stay in `packages/gateway/src/connectors/`.** Both existing test files import `./connector-sync-test-helpers.ts` from that same directory. Never add a test under `packages/gateway/src/` that imports `../../test/helpers/` — `tsconfig.json` includes `src/**/*` only, and doing so drags never-type-checked files into the graph and reds typecheck.
- **`db.query()`, never `db.prepare()`.** An unfinalized `db.prepare()` makes `db.close()` a silent no-op and pins the file (EBUSY on Windows). `db.query()` is cache-managed by `bun:sqlite`.
- **Trace every value to its origin before editing.** A `bodyPreview:` → `body:` swap is a silent no-op if anything upstream already truncated. This plan's Task 1 exists because two call sites do exactly that.
- **Gates are run individually in this worktree.** `bun run lint`, `test:ci` and `preflight` are all broken inside `.claude/worktrees/` (Biome path quirk reports `Checked 0 files`, exit 1; `ci-tests.ts:129` runs lint before the suite). For lint use exactly `bunx biome check --error-on-warnings <dirs>` — CI uses `--error-on-warnings` and omitting it is weaker than CI.
- **Run `bun install` in the worktree before the first test run.** A fresh worktree has no `node_modules` and every suite fake-fails without it.
- **Commit on this branch only** (`dev/asaf/notion-confluence-full-body`). Never `git add -A` — `.claude/settings.local.json` is git-tracked.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `packages/gateway/src/string/html-plain-text.ts` | Add non-truncating `plainTextFromHtml`; keep `plainTextPreviewFromHtml` as a thin wrapper | 1 |
| `packages/gateway/src/connectors/_lib/teams/api.ts` | Stop pre-truncating before `body:` (live false-completeness bug) | 1 |
| `packages/gateway/src/connectors/bitbucket-sync.ts` | Same fix, latent | 1 |
| `packages/gateway/src/index/item-store.ts` | `bodyTruncated` input flag; `selectItemBodyFetchState` read | 2 |
| `packages/gateway/src/connectors/confluence-sync.ts` | `body.storage` expand, `limit` 25, `confluenceBodyText` | 3 |
| `packages/gateway/src/connectors/notion-page-body.ts` | **New.** Block walk: pagination, depth-2 recursion, per-page cap, outcome | 4 |
| `packages/gateway/src/connectors/notion-sync.ts` | Wire the walk: per-request throttle, budget, skip-if-fresh, watermark pin | 5 |
| `packages/gateway/src/sync/rate-limiter.ts` | notion `requestsPerMinute` 30 → 120 | 5 |
| `packages/gateway/src/ipc/index-rebody-rpc.ts` | `REBODY_IMPROVABLE_SERVICES` + rewrite its now-false doc comment | 6 |
| `docs/*` | Accounting 10 → 12 full, everywhere it is stated | 7 |

Task order matters: 1 and 2 are independent leaves; 3 needs 1; 5 needs 2 and 4; 6 needs 3 and 5.

---

### Task 1: Non-truncating HTML→text, and the two call sites that pre-truncate

**Files:**
- Modify: `packages/gateway/src/string/html-plain-text.ts:39-42`
- Modify: `packages/gateway/src/connectors/_lib/teams/api.ts:55`
- Modify: `packages/gateway/src/connectors/bitbucket-sync.ts:138`
- Test: `packages/gateway/src/string/html-plain-text.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `plainTextFromHtml(raw: string): string` — strips tags and collapses whitespace with **no length limit**. Task 3 uses it.

**Why this task exists.** `plainTextPreviewFromHtml(raw, BODY_MAX_PROSE)` slices to 16384 *before* `upsertIndexedItem` sees the text. The store then computes `body_complete` as `raw.length <= cap` (`item-store.ts:85`) against already-clipped text and concludes the body is complete. `teams:message` is in `PROSE_HEAVY_TYPES`, so this is a live false-completeness claim today, not a hypothetical.

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/src/string/html-plain-text.test.ts`:

```ts
import { plainTextFromHtml, plainTextPreviewFromHtml } from "./html-plain-text.ts";

test("plainTextFromHtml does not truncate", () => {
  const long = `<p>${"a".repeat(20_000)}</p>`;
  expect(plainTextFromHtml(long).length).toBe(20_000);
});

test("plainTextFromHtml strips tags and collapses whitespace", () => {
  expect(plainTextFromHtml("<p>one</p>\n\n  <p>two</p>")).toBe("one two");
});

test("plainTextPreviewFromHtml still truncates to maxLen", () => {
  const long = `<p>${"a".repeat(20_000)}</p>`;
  expect(plainTextPreviewFromHtml(long, 512).length).toBe(512);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/string/html-plain-text.test.ts`
Expected: FAIL — `plainTextFromHtml is not a function` / import error.

- [ ] **Step 3: Add the helper and re-express the preview in terms of it**

Replace `html-plain-text.ts:39-42` with:

```ts
/** Full plain text — no length limit. Let the store apply the cap so
 *  `body_complete` is computed against the real length, not a pre-clipped one. */
export function plainTextFromHtml(raw: string): string {
  return collapseWhitespace(stripHtmlTagsToSpaces(raw));
}

export function plainTextPreviewFromHtml(raw: string, maxLen: number): string {
  const plain = plainTextFromHtml(raw);
  return plain.length > maxLen ? plain.slice(0, maxLen) : plain;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/string/html-plain-text.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing regression test for the Teams bug**

Add to `packages/gateway/src/connectors/teams-sync.test.ts` (find the existing message-upsert test for the surrounding harness and mirror it; the assertion is the point):

```ts
test("a Teams message over the prose cap is not reported complete", async () => {
  // 20 KiB of body content, well over BODY_MAX_PROSE (16384)
  const huge = "x".repeat(20_000);
  // ...drive the existing sync harness so one message with body.content = huge is indexed...
  const row = db
    .query<{ body_complete: number; len: number }, []>(
      "SELECT body_complete, length(body) AS len FROM item WHERE service = 'teams'",
    )
    .get();
  expect(row?.len).toBe(16_384);
  expect(row?.body_complete).toBe(0); // was 1 — the bug
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test packages/gateway/src/connectors/teams-sync.test.ts`
Expected: FAIL — `body_complete` is `1`.

- [ ] **Step 7: Fix both call sites**

`_lib/teams/api.ts:55` — drop the pre-clip. `preview` below it stays; it only feeds the title deriver:

```ts
const full = plainTextFromHtml(content);
const preview = full.slice(0, 512);
```

and change the import on line 4 to `plainTextFromHtml`. `BODY_MAX_PROSE` is then unused in that file — remove the line-1 import too, or Biome's unused-import rule fails the lint gate.

`bitbucket-sync.ts:138`:

```ts
    body: plainTextFromHtml(desc),
```

with the same import swap on line 4, and drop the now-unused `BODY_MAX_PROSE` import if nothing else in the file uses it (grep before deleting — it may also be used elsewhere).

- [ ] **Step 8: Run the affected suites**

Run: `bun test packages/gateway/src/connectors/teams-sync.test.ts packages/gateway/src/connectors/bitbucket-sync.test.ts packages/gateway/src/string/`
Expected: PASS.

- [ ] **Step 9: Lint and typecheck**

Run: `bunx tsc --noEmit -p packages/gateway/tsconfig.json && bunx biome check --error-on-warnings packages/gateway/src/string packages/gateway/src/connectors`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add packages/gateway/src/string/html-plain-text.ts packages/gateway/src/string/html-plain-text.test.ts packages/gateway/src/connectors/_lib/teams/api.ts packages/gateway/src/connectors/bitbucket-sync.ts packages/gateway/src/connectors/teams-sync.test.ts
git commit -m "fix: pre-truncating HTML defeated the body_complete check"
```

---

### Task 2: Store support — `bodyTruncated` input and the fetch-state read

**Files:**
- Modify: `packages/gateway/src/index/item-store.ts:40-56` (the union + its comment), `:85` (the verdict)
- Modify: `packages/gateway/src/index/item-store.ts` (append `selectItemBodyFetchState`)
- Test: `packages/gateway/src/index/item-store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `IndexedItemBodyInput` gains `bodyTruncated?: boolean` on the `body` arm only.
  - `selectItemBodyFetchState(db: Database, id: string): ItemBodyFetchState | null`
  - `type ItemBodyFetchState = { modifiedAt: number; bodyFetch: string | null }`

  Task 5 uses both.

- [ ] **Step 1: Write the failing tests**

```ts
import { selectItemBodyFetchState, upsertIndexedItem } from "./item-store.ts";

test("bodyTruncated forces body_complete = 0 even under the cap", () => {
  const db = createMemoryIndexDb();
  upsertIndexedItem(db, {
    service: "notion", type: "page", externalId: "p1", title: "T",
    body: "short text", bodyTruncated: true,
    modifiedAt: 1000, syncedAt: 1000,
  });
  const row = db
    .query<{ body_complete: number }, []>("SELECT body_complete FROM item")
    .get();
  expect(row?.body_complete).toBe(0);
  db.close();
});

test("body without bodyTruncated still reports complete", () => {
  const db = createMemoryIndexDb();
  upsertIndexedItem(db, {
    service: "notion", type: "page", externalId: "p2", title: "T",
    body: "short text",
    modifiedAt: 1000, syncedAt: 1000,
  });
  const row = db
    .query<{ body_complete: number }, []>("SELECT body_complete FROM item")
    .get();
  expect(row?.body_complete).toBe(1);
  db.close();
});

test("selectItemBodyFetchState reads modified_at and metadata.bodyFetch", () => {
  const db = createMemoryIndexDb();
  upsertIndexedItem(db, {
    service: "notion", type: "page", externalId: "p3", title: "T",
    body: "text", modifiedAt: 4242, syncedAt: 1000,
    metadata: { notionPageId: "p3", bodyFetch: "capped" },
  });
  expect(selectItemBodyFetchState(db, "notion:p3")).toEqual({
    modifiedAt: 4242,
    bodyFetch: "capped",
  });
  db.close();
});

test("selectItemBodyFetchState returns null bodyFetch when the key is absent", () => {
  const db = createMemoryIndexDb();
  upsertIndexedItem(db, {
    service: "notion", type: "page", externalId: "p4", title: "T",
    bodyPreview: "", modifiedAt: 7, syncedAt: 1000, metadata: { notionPageId: "p4" },
  });
  expect(selectItemBodyFetchState(db, "notion:p4")).toEqual({ modifiedAt: 7, bodyFetch: null });
  db.close();
});

test("selectItemBodyFetchState returns null for an unknown id", () => {
  const db = createMemoryIndexDb();
  expect(selectItemBodyFetchState(db, "notion:nope")).toBeNull();
  db.close();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/index/item-store.test.ts`
Expected: FAIL — `selectItemBodyFetchState is not a function`, and the first test reports `1`.

- [ ] **Step 3: Widen the union**

Replace the type at `item-store.ts:54-56`:

```ts
export type IndexedItemBodyInput =
  | { bodyPreview?: string; body?: undefined; bodyTruncated?: undefined }
  | { body: string; bodyPreview?: undefined; bodyTruncated?: boolean };
```

Add to the doc comment above it (do not delete the existing text — it documents why the union must not be relaxed to a runtime check):

```
 * `bodyTruncated` rides the `body` arm only. It lets a connector say "I
 * fetched a body, and I know it is not all of it" — the one thing the
 * length-vs-cap test cannot express, because such a body is usually well
 * under the cap. It is deliberately unavailable on the `bodyPreview` arm,
 * which never claims completeness in the first place.
```

- [ ] **Step 4: Apply the flag in the verdict**

`item-store.ts:85`:

```ts
  const bodyComplete = declaredFull && raw.length <= cap && row.bodyTruncated !== true ? 1 : 0;
```

- [ ] **Step 5: Add the read helper**

Append to `item-store.ts`:

```ts
export type ItemBodyFetchState = { modifiedAt: number; bodyFetch: string | null };

/**
 * The two facts a connector needs to decide whether re-fetching an item's body
 * could gain anything: when we last saw it change, and the verdict the
 * connector recorded last time it tried. A `bodyFetch` of `"complete"` or
 * `"capped"` both mean "do not re-fetch"; `null` means never attempted, or
 * attempted and errored, so retry.
 */
export function selectItemBodyFetchState(db: Database, id: string): ItemBodyFetchState | null {
  const row = db
    .query<{ modified_at: number; body_fetch: string | null }, [string]>(
      `SELECT modified_at, json_extract(metadata, '$.bodyFetch') AS body_fetch
         FROM item WHERE id = ?`,
    )
    .get(id);
  return row === null
    ? null
    : { modifiedAt: row.modified_at, bodyFetch: row.body_fetch };
}
```

- [ ] **Step 6: Run to verify they pass**

Run: `bun test packages/gateway/src/index/item-store.test.ts`
Expected: PASS.

- [ ] **Step 7: Prove the union still rejects the illegal combination**

This must be checked with the compiler, not a runtime test. Temporarily add to any gateway source file:

```ts
upsertIndexedItem(db, {
  service: "x", type: "y", externalId: "z", title: "t",
  bodyPreview: "a", bodyTruncated: true,
  modifiedAt: 1, syncedAt: 1,
});
```

Run: `bunx tsc --noEmit -p packages/gateway/tsconfig.json`
Expected: FAIL with TS2345. **Then delete the probe** and re-run to confirm clean.

- [ ] **Step 8: Run the full index suite and lint**

Run: `bun test packages/gateway/src/index/ && bunx biome check --error-on-warnings packages/gateway/src/index`
Expected: PASS, clean.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/index/item-store.ts packages/gateway/src/index/item-store.test.ts
git commit -m "feat: bodyTruncated input flag and item body-fetch state read"
```

---

### Task 3: Confluence — expand `body.storage`

**Files:**
- Modify: `packages/gateway/src/connectors/confluence-sync.ts` (imports, `:104-151`, `:169`, `:205`)
- Test: `packages/gateway/src/connectors/confluence-sync.test.ts`

**Interfaces:**
- Consumes: `plainTextFromHtml` (Task 1).
- Produces: `confluenceBodyText(row: Record<string, unknown>): string | null` — `null` when the row carries no `body.storage.value` at all.

**Note on the `null` return.** An absent expand and a genuinely empty page must not be conflated. If `confluenceBodyText` returned `""` for a missing expand, the store would see `raw.length (0) <= cap` and write `body_complete = 1` — claiming a complete body for a page whose body we never received. `null` routes to the legacy `bodyPreview` arm, which never claims completeness.

- [ ] **Step 1: Write the failing tests**

```ts
test("indexes the storage body as full text", async () => {
  const { db, vault, ...extras } = makeCtx();
  globalThis.fetch = makeFetch(200, JSON.stringify({
    results: [makePageResult({
      body: { storage: { value: "<p>Hello <b>there</b></p>", representation: "storage" } },
    })],
  }));
  await createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} })
    .sync({ db, vault, ...extras }, null);
  const row = db
    .query<{ body: string; body_complete: number }, []>(
      "SELECT body, body_complete FROM item WHERE service = 'confluence'",
    )
    .get();
  expect(row?.body).toBe("Hello there");
  expect(row?.body_complete).toBe(1);
  db.close();
});

test("requests the body.storage expand at limit 25", async () => {
  const seen: string[] = [];
  const { db, vault, ...extras } = makeCtx();
  globalThis.fetch = ((input: SyncTestFetchParams[0]) => {
    seen.push(urlFromFetchInput(input));
    return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }));
  }) as typeof fetch;
  await createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} })
    .sync({ db, vault, ...extras }, null);
  expect(seen[0]).toContain("body.storage");
  expect(seen[0]).toContain("limit=25");
  db.close();
});

test("a page with no body.storage indexes title-only and does not claim completeness", async () => {
  const { db, vault, ...extras } = makeCtx();
  globalThis.fetch = makeFetch(200, JSON.stringify({ results: [makePageResult()] }));
  await createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} })
    .sync({ db, vault, ...extras }, null);
  const row = db
    .query<{ body: string; body_complete: number }, []>(
      "SELECT body, body_complete FROM item WHERE service = 'confluence'",
    )
    .get();
  expect(row?.body_complete).toBe(0);
  db.close();
});

test("a storage body over the prose cap clamps and reports incomplete", async () => {
  const { db, vault, ...extras } = makeCtx();
  globalThis.fetch = makeFetch(200, JSON.stringify({
    results: [makePageResult({ body: { storage: { value: `<p>${"z".repeat(20_000)}</p>` } } })],
  }));
  await createConfluenceSyncable({ ensureConfluenceMcpRunning: async () => {} })
    .sync({ db, vault, ...extras }, null);
  const row = db
    .query<{ len: number; body_complete: number }, []>(
      "SELECT length(body) AS len, body_complete FROM item WHERE service = 'confluence'",
    )
    .get();
  expect(row?.len).toBe(16_384);
  expect(row?.body_complete).toBe(0);
  db.close();
});

test("macro markup strips to its inner text", () => {
  expect(
    confluenceBodyText({
      body: {
        storage: {
          value:
            '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Note</p></ac:rich-text-body></ac:structured-macro>',
        },
      },
    }),
  ).toBe("Note");
});
```

`confluenceBodyText` must be exported for that last test.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/connectors/confluence-sync.test.ts`
Expected: FAIL — `body` is `""`, `limit=50`, no `body.storage` in the URL.

- [ ] **Step 3: Add the body extractor**

Add near the other row helpers in `confluence-sync.ts`, and import `plainTextFromHtml` from `../string/html-plain-text.ts` plus `IndexedItemBodyInput` from `../index/item-store.ts`:

```ts
/**
 * `null` (not `""`) when the row carries no storage body at all — an absent
 * expand must not be indistinguishable from an empty page, or the store would
 * report `body_complete = 1` for a body we never received.
 */
export function confluenceBodyText(row: Record<string, unknown>): string | null {
  const body = asRecord(row["body"]);
  const storage = body === undefined ? undefined : asRecord(body["storage"]);
  const value = storage === undefined ? undefined : stringField(storage, "value");
  return value === undefined ? null : plainTextFromHtml(value);
}
```

- [ ] **Step 4: Pass it through the upsert**

In `confluenceUpsertOneSearchHit`, replace `bodyPreview: "",` (line ~141) by building the arm explicitly — a conditional spread keeps the discriminated union intact:

```ts
  const text = confluenceBodyText(row);
  const bodyInput: IndexedItemBodyInput = text === null ? { bodyPreview: "" } : { body: text };
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "page",
    externalId: id,
    title: title.length > 512 ? title.slice(0, 512) : title,
    ...bodyInput,
    url: webUi,
    canonicalUrl: webUi,
    modifiedAt: Number.isFinite(modified) ? modified : opts.syncTime,
    authorId,
    metadata: { confluencePageId: id },
    pinned: false,
    syncedAt: opts.syncTime,
  });
```

- [ ] **Step 5: Expand the search and shrink the batch**

`confluenceFetchSearchPageBatch`, the `qs` construction (~line 169):

```ts
    expand: "history.lastUpdated,space,version,body.storage",
```

`confluenceRunPagedSearch` (~line 205) — 25 pages of storage XHTML is already a 1–2 MB response; 50 risks Atlassian truncating or rejecting the expand:

```ts
  const limit = 25;
```

- [ ] **Step 6: Run to verify they pass**

Run: `bun test packages/gateway/src/connectors/confluence-sync.test.ts`
Expected: PASS.

- [ ] **Step 7: Lint and typecheck**

Run: `bunx tsc --noEmit -p packages/gateway/tsconfig.json && bunx biome check --error-on-warnings packages/gateway/src/connectors`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/connectors/confluence-sync.ts packages/gateway/src/connectors/confluence-sync.test.ts
git commit -m "feat: index Confluence page bodies via the body.storage expand"
```

---

### Task 4: `notion-page-body.ts` — the bounded block walk

**Files:**
- Create: `packages/gateway/src/connectors/notion-page-body.ts`
- Test: `packages/gateway/src/connectors/notion-page-body.test.ts`

**Interfaces:**
- Consumes: `asRecord`, `stringField` from `./unknown-record.ts`; `ProviderRateLimiter` from `../sync/rate-limiter.ts`.
- Produces (all used by Task 5):
  - `NOTION_BODY_FETCH_BUDGET_PER_SYNC = 200`
  - `NOTION_BODY_REQUESTS_PER_PAGE_MAX = 10`
  - `type NotionPageBodyOutcome = "complete" | "capped" | "errored"`
  - `type NotionPageBodyResult = { text: string; outcome: NotionPageBodyOutcome; bytes: number }`
  - `type NotionBlockFetchDeps = { accessToken: string; rateLimiter: ProviderRateLimiter; budget: { left: number } }`
  - `fetchNotionPageText(deps: NotionBlockFetchDeps, pageId: string): Promise<NotionPageBodyResult>`
  - `notionRichTextToPlain(richText: unknown): string`
  - `notionBlockOwnText(block: Record<string, unknown>): string`

**`bytes` is an addition to the spec's declared type** — the sync's `SyncResult.bytesTransferred` must account for block traffic, and threading a counter through the walk is noisier than returning it.

**This file needs ≥80% line and branch coverage.** Every `continue` and every guard below needs a test that reaches it; the case list in Step 1 is built to do that.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from "bun:test";

import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import {
  fetchNotionPageText,
  NOTION_BODY_REQUESTS_PER_PAGE_MAX,
  notionBlockOwnText,
  notionRichTextToPlain,
} from "./notion-page-body.ts";
import { describeWithFetchRestore, urlFromFetchInput } from "./connector-sync-test-helpers.ts";

function para(id: string, text: string, hasChildren = false): Record<string, unknown> {
  return {
    id,
    type: "paragraph",
    has_children: hasChildren,
    paragraph: { rich_text: [{ type: "text", plain_text: text }] },
  };
}

function bullet(id: string, text: string, hasChildren = false): Record<string, unknown> {
  return {
    id,
    type: "bulleted_list_item",
    has_children: hasChildren,
    bulleted_list_item: { rich_text: [{ type: "text", plain_text: text }] },
  };
}

/** Route block-children requests by parent block id, taken from the URL path. */
function routedFetch(byParent: Record<string, unknown[]>, status = 200): typeof fetch {
  return ((input: Parameters<typeof fetch>[0]) => {
    const url = urlFromFetchInput(input);
    const m = /\/v1\/blocks\/([^/]+)\/children/.exec(url);
    const parent = m?.[1] ?? "";
    if (status !== 200) {
      return Promise.resolve(new Response("{}", { status }));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({ results: byParent[parent] ?? [], has_more: false, next_cursor: null }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;
}

function deps(budgetLeft = 100) {
  return {
    accessToken: "tok",
    rateLimiter: new ProviderRateLimiter(),
    budget: { left: budgetLeft },
  };
}

describeWithFetchRestore("notion-page-body", () => {
  test("notionRichTextToPlain joins plain_text and ignores junk", () => {
    expect(notionRichTextToPlain([{ plain_text: "a" }, "junk", { plain_text: "b" }])).toBe("ab");
    expect(notionRichTextToPlain("not-an-array")).toBe("");
  });

  test("notionBlockOwnText reads the type-keyed rich_text", () => {
    expect(notionBlockOwnText(para("b1", "hello"))).toBe("hello");
    expect(notionBlockOwnText({ id: "x" })).toBe("");
    expect(notionBlockOwnText({ id: "x", type: "divider" })).toBe("");
  });

  test("notionBlockOwnText reads table_row cells, joined", () => {
    expect(
      notionBlockOwnText({
        id: "r1",
        type: "table_row",
        table_row: {
          cells: [[{ plain_text: "CDR" }], [{ plain_text: "change data record" }], []],
        },
      }),
    ).toBe("CDR | change data record");
  });

  test("notionBlockOwnText falls back to caption when there is no rich_text", () => {
    expect(
      notionBlockOwnText({
        id: "i1",
        type: "image",
        image: { caption: [{ plain_text: "the deploy topology" }] },
      }),
    ).toBe("the deploy topology");
  });

  test("notionBlockOwnText returns empty for a table_row with no cells array", () => {
    expect(notionBlockOwnText({ id: "r2", type: "table_row", table_row: {} })).toBe("");
  });

  test("collects top-level text and reports complete", async () => {
    globalThis.fetch = routedFetch({ p1: [para("b1", "one"), para("b2", "two")] });
    const r = await fetchNotionPageText(deps(), "p1");
    expect(r.text).toBe("one\ntwo");
    expect(r.outcome).toBe("complete");
  });

  test("follows a container into its children", async () => {
    globalThis.fetch = routedFetch({
      p1: [{ id: "c1", type: "column_list", has_children: true, column_list: {} }],
      c1: [para("b1", "inner")],
    });
    const r = await fetchNotionPageText(deps(), "p1");
    expect(r.text).toBe("inner");
    expect(r.outcome).toBe("complete");
  });

  test("a list item with children yields its own text AND its sub-bullets, in order", async () => {
    globalThis.fetch = routedFetch({
      p1: [bullet("b1", "parent", true)],
      b1: [bullet("b2", "child")],
    });
    const r = await fetchNotionPageText(deps(), "p1");
    expect(r.text).toBe("parent\nchild");
  });

  test("does not follow child_page or child_database", async () => {
    const seen: string[] = [];
    globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
      seen.push(urlFromFetchInput(input));
      const url = urlFromFetchInput(input);
      const results = url.includes("/p1/")
        ? [
            { id: "sub", type: "child_page", has_children: true, child_page: { title: "Sub" } },
            { id: "dbx", type: "child_database", has_children: true, child_database: {} },
          ]
        : [];
      return Promise.resolve(
        new Response(JSON.stringify({ results, has_more: false, next_cursor: null }), {
          status: 200,
        }),
      );
    }) as typeof fetch;
    const r = await fetchNotionPageText(deps(), "p1");
    expect(seen.length).toBe(1);
    expect(r.outcome).toBe("complete");
  });

  test("toggle -> list -> sub-list resolves fully at depth 3", async () => {
    globalThis.fetch = routedFetch({
      p1: [{ id: "t1", type: "toggle", has_children: true,
             toggle: { rich_text: [{ plain_text: "Decisions" }] } }],
      t1: [bullet("b1", "L1", true)],
      b1: [bullet("b2", "L2")],
    });
    const r = await fetchNotionPageText(deps(), "p1");
    expect(r.text).toBe("Decisions\nL1\nL2");
    expect(r.outcome).toBe("complete");
  });

  test("stops at depth 3 and reports capped", async () => {
    globalThis.fetch = routedFetch({
      p1: [bullet("b1", "L1", true)],
      b1: [bullet("b2", "L2", true)],
      b2: [bullet("b3", "L3", true)],
      b3: [bullet("b4", "L4")],
    });
    const r = await fetchNotionPageText(deps(), "p1");
    expect(r.text).toBe("L1\nL2\nL3");
    expect(r.outcome).toBe("capped");
  });

  test("a table's rows are collected", async () => {
    globalThis.fetch = routedFetch({
      p1: [{ id: "tb1", type: "table", has_children: true, table: { table_width: 2 } }],
      tb1: [
        { id: "r1", type: "table_row", has_children: false,
          table_row: { cells: [[{ plain_text: "CDR" }], [{ plain_text: "change data record" }]] } },
      ],
    });
    const r = await fetchNotionPageText(deps(), "p1");
    expect(r.text).toBe("CDR | change data record");
    expect(r.outcome).toBe("complete");
  });

  test("paginates block children via start_cursor", async () => {
    let call = 0;
    globalThis.fetch = (() => {
      call += 1;
      const first = call === 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [para(`b${String(call)}`, first ? "one" : "two")],
            has_more: first,
            next_cursor: first ? "CUR" : null,
          }),
          { status: 200 },
        ),
      );
    }) as typeof fetch;
    const r = await fetchNotionPageText(deps(), "p1");
    expect(r.text).toBe("one\ntwo");
    expect(call).toBe(2);
  });

  test("caps a single page at NOTION_BODY_REQUESTS_PER_PAGE_MAX requests", async () => {
    let call = 0;
    globalThis.fetch = (() => {
      call += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [para(`b${String(call)}`, "x")],
            has_more: true,
            next_cursor: "CUR",
          }),
          { status: 200 },
        ),
      );
    }) as typeof fetch;
    const r = await fetchNotionPageText(deps(), "p1");
    expect(call).toBe(NOTION_BODY_REQUESTS_PER_PAGE_MAX);
    expect(r.outcome).toBe("capped");
  });

  test("a 429 returns errored and zeroes the remaining budget", async () => {
    globalThis.fetch = routedFetch({}, 429);
    const d = deps(100);
    const r = await fetchNotionPageText(d, "p1");
    expect(r.outcome).toBe("errored");
    expect(d.budget.left).toBe(0);
  });

  test("a non-429 error returns errored and leaves the budget alone", async () => {
    globalThis.fetch = routedFetch({}, 500);
    const d = deps(100);
    const r = await fetchNotionPageText(d, "p1");
    expect(r.outcome).toBe("errored");
    expect(d.budget.left).toBe(99);
  });

  test("invalid JSON returns errored", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response("not json", { status: 200 }))) as typeof fetch;
    expect((await fetchNotionPageText(deps(), "p1")).outcome).toBe("errored");
  });

  test("a malformed results field returns errored", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ results: "nope" }), { status: 200 }))) as typeof fetch;
    expect((await fetchNotionPageText(deps(), "p1")).outcome).toBe("errored");
  });

  test("skips non-record and untyped entries", async () => {
    globalThis.fetch = routedFetch({ p1: ["junk", { id: "x" }, para("b1", "kept")] });
    expect((await fetchNotionPageText(deps(), "p1")).text).toBe("kept");
  });

  test("skips a has_children block with no id", async () => {
    globalThis.fetch = routedFetch({
      p1: [{ type: "toggle", has_children: true, toggle: { rich_text: [] } }],
    });
    expect((await fetchNotionPageText(deps(), "p1")).outcome).toBe("complete");
  });

  test("reports bytes transferred", async () => {
    globalThis.fetch = routedFetch({ p1: [para("b1", "one")] });
    expect((await fetchNotionPageText(deps(), "p1")).bytes).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/connectors/notion-page-body.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Create `packages/gateway/src/connectors/notion-page-body.ts`:

```ts
import type { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const NOTION_VERSION = "2022-06-28";
const BLOCKS_URL = "https://api.notion.com/v1/blocks";
const PAGE_SIZE = 100;

/** Max block-children requests one sync pass may spend on bodies, across all pages. */
export const NOTION_BODY_FETCH_BUDGET_PER_SYNC = 200;

/**
 * Max block-children requests a SINGLE page may spend. Necessary because
 * recursion follows any `has_children` block, so one list-heavy page could
 * otherwise cost dozens of requests and dominate a whole pass.
 */
export const NOTION_BODY_REQUESTS_PER_PAGE_MAX = 10;

/**
 * Depth 1 is the page's own children. 3 covers the ordinary Notion shapes —
 * `toggle` → list → sub-list, `table` → `table_row`, two levels of bullets.
 * This is a cycle guard (a `synced_block` reference can in principle loop),
 * NOT the cost bound; `NOTION_BODY_REQUESTS_PER_PAGE_MAX` is that.
 */
const MAX_DEPTH = 3;

/** Separate items in their own right — following them would double-index. */
const NOT_FOLLOWED_BLOCK_TYPES: ReadonlySet<string> = new Set(["child_page", "child_database"]);

/**
 * `capped` is PERMANENT — the page will hit the same cap on every future pass,
 * so it must never be re-fetched. `errored` is TRANSIENT and must be. The
 * global budget deliberately cannot produce either: it is checked before a page
 * starts, never during it, so every started page can afford to finish.
 */
export type NotionPageBodyOutcome = "complete" | "capped" | "errored";

export type NotionPageBodyResult = {
  text: string;
  outcome: NotionPageBodyOutcome;
  bytes: number;
};

export type NotionBlockFetchDeps = {
  accessToken: string;
  rateLimiter: ProviderRateLimiter;
  /** Mutated in place: the caller reads `left` to decide whether to start the next page. */
  budget: { left: number };
};

export function notionRichTextToPlain(richText: unknown): string {
  if (!Array.isArray(richText)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of richText) {
    const r = asRecord(item);
    if (r === undefined) {
      continue;
    }
    const t = stringField(r, "plain_text");
    if (t !== undefined && t !== "") {
      parts.push(t);
    }
  }
  return parts.join("");
}

/** A `table_row` has no `rich_text` — its text is a 2-D array of rich-text arrays. */
function notionTableRowText(payload: Record<string, unknown>): string {
  const cells = payload["cells"];
  if (!Array.isArray(cells)) {
    return "";
  }
  return cells
    .map((cell) => notionRichTextToPlain(cell))
    .filter((t) => t !== "")
    .join(" | ");
}

/**
 * A block's text lives under a key named after its own `type`, but the shape
 * under that key varies: most blocks use `rich_text`, a `table_row` uses
 * `cells`, and media blocks (`image`, `file`, `video`, `bookmark`) carry only a
 * `caption`. A `rich_text`-only reader returns nothing for a page built around
 * a table — a common way to write exactly the glossary content we want.
 */
export function notionBlockOwnText(block: Record<string, unknown>): string {
  const type = stringField(block, "type");
  if (type === undefined) {
    return "";
  }
  const payload = asRecord(block[type]);
  if (payload === undefined) {
    return "";
  }
  if (type === "table_row") {
    return notionTableRowText(payload);
  }
  const own = notionRichTextToPlain(payload["rich_text"]);
  return own === "" ? notionRichTextToPlain(payload["caption"]) : own;
}

type WalkState = { used: number; bytes: number; capped: boolean };

type ChildrenPage = { results: unknown[]; nextCursor: string | undefined };

async function fetchChildrenPage(
  deps: NotionBlockFetchDeps,
  blockId: string,
  startCursor: string | undefined,
  state: WalkState,
): Promise<ChildrenPage> {
  const qs = new URLSearchParams({ page_size: String(PAGE_SIZE) });
  if (startCursor !== undefined && startCursor !== "") {
    qs.set("start_cursor", startCursor);
  }
  const res = await fetch(`${BLOCKS_URL}/${encodeURIComponent(blockId)}/children?${qs.toString()}`, {
    headers: {
      Authorization: `Bearer ${deps.accessToken}`,
      "Notion-Version": NOTION_VERSION,
    },
  });
  const text = await res.text();
  state.bytes += text.length;
  if (res.status === 429) {
    deps.rateLimiter.penalise("notion", 60_000);
    // Back off for the whole pass rather than spending the rest of the budget
    // rediscovering the same limit page by page.
    deps.budget.left = 0;
    throw new Error("Notion blocks: rate limited");
  }
  if (!res.ok) {
    throw new Error(`Notion blocks HTTP ${String(res.status)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Notion blocks: invalid JSON");
  }
  const root = asRecord(parsed);
  const results = root?.["results"];
  if (!Array.isArray(results)) {
    throw new TypeError("Notion blocks: missing results");
  }
  const next = root === undefined ? undefined : stringField(root, "next_cursor");
  return {
    results,
    nextCursor: root?.["has_more"] === true && next !== undefined && next !== "" ? next : undefined,
  };
}

async function collectChildren(
  deps: NotionBlockFetchDeps,
  state: WalkState,
  blockId: string,
  depth: number,
  out: string[],
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    if (state.used >= NOTION_BODY_REQUESTS_PER_PAGE_MAX) {
      state.capped = true;
      return;
    }
    await deps.rateLimiter.acquire("notion");
    state.used += 1;
    deps.budget.left -= 1;
    const page = await fetchChildrenPage(deps, blockId, cursor, state);
    for (const raw of page.results) {
      const block = asRecord(raw);
      if (block === undefined) {
        continue;
      }
      const type = stringField(block, "type");
      if (type === undefined) {
        continue;
      }
      const own = notionBlockOwnText(block);
      if (own !== "") {
        out.push(own);
      }
      if (block["has_children"] !== true || NOT_FOLLOWED_BLOCK_TYPES.has(type)) {
        continue;
      }
      if (depth >= MAX_DEPTH) {
        state.capped = true;
        continue;
      }
      const childId = stringField(block, "id");
      if (childId === undefined || childId === "") {
        continue;
      }
      await collectChildren(deps, state, childId, depth + 1, out);
    }
    if (page.nextCursor === undefined) {
      return;
    }
    cursor = page.nextCursor;
  }
}

/**
 * Never throws. A failure returns whatever text was gathered with
 * `outcome: "errored"`, so the page still indexes with its title and URL —
 * exactly today's behaviour for that page, never worse.
 */
export async function fetchNotionPageText(
  deps: NotionBlockFetchDeps,
  pageId: string,
): Promise<NotionPageBodyResult> {
  const state: WalkState = { used: 0, bytes: 0, capped: false };
  const out: string[] = [];
  try {
    await collectChildren(deps, state, pageId, 1, out);
  } catch {
    return { text: out.join("\n"), outcome: "errored", bytes: state.bytes };
  }
  return {
    text: out.join("\n"),
    outcome: state.capped ? "capped" : "complete",
    bytes: state.bytes,
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/gateway/src/connectors/notion-page-body.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Check coverage on the new file**

Run: `bun test --coverage packages/gateway/src/connectors/notion-page-body.test.ts`
Expected: `notion-page-body.ts` at ≥80% line **and** branch. If a branch is short, the uncovered lines are named in the report — add the case rather than lowering the bar.

- [ ] **Step 6: Lint and typecheck**

Run: `bunx tsc --noEmit -p packages/gateway/tsconfig.json && bunx biome check --error-on-warnings packages/gateway/src/connectors`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/connectors/notion-page-body.ts packages/gateway/src/connectors/notion-page-body.test.ts
git commit -m "feat: bounded Notion block walk with permanent-vs-transient outcomes"
```

---

### Task 5: Wire the walk into `notion-sync.ts`

**Files:**
- Modify: `packages/gateway/src/connectors/notion-sync.ts:136-224` (the row/accumulator path), `:236-297` (the sync body)
- Modify: `packages/gateway/src/sync/rate-limiter.ts:103`
- Test: `packages/gateway/src/connectors/notion-sync.test.ts`

**Interfaces:**
- Consumes: `fetchNotionPageText`, `NOTION_BODY_FETCH_BUDGET_PER_SYNC`, `NOTION_BODY_REQUESTS_PER_PAGE_MAX`, `NotionBlockFetchDeps` (Task 4); `selectItemBodyFetchState` (Task 2); `itemPrimaryKey` from `../index/item-store.ts`.
- Produces: nothing consumed by later tasks.

**The three rules this task implements, in the order they must be checked per page:**
1. **Skip-if-fresh** — `bodyFetch` present and `modified_at` unchanged → no fetch, no upsert.
2. **Start-or-stop** — fewer than `NOTION_BODY_REQUESTS_PER_PAGE_MAX` budget left → stop the pass, leave the page untouched. This is what guarantees the budget can never truncate a page mid-walk.
3. **Pin-on-budget-stop** — a pass stopped by rule 2 returns the *original* watermark, so nothing older is skipped.

- [ ] **Step 1: Write the failing tests**

```ts
/** Serve one search page, then block children per parent id. */
function installSearchAndBlocks(
  pages: Record<string, unknown>[],
  blocks: Record<string, unknown[]>,
): { count: () => number } {
  let blockCalls = 0;
  globalThis.fetch = ((input: SyncTestFetchParams[0]) => {
    const url = urlFromFetchInput(input);
    if (url.includes("/v1/search")) {
      return Promise.resolve(
        new Response(JSON.stringify({ results: pages, has_more: false, next_cursor: null }), {
          status: 200,
        }),
      );
    }
    blockCalls += 1;
    const m = /\/v1\/blocks\/([^/?]+)\/children/.exec(url);
    const parent = decodeURIComponent(m?.[1] ?? "");
    return Promise.resolve(
      new Response(
        JSON.stringify({ results: blocks[parent] ?? [], has_more: false, next_cursor: null }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;
  return { count: () => blockCalls };
}

test("indexes a page body from its blocks", async () => {
  const db = createMemoryIndexDb();
  const vault = createStubVault({ "notion.oauth": makeOauthPayload() });
  installSearchAndBlocks(
    [makePage("pg-1")],
    { "pg-1": [{ id: "b1", type: "paragraph", has_children: false,
                 paragraph: { rich_text: [{ plain_text: "decided to ship" }] } }] },
  );
  await createNotionSyncable({ ensureNotionMcpRunning: async () => {} })
    .sync(syncTestContext(db, vault), null);
  const row = db
    .query<{ body: string; body_complete: number; meta: string }, []>(
      "SELECT body, body_complete, metadata AS meta FROM item WHERE service = 'notion'",
    )
    .get();
  expect(row?.body).toBe("decided to ship");
  expect(row?.body_complete).toBe(1);
  expect(JSON.parse(row?.meta ?? "{}").bodyFetch).toBe("complete");
  db.close();
});

test("skips a page whose bodyFetch is recorded and modified_at is unchanged", async () => {
  const db = createMemoryIndexDb();
  const vault = createStubVault({ "notion.oauth": makeOauthPayload() });
  const page = makePage("pg-1");
  const first = installSearchAndBlocks([page], { "pg-1": [] });
  const syncable = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
  await syncable.sync(syncTestContext(db, vault), null);
  expect(first.count()).toBe(1);
  // Second pass with the watermark cleared: same page, unchanged.
  const second = installSearchAndBlocks([page], { "pg-1": [] });
  await syncable.sync(syncTestContext(db, vault), null);
  expect(second.count()).toBe(0);
  db.close();
});

test("a capped page is skipped on the next pass — no perpetual re-fetch", async () => {
  const db = createMemoryIndexDb();
  const vault = createStubVault({ "notion.oauth": makeOauthPayload() });
  const page = makePage("pg-1");
  // Nesting one level past MAX_DEPTH (3) forces outcome "capped".
  const deep = {
    "pg-1": [{ id: "b1", type: "bulleted_list_item", has_children: true,
               bulleted_list_item: { rich_text: [{ plain_text: "L1" }] } }],
    b1: [{ id: "b2", type: "bulleted_list_item", has_children: true,
           bulleted_list_item: { rich_text: [{ plain_text: "L2" }] } }],
    b2: [{ id: "b3", type: "bulleted_list_item", has_children: true,
           bulleted_list_item: { rich_text: [{ plain_text: "L3" }] } }],
    b3: [{ id: "b4", type: "bulleted_list_item", has_children: false,
           bulleted_list_item: { rich_text: [{ plain_text: "L4" }] } }],
  };
  const syncable = createNotionSyncable({ ensureNotionMcpRunning: async () => {} });
  installSearchAndBlocks([page], deep);
  await syncable.sync(syncTestContext(db, vault), null);
  const row = db
    .query<{ body_complete: number; meta: string }, []>(
      "SELECT body_complete, metadata AS meta FROM item WHERE service = 'notion'",
    )
    .get();
  expect(row?.body_complete).toBe(0);
  expect(JSON.parse(row?.meta ?? "{}").bodyFetch).toBe("capped");
  const second = installSearchAndBlocks([page], deep);
  await syncable.sync(syncTestContext(db, vault), null);
  expect(second.count()).toBe(0); // the regression this whole design exists to prevent
  db.close();
});

// Fix round 1 correction: this test only runs one pass and asserts nothing
// about a retry actually happening. It does NOT — the watermark check runs
// (and folds this page's last_edited_time into maxEdited) *before* the fetch
// attempt, so a later pass's watermark normally already sits at or above
// this page. The missing `bodyFetch` key is real (it marks the page as
// retryable in principle), but the page is only re-examined when it is
// edited again in Notion or when `nimbus index rebody` clears the watermark.
// See notion-sync.ts for the full rationale.
test("an errored page indexes title-only with no bodyFetch key, and the sync still succeeds", async () => {
  const db = createMemoryIndexDb();
  const vault = createStubVault({ "notion.oauth": makeOauthPayload() });
  const page = makePage("pg-1");
  globalThis.fetch = ((input: SyncTestFetchParams[0]) => {
    const url = urlFromFetchInput(input);
    if (url.includes("/v1/search")) {
      return Promise.resolve(
        new Response(JSON.stringify({ results: [page], has_more: false, next_cursor: null }), {
          status: 200,
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 500 }));
  }) as typeof fetch;
  const r = await createNotionSyncable({ ensureNotionMcpRunning: async () => {} })
    .sync(syncTestContext(db, vault), null);
  expect(r.itemsUpserted).toBe(1);
  const row = db
    .query<{ title: string; meta: string; body_complete: number }, []>(
      "SELECT title, metadata AS meta, body_complete FROM item WHERE service = 'notion'",
    )
    .get();
  expect(row?.title).toBe("Hello"); // title-only: the title still indexed despite the body error
  expect(JSON.parse(row?.meta ?? "{}").bodyFetch).toBeUndefined();
  expect(row?.body_complete).toBe(0);
  db.close();
});

test("the watermark is pinned when the budget stops the pass", async () => {
  const db = createMemoryIndexDb();
  const vault = createStubVault({ "notion.oauth": makeOauthPayload() });
  // More pages than the budget can serve: BUDGET / PER_PAGE_MAX pages fit.
  const many = Array.from({ length: NOTION_BODY_FETCH_BUDGET_PER_SYNC + 5 }, (_, i) =>
    makePage(`pg-${String(i)}`),
  );
  installSearchAndBlocks(many, {});
  const r = await createNotionSyncable({ ensureNotionMcpRunning: async () => {} })
    .sync(syncTestContext(db, vault), null);
  expect(r.cursor).toBe(encodeWatermarkCursorV1("nimbus-ntn1:", { v: 1, watermark: null }));
  db.close();
});

test("the watermark advances when the budget does not stop the pass", async () => {
  const db = createMemoryIndexDb();
  const vault = createStubVault({ "notion.oauth": makeOauthPayload() });
  installSearchAndBlocks([makePage("pg-1")], { "pg-1": [] });
  const r = await createNotionSyncable({ ensureNotionMcpRunning: async () => {} })
    .sync(syncTestContext(db, vault), null);
  expect(r.cursor).toContain("2026-04-01T12:00:00.000Z");
  db.close();
});
```

`encodeWatermarkCursorV1` is imported from `./sync-watermark-cursor-v1.ts`; `NOTION_BODY_FETCH_BUDGET_PER_SYNC` from `./notion-page-body.ts`.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/connectors/notion-sync.test.ts`
Expected: FAIL — bodies are `""`, no block requests are made at all.

- [ ] **Step 3: Make the row consumer async and body-aware**

In `notion-sync.ts`, add imports:

```ts
import { itemPrimaryKey, selectItemBodyFetchState } from "../index/item-store.ts";
import {
  fetchNotionPageText,
  NOTION_BODY_FETCH_BUDGET_PER_SYNC,
  NOTION_BODY_REQUESTS_PER_PAGE_MAX,
  type NotionBlockFetchDeps,
} from "./notion-page-body.ts";
```

Extend the accumulator (`:136-140`):

```ts
type NotionRowProcessAcc = {
  maxEdited: string;
  upserted: number;
  shouldStop: boolean;
  /** The pass ran out of budget. Distinct from `shouldStop` (hit the watermark). */
  budgetStopped: boolean;
  bytes: number;
};
```

Replace `notionConsumeSearchResultRow` (`:170-211`) with an async version. Note the ordering: watermark check, then skip-if-fresh, then the budget gate, and only then a fetch.

```ts
async function notionConsumeSearchResultRow(
  ctx: SyncContext,
  deps: NotionBlockFetchDeps,
  item: unknown,
  opts: { watermarkMs: number; syncTime: number },
  acc: NotionRowProcessAcc,
): Promise<boolean> {
  const row = asRecord(item);
  if (row === undefined || stringField(row, "object") !== "page") {
    return false;
  }
  const id = stringField(row, "id");
  if (id === undefined || id === "") {
    return false;
  }
  const edited = stringField(row, "last_edited_time");
  if (notionWatermarkOrAdvanceMax(edited, opts, acc) === "stop") {
    return true;
  }
  const rawModified = edited !== undefined && edited !== "" ? isoMs(edited) : opts.syncTime;
  const modifiedAt = Number.isFinite(rawModified) ? rawModified : opts.syncTime;

  // 1. Nothing to gain: we already recorded a verdict for this exact revision.
  const prior = selectItemBodyFetchState(ctx.db, itemPrimaryKey(SERVICE_ID, id));
  if (prior !== null && prior.bodyFetch !== null && prior.modifiedAt === modifiedAt) {
    return false;
  }

  // 2. Never start a page we cannot afford to finish — this is what keeps the
  //    global budget from ever being a *cause* of truncation.
  if (deps.budget.left < NOTION_BODY_REQUESTS_PER_PAGE_MAX) {
    acc.budgetStopped = true;
    return true;
  }

  const fetched = await fetchNotionPageText(deps, id);
  acc.bytes += fetched.bytes;

  const title = extractTitleFromProperties(row["properties"]);
  const url = `https://www.notion.so/${id.replaceAll("-", "")}`;
  acc.upserted += 1;
  const metadata: Record<string, unknown> =
    fetched.outcome === "errored"
      ? { notionPageId: id }
      : { notionPageId: id, bodyFetch: fetched.outcome };
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "page",
    externalId: id,
    title: title.length > 512 ? title.slice(0, 512) : title,
    body: fetched.text,
    bodyTruncated: fetched.outcome !== "complete",
    url,
    canonicalUrl: url,
    modifiedAt,
    authorId: notionAuthorIdFromPageRow(ctx, row),
    metadata,
    pinned: false,
    syncedAt: opts.syncTime,
  });
  return false;
}
```

Make the accumulator loop await (`:213-224`):

```ts
async function notionAccumulateSearchResults(
  ctx: SyncContext,
  deps: NotionBlockFetchDeps,
  results: unknown[],
  opts: { watermarkMs: number; syncTime: number },
  acc: NotionRowProcessAcc,
): Promise<void> {
  for (const item of results) {
    if (await notionConsumeSearchResultRow(ctx, deps, item, opts, acc)) {
      break;
    }
  }
}
```

- [ ] **Step 4: Thread the budget and the pin through `sync()`**

In the `sync` body, replace the single pre-loop `await ctx.rateLimiter.acquire("notion")` (`:255`) — throttling is now per request, and the search call needs its own acquire inside the loop:

```ts
      const deps: NotionBlockFetchDeps = {
        accessToken,
        rateLimiter: ctx.rateLimiter,
        budget: { left: NOTION_BODY_FETCH_BUDGET_PER_SYNC },
      };
      let budgetStopped = false;
```

Inside the pagination loop, acquire before each search request and pass `deps`:

```ts
      for (;;) {
        const body = notionSearchRequestBody(nextCursor);
        await ctx.rateLimiter.acquire("notion");
        const batch = await notionFetchSearchBatch(ctx, accessToken, body);
        bytesTransferred += batch.bytesThisPage;
        const acc: NotionRowProcessAcc = {
          maxEdited, upserted: 0, shouldStop: false, budgetStopped: false, bytes: 0,
        };
        await notionAccumulateSearchResults(ctx, deps, batch.results, { watermarkMs, syncTime }, acc);
        upserted += acc.upserted;
        maxEdited = acc.maxEdited;
        shouldStop = acc.shouldStop;
        budgetStopped = acc.budgetStopped;
        bytesTransferred += acc.bytes;

        if (shouldStop || budgetStopped || !batch.hasMore) {
          break;
        }
        if (batch.nextCursor === undefined || batch.nextCursor === "") {
          break;
        }
        nextCursor = batch.nextCursor;
      }
```

And the watermark decision:

```ts
      // A pass stopped by the budget must NOT advance the watermark: pages
      // older than the stopping point are unprocessed, and advancing would
      // skip them forever.
      const nextW = budgetStopped ? watermark : maxEdited === "" ? watermark : maxEdited;

      // A multi-pass backfill is otherwise invisible: the sync reports success
      // with hasMore:false every time, so nothing distinguishes "converged"
      // from "still working through a 10,000-page workspace".
      if (budgetStopped) {
        ctx.logger.info(
          { service: SERVICE_ID, upserted },
          "notion sync budget exhausted; watermark pinned for backfill convergence",
        );
      }
```

- [ ] **Step 5: Raise the notion rate limit**

`packages/gateway/src/sync/rate-limiter.ts:103`. Notion's documented allowance is ~3 req/s ≈ 180/min; 30 was safe when a sync made ~10 requests but means a ~7-minute pass at a 200-request budget:

```ts
  notion: { requestsPerMinute: 120, burstSize: 5 },
```

- [ ] **Step 6: Run to verify they pass**

Run: `bun test packages/gateway/src/connectors/notion-sync.test.ts packages/gateway/src/sync/rate-limiter.test.ts`
Expected: PASS. If `rate-limiter.test.ts` asserts the old `30`, update that assertion — it is a fixture of the value, not a behaviour test.

- [ ] **Step 7: Lint and typecheck**

Run: `bunx tsc --noEmit -p packages/gateway/tsconfig.json && bunx biome check --error-on-warnings packages/gateway/src/connectors packages/gateway/src/sync`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/connectors/notion-sync.ts packages/gateway/src/connectors/notion-sync.test.ts packages/gateway/src/sync/rate-limiter.ts packages/gateway/src/sync/rate-limiter.test.ts
git commit -m "feat: index Notion page bodies with a budgeted resumable block walk"
```

---

### Task 6: `nimbus index rebody` — add both services, rewrite the stale comment

**Files:**
- Modify: `packages/gateway/src/ipc/index-rebody-rpc.ts:31-37` (the comment), `:167-177` (the set)
- Test: `packages/gateway/src/ipc/index-rebody-rpc.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

`REBODY_IMPROVABLE_SERVICES` is an **inclusion** list — absence means "cannot improve". Leaving it unedited would have `rebody` refuse to promise a fix it can now deliver.

- [ ] **Step 1: Write the failing test**

```ts
test("notion and confluence can now be improved by rebody", () => {
  expect(REBODY_IMPROVABLE_SERVICES.has("notion")).toBe(true);
  expect(REBODY_IMPROVABLE_SERVICES.has("confluence")).toBe(true);
  expect(cannotImproveAmong({ notion: 3, confluence: 2, zoom: 1 })).toEqual(["zoom"]);
});
```

Also update any existing test asserting the set's size — it goes from 9 to 11.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/ipc/index-rebody-rpc.test.ts`
Expected: FAIL — `false`, and `cannotImproveAmong` returns all three.

- [ ] **Step 3: Add both services**

`:167-177`, keeping the list sorted:

```ts
export const REBODY_IMPROVABLE_SERVICES: ReadonlySet<string> = new Set([
  "bitbucket",
  "confluence",
  "discord",
  "github",
  "jira",
  "linear",
  "notion",
  "obsidian",
  "slack",
  "snyk",
  "teams",
]);
```

- [ ] **Step 4: Rewrite the comment that this change makes false**

The block at `:31-37` currently claims *"Notion/Confluence are full-scan (expensive) AND cannot complete — the worst combination"*. Replace that sentence (keep the surrounding paragraphs about Gmail and about `--only-truncated`, which are still accurate):

```
 * completeness: Gmail is bounded-window (cheap) but its connector still never
 * declares a full `body:`, so re-syncing it costs little AND recovers
 * nothing. Notion and Confluence are both full-scan (expensive) but both now
 * complete: Confluence recovers a page's whole body in the search response it
 * already pays for, and Notion recovers bodies over successive budgeted
 * passes, converging once no pass is cut short. Both were the "expensive AND
 * cannot complete" worst case until 2026-08-03.
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun test packages/gateway/src/ipc/index-rebody-rpc.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/index-rebody-rpc.ts packages/gateway/src/ipc/index-rebody-rpc.test.ts
git commit -m "feat: notion and confluence are rebody-improvable"
```

---

### Task 7: Documentation — correct the accounting everywhere it is stated

**Files:**
- Modify: `docs/roadmap.md:912`, `docs/roadmap.md:1118`
- Modify: `docs/CHANGELOG.md:18`, `docs/CHANGELOG.md:47`, plus a new dated entry
- Modify: `docs/cli-reference.md:2125`
- Modify: `docs/superpowers/specs/2026-08-02-full-body-store-design.md` (append only)

**Interfaces:** none.

The accounting goes from **10 full / 1 partial / 2 inert** to **12 full / 1 partial / 2 inert**. The "twelve connectors" claim was wrong once before and had to be retracted, so each number is corrected exactly and nothing is left implying the old count.

- [ ] **Step 1: Find every surviving statement of the old numbers**

Run:

```bash
grep -rn "nine services\|(10)\|10 full\|Zoom transcripts" docs/*.md docs/superpowers/specs/*.md
```

Expected hits: `docs/CHANGELOG.md:18`, `docs/CHANGELOG.md:47`, `docs/cli-reference.md:2125`, `docs/roadmap.md:912`. Any additional hit must be fixed too — this grep is the authority, not this list.

- [ ] **Step 2: `docs/CHANGELOG.md:47` — the table row**

`| **Full body @ 16 KiB (10)** | Slack, Teams, Discord, Linear, Jira, ... |` becomes `(12)` with `Notion pages` and `Confluence pages` appended to the list.

- [ ] **Step 3: `docs/CHANGELOG.md:18` and `docs/cli-reference.md:2125` — the service count**

Both say the `REBODY_IMPROVABLE_SERVICES` list "is nine services" and enumerate them. Both become eleven, with `confluence` and `notion` inserted in the same sorted order used in the code.

- [ ] **Step 4: `docs/roadmap.md:912` — the full-body-store entry**

Update the parenthetical accounting from "**10 full body @ 16 KiB**" to 12, adding Notion and Confluence to the enumerated list, and note the follow-up PR delivered them.

- [ ] **Step 5: `docs/roadmap.md:1118` — the Wave 5 glossary claim**

This line has always claimed `nimbus glossary` mines "Slack threads + **Confluence/Notion pages** + …". It was false until now. Do not silently leave it: annotate that the Confluence/Notion half became true on 2026-08-03, so the record shows when the claim started holding.

- [ ] **Step 6: Append to the prior design spec**

Add to `docs/superpowers/specs/2026-08-02-full-body-store-design.md` § Post-implementation correction — **append a dated follow-up note, do not rewrite the section.** It is a historical record of a correction; editing it in place would erase the very thing it documents.

```markdown
### Follow-up 2026-08-03 — Notion + Confluence

The 10/1/2 accounting above was accurate when written. `notion:page` and
`confluence:page` were migrated from `bodyPreview: ""` to a declared-full
`body:` on 2026-08-03, making the count **12 full / 1 partial / 2 inert**.
Design: `2026-08-03-notion-confluence-full-body-design.md`.
```

- [ ] **Step 7: Add the dated CHANGELOG delivery entry**

Per the connector-docs convention, deliveries are logged in `docs/CHANGELOG.md`, not in `CLAUDE.md`'s status line. Add an entry dated 2026-08-03 covering: Notion and Confluence full bodies, the Teams `body_complete` fix, the `bodyTruncated` store flag, the notion rate-limit raise, and the two new `REBODY_IMPROVABLE_SERVICES` entries.

- [ ] **Step 8: Re-run the grep to confirm nothing stale survives**

Run: `grep -rn "nine services\|10 full" docs/`
Expected: no hits.

- [ ] **Step 9: Commit**

```bash
git add docs/
git commit -m "docs: correct the full-body connector accounting to 12 full"
```

---

### Task 8: Full verification before the PR

**Files:** none modified unless a gate fails.

- [ ] **Step 1: Whole-suite run for the touched packages**

Run: `bun test packages/gateway/src/connectors packages/gateway/src/index packages/gateway/src/ipc packages/gateway/src/string packages/gateway/src/sync`
Expected: PASS. Anything red here is yours — this is not a "not my diff" situation, the whole set is in scope.

- [ ] **Step 2: Static invariant audit**

Run: `bun run audit:invariants`
Expected: PASS. This slice adds no invariant, but D22 confines `connectors.dispatch` call sites and the audit runs before the suite in CI.

- [ ] **Step 3: `audit:any` — with `--check`**

Run: `bun run audit:any --check`
Expected: PASS. Without `--check` this command always exits 0 and reports a false pass.

- [ ] **Step 4: Coverage floor, Docker-Linux-authoritative**

Run: `bash scripts/coverage-floor/reseed-docker.sh`

Then **inspect the baseline diff — this script prints `ok` while ratcheting failures in as permanent exceptions**:

```bash
git diff docs/structure-audit/coverage-baseline.json
```

Expected: **no change**, and `"files"` still `{}`. If `notion-page-body.ts` appears there, it failed the floor and was silently excused — go back and write the missing tests instead.

- [ ] **Step 5: Documentation gates**

Task 7 edits four docs, and three separate gates read them:

```bash
bun run audit:links        # lychee — NOT "lint:links", that script does not exist
bun run audit:doc-refs
bun run audit:status-drift
bunx markdownlint-cli2 "docs/superpowers/**/*.md"
```

Expected: all PASS. Three cautions:

- `audit:links` scopes to `docs/**/*.md` and `*.md` — the **whole branch**, not your diff. A pre-existing broken link elsewhere still fails your PR, so fix whatever it reports regardless of authorship. Never leave a `file:///C:/...` path in a doc.
- `audit:doc-refs` only scans a fixed doc set, so a green result does not prove every link in `roadmap.md` resolves.
- Invoke markdownlint as `bunx markdownlint-cli2 <glob>`, not `bun run lint:markdown` — inside `.claude/worktrees/` the latter matches no files and **exits 0 silently**, which reads as a pass.

- [ ] **Step 6: Push and open the PR**

The PR title and body **become** the squash commit — local commit messages are discarded on merge, and release-please parses the title for the version bump.

Title: `feat(connectors): index real Notion and Confluence page bodies`

Body must cover: the two connectors, the cost asymmetry, the Teams `body_complete` fix (call it out — it is a live bug fix riding along), the `bodyTruncated` store flag, the notion rate-limit change, and the two deferred review items with their triggers.

```bash
git push -u origin dev/asaf/notion-confluence-full-body
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: Confluence expand → 3; Notion walk, depth, budget, per-page cap → 4; skip-if-fresh, convergence, watermark pin, rate limit → 5; error handling / outcome split → 4 (module) + 5 (metadata); honesty flag → 2; the pre-truncation fix → 1; rebody → 6; accounting → 7. The two deferred items (search amplification, Confluence batch fallback) are documentation-only in the spec and correctly have no task; they surface in the PR body at Task 8 Step 6.

**Type consistency.** `NotionPageBodyResult` carries `bytes` in Tasks 4 and 5 — this is an addition beyond the spec's declared `{ text, outcome }`, made so `SyncResult.bytesTransferred` can account for block traffic, and it is used consistently in both. `selectItemBodyFetchState` returns `{ modifiedAt, bodyFetch }` in Task 2 and is destructured as `prior.bodyFetch` / `prior.modifiedAt` in Task 5. `confluenceBodyText` returns `string | null` in Task 3 and is branched on `text === null` at its only call site.

**Known ordering hazard.** Task 5's skip-if-fresh compares `prior.modifiedAt` against the `modifiedAt` the connector is *about to write*, not the raw `last_edited_time`. Both are computed from the same `Number.isFinite(rawModified) ? rawModified : opts.syncTime` expression for exactly this reason — comparing against a differently-derived value would make the skip never fire.
