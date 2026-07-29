---
name: nimbus-embedding-routing
description: >
  Hybrid 384/1536-dim embedding routing (Phase 5 T6 PR 3): `PROSE_HEAVY_TYPES`,
  `EMBEDDING_DIM_LOCAL`/`EMBEDDING_DIM_OPENAI`, the `RoutingEmbeddingPipeline` wrapper,
  dual-table search (`vec_items_384` + `vec_items_1536` via `vectorSearchChunksDual`),
  the V30 migration (1536-dim table + dim-aware delete triggers), the `nimbus index
  reembed` CLI + long-running IPC contract (`index.reembedProgress`), and the
  MiniLM-only fallback when `openai.api_key` is absent. Use when adding a connector
  item type and deciding its routing (MiniLM vs OpenAI), modifying `PROSE_HEAVY_TYPES`,
  changing embedding-table dims (e.g. a new V31 for a 3072-dim provider), writing search
  that must hit both tables, wiring a long-running IPC notification, or asking what
  `nimbus index reembed` does / whether it's cancellable.
---

# Nimbus Embedding Routing (T6 PR 3)

## Why This Skill Exists

Phase 5 T6 PR 3 split the embedding store into two dim-specific virtual tables (`vec_items_384` for MiniLM, `vec_items_1536` for `text-embedding-3-small`) and introduced a routing layer that dispatches each item to the right pipeline based on its `(service, type)`. Adding a connector that emits, say, `obsidian:obsidian_note` requires deciding whether the type is prose-heavy (route to OpenAI) or sparse-structured (stay on local MiniLM). Getting that decision wrong silently degrades recall for that type for every user who runs in hybrid mode.

This skill is the rule a contributor consults **before** touching `PROSE_HEAVY_TYPES`, the routing pipeline, the dual-search code, or the reembed flow.

## Where It Lives

