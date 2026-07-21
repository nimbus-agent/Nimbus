# Stage 0 (Revised) — Seal the Narrow Waist Against the Real Schema

> **Status:** Design — approved in brainstorm (2026-07-20); ready for implementation plan.
> **Supersedes:** the schema assumptions in the original Stage 0 plan, `2026-07-19-stage-0-seal-the-narrow-waist.md` (added in [#776](https://github.com/nimbus-agent/Nimbus/pull/776), deleted when this revision landed — recover it from git history if needed). Task 1 of that plan is **done** — `@nimbus-dev/sdk@1.4.0` published 2026-07-20 with the corrected 68-type vocabulary. Tasks 2–5 are redesigned here.

## Why this revision exists

The original plan built its contract from the SQL comment in `docs/schema-reference.md`, which
documents a table named `items` with columns `item_type`, `name`, `mime_type`, `size_bytes`,
`created_at`, `parent_id`.

**That table does not exist.** A live `nimbus.db` contains exactly one item table — the unified V3
`item` table (`index/unified-item-v3-sql.ts:16`):

```text
id, service, type, external_id, title, body_preview, url,
canonical_url, modified_at, author_id, metadata, synced_at, pinned
```

Every downstream task in the original plan mapped `item_type` and `name`, which are not on the wire.
Implementing it as written produced a validator that rejected **all 546 rows** of a real index — a
hard failure replacing a silent one. That work was caught before merge and is discarded.

`docs/schema-reference.md` still describes the legacy `items` shape and is itself stale. Correcting
it is a follow-up, not part of this stage; the code, not the doc, is authoritative here.

## The three bugs, restated accurately

### Bug 1 — the gateway relabels most of the index

`index/local-index.ts:94` coerces any type outside a six-value list to `"file"`:

```ts
function itemTypeFromRowType(raw: string): NimbusItem["itemType"] { /* ... */ return "file"; }
```

Measured against a live 546-row index, this mislabels **300 rows — 55%**:

| type | rows | today |
| --- | --- | --- |
| `email` | 228 | preserved |
| `ci_run` | 214 | → `"file"` |
| `pr` | 79 | → `"file"` |
| `file` | 13 | preserved |
| `folder` | 5 | preserved |
| `issue` | 5 | → `"file"` |
| `web_clip` | 2 | → `"file"` |

This is worse than the original plan claimed, and it is data corruption rather than missing typing:
the true value is discarded, not merely untyped.

### Bug 2 — one IPC method bypasses the mapper

`rowToItem` (`local-index.ts:161`) is a correct, complete V3 → `NimbusItem` translator, and
`LocalIndex.search` / `searchRanked` both use it. `rpcIndexQueryItems`
(`ipc/diagnostics-rpc.ts:343`) does not — it returns raw `SELECT * FROM item` rows straight over
IPC, so snake_case V3 columns leak to every client.

This is the root cause of what the original plan filed as a client-side bug.

### Bug 3 — a dead view in VS Code

`nimbus-vscode/src/sidebar/index.ts` keeps a private six-value `itemType` mirror and reads camelCase
keys. Both were wrong against raw rows, so `itemType` and `updatedMs` were `undefined` on every row:
the Index view has never displayed a type or ordered by recency. It looked correct only because
`id`, `name`, `service` and `url` collide across both spellings — and `name` in fact does not exist
on the wire either (`title` does), so it fell back to `id`.

## Key correction: `NimbusItem` fits the V3 row exactly

An earlier reading claimed `createdAt`/`parentId` had no column and the mapping was lossy in both
directions. **That is wrong.** The gateway already round-trips the full `NimbusItem` through the
`metadata` JSON blob:

| `NimbusItem` | V3 storage |
| --- | --- |
| `id` | `external_id` |
| `service` | `service` |
| `itemType` | `type` |
| `name` | `title` |
| `modifiedAt` | `modified_at` |
| `url` | `url` |
| `mimeType`, `sizeBytes`, `parentId`, `createdAt` | packed into `metadata` JSON |
| `rawMeta` | remaining `metadata` keys |

Write side: `index/item-store.ts:123` `upsertNimbusItemIntoItemTable`.
Read side: `local-index.ts:161` `rowToItem` + `applyItemMetadataColumn` — the exact inverse.

The round-trip is complete and already tested. There is no lossy-fit problem to design around, which
is what makes the gateway the right seam.

**What `rowToItem` does not carry.** Five V3-only columns — `body_preview`, `author_id`,
`canonical_url`, `synced_at`, `pinned` — are **dropped entirely**, not preserved in `rawMeta`.
`rawMeta` is populated only from the `metadata` JSON column, so nothing recovers them. That is
deliberate for Stage 0: they are storage/provenance concerns rather than item identity, nothing
consumes them today, and `searchRanked` already surfaces `canonicalUrl` where ranking needs it.
Adding any of them to `NimbusItem` is a **deferred** decision — it would widen an MIT SDK type
shared by every connector, which deserves its own design rather than riding along here. `querySql`
remains available for ad-hoc access to the raw columns.

## Architecture

**One mapping seam, at the gateway.**

```text
V3 item row ──rowToItem()──> NimbusItem ──IPC (camelCase)──> client validates ──> vscode renders
             ^ the only translation in the system
```

`rpcIndexQueryItems` maps rows through `rowToItem` instead of shipping them raw. The wire type
becomes:

```ts
type IndexedItem = NimbusItem & { indexPrimaryKey: string };
```

`indexPrimaryKey` mirrors the established `RankedSearchItem` pattern
(`nimbus-client/src/nimbus-client.ts:50`). It is required because `rowToItem` sets
`id = external_id` — the bare external id, which is **not unique across services**. Today's raw rows
carry the `service:external_id` primary key in `id`; without `indexPrimaryKey` that information
would be silently lost and multi-service list views could collide.

**Is `r.id` guaranteed non-null?** By the schema, no: SQLite permits `NULL` in a `TEXT PRIMARY KEY`
column unless it is also declared `NOT NULL` (verified empirically — the insert is accepted). By the
code, yes: `upsertIndexedItem` (`item-store.ts:69`) is the sole writer and always computes
`id = itemPrimaryKey(service, externalId)`, which returns a template string. A `NULL` is therefore
reachable only through direct SQL against the file. The validator keeps `indexPrimaryKey` **required**
precisely so that case fails loudly as the corrupt row it is, rather than propagating a null key into
list rendering and dedup.

The client then *validates* this shape rather than translating it. No snake_case crosses the IPC
boundary, so there is no transcription to drift.

### Why not map in the client

The original plan's approach would reimplement `rowToItem` **and** `applyItemMetadataColumn` in a
second repo and language. Two hand-maintained copies of one mapping, with nothing linking them at
compile time, is precisely the failure that produced these bugs.

## Task A — Gateway (`Nimbus`)

1. **Delete `itemTypeFromRowType`** (`local-index.ts:94-105`); `rowToItem` passes `String(row.type)`
   through unchanged. The SDK's open `ItemType` accepts any string, so no cast is needed. This one
   deletion fixes `search`, `searchRanked` and `queryItems` at once, since all three funnel through
   `rowToItem`.
2. **Wire the IPC to the mapper** (`diagnostics-rpc.ts:343`):

   ```ts
   const rows = d.query(sql).all(...vals) as ItemRow[];
   const items = rows.map((r) => ({ ...rowToItem(r), indexPrimaryKey: r.id }));
   return { kind: "hit", value: { items, meta: { limit, total: items.length } } };
   ```

   `{ kind, value }` is the **internal** `DiagnosticsRpcOutcome` discriminator, not the wire shape.
   `ipc/server/dispatchers.ts:1224` unwraps it (`if (out.kind === "hit") return out.value`), so the
   JSON-RPC `result` a client sees is exactly `{ items, meta }` — unchanged from today apart from the
   row contents.

3. **Regression tests** (`local-index.test.ts`, `diagnostics-rpc.test.ts`):
   - every ops type (`ci_run`, `pr`, `issue`, `deployment`, `incident`) survives a round-trip;
   - an unknown type (`dora_metric`) is preserved verbatim, never coerced;
   - `queryItems` rows carry `indexPrimaryKey`;
   - **no response key is snake_case** — the structural gate that catches any future regression to
     raw-row passthrough.

**Out of scope for this task:** `index.querySql` keeps returning `Record<string, unknown>[]`.
Arbitrary SQL has no fixed shape; that is correct.

**User-visible change:** `nimbus query` (`cli/src/commands/query.ts:75`) prints its rows through a
generic table printer, so its columns change from raw DB columns to `NimbusItem` fields. This is an
improvement for a filtered listing command, and `index.querySql` remains available for raw SQL. Its
local result type must be updated from `Record<string, unknown>[]`.

`index.queryItems` is **not** in the Tauri `ALLOWED_METHODS` list, so invariant I7 is unaffected.

## Task B — Client `@nimbus-dev/client@0.6.0`

`validateQueryItems` becomes a real validator instead of a shape-checker:

- assert each row is a `NimbusItem` — `id`, `service`, `itemType`, `name` required strings — plus a
  required `indexPrimaryKey`;
- carry the optional fields through when present and well-typed;
- pass `itemType` through **verbatim**; rewriting an unrecognised type is data corruption;
- throw `IpcResponseError` on a malformed row.

No key translation and no `metadata`-JSON parsing: that logic stays in the gateway, where it already
exists and is tested.

`queryItems` returns `Promise<{ items: IndexedItem[]; meta: { limit: number; total: number } }>`.
`MockClient` matches via the shared interface, and its `as unknown as` cast is deleted — that cast
existed only because the real type was wrong.

**The conformance fixture must be captured from a live gateway IPC response** — not hand-written,
and not dumped from SQL. The discarded first attempt passed its own tests while being entirely wrong
precisely because its fixtures were invented in the same wrong shape as the code under test. The
fixture pins the gateway↔client contract so an upstream shape change fails in CI.

## Task C — nimbus-vscode

Once the gateway emits `NimbusItem`, `parseIndexRow`'s existing camelCase reads (`name`, `itemType`,
`modifiedAt`, `createdAt`) become correct with no change. What remains:

- delete the private `IndexItemType` union and the six-value `ITEM_TYPES` set — it filters out
  `ci_run`, `pr`, `issue` and every other real type;
- accept any non-empty string as `itemType`; the enum is open and the client has already validated;
- replace `ITEM_TYPE_ICONS` with a total lookup plus a fallback icon. Map exactly the seven types a
  live index actually contains (`email`, `ci_run`, `pr`, `file`, `folder`, `issue`, `web_clip`) plus
  the common ops types (`deployment`, `incident`, `message`, `page`, `event`), and let everything
  else hit the fallback — do **not** enumerate all 68. The fallback must be visually distinct from
  any mapped icon — `symbol-misc`, never `file` or `folder`, since those are themselves real item
  types and reusing them would assert a type the row does not have. Every codicon name must be
  verified against the published codicon list;
- prefer `indexPrimaryKey` as the tree-item key so multi-service rows cannot collide.

Requires `@nimbus-dev/client@0.6.0`, so it waits on Task B publishing.

Unit tests stub `vscode`, so this needs Layer 2 verification in a real Extension Development Host:
the Index view must show type icons and order each service group newest-first.

## Where drift gets caught

Three gates, one per boundary:

| Gate | Repo | Catches |
| --- | --- | --- |
| `KNOWN_ITEM_TYPES` pinned to live-observed types | `nimbus-sdk` | vocabulary going stale |
| `queryItems` emits no snake_case key | `Nimbus` | the IPC regressing to raw rows |
| conformance test vs. a captured live response | `nimbus-client` | gateway ↔ client divergence |

Each must be **observed failing** before it is trusted. A gate never seen red is not a gate — that
discipline is what caught the original plan's error one task before it shipped.

## Sequencing

```text
Task A (gateway) ──merge──> capture fixture ──> Task B (client) ──publish 0.6.0──> Task C (vscode)
```

**The tasks are strictly ordered.** Task B validates a shape that only exists once Task A ships, and
its conformance fixture must be captured from a gateway that already carries Task A — capturing it
earlier would pin the contract to the broken raw-row shape, which is exactly how the discarded first
attempt went wrong. Task B's *code* can be drafted while Task A is in review, but it must not merge
first: a client that validates the new shape against an old gateway rejects every row.

`nimbus-client`'s
`bun run verify:sdk` packs a sibling SDK checkout, so client work can proceed against a local build
if needed — though `@nimbus-dev/sdk@1.4.0` is already on npm, so this is no longer required.

## Non-goals

- **Generating the item-type list from connector sources.** The 68 values are bare string literals
  across ~70 mapping modules with no canonical enumeration. Stage 0 makes the list testable, not
  generated. Revisit once the gate has caught its first real drift.
- **Typing connector mappers at the write boundary.** `upsertIndexedItem` is the single writer and
  is already the chokepoint; typing its `type` field is a later cleanup.
- **Refreshing `docs/schema-reference.md`.** It documents the legacy `items` table and is stale, but
  correcting it is a documentation task with its own blast radius.
- **`querySql`.** Correctly untyped.
- **A static `structure-audit` rule forcing `rpcIndexQueryItems` through `rowToItem`.**
  `scripts/structure-audit/check-nimbus-invariants.ts` hosts only D10–D22, each bound to a numbered
  **security** invariant under the triple rule (wiring + docs entry + enforcement test). A
  data-mapping rule has no I-number and would dilute that system. It would also be weaker than what
  Task A already specifies: a static check asserts one function is *called*, which a rename or a
  second code path defeats, whereas the "no snake_case key in the response" runtime test asserts the
  *observable output* and catches every route back to raw rows.
- **Adding `body_preview` / `author_id` / `canonical_url` / `synced_at` / `pinned` to `NimbusItem`.**
  See the round-trip section — deferred, needs its own design.

## Risks

| Risk | Mitigation |
| --- | --- |
| IPC wire shape is a breaking change | Only two consumers: `nimbus query` (ships with the gateway) and nimbus-vscode (broken today regardless, fixed by Task C) |
| **Version skew** — `@nimbus-dev/client@0.6.0` against a pre-Task-A gateway rejects every row with `IpcResponseError` | Strict task ordering (Task A merges first); 0.6.0's release notes must state the minimum gateway version. The failure is contained, not fatal: `createIndexView` already catches and renders `errorRow("Failed to load index", err)` (`sidebar/index-view.ts`), so a skewed pair shows a named error instead of a crash — and a named error beats today's silently empty view. Validation stays whole-response fail-closed rather than per-row skipping: dropping bad rows and rendering the rest is itself a silent-corruption mode, which is the bug class this stage exists to remove |
| `rowToItem` drops V3-only columns (`body_preview`, `author_id`, `canonical_url`, `pinned`, `synced_at`) | Raw `queryItems` exposed them incidentally; nothing consumes them. `searchRanked` already surfaces `canonicalUrl` where it matters, and `querySql` remains for ad-hoc access |
| Icon map incomplete for 68 types | Total lookup with a generic fallback; an unmapped type renders a default icon rather than failing |
