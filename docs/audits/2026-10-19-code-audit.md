# Nimbus code audit (2026-10-19, `main` @ fdc2271)

Read-only review of `packages/gateway/src` and `packages/cli/src`, covering security, PII, performance and SOLID/maintainability. Every finding was checked against the code. Starred items (★) were also re-checked by hand. Findings that CLAUDE.md already lists as stated bounds are left out. Nothing was benchmarked, so the performance impact figures are estimates.

---

## 1. Security

| # | Sev | Finding | Where | Fix |
|---|-----|---------|-------|-----|
| S1 ★ | **High** | **DNS rebinding can read the whole index.** The HTTP sidecar binds 127.0.0.1 but never checks `Host` or `Origin`. The "no bearer gate" table serves full item bodies, people and the audit log, including I33 script bodies. A page at `evil.com:8787` whose DNS answer rebinds to 127.0.0.1 becomes same-origin with the gateway and can page through `/v1/items`. | `ipc/http-server.ts:631-673` (`dispatchReadOnlyDataGet`), `:1521` (`Bun.serve`, no Host check) | Reject any `Host` that is not `127.0.0.1:<port>` or `localhost:<port>`. Reject a browser `Origin` that is not the extension's. Put a scoped bearer on `/v1/items*`, `/v1/people*` and `/v1/audit`. |
| S2 | Med | **LAN frames can be replayed.** There is no session key, sequence number or nonce cache. `hello` only matches a cleartext pubkey. A captured `connector.remove` or `workflow.run` from a write-allowed peer can be replayed on a new TCP connection. | `ipc/lan-server.ts:222-262`, `lan-crypto.ts:28-41` | Derive an ephemeral per-connection key and a server challenge in `hello_ok`, and require a sequence number that only goes up. |
| S3 | Med | **The LAN pairing code is cleartext and not bound to the keys.** An attacker can race the pairing, or sit in the middle and swap pubkeys. | `ipc/lan-server.ts:186-221` | Send `HMAC(code, client_pk‖host_pk)` instead of the code, or use a PAKE such as SPAKE2. |
| S4 | Med | **The IPC endpoint can be squatted.** The Windows pipe `\\.\pipe\nimbus-gateway` is machine-global. Linux falls back to `/tmp/nimbus-gateway.sock` when `XDG_RUNTIME_DIR` is unset. Neither side checks who the peer is, so `nimbus vault set` or `connector auth --token` can send secrets to another user's listener. | `platform/paths.ts:89,127`, `cli/src/paths.ts:30-36` | Put a hash of the user's SID in the pipe name, set an explicit DACL and verify the server owner. On Linux, fall back to a per-user 0700 directory. |
| S5 ★ | Med | **The live DB, WAL, logs and data directories get default permissions** (about 0644/0755 on Linux). Backups and snapshots, by contrast, are correctly 0600/0700. | `platform/dirs.ts:24`, `platform/assemble.ts:480`, `platform/gateway-log-file.ts:179-185,239` | Create directories with mode 0o700. Pre-create `nimbus.db` with mode 0600. Call `process.umask(0o077)` early. Add a `nimbus doctor` check. |
| S6 | Med/Low | **Unauthenticated POSTs can flood `audit_log`.** Every 401/429 is audited with no cap. The no-bearer routes share fixed rate-limit buckets, so any website can send `no-cors` `text/plain` POSTs to `/v1/clips`. That exhausts the clipper's budget and the pairing attempts. | `ipc/http-write-routes.ts:338-366,628-690,1033` | Reject browser `Origin` and the wrong `Content-Type`. Check auth before spending the shared bucket. Sample or cap rejection rows. |
| S7 | Low | **Any `Authorization: Bearer x` spawns `secret-tool`.** There is no token cache and no limit before auth. | `ipc/http-server.ts:177`, `clips/clip-token-store.ts:138`, `vault/linux.ts:138` | Cache the token map in memory, invalidate it on mutation, and rate-limit failed bearer attempts. |
| S8 | Low | **A chunked body (no `content-length`) is buffered up to Bun's 128 MiB default** before the 8 KiB/1 MiB caps apply. | `ipc/http-write-routes.ts:725-749` | Set `maxRequestBodySize` in `Bun.serve`. |
| S9 | Low | **Credentials can be passed as argv** (`--token`, `--credential host=token`), so they show in `ps` and shell history. | `cli/src/commands/connector.ts:206` | Add a hidden prompt or `--token-stdin`, and warn when `--token` is used. |
| S10 ★ | Med | **`data.import` writes vault keys from an unvalidated cast** `JSON.parse(...) as VaultEntry[]`. It does not check shape or the vault-key allow-list. | `commands/data-import.ts:87` | Add a zod schema and an allow-list check before `vault.set`. |
| S11 | Low | **An inbound share file is cast `as ShareFile`** after only `typeof` checks. | `share/share-format.ts:106` | Add a zod schema. |

