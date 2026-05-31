# Monorepo Cleanup Pass — Design

**Date:** 2026-05-28
**Branch:** `cleanup/monorepo-pass`
**Worktree:** `.worktrees/cleanup-pass`
**Base:** `main` at `02610e59`
**Delivery:** one mega PR on a single branch
**Author:** Asaf Golombek
**Status:** approved, ready for planning

## Goal

A single coordinated pass across the Nimbus monorepo that:

1. Strips every human-written comment from source code and migrates every load-bearing comment's rationale into markdown documentation.
2. Extracts real duplication into shared helpers, with the highest-leverage targets being the connector subsystem (30+ connectors with similar shape) and the IPC RPC dispatchers.
3. Applies SOLID principles where violations exist, with the highest priority on the engine, connectors, and IPC subsystems.
4. Preserves all sixteen security invariants (`I1`–`I16`), the HITL gate, vault key names, license fields, cross-platform parity, the audit chain format, and the existing test suite as the safety net.

The cleanup is aggressive on external API surfaces (IPC method names, CLI flags, OpenAPI routes, `@nimbus-dev/sdk` and `@nimbus-dev/client` exports) where doing so unlocks meaningful SOLID improvements. Aggressive does not extend to the constraints listed in §8.

## Scope decisions captured

| Decision | Value |
|---|---|
| Tree scope | Whole monorepo |
| API aggressiveness | Aggressive — external surfaces can change |
| Comment policy | Strip all comments; migrate load-bearing context to markdown docs (new files created as needed) |
| Delivery | One mega PR on a single branch |
| Test scope | Tests stay frozen as the regression safety net; touched only when a refactored module's import path or signature genuinely changes; assertions never edited |
| Approach | Hybrid (whole-tree passes 2+3, focused per-subsystem commits in passes 4+5) |

## Six-pass plan

### Pass 1 — Survey (read-only)

Output: this design document plus a punch list at `docs/superpowers/specs/2026-05-28-monorepo-cleanup-punchlist.md`. The punch list has four sections:

1. **Load-bearing comments** — every comment that has to survive as documentation somewhere.
   - Discovery: `Grep` for `I[0-9]+`, `HITL`, `WHY:`, `NOTE:`, `WORKAROUND`, `BUG-`, `TODO`, `FIXME`, `HACK`, `XXX`, perf-justifying numbers, bug-ticket refs (`#NNNN`), security/timing wording.
   - Row shape: `file:line` → comment text → suggested target doc.
   - **TODO/FIXME/HACK/XXX triage rule:** a marker that names a concrete future task (cites a ticket, a date, a named follow-up) → row in `docs/internals/known-todos.md`. A vague "todo maybe" with no concrete task → captured as "delete-only" with no migration row. Markers older than 6 months without a ticket cite default to delete-only.
2. **Duplication clusters** — `bun run audit:duplication` (jscpd) output, plus a manual grep pass for shape duplication that token-based jscpd misses (connector sync handlers, IPC RPC dispatchers, mapping files).
   - Row shape: cluster ID → list of `file:line` ranges → proposed extracted symbol + home.
3. **Single-responsibility offenders** — files >500 LOC that export 3+ unrelated symbols, classes that mix I/O with business logic, modules that handle their own dependency lookup.
   - Row shape: file → smell → proposed split.
4. **Open/closed violations** — `if`/`else` chains on a provider/type discriminator that should be a registry.
   - Row shape: `file:line` → discriminator → proposed registry shape.

The punch list is the input to passes 2–5. Every commit in passes 2–5 cites the punch-list rows it resolves.

### Pass 2 — Docs migration

For each load-bearing comment in the punch list, the rationale moves to markdown:

| Comment topic | Target doc |
|---|---|
| Security / invariant rationale (I1–I16) | Append to existing `docs/SECURITY-INVARIANTS.md` under the matching `I<N>` row, or create a new `I<N>` if the comment named a defense not yet listed |
| HITL action-type rationale | `docs/SECURITY-INVARIANTS.md` §I2 |
| Subsystem architecture WHY | `docs/architecture.md` under the matching subsystem section |
| Performance constants | New file `docs/internals/performance-tuning.md` |
| External library workarounds | New file `docs/internals/upstream-workarounds.md` |
| Platform quirks | Existing `docs/sandbox.md` or new `docs/internals/platform-quirks.md` |
| Connector-specific quirks | New per-connector `docs/connectors/<name>.md` (only when a connector actually has quirks worth preserving) |
| DB migration WHY | New file `docs/internals/migration-history.md` |
| Test fixture WHY | Inline in existing `docs/contributors/*.md`, or new `docs/internals/test-fixtures.md` |
| Type-field narrative (e.g. "this field must be non-empty because X") | New file `docs/internals/types-reference.md` — preserves the *why* of complex internal types that loses JSDoc in pass 3 |
| TODO/FIXME with a real future task | New file `docs/internals/known-todos.md` |

