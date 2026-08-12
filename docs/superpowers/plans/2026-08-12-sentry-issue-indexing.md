# Sentry Issue Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Index Sentry issues as `sentry:error_issue` items and graph entities, so a later spec can attribute them to people.

**Architecture:** `sentry-sync.ts` becomes a two-pass syncable — pass 1 lists projects (unchanged), pass 2 walks the org-wide issues endpoint. The issue pass lives in its own module, its row mapping is a pure function in a third, and Link-header pagination moves to one correct shared parser that Mendeley is migrated onto. No migration, no new table, no attribution.

**Tech Stack:** Bun 1.2+, TypeScript strict, `bun:sqlite`, Biome, `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-12-sentry-issue-indexing-design.md`
**Review response:** `docs/superpowers/specs/2026-08-12-sentry-issue-indexing-review-response.md`

## Global Constraints

- **No `any`.** `unknown` for external data; every API field is external data.
- **Bound-param SQL only** (I9); production writes through `dbRun`/`dbExec` (I14). This work performs **no direct SQL** — items go through `upsertIndexedItemForSync`, graph rows through `upsertGraphEntity` / `upsertGraphRelation`.
- **No migration, no DDL.** If you find yourself writing `CREATE TABLE`, stop.
- **No attribution.** No `authorId` other than `null`, no `person` lookup, no `resolvePersonForSync` import. That is Spec B.
- **Never commit on `main`.** Work lands on `dev/asafgolombek/incident-attribution`, already checked out at `C:/gitrep/Nimbus/.claude/worktrees/incident-attribution`.
- **Run `bun run preflight:fast` before every commit.** Chain with `&&`, never `;` — a `;` lets a failing gate through to the commit.
- **Coverage floor is 85% line / 80% branch, per file, and NOTHING is exempt.** The baseline `files` map has **0 entries**, and `scripts/coverage-floor/check.ts:55` iterates every source file. Measure with a **full-suite** lcov (`bash scripts/coverage-floor/build-lcov.sh` then `bun run audit:coverage-floor`) — a scoped per-directory run under-reports badly and must not be used to answer a floor question.
- **Gateway unit tests live in `packages/gateway/test/unit/…`, not beside the source.** `packages/gateway/src/**/*.test.ts` also exists for some modules; follow the neighbouring convention named per task.
- **`bun run typecheck:tests` before pushing** — advisory on Windows, gating on CI-Linux; read the "N new" line.

---

## File Structure

| File | Responsibility | Action |
| --- | --- | --- |
| `packages/gateway/src/connectors/link-header.ts` | Order-independent RFC-8288 Link parser; `results`-aware next-page selection | Create |
| `packages/gateway/src/connectors/link-header.test.ts` | Parser unit tests | Create |
| `packages/gateway/src/connectors/mendeley-link-header.ts` | Superseded by `link-header.ts` | **Delete** |
| `packages/gateway/src/connectors/mendeley-sync.ts` | Import swap only | Modify |
| `packages/gateway/src/connectors/sentry-issue-mapping.ts` | Pure Sentry issue row → item row | Create |
| `packages/gateway/src/connectors/sentry-issue-mapping.test.ts` | Mapper unit tests | Create |
| `packages/gateway/src/connectors/sentry-issue-sync.ts` | Pass 2: request shape, pagination loop, early stop, 403 | Create |
| `packages/gateway/src/connectors/sentry-sync.ts` | Two-pass composition, cursor v2, `historyFloorMs` | Modify |
| `packages/gateway/test/unit/connectors/sentry-sync.test.ts` | Existing suite; extend for pass 2 | Modify |
| `packages/gateway/src/graph/graph-populator.ts` | `error_issue` branch | Modify |
| `packages/gateway/src/graph/graph-populator-error-issue.test.ts` | Graph branch tests | Create |
| `docs/CHANGELOG.md`, `docs/connectors/…` | Documentation | Modify |

## Facts resolved at plan time

Verified against the tree at `origin/main` @ `3689401c`. **Do not re-derive these.**

1. **`_lib/pagination.ts` has zero production users.** Nothing in `packages/` imports it; only `_lib/pagination.test.ts` references `LinkHeaderPagination`. Leave the module alone — it is pre-existing dead code and deleting it is a separate cleanup with its own coverage consequences.
2. **Mendeley uses its own parser**, `connectors/mendeley-link-header.ts` `parseNextLink`, called at `mendeley-sync.ts:90`. That is the one being replaced.
3. **`MockFetch` stubs are first-match-wins and are never consumed** (`test/helpers/mock-fetch.ts:110-131`). A pagination test whose page-1 stub URL pattern also matches page 2 will replay page 1 forever. Anchor each page's pattern on its `cursor=` parameter.
4. **`MockFetch.respond`'s `headers` option REPLACES the default `content-type`** (`mock-fetch.ts:31`). Any stub that sets a `Link` header must also set `"content-type": "application/json"`, or the body will not be treated as JSON.
5. **`createConnectorSyncFixture().createSyncContext()` returns only `{vault, db, logger, rateLimiter}`** (`test/helpers/connector-sync-harness.ts:46-51`) — it omits `depth`, `sandboxCwd`, `credentialFor` and `runTeamList`, which `SyncContext` declares as required. This is pre-existing and is why `typecheck:tests` carries a baseline. Do not "fix" the harness as part of this work; if a test needs a depth, spread it: `{...fixture.createSyncContext(), depth: "full"}`.
6. **`item.body` vs `bodyPreview` is a two-arm union.** `IndexedItemBodyInput` (`index/item-store.ts:61-63`) permits `{bodyPreview}` **or** `{body, bodyTruncated?}`, never both. `MappedRow` (`connectors/mapped-row.ts`) declares `bodyPreview` as required, so it is the **wrong** base type for a mapper that supplies `body`. Declare the row type explicitly.
7. **`clearRelationsTouchingEntity` (`graph-populator.ts:96`) deletes every edge touching the entity except the four `CROSS_ITEM_RELATION_TYPES`** (`resolves`, `mentions`, `correlates_with`, `reviewed`). Whatever a populator branch clears, it must re-emit in the same pass.
8. **`error_issue` is already in `ITEM_LINKED_ENTITY_TYPES`** (`graph/relationship-graph.ts:12`). No change needed there.
9. **`sentry:error_issue` must NOT be added to `PROSE_HEAVY_TYPES`.** See the spec's "Embedding routing" section.
10. **The cursor prefix change is the legacy-cursor fix.** `decodeNimbusJsonCursorPayload(raw, prefix)` returns `undefined` when `raw` does not start with `prefix` (`nimbus-json-cursor.ts:6-8`). Moving from `nimbus-sentry1:` to `nimbus-sentry2:` therefore makes every persisted `{pass:1}` cursor decode to "unrecognised" → cold start, with no explicit legacy branch. Prove it with a test; do not add a branch.

## Reference signatures

Copied from the tree. Use exactly.

