# Stage 0 (Revised) — Seal the Narrow Waist: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the gateway relabelling 55% of indexed items as `"file"`, and make `index.queryItems`
return validated `NimbusItem` objects instead of raw SQLite rows, so the VS Code Index view renders
item types and sorts by recency.

**Architecture:** One mapping seam. `rowToItem` (already a complete, lossless V3-row → `NimbusItem`
translator) becomes the only translation in the system. A new `LocalIndex.listItems()` owns the
list SQL plus that mapping; `index.queryItems` calls it instead of returning `SELECT *` rows. The
wire becomes camelCase `NimbusItem & { indexPrimaryKey }`, so `@nimbus-dev/client` *validates* a
shape rather than transcribing one, and nimbus-vscode consumes the real type.

**Tech Stack:** TypeScript strict, Bun (`bun test`) in `Nimbus` and `nimbus-client`, Vitest in
`nimbus-vscode`, Biome for lint in all three, release-please + npm trusted publishing for the client.

**Design:** [`../specs/2026-07-20-stage-0-real-schema-design.md`](../specs/2026-07-20-stage-0-real-schema-design.md)

## Global Constraints

- TypeScript **strict**, **no `any`** — use `unknown` for external data. Non-negotiable #7.
- The item-type vocabulary is an **open enum**. Never rewrite an unrecognised type to a recognised
  one; preserving it verbatim is required behaviour.
- `@nimbus-dev/sdk@1.4.0` is published and already satisfies the gateway's `^1.3.0` range. No
  manifest edit is needed in `Nimbus`.
- `@nimbus-dev/client` ships as **0.6.0** (minor; breaking is permitted pre-1.0) via release-please.
  Do not hand-edit `package.json` versions or `CHANGELOG.md`; PR titles must be Conventional Commits.
- **Tasks are strictly ordered.** Task 3 validates a shape that only exists after Tasks 1–2 merge.
  Task 4's fixture must be captured from a gateway carrying Tasks 1–2.
- In `Nimbus`, work on a branch in a worktree — never commit on `main`. Run `bun run preflight:fast`
  before any push.
- Do not touch `vault.*` or `db.*`.

## File structure

| File | Repo | Responsibility |
| --- | --- | --- |
| `packages/gateway/src/index/local-index.ts` (modify) | `Nimbus` | Delete the coercion; add `IndexedItem` + `listItems()` |
| `packages/gateway/src/index/local-index.test.ts` (modify) | `Nimbus` | Prove ops + unknown types round-trip |
| `packages/gateway/src/ipc/diagnostics-rpc.ts` (modify) | `Nimbus` | `index.queryItems` calls `listItems()` |
| `packages/gateway/src/ipc/diagnostics-rpc.test.ts` (modify) | `Nimbus` | Wire-shape gate: no snake_case, has `indexPrimaryKey` |
| `packages/cli/src/commands/query.ts` (modify) | `Nimbus` | Update the local result type |
| `src/validate.ts` (modify) | `nimbus-client` | `validateQueryItems` validates `IndexedItem` |
| `src/nimbus-client.ts` (modify) | `nimbus-client` | `IndexedItem` type; `queryItems` return type |
| `src/mock-client.ts` (modify) | `nimbus-client` | Parity stub |
| `src/index.ts` (modify) | `nimbus-client` | Re-export `IndexedItem` + `NimbusItem` |
| `test/fixtures/query-items-response.json` (create) | `nimbus-client` | Golden response captured from a live gateway |
| `test/query-items-conformance.test.ts` (create) | `nimbus-client` | The cross-repo drift gate |
| `src/sidebar/index.ts` (modify) | `nimbus-vscode` | Delete the private mirror; total icon lookup |
| `test/unit/index.test.ts` (modify) | `nimbus-vscode` | Ops + unknown types survive `parseIndexRow` |

---

## Task 1: Gateway — delete the lossy coercion

**Repo:** `Nimbus` (`C:/gitrep/Nimbus`)

**Files:**

- Modify: `packages/gateway/src/index/local-index.ts:94-105` (delete) and `:165`
- Test: `packages/gateway/src/index/local-index.test.ts`

**Interfaces:**

- Consumes: `NimbusItem`, open `ItemType` from `@nimbus-dev/sdk@1.4.0`.
- Produces: no new exports. `rowToItem` keeps its signature; only its fidelity changes. Fixes
  `LocalIndex.search`, `LocalIndex.searchRanked` and `index.queryItems` simultaneously, because all
  three funnel through `rowToItem`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/gateway/src/index/local-index.test.ts`, immediately after the existing
`"upsert with itemType 'event' round-trips as event"` test (line ~118). Reuse that file's existing
`makeIndex()` (line 18) and `makeItem()` (line 24) helpers — do not redefine them.

```ts
  test("upsert round-trips every ops item type instead of coercing to file", () => {
    const idx = makeIndex();
    const opsTypes = ["ci_run", "pr", "issue", "deployment", "incident", "web_clip"];
    for (const t of opsTypes) {
      idx.upsert(makeItem({ id: `ops-${t}`, itemType: t, name: `ops item ${t}` }));
    }
    for (const t of opsTypes) {
      const hits = idx.search({ name: `ops item ${t}` });
      expect(hits.find((h) => h.id === `ops-${t}`)?.itemType).toBe(t);
    }
  });

  test("upsert round-trips an item type this gateway build does not know", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "future-1", itemType: "dora_metric", name: "future typed item" }));
    const hits = idx.search({ name: "future typed item" });
    expect(hits.find((h) => h.id === "future-1")?.itemType).toBe("dora_metric");
  });

  test("upsert preserves 'folder', which the gateway really does emit", () => {
    // google-drive-sync.ts:173 emits `type: isFolder ? "folder" : "file"`.
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "fold-1", itemType: "folder", name: "a real folder" }));
    const hits = idx.search({ name: "a real folder" });
    expect(hits.find((h) => h.id === "fold-1")?.itemType).toBe("folder");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd C:/gitrep/Nimbus && bun test packages/gateway/src/index/local-index.test.ts
```

Expected: FAIL. The first two tests receive `"file"` for every ops type and for `dora_metric`.
**This failure is the bug reproduced** — record the output. The third test (`folder`) passes
already, because `folder` is one of the six values the coercion happens to accept.

- [ ] **Step 3: Delete the coercion function**

In `packages/gateway/src/index/local-index.ts`, delete this entire function (lines 94-105):

```ts
function itemTypeFromRowType(raw: string): NimbusItem["itemType"] {
  if (
    raw === "file" ||
    raw === "folder" ||
    raw === "email" ||
    raw === "event" ||
    raw === "photo" ||
    raw === "task"
  ) {
    return raw;
  }
  return "file";
}
```

- [ ] **Step 4: Pass the raw column value through**

In the same file, in `rowToItem` (line ~161), change the `itemType` line:

```ts
// Before:
//   itemType: itemTypeFromRowType(String(row.type)),
// After:
    itemType: String(row.type),