Every migrated entry is dated (`Added 2026-05-28 from <file>:<line>`) so reverse-lookup is possible after the strip. Documents link to source files; source files do not link back (they have no comments after pass 3).

### Pass 3 — Comment strip

Tooling: a one-shot Bun script at `scripts/cleanup/strip-comments.ts` that walks every `*.ts`, `*.tsx`, `*.js`, `*.rs` under `packages/` and `scripts/`, using a parser-aware approach (TypeScript compiler API for `.ts`/`.tsx`/`.js`; `syn` or a regex with string-literal awareness for `.rs`).

**Preserved by design:**

- Shebang lines (functional).
- Tooling pragmas: `// @ts-expect-error`, `// @ts-ignore`, `// biome-ignore`, `// eslint-disable-*`, `// dprint-ignore`, `// prettier-ignore`.
- JSDoc on `@nimbus-dev/sdk` and `@nimbus-dev/client` source files — these surface to extension authors via published `.d.ts`. Everywhere else, JSDoc is stripped.
- License header blocks at the top of files (preventative; none exist today).
- `<!-- ... -->` inside markdown (out of scope; we only touch source).
- `// cross-platform-ok` markers (functional directive for `audit:cross-platform`).

**Deleted:**

- All other `//` and `/* */` comments in `.ts`, `.tsx`, `.js`, `.rs`.
- All JSDoc blocks outside `@nimbus-dev/sdk` and `@nimbus-dev/client`.
- All TODO/FIXME/XXX/HACK markers, regardless of phrasing.

The script is checked in so the operation is reproducible and reviewable. A reviewer can verify by running the same script against `main` and diffing.

### Pass 4 — Dedupe

Each theme below is a separate commit. Each commit cites the jscpd cluster IDs and punch-list rows it resolves.

**Connector themes:**

Composition over parameters. The connector subsystem has 30+ files with similar shape but real per-API differences (pagination styles, OAuth refresh edge cases, rate-limit signaling). A single `runConnectorSync(opts)` with 15 flags becomes a god function fast. The extraction is structured as **strategy interfaces + a thin template** that composes them — connectors declare which strategy they use, the template orchestrates.

- **`Pagination` interface** (`packages/gateway/src/connectors/_lib/paginate.ts`) — four concrete implementations: `CursorPagination`, `OffsetPagination`, `PageNumberPagination`, `LinkHeaderPagination`. The connector picks one; the template loop drives it.
- **`AuthHeaderProvider` interface** (`packages/gateway/src/connectors/_lib/auth.ts`) — four concrete: `BearerPat`, `OAuthWithRefresh` (consumes `OAUTH_PROVIDERS` from `oauth-registry.ts`), `QueryStringToken`, `Anonymous`.
- **`RateLimitObserver` interface** (`packages/gateway/src/connectors/_lib/rate-limit-observer.ts`) — reads response headers and informs the existing per-provider rate limiter. Two concrete: `GithubStyleHeaders`, `RetryAfterHeader`. Default observer is a no-op.
- **`runConnectorSync` template function** (`packages/gateway/src/connectors/_lib/sync-runner.ts`) — takes `{ pagination, auth, rateLimitObserver, mapItem, dbWrite }` as constructor-style strategy injection, **not** as a flag bag. Loops until pagination is exhausted; each iteration: fetch page (auth + observer), map items, batch-write via `dbRun`. ~80 lines.
- **HTTP client with retry + audit** (`packages/gateway/src/connectors/_lib/http.ts`) — wraps `fetch`; produces audit entries on retries and non-2xx; consumes the `AuthHeaderProvider` and `RateLimitObserver`. The HTTP client is the only place the auth strategy interacts with the wire.
- **`buildIndexedItem({ service, type, externalId, … })`** — extracted to `packages/gateway/src/connectors/_lib/item-builder.ts`. Pure; no I/O. Every `*-mapping.ts` consumes it.
- **`registerReadOnlyConnectorTools(server, { list, get, search })`** — extracted to `@nimbus-dev/sdk` so first-party and third-party MCP servers share the registration helper.