```ts
// connectors/unknown-record.ts
asRecord(v: unknown): Record<string, unknown> | undefined
stringField(r: Record<string, unknown>, key: string): string | undefined
numberField(r: Record<string, unknown>, key: string): number | undefined

// connectors/nimbus-json-cursor.ts
encodeNimbusJsonCursor(prefix: string, payload: unknown): string
decodeNimbusJsonCursorPayload(raw: string, prefix: string): unknown   // undefined on prefix miss / bad base64 / bad JSON

// index/item-store.ts
type IndexedItemBodyInput =
  | { bodyPreview?: string; body?: undefined; bodyTruncated?: undefined }
  | { body: string; bodyPreview?: undefined; bodyTruncated?: boolean };
upsertIndexedItemForSync(ctx: SyncContext, row: {
  service: string; type: string; externalId: string; title: string;
  url?: string | null; canonicalUrl?: string | null; modifiedAt: number;
  authorId?: string | null; metadata?: Record<string, unknown>;
  pinned?: boolean; syncedAt: number;
} & IndexedItemBodyInput): void

// graph/relationship-graph.ts
upsertGraphEntity(db, { type: string; externalId: string; label: string;
                        service?: string | null; metadata?: Record<string, unknown> | null }): string
upsertGraphRelation(db, fromId: string, toId: string, type: string, now: number, weight?: number): void

// graph/graph-populator.ts
type IndexedItemGraphInput = {
  id: string; service: string; type: string; title: string;
  bodyPreview: string | null; authorId: string | null; metadata: Record<string, unknown>;
}

// sync/pass-cursor-sync-result.ts
clampSyncTitle(title: string, maxLen = 512): string

// sync/types.ts
SyncContext.depth: "metadata_only" | "summary" | "full"
SyncContext.historyFloorMs?: number
SyncContext.rateLimiter.acquire(service: string): Promise<void>
```

---

## Task 1: The Link-header parser

**Files:**

- Create: `packages/gateway/src/connectors/link-header.ts`
- Create: `packages/gateway/src/connectors/link-header.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `parseLinkHeader(header: string | null): LinkValue[]` and `nextPageUrl(header: string | null): string | null`, where `LinkValue = { readonly url: string; readonly params: Readonly<Record<string, string>> }`. Task 2 and Task 4 both import `nextPageUrl`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/connectors/link-header.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

import { nextPageUrl, parseLinkHeader } from "./link-header.ts";

describe("parseLinkHeader", () => {
  test("returns [] for null, empty and whitespace headers", () => {
    expect(parseLinkHeader(null)).toEqual([]);
    expect(parseLinkHeader("")).toEqual([]);
    expect(parseLinkHeader("   ")).toEqual([]);
  });

  test("parses url and params of a single link-value", () => {
    const [link] = parseLinkHeader('<https://api/x?cursor=0:100:0>; rel="next"; results="true"');
    expect(link?.url).toBe("https://api/x?cursor=0:100:0");
    expect(link?.params["rel"]).toBe("next");
    expect(link?.params["results"]).toBe("true");
  });

  test("splits multiple link-values", () => {
    const links = parseLinkHeader('<https://api/p>; rel="previous", <https://api/n>; rel="next"');
    expect(links.map((l) => l.url)).toEqual(["https://api/p", "https://api/n"]);
  });

  test("does not split on a comma inside the URL", () => {
    const links = parseLinkHeader('<https://api/x?ids=1,2,3>; rel="next"');
    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe("https://api/x?ids=1,2,3");
  });

  test("accepts unquoted param values and mixed case keys", () => {
    const [link] = parseLinkHeader("<https://api/n>; REL=next; Results=False");
    expect(link?.params["rel"]).toBe("next");
    expect(link?.params["results"]).toBe("False");
  });

  test("skips malformed link-values instead of throwing", () => {
    expect(parseLinkHeader("not-a-link")).toEqual([]);
    expect(parseLinkHeader('garbage, <https://api/n>; rel="next"')).toHaveLength(1);
  });

  test("a link-value with no params yields an empty param map", () => {
    const [link] = parseLinkHeader("<https://api/n>");
    expect(link?.url).toBe("https://api/n");
    expect(link?.params).toEqual({});
  });
});

describe("nextPageUrl", () => {
  test("returns the next URL when results is true", () => {
    expect(nextPageUrl('<https://api/n>; rel="next"; results="true"')).toBe("https://api/n");
  });

  // THE SENTRY TERMINATION GUARD. Sentry always emits rel="next".
  test("returns null when the next link declares results=false", () => {
    expect(nextPageUrl('<https://api/n>; rel="next"; results="false"')).toBeNull();
  });

  // THE ORDER-INDEPENDENCE GUARD. The regex this module replaces required rel to come first.
  test("finds rel=next regardless of parameter order", () => {
    expect(nextPageUrl('<https://api/n>; results="true"; cursor="0:100:0"; rel="next"')).toBe(
      "https://api/n",
    );
    expect(nextPageUrl('<https://api/n>; results="false"; rel="next"')).toBeNull();
  });

  test("treats an absent results attribute as true (RFC-5988 compatibility)", () => {
    expect(nextPageUrl('<https://api/n>; rel="next"')).toBe("https://api/n");
  });

  test("ignores non-next relations", () => {
    expect(nextPageUrl('<https://api/p>; rel="previous"; results="true"')).toBeNull();
  });

  test("picks next out of a multi-link header", () => {
    const header =
      '<https://api/p>; rel="previous"; results="false", <https://api/n>; rel="next"; results="true"';
    expect(nextPageUrl(header)).toBe("https://api/n");
  });

  test("returns null for null, empty, and an empty URL", () => {
    expect(nextPageUrl(null)).toBeNull();
    expect(nextPageUrl("")).toBeNull();
    expect(nextPageUrl('<>; rel="next"')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/connectors/link-header.test.ts`
Expected: FAIL — module `./link-header.ts` does not exist.

- [ ] **Step 3: Write the parser**

Create `packages/gateway/src/connectors/link-header.ts`:

```typescript
/**
 * One RFC 8288 link-value: the URL inside angle brackets plus its parameters,
 * keyed lower-case.
 */
export type LinkValue = {
  readonly url: string;
  readonly params: Readonly<Record<string, string>>;
};

/** `<uri>` followed by the remaining parameter text. `s` so a folded header still matches. */
const LINK_VALUE_RE = /^<([^<>]*)>\s*(.*)$/s;

/**
 * Split on the commas that separate link-values, NOT on commas inside a URL.
 * A separating comma is always followed by the next value's `<`.
 */
const LINK_SEPARATOR_RE = /,\s*(?=<)/;

function parseParams(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const segment = part.trim();
    if (segment === "") continue;
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    if (key === "") continue;
    let value = segment.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Parse an RFC 8288 `Link` header into its link-values.
 *
 * Parameter ORDER is not significant — which is the whole point of this module.
 * The regex it replaces (`connectors/mendeley-link-header.ts`, and the unused
 * `_lib/pagination.ts` `LinkHeaderPagination`) required `rel` to be the first
 * parameter, so a server emitting `results="false"; rel="next"` looked like a
 * header with no next link at all.
 */
export function parseLinkHeader(header: string | null): LinkValue[] {
  if (header === null || header.trim() === "") return [];
  const out: LinkValue[] = [];
  for (const raw of header.split(LINK_SEPARATOR_RE)) {
    const match = LINK_VALUE_RE.exec(raw.trim());
    if (match === null) continue;
    const url = (match[1] ?? "").trim();
    const rest = match[2] ?? "";
    out.push({
      url,
      params: Object.freeze(parseParams(rest.startsWith(";") ? rest.slice(1) : rest)),
    });
  }
  return out;
}

/**
 * The URL of the `rel="next"` link, or null when there is no further page.
 *
 * `results="false"` means "a next cursor exists but has nothing behind it" —
 * Sentry emits a next link on EVERY response, including the last, so this
 * attribute is the only termination signal. An ABSENT `results` is treated as
 * `true`, which is what keeps plain RFC-5988 servers (Mendeley) working.
 */
export function nextPageUrl(header: string | null): string | null {
  for (const link of parseLinkHeader(header)) {
    if ((link.params["rel"] ?? "").toLowerCase() !== "next") continue;
    if ((link.params["results"] ?? "true").toLowerCase() === "false") return null;
    return link.url === "" ? null : link.url;
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/connectors/link-header.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Red-prove the two guards**

Both guards must be shown to fail without their implementation, or they are decoration.

1. Change `(link.params["results"] ?? "true")` to the literal `"true"`. Run the suite.
   Expected: **"returns null when the next link declares results=false"** and the
   `results="false"; rel="next"` half of the order-independence test both FAIL. Restore.
2. Replace the body of `parseLinkHeader` with the old shape — match
   `/<([^<>]+)>;\s*rel="next"/` per comma-split part. Run the suite.
   Expected: **"finds rel=next regardless of parameter order"** FAILS. Restore.

- [ ] **Step 6: Commit**

```bash
bun run typecheck && bun run preflight:fast && \
git add packages/gateway/src/connectors/link-header.ts packages/gateway/src/connectors/link-header.test.ts && \
git commit -m "feat(connectors): order-independent Link header parser with results support"
```

---

## Task 2: Migrate Mendeley onto the shared parser

Its own task because a reviewer could reasonably accept Task 1 and reject this one. If rejected, Sentry still works and the repo keeps two parsers.

**Files:**

- Modify: `packages/gateway/src/connectors/mendeley-sync.ts` (import at `:10`, call at `:90`)
- Modify: `packages/gateway/src/connectors/mendeley-sync.test.ts` (add one test)
- Delete: `packages/gateway/src/connectors/mendeley-link-header.ts`
- Delete: `packages/gateway/src/connectors/mendeley-link-header.test.ts`

**Interfaces:**

- Consumes: `nextPageUrl` from Task 1.
- Produces: nothing new.

**Context:** the regression suite for this swap **already exists**.
`mendeley-sync.test.ts` contains `"follows Link rel=next across pages and counts upserts"` (`:76`)
and `"resolves a relative rel=next href against the current page URL"` (`:99`). The second is the
one that matters most: Mendeley may send a **relative** href (`</documents?marker=REL2>; rel="next"`),
which `mendeley-sync.ts`'s own `resolveNextUrl()` (`:94`) turns absolute. `nextPageUrl` returns the
raw href exactly as `parseNextLink` did, so that resolution is untouched — but it is the assertion
that proves it.

Note this file uses a **different harness** from the Sentry suite: a hand-rolled context, an
injected `fetchFn` second argument to `createMendeleySyncable(options, fetchFn)`, and a local
`jsonResponse(body, link?)` helper (`:55`). Follow that, not `MockFetch`.

- [ ] **Step 1: Run the existing suite to capture the pre-swap baseline**

Run: `bun test packages/gateway/src/connectors/mendeley-sync.test.ts`
Expected: PASS. Record the test count — it must not drop after the swap.

- [ ] **Step 2: Add the test the swap actually buys**

The existing tests would pass with either parser, so they prove no regression but not the
improvement. Add this beside them:

```typescript
test("follows rel=next even when it is not the first link parameter", async () => {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("marker=ORD2")) {
      return jsonResponse([{ id: "d2", title: "Second" }]);
    }
    // `rel` LAST, not first — the old regex required it first and would have
    // treated this as "no next page", silently truncating the sync.
    return jsonResponse(
      [{ id: "d1", title: "First" }],
      '<https://api.mendeley.com/documents?marker=ORD2>; type="application/json"; rel="next"',
    );
  }) as unknown as typeof globalThis.fetch;

  const ctx = makeCtxWithSecret(
    JSON.stringify({
      accessToken: "tok-abc",
      refreshToken: "ref",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["all"],
    }),
  );
  const syncable = createMendeleySyncable({ ensureMendeleyMcpRunning: async () => {} }, fetchFn);
  // biome-ignore lint/suspicious/noExplicitAny: minimal fake context
  const r = await syncable.sync(ctx as any, null);

  expect(calls).toHaveLength(2);
  expect(calls[1]).toBe("https://api.mendeley.com/documents?marker=ORD2");
  expect(r.itemsUpserted).toBe(2);
});
```

Mirror the exact `fetchFn` cast and `biome-ignore` comment style used by the neighbouring tests —
read `:76-120` first.

- [ ] **Step 3: Run it and watch it FAIL on the current parser**

Run: `bun test packages/gateway/src/connectors/mendeley-sync.test.ts -t "not the first link parameter"`
Expected: **FAIL** — one call recorded, one item upserted. This is the red-prove for the whole
task: it demonstrates the bug being fixed before the fix lands. If it passes, stop — the
premise is wrong and the migration has no justification.

- [ ] **Step 4: Swap the import**

In `mendeley-sync.ts`, replace the `:10` import

```typescript
import { parseNextLink } from "./mendeley-link-header.ts";
```

with

```typescript
import { nextPageUrl } from "./link-header.ts";
```

and at `:90` replace `parseNextLink(res.headers.get("link"))` with
`nextPageUrl(res.headers.get("link"))`.

`resolveNextUrl()` at `:94` is unchanged — both functions return `string | null` and both return
the href verbatim, so relative-href resolution still happens exactly where it did.

- [ ] **Step 5: Delete the superseded module and its test**

```bash
git rm packages/gateway/src/connectors/mendeley-link-header.ts \
       packages/gateway/src/connectors/mendeley-link-header.test.ts