**Checked and found clean:** SQL (constant identifiers, `?` params), randomness, updater (https, size cap, sha256 plus Ed25519), tar extraction (rejects links and `..`, lstat walk), toolgen paths, constant-time compares (UTF-16LE, no short-circuit), the I30 pairing window.

---

## 2. PII protection

| # | Sev | Finding | Where | Fix |
|---|-----|---------|-------|-----|
| P1 | **High** | **No encryption at rest.** This covers `item.body`, `person`, `session_memory`, `tool_call_log.result_envelope`, `audit_log`, `cu_action.dom_after`, captures and `share_inbox`. FTS shadow tables also hold the tokens in plaintext, so field-level encryption is not enough. | design | Use SQLCipher or sqlite3mc, keyed by a random 256-bit key in the Vault (`index.dbkey`). `Database.setCustomSQLite` is already used on macOS, but the custom build must also bundle FTS5 and sqlite-vec on all three OSes. Migrate existing installs with `sqlcipher_export` behind a pre-migration backup. Pass the key to the embedding worker. |
| P2 | **High** | **Deleted data stays recoverable.** No `secure_delete`, no `auto_vacuum`. `data.delete`, `captures revoke`, prunes and expiries leave content in free pages, the WAL and unmerged FTS segments. | `db/writable-pragmas.ts:35-36` | Set `PRAGMA secure_delete=FAST`. After a bulk delete, run `wal_checkpoint(TRUNCATE)`, then FTS `optimize`, then an optional VACUUM. |
| P3 ★ | **High** | **`data.delete` erases only `item` and `sync_state`.** It leaves `person`, `graph_*`, glossary, decisions, `session_memory`, `tool_call_log`, `audit_log`, egress payloads, fleet and pushed briefs, shares, `watcher_event`, `slow_query_log`, snapshots and backups. The preflight hardcodes `peopleUnlinked: 0`. `LIKE '${service}%'` also wipes the sync state of `github_actions` when you delete `github` (`_` is a LIKE wildcard too). Nothing lets you forget a single person. | `commands/data-delete.ts:47,69-75` | Keep one PII-table registry (table → join key) that drives `data.delete` and a new `nimbus data forget --person <email>`. Add a drift test that fails when a new TEXT table is not listed. Use `connector_id = ? OR connector_id LIKE ? ESCAPE` with an explicit separator. |
| P4 | Med-High | **Unbounded PII tables and logs.** `audit_log` (exported in plaintext), `share_inbox`, `watcher_event`, `share_records` without an expiry, daily `gateway-*.log` files (no rotation or retention), and snapshots. | `share/share-inbox-store.ts:59`, `automation/watcher-store.ts:146`, `share-store.ts:104` | Add `[retention]` keys with defaults. Prune logs after 30 days. Tombstone `audit_log.action_json` after N days (the chain survives, as with `egress.prune`). |
| P5 | Med-High | **Audit and egress redaction removes credentials only.** Email addresses, phone numbers, recipients and message bodies are kept verbatim (4 KiB in `audit_log`, 256 B in `egress_ledger`). Token families it misses: Stripe `sk_live_`, GitLab `glpat-`, Google `AIza`, PEM keys, `xapp-`, `?token=`, `user:pass@`. | `audit/format-audit-payload.ts`, `egress/egress-record.ts:40` | Record field names, sizes and hashes per action type instead of value prefixes. Use one shared pattern map. |
| P6 ★ | Med | **The workflow runner audits through `formatAuditPayload`**, which does not redact, instead of `redactAuditPayload`. | `automation/workflow-runner.ts:41-50` | Swap the call, and add a static rule that bans `formatAuditPayload` outside `audit/`. |
| P7 | Med | **Share redaction gaps.** No phone pattern, no person names, no URL query strings, and no redaction by key name (`{apiKey:"…"}` gets through). | `share/share-redaction.ts:13-22` | Add the `SENSITIVE_KEY` check, phone regexes, query stripping, and name/handle substitution from `person`. |
| P8 | Med | **No minimisation before remote LLM or embedding egress.** `run-ask` sends title, preview and URL as they are. Hybrid embeddings send every prose-heavy body (Gmail, Slack, Zoom) to OpenAI. | `engine/run-ask.ts:711-731`, `embedding/routing.ts:8` | Add an `[llm.remote] redact` (`"off"` / `"contacts"` / `"strict"`) stage inside `wrapLedgeredProvider` and `wrapLedgeredEmbedder`. It would use reversible per-request pseudonyms (`<PERSON_3>`), record the substitution count in the ledger row, and default to `contacts`. |
| P9 ★ | Med | **The OpenAI embedding key is still read from `OPENAI_API_KEY` in the environment.** v5.0.0 removed this env fallback for the LLM adapters only. This conflicts with non-negotiable #3. | `embedding/create-routing-runtime.ts:29`, `create-embedding-runtime.ts:91` | Read it from the Vault only. Note that this is a user-visible change. |
| P10 | Low-Med | **The emergency log writes `err.stack` unscrubbed.** Connector fetch errors log full URLs including query strings, such as `q=from:alice@…`. | `gateway-log-file.ts:240`, `connectors/_lib/fetch-outcome.ts:23`, `mendeley-sync.ts:69` | Scrub the stack. Add a shared `redactUrl` helper (origin plus path). |
| P11 | Low | **The export bundle holds `audit-chain.json` in plaintext**, and the archive is written with the default mode. | `commands/data-export.ts:73` | Encrypt the whole bundle and write it 0600. |
| P12 | Low | **Telemetry** (off by default, allow-listed) sends raw local extension IDs, and its flush is not ledgered. | `telemetry/` | Hash non-registry IDs and ledger the flush. |