```

`ItemType` is an open enum (`KnownItemType | (string & {})`), so `string` is assignable and no cast
is needed.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd C:/gitrep/Nimbus && bun test packages/gateway/src/index/local-index.test.ts
```

Expected: PASS.

- [ ] **Step 6: Confirm no other coercion survives**

```bash
cd C:/gitrep/Nimbus && grep -rn "itemTypeFromRowType" packages/ --include=*.ts
```

Expected: no output. If anything matches, it is the same bug in another spelling — remove it too.

- [ ] **Step 7: Run the wider gate**

```bash
cd C:/gitrep/Nimbus && bun test packages/gateway/src/index/ && bun run preflight:fast
```

Expected: PASS. If another test asserted the old coercion (e.g. expecting `"file"` for a non-file
type), update it — that test encoded the bug.

- [ ] **Step 8: Commit**

```bash
cd C:/gitrep/Nimbus
git add packages/gateway/src/index/local-index.ts packages/gateway/src/index/local-index.test.ts
git commit -m "fix: stop relabelling most indexed item types as \"file\"

itemTypeFromRowType() accepted only the six values in the pre-1.4.0 SDK union
and returned \"file\" for everything else. Measured against a live 546-row
index that mislabels 300 rows (55%): ci_run (214), pr (79), issue (5) and
web_clip (2) all came back as files.

@nimbus-dev/sdk 1.4.0 makes ItemType an open enum, so the raw column value
passes through unchanged. Fixes search, searchRanked and queryItems at once,
since all three map rows through rowToItem."
```

---

## Task 2: Gateway — return NimbusItem from `index.queryItems`

**Repo:** `Nimbus`. **Depends on:** Task 1.

**Files:**

- Modify: `packages/gateway/src/index/local-index.ts` (add `IndexedItem` + `listItems`)
- Modify: `packages/gateway/src/ipc/diagnostics-rpc.ts:312-345`
- Modify: `packages/cli/src/commands/query.ts:73-79`
- Test: `packages/gateway/src/ipc/diagnostics-rpc.test.ts`
- Test: `packages/gateway/src/index/local-index.test.ts` (direct `listItems` coverage)
- Test: `packages/cli/src/commands/query.test.ts:106-124` (fixture uses raw V3 columns)

**Interfaces:**

- Consumes: `rowToItem` (module-private, Task 1), `buildItemListSql` + `ItemListQueryParams` from
  `packages/gateway/src/index/item-list-query.ts`.
- Produces:
  - `export type IndexedItem = NimbusItem & { indexPrimaryKey: string }` from `local-index.ts`.
  - `LocalIndex.listItems(params: ItemListQueryParams): IndexedItem[]`.
  - `index.queryItems` JSON-RPC result becomes `{ items: IndexedItem[], meta: { limit, total } }`.