**Opt-out clause:** connectors whose shape genuinely doesn't fit the template (the `openapi-indexer-sync.ts` is the obvious candidate — it indexes spec *files*, not paginated API responses) **keep their bespoke code**. The success criterion is not "every `<connector>-sync.ts` collapses to 40 lines"; it is "the median connector consumes the template, and any sync handler still >150 LOC after pass 4 has a documented reason in its file's leading docs entry."

Pass 5's `connectors/` review then enforces the success criterion: any sync handler still >150 LOC without a documented exemption gets a second look.

**IPC themes:**

- `createRpcDispatcher({ methods })` — every `<namespace>-rpc.ts` parses params → validates → calls handler → wraps result. Extracted to `packages/gateway/src/ipc/_lib/dispatcher.ts`.
- Long-running IPC pattern (`{ jobId } + progress/done/error` notifications) — extracted to `packages/gateway/src/ipc/_lib/long-running.ts`. `index.reembed` and any future long-running flow consume it.
- HTTP write route per-route body-parse + service-allowlist + audit-on-reject — finished extraction from `dispatchWriteRoute`.

**DB / index themes:**

- `applySchemaStep({ version, description, sql })` — replaces per-step boilerplate in `runner.ts`.

**Engine / agent themes:**

- `runReadOnlyAgent({ decompose, synthesize })` — extracted to `packages/gateway/src/agents/_lib/read-only-agent.ts`. `expert.ts` and `impact.ts` consume it.
- Tool-output envelope (`I11`) call sites stay explicit and unchanged — `engine/agent.ts:wrapToolForLlm` and `lazy-mesh/mesh.ts:397`.

**Vault / auth themes:**

- Audit for remaining `if (provider === "google") ...` chains; replace with `oauth-registry.ts` lookups.

### Pass 5 — SOLID per subsystem

Each subsystem is a separate commit, citing the punch-list rows it resolves.

**Gateway/engine:** Single-responsibility split on `executor.ts` only if it has grown beyond the HITL gate + dispatch; `HITL_REQUIRED` and `ToolExecutor.gate` must stay in the same module per `I2` module-privacy. Dependency injection: modules importing `pino` / `Database` / `fs` directly accept them as constructor args.

**Gateway/connectors:** After pass 4 lands, two checks. (a) Adding a new connector requires only adding a row to `connector-secrets-manifest.ts` plus a sync-runner declaration that picks pagination + auth strategies, never a code branch in a dispatcher (open/closed). (b) Any `<connector>-sync.ts` still >150 LOC after pass 4 must either consume the template with an additional documented strategy, or carry a leading docs entry in the file naming the reason it opts out (the OpenAPI indexer is the expected one). Files that fail both get split or refactored in this pass.

**Gateway/ipc:** Interface segregation — per-method types instead of large union types in handler signatures.

**Gateway/db:** `verify.ts` / `repair.ts` / `snapshot.ts` are already single-purpose; audit `migrations/runner.ts` for SRP.

**Gateway/vault:** Liskov check — `win32.ts` / `darwin.ts` / `linux.ts` all genuinely implement `NimbusVault` with no platform leak.

**Gateway/llm + voice:** `LlmRouter` accepts providers as constructor args.

**CLI:** Any command file >300 LOC splits into `<command>.ts` (thin) + `<command>-impl.ts` or per-subcommand files.

**UI:** Zustand store slices are the existing split; leave the store shape alone. React components >250 LOC get extracted into smaller components. `gateway_bridge.rs` `ALLOWED_METHODS` stays hardcoded per `I7`.

**SDK + client:** Published packages get SOLID refactors only where it's a clean win. Breaking surface changes require a version bump and explicit migration notes in the PR description.

**mcp-connectors:** After pass 4, each `server.ts` is ~30 lines. SOLID is implicit at that size.

**vscode-extension:** Comment strip + dedupe; SOLID not needed at current size.

### Pass 6 — Verify

Final commit on the branch before opening the PR. No code changes.