---

## 3. Performance (at 100k–1M items)

| # | Impact | Finding | Where | Fix |
|---|--------|---------|-------|-----|
| F1 ★ | **High** | **Sync writes are never in a transaction.** None of the 99 `*-sync.ts` files does. Each item is about 5–15 autocommits (item upsert, FTS triggers, graph upserts), each an fsync. | `connectors/_lib/paginated-sync.ts:27`, `index/item-store.ts` | Wrap each page in `db.transaction(...)`. Expect a 10–100× write speedup. |
| F2 ★ | **High** | **Only WAL and `busy_timeout` are set.** No `synchronous`, `cache_size`, `mmap_size` or `temp_store`. `ANALYZE` and `PRAGMA optimize` are never run. | `db/writable-pragmas.ts:34` | Set `synchronous=NORMAL`, `cache_size=-65536`, `mmap_size=256MB`, `temp_store=MEMORY`. Run `PRAGMA optimize` after sync batches and at shutdown. |
| F3 | **High** | **The FTS update trigger re-indexes up to 16 KB of body on every update**, and the UPSERT always writes even when nothing changed. | `index/body-store-v48-sql.ts:30`, `item-store.ts` | Use `AFTER UPDATE OF title, body … WHEN old.body IS NOT new.body`, and add a no-op `WHERE` on `DO UPDATE`. |
| F4 | **High** | **Every upsert re-embeds the item** (model inference plus chunk rewrite). There is no content hash, no coalescing, and the worker queue is unbounded. | `item-store.ts:224` → `embedding/worker-bridge.ts:297` → `pipeline.ts:103` | Store a text hash and skip when it matches. Coalesce ids in a Set and embed in batches. |
| F5 ★ | **High** | **`item` has only single-column indexes and none on `author_id`.** Hot queries filter `service IN … AND type=? AND modified_at BETWEEN` or `author_id=?`. | `index/unified-item-v3-sql.ts:33-35` | Add `(service,type,modified_at)`, `(type,modified_at)` and `(author_id,modified_at)`, plus indexes on the `person` handle columns. |
| F6 | **High** | **N+1 in the people list.** `countItemsByAuthor` runs once per person, and each one is a full scan. | `ipc/people-rpc.ts:157-194`, `people/person-store.ts:358` | Use one `GROUP BY author_id` query, plus the F5 index. |
| F7 ★ | High (confirm with EXPLAIN) | **`MAX(rowid)` on the vec0 virtual table runs once per embedded item.** It is probably a scan, which makes a backfill quadratic. | `embedding/pipeline.ts:144` | Use `MAX(vec_rowid) FROM embedding_chunk` (already indexed) or an in-memory counter. |
| F8 | Med-High | **The embedding backfill restarts from the newest item on every page.** Items that produce zero chunks, or that fail, are picked again forever. In hybrid mode this runs on the main thread. | `embedding/pipeline.ts:216-286` | Use a keyset cursor and record failed or empty items. Add an index on `embedding_chunk(item_id, model)`. |
| F9 | Med | **Graph populator lookups scan.** It uses `LIKE '%:'\|\|?`, `substr(…) LIKE`, and `json_extract` with no expression index, once per item. It also runs `PRAGMA user_version` on every call. | `graph/graph-populator.ts:277-306,581,730,1064` | Add a `ref_key` side table with exact or range seeks, and expression indexes. Cache the version. |
| F10 ★ | Med | **The scheduler ticks every 25 ms** and re-reads `sync_state` and `scheduler_state` each tick, about 80 queries/s at idle all day. | `sync/scheduler.ts:290-292,486` | Arm one `setTimeout` for the earliest `next_sync_at`, or tick at 1 s with cached state. |
| F11 | Med | **Egress and audit chain verify `.all()` and BLAKE3 every row on the main thread.** This is reachable over HTTP and `nimbus prove`, and it grows without limit. | `egress/egress-verify.ts:91-118`, `db/audit-verify.ts` | Use `.iterate()`, a persisted verified checkpoint, incremental verify, or a Worker. |
| F12 | Med | **A search with no query runs `SELECT i.*`**, pulling bodies of up to 500 × 16 KB. | `index/local-index.ts:605` | Use an explicit column list. |
| F13 | Med | **The decisions pass re-runs the same full ADR scan for every decision.** The `service\|\|':'\|\|type IN …` filter cannot use an index. | `decisions/decision-corroborate.ts:183` | Run it once per pass, and rewrite the filter as `(service,type) IN (VALUES …)`. |
| F14 | Low-Med | **`dbRun` uses `db.run`**, which is not statement-cached, so hot upserts are re-parsed every time. | `db/write.ts` | Add a `dbRunCached` built on `db.query(sql).run()`. |
| F15 | Low | **Sync `readdirSync`/`statSync` in the filesystem walker.** Several maps are never evicted (`LanRateLimiter.failures`, mDNS `seen`, the chatops identity-mapper). `LocalIndex.delete` by `external_id` alone scans the table. | `connectors/filesystem-v2-sync.ts`, `ipc/lan-rate-limit.ts:8`, `local-index.ts:542` | Use async fs with yielding, LRU caps or sweeps, and pass `service` with the id. |