| File | Role |
|---|---|
| [`packages/gateway/src/embedding/routing.ts`](../../packages/gateway/src/embedding/routing.ts) | `EMBEDDING_DIM_LOCAL` (384) + `EMBEDDING_DIM_OPENAI` (1536) + `SUPPORTED_EMBEDDING_DIMS` + `PROSE_HEAVY_TYPES` + `routingKey` + `isProseHeavy` |
| [`packages/gateway/src/embedding/routing-pipeline.ts`](../../packages/gateway/src/embedding/routing-pipeline.ts) | `RoutingEmbeddingPipeline` — wraps two `SqliteEmbeddingPipeline` instances and dispatches by `isProseHeavy(service, type)` |
| [`packages/gateway/src/embedding/create-routing-runtime.ts`](../../packages/gateway/src/embedding/create-routing-runtime.ts) | `tryCreateRoutingEmbeddingRuntime` — hybrid-mode factory; **falls back to MiniLM-only when `openai.api_key` is missing** so the gateway never refuses to start because of a missing optional secret |
| [`packages/gateway/src/embedding/embedding-readiness.ts`](../../packages/gateway/src/embedding/embedding-readiness.ts) | `EmbeddingReadiness` (`warming`/`ready`/`unavailable`/`disabled` + elapsed, model, dims, download progress, reason), `EmbeddingWarmingError`, `EMBEDDING_WARMING_RPC_CODE` (-32021), and the explicitly-named `embedQueryBestEffort` / `embedQueryDualBestEffort` degrade helpers (#928) |
| [`packages/gateway/src/embedding/deferred-runtime.ts`](../../packages/gateway/src/embedding/deferred-runtime.ts) | `createDeferredEmbeddingRuntime` — the bind-first wrapper. Returns SYNCHRONOUSLY so gateway assembly reaches `ipc.start()` without awaiting a model fetch; while warming it THROWS `EmbeddingWarmingError` instead of resolving a null vector (#928) |
| [`packages/gateway/src/search/dual-search.ts`](../../packages/gateway/src/search/dual-search.ts) | `vectorSearchChunksDual` — KNN over both `vec_items_*` tables, merged by distance. This is the only correct way to do vector search after T6 PR 3 |
| [`packages/gateway/src/index/vec-items-1536-v30-sql.ts`](../../packages/gateway/src/index/vec-items-1536-v30-sql.ts) | V30 migration SQL — `vec_items_1536` virtual table + dim-aware delete triggers |
| [`packages/gateway/src/ipc/index-reembed-rpc.ts`](../../packages/gateway/src/ipc/index-reembed-rpc.ts) | `dispatchIndexReembedRpc` — `index.reembed` / `index.reembedCancel` long-running handler. **CLI-only**: NOT LAN-callable (`I5`), NOT in Tauri allowlist (`I7`) |
| [`packages/cli/src/commands/index-cmd.ts`](../../packages/cli/src/commands/index-cmd.ts) | `nimbus index reembed` CLI; subscribes to `index.reembedProgress` / `index.reembedDone` / `index.reembedError` notifications |

## Warm-up (#928) — `null` vs "not yet"

The gateway binds its IPC socket BEFORE the model is loaded, so every embedding surface has to
distinguish two different absences:

- **`null` vector** — vectors are permanently unavailable for this process (`disabled` /
  `unavailable`). Degrading to BM25 is correct.
- **`EmbeddingWarmingError`** — vectors are not available YET (`warming`). Degrading here is the
  FALSE GREEN: hybrid search silently drops to BM25 and a query with no lexical overlap returns
  `[]`, which reads exactly like "searched everything, found nothing".

`EmbeddingRuntime.getReadiness()` is the contract. Rules for any new code:

1. A runtime that is warming MUST throw, never resolve `null`.
2. A caller that genuinely wants to degrade must say so via `embedQueryBestEffort` /
   `embedQueryDualBestEffort` — those names are the audit trail for every silent-degrade site.
3. A user-facing surface that could report a zero must surface the warming state instead
   (`index.searchRanked` → JSON-RPC `-32021`, `gateway.ping` → the `embedding` readiness block).

## The Routing Decision

```typescript
export const PROSE_HEAVY_TYPES: ReadonlySet<string> = new Set([
  "slack:message",
  "discord:message",
  "teams:message",
  "gmail:email",
  "outlook:email",
  "notion:page",
  "confluence:page",
  "obsidian:obsidian_note",
  "pagerduty:incident",
  "linear:issue",
  "jira:issue",
  "github:issue",
  "gitlab:issue",
  "bitbucket:issue",
  "snyk:vulnerability",
  "zoom:transcript",   // transcribed speech — paragraph-shaped natural language
  "imap:email",        // email bodies — same posture as gmail:email
  "fastmail:email",    // JMAP email bodies
  "protonmail:email",  // Bridge email bodies
]);
```

The key shape is `"<service>:<type>"` — same shape every `IndexedItem.id` uses on its left side. When you add a new item type, decide:

- **Prose-heavy** (paragraphs of natural language; semantic search benefits from a larger model): add to `PROSE_HEAVY_TYPES`. Routes to OpenAI `text-embedding-3-small` in hybrid mode. Examples: chat messages, email bodies, wiki pages, free-form ticket descriptions.
- **Sparse / structured** (titles, file paths, identifiers, code snippets, short metadata): omit from the set. Stays on local MiniLM-L6-v2 (384-dim). Examples: PR titles, file names, API endpoint paths, deployment items, CI run names.

**Default to omitting.** Adding a new entry sends every existing user's `(service, type)` corpus through OpenAI on the next embed pass — for free OSS users that means surprise API spend the first time the gateway encounters that type after upgrade. But when content is genuinely prose-paragraph-shaped (email bodies, transcribed speech, vulnerability descriptions), additions are justified and actively made — see the comment-annotated `snyk:vulnerability` / `zoom:transcript` / `imap:email` / `fastmail:email` / `protonmail:email` entries in `routing.ts`. For sparse/structured types (titles, paths, IDs), the default of "stay on local" remains the safer floor.

## The Routing Pipeline

`RoutingEmbeddingPipeline` is a drop-in `EmbeddingPipeline` that takes two `SqliteEmbeddingPipeline` instances at construction:

```typescript
class RoutingEmbeddingPipeline implements EmbeddingPipeline {
  constructor(
    private readonly db: Database,
    private readonly local: SqliteEmbeddingPipeline,    // MiniLM, 384
    private readonly openai: SqliteEmbeddingPipeline,   // text-embedding-3-small, 1536
  ) {}

  async embedItem(item: IndexedItem): Promise<void> {
    const target = isProseHeavy(item.service, item.type) ? this.openai : this.local;
    await target.embedItem(item);
  }

  async deleteItemEmbeddings(itemId: string): Promise<void> {
    // V30 dim-aware delete triggers on `embedding_chunk` fan out to
    // both vec_items_* tables automatically — one DELETE is enough.
    dbRun(this.db, `DELETE FROM embedding_chunk WHERE item_id = ?`, [itemId]);
  }

  async backfillAll(onProgress?): Promise<void> {
    const proseKeys = Array.from(PROSE_HEAVY_TYPES);
    await this.openai.backfillForRoutingKeys({ in: proseKeys }, onProgress);
    await this.local.backfillForRoutingKeys({ notIn: proseKeys }, onProgress);
  }
}
```

Two non-obvious properties:

1. **Deletes go through `embedding_chunk` only** — the V30 migration installed triggers that fan a single `DELETE FROM embedding_chunk WHERE item_id = ?` to whichever `vec_items_*` table holds the chunks. Do not try to delete from `vec_items_384` and `vec_items_1536` separately — that's a bug, not a defence-in-depth.
2. **The write goes through `dbRun`** (invariant `I14`). Direct `db.run(...)` in routing code would fail the static-time audit.

## Dual Search

After T6 PR 3, vector search **must** consult both tables and merge by distance. The canonical helper is:

```typescript
import { vectorSearchChunksDual } from "../search/dual-search.ts";

const hits = await vectorSearchChunksDual(db, {
  queryEmbedding384: localEmbedding,    // optional — undefined skips local KNN
  queryEmbedding1536: openaiEmbedding,  // optional — undefined skips OpenAI KNN
  k: 50,
});
```

The dispatcher computes the query embedding(s) using the same routing decision (the query type is `chat:user_query` by default; pass through both if you want hybrid recall). **Never `SELECT FROM vec_items_384`** in new search code — it silently misses every prose-heavy item.

## Hybrid Runtime Factory + Fallback

`tryCreateRoutingEmbeddingRuntime` is the gateway-startup factory. The important property:

> If `openai.api_key` is missing from the vault but `embedding.provider = "hybrid"` is set in `nimbus.toml`, the factory **falls back to MiniLM-only** and logs one info-level line. The gateway never refuses to start because of the missing optional secret.

This is the right default for OSS: hybrid is opt-in via vault key, not config. A user who configures `provider = "hybrid"` but never adds the key gets degraded recall, not a startup failure.

## Reembed (long-running IPC pattern)

`nimbus index reembed` is the canonical long-running IPC contract. Use it as a template when adding any future long-running gateway operation.

**Surfaces:**

| Layer | Surface |
|---|---|
| CLI | [`packages/cli/src/commands/index-cmd.ts`](../../packages/cli/src/commands/index-cmd.ts) — `nimbus index reembed --model <id> [--item-type <key>] [--service <name>] [--limit N] [--batch-size N] [--dry-run] [--yes] [--json]` |
| IPC request | `index.reembed` → `{ jobId }` (returns immediately) |
| IPC cancellation | `index.reembedCancel { jobId }` → `{ cancelled: boolean }` |
| IPC notifications | `index.reembedProgress { jobId, done, total, skipped }` per batch · `index.reembedDone { jobId, succeeded, skipped, durationMs }` on completion · `index.reembedError { jobId, code, message }` on fatal abort |

**Security posture (CLI-only):**

- `index.reembed` and `index.reembedCancel` are in `FORBIDDEN_OVER_LAN` (invariant `I5`).
- Neither is in the Tauri renderer allowlist (invariant `I7`).
- They are not exposed over the HTTP API.

Adding a new method that should follow the same posture: list it by full name in `FORBIDDEN_OVER_LAN`, omit it from `ALLOWED_METHODS` in `gateway_bridge.rs`, and do not register an HTTP route for it.

**Idempotence:** items already embedded against the target model are skipped, so re-running after a transient OpenAI 5xx is safe. Exit code `0` covers "completed with any number of skips"; operator re-runs to retry. Exit code `1` is reserved for fatal aborts (vault key missing, unknown model id, auth failure, gateway down).

**Dry-run:** `--dry-run` emits exactly one `index.reembedDone` notification with `{ dryRun: true, planned: N }` and writes nothing.

## Adding a New Item Type — Checklist

When a new connector emits a new `(service, type)` pair:

- [ ] Decide prose-heavy vs sparse using the criteria above. Default to sparse.
- [ ] If prose-heavy, add `"<service>:<type>"` to `PROSE_HEAVY_TYPES` in `routing.ts`. Keep alphabetical order within blocks if it helps readability.
- [ ] Update the unit test for `isProseHeavy` to cover the new key.
- [ ] If you also want existing users' historical data re-embedded on the next start, leave it for the user — `RoutingEmbeddingPipeline.backfillAll` will pick it up at the next pass; or document `nimbus index reembed --item-type <key> --model openai:text-embedding-3-small`.
- [ ] Confirm new search code uses `vectorSearchChunksDual`. Never `vec_items_384`-only.

## Adding a New Provider Track (e.g. 3072-dim)

This is a larger change than adding a routing key — it's a new migration + new constants + new pipeline plumbing:

- [ ] Add a new `EMBEDDING_DIM_<NAME>` constant in `routing.ts`. Add it to `SUPPORTED_EMBEDDING_DIMS`.
- [ ] Add a V`<N>` migration mirroring V30: `vec_items_<dim>` virtual table + dim-aware delete trigger on `embedding_chunk`.
- [ ] Extend `RoutingEmbeddingPipeline` to hold a third pipeline (or restructure into an `n`-pipeline router keyed by target dim).
- [ ] Extend `vectorSearchChunksDual` (or replace with `vectorSearchChunksMulti`) so search queries can target the third table.
- [ ] Extend `nimbus index reembed --model` validation to accept the new model id; vault-key requirement, if any, declared in the validator.
- [ ] Update `nimbus-file-map.md` and `nimbus-commands.md` with the new model id and any new vault key.

## Anti-Patterns

| Anti-pattern | Why it's bad | What to do instead |
|---|---|---|
| Adding a new `(service, type)` to `PROSE_HEAVY_TYPES` because "OpenAI gives better results for everything" | Forces every hybrid-mode user to pay for OpenAI embedding of a corpus they didn't ask for. Sparse-structured types (titles, paths, IDs) embed fine on 384-dim MiniLM | Default to omitting. Add only when the content is genuinely prose-paragraph-shaped |
| Calling `SELECT ... FROM vec_items_384 WHERE …` in new search code | Silently misses every prose-heavy item; recall regresses for the OpenAI-embedded portion of the corpus without any test failure | Always go through `vectorSearchChunksDual` |
| Issuing parallel `DELETE FROM vec_items_384 WHERE item_id = ?` + `DELETE FROM vec_items_1536 WHERE item_id = ?` | Defeats the V30 trigger design; introduces a window where one table is half-deleted | Delete once from `embedding_chunk`; let the triggers fan out |
| Direct `db.run(...)` inside the routing pipeline | Regresses `I14` (the static audit `D12` exits 1) | Use `dbRun` from `db/write.ts` |
| Hard-failing gateway startup when `openai.api_key` is missing | The hybrid-mode fallback to MiniLM-only is intentional — OSS users have no obligation to provide an OpenAI key | Trust the factory's fallback; do not add a startup precondition |
| Adding `index.reembed` to the Tauri allowlist for a "convenient UI button" | Long-running ops with API cost on every batch should not be one-click from the renderer | Keep it CLI-only. If the desktop UI needs status, expose a read-only `index.reembedStatus` instead |
| Suppressing `index.reembedProgress` notifications because "they're noisy" | The CLI's progress streamer + the user's ability to know if a long run is making progress depend on these. Suppression means the user sees nothing for tens of minutes | Keep the per-batch cadence; throttle batch size instead |

## Tests

Coverage gate: `bun run test:coverage:embedding` (≥80%). Add a unit test for any new entry in `PROSE_HEAVY_TYPES` (round-trip through `isProseHeavy`); an integration test for any change to `RoutingEmbeddingPipeline.embedItem` (asserts the right inner pipeline is called); an e2e test for any change to the `nimbus index reembed` CLI surface.

## See Also

- [`packages/gateway/src/embedding/`](../../packages/gateway/src/embedding/) — pipeline implementations
- [`docs/architecture.md`](../../docs/architecture.md) §"Local Database Schema" — `embedding_chunk` + `vec_items_*` schemas
- `nimbus-db-migrations` skill — for V`<N>` migration authoring + FTS5/vec0 caveats
- `nimbus-ipc` skill — for the long-running IPC notification pattern
- `nimbus-commands` skill — for the `nimbus index reembed` CLI invocation and coverage gates