grep -rn "mendeley-link-header" packages/ || echo "no references remain"
```

Expected: `no references remain`.

- [ ] **Step 6: Run the Mendeley suite**

Run: `bun test packages/gateway/src/connectors/mendeley-sync.test.ts`
Expected: PASS — the Step 1 baseline count **plus one**, with the Step 2 test now green.

- [ ] **Step 7: Commit**

```bash
bun run typecheck && bun run preflight:fast && \
git add -u packages/gateway/src/connectors && \
git commit -m "refactor(connectors): migrate Mendeley onto the shared Link header parser"
```

---

## Task 3: The Sentry issue mapper

**Files:**

- Create: `packages/gateway/src/connectors/sentry-issue-mapping.ts`
- Create: `packages/gateway/src/connectors/sentry-issue-mapping.test.ts`

**Interfaces:**

- Consumes: `asRecord`, `numberField`, `stringField`, `clampSyncTitle`.
- Produces: `mapSentryIssueToItem(raw: unknown, ctx: SentryIssueMappingContext): SentryIssueMappedRow | null` and the exported types `SentryIssueMappingContext = { readonly org: string; readonly syncedAt: number }` and `SentryIssueMappedRow`. Task 4 imports both the function and `SentryIssueMappedRow`.

**Context:** the row shape is external data — treat every field as possibly absent or the wrong
type. A row without an `id`, or without a parseable `lastSeen`, is **skipped** (return `null`),
never defaulted: a defaulted timestamp corrupts the cursor and silently truncates the next run's
window.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/connectors/sentry-issue-mapping.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

import { mapSentryIssueToItem } from "./sentry-issue-mapping.ts";

const CTX = { org: "acme", syncedAt: 1_700_000_000_000 };

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "4711",
    title: "TypeError: undefined is not a function",
    culprit: "app/utils/parse.tsx in handleSubmit",
    permalink: "https://acme.sentry.io/issues/4711/",
    status: "resolved",
    level: "error",
    count: "42",
    userCount: 7,
    shortId: "ACME-3B",
    firstSeen: "2026-07-01T00:00:00.000Z",
    lastSeen: "2026-08-01T12:00:00.000Z",
    project: { slug: "web", name: "Web" },
    metadata: { value: "undefined is not a function", type: "TypeError" },
    assignedTo: { id: "u1", name: "Dana", type: "user", email: "dana@acme.example" },
    ...overrides,
  };
}

describe("mapSentryIssueToItem", () => {
  test("maps the core item fields", () => {
    const row = mapSentryIssueToItem(issue(), CTX);
    expect(row?.service).toBe("sentry");
    expect(row?.type).toBe("error_issue");
    expect(row?.externalId).toBe("4711");
    expect(row?.title).toBe("TypeError: undefined is not a function");
    expect(row?.url).toBe("https://acme.sentry.io/issues/4711/");
    expect(row?.canonicalUrl).toBe("https://acme.sentry.io/issues/4711/");
    expect(row?.modifiedAt).toBe(Date.parse("2026-08-01T12:00:00.000Z"));
    expect(row?.syncedAt).toBe(CTX.syncedAt);
  });

  // SPEC A ATTRIBUTES NOTHING.
  test("authorId is always null even when the issue is assigned", () => {
    expect(mapSentryIssueToItem(issue(), CTX)?.authorId).toBeNull();
  });

  // THE SPEC B HINGE: assignedTo is stored RAW so Spec B needs no re-sync.
  test("assignedTo is carried into metadata unresolved", () => {
    const meta = mapSentryIssueToItem(issue(), CTX)?.metadata ?? {};
    expect(meta["assignedTo"]).toEqual({
      id: "u1",
      name: "Dana",
      type: "user",
      email: "dana@acme.example",
    });
  });

  test("assignedTo null is preserved as null, not dropped", () => {
    const meta = mapSentryIssueToItem(issue({ assignedTo: null }), CTX)?.metadata ?? {};
    expect(meta).toHaveProperty("assignedTo");
    expect(meta["assignedTo"]).toBeNull();
  });

  test("captures status, level, counts, shortId, project and org", () => {
    const meta = mapSentryIssueToItem(issue(), CTX)?.metadata ?? {};
    expect(meta["status"]).toBe("resolved");
    expect(meta["level"]).toBe("error");
    expect(meta["userCount"]).toBe(7);
    expect(meta["shortId"]).toBe("ACME-3B");
    expect(meta["project"]).toBe("web");
    expect(meta["org"]).toBe("acme");
    expect(meta["firstSeen"]).toBe(Date.parse("2026-07-01T00:00:00.000Z"));
    expect(meta["lastSeen"]).toBe(Date.parse("2026-08-01T12:00:00.000Z"));
  });

  test("body joins metadata.value and culprit", () => {
    expect(mapSentryIssueToItem(issue(), CTX)?.body).toBe(
      "undefined is not a function\n\napp/utils/parse.tsx in handleSubmit",
    );
  });

  test("body omits an absent side without leaving blank lines", () => {
    expect(mapSentryIssueToItem(issue({ culprit: undefined }), CTX)?.body).toBe(
      "undefined is not a function",
    );
    expect(mapSentryIssueToItem(issue({ metadata: {} }), CTX)?.body).toBe(
      "app/utils/parse.tsx in handleSubmit",
    );
    expect(mapSentryIssueToItem(issue({ culprit: undefined, metadata: {} }), CTX)?.body).toBe("");
  });

  test("falls back to the short id then the raw id when title is absent", () => {
    expect(mapSentryIssueToItem(issue({ title: undefined }), CTX)?.title).toBe("ACME-3B");
    expect(mapSentryIssueToItem(issue({ title: undefined, shortId: undefined }), CTX)?.title).toBe(
      "4711",
    );
  });

  test("clamps an over-long title to 512 characters", () => {
    const row = mapSentryIssueToItem(issue({ title: "x".repeat(900) }), CTX);
    expect(row?.title).toHaveLength(512);
  });

  test("returns null for rows that cannot be identified or timestamped", () => {
    expect(mapSentryIssueToItem(issue({ id: undefined }), CTX)).toBeNull();
    expect(mapSentryIssueToItem(issue({ id: "" }), CTX)).toBeNull();
    expect(mapSentryIssueToItem(issue({ lastSeen: undefined }), CTX)).toBeNull();
    expect(mapSentryIssueToItem(issue({ lastSeen: "not-a-date" }), CTX)).toBeNull();
    expect(mapSentryIssueToItem(42, CTX)).toBeNull();
    expect(mapSentryIssueToItem(null, CTX)).toBeNull();
    expect(mapSentryIssueToItem([1, 2], CTX)).toBeNull();
  });

  test("tolerates a non-record project and a missing permalink", () => {
    const row = mapSentryIssueToItem(issue({ project: "web", permalink: undefined }), CTX);
    expect(row?.url).toBeNull();
    expect(row?.canonicalUrl).toBeNull();
    expect(row?.metadata["project"]).toBeNull();
  });

  test("count arrives as a string from Sentry and is preserved verbatim", () => {
    expect(mapSentryIssueToItem(issue(), CTX)?.metadata["count"]).toBe("42");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/connectors/sentry-issue-mapping.test.ts`
Expected: FAIL — module `./sentry-issue-mapping.ts` does not exist.

- [ ] **Step 3: Write the mapper**

Create `packages/gateway/src/connectors/sentry-issue-mapping.ts`:

```typescript
import { clampSyncTitle } from "../sync/pass-cursor-sync-result.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export type SentryIssueMappingContext = {
  readonly org: string;
  readonly syncedAt: number;
};

/**
 * Deliberately NOT `MappedRow<"sentry", "error_issue">`: that interface declares
 * `bodyPreview` as required, and `IndexedItemBodyInput` forbids supplying both
 * `body` and `bodyPreview`. This mapper supplies `body` and lets
 * `upsertIndexedItemForSync` clamp it to the connector's configured depth.
 */
export type SentryIssueMappedRow = {
  readonly service: "sentry";
  readonly type: "error_issue";
  readonly externalId: string;
  readonly title: string;
  readonly body: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly authorId: null;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
  readonly pinned: false;
};

function parseIsoMs(v: string | undefined): number | null {
  if (v === undefined) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** `metadata.value` over `culprit`, either side omitted when absent. */
function buildBody(row: Record<string, unknown>): string {
  const meta = asRecord(row["metadata"]);
  const value = meta === undefined ? undefined : stringField(meta, "value");
  const culprit = stringField(row, "culprit");
  return [value, culprit].filter((s): s is string => s !== undefined && s !== "").join("\n\n");
}

export function mapSentryIssueToItem(
  raw: unknown,
  ctx: SentryIssueMappingContext,
): SentryIssueMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) return null;

  const id = stringField(row, "id");
  if (id === undefined || id === "") return null;

  // Skipped, never defaulted: a defaulted timestamp corrupts the cursor.
  const lastSeenMs = parseIsoMs(stringField(row, "lastSeen"));
  if (lastSeenMs === null) return null;

  const shortId = stringField(row, "shortId");
  const title = stringField(row, "title") ?? shortId ?? id;
  const permalink = stringField(row, "permalink") ?? null;
  const project = asRecord(row["project"]);
  const projectSlug = project === undefined ? null : (stringField(project, "slug") ?? null);

  // `assignedTo` is stored RAW and UNRESOLVED. Spec B resolves it to a person
  // from rows already indexed, with no re-sync. `?? null` rather than a
  // conditional key, so "not assigned" is recorded rather than indistinguishable
  // from "this connector version did not capture assignment".
  const metadata: Record<string, unknown> = {
    org: ctx.org,
    project: projectSlug,
    status: stringField(row, "status") ?? null,
    level: stringField(row, "level") ?? null,
    shortId: shortId ?? null,
    count: row["count"] ?? null,
    userCount: numberField(row, "userCount") ?? null,
    firstSeen: parseIsoMs(stringField(row, "firstSeen")),
    lastSeen: lastSeenMs,
    assignedTo: row["assignedTo"] ?? null,
  };

  return {
    service: "sentry",
    type: "error_issue",
    externalId: id,
    title: clampSyncTitle(title),
    body: buildBody(row),
    url: permalink,
    canonicalUrl: permalink,
    modifiedAt: lastSeenMs,
    authorId: null,
    metadata,
    syncedAt: ctx.syncedAt,
    pinned: false,
  };
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `bun test packages/gateway/src/connectors/sentry-issue-mapping.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
bun run typecheck && bun run preflight:fast && \
git add packages/gateway/src/connectors/sentry-issue-mapping.ts packages/gateway/src/connectors/sentry-issue-mapping.test.ts && \
git commit -m "feat(connectors): pure Sentry issue row mapper"
```

---

## Task 4: The issue pass and the two-pass syncable

**Files:**

- Create: `packages/gateway/src/connectors/sentry-issue-sync.ts`
- Modify: `packages/gateway/src/connectors/sentry-sync.ts`
- Modify: `packages/gateway/test/unit/connectors/sentry-sync.test.ts`

**Interfaces:**

- Consumes: `nextPageUrl` (Task 1), `mapSentryIssueToItem` / `SentryIssueMappedRow` (Task 3).
- Produces: `syncSentryIssuePass(input: SentryIssuePassInput): Promise<SentryIssuePassResult>` where

```ts
type SentryIssuePassInput = {
  readonly ctx: SyncContext;
  readonly apiRoot: string;
  readonly org: string;
  readonly token: string;
  readonly sinceMs: number;
  readonly cursorLastSeenMs: number | null;
  readonly now: number;
  readonly maxPages: number;
};
type SentryIssuePassResult = {
  readonly upserted: number;
  readonly bytes: number;
  readonly maxLastSeenMs: number | null;   // null when the pass indexed nothing
  readonly ok: boolean;                    // false when a request failed; caller must not advance the cursor
  readonly hasMore: boolean;               // true when the page budget stopped a walk that had further pages
};
```

**Context — read before writing the request.** Three API facts from the spec, each of which
silently produces wrong data if ignored:

1. `query` is ONE string and replaces Sentry's `is:unresolved` default. Send
   `query=lastSeen:-<days>d` with **no `is:` term** — that both windows the request and returns
   every status. Adding `is:unresolved` back drops exactly the resolved issues this exists to index.
2. **Never use `statsPeriod` to window.** It only controls the inline `stats` key and returns all
   issues regardless. Set `collapse=stats` to drop that payload instead.
3. Sentry emits `rel="next"` on **every** response. `nextPageUrl` (Task 1) is the termination signal.

- [ ] **Step 1: Write the failing tests**

Add to `packages/gateway/test/unit/connectors/sentry-sync.test.ts`. Note the new cursor prefix and
the per-page URL patterns — **fact 3**: stubs are first-match-wins and never consumed, so page 1's
pattern must NOT match page 2's URL.

```typescript
const ISSUES_RE = /\/organizations\/test-org\/issues\/\?[^#]*$/;
const ISSUES_PAGE1_RE = /\/organizations\/test-org\/issues\/\?(?!.*cursor=)/;
const ISSUES_PAGE2_RE = /\/organizations\/test-org\/issues\/\?.*cursor=C2/;
const CURSOR_V2_PREFIX = "nimbus-sentry2:";

function sentryIssue(id: string, lastSeen: string): Record<string, unknown> {
  return {
    id,
    title: `Issue ${id}`,
    culprit: "app/x.ts in run",
    permalink: `https://acme.sentry.io/issues/${id}/`,
    status: "resolved",
    level: "error",
    lastSeen,
    firstSeen: "2026-07-01T00:00:00.000Z",
    project: { slug: "web" },
    metadata: { value: `boom ${id}` },
    assignedTo: null,
  };
}

describe("sentry-sync — issue pass", () => {
  let fixture: ConnectorSyncFixture;

  beforeEach(async () => {
    fixture = createConnectorSyncFixture();
    fixture.fetchMock.install();
    await fixture.vault.set("sentry.auth_token", "sentry-stub-token");
    await fixture.vault.set("sentry.org_slug", "test-org");
    fixture.fetchMock.respond("GET", PROJECTS_DEFAULT_RE, []);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("indexes issues as sentry:error_issue with a null author", async () => {
    fixture.fetchMock.respond("GET", ISSUES_RE, [sentryIssue("1", "2026-08-01T00:00:00.000Z")], {
      headers: { "content-type": "application/json" },
    });
    await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      null,
    );
    const row = fixture.db
      .query<{ type: string; author_id: string | null; external_id: string }, []>(
        "SELECT type, author_id, external_id FROM item WHERE service = 'sentry' AND type = 'error_issue'",
      )
      .get();
    expect(row?.type).toBe("error_issue");
    expect(row?.external_id).toBe("1");
    expect(row?.author_id).toBeNull();
  });

  // THE STATUS GUARD. The API default is is:unresolved, which would drop these.
  test("sends a lastSeen query with no is: term, and never statsPeriod", async () => {
    fixture.fetchMock.respond("GET", ISSUES_RE, [], {
      headers: { "content-type": "application/json" },
    });
    await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      null,
    );
    const call = fixture.fetchMock.calls.find((c) => c.url.includes("/issues/"));
    const url = new URL(call?.url ?? "https://x/");
    expect(url.searchParams.get("query")).toBe("lastSeen:-30d");
    expect(url.searchParams.get("query")).not.toContain("is:");
    expect(url.searchParams.get("statsPeriod")).toBeNull();
    expect(url.searchParams.get("collapse")).toBe("stats");
    expect(url.searchParams.get("sort")).toBe("date");
  });

  // THE TERMINATION GUARD. Sentry sends rel="next" on the last page too.
  test("stops paginating when the next link declares results=false", async () => {
    fixture.fetchMock.respond("GET", ISSUES_PAGE1_RE, [sentryIssue("1", "2026-08-02T00:00:00.000Z")], {
      headers: {
        "content-type": "application/json",
        Link: '<https://sentry.io/api/0/organizations/test-org/issues/?cursor=C2>; rel="next"; results="true"',
      },
    });
    fixture.fetchMock.respond("GET", ISSUES_PAGE2_RE, [sentryIssue("2", "2026-08-01T00:00:00.000Z")], {
      headers: {
        "content-type": "application/json",
        Link: '<https://sentry.io/api/0/organizations/test-org/issues/?cursor=C3>; rel="next"; results="false"',
      },
    });
    await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      null,
    );
    const issueCalls = fixture.fetchMock.calls.filter((c) => c.url.includes("/issues/"));
    expect(issueCalls).toHaveLength(2);
    const ids = fixture.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE type = 'error_issue' ORDER BY external_id",
      )
      .all()
      .map((r) => r.external_id);
    expect(ids).toEqual(["1", "2"]);
  });

  test("stops early once a row is at or below the stored cursor", async () => {
    const cursor =
      CURSOR_V2_PREFIX +
      Buffer.from(JSON.stringify({ lastSeenMs: Date.parse("2026-08-01T12:00:00.000Z") }), "utf8")
        .toString("base64url");
    fixture.fetchMock.respond(
      "GET",
      ISSUES_RE,
      [
        sentryIssue("new", "2026-08-02T00:00:00.000Z"),
        sentryIssue("old", "2026-07-01T00:00:00.000Z"),
      ],
      { headers: { "content-type": "application/json" } },
    );
    await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      cursor,
    );
    const ids = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE type = 'error_issue'")
      .all()
      .map((r) => r.external_id);
    expect(ids).toEqual(["new"]);
  });

  // THE LEGACY CURSOR. Every existing install has one persisted.
  test("a legacy nimbus-sentry1 cursor is treated as a cold start", async () => {
    fixture.fetchMock.respond("GET", ISSUES_RE, [], {
      headers: { "content-type": "application/json" },
    });
    const legacy =
      "nimbus-sentry1:" + Buffer.from(JSON.stringify({ pass: 1 }), "utf8").toString("base64url");
    const res = await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      legacy,
    );
    const call = fixture.fetchMock.calls.find((c) => c.url.includes("/issues/"));
    expect(new URL(call?.url ?? "https://x/").searchParams.get("query")).toBe("lastSeen:-30d");
    expect(res.cursor?.startsWith(CURSOR_V2_PREFIX)).toBe(true);
  });

  // THE MIS-SCOPED TOKEN. project:read lists projects but 403s on issues.
  test("a 403 on the issue pass indexes nothing and leaves the cursor unadvanced", async () => {
    const cursor =
      CURSOR_V2_PREFIX +
      Buffer.from(JSON.stringify({ lastSeenMs: 1_600_000_000_000 }), "utf8").toString("base64url");
    fixture.fetchMock.respond("GET", ISSUES_RE, { detail: "forbidden" }, { status: 403 });
    const res = await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      cursor,
    );
    expect(res.cursor).toBe(cursor);
    const n = fixture.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM item WHERE type = 'error_issue'")
      .get();
    expect(n?.n).toBe(0);
  });

  test("honours historyFloorMs on a cold start", async () => {
    fixture.fetchMock.respond("GET", ISSUES_RE, [], {
      headers: { "content-type": "application/json" },
    });
    const floor = Date.now() - 120 * 86_400_000;
    await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full", historyFloorMs: floor },
      null,
    );
    const call = fixture.fetchMock.calls.find((c) => c.url.includes("/issues/"));
    const q = new URL(call?.url ?? "https://x/").searchParams.get("query") ?? "";
    expect(q).toMatch(/^lastSeen:-1[12]\dd$/);
  });

  test("a row with an unparseable lastSeen is skipped, not defaulted", async () => {
    fixture.fetchMock.respond(
      "GET",
      ISSUES_RE,
      [{ id: "bad", title: "x", lastSeen: "nope" }, sentryIssue("good", "2026-08-01T00:00:00.000Z")],
      { headers: { "content-type": "application/json" } },
    );
    await createSentrySyncable(ENSURE_MCP).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      null,
    );
    const ids = fixture.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE type = 'error_issue'")
      .all()
      .map((r) => r.external_id);
    expect(ids).toEqual(["good"]);
  });

  test("stops at the page budget", async () => {
    fixture.fetchMock.respond("GET", ISSUES_RE, [sentryIssue("1", "2026-08-02T00:00:00.000Z")], {
      headers: {
        "content-type": "application/json",
        Link: '<https://sentry.io/api/0/organizations/test-org/issues/?cursor=CN>; rel="next"; results="true"',
      },
    });
    const res = await createSentrySyncable({ ...ENSURE_MCP, maxPagesPerSync: 2 }).sync(
      { ...fixture.createSyncContext(), depth: "full" },
      null,
    );
    expect(fixture.fetchMock.calls.filter((c) => c.url.includes("/issues/"))).toHaveLength(2);
    expect(res.hasMore).toBe(true);
  });
});
```

Existing tests in that file assert the **old** `nimbus-sentry1:` prefix and a `{pass: 1}` payload
(the `describe("cursor decode")` block, and the `res.cursor.startsWith(CURSOR_PREFIX)` assertions
in the HTTP-path block). Update those to `nimbus-sentry2:` and the `{lastSeenMs}` payload as part
of this task — they are testing the cursor contract this task deliberately changes.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/test/unit/connectors/sentry-sync.test.ts`
Expected: FAIL — `MockFetch: no stub matched GET …/issues/…` is never reached because no issue
request is made; the cursor-prefix assertions fail on `nimbus-sentry1:`.