1. `bun run preflight` — full local CI parity. Must pass; fix anything that doesn't in a new commit.
2. `bun run audit:invariants` — D10 (I15) + D12 (I14) + vault-key allow-list.
3. `bun run audit:cross-platform` — backslash/drive-letter detection.
4. `bun run audit:openapi-drift` — OpenAPI vs `READ_ONLY_HTTP_ROUTES`.
5. `bun run audit:coverage-floor` — per-file 80% floor. On Windows this may falsely pass; reproduce on Linux via the docker recipe in CLAUDE.md before opening the PR.
6. `cd packages/ui/src-tauri && cargo test` — four allowlist tests plus `no_timeout_methods_*`.
7. Manual diff sanity check via `git log main..HEAD --stat`.

PR description template:

- Headline: "Monorepo cleanup pass — comment strip, dedupe, SOLID".
- Section per pass with commit SHA + one-line summary.
- "What did NOT change" section listing the constraints in §8.
- Reviewer guide: "Read commit by commit. Pass 3 is huge but mechanical — diff `scripts/cleanup/strip-comments.ts` first, then trust the output."

## Hard constraints — what will NOT change

These are load-bearing structural defenses, not API. Aggressive on externals does not extend to them.

- **Security invariants I1–I16.** Every wiring site stays wired. Every enforcement test in `security-invariants.test.ts` stays green. If a SOLID refactor moves a wiring site, the test assertion moves with it in the same commit.
- **HITL `HITL_REQUIRED` frozen set membership and module-privacy** (I2). The set stays in `engine/executor.ts`, populated at module init, never widened at runtime.
- **`hitlStatus` set only by the consent gate** (I4). No handler hardcodes `"approved"`.
- **Tauri `ALLOWED_METHODS` array.** Method renames update the allowlist + count assertion in lockstep. The `cargo test` gate enforces this.
- **OpenAPI ↔ HTTP route drift.** Same lockstep rule for `POST /v1/deployments` and the read-only routes.
- **Vault key names** for already-deployed users. Vault keys are user data — renaming `openai.api_key` silently loses tokens after upgrade. Out of scope.
- **License fields** in every `package.json` (AGPL-3.0 for gateway/cli/connectors, MIT for sdk/client). Non-negotiable per CLAUDE.md.
- **Audit chain BLAKE3 format.** Change invalidates existing user audit chains.
- **Cross-platform parity.** Anything added or refactored works identically on Windows, macOS, Linux. `audit:cross-platform` catches obvious failures.
- **Test files** stay frozen. Touched only when a refactored module's import path or signature genuinely changes; assertions never edited.

## Risks

- **Mega PR review burden.** Mitigated by committing pass-by-pass and theme-by-theme, with the PR description guiding the reviewer through the order. Pass 3 is the largest diff but is mechanical; the reviewer can verify by re-running the strip script.
- **Merge conflicts with in-flight work.** No active feature branches at the time of writing. Mitigated by landing this before any new feature work starts.
- **Coverage-floor drift on Linux.** Mitigated by running the docker-based Linux check before opening the PR per CLAUDE.md.
- **Invariant test failures from moved wiring sites.** Every refactor commit that moves a wiring site updates the matching `security-invariants.test.ts` assertion in the same commit. The triple rule (production wiring + docs entry + enforcement test) holds.
- **`@nimbus-dev/sdk` / `@nimbus-dev/client` published API churn.** Mitigated by treating these as the most conservative packages in the tree — refactor only where it's a clean win, and bump the version with explicit migration notes if breaks ship.

## Review-driven amendments (2026-05-28)

After initial spec review (`2026-05-28-monorepo-cleanup-design-review.md`):

- **JSDoc on internal code stays stripped** (reviewer suggested preserving). Honors the explicit "strip all comments" direction; type *shapes* still produce IDE tooltips via the TypeScript type system. Type-field *narrative* migrates to the new `docs/internals/types-reference.md` target in pass 2.
- **TODO/FIXME/HACK/XXX added to the pass 1 grep.** Triage rule documented above — concrete-task markers migrate to `docs/internals/known-todos.md`; stale ones are delete-only.
- **`runConnectorSync` god-function risk addressed.** Pass 4 now specifies composition via strategy interfaces (`Pagination`, `AuthHeaderProvider`, `RateLimitObserver`) over a parameter-flag bag. Outlier connectors opt out explicitly with a leading docs entry.
- **One mega PR retained over two-PR split.** Honors the explicit delivery choice. Mitigations: pass 3 is a single-script mechanical commit reviewable by inspecting the script; passes 4–5 commits cite punch-list rows. If the PR is unreviewable in practice, splitting later is cheap (rebase passes 4–5 onto a fresh branch).

## Open questions

None at the time of writing. Open questions surfaced during implementation get appended below with a date stamp.
