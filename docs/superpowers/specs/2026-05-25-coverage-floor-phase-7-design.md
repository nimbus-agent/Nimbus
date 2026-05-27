# Coverage Floor Phase 7 — Packages + Closeout

**Date:** 2026-05-25
**Spec parent:** [`2026-05-17-coverage-floor-design.md`](./2026-05-17-coverage-floor-design.md) §"Phasing"
**Direct predecessor:** [`2026-05-22-coverage-floor-phase-6-design.md`](./2026-05-22-coverage-floor-phase-6-design.md)
**Branch:** `dev/asafgolombek/coverage-floor-phase-7-2026-05-25`
**Worktree:** `.worktrees/coverage-floor-phase-7-2026-05-25/`
**Branched from:** `origin/main` at `f196b03f` (Phase 6 merge, PR #422 — includes the ArgoCD connector PR #424)

---

## Goal

Take the per-file coverage-floor baseline from **51 → 10 entries** by closing every remaining non-CLI bucket. After Phase 7 the only baselined files are the **10 CLI deep cuts** (9 commands + `lib/gateway-process.ts`) that Phase 6 explicitly deferred — those are the entire scope of Phase 8 and the program's finale.

The 51 entries on `origin/main` break down as:

| Bucket | Count | Phase 7 disposition |
|---|---|---|
| Client package (`@nimbus-dev/client`) | 5 | 3 raised to ≥80% (`ipc-transport`, `nimbus-client`, `mock-client`); 2 excluded (`index.ts` barrel, `stream-events.ts` types) |
| Nimbus SDK (`@nimbus-dev/sdk`) | 3 | 2 raised to ≥80% (`crypto/verify-signature`, `ipc/ndjson-line-reader`); 1 excluded (`ipc/index.ts` barrel) |
| Gateway leftover | 1 | `embedding/model.ts` raised to ≥80% via sibling-shim DI refactor |
| MCP connector `server.ts` | 31 | already structurally exempt — **pruned from baseline** (no new tests) |
| MCP connector `jenkins-api.ts` | 1 | raised to ≥80% (the only below-floor connector source file) |
| **CLI deep cuts** | **10** | **out of scope — deferred to Phase 8** |

**Expected outcome:** baseline 51 → 10 (41 entries removed: 34 pruned because already-exempt, 7 raised to ≥80%). Four new structural exclusions are added (3 barrels/types + 1 dynamic-import shim created during the `model.ts` refactor).

---

## Approach

Unlike Phase 6 — 51 homogeneous CLI command files sharing one new harness — Phase 7's files are **heterogeneous across four packages with sharply different risk profiles**. There is no single shared harness; each bucket reuses the patterns already present in its own package. The phase is therefore structured as a sequence of small, independent commits ordered low-risk → high-risk, with the lcov-dependent baseline drop confined to the final commit (the Phase 5/6 CI-Linux-authoritative discipline).

### The two kinds of baseline removal

This phase removes 41 baseline entries, and they fall into two categories with **different safety properties**:

1. **Exempt-prune (no lcov dependency, 34 entries).** The 31 `mcp-connectors/*/src/server.ts` entries are already matched by the `exclusions.ts` pathRegex; the 3 barrel/type files become exempt the moment their exclusion entries are added. An exempt file is skipped by `evaluateCheck` rule 1 *before* the baseline ratchet runs, and its lcov value is irrelevant (it produces none). Removing these from the baseline is safe in an **early commit** regardless of local-vs-CI lcov divergence.

2. **Raised-to-≥80% (lcov-dependent, 7 entries).** `ipc-transport`, `nimbus-client`, `mock-client`, `verify-signature`, `ndjson-line-reader`, `jenkins-api`, `model.ts` are removed only because real tests lift them above the floor. Their removal **must** be confirmed against CI-Linux-equivalent measurement, so it lands in the **final commit** only (Phase 5 Task 9 was reverted for editing the baseline against local Windows lcov mid-task — fixup `06628373`).

### Why the 31 connector `server.ts` entries are a prune, not a test-writing exercise

`exclusions.ts` already carries `{ kind: "pathRegex", re: /^packages\/mcp-connectors\/[^/]+\/src\/server\.ts$/ }`. Every connector `server.ts` ends with a top-level `await mcp.connect(new StdioServerTransport())`, which is structurally unreachable from the in-process test layer (same exemption rationale as `cli/src/index.ts`, `gateway/src/index.ts`, and `github-actions/*/src/main.ts`). The entries linger in the baseline only because `computeUpdatedBaseline` never prunes an exempt-but-baselined entry (its pass-1 loop keeps the watermark when `actualPct` is 0). They are pure dead weight; removing them is a one-line-per-entry baseline edit.

**Contract tests are NOT part of this.** Every one of the 31 connectors already ships `test/sandbox.test.ts` (`runSandboxContractTests`, gated behind `describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])`), and that harness spawns the sandbox probe as a **subprocess** — it contributes **zero in-process lcov** and never imports `server.ts`. Adding `runContractTests`-style manifest validators would be ~31 near-identical files that move no coverage number and duplicate coverage already on the SDK's `contract-tests.ts`. They are explicitly **out of scope**.

### The one genuinely novel piece: `model.ts` sibling-shim DI

`packages/gateway/src/embedding/model.ts` sits at 13.51% because its only meaningful logic lives inside `createLocalEmbedder`, whose first line is `const { env, pipeline } = await import("@xenova/transformers")`. `@xenova/transformers` pulls `onnxruntime-node`, which cannot load under `bun test` on CI. Phase 5 moved the import *inside* the function (so the gateway boots without libonnxruntime) but did **not** extract a testable seam — there is **no** `load-transformer-pipeline.ts` today (the Phase 6 spec's transition note assumed one existed; it does not).

The refactor (Phase 6 spec's deferred "Phase 9", chosen here as a coverage push rather than an exclusion):

- Create `packages/gateway/src/embedding/load-feature-extraction-pipeline.ts` — a thin shim that encapsulates the **entire** `@xenova/transformers` touch: the dynamic import, the `env.cacheDir` assignment, and the `pipeline("feature-extraction", ...)` call. It returns the ready `pipe` callable. This shim is **structurally excluded** (it is irreducibly the dynamic-import boundary — same rationale as `embedding/embedding-worker.ts`, already excluded).
- `model.ts` keeps everything testable: the `NIMBUS_EMBEDDING_MODEL_DIR` override resolution, the call to the shim, the returned `Embedder` closure, the `embed()` empty/non-empty branches, and `tensorToRowVectors` (both the rank-guard throw and the slicing loop).
- `model.test.ts` mocks **only the shim path** (`load-feature-extraction-pipeline.ts`), not `model.ts`. This sidesteps the process-global `mock.module` collision that defeated the original `model.test.ts`: `create-routing-runtime.test.ts` mocks `model.ts` itself, and because that registration is process-global and survives `mock.restore()`, the old `model.test.ts` could not intercept the `@xenova` import. Mocking a **different module path** (the shim) avoids the collision entirely. The shim mock is restored to the real module in `afterAll`.

`createLocalEmbedder`'s signature does not change, so none of its five call sites (`create-routing-runtime.ts`, `embedding-worker.ts`, `lazy-scheduler.ts`, `index-reembed-rpc.ts`, plus the `LOCAL_EMBEDDING_MODEL_ID` consumer `worker-bridge.ts`) are touched.

### The client `ipc-transport.ts` injection seam

`IPCClient` (278 LOC, 10.81%) directly calls `Bun.connect()` / `node:net.createConnection()` inside `connect()`, so its connection paths and JSON-RPC dispatch are unreachable without a real socket. The package already proves the testable pattern elsewhere: `ask-stream.test.ts` drives `createAskStream` through a hand-rolled `FakeIpc` (a `{ call, onNotification, emit }` object). Phase 7 extends `IPCClient` with a **backward-compatible optional injected transport** so its `call` / notification-dispatch / `disconnect` / `failAll` logic is exercised without a socket, while the public constructor `new IPCClient(socketPath)` and the published API surface stay unchanged (verified against the existing `node-compat.test.ts`). The platform-branching `connect()` body that selects `Bun.connect` vs `net.createConnection` remains the one part that needs a live socket; if it cannot reach ≥80% after the dispatch logic is covered, the residual is held at a raised watermark (spec rule 3), not excluded.

### Reuse, don't invent

- **Client + SDK + jenkins-api** reuse each package's existing test conventions (the `FakeIpc` object in `client/test/ask-stream.test.ts`; the `mkdtemp` fs-isolation in `client/test/discovery.test.ts`; in-test Ed25519 keypair generation; `globalThis.fetch` stubs with `process.env` save/restore). **The Phase 6 CLI harness (`packages/cli/test/helpers/`) is NOT reused** — it is CLI-package-specific.
- **No `mock.module` for cross-package IPC.** Client tests inject `FakeIpc` directly. The only `mock.module` in this phase is `model.test.ts` mocking the new shim path, and it follows the snapshot-restore discipline.

---

## Scope

### Tier X — Structural exclusions (barrels / types / shim)

| File | Baseline | Justification |
|---|---|---|
| `packages/client/src/index.ts` | 0% | Pure re-export barrel (`export { … } from` + `export type`). Zero runtime emit after TS erasure; bun's V8 coverage reports no executable lines. Same rationale as `gateway/src/connectors/index.ts` (already excluded). |
| `packages/client/src/stream-events.ts` | 0% | `export type` only — a discriminated union + 3 type aliases. Zero runtime emit. Does **not** match the existing `types.ts` / `-types.ts` basename regexes, so it needs an **exact** entry. |
| `packages/sdk/src/ipc/index.ts` | 0% | Pure re-export barrel of `ndjson-line-reader.js`. Zero runtime emit. Same rationale as the client barrel. |
| `packages/gateway/src/embedding/load-feature-extraction-pipeline.ts` | (new file) | The irreducible `@xenova/transformers` dynamic-import boundary — cannot load `onnxruntime-node` under `bun test`. Same rationale as `embedding/embedding-worker.ts` (already excluded). Added in the `model.ts` refactor commit, when the file is created. |

Each entry is mirrored into `sonar-project.properties` line 65 (`sonar.coverage.exclusions`) and verified by `bun run audit:exclusion-parity`.

### Tier P — MCP `server.ts` baseline prune (31 entries, 0 tests)

Remove these already-exempt entries from `coverage-baseline.json`. No source or test changes; no `exclusions.ts` change (the pathRegex already covers them):

```
aws, azure, bitbucket, bitrise, circleci, confluence, datadog, discord, gcp,
github-actions, github, gitlab, gmail, google-drive, google-photos, grafana,
iac, jenkins, jira, kubernetes, linear, newrelic, notion, obsidian, onedrive,
outlook, pagerduty, sentry, slack, snyk, teams   (each .../src/server.ts)
```

### Tier S — SDK real tests (2 files)

| File | Baseline | Approach |
|---|---|---|
| `packages/sdk/src/crypto/verify-signature.ts` | 18.68% | New `verify-signature.test.ts`. Generate an Ed25519 keypair in-test via the file's own `generateEd25519Keypair()`; cover sign→verify round-trip, signature tampering (`SignatureInvalid`), publisher-key mismatch (`PublisherKeyMismatch`), malformed sig length + malformed declared pubkey + bad resolved-pubkey length (`SignatureInvalidFormat`), missing publisher/signature, base64 round-trip, and `errorToHardDisableReason` mapping for each error class + the unknown fallback. WebCrypto Ed25519 is available under bun. |
| `packages/sdk/src/ipc/ndjson-line-reader.ts` | 2.94% | Extend the existing `ndjson-line-reader.test.ts`. Cover partial lines across `push()` calls, `\r\n` trimming, empty-line skipping, oversized-pending and oversized-trimmed-line throws (`IPC_MAX_LINE_BYTES`), the custom `lineLimitError` constructor option, multi-byte UTF-8 across chunk boundaries, and `flush()` with/without pending content. |

### Tier C — Connector real test (1 file)

| File | Baseline | Approach |
|---|---|---|
| `packages/mcp-connectors/jenkins/src/jenkins-api.ts` | 17.89% | Extend the existing `src/jenkins-api.test.ts`. Stub `globalThis.fetch` and save/restore `process.env`. Cover `jenkinsBaseUrl` (missing/empty/trim), `jenkinsAuthHeader` (missing user/token/both), `getJenkinsCrumb` (cache hit, ok+valid JSON, !ok, parse error, non-object JSON, missing crumb fields), `jenkinsFetchJson` (200+JSON, error status, unparseable body, header merge), `jenkinsPost` (with/without crumb), and `jobPathFromFullName` empty/whitespace throw. **The module-level `crumbCache` singleton must be reset between tests.** |

### Tier L — Client real tests (3 files)

| File | Baseline | Approach |
|---|---|---|
| `packages/client/src/mock-client.ts` | 15.71% | New `mock-client.test.ts` (the existing one tests only `queryItems`). No I/O — exercise every method: `agentInvoke` (default + `reply` fixture), `askStream` (default tokens, custom `streamTokens`, cancel-before and cancel-during iteration, `done` event), `subscribeHitl` (returns disposer), `getSessionTranscript`, `cancelStream`, `queryItems` (empty + fixtures), `querySql`, `auditList`, `close`. |
| `packages/client/src/nimbus-client.ts` | 8.05% | New `nimbus-client.test.ts`. Inject a `FakeIpc` (mirror `ask-stream.test.ts:8-31`). Assert each method's RPC method-name + params + result handling: `agentInvoke` (param spread for optional `sessionId`/`agent`/`stream`), `askStream` delegates to `createAskStream`, `subscribeHitl` type-guard filtering (valid vs malformed notifications), `getSessionTranscript`, `cancelStream`, `queryItems`, `querySql`, `auditList` (default + custom limit), `close`. |
| `packages/client/src/ipc-transport.ts` | 10.81% | Backward-compatible injectable-transport seam (additive optional constructor param), then `ipc-transport.test.ts` exercising `call` happy path + not-connected throw, response routing by id, error-field rejection, notification dispatch via `onNotification`, multi-pending independence, `disconnect`/`failAll`, and NDJSON `ingest` of partial frames. The live `Bun.connect`/`net.createConnection` selection in `connect()` is the residual; hold at raised watermark if <80%. |

### Tier G — Gateway `model.ts` sibling-shim DI (1 file + 1 new excluded shim)

| File | Baseline | Approach |
|---|---|---|
| `packages/gateway/src/embedding/load-feature-extraction-pipeline.ts` | (new) | Thin shim: dynamic-import `@xenova/transformers`, set `env.cacheDir`, return `await pipeline("feature-extraction", repo)`. Excluded (Tier X). |
| `packages/gateway/src/embedding/model.ts` | 13.51% | Refactor `createLocalEmbedder` to call the shim instead of importing `@xenova` directly (signature unchanged). Rewrite `model.test.ts` to `mock.module` the **shim path** (not `model.ts`), restore in `afterAll`. Cover override-resolution (env set vs unset), the `Embedder` closure, `embed([])` early-return, `embed([...])` → `tensorToRowVectors`, and `tensorToRowVectors` rank-guard throw via a rank-1 fake tensor. |

### Out of scope (Phase 8)

The 10 CLI deep cuts remain in the baseline at their current watermarks, untouched:

`commands/{connector,doctor,extension,repl,serve,start,test,tui,update}` + `lib/gateway-process.ts`. These need new infra (Ink test-render with stubbed stdin, real-subprocess harness) and are the entire scope of Phase 8.

---

## Commit Structure

Single PR, 7 commits ordered low-risk → high-risk:

| # | Commit subject | Files | Baseline effect |
|---|---|---|---|
| 1 | `chore(coverage-floor): prune exempt connector + barrel/type entries` | `exclusions.ts` (+3), `sonar-project.properties` (+3), `coverage-baseline.json` (−34) | −34 (31 server.ts + 3 barrels/types) |
| 2 | `test(sdk): cover verify-signature + ndjson-line-reader` | `verify-signature.test.ts` (new), `ndjson-line-reader.test.ts` (extend) | none (drop in commit 7) |
| 3 | `test(mcp): cover jenkins-api (fetch stub + env)` | `jenkins-api.test.ts` (extend) | none (drop in commit 7) |
| 4 | `test(client): cover mock-client + nimbus-client via FakeIpc` | `mock-client.test.ts` (new), `nimbus-client.test.ts` (new) | none (drop in commit 7) |
| 5 | `test(client): cover ipc-transport via injectable transport seam` | `ipc-transport.ts` (additive seam), `ipc-transport.test.ts` (new) | none (drop in commit 7) |
| 6 | `test(embedding): sibling-shim DI for model.ts coverage` | `load-feature-extraction-pipeline.ts` (new), `model.ts` (refactor), `model.test.ts` (rewrite), `exclusions.ts` (+1), `sonar-project.properties` (+1) | none (drop in commit 7) |
| 7 | `chore(coverage-floor): drop raised entries + Phase 7 plan + status row` | `coverage-baseline.json` (−7), `CLAUDE.md`, `GEMINI.md`, this spec + plan + review docs | −7 (the raised entries) |

**Totals:** ~60 new test cases across ~6 test files (2 new + 3 new + 1 extend in client/sdk/mcp), 1 source refactor (`model.ts` + shim), 1 additive source seam (`ipc-transport.ts`), 4 new exclusions, 41 baseline entries removed.

**Ordering rationale:**

- Commit 1 first: pure config / already-exempt prune, zero reversibility risk (Phase 5/6 precedent for the structural-exclusion commit going first).
- SDK (commit 2) before client: fully deterministic pure logic (crypto round-trip, stream framing), no source changes — the cleanest possible warm-up.
- jenkins-api (commit 3): one isolated file, `fetch` stub — low risk, no source change.
- Client FakeIpc tests (commit 4) before the `ipc-transport` seam (commit 5): commit 4 needs no source change; commit 5 touches a published MIT package's source and is the higher-risk client work.
- `model.ts` (commit 6) last of the test commits: the only novel refactor + the only `mock.module` in the phase.
- Commit 7 drops the 7 raised entries. **`update-baseline` is run only here, hand-curated against CI-Linux measurement** (never mid-task).

---

## Test Infrastructure

No new shared harness. Each package reuses its own existing patterns:

### Client `FakeIpc` (already in `client/test/ask-stream.test.ts:8-31`)

```typescript
class FakeIpc {
  calls: Array<{ method: string; params: unknown }> = [];
  notifHandlers = new Map<string, ((p: unknown) => void)[]>();
  async call(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return this.responses.shift() ?? null; // test seeds responses
  }
  onNotification(method: string, handler: (p: unknown) => void): void { /* register */ }
  emit(method: string, params: unknown): void { /* invoke handlers */ }
  async disconnect(): Promise<void> {}
}
```

`NimbusClient` holds a private `IPCClient`; tests construct it via the factory and substitute the fake (the existing `nimbus-client-surface.test.ts` shows the introspection seam; the new test drives real method calls).

### `ipc-transport.ts` injectable seam (additive, backward-compatible)

The public `new IPCClient(socketPath)` stays. Add an optional second arg (or an internal `setTransport` used only by tests) shaped like the minimal duplex the dispatch logic needs: `{ write(line): void; onData(cb): void; onClose(cb): void; onError(cb): void; end(): void }`. Tests feed NDJSON frames through `onData` and assert `call` resolves/rejects. Confirm `node-compat.test.ts` and the existing runtime test still pass.

### `model.test.ts` shim mock (the only `mock.module` in this phase)

```typescript
const SHIM = resolve(import.meta.dir, "load-feature-extraction-pipeline.ts");
const realShim = await import(SHIM);
beforeEach(() => {
  mock.module(SHIM, () => ({
    loadFeatureExtractionPipeline: async () => fakePipe, // returns the fake `pipe` callable
  }));
});
afterAll(() => {
  mock.module(SHIM, () => realShim); // restore for sibling test files in the same process
});
```

`fakePipe(texts, opts)` returns `{ data: Float32Array, dims: [batch, width] }`; a separate case returns `dims: [width]` (rank 1) to hit the `tensorToRowVectors` guard.

### Reused patterns

| Pattern | Used by |
|---|---|
| Hand-rolled `FakeIpc` object (no `mock.module`) | client `nimbus-client`, `mock-client` |
| `globalThis.fetch` stub + `process.env` save/restore | `jenkins-api` |
| In-test Ed25519 keypair via `generateEd25519Keypair()` | sdk `verify-signature` |
| `mkdtemp` fs isolation (`client/test/discovery.test.ts`) | none expected (no fs in scope) |
| `mock.module` of a sibling shim path + `afterAll` restore | gateway `model.ts` only |

---

## Carry-forwards

### Phase 4 (still apply)

- **CI Linux is authoritative.** Never lower a baseline watermark to match local Windows lcov — only match CI Linux.
- TS strictness: `noUncheckedIndexedAccess` (`arr[i]?.x`), `noPropertyAccessFromIndexSignature` (`obj["key"]`), `exactOptionalPropertyTypes: true` (omit the prop, don't pass `undefined`).
- `bun:test`'s `test.each(table)` requires a **mutable** array — never `readonly T[]`.
- `fetch` stubs: throwing closures infer `Promise<never>` → `as unknown as typeof fetch`; `Response`-returning closures → `as typeof fetch`.
- IDE false positives to ignore: `await expect(...).rejects.toThrow()` "await has no effect"; `bun:sqlite`/`bun:test` "declared but never read"; `replaceAll` "not on string"; `node:path.join` "missing slash" on Windows.
- Run `bun run lint:fix` before every commit.

### Phase 5/6 execution (Phase 7 guardrails)

1. **`mock.module(...)` is process-global AND only affects FUTURE imports.** `build-lcov.sh` runs `bun test --coverage` **once per package**, so a `mock.module` in one test file leaks to every later file in that package's process; `afterAll` restore does not undo it for files already loaded. **Phase 7 application:** the only `mock.module` is `model.test.ts` → the shim path; it restores to the real module in `afterAll`, and it deliberately mocks the **shim**, not `model.ts`, to avoid colliding with `create-routing-runtime.test.ts`'s `model.ts` mock. Everywhere else, use hand-rolled `FakeIpc` injection — no `mock.module`.
2. **Never run `bun run audit:coverage-floor:update-baseline` mid-task.** Local lcov diverges from CI Linux on pinned files (Phase 5 Task 9 reverted in `06628373`). Baseline edits land in **commit 7 only**, hand-curated. The exempt-prune in commit 1 is hand-edited (no `update-baseline`) and is lcov-independent.
3. **`node:path.join` is platform-dependent.** Use `join(...)` against the same operands the source uses; never hardcode separators.
4. **Don't commit auto-modified files** (e.g. `.claude/settings.local.json`). Stage explicit paths; never `git add -A`/`git add .`.
5. **Branch-update strategy.** `origin/main` moves fast (it already absorbed PR #424 after #422). Merge `origin/main` as needed; `CLAUDE.md`/`GEMINI.md` status rows conflict — keep both the Phase 7 row and any new rows from main.
6. **The plan's per-file case suggestions are guesses.** Read the source FIRST, target the actual uncovered branches, document divergence in implementer reports.
7. **Module-singleton state in tests.** `jenkins-api.ts`'s `crumbCache` and any other module-level singleton must be reset between tests (re-import or an exported reset), or cache-hit/miss branches cross-contaminate.

---

## Acceptance

1. `bun run audit:coverage-floor:build-lcov && bun run audit:coverage-floor` exits 0 locally (CI Linux authoritative for the merge gate).
2. `bun run audit:exclusion-parity` exits 0 — `sonar-project.properties` and `exclusions.ts` agree on the 4 new entries.
3. `bun run audit:invariants` exits 0 — D10 / D12 / vault-key allow-list unchanged.
4. `bun run lint` + `bun run typecheck` exit 0.
5. Baseline drops from 51 → 10: 34 exempt entries pruned (31 `server.ts` + `client/index.ts` + `client/stream-events.ts` + `sdk/ipc/index.ts`) and 7 raised to ≥80% and removed (`ipc-transport`, `nimbus-client`, `mock-client`, `verify-signature`, `ndjson-line-reader`, `jenkins-api`, `model.ts`). The 10 CLI deep cuts remain at their current watermarks.
6. No file currently ≥80% drops below 80% — enforced by the floor gate.
7. `@nimbus-dev/client`'s published API is unchanged — `new IPCClient(socketPath)` and all `index.ts` exports keep their signatures; `node-compat.test.ts` passes.
8. `createLocalEmbedder`'s signature is unchanged; its five call sites are untouched and the gateway still boots with embeddings disabled.
9. If `model.ts` or `ipc-transport.ts` genuinely cannot reach 80% after the refactor/seam, the file is **held at a raised watermark** (spec rule 3), not excluded and not dropped — and the implementer report states the residual uncovered branches.

---

## Risks

| Risk | Mitigation |
|---|---|
| `model.ts` lands below 80% after the shim refactor | With the shim owning the full `@xenova` touch, the entire `createLocalEmbedder` body + `tensorToRowVectors` (both branches) is reachable — projected ≥90%. If still short, raise the watermark (acceptance 9); do **not** exclude (the user chose a coverage push over exclusion). |
| `model.test.ts` shim mock collides with `create-routing-runtime.test.ts` | They mock **different module paths** (shim vs `model.ts`); the shim mock restores to the real module in `afterAll`. This is the exact fix the original `model.test.ts` comment said was needed. |
| `ipc-transport.ts` seam breaks the published `@nimbus-dev/client` API | The seam is an **additive optional** constructor param / internal setter; `new IPCClient(socketPath)` is unchanged. Acceptance 7 + the existing `node-compat.test.ts` gate it. |
| Pruning 31 exempt entries trips a gate | The exclusion pathRegex already covers them, so the floor gate skips them whether or not they're in the baseline. Exclusion-parity is `exclusions.ts`↔`sonar` only — baseline edits don't affect it. |
| Local Windows lcov diverges from CI for the 7 raised entries | Carry-forward 2: drop the 7 only in commit 7, against CI-Linux measurement; never `update-baseline` mid-task. |
| `jenkins-api.ts` `crumbCache` singleton leaks across tests | Carry-forward 7: reset the cache between tests (exported reset or fresh module import). |
| WebCrypto Ed25519 unavailable in the bun version used by CI | `verify-signature.ts` already uses `crypto.subtle` in production and the gateway has passing tests for it; the SDK test exercises the same path. If a CI bun lacks Ed25519 SubtleCrypto, the file's `generateEd25519Keypair()` Node fallback path is the seam — document any divergence. |
| Barrel/type files are not actually zero-emit on the CI bun | Confirmed by reading: `client/index.ts` and `sdk/ipc/index.ts` are `export … from` only; `stream-events.ts` is `export type` only. If any emits a line on CI, fall back to a real (trivial) test rather than the exclusion. |

---

## Out-of-band cleanup

The worktree was created before this spec at `.worktrees/coverage-floor-phase-7-2026-05-25/` on branch `dev/asafgolombek/coverage-floor-phase-7-2026-05-25` off `origin/main` at `f196b03f`, with `bun install` already run. Stale prior-phase worktrees under `.worktrees/` are git-ignored (disk cost only); leave them unless disk pressure requires `git worktree remove`.

---

## Phase 7 → Phase 8 transition

After this PR merges the baseline is **10 entries**, all CLI deep cuts:

`commands/connector` (40.5%), `commands/doctor` (46.22%), `commands/extension` (72.13%), `commands/repl` (74.36%), `commands/serve` (68.63%), `commands/start` (30.61%), `commands/test` (76.47%), `commands/tui.tsx` (45.59%), `commands/update` (34.18%), `lib/gateway-process.ts` (15.22%).

Phase 8 (the program's finale) splits these into:

- **Near-floor nudges** (`extension`, `test`, `repl`, `serve` — already 68–76%): small additional cases on the existing Phase 6 CLI harness.
- **Infra-needed** (`start`, `update`, `connector`, `tui`, `doctor`, `gateway-process` — 15–46%): need an Ink test-render with stubbed stdin and a real-subprocess harness for `gateway-process.ts`. Any file that genuinely cannot reach 80% is held at a raised watermark with a documented reason; the program closes when the baseline is empty of reducible entries.

The deferred architectural cleanups (refactor `cli/src/index.ts` + `gateway/src/index.ts` to expose `main()` for testing; dependency-inversion of the CLI dispatchers' IPC client) remain Phase 9+ candidates, unchanged by Phase 7.

---

## Review & Suggestions

Self-review pass. Each point shows the observation and the **Disposition** applied. The canonical write-up also lives in [`docs/superpowers/plans/2026-05-25-coverage-floor-phase-7-review.md`](../plans/2026-05-25-coverage-floor-phase-7-review.md).

**1. `model.ts` coverage-target confidence**
- **Observation:** An exploration agent estimated the sibling-shim refactor reaches "75–80%", which straddles the floor.
- **Disposition:** The agent's estimate assumed an Option B that left the `env` import in `model.ts` (which would throw under test). This spec's shim owns the **entire** `@xenova` touch, so `model.ts` has no residual dynamic import and the whole body is reachable (projected ≥90%). Acceptance 9 + the Risks row add the watermark-hold fallback as a safety net.

**2. `ipc-transport.ts` published-API risk**
- **Observation:** `@nimbus-dev/client` is MIT-published; a transport refactor could break consumers.
- **Disposition:** The seam is strictly additive (optional param / internal setter). Acceptance 7 pins the public surface and the existing `node-compat.test.ts` is the regression gate. The platform `connect()` body is explicitly allowed to stay below 80% via watermark-hold rather than forcing a risky refactor of socket selection.

**3. MCP scope correction**
- **Observation:** The original framing was "32 connector contract tests"; investigation showed all 31 already ship `test/sandbox.test.ts` and contract tests contribute zero lcov.
- **Disposition:** Scope reduced to a baseline prune of the 31 exempt entries + the one real `jenkins-api.ts` test. No new contract-test files (confirmed with the requester).

**4. Barrel/type exclusion vs the "coverage push" preference**
- **Observation:** The requester preferred coverage pushes over exclusions (for `model.ts`).
- **Disposition:** Barrels and `export type`-only files have **no executable lines** — a coverage push is impossible by construction, so exclusion is the structurally-correct classification (matching existing precedent), not a capitulation. `model.ts`, which *does* have logic, gets the push.

**5. Single PR vs split**
- **Observation:** Phase 6 was one 14-commit PR of homogeneous files.
- **Disposition:** Phase 7's heterogeneous, independent buckets are one PR of 7 commits; the genuinely hard, infra-heavy CLI deep cuts are a separate PR (Phase 8), per the requester's "two PRs, packages first" decision.
