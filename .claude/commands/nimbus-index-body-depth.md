---
name: nimbus-index-body-depth
description: >
  The full-body store and the connector index-depth chokepoint (schema V48 + V49):
  `item.body` / `item.body_preview` / `item.body_complete`, the `BODY_MAX_PROSE` 16,384 vs
  512 cap split, the two-arm `IndexedItemBodyInput` union, and
  `upsertIndexedItemForSync` — the single site every connector's item write must go
  through so `metadata_only` / `summary` / `full` is enforced on EVERY sync, not just at
  reindex. Also covers `nimbus index rebody` — which recovers indexed DEPTH, both missing
  bodies and connector metadata below `REBODY_REQUIRED_META_VERSION` (jira/linear ticket
  depth), plus its `--since` cold-start widening — the `index.rebody` IPC, and how to derive
  which connectors actually index a body (the list has drifted three times — derive it,
  do not trust a hand-written table). Use when adding or changing a connector's body
  indexing, adding an item type to `PROSE_HEAVY_TYPES`, registering a service's metadata
  version for recovery, touching
  `packages/gateway/src/index/{item-store,body-caps}.ts`, wiring a new depth-aware code
  path, or asking why an item's body is empty / truncated / not searchable.
---

# Full-Body Store & Index Depth

Two subsystems that ship as one contract: **what text an item stores** (V48) and **how much of
it a connector is allowed to store** (V49). Read both halves before touching either — the second
silently governs the first.

---

## The one rule

> **Every connector item write goes through `upsertIndexedItemForSync`
> (`packages/gateway/src/index/item-store.ts`). Never call `upsertIndexedItem` directly from a
> connector.**

`upsertIndexedItemForSync(ctx, row)` applies `applyDepth(ctx.depth, row)` and then schedules the
item's embedding. Calling the lower-level `upsertIndexedItem` from a connector bypasses depth
entirely.

This is not hypothetical. `connectors/obsidian-sync.ts` did exactly that until 2026-08-04, so an
Obsidian vault configured at `metadata_only` or `summary` kept indexing **full note bodies on
every sync**, regardless of the persisted setting. There is no static gate for this — it is a
code-review check.

---

## The storage shape (V48)

| Column | Meaning |
|---|---|
| `item.body` | The body text, clamped to the type's cap. Repointed `item_fts` off `body_preview`, so this is what keyword search matches. |
| `item.body_preview` | Always the first 512 code units of `body` (`BODY_PREVIEW_MAX`). **Derived — never written independently.** |
| `item.body_complete` | `1` only when the connector declared a body AND it was not clamped AND the connector did not flag `bodyTruncated`. |

Caps (`packages/gateway/src/index/body-caps.ts`):

- `BODY_MAX_PROSE = 16_384` — for item types in `PROSE_HEAVY_TYPES`.
- `BODY_MAX_DEFAULT = 512` — everything else. Unchanged from pre-V48 behaviour.
- `clampBody` clamps by **UTF-16 code unit** and drops a trailing lone high surrogate rather than
  splitting a pair — a bare `slice(0, max)` corrupts the value on its way into SQLite.

**Embeddings, the relationship graph, and the federation query gate all still read
`body_preview`, deliberately.** That is what keeps embedding egress flat across V48. If you point
any of the three at `body`, you have changed the egress profile — that is an invariant-adjacent
decision, not a refactor.

---

## The two-arm body input

```typescript
export type IndexedItemBodyInput =
  | { bodyPreview?: string; body?: undefined; bodyTruncated?: undefined }
  | { body: string;  bodyPreview?: undefined; bodyTruncated?: boolean };
```

Pick the arm by **what you actually fetched**, not by what is convenient:

- **`{ body }`** — "this is the whole body." Eligible for `body_complete = 1`.
- **`{ body, bodyTruncated: true }`** — "I fetched a body and I know it is not all of it." This is
  the only way to express incompleteness that the length-vs-cap test cannot catch, because such a
  body is usually well under the cap.
- **`{ bodyPreview }`** — "this is a snippet." Never claims completeness. `bodyTruncated` is
  deliberately unavailable on this arm.

