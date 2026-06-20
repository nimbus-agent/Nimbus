# Nimbus Actions — Recipe Marketplace — Design

**Date:** 2026-06-20
**Status:** Design — pending user review
**Roadmap home:** Track 1 Near-Term Spine **S3 — Open Surface** (marketplace registry overlay) · folds into **Phase 9.5 — Marketplace Registry** as a `/recipes/` index alongside the planned extension index
**Scope:**
- New: `packages/gateway/src/recipes/` (registry client, install gate, recipe-manifest types, recipe store)
- Extend: `packages/gateway/src/ipc/share-rpc.ts` (recipe RPC handlers) or a sibling `recipe-rpc.ts`; `packages/cli/src/commands/` (new `recipes.ts`)
- Extend: `packages/gateway/src/engine/executor.ts` (`HITL_REQUIRED_BACKING` adds `recipe.publish`)
- Reuse (no change): `share/share-keypair.ts`, `share/share-format.ts`, `share/recipe.ts`, `share/recipe-runner.ts`, `share/recipe-yaml.ts`, `extensions/registry-client.ts`, `extensions/verify-signature.ts`
- New migration: **V46** (`recipe_index` cache table — see Schema)

---

## Motivation / Goal

Today a Nimbus recipe is an **ephemeral, one-time export**: `nimbus share create <session> --as-recipe` reconstructs a declarative, LLM-free tool-call DAG from `tool_call_log` (verified by `buildRecipeFromSession` in `packages/gateway/src/share/recipe.ts`), redacts it, gets the owner's HITL approval, signs it with the Vault-only Ed25519 share keypair, and drops a `.nimbus-recipe.yaml` file. The recipient verifies the signature and can `share.replay` it read-only (`packages/gateway/src/share/recipe-runner.ts`). The crypto, redaction, content-addressing, and replay are all production-wired (Slice 8b PR #679, Slice 8c PR #684).

What does **not** exist: any way to **find** a recipe you didn't receive directly, to **trust** a recipe by publisher rather than by hand-carried file, or to know a recipe's **version / rating / freshness**. There is no recipe registry, no search, no publish flow, no quality signal. `registry.nimbus-agent.dev` (Phase 9.5) is specced for **connectors/extensions only** — the Phase 9.5 roadmap section (`docs/roadmap.md` §"Phase 9.5 — Marketplace Registry", lines 1276–1340) never names recipes.

**Goal:** promote recipes from hand-carried files into a **signed, versioned, searchable** marketplace (community ratings deferred to a later sub-slice — see Non-goals) — *reusing* the existing share signing + the I16 extension publisher-key chain rather than inventing crypto — while keeping every recipe **inert until the owner approves install** and routing **every replayed step through the read-only replay path** (no HITL bypass). This directly advances **S3 Open Surface**, the cheap ecosystem-flywheel lever in the resequence design (`docs/superpowers/specs/2026-06-17-roadmap-phase7-plus-resequence-design.md`, lines 81–87).

---

## Where this fits (roadmap home + not-already-shipped evidence)

- **Roadmap home:** S3 Open Surface (marketplace registry). The resequence design (line 87) lists "Marketplace registry [↑from Phase 9.5] + extension/plugin maturity" as S3 scope. Phase 9.5 is the detailed home; this spec is the **recipe index** that Phase 9.5 left unspecified.
- **Already shipped (reuse, do NOT rebuild):**
  - Recipe reconstruction: `buildRecipeFromSession()` → `Recipe`/`RecipeStep` (`share/recipe.ts`).
  - Signing + canonical hash + verify: `buildShareFile()` / `contentHash()` (blake3) / `verifyShareBytes()` (`share/share-format.ts`); Vault-only seed via `ensureShareKeypair()` (`share/share-keypair.ts`, keys `share.signing.privkey` / `share.signing.pubkey`).
  - Read-only replay: `replayShare()` / `stepsFromShare()` — write tools are `skipped-non-read`, never executed (`share/recipe-runner.ts`).
  - Deterministic on-disk form: `serializeShareFileToYaml()` (`share/recipe-yaml.ts`).
  - The outbound HITL chokepoint: `createShare()` (`share/share-gate.ts`), `share.publish` already in `HITL_REQUIRED_BACKING` (`engine/executor.ts`, line 124) — this is **I27**.
  - The registry HTTP-fetch pattern: `createRegistryClient()` / `createPublisherKeyFetcher()` with timeout/retry/transient classification + publisher-key-by-id fetch (`extensions/registry-client.ts`); the I16 verify chain (`extensions/verify-signature.ts`).