- [ ] **Step 3: Write the issue pass**

Create `packages/gateway/src/connectors/sentry-issue-sync.ts`:

```typescript
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import type { SyncContext } from "../sync/types.ts";
import { nextPageUrl } from "./link-header.ts";
import { mapSentryIssueToItem } from "./sentry-issue-mapping.ts";

export type SentryIssuePassInput = {
  readonly ctx: SyncContext;
  readonly apiRoot: string;
  readonly org: string;
  readonly token: string;
  readonly sinceMs: number;
  readonly cursorLastSeenMs: number | null;
  readonly now: number;
  readonly maxPages: number;
};

export type SentryIssuePassResult = {
  readonly upserted: number;
  readonly bytes: number;
  readonly maxLastSeenMs: number | null;
  readonly ok: boolean;
  readonly hasMore: boolean;
};

const MS_PER_DAY = 86_400_000;

/**
 * `query` is ONE string and REPLACES Sentry's `is:unresolved` default, so a
 * `lastSeen:` term with no `is:` term both windows the request and returns every
 * status — resolved issues included, which is the entire point. `statsPeriod` is
 * deliberately absent: it does not filter the result set, it only controls the
 * inline `stats` key, which `collapse=stats` drops.
 */
function firstPageUrl(input: SentryIssuePassInput): string {
  const days = Math.max(1, Math.ceil((input.now - input.sinceMs) / MS_PER_DAY));
  const u = new URL(`${input.apiRoot}/organizations/${encodeURIComponent(input.org)}/issues/`);
  u.searchParams.set("query", `lastSeen:-${String(days)}d`);
  u.searchParams.set("sort", "date");
  u.searchParams.set("collapse", "stats");
  u.searchParams.set("limit", "100");
  return u.toString();
}

export async function syncSentryIssuePass(
  input: SentryIssuePassInput,
): Promise<SentryIssuePassResult> {
  const { ctx } = input;
  let url: string | null = firstPageUrl(input);
  let pages = 0;
  let upserted = 0;
  let bytes = 0;
  let maxLastSeenMs: number | null = null;

  while (url !== null && pages < input.maxPages) {
    await ctx.rateLimiter.acquire("sentry");
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${input.token}`, Accept: "application/json" },
    });
    const text = await res.text();
    bytes += text.length;
    if (!res.ok) {
      // 403 is the mis-scoped-token case: the org issues endpoint needs
      // `event:read`, which a `project:read` token lacks even though pass 1
      // succeeds with it. Treated as an ordinary failure — nothing indexed, and
      // `ok: false` stops the caller advancing the cursor past unfetched data.
      ctx.logger.warn(
        { serviceId: "sentry", status: res.status, page: pages },
        res.status === 403
          ? "sentry sync: issues forbidden — the auth token needs the event:read scope"
          : "sentry sync: issues list failed",
      );
      return { upserted, bytes, maxLastSeenMs, ok: false, hasMore: false };
    }

    let root: unknown;
    try {
      root = JSON.parse(text) as unknown;
    } catch {
      ctx.logger.warn({ serviceId: "sentry", page: pages }, "sentry sync: issues body not JSON");
      return { upserted, bytes, maxLastSeenMs, ok: false, hasMore: false };
    }
    const list = Array.isArray(root) ? root : [];

    for (const raw of list) {
      const row = mapSentryIssueToItem(raw, { org: input.org, syncedAt: input.now });
      if (row === null) continue;
      // Descending scan: the first row at or below the stored high-water mark
      // means everything after it is already indexed.
      if (input.cursorLastSeenMs !== null && row.modifiedAt <= input.cursorLastSeenMs) {
        return { upserted, bytes, maxLastSeenMs, ok: true, hasMore: false };
      }
      upsertIndexedItemForSync(ctx, row);
      upserted += 1;
      if (maxLastSeenMs === null || row.modifiedAt > maxLastSeenMs) {
        maxLastSeenMs = row.modifiedAt;
      }
    }

    pages += 1;
    url = nextPageUrl(res.headers.get("Link"));
  }

  return { upserted, bytes, maxLastSeenMs, ok: true, hasMore: url !== null };
}
```

- [ ] **Step 4: Wire the two-pass syncable**

In `sentry-sync.ts`:

1. Change `const CURSOR_PREFIX = "nimbus-sentry1:";` to `"nimbus-sentry2:"`.
2. Replace `type SentryCursorV1 = { pass: number }` with `type SentryCursorV2 = { lastSeenMs: number }`,
   and replace `pass1Cursor()` with an `encodeCursor({ lastSeenMs })` helper.
3. Add a `decodeCursor(raw: string | null): SentryCursorV2 | null` mirroring `pagerduty-sync.ts`'s —
   it returns `null` on a prefix miss, which is what makes a persisted `nimbus-sentry1:` cursor a
   cold start with no legacy branch (fact 10).
4. Change `initialSyncDepthDays` from `1` to `30`.
5. Add `maxPagesPerSync?: number` to `SentrySyncableOptions` and clamp it as PagerDuty does:
   `Math.max(1, Math.min(100, options.maxPagesPerSync ?? 20))`.
6. The existing projects pass ends by `return`ing `syncPassCursorSuccess(...)`. It must stop
   returning and instead keep its results for composition. Concretely: rename its `let upserted = 0`
   to `let projectsUpserted = 0` (updating the two `upserted += 1` / usages in the project loop),
   capture `const projectBytes = text.length` where the projects response is read, and delete the
   three `syncPassCursorSuccess` / `syncPassCursorHttpEmpty` / `syncPassCursorParseEmpty` returns in
   favour of early-returning with `projectsUpserted = 0` and skipping the issue pass when the
   projects request itself failed. Then drop the now-unused imports from
   `sync/pass-cursor-sync-result.ts`, **keeping `clampSyncTitle`**, which Task 3 uses.

7. After the projects pass, call the issue pass and compose the result:

```typescript
const prev = decodeCursor(cursor);
// Honors `SyncContext.historyFloorMs` (opt-in, see `sync/types.ts`) on a COLD
// START only; an established cursor is more recent by construction and wins.
const coldFloorMs =
  ctx.historyFloorMs !== undefined && Number.isFinite(ctx.historyFloorMs)
    ? ctx.historyFloorMs
    : now - initialSyncDepthDays * 86_400_000;