**The trap:** a declared-full empty body (`body: ""`) is a *lie that type-checks*. Gmail and
Outlook both guard it explicitly — if no body part can be extracted they fall back to the
`bodyPreview` arm carrying the provider's snippet, so the row stays searchable at
`body_complete = 0` instead of claiming an empty message is complete.

---

## Depth enforcement (V49)

`SyncContext.depth` is a **required** field, resolved per sync run. `applyDepth` coerces the row
before it is written:

| Depth | Effect |
|---|---|
| `full` | Pass-through. |
| `summary` | Forces the `bodyPreview` arm — clamps to 512, never claims `body_complete`. |
| `metadata_only` | Sets `body: ""` **and** `bodyTruncated: true`. Both `body` and `body_preview` land empty. |

### Two non-obvious decisions, both load-bearing

**1. `metadata_only` passes `body: ""`, it does not omit the field.** `upsertIndexedItem` computes
`raw = row.body ?? row.bodyPreview ?? row.title`. Omitting the body would fall through that chain
to the **title** and store it as the body. The empty string is not nullish, so it wins the chain
and suppresses both columns. If you refactor this, keep the empty string.

**2. An unknown depth resolves to `full`, in exactly one direction.** `applyDepth` suppresses only
on the two depths that actually mean "hold text back"; anything else — including an
undefined depth — passes through. This matches `sync/scheduler.ts` `getDepthForService()`,
`connectors/health.ts`'s `sync_state` insert, and the V49 backfill. Routing an unknown depth into
the `summary` arm instead would clamp to 512 — the opposite of every other resolver.

### Why V49 resets `summary` → `full`

V21 declared `depth TEXT NOT NULL DEFAULT 'summary'`, so every row already held `'summary'`
materialised rather than NULL — and because depth was never enforced for bodies, a stored
`'summary'` expressed no intent and had always behaved as `'full'`. Enforcing depth without the
backfill would have silently truncated every existing index to 512 code units on its next sync.
`metadata_only` rows are deliberately untouched.

**Suppression covers vectors, not only stored text.** `SqliteEmbeddingPipeline.embedItem` deletes
the item's existing chunks for its model before its early return, so a downgrade to
`metadata_only` clears previously-computed embeddings (and, via the V30 dim-aware delete triggers,
their `vec_items_*` rows) along with the text. Without that, a suppressed item stayed searchable
as vectors after its text was gone.

---

## Which connectors actually index a body — derive it, don't trust a table

**This membership list has drifted three times. Do not hand-write it, and do not trust a
hand-written one you find.** Two independent axes get conflated:

1. **`PROSE_HEAVY_TYPES` membership** (`embedding/routing.ts`) — raises the cap from 512 to
   16,384 UTF-16 code units. **It does not mean the connector writes a body.** There are 23 members; only 14 write a
   full body.
2. **The connector actually passing the `{ body }` arm** — this is what puts text in the column.

A type in `PROSE_HEAVY_TYPES` whose connector still passes `bodyPreview` is *inert*: it has a
16,384-unit cap and nothing to put in it. `bitbucket:issue` is inert because Bitbucket emits only
`type: "pr"`; `github:pr` is capped at 512 because it was never added to `PROSE_HEAVY_TYPES`.

When you need the current membership, derive it from the tree and **count the result** — do not
eyeball it:

```bash
# Connector sites that declare a full body. Note the alternation: the object-shorthand
# `body,` form is a real call shape and a grep for `body:` alone MISSES it — that is the
# specific mistake behind two of the three drifts.
rg -n --glob '!*test*' -e '^\s*body\s*:' -e '^\s*body\s*,' -e '\.\.\.bodyInput' \
   packages/gateway/src/connectors/
```

Then cross-check each hit actually reaches `upsertIndexedItemForSync` — several matches are HTTP
request bodies (`_lib/http.ts`, `_lib/pagination.ts`), not item bodies.

The authoritative prose accounting lives in `docs/CHANGELOG.md` (the full-body-store entry and its
dated follow-ups), stated as *N full / N partial / N inert*, not as a bare connector count.

---

## `nimbus index rebody`

Backfills indexed **depth** for **already-indexed** items by clearing a connector's sync watermark
so the next sync re-fetches them. Bodies were the first kind of depth and are no longer the only
one.