- **Not shipped (the gap this spec designs):** recipe registry index, recipe search/info, recipe publish-to-registry, recipe install-from-registry (with owner HITL), a local recipe cache table, recipe ratings, freshness. None of these exist for recipes anywhere in-tree (confirmed: `recipes/` directory does not exist; Phase 9.5 roadmap is extensions-only).

---

## Approaches considered

### Approach A — GitHub-repo-backed static index (like the connector/extension registry) **[RECOMMENDED]**

A `/recipes/` namespace on the **same static-hosting model** Phase 9.5 already mandates for extensions (`registry.nimbus-agent.dev`, "Static-hosting-friendly (S3 / R2 / GCS + CDN); no relational database", roadmap line 1294). The registry is a content-addressed tree of signed `.nimbus-recipe.yaml` files plus a JSON index materialized from the tree. Authors publish via a one-shot signed POST (or PR to a GitHub-repo-backed bucket, exactly like the connector registry). **v1 focuses on signed-metadata verification + install-time HITL only**; community ratings (append-only signed rating records in a sibling `/recipes/<hash>/ratings/` path) are deferred to a later sub-slice (see Non-goals).

- **Pros:** Reuses the *exact* Phase 9.5 infra decision (static bucket, no DB, keys-are-identity). `createRegistryClient` already speaks this protocol — minimal new HTTP code. No payment/account/server-state liability. Recipes are already content-addressed (`contentHash`), so the tree key is free. The signed-metadata verification + install-HITL core is the entire trust surface; ratings layer on top later without changing it.
- **Cons:** No live "install count" or "trending" without a counter service — surface "freshness" (publishedAt) instead of installs for v1 (YAGNI). Community quality signals (ratings) arrive in a later sub-slice.

### Approach B — Hosted dynamic service (accounts + relational DB + server-side ratings/search)

A real service: user accounts, a Postgres of recipes/versions/ratings, server-side full-text search, install counters, trending.

- **Pros:** Rich discovery (trending, faceted search, install counts) out of the box; server enforces one-rating-per-account.
- **Cons:** Directly contradicts the Phase 9.5 "no user accounts on the registry itself… the keys are the identity… no relational database" commitment (roadmap line 1294). Operational + privacy liability (accounts = PII = a breach surface). Heaviest possible build for an S3 "cheap lever." Rejected on cost-vs-moat and on roadmap consistency.

### Approach C — Keep recipes as ephemeral files; add only a curated, read-only "starter recipes" list in the existing extension registry

No publish flow, no ratings — just ship ~10 first-party recipes as static signed files behind a `nimbus recipes list`/`install` over the existing extension registry base URL.

- **Pros:** Smallest possible surface; zero new trust model; ships in days.
- **Cons:** Not a marketplace — no community publishing, no versioning ledger, no search beyond a flat list. Fails the stated goal ("signed + versioned + searchable"). Good as a **decomposition first slice**, not the whole design.

### Recommendation

**Approach A.** It is the only option that delivers "signed + versioned + searchable" (with rated as a later sub-slice) *and* stays inside the Phase 9.5 architectural commitments (static bucket, keys-are-identity, no accounts, no DB on the registry). It reuses `createRegistryClient`'s fetch/timeout/retry shape, the I16 publisher-key chain, the I27 share signing keypair, and the Slice-8c read-only replay path verbatim — so the new code is a thin **recipe index + install-HITL gate**, not new crypto or new infra. Approach C is folded in as the **first decomposition slice** (first-party seed recipes), de-risking the publish/ratings layer behind a working install path.

---

## Design (recommended)

### Architecture & components