**Best first batch:** F1, F2, F3, F4 and F5 together should cut sync cost by roughly an order of magnitude.

---

## 4. SOLID and maintainability

| # | Principle | Finding | Proposal |
|---|-----------|---------|----------|
| D1 | SRP | **`assemblePlatformServices` is 1,363 lines** in a 4,680-line file with 238 imports. Storage, LLM routes, federation, ChatOps, fleet, sidecars, IPC options and shutdown are all mixed together. | Split into `platform/boot/<phase>.ts`. Each returns `Partial<IpcOptions> & { stops }`, and the root stays an ordered list of phases. Keep the I41 guards visible in the root. |
| D2 | OCP | **IPC routing is a linear chain of 57 `tryDispatch*` functions with 10 skip-marker symbols**, and routing has two levels. That is why `ask.explainLast` passed its unit tests and still returned `Method not found`. Handlers use three dispatch styles. | One `MethodRegistry` built from `RpcModule { namespace, methods }`, which throws on a duplicate. That removes the outer/inner mismatch by construction. |
| D3 | ISP/DIP | **`CreateIpcServerOptions` has 70 fields, 67 optional.** There are 210 `ctx.options.*` reads, and a missing piece of wiring only shows up at call time. | Each `RpcModule` declares its own deps type. A module whose deps are missing is not registered, which can be checked at compile time. |
| D4 | OCP | **A new agent touches 8–10 registration sites.** All 17 renderers live in one 1,586-line `render.ts`. | Add one `AgentDescriptor<K>` per agent, collect them in `AGENTS satisfies {[K in BriefKind]: …}`, and derive every table from it. The index must live in `ipc/` to keep D22(d). |
| D5 | DRY | **26 copy-pasted `ensureXMcp` lazy-spawn functions** with the same 8-step skeleton, plus 63 one-line `phase3Add*` wrappers. | `ensureSlot(ctx, LazySlotSpec)` plus a table. `wrapServerSpec` stays in one place, which makes D10 easier to audit. |
| D6 | DRY | **Local validators everywhere.** 23 local `asRecord` (three different contracts), 10 `requireString`, 92 `require*` functions. zod is a dependency but only 3 files use it. | Standardise on `parseParams` plus zod, and lint against new local `asRecord`. |
| D7 | type safety | **121 `JSON.parse(...) as T`.** 13 cast straight to a domain type (S10, S11, `capture-act.ts:152`, `jwks-cache.ts:51`, `ollama-provider.ts:48`). There are 39 `as unknown as` in source. | Add zod schemas at external boundaries. Add a `ModelLifecycle` capability guard in `llm/registry.ts`. |
| D8 | SRP + correctness | **`nimbus-toml.ts` is 2,837 lines and is re-read and re-parsed about 64 times per boot.** `loadTomlSection` swallows parse errors, so a typo silently resets a section to defaults. | Use `loadConfigSnapshot()` once, with `config/sections/<name>.ts` descriptors, and surface `{value, diagnostics}` in `nimbus doctor`. |
| D9 | robustness | **171 comment-only catches and 49 `.catch(() => {})`.** The shutdown path ignores failures of the I40 credential sweep. | A named LIFO `ShutdownRegistry` that logs each failed step. Lint so a comment-only catch must log or carry `// intentional:`. |
| D10 | contracts | **176 `ERR_*` codes live inside message strings**, and clients find them with `msg.includes(...)`. | A `NimbusError {code}` base mapped to `error.data.code`, plus a generated `ErrCode` union. |
| D11 | DIP | **85 `json_extract('$.merged_at' …)` calls and 128 raw SQL statements in `agents/`.** The item metadata schema is implicit. | Add `index/item-meta/<type>.ts` with SQL fragments plus zod parsers, and have agents query through these modules. |
| D12 | SRP | **`run-ask.ts` (1,313 lines)** mixes routing, retrieval, the explain record and persistence. It also has GitHub-specific enrichment inside the engine. | Split into `engine/ask/*`, and move the enrichment behind a `ContextEnricher[]` interface. |
| D13 | DIP | **Late-bound module globals** (`gateway-events` broadcast, approval notifier) silently drop events emitted before they are set. There are 11 `__set*ForTest` seams and 88 `mock.module`. | Create a buffered `EventBus` first, and use constructor injection. This also reduces the CI-only mock leaks. |
| D14 ★ | LSP | **The CU `download` kind is allowed and classified, but always throws "not implemented".** The owner is asked to approve something that cannot run. `autostart` is a no-op stub. | Remove `download` from `KINDS_BY_LANE` so it is refused before consent. Make autostart reject or remove it. |
| D15 | DRY | **36 `loadCreds` functions, 5 `basicAuthHeader`, 60 identical `pass1Cursor`, 21 `decodeCursor`.** | Shared helpers `readRequiredSecrets`, `basicAuthHeader` and `defineCursor(prefix, schema)`. |