- IPC `index.rebody` / `index.rebodyCancel`, params `{ service?, type?, limit?, sinceDays?,
  dryRun? }`; emits `index.rebodyProgress` / `index.rebodyDone` / `index.rebodyError`
  (`ipc/index-rebody-rpc.ts`, via `LongRunningJobRegistry`).
- **CLI-only.** Not renderer-exposed (I7) and `FORBIDDEN_OVER_LAN` (I5) — a strictly stronger case
  than `index.reembed`, which only recomputes local embeddings, whereas rebody drives real
  outbound third-party API traffic on the owner's quota.
- `--dry-run` reports per-service pending counts **and names the services it cannot
  improve** — a connector below `full` depth, or one that never declared a body, stays pending by
  design and saying so is the point.

**Two eligibility reasons, reported separately.** A row is recoverable when `body_complete = 0`
**OR** its service's `metadata.meta_v` is below the version that service must carry —
`REBODY_REQUIRED_META_VERSION` in `ipc/index-rebody-rpc.ts`, today `jira` and `linear` at
`TICKET_META_VERSION` (`connectors/ticket-depth.ts`). **This map is where a future metadata-depth
PR registers itself** — bump the version constant and add a row; the mechanism already exists.
The counts stay separate (`pending*` for bodies, `pendingMeta*` for metadata) and are deliberately
never summed: `pending` has meant `body_complete = 0` since V48, a silently widened meaning would
make every historical reading of it wrong, and a caller must be able to tell which kind of depth
is missing. A row can be behind on both — they are two questions about the same rows, not a
partition.

**Metadata is depth-invariant.** `applyDepth` strips body fields only; `metadata` passes through
at `metadata_only` too, which is correct by that depth's own name — it withholds item TEXT, not
the connector facts a consumer selects on. Locked by "metadata survives every index depth" in
`index/item-store.test.ts`.

**`--since <days>`** widens the **cold-start** window for one run via the optional
`SyncContext.historyFloorMs` (epoch ms). Opt-in per connector: jira and linear read it, every
other connector ignores it and keeps its own `initialSyncDepthDays`. An established cursor always
wins (it is more recent by construction), so it can never cause a re-walk on a later tick. The
scheduler holds the floor **in memory only** (`SyncScheduler.setHistoryFloor`) and consumes it on a
completed run — a restart drops it back to 30 days, and a failed run that advanced no watermark
keeps it for the retry.

**Deepening is not retroactive.** Lowering depth rewrites rows immediately; raising it reports
`0` items affected and applies to future syncs only. The gateway has no copy of discarded bodies.
Recovery is `nimbus connector sync <name> --full` or `nimbus index rebody --service <name>`.

**Per-connector limits worth knowing:** Confluence's rebody is bounded by its 30-day
`initialSyncDepthDays` window — it is not an account-wide backfill. A Notion page whose block
fetch errors is indexed title-only and the watermark still advances past it, so it is **not**
retried automatically; it is re-examined only on a later edit or a rebody.

---

## Checklist — adding body indexing to a connector

1. Add the `<service>:<type>` to `PROSE_HEAVY_TYPES` if it is paragraph-shaped (this only raises
   the cap — see above).
2. Pass the `{ body }` arm from the sync handler, via **`upsertIndexedItemForSync`**.
3. Guard the empty case — fall back to the `bodyPreview` arm rather than declaring `body: ""`.
4. Set `bodyTruncated: true` if you know the fetch was partial.
5. State the cost in the changelog entry if fetching the body changes the request shape
   (Gmail's `format=full` is the same quota cost but materially more bandwidth; Notion's is an
   extra API call per page).
6. Confirm depth still suppresses correctly at `metadata_only` and `summary` — the chokepoint
   handles it, which is exactly why step 2 is not optional.

## See also

- `nimbus-db-migrations` — authoring the migration (V48/V49 shape)
- `nimbus-embedding-routing` — `PROSE_HEAVY_TYPES` in its other role (384 vs 1536 dim routing)
- `nimbus-connector-authoring` — the sync handler contract
- `docs/cli-reference.md` § `nimbus connector reindex` — the user-facing depth contract