New subsystem `packages/gateway/src/recipes/` (AGPL, gateway-owned — see License check):

- **`recipe-manifest.ts`** — `RecipeManifest` type: `{ recipeId, version, title, summary, authorPubkey, contentHash, publishedAt, recipeFormatVersion: 1, declaredConnectors: string[] }`. A recipe manifest is a thin metadata envelope **referencing** the signed `.nimbus-recipe.yaml` body (which is already a `ShareFile` with `kind: "recipe"`). The manifest itself is signed by the author's **share pubkey** (the same Ed25519 key in `share-keypair.ts`) — no new key material. Parser validates every field from `unknown` (no `any`).
- **`recipe-registry-client.ts`** — built by composing `createRegistryClient`-style fetch (reuse `extensions/registry-client.ts`'s timeout/retry/transient classifier; extract the shared `getJson` helper to `@nimbus-dev/sdk` only if it is provably reusable, else duplicate the ~15-line fetch shape in gateway). Endpoints: `GET /recipes/index.json` (search index), `GET /recipes/<recipeId>/<version>.yaml` (signed body). Publisher key by author id reuses `createPublisherKeyFetcher` unchanged. (Ratings endpoints are a later sub-slice — see Non-goals.)
- **`recipe-install-gate.ts`** — the **install chokepoint**. Fetches the signed body, runs `verifyShareBytes()` (signature + contentHash + format, reusing `share-format.ts`), surfaces the **redacted recipe DAG preview + declared connectors** to the owner via a `recipe.install` HITL action, and on approval persists a row into the local `recipe_index` cache (V46). **Fail-closed:** an invalid signature, a content-hash mismatch, or an unverified publisher rejects before any prompt; a denied/timed-out HITL persists nothing.
- **`recipe-store.ts`** — `insertRecipeIndexRow` / `listRecipes` / `getRecipe` writing **only** through `dbRun`/`dbStmtRun` (I14). The cache mirrors what the user has installed/viewed; the registry remains the source of truth.

**Reused unchanged:** `share/recipe.ts` (build), `share/recipe-runner.ts` (replay), `share/recipe-yaml.ts` (serialize), `share/share-keypair.ts` (Vault seed), `share/share-format.ts` (sign/verify), `extensions/verify-signature.ts` (publisher chain).

### Data flow

**Publish** (author): `nimbus recipes publish <session-id>` → builds the recipe via the *existing* `createShare({ kind: "recipe", sink: ... })` path so the owner approves the **exact redacted DAG** under `recipe.publish` HITL (I27 + the new `recipe.publish` HITL action) → the signed `ShareFile` + a manifest are uploaded to the registry bucket (one-shot signed POST / repo PR). No raw params leave: `redactForShare` already stripped secrets at gate time (`share-gate.ts`).

**Discover:** `nimbus recipes search <query>` / `nimbus recipes info <id>` → `recipe-registry-client` fetches `index.json` / per-recipe metadata → pure render. No execution, no install.

**Check connectors:** `nimbus recipes check-connectors <recipe-id>` → fetch the recipe manifest → compare its `declaredConnectors` against the locally-registered connectors → report which declared connectors are present vs missing on this gateway. Read-only, no install, no execution — a pre-install readiness check.

**Install:** `nimbus recipes install <id>[@<version>]` → fetch signed body → `verifyShareBytes` (fail-closed) → verify author pubkey against the I16 chain → `recipe-install-gate` shows redacted DAG preview → **owner `recipe.install` HITL** → on approve, cache the verified body locally (V46). Install does **not** run anything.

**Run:** `nimbus recipes run <id>` (or the existing `nimbus verify-share <file> --replay`) → `replayShare()` from `recipe-runner.ts` → **every write-classified step is `skipped-non-read`; read steps run through the mesh; the LLM is never re-invoked; `dependsOn` is never consulted.** A future write-capable execution mode is explicitly a non-goal (see Non-goals) and would route each write step through the existing executor `gate()` — never bypassed.

### IPC / CLI surface

New CLI command group `nimbus recipes`:
- `nimbus recipes search <query>` → RPC `recipes.search`
- `nimbus recipes info <id>` → RPC `recipes.info`
- `nimbus recipes check-connectors <recipe-id>` → RPC `recipes.checkConnectors` (read-only: reports which connectors a recipe declares that the local gateway has vs is missing, before install)
- `nimbus recipes install <id>[@<version>]` → RPC `recipes.install` (HITL `recipe.install`)
- `nimbus recipes publish <session-id> [--registry <url>]` → RPC `recipes.publish` (reuses `share.create` recipe path under `recipe.publish` HITL)
- `nimbus recipes list` → RPC `recipes.list` (local cache)
- `nimbus recipes run <id>` → RPC `recipes.run` (delegates to `replayShare`)

(`nimbus recipes rate` is deferred to the ratings sub-slice — see Non-goals.)

RPC handlers land in a new `packages/gateway/src/ipc/recipe-rpc.ts` (sibling to `share-rpc.ts`), registered in the dispatcher. **Tauri allowlist (I7):** expose only the read/discovery methods (`recipes.search`, `recipes.info`, `recipes.checkConnectors`, `recipes.list`) to the renderer; `recipes.install` / `recipes.publish` are HITL-emitting and stay **off** the renderer allowlist for v1 (the desktop install flow can land in a later slice). LAN: recipe install/publish are **LAN-forbidden** (owner-local only), mirroring `federation.shareForward`'s LAN-forbidden treatment in D21.

### Security: 7 Non-Negotiables + invariant/schema impact

1. **Local-first** — the registry is a connector for *discovery*; the machine stays the source of truth. Nothing auto-syncs, auto-installs, or auto-runs. A recipe is inert until the owner approves install (HITL), and only ever **replays read-only**. Cache (V46) is local; registry is read-only metadata. ✅
2. **HITL is structural** — `recipe.install` and `recipe.publish` both gate through `engine/executor.ts` `gate()` via the frozen `HITL_REQUIRED_BACKING` set. The gate consults `action.type` only (I3); cannot be configured away. `recipes.run` uses the *read-only* `replayShare` path — there is no write to gate, and any write step is `skipped-non-read` by construction. ✅
3. **No plaintext credentials** — recipe bodies are already secret-redacted at creation time by `redactForShare` (V42 `tool_call_log.params_json` stores redacted params). The author's signing key is the Vault-only `share.signing.privkey` (never returned over IPC/HTTP/DB/logs). Publisher pubkeys are public by design. No new secret. ✅
4. **MCP as connector standard** — a recipe is by construction a *composition of logged MCP tool calls*; replay invokes the mesh via `recipe-runner`'s injected `run(toolId, params)`, never a raw cloud HTTP call. ✅
5. **Platform equality** — all new code is Bun/TS; HTTP fetch + SQLite cache are platform-neutral; no OS-specific paths (use `path.join`). ✅
6. **AGPL core / MIT SDK** — all new recipe code lands in `packages/gateway` (AGPL). The only SDK touch would be an *optional* extraction of the byte-shaped `getJson` fetch helper — if extracted it stays MIT and carries no recipe semantics; default is to keep the fetch shape in gateway to avoid over-extraction. No license field changes. ✅
7. **No `any`** — all registry responses, manifests, and rating records are parsed from `unknown` with explicit validators (the `parseStep`/`parseExtensionManifestJson` pattern). ✅

**Invariant impact:**
- **Reuse I27 / D21** for the *publish* emit (a published recipe leaves the machine only through the share-gate `createShare()` with owner HITL approval of the exact redacted body). The publish path is literally `createShare({ kind: "recipe" })` — no new emit chokepoint. (The *rate* emit is deferred with ratings to a later sub-slice; when built it reuses the same I27 owner-approved emit pattern.)
- **Reuse I16** for publisher-key verification at install (Ed25519 chain, `extensions/verify-signature.ts`).
- **Reuse I14** for all `recipe_index` writes; **I10** constant-time compare is inherited via `verifyShareBytes`.
- **New invariant — I33**: *"A recipe fetched from a registry is verified (signature + content-hash + publisher chain) and surfaced to the LOCAL owner for `recipe.install` HITL approval before it is persisted to the local recipe cache; an unverified or owner-denied recipe persists nothing and is never replayable (fail-closed). Recipe execution is read-only `replayShare` — no recipe step ever bypasses the executor `gate()`."* Wiring site `recipes/recipe-install-gate.ts`; enforcement test in `security-invariants.test.ts`; static complement (**D26**) in `scripts/structure-audit/check-nimbus-invariants.ts` confining the install-persist call to the gate. **Decision rule:** I33 is needed *only because* recipes become **installable, persisted, registry-sourced artifacts** (not one-time hand-carried files); if the user prefers Approach C (no install/publish, curated-list-only) for the first slice, I27 + I16 suffice and **no new invariant is needed** until the publish/install slice lands.

  **Numbering note:** I28 is reserved for the MCP-server owner-sink (branch dev/asafgolombek/phase7-mcp-gateway-server). The I33/D26/V46-style numbers here follow the *proposed* global sequence in 2026-06-20-superpowers-specs-consolidated-review.md §1 — these family ideas are mutually exclusive, so the actual number is the next-free at this spec's own merge time, reconciled by build order.
- **Schema:** **V46** adds `recipe_index` (local cache): `content_hash TEXT PRIMARY KEY, recipe_id TEXT, version TEXT, title TEXT, author_pubkey TEXT, declared_connectors TEXT (json), body_json TEXT, installed_at INTEGER, source_registry TEXT`. Append-only/forward-only, written via `dbRun` (I14), runner-wrapped per `nimbus-db-migrations`. The registry index itself is **not** a DB (static JSON). Ratings are **not** stored locally (deferred to a later sub-slice).

**Fail-closed behavior:** invalid signature / hash mismatch / unverified publisher → reject before HITL. HITL deny/timeout → persist nothing. Registry unreachable → `recipes.search`/`info` return a transient error (reuse the `transient` classifier), never a partial/forged result. A malformed registry index → zero results (the `stepsFromShare` "anything malformed yields zero steps" fail-safe pattern).

### Testing (layers + coverage)

- **HITL test** (`security-invariants.test.ts` + a recipe-install test): prove `recipe.install` / `recipe.publish` fire the gate before any persist/emit; prove a denied install persists nothing; prove a tampered (bad-signature) recipe is rejected *before* the prompt (fail-closed). This is the I33 enforcement triple (wiring + docs row in `SECURITY-INVARIANTS.md` + test, same commit).
- **Vault test:** prove the author signing seed never appears in any `recipes.*` IPC response, registry POST body, log line, or the `recipe_index` cache.
- **Integration test (real SQLite, real subprocess):** publish → fetch-back → `verifyShareBytes` ok → install (HITL approve) → `recipe_index` row present → `recipes.run` replays read-only with write steps `skipped-non-read`. Mock the registry as a local HTTP fixture (no real cloud).
- **Pure-unit tests:** `recipe-manifest.ts` parser (every `unknown` field), `check-connectors` present-vs-missing diff against the local connector set, the registry client's transient/not-found/error classification.
- **Coverage floor ≥80% line+branch per new file** (the project baseline is `{}` — every new file must clear the floor; verify Linux-authoritative via Docker per the ship-readiness note). E2E CLI test: real gateway subprocess + mock registry for `nimbus recipes search/install/run`.

---

## Non-goals (YAGNI)

- **No community ratings in v1.** v1 focuses on signed-metadata verification + install-time HITL. Community ratings (append-only signed rating records, distinct-rater aggregation mirroring I21, `nimbus recipes rate`, the `recipes.rate` RPC + `recipe.rate` emit, and the `/recipes/<hash>/ratings/` endpoint) are deferred to a later sub-slice. Until then, "freshness" (`publishedAt`) is the quality signal surfaced by `recipes.info`.
- **No write-capable recipe execution.** Recipes replay **read-only** (`replayShare`). A "run this recipe and let it make changes" mode is explicitly deferred; if ever built, every write step routes through the executor `gate()` — never a standing-approval auto-run (that would be the Phase 10 taint-barrier's problem, not this spec's).
- **No payments / monetization / paid recipes** (Marketplace v2 / Phase 6 monetization territory).
- **No user accounts on the registry** (keys-are-identity, per Phase 9.5).
- **No relational registry DB / server-side search / trending / live install counters** for v1 — static index + client-side rating aggregation only.
- **No recipe *dependency* resolution** (recipe-A depends on recipe-B). Recipes are flat ordered step lists today (`recipe.ts`); cross-recipe deps are a later slice if demand appears.
- **No Turing-complete DAG semantics** (loops/branches). Recipes stay a flat list in recorded order — the existing `Recipe` contract.
- **No private/BYO recipe registry** in v1 — but the registry-client base URL is configurable (`registry.url` reuse) so this is a config flip later, not a rebuild.
- **No Tauri renderer install/publish flow** in v1 (read-only discovery only on the renderer).

## Open questions

- **Q1 (scope gate):** Ship the full publish/install marketplace (needs **I33 + V46**), or land **Approach C first** (curated first-party seed recipes, install-only, no publish) to de-risk — which needs **no new invariant and no migration**? Recommendation: C as slice 1, then I33 publish/install as slice 2; community ratings as a later sub-slice.
- **Q2:** Same domain as extensions (`registry.nimbus-agent.dev/recipes/`) or a sibling (`recipes.nimbus-agent.dev`)? Recommendation: same domain, `/recipes/` path — reuses the publisher-key endpoint and CDN.
- **Q3:** Does a recipe manifest fold into the **Signed Connector Manifest (SCM)** RFC (S — Standards track) or get its own thin RFC? Recommendation: a sibling RFC referencing SCM; recipes reference a `ShareFile` body, not a connector tarball, so the shapes differ.
- **Q4 (RESOLVED):** Ratings are deferred entirely to a later sub-slice. v1 focuses on signed-metadata verification + install-time HITL (search + freshness only); community ratings (signed rating records, distinct-rater aggregation, `recipes.rate`) are the *last* sub-slice. Recorded in Non-goals.
- **Q5:** Should `recipes.run` require its own HITL acknowledgement even though it's read-only (a "you are about to replay N tool calls" confirmation), or is read-only replay HITL-free like the built-in agents? Recommendation: HITL-free read-only run (matches `share.replay`), but show a one-line step-count preview.

## Acceptance criteria

- `nimbus recipes search <query>` and `nimbus recipes info <id>` return results from a (mock-in-test, live-in-prod) static registry index; an unreachable registry returns a clean transient error, never a partial result.
- `nimbus recipes check-connectors <recipe-id>` reports, before any install, which connectors the recipe declares that the local gateway has versus is missing — read-only, no execution.
- `nimbus recipes publish <session-id>` round-trips: the owner approves the **exact redacted recipe DAG** under `recipe.publish` HITL (I27), the signed body is uploaded, and fetching it back verifies (`verifyShareBytes().ok === true`) against the author's Ed25519 share pubkey.
- `nimbus recipes install <id>` is **fail-closed**: a tampered body (bad signature or content-hash mismatch) or an unverified publisher is rejected *before* the HITL prompt; an owner-denied or timed-out install persists nothing to `recipe_index`; an approved install writes exactly one V46 row via `dbRun`.
- `nimbus recipes run <id>` replays through `replayShare`: every write-classified step is `skipped-non-read`, the LLM is never invoked, `dependsOn` is never consulted, and the divergence summary renders.
- The author signing seed never appears in any `recipes.*` IPC response, registry upload body, log, or `recipe_index` row (Vault test green).
- I33 triple lands in one commit (wiring in `recipes/recipe-install-gate.ts` + a row in `docs/SECURITY-INVARIANTS.md` + an enforcement test in `security-invariants.test.ts`), with the static complement (D26) confining the install-persist call to the gate — **or**, if slice 1 (Approach C) ships first, the spec notes no new invariant is required until the publish/install slice.
- Every new file under `packages/gateway/src/recipes/` clears the ≥80% line+branch coverage floor (Linux-authoritative), and `bun run preflight` is green before the first push.