---

## Suggested order

**This week (small changes, large gain):**

1. S1: Host/Origin check plus a bearer on data GETs.
2. S5/P-perms: 0700/0600 permissions and umask.
3. F1 and F2: per-page transactions and PRAGMAs.
4. P6: workflow-runner redaction.
5. P3: the `data.delete` LIKE bug.
6. S10: the data-import schema.
7. D14: the `download` kind.
8. P9: the embedding key from the Vault only.

**Next:**

1. F3, F4 and F5: no-op upserts, embed dedupe, composite indexes (one migration).
2. P2: `secure_delete`.
3. P4: retention.
4. P5/P7: one redaction library.
5. S2/S3: LAN session keys and pairing MAC.
6. S4: per-user IPC endpoint.

**Larger efforts:**

1. P1: SQLCipher.
2. P3: PII registry plus `data forget`.
3. P8: remote-egress pseudonymisation.
4. D2/D3: the RPC module registry.
5. D4: agent descriptors.
6. D1: boot phases.
7. D8: config snapshot.

---

## Progress

Updated as each item lands on this branch. Status is one of: `todo`, `done`, `deferred`.

| Item | Status | Notes |
|------|--------|-------|
| S1 Host/Origin check + bearer on data GETs | done | Host guard shipped as invariant I45. `/v1/items*`, `/v1/people*` and `/v1/audit` now need a client token with the new `data` scope, which no existing token gains automatically. The owner chose to ship this; scripts that read those routes need a token. |
| S5 0700/0600 permissions + umask | done | Data, config, vault and log directories are 0700 (an existing install is tightened). The database (whose `-wal`/`-shm` inherit its mode) and log files are 0600. P10's emergency-log scrub landed in the same change. A global `umask(077)` was left out: it would also change the mode of files the gateway writes for the user, such as exports. |
| F1 per-page sync transactions | done (partial) | New `writeBatch` sync capability: one transaction per page, with embedding requests held until commit. `upsertMapped` uses it, covering 22 connectors. Connectors with hand-written `ctx.upsertItem` loops (about 58 call sites) still need moving over. |
| F2 SQLite PRAGMAs | done | `synchronous=NORMAL` (only once WAL is confirmed), `temp_store=MEMORY`, a 16 MiB page cache, and `PRAGMA optimize` at open and close. `mmap_size` was left out on purpose: mmap behaviour differs across platforms. |
| P6 workflow-runner redaction | done | Now uses `redactAuditPayload`. A test fails if any production file outside `audit/` calls the unredacted formatter. |
| P3 `data.delete` LIKE match | done (LIKE only) | Matches the exact id or a `-`/`:` sub-key, with the id escaped, so deleting `github` no longer clears `github_actions`. The wider erasure gaps (people, graph, logs and other PII tables) are still open under P3/P4. |
| S10 `data.import` schema | done | `parseVaultEntries` checks every entry before any write: string key and value, vault-key format, no duplicates. Errors never echo values. Also found and fixed: the unpacked bundle staging directory was never removed. |
| D14 CU `download` kind | done | Removed from the browser lane's kinds, so it is refused out of envelope before consent. `performActuation` still throws as a second line of defence. Autostart stub not changed. |
| P9 embedding key from Vault only | done (warn) | Owner decision: keep the `OPENAI_API_KEY` fallback and warn. All four read sites now share `embedding/openai-key.ts`, which warns (naming the Vault key, never the value) whenever the environment supplies the key. |
| F3 FTS trigger on every update | done (V72) | `item_fts_update` is now `AFTER UPDATE OF title, body … WHEN` either changed, so a re-sync of unchanged text no longer re-indexes up to 16 KiB per item. The upsert itself still writes, because `synced_at` must move. |
| F4 re-embed on every upsert | done | `upsertIndexedItem` returns `embeddingTextChanged` (type, title or preview changed); the sync wrapper schedules embedding only then. An item left unembedded for another reason is picked up by the startup backfill, as before. Coalescing ids into batches inside the worker is not done. |
| F5 composite indexes | done (V72) | `(service, type, modified_at)`, `(type, modified_at)`, `(author_id, modified_at)`; the redundant single-column `service`/`type` indexes are dropped. Partial indexes on all nine `person` handle columns. |
| F6 people-list N+1 | done | `countItemsByAuthors` answers a page of people in one `GROUP BY` (chunked at 500 ids). |
| F7 `MAX(rowid)` on vec0 | done | Confirmed a full scan (15 ms at 40k vectors). `nextVecRowid` reads vec0's `<table>_rowids` shadow table (0.01 ms), with a fallback to the slow query if that layout ever changes. Used by the embedding pipeline and session memory, which share `vec_items_384`. |
| F8 backfill re-selects failed items | done | Keyset cursor on (`modified_at`, `id`): each unembedded item is tried once per pass. Before, a page of items that chunked to nothing made the backfill loop forever (the new test hangs against the old code). The `(item_id, model)` index was not added; `idx_embedding_chunk_item_id` already serves the `NOT EXISTS`. |
| P2 `secure_delete` | done | `secure_delete = FAST` on every writable handle; `nimbus data delete` runs under `ON`, then `item_fts` `'optimize'` and `wal_checkpoint(TRUNCATE)`. A test scans the database and WAL bytes for a deleted marker, with a positive control. VACUUM is not run. Also fixed: the delete preflight's vector count joined vec rowids to item rowids, which are unrelated. |
| P4 retention | done (partial) | Daily logs older than `NIMBUS_LOG_RETENTION_DAYS` (default 30) are deleted at start; `sync_telemetry` (found during this work: one row per sync run, never pruned) and `watcher_event` past 90 days daily. Not done, needs an owner decision: `share_inbox` and `share_records` (pruning deletes shares the user received or sent) and tombstoning old `audit_log` payloads (changes the chain). |
| P5 audit/egress redaction | done (partial) | One credential map now feeds the audit, egress, share and log scrubbers, with eight new families (Stripe, GitLab, Google, Slack `xapp-`, PEM keys, URL userinfo, secret query parameters, labelled credentials), each fuzzed. Emails and phone numbers are scrubbed from the egress summary. Not done: `audit_log` keeps recipients deliberately (it is the owner's record of who an approved action reached); per-action-type field allow-lists. |
| P7 share redaction | done (partial) | Values under credential-named keys and phone numbers are redacted; secret query parameters come from the shared map. Not done: substituting person names and handles from `person`. |
| S2 LAN replay | done (protocol v2) | Per-connection key from static + ephemeral X25519, counter nonces per direction. Breaking between peers: both must upgrade. |
| S3 LAN pairing code in cleartext | done (protocol v2) | The code never travels: HMAC proofs bound to the keys, checked in both directions before a key is pinned. The ~110-bit code makes offline guessing from a recorded proof infeasible, so no PAKE is needed. |
| S4 IPC endpoint squatting | done (POSIX part) | The CLI refuses a Unix socket owned by another uid before connecting. Not done: Windows named pipes (needs a server-owner check over FFI), and moving the default socket path, which the VS Code extension, `@nimbus-dev/client` and `nimbus-mcp` compute themselves, so it has to be a coordinated cross-repo change. |