const issues = await syncSentryIssuePass({
  ctx,
  apiRoot,
  org,
  token,
  sinceMs: prev === null ? coldFloorMs : now - initialSyncDepthDays * 86_400_000,
  cursorLastSeenMs: prev?.lastSeenMs ?? null,
  now,
  maxPages: maxPagesPerSync,
});

// Never advance past data that was not fetched. A failed pass keeps the incoming
// cursor so the next tick retries the same window — see the spec's "Do not
// optimise this by checkpointing" note before changing this.
const nextCursor =
  issues.ok && issues.maxLastSeenMs !== null
    ? encodeCursor({ lastSeenMs: issues.maxLastSeenMs })
    : (cursor ?? encodeCursor({ lastSeenMs: prev?.lastSeenMs ?? 0 }));

return {
  cursor: nextCursor,
  itemsUpserted: projectsUpserted + issues.upserted,
  itemsDeleted: 0,
  hasMore: issues.hasMore,
  durationMs: Math.round(performance.now() - t0),
  bytesTransferred: projectBytes + issues.bytes,
};
```

- [ ] **Step 5: Run the suite**

Run: `bun test packages/gateway/test/unit/connectors/sentry-sync.test.ts`
Expected: PASS — the pre-existing project tests plus the 9 new issue tests.

- [ ] **Step 6: Red-prove the three guards**

1. Change the query to `` `is:unresolved lastSeen:-${days}d` ``. Expected: **"sends a lastSeen
   query with no is: term"** FAILS. Restore.
2. Replace `nextPageUrl(res.headers.get("Link"))` with a raw `rel="next"` regex that ignores
   `results`. Expected: **"stops paginating when the next link declares results=false"** FAILS by
   running to the page budget. Restore.
3. Make the `!res.ok` arm return `ok: true`. Expected: **"a 403 … leaves the cursor unadvanced"**
   FAILS. Restore.

- [ ] **Step 7: Commit**

```bash
bun run typecheck && bun run preflight:fast && \
git add packages/gateway/src/connectors/sentry-issue-sync.ts packages/gateway/src/connectors/sentry-sync.ts packages/gateway/test/unit/connectors/sentry-sync.test.ts && \
git commit -m "feat(connectors): index Sentry issues as sentry:error_issue"
```

---

## Task 5: The `error_issue` graph branch

**Files:**

- Modify: `packages/gateway/src/graph/graph-populator.ts`
- Create: `packages/gateway/src/graph/graph-populator-error-issue.test.ts`

**Interfaces:**

- Consumes: `IndexedItemGraphInput`, `upsertGraphEntity`, `upsertGraphRelation`,
  `clearRelationsTouchingEntity` (all already in `graph-populator.ts` / `relationship-graph.ts`).
- Produces: an `error_issue` graph entity per indexed Sentry issue, plus a `belongs_to` edge to a
  `service` entity keyed on the project slug. **No person edges** — Spec B adds those.

**Context — the Spec B seam, read this before writing.** `clearRelationsTouchingEntity`
(`graph-populator.ts:96`) deletes **every** edge touching the entity except the four
`CROSS_ITEM_RELATION_TYPES` (`resolves`, `mentions`, `correlates_with`, `reviewed`). A
`person --assigned--> error_issue` edge is not among them, so when Spec B adds it, that edge is
wiped on every re-sync **unless Spec B re-emits it inside this same branch**. Leave the comment
below in place so the constraint is discoverable from the code rather than from this plan.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/graph/graph-populator-error-issue.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { upsertIndexedItem } from "../index/item-store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function seedErrorIssue(db: Database, id: string, project: string | null): void {
  upsertIndexedItem(db, {
    service: "sentry",
    type: "error_issue",
    externalId: id,
    title: `Issue ${id}`,
    body: "boom",
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    authorId: null,
    metadata: { org: "acme", project },
  });
}

test("an indexed Sentry issue becomes an error_issue graph entity", () => {
  const db = freshDb();
  seedErrorIssue(db, "4711", "web");
  const row = db
    .query<{ type: string; label: string; service: string | null }, []>(
      "SELECT type, label, service FROM graph_entity WHERE type = 'error_issue'",
    )
    .get();
  expect(row?.type).toBe("error_issue");
  expect(row?.label).toBe("Issue 4711");
  expect(row?.service).toBe("sentry");
  db.close();
});

test("the issue belongs_to a service entity keyed on its project slug", () => {
  const db = freshDb();
  seedErrorIssue(db, "4711", "web");
  const rel = db
    .query<{ type: string; label: string }, []>(
      `SELECT r.type AS type, te.label AS label
         FROM graph_relation r
         JOIN graph_entity fe ON fe.id = r.from_id AND fe.type = 'error_issue'
         JOIN graph_entity te ON te.id = r.to_id
        WHERE r.type = 'belongs_to'`,
    )
    .get();
  expect(rel?.type).toBe("belongs_to");
  expect(rel?.label).toBe("web");
  db.close();
});

test("an issue with no project slug still yields an entity and no belongs_to edge", () => {
  const db = freshDb();
  seedErrorIssue(db, "4712", null);
  const entity = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM graph_entity WHERE type = 'error_issue'")
    .get();
  const rels = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'belongs_to'")
    .get();
  expect(entity?.n).toBe(1);
  expect(rels?.n).toBe(0);
  db.close();
});

// SPEC A ATTRIBUTES NOTHING.
test("no person edge is emitted for an error_issue", () => {
  const db = freshDb();
  seedErrorIssue(db, "4711", "web");
  const n = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'`,
    )
    .get();
  expect(n?.n).toBe(0);
  db.close();
});