`rowToItem` and `ItemRow` stay module-private — `listItems` is the public seam, mirroring how
`search()` wraps `searchRanked()`.

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/ipc/diagnostics-rpc.test.ts` inside the existing
`describe("index.queryItems", ...)` block (line ~601). Reuse that file's `makeCtxWithIndex()`
(line 41) and `rmTmp()` (line 60) helpers.

```ts
  test("returns camelCase NimbusItem rows with indexPrimaryKey, never raw columns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi3-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        db.run(
          `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
           VALUES ('github:run-1', 'github', 'ci_run', 'run-1', 'nightly build', 5000, 5000,
                   '{"mime_type":"application/json","size_bytes":42,"created_at":4000}')`,
        );
        const r = await dispatchDiagnosticsRpc("index.queryItems", {}, ctx);
        expect(r.kind).toBe("hit");
        const v = (r as { value: { items: Record<string, unknown>[] } }).value;
        const row = v.items[0];
        expect(row).toBeDefined();

        // The type survives — not coerced to "file".
        expect(row?.["itemType"]).toBe("ci_run");
        // Wire is camelCase NimbusItem, not the V3 column names.
        expect(row?.["name"]).toBe("nightly build");
        expect(row?.["id"]).toBe("run-1");
        expect(row?.["indexPrimaryKey"]).toBe("github:run-1");
        expect(row?.["modifiedAt"]).toBe(5000);
        // metadata JSON is unpacked by rowToItem.
        expect(row?.["mimeType"]).toBe("application/json");
        expect(row?.["sizeBytes"]).toBe(42);
        expect(row?.["createdAt"]).toBe(4000);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });

  test("no response key is snake_case", async () => {
    // The structural gate. If queryItems ever regresses to returning raw
    // SELECT * rows, this fails regardless of how the regression is written.
    const dir = mkdtempSync(join(tmpdir(), "nimbus-diag-qi4-"));
    try {
      const { ctx, db } = makeCtxWithIndex(dir);
      try {
        db.run(
          `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
           VALUES ('slack:m-1', 'slack', 'message', 'm-1', 'hello', 1000, 1000)`,
        );
        const r = await dispatchDiagnosticsRpc("index.queryItems", {}, ctx);
        const v = (r as { value: { items: Record<string, unknown>[] } }).value;
        const keys = Object.keys(v.items[0] ?? {});
        expect(keys.length).toBeGreaterThan(0);
        expect(keys.filter((k) => k.includes("_"))).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      rmTmp(dir);
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd C:/gitrep/Nimbus && bun test packages/gateway/src/ipc/diagnostics-rpc.test.ts
```

Expected: FAIL — `row["itemType"]` is `undefined` (the raw row has `type`), and the snake_case
filter returns `["external_id", "body_preview", "canonical_url", "modified_at", "author_id",
"synced_at"]` instead of `[]`.

- [ ] **Step 3: Add the `IndexedItem` type and `listItems` to `LocalIndex`**

In `packages/gateway/src/index/local-index.ts`, add the import at the top alongside the other
`./` imports:

```ts
import { buildItemListSql, type ItemListQueryParams } from "./item-list-query.ts";
```

Export the type next to the other exported types in that file:

```ts
/**
 * A `NimbusItem` plus the index primary key (`service:external_id`).
 *
 * `rowToItem` sets `id` to the bare `external_id`, which is NOT unique across
 * services, so list consumers need the composite key for stable identity.
 * Mirrors how `RankedIndexItem` exposes `indexPrimaryKey`.
 */
export type IndexedItem = NimbusItem & { indexPrimaryKey: string };
```

Add this method to the `LocalIndex` class, immediately after `search()` (line ~711):

```ts
  /**
   * List indexed items for `index.queryItems`.
   *
   * Owns the SQL and the row mapping together so no caller ever sees a raw V3
   * row: the snake_case column names must not cross the IPC boundary.
   */
  listItems(params: ItemListQueryParams): IndexedItem[] {
    const { sql, vals } = buildItemListSql(params);
    const rows = this.db.query(sql).all(...vals) as ItemRow[];
    return rows.map((row) => ({ ...rowToItem(row), indexPrimaryKey: String(row.id) }));
  }
```

- [ ] **Step 4: Wire the RPC to `listItems`**

In `packages/gateway/src/ipc/diagnostics-rpc.ts`, in `rpcIndexQueryItems` (line ~312), replace the
final three lines of the function body. Everything above them — the `sinceMs` / `untilMs` / `limit` /
`services` / `types` parsing — stays exactly as it is.

```ts
// Before:
//   const d = requireDb(ctx);
//   const { sql, vals } = buildItemListSql({ ... });
//   const rows = d.query(sql).all(...vals) as Record<string, unknown>[];
//   return { kind: "hit", value: { items: rows, meta: { limit, total: rows.length } } };

// After:
  const items = requireLocalIndex(ctx).listItems({
    services,
    types,
    limit,
    ...(sinceMs === undefined ? {} : { sinceMs }),
    ...(untilMs === undefined ? {} : { untilMs }),
  });
  return { kind: "hit", value: { items, meta: { limit, total: items.length } } };
```

Then delete the now-unused import at `diagnostics-rpc.ts:23`:

```ts
import { buildItemListSql } from "../index/item-list-query.ts";
```

Line 336 was its only use in that file, so leaving it fails lint. Leave `requireDb` alone — other
RPCs still call it.

`{ kind, value }` is the internal `DiagnosticsRpcOutcome`; `ipc/server/dispatchers.ts:1224` unwraps
it, so the JSON-RPC `result` is `{ items, meta }`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd C:/gitrep/Nimbus && bun test packages/gateway/src/ipc/diagnostics-rpc.test.ts
```

Expected: PASS, including the two pre-existing `index.queryItems` tests (empty-db defaults and the
services/types/limit filters), which must keep passing unchanged.

- [ ] **Step 5b: Cover `listItems` directly at the unit layer**

The RPC test above proves the behaviour end-to-end, but a failure there cannot distinguish a bad
mapping from a bad RPC wiring. Add a direct test to
`packages/gateway/src/index/local-index.test.ts`, using the existing `makeIndex()` and `makeItem()`
helpers:

```ts
describe("LocalIndex.listItems", () => {
  test("maps rows to IndexedItem and honours service/type/limit filters", () => {
    const idx = makeIndex();
    idx.upsert(makeItem({ id: "run-1", service: "github", itemType: "ci_run", name: "nightly" }));
    idx.upsert(makeItem({ id: "m-1", service: "slack", itemType: "message", name: "hello" }));

    const all = idx.listItems({ services: [], types: [], limit: 50 });
    expect(all).toHaveLength(2);
    // Mapped, not raw: camelCase fields and the composite key.
    const run = all.find((i) => i.id === "run-1");
    expect(run?.itemType).toBe("ci_run");
    expect(run?.name).toBe("nightly");
    expect(run?.indexPrimaryKey).toBe("github:run-1");

    const onlyGithub = idx.listItems({ services: ["github"], types: [], limit: 50 });
    expect(onlyGithub.map((i) => i.id)).toEqual(["run-1"]);

    const onlyMessages = idx.listItems({ services: [], types: ["message"], limit: 50 });
    expect(onlyMessages.map((i) => i.id)).toEqual(["m-1"]);

    expect(idx.listItems({ services: [], types: [], limit: 1 })).toHaveLength(1);
  });
});
```

Run it:

```bash
cd C:/gitrep/Nimbus && bun test packages/gateway/src/index/local-index.test.ts
```

Expected: PASS.

- [ ] **Step 6: Update the CLI's local result type**

`packages/cli/src/commands/query.ts:73-79` declares the response shape inline. It prints rows through
a generic table printer, so no field-specific logic changes — only the type annotation:

```ts
// Before: c.call<{ items: Record<string, unknown>[]; meta: { limit: number; total: number } }>(
  const r = await withGatewayIpc((c) =>
    c.call<{
      items: Array<Record<string, unknown>>;
      meta: { limit: number; total: number };
    }>("index.queryItems", params),
  );
  printRows(r.items, wantJson, pretty);
```

The rows are now camelCase `NimbusItem` fields, so `nimbus query`'s columns change accordingly.
`nimbus query --sql` / `index.querySql` still returns raw rows for genuine SQL access.

- [ ] **Step 6b: Update the CLI test fixture, which encodes the old wire shape**

`packages/cli/src/commands/query.test.ts:106-124` mocks the IPC client with a **raw V3 row** and
asserts the raw key reaches stdout:

```ts
// Current — the shape the gateway no longer produces:
      items: [{ title: "foo", service: "github", type: "pr", modified_at: 1700000000000 }],
// ...
    expect(out.stdout).toContain('"title": "foo"');
```

Because the IPC is mocked, this test keeps **passing** either way — which is exactly why it must be
fixed deliberately. Left alone it documents a wire contract that no longer exists and would not
catch a regression. Update the fixture and the assertion to the mapped shape:

```ts
      items: [
        {
          id: "pr-1",
          indexPrimaryKey: "github:pr-1",
          service: "github",
          itemType: "pr",
          name: "foo",
          modifiedAt: 1700000000000,
        },
      ],
// ...
    expect(out.stdout).toContain('"name": "foo"');
```

Leave the assertion at line ~243 (`'[{"id":7}]'`) alone — that test covers `index.querySql`, which
still returns raw rows.

- [ ] **Step 7: Run the full gate**

```bash
cd C:/gitrep/Nimbus && bun run preflight:fast && bun test packages/gateway/src/ipc/ packages/gateway/src/index/ packages/cli/src/commands/
```

Expected: all PASS.

- [ ] **Step 8: Commit and open the PR**

```bash
cd C:/gitrep/Nimbus
git add packages/gateway/src/index/local-index.ts packages/gateway/src/index/local-index.test.ts \
        packages/gateway/src/ipc/diagnostics-rpc.ts packages/gateway/src/ipc/diagnostics-rpc.test.ts \
        packages/cli/src/commands/query.ts packages/cli/src/commands/query.test.ts
git commit -m "fix: index.queryItems returns NimbusItem instead of raw SQLite rows

rpcIndexQueryItems returned raw \`SELECT * FROM item\` rows, so the unified V3
column names (type, title, external_id, ...) leaked over IPC while every other
read path mapped rows through rowToItem. Downstream clients had to guess the
wire shape, and nimbus-vscode guessed wrong.

Adds LocalIndex.listItems(), which owns the list SQL and the mapping together,
and returns IndexedItem = NimbusItem & { indexPrimaryKey }. indexPrimaryKey
carries the service:external_id composite key, which the bare NimbusItem.id
(external_id) does not uniquely provide across services.

Adds a structural test asserting no response key is snake_case, so a regression
to raw-row passthrough fails however it is written."
gh pr create --title "fix: index.queryItems returns NimbusItem instead of raw SQLite rows"
```

---

## Task 3: Client — validate the new shape

**Repo:** `nimbus-client` (`C:/gitrep/nimbus-client`). **Depends on:** Tasks 1–2 **merged**.

> A prior attempt at this task exists on the branch `feat/validate-query-items` (commit `cc15791`).
> It maps `item_type` and `name`, which are not on the wire, and must **not** be reused. Start from
> a fresh branch off `origin/main`.

**Files:**

- Modify: `src/validate.ts` (`validateQueryItems`, ~line 103)
- Modify: `src/nimbus-client.ts` (`IndexedItem` type; interface line ~180; impl line ~263)
- Modify: `src/mock-client.ts:102-111`
- Modify: `src/index.ts` (barrel re-exports)
- Test: `test/nimbus-client.test.ts`, `test/validate.test.ts`

**Interfaces:**

- Consumes: `NimbusItem` from `@nimbus-dev/sdk`; the gateway wire shape from Task 2.
- Produces:
  - `export type IndexedItem = NimbusItem & { indexPrimaryKey: string }` from `nimbus-client.ts`.
  - `validateQueryItems(method: string, v: unknown): { items: IndexedItem[]; meta: { limit: number; total: number } }`.
  - `NimbusClientLike.queryItems(...)` returns `Promise<{ items: IndexedItem[]; meta: { limit: number; total: number } }>`.
  - The barrel re-exports `IndexedItem` **and** `NimbusItem` — nimbus-vscode depends only on
    `@nimbus-dev/client`, not on the SDK, so it cannot import `NimbusItem` any other way.

- [ ] **Step 1: Create the branch**

```bash
cd C:/gitrep/nimbus-client && git fetch origin && git switch -c feat/validate-index-items origin/main && bun install
```

- [ ] **Step 2: Write the failing tests**

Add to `test/nimbus-client.test.ts` as a new top-level `describe` after the existing
`describe("NimbusClient method dispatch", ...)` block closes. Use that file's `FakeIpc` class
(line 8) and `makeClient(ipc)` helper (line 38). Add `IpcResponseError` to the imports:

```ts
import { IpcResponseError } from "../src/validate.ts";
```

```ts
describe("queryItems result validation", () => {
  test("returns the gateway's camelCase item verbatim", async () => {
    const ipc = new FakeIpc([
      {
        items: [
          {
            id: "run-1",
            indexPrimaryKey: "github:run-1",
            service: "github",
            itemType: "ci_run",
            name: "nightly build",
            modifiedAt: 1_700_000_000_000,
            createdAt: 1_600_000_000_000,
            url: "https://example.test/r/1",
            mimeType: "application/json",
            sizeBytes: 12,
            parentId: "github:wf-9",
          },
        ],
        meta: { limit: 50, total: 1 },
      },
    ]);

    const { items, meta } = await makeClient(ipc).queryItems({ limit: 50 });

    expect(items[0]).toEqual({
      id: "run-1",
      indexPrimaryKey: "github:run-1",
      service: "github",
      itemType: "ci_run",
      name: "nightly build",
      mimeType: "application/json",
      sizeBytes: 12,
      createdAt: 1_600_000_000_000,
      modifiedAt: 1_700_000_000_000,
      url: "https://example.test/r/1",
      parentId: "github:wf-9",
    });
    expect(meta).toEqual({ limit: 50, total: 1 });
  });

  test("omits optional fields the item does not carry", async () => {
    const ipc = new FakeIpc([
      {
        items: [{ id: "x1", indexPrimaryKey: "x:x1", service: "x", itemType: "file", name: "n" }],
        meta: { limit: 1, total: 1 },
      },
    ]);
    const { items } = await makeClient(ipc).queryItems({});
    expect(items[0]).toEqual({
      id: "x1",
      indexPrimaryKey: "x:x1",
      service: "x",
      itemType: "file",
      name: "n",
    });
  });

  test("preserves an item type this client version does not know", async () => {
    const ipc = new FakeIpc([
      {
        items: [
          { id: "x1", indexPrimaryKey: "x:x1", service: "x", itemType: "dora_metric", name: "n" },
        ],
        meta: { limit: 1, total: 1 },
      },
    ]);
    const { items } = await makeClient(ipc).queryItems({});
    expect(items[0]?.itemType).toBe("dora_metric");
  });

  test("throws IpcResponseError when items is not an array", async () => {
    const ipc = new FakeIpc([{ items: "nope", meta: { limit: 0, total: 0 } }]);
    await expect(makeClient(ipc).queryItems({})).rejects.toBeInstanceOf(IpcResponseError);
  });

  test("throws IpcResponseError when indexPrimaryKey is missing", async () => {
    const ipc = new FakeIpc([
      {
        items: [{ id: "x1", service: "x", itemType: "file", name: "n" }],
        meta: { limit: 1, total: 1 },
      },
    ]);
    await expect(makeClient(ipc).queryItems({})).rejects.toBeInstanceOf(IpcResponseError);
  });

  test("throws IpcResponseError on a snake_case row from an old gateway", async () => {
    // Version skew: client 0.6.0 against a pre-Task-2 gateway. Failing loudly
    // is intended — the alternative is silently undefined fields.
    const ipc = new FakeIpc([
      {
        items: [{ id: "github:run-1", service: "github", type: "ci_run", title: "nightly" }],
        meta: { limit: 1, total: 1 },
      },
    ]);
    await expect(makeClient(ipc).queryItems({})).rejects.toBeInstanceOf(IpcResponseError);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd C:/gitrep/nimbus-client && bun test test/nimbus-client.test.ts
```

Expected: FAIL. The current `validateQueryItems` only asserts each element is an object, so the
`indexPrimaryKey`-missing and snake_case cases resolve instead of rejecting.

- [ ] **Step 4: Replace the validator**

In `src/validate.ts`, add `IndexedItem` to the **existing** type-import block from
`./nimbus-client.js` (which already pulls in `EgressHead`, `RankedSearchItem`, etc.) — do not add a
second import line for the same module, which lint rejects:

```ts
import type {
  EgressCompleteness,
  EgressHead,
  EgressListResult,
  EgressProveWindowResult,
  EgressReceipt,
  EgressRow,
  EgressVerifyResult,
  IndexedItem,
  RankedSearchItem,
  SessionTranscript,
} from "./nimbus-client.js";
```

This is a type-only import, so the `validate.ts` ↔ `nimbus-client.ts` cycle is erased at compile
time — the same pattern the existing entries already use.

Add these two helpers next to the existing `str` / `num` / `bool` / `arr` helpers (after `arr`,
line ~64):

```ts
function optStr(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}

function optNum(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
```

Replace the whole existing `validateQueryItems` function (line ~103) with:

```ts
/**
 * The gateway maps V3 rows through rowToItem before answering
 * index.queryItems, so the wire is already camelCase NimbusItem plus
 * indexPrimaryKey. This validates that shape — it does NOT translate one.
 * Key translation belongs in the gateway, where the mapping already exists;
 * a second copy here is what drifted last time.
 *
 * `itemType` passes through verbatim: ItemType is an open enum, and rewriting
 * an unrecognised type would be data corruption.
 */
export function validateQueryItems(
  method: string,
  v: unknown,
): { items: IndexedItem[]; meta: { limit: number; total: number } } {
  const o = record(method, v);

  const items = arr(method, o["items"]).map((raw): IndexedItem => {
    const r = record(method, raw);
    const item: IndexedItem = {
      id: str(method, r, "id"),
      indexPrimaryKey: str(method, r, "indexPrimaryKey"),
      service: str(method, r, "service"),
      itemType: str(method, r, "itemType"),
      name: str(method, r, "name"),
    };
    const mimeType = optStr(r, "mimeType");
    if (mimeType !== undefined) item.mimeType = mimeType;
    const sizeBytes = optNum(r, "sizeBytes");
    if (sizeBytes !== undefined) item.sizeBytes = sizeBytes;
    const createdAt = optNum(r, "createdAt");
    if (createdAt !== undefined) item.createdAt = createdAt;
    const modifiedAt = optNum(r, "modifiedAt");
    if (modifiedAt !== undefined) item.modifiedAt = modifiedAt;
    const url = optStr(r, "url");
    if (url !== undefined) item.url = url;
    const parentId = optStr(r, "parentId");
    if (parentId !== undefined) item.parentId = parentId;
    return item;
  });

  const meta = record(method, o["meta"]);
  return { items, meta: { limit: num(method, meta, "limit"), total: num(method, meta, "total") } };
}
```

- [ ] **Step 5: Add the type and update the client**

In `src/nimbus-client.ts`, add the exported type next to `RankedSearchItem` (line ~50):

```ts
/**
 * An indexed item as `index.queryItems` returns it: a NimbusItem plus the
 * gateway's composite index key (`service:external_id`). `NimbusItem.id` is the
 * bare external id and is not unique across services, so use `indexPrimaryKey`
 * for identity. Mirrors `RankedSearchItem`.
 */
export type IndexedItem = NimbusItem & { indexPrimaryKey: string };
```

Change **both** the `NimbusClientLike` signature (line ~180) and the `NimbusClient` implementation
(line ~269) return types from
`Promise<{ items: Record<string, unknown>[]; meta: { limit: number; total: number } }>` to:

```ts
  }): Promise<{ items: IndexedItem[]; meta: { limit: number; total: number } }>;
```

The implementation body is unchanged — it already routes through `validateQueryItems`.

- [ ] **Step 6: Update the mock for parity**

In `src/mock-client.ts:102-111`, change the return type and delete the cast:

```ts
  async queryItems(_params: {
    services?: string[];
    types?: string[];
    sinceMs?: number;
    untilMs?: number;
    limit?: number;
  }): Promise<{ items: IndexedItem[]; meta: { limit: number; total: number } }> {
    const items = this.fixtures.items ?? [];
    return { items, meta: { limit: items.length, total: items.length } };
  }
```

Change `MockClientFixtures.items` (line ~24) from `NimbusItem[]` to `IndexedItem[]`, and import
`IndexedItem` from `./nimbus-client.js`. The `as unknown as` cast is deleted — it existed only
because the real type was wrong.

- [ ] **Step 7: Re-export from the barrel**

In `src/index.ts`, add `IndexedItem` to the existing `./nimbus-client.js` export block (keep the
list alphabetical), and re-export `NimbusItem`, which nimbus-vscode needs and cannot otherwise
reach:

```ts
export type { NimbusItem } from "@nimbus-dev/sdk";
```

- [ ] **Step 8: Fix the pre-existing validator test**

`test/validate.test.ts` has a test `"validateQueryItems accepts items + meta"` asserting that
`{ items: [{ a: 1 }], meta: {...} }` round-trips unchanged. That test encodes the old
no-per-field-validation behaviour and will now fail. Replace it with:

```ts
  test("validateQueryItems accepts a camelCase indexed item", () => {
    expect(
      validateQueryItems("m", {
        items: [
          { id: "s1", indexPrimaryKey: "s:s1", service: "s", itemType: "alert", name: "n" },
        ],
        meta: { limit: 1, total: 1 },
      }),
    ).toEqual({
      items: [{ id: "s1", indexPrimaryKey: "s:s1", service: "s", itemType: "alert", name: "n" }],
      meta: { limit: 1, total: 1 },
    });
  });

  test("validateQueryItems rejects a row that is not an indexed item", () => {
    expect(() =>
      validateQueryItems("m", { items: [{ a: 1 }], meta: { limit: 1, total: 1 } }),
    ).toThrow(IpcResponseError);
  });
```

`IpcResponseError` is already imported in that file (line 4).

- [ ] **Step 9: Run the tests and the gate**

```bash
cd C:/gitrep/nimbus-client && bun test && bun run typecheck && bun run lint
```

Expected: all PASS. `test/mock-client.test.ts` exercises `queryItems` at lines 6 and 64 — if its
fixtures lack `indexPrimaryKey`, add it; the mock returns fixtures directly without validating, so
the change is type-level only.

- [ ] **Step 10: Commit**

```bash
cd C:/gitrep/nimbus-client
git add src/validate.ts src/nimbus-client.ts src/mock-client.ts src/index.ts \
        test/nimbus-client.test.ts test/validate.test.ts
git commit -m "feat!: queryItems returns validated IndexedItem[] instead of raw rows

queryItems had only a shape-level validator: it asserted each element was an
object and returned the gateway's rows as Record<string, unknown>[], so nothing
caught a wire change. nimbus-vscode read camelCase keys against raw snake_case
V3 columns and silently got undefined on every row.

The gateway now maps rows through rowToItem before answering, so this validates
that shape rather than translating it — key translation stays in the gateway
where the mapping already exists. Adds IndexedItem (NimbusItem plus the
service:external_id composite key) and re-exports NimbusItem, which downstream
consumers cannot otherwise reach without depending on the SDK directly.

Requires a gateway carrying the matching queryItems change; an older gateway
now fails loudly with IpcResponseError instead of yielding undefined fields."
```

---

## Task 4: Client — the conformance gate

**Repo:** `nimbus-client`. **Depends on:** Task 3, and a **running gateway that carries Tasks 1–2**.

This is the task that makes Stage 0 durable. Without it the next shape drift is silent again.

**Files:**

- Create: `test/fixtures/query-items-response.json`
- Create: `test/fixtures/README.md`
- Create: `test/query-items-conformance.test.ts`

**Interfaces:**

- Consumes: `validateQueryItems` (Task 3), `KNOWN_ITEM_TYPES` from `@nimbus-dev/sdk`.
- Produces: no runtime exports — a CI gate only.

- [ ] **Step 1: Capture the golden response from a real gateway**

With a gateway built from Tasks 1–2 running against an index containing at least one ops item:

```bash
cd C:/gitrep/Nimbus && nimbus query --limit 5 --json
```

Save the response verbatim to `C:/gitrep/nimbus-client/test/fixtures/query-items-response.json` in
the shape the IPC returns:

```json
{ "items": [ ... ], "meta": { "limit": 5, "total": 5 } }
```

**Do not hand-write this file.** The previous attempt at this stage passed its own tests while being
completely wrong, precisely because its fixtures were invented in the same shape as the code under
test. Redact values if needed, but never rename a key or change a type.

Record provenance in `test/fixtures/README.md`:

```markdown
# Fixtures

## `query-items-response.json`

Captured verbatim from a live gateway's `index.queryItems` response.

- Captured: 2026-07-20
- Gateway: <version from `nimbus status`>
- Method: `nimbus query --limit 5 --json`

Values may be redacted; **keys and types are never edited**. When the conformance
test fails, re-capture from a current gateway and fix the validator to match —
do not edit this file to make the test pass.
```

- [ ] **Step 2: Write the conformance test**

Create `test/query-items-conformance.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { KNOWN_ITEM_TYPES } from "@nimbus-dev/sdk";
import golden from "./fixtures/query-items-response.json" with { type: "json" };
import { validateQueryItems } from "../src/validate.ts";

/**
 * The conformance gate.
 *
 * `validateQueryItems` hand-transcribes the gateway's wire contract; nothing
 * links the two at compile time. This pins it to a response a real gateway
 * actually produced, so a shape change upstream fails here instead of silently
 * yielding undefined fields in every downstream client.
 *
 * When this fails: re-capture the fixture from a current gateway, then fix the
 * validator to match. Do not edit the fixture by hand to make it pass.
 */
describe("index.queryItems conformance", () => {
  test("the golden response validates", () => {
    expect(() => validateQueryItems("index.queryItems", golden)).not.toThrow();
  });

  test("no required field comes back undefined", () => {
    const { items } = validateQueryItems("index.queryItems", golden);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.id).toBeTruthy();
      expect(item.indexPrimaryKey).toBeTruthy();
      expect(item.service).toBeTruthy();
      expect(item.name).toBeTruthy();
      expect(item.itemType).toBeTruthy();
    }
  });

  test("the wire is camelCase — the gateway maps rows, it does not ship columns", () => {
    const first = (golden as { items: Record<string, unknown>[] }).items[0];
    expect(first).toBeDefined();
    const keys = Object.keys(first ?? {});
    expect(keys).toContain("itemType");
    expect(keys.filter((k) => k.includes("_"))).toEqual([]);
  });

  test("indexPrimaryKey is the composite key, not the bare id", () => {
    const { items } = validateQueryItems("index.queryItems", golden);
    for (const item of items) {
      expect(item.indexPrimaryKey).toBe(`${item.service}:${item.id}`);
    }
  });

  test("every itemType in the fixture is one this SDK knows", () => {
    const { items } = validateQueryItems("index.queryItems", golden);
    const unknown = items
      .map((i) => i.itemType)
      .filter((t) => !(KNOWN_ITEM_TYPES as readonly string[]).includes(t));
    // Not a failure of the open enum — a signal the SDK vocabulary is stale.
    expect(unknown).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it**

```bash
cd C:/gitrep/nimbus-client && bun test test/query-items-conformance.test.ts
```

Expected: PASS. If the last test fails, the gateway emits a type absent from
`nimbus-sdk/src/item-types.ts` — add it there with its test, cut an SDK release, and bump. **That is
the gate working.**

If `indexPrimaryKey is the composite key` fails, check whether the captured `id` already carried the
`service:` prefix — `itemPrimaryKey()` does not double-prefix. Relax that assertion to
`expect(item.indexPrimaryKey.endsWith(item.id)).toBe(true)` only if the fixture proves it necessary.

- [ ] **Step 4: Prove the gate actually catches drift**

Temporarily rename `itemType` to `item_type` in one fixture item and re-run:

```bash
cd C:/gitrep/nimbus-client && bun test test/query-items-conformance.test.ts
```

Expected: FAIL on both `the golden response validates` and the camelCase test. Revert the fixture
and confirm it passes again. **A gate never observed failing is not a gate** — record both outputs.

- [ ] **Step 5: Run the full gate and commit**

```bash
cd C:/gitrep/nimbus-client && bun test && bun run typecheck && bun run lint
git add test/fixtures/query-items-response.json test/fixtures/README.md \
        test/query-items-conformance.test.ts
git commit -m "test: pin index.queryItems to a golden gateway response

validateQueryItems hand-transcribes the wire contract with nothing linking it to
the gateway at compile time — the failure mode that produced the original bug.
This pins it to a response a real gateway produced, so an upstream shape change
fails in CI instead of yielding undefined fields in every downstream client.

Verified the gate fails when a fixture key is renamed to snake_case."
```

- [ ] **Step 6: Open the PR, merge, and confirm the publish**

```bash
cd C:/gitrep/nimbus-client
gh pr create --title "feat!: queryItems returns validated IndexedItem[] instead of raw rows"
```

After the release PR merges, confirm the publish and its provenance — do not trust the job
conclusion alone:

```bash
npm view @nimbus-dev/client version    # expect 0.6.0
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://registry.npmjs.org/-/npm/v1/attestations/@nimbus-dev%2fclient@0.6.0"   # expect 200
```

The attestation endpoint lags the tarball by a few seconds; a 404 immediately after publish is
propagation, not a provenance failure. Re-check before concluding anything.

---

## Task 5: VS Code — delete the private mirror

**Repo:** `nimbus-vscode` (`C:/gitrep/nimbus-vscode`). **Depends on:** Task 4 published.

**Files:**

- Modify: `package.json` (dependency bump)
- Modify: `src/sidebar/index.ts:5` (union), `:23-30` (`ITEM_TYPES` set), `:31-38` (`ITEM_TYPE_ICONS`),
  `:66-93` (`parseIndexRow`), `:114-116` (`iconForItemType`)
- Test: `test/unit/index.test.ts` — **two existing tests will break and must be updated**, see Step 2

**Interfaces:**

- Consumes: `NimbusItem`, `IndexedItem` from `@nimbus-dev/client@0.6.0` (Task 3).
- Produces: `IndexItem` keeps its name and shape, so the tree building is unaffected.
  `iconForItemType` keeps its name and call site but changes signature from
  `(itemType: IndexItem["itemType"]) => string` to `(itemType: string | undefined) => string`.

> **Note on the existing code:** `iconForItemType` **already exists** at `src/sidebar/index.ts:114`
> and is already called from `itemToRow` in that same file (line ~143) — *not* from
> `index-view.ts`. This task modifies it; it does not create it. `itemToRow` also already sets
> `description: item.itemType`, so once types stop being dropped, the type text appears in the tree
> with no further change.

- [ ] **Step 1: Bump the client**

```bash
cd C:/gitrep/nimbus-vscode && bun add @nimbus-dev/client@^0.6.0 && bun run typecheck
```

Expected: typecheck may FAIL in `src/extension.ts:454`, where `queryItems` now returns
`IndexedItem[]` rather than `Record<string, unknown>[]`. **That failure is the compile error that
should have existed all along** — the contract working.

**If `0.6.0` is not on npm yet**, develop against a locally packed build rather than waiting on the
release pipeline. Use a packed tarball, not `npm link` / `yalc`: this repo is Bun-based, and a
symlinked dependency would make `check-bundle` and `check-vsix-contents` validate a tree that is not
what actually ships. This mirrors `nimbus-client`'s own `scripts/verify-against-local-sdk.ts`.

```bash
cd C:/gitrep/nimbus-client && bun run build && bun pm pack --destination "$TEMP"
cd C:/gitrep/nimbus-vscode && bun add "file:$TEMP/nimbus-dev-client-0.6.0.tgz" && bun run typecheck
```

`bun pm pack` flattens the scoped name: `@nimbus-dev/client` → `nimbus-dev-client-<version>.tgz`.

**Before committing, restore the real dependency** — a manifest pointing at a local tarball must
never be merged:

```bash
cd C:/gitrep/nimbus-vscode && bun add @nimbus-dev/client@^0.6.0
```

Task 5 still merges only after `0.6.0` is genuinely published; the tarball unblocks development, not
the merge.

- [ ] **Step 2: Update the two tests that encode the bug, then add the new ones**

`test/unit/index.test.ts` contains two tests that assert the **current broken behaviour**. They will
fail after this task, and that is correct — update them first so the suite states the intended
contract.

Replace `"name falls back to id; unknown itemType is dropped"` (line ~39):

```ts
  test("name falls back to id; an unknown itemType is preserved, not dropped", () => {
    const item = parseIndexRow({ id: "i2", itemType: "wormhole" });
    expect(item?.name).toBe("i2");
    // Was: expect(item?.itemType).toBeUndefined() — that assertion encoded the
    // bug. The vocabulary is open; dropping an unrecognised type is data loss.
    expect(item?.itemType).toBe("wormhole");
  });
```

Replace `"maps each enum value and defaults to file"` (line ~71). The old version asserts
`iconForItemType("task")` → `"checklist"` and `iconForItemType(undefined)` → `"file"`; `task` is not
a type the gateway emits, and `file` is no longer an acceptable fallback:

```ts
  test("maps the emitted types and falls back without claiming a type", () => {
    expect(iconForItemType("email")).toBe("mail");
    expect(iconForItemType("event")).toBe("calendar");
    expect(iconForItemType("photo")).toBe("device-camera");
    expect(iconForItemType("folder")).toBe("folder");
    expect(iconForItemType("ci_run")).toBe("play-circle");
    expect(iconForItemType("pr")).toBe("git-pull-request");
  });
```

Then add these new tests:

```ts
test("parseIndexRow keeps an ops item type", () => {
  const item = parseIndexRow({
    id: "run-1",
    service: "github",
    itemType: "ci_run",
    name: "nightly build",
    modifiedAt: 1_700_000_000_000,
  });
  expect(item?.itemType).toBe("ci_run");
  expect(item?.updatedMs).toBe(1_700_000_000_000);
});

test("parseIndexRow keeps an item type this extension build does not know", () => {
  const item = parseIndexRow({
    id: "x1",
    service: "x",
    itemType: "dora_metric",
    name: "n",
  });
  expect(item?.itemType).toBe("dora_metric");
});

test("iconForItemType falls back without claiming the item is a file", () => {
  expect(iconForItemType("ci_run")).toBe("play-circle");
  expect(iconForItemType("totally_new_type")).toBe("symbol-misc");
  expect(iconForItemType(undefined)).toBe("symbol-misc");
  // The fallback must never be a real item type's icon.
  expect(iconForItemType("totally_new_type")).not.toBe("file");
  expect(iconForItemType("totally_new_type")).not.toBe("folder");
});
```

`iconForItemType` is already imported in that file (it has an existing `describe` block for it), so
no import change is needed.

Note that `parseIndexRow({ id: "x1", ... })` in the new tests omits `indexPrimaryKey`; Step 6 makes
the parser prefer it when present and fall back to `id`, so both forms must work.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd C:/gitrep/nimbus-vscode && bun run test
```

Expected: FAIL — `itemType` is `undefined` for `ci_run` and `dora_metric` because `ITEM_TYPES` does
not contain them, and `iconForItemType("ci_run")` returns `undefined` because `ITEM_TYPE_ICONS` has
no such key. Record the output.

- [ ] **Step 4: Delete the private mirror**

In `src/sidebar/index.ts`, delete the local union (line 5) and the `ITEM_TYPES` set (lines 23-30),
and re-source the type from the contract:

```ts
import type { NimbusItem } from "@nimbus-dev/client";

// Sourced from the SDK contract via the client — do NOT re-declare it here. A
// private mirror of this vocabulary is what made this view render no types for
// its entire life.
export type IndexItemType = NimbusItem["itemType"];
```

In `parseIndexRow`, accept any non-empty string — the enum is open and the client has already
validated the row:

```ts
  const itemType = asNonEmptyString(rec["itemType"]);
  if (itemType !== undefined) item.itemType = itemType;
```

- [ ] **Step 5: Make the icon lookup total**

`ITEM_TYPE_ICONS` is declared `Record<IndexItemType, string>`, total over the old closed union, so
it no longer typechecks once the union opens. Replace the map (lines 31-38) and **modify** the
existing `iconForItemType` at line 114 — it already exists and is already called from `itemToRow`
in this same file, so its name and call site do not change:

```ts
// Covers the types a live index actually contains plus the common ops types.
// Deliberately NOT all 68 emitted types — unmapped types take the fallback.
const ITEM_TYPE_ICONS: Readonly<Record<string, string>> = {
  file: "file",
  folder: "folder",
  email: "mail",
  ci_run: "play-circle",
  pr: "git-pull-request",
  issue: "issues",
  web_clip: "link",
  deployment: "rocket",
  incident: "flame",
  message: "comment",
  page: "book",
  event: "calendar",
  photo: "device-camera",
};

/**
 * Icon for an item type, falling back for anything unmapped.
 *
 * The fallback is `symbol-misc` and must never be `file` or `folder` — those
 * are real item types, so reusing them would assert a type the row does not
 * have. The previous implementation returned "file" for an absent type, which
 * did exactly that.
 */
export function iconForItemType(itemType: string | undefined): string {
  return (itemType !== undefined ? ITEM_TYPE_ICONS[itemType] : undefined) ?? "symbol-misc";
}
```

The `?? "symbol-misc"` is load-bearing: indexing a `Record<string, string>` yields
`string | undefined` under `noUncheckedIndexedAccess`, whereas the old total `Record<IndexItemType,
string>` yielded `string`. No call site changes — `itemToRow` (line ~143) already calls
`iconForItemType(item.itemType)`.

Verify every codicon id above against <https://microsoft.github.io/vscode-codicons/dist/codicon.html>
and substitute a real one for any that does not exist.

- [ ] **Step 6: Prefer the composite key for identity**

Where `parseIndexRow` builds `IndexItem.id`, prefer the gateway's composite key when present so rows
from different services cannot collide:

```ts
  const id = asNonEmptyString(rec["indexPrimaryKey"]) ?? asNonEmptyString(rec["id"]);
  if (id === undefined) return undefined;
```

- [ ] **Step 7: Run the full gate**

```bash
cd C:/gitrep/nimbus-vscode && bun run typecheck && bun run lint && bun run test \
  && bun run build && bun run check-bundle && bun run check-vsix-contents && bun run check-settings-docs
```

Expected: all PASS.

- [ ] **Step 8: Verify in a real editor**

Unit tests stub `vscode`, so this runtime/UI change needs Layer 2 verification. Package, install into
an isolated profile, and confirm the Index view renders:

```bash
cd C:/gitrep/nimbus-vscode
SP="$TEMP/claude/nimbus-stage0"
bunx vsce package --no-dependencies --out "$SP/nimbus.vsix"
code --extensions-dir "$SP/ext" --user-data-dir "$SP/udata" --install-extension "$SP/nimbus.vsix"
code --extensions-dir "$SP/ext" --user-data-dir "$SP/udata" .
```

With a gateway running, open the Nimbus sidebar → Index. Expected: items show type icons (a CI run
is a play-circle, not a file), and each service group is newest-first. **Record what you observed;
do not claim this step passed without running it.**

- [ ] **Step 9: Commit and open the PR**

```bash
cd C:/gitrep/nimbus-vscode
git switch -c fix/index-item-type-contract
git add package.json bun.lock src/sidebar/index.ts test/unit/index.test.ts
git commit -m "fix: Index view shows item types and sorts by time

The view kept a private six-value copy of the SDK's itemType union while the
gateway emits dozens, so every ci_run, pr and issue was dropped on the floor.
The rows it read were raw V3 columns, so itemType and updatedMs were undefined
on every row and name fell back to id: the Index view has never displayed a
type or ordered by recency.

@nimbus-dev/client 0.6.0 returns validated IndexedItem[], so the mirror is
deleted and the type comes from the contract. The icon map covers the types a
real index contains and falls back to symbol-misc — never to file or folder,
which are themselves real types."
gh pr create --title "fix: Index view shows item types and sorts by time"
```

---

## Stage 0 exit criteria

- [ ] No code path rewrites one item type into another:
      `grep -rn "itemTypeFromRowType" C:/gitrep/Nimbus/packages` is empty.
- [ ] `index.queryItems` emits no snake_case key, proven by a gateway test that has been **observed
      failing** against the old implementation.
- [ ] `index.queryItems` is validated per-field like every other client method.
- [ ] The conformance gate has been **observed failing** on a renamed fixture key (Task 4, Step 4).
- [ ] Exactly one declaration of the item-type vocabulary exists across all four repos:

  ```bash
  grep -rn '"ci_run"' C:/gitrep/nimbus-sdk/src C:/gitrep/nimbus-client/src \
    C:/gitrep/nimbus-vscode/src C:/gitrep/Nimbus/packages/gateway/src --include=*.ts \
    | grep -v test | grep -v connectors/
  ```

  Expected: hits only in `nimbus-sdk/src/item-types.ts`. Connector mappers legitimately contain the
  literal at their emit sites; typing those is a Stage 1 cleanup.
- [ ] The VS Code Index view renders type icons and sorts by recency, confirmed in a real Extension
      Development Host.

## Follow-ups (not Stage 0)

- `docs/schema-reference.md` still documents the legacy `items` table (`item_type`, `name`, …) that
  no longer exists. It misled the original plan and should be rewritten against the V3 `item`
  schema.
- `nimbus-sdk/src/item-types.ts` is still a hand-maintained list of 68 literals spread across ~70
  connector mapping modules. Stage 0 makes it testable, not generated. Revisit generation once the
  gate has caught its first real drift.
- Connector mappers still emit bare string literals into `upsertIndexedItem`. Typing that single
  writer's `type` field is a Stage 1 cleanup.
- Adding `body_preview` / `author_id` / `canonical_url` / `synced_at` / `pinned` to `NimbusItem` —
  deferred; widening an SDK type shared by every connector needs its own design.
- `querySql` still returns `Record<string, unknown>[]`. That is correct — arbitrary SQL has no fixed
  shape.
- `docs/release/manual-smoke-headless.md:168-169` says **`Nimbus: Search`** "executes
  `index.queryItems`" and lists results by "title". Both are wrong today, independently of this
  work: the command calls `index.searchRanked` (`nimbus-vscode/src/extension.ts:575`), and that
  method already returns camelCase `name`, not `title`. A pre-existing inaccuracy in a release
  smoke-test doc — worth correcting, but not caused by and not in scope for Stage 0.
  (`docs/SECURITY.md:186` also names `index.queryItems`, but only to classify it as a read-side LAN
  method; no shape dependency, no change needed.)