// RE-SYNC IDEMPOTENCE. clearRelationsTouchingEntity runs on every pass.
test("re-indexing the same issue does not duplicate its belongs_to edge", () => {
  const db = freshDb();
  seedErrorIssue(db, "4711", "web");
  seedErrorIssue(db, "4711", "web");
  const n = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'belongs_to'")
    .get();
  expect(n?.n).toBe(1);
  db.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/graph/graph-populator-error-issue.test.ts`
Expected: FAIL — no `error_issue` row in `graph_entity`; `graph-populator.ts` has no branch for it.

- [ ] **Step 3: Add the branch**

In `graph-populator.ts`, beside the other `row.type ===` branches (around `:883`, before the
`incident` branch), add:

```typescript
  if (row.type === "error_issue") {
    syncErrorIssueGraph(db, row, now);
    return;
  }
```

and the function, mirroring `syncIssueGraph` (`:340`):

```typescript
/**
 * A Sentry error group. Deliberately NOT an `incident` entity: an error group
 * with a large event count that never paged anyone is not an incident, and
 * counting it as one inflates every downstream contribution brief.
 *
 * `clearRelationsTouchingEntity` removes every edge touching this entity except
 * the four CROSS_ITEM_RELATION_TYPES, so ANY edge a later change wants to keep
 * across re-syncs must be re-emitted HERE, in this function. That includes the
 * `person --assigned--> error_issue` edge planned for the attribution spec.
 */
function syncErrorIssueGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const projectRaw = row.metadata["project"];
  const project = typeof projectRaw === "string" && projectRaw !== "" ? projectRaw : undefined;

  const entityId = upsertGraphEntity(db, {
    type: "error_issue",
    externalId: row.id,
    label: row.title,
    service: row.service,
    metadata: { project: project ?? null },
  });
  clearRelationsTouchingEntity(db, entityId);

  if (project !== undefined) {
    const serviceId = upsertGraphEntity(db, {
      type: "service",
      externalId: `${row.service}:${project}`,
      label: project,
      service: row.service,
    });
    upsertGraphRelation(db, entityId, serviceId, "belongs_to", now);
  }
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `bun test packages/gateway/src/graph/graph-populator-error-issue.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the whole graph suite for regressions**

Run: `bun test packages/gateway/src/graph/`
Expected: PASS. A new branch in the dispatch chain can change which branch a previously
unmatched type falls through to — the existing suite is what proves it did not.

- [ ] **Step 6: Commit**

```bash
bun run typecheck && bun run preflight:fast && \
git add packages/gateway/src/graph/ && \
git commit -m "feat(graph): populate error_issue entities from indexed Sentry issues"
```

---

## Task 6: Documentation and the coverage floor

**Files:**

- Modify: `docs/CHANGELOG.md`
- Modify: `packages/gateway/src/connectors/sentry-sync.ts` (doc comment stating the required scope)

**Do not create a Sentry connector doc page.** `docs/connectors/` contains exactly three pages —
`github.md`, `slack.md`, `vercel.md` — so Sentry having none is the norm here, not an omission
this task introduced. Broad connector-page coverage is tracked in issue #1002; adding one page
off-pattern is scope creep. The scope requirement goes in the CHANGELOG and in a doc comment at
the connector's token read, where someone debugging an empty index will actually look.

**Interfaces:** none — this task ships no behaviour.

- [ ] **Step 1: Write the CHANGELOG entry**

Add under the unreleased heading, matching the surrounding style:

```markdown
- **Sentry issues are now indexed** (`sentry:error_issue`). The connector previously indexed only
  projects. Issues are pulled org-wide, windowed by `lastSeen` with a 30-day cold start, and
  include resolved issues. Requires the Sentry auth token to carry the **`event:read`** scope —
  a `project:read`-only token continues to sync projects but logs a warning and indexes no issues.
  Assignment is captured but not yet attributed to a person.
```

- [ ] **Step 2: Document the token scope at the point of use**

Add a doc comment above the `readConnectorSecret(ctx.vault, "sentry", "auth_token")` call in
`sentry-sync.ts`:

```typescript
/**
 * `sentry.auth_token` must carry the **`event:read`** scope. The org-wide issues
 * endpoint rejects a `project:read`-only token with 403 while the projects list
 * below still succeeds — so a mis-scoped install syncs projects, indexes zero
 * issues, and looks configured. A project-scoped token cannot reach the endpoint
 * at all, and an Organization Auth Token is not a substitute: it exists for
 * source-map upload in CI and its scope cannot be changed after creation.
 */
```

- [ ] **Step 3: Build a full-suite lcov and check the floor**

**Scoped runs under-report badly and must not be used to answer a floor question.**

```bash
bash scripts/coverage-floor/build-lcov.sh && bun run audit:coverage-floor
```

Expected: no violation for `link-header.ts`, `sentry-issue-mapping.ts`, `sentry-issue-sync.ts`,
`sentry-sync.ts`, `graph-populator.ts`, or `mendeley-sync.ts`.

- [ ] **Step 4: Fix any file below 85% line / 80% branch**

Write targeted tests for the uncovered arms — do **not** add a coverage exclusion. The likely
shortfalls are `sentry-issue-sync.ts`'s non-JSON body arm and `sentry-sync.ts`'s cursor-fallback
expression. Re-run Step 3 until clean.

- [ ] **Step 5: Full preflight**

```bash
bun run preflight && bun run typecheck:tests
```

Expected: `preflight PASSED`. Read the `typecheck:tests` "N new" line — it must be 0 new.

- [ ] **Step 6: Commit**

```bash
git add docs/ packages/ && \
git commit -m "docs: record Sentry issue indexing and its event:read scope requirement"
```

---

## Out of scope — do not do these here

Each is deliberate; the spec records why.

- Any person attribution, `authorId`, or `person -> error_issue` edge. **Spec B.**
- Rewording `remediationForEntityType("incident")` in `agents/_lib/gap-notes.ts`. **Spec B.**
- Any change to `pagerduty-sync.ts`. **Spec B.**
- Adding `sentry:error_issue` to `PROSE_HEAVY_TYPES`.
- Adding a `project` graph entity type or a `project -> error_issue` edge.
- Deleting the unused `_lib/pagination.ts`.
- Falling back to per-project issue listing when the token lacks `event:read`.
- Any migration.
