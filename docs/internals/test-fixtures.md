# Test fixture narrative

Rationale for non-obvious test fixture and isolation choices, migrated from inline comments. Each entry is dated and cites the source file:line where the fixture lives.

## Entries

### HITL subscription wiring test is shallow by design

**Source:** `test/node-compat.test.ts:206` in the standalone [nimbus-agent/nimbus-client](https://github.com/nimbus-agent/nimbus-client) repo — added 2026-05-28, while the client workspace still lived in this monorepo (extracted in #758)
**Original comment (excerpt):** `The Gateway in test mode does not naturally fire HITL on a passive socket connection; this test only asserts the subscription wires up without throwing. A full HITL roundtrip is covered by the integration test in the gateway package.`

The `subscribeHitl` node-compat test intentionally stops at verifying that the returned subscription object exposes a `dispose` function. Triggering a live HITL event would require a full Gateway subprocess and a write action — that scenario is owned by the integration tests in `packages/gateway/test/integration/`.

---

### Auto-approving ToolExecutor stub in data-rpc tests

**Source:** `packages/gateway/src/ipc/data-rpc.test.ts:25` — added 2026-05-28
**Original comment (excerpt):** `Auto-approving stub executor that bypasses HITL for tests that just want to exercise the post-gate code path.`

`data-rpc` tests need to reach the code that runs after HITL approval without wiring a full consent round-trip. The `approvingExecutor` stub short-circuits `gate()` to always return `"proceed"`, allowing the test to focus on the data-export/import logic rather than the consent channel. Tests that verify the HITL gate itself live in `packages/gateway/src/engine/` — `executor.test.ts` and its siblings, co-located with the gate.

---

### `process.exitCode` snapshot-and-restore pattern

**Source:** `packages/cli/src/commands/update.test.ts:55` — added 2026-05-28
**Original comment (excerpt):** `Snapshot + restore the process.exitCode so cross-test bleed-through doesn't leak into adjacent suites. process.exitCode is typed as number | string | null | undefined on recent Node — coerce to a plain number on save and re-assign verbatim on restore.`

Bun inherits Node's mutable `process.exitCode` field. Tests that exercise the update-check path intentionally set a non-zero exit code to signal update-available; without the snapshot/restore pair, the exit code leaks into adjacent tests and can make the coverage threshold check appear to fail. The `beforeEach` / `afterEach` guards capture and reset the field around every case in the suite.

---

### Routing-runtime test injects embedder via parameter, not `mock.module`

**Source:** `packages/gateway/src/embedding/create-routing-runtime.test.ts:35` — added 2026-05-28
**Original comment (excerpt):** `The local MiniLM embedder is injected into tryCreateRoutingEmbeddingRuntime via its createEmbedder param (not mock.module) — a process-global model.ts mock would leak a fake into the sibling model.test.ts.`

`mock.module` operates at process-global scope in Bun. Because `create-routing-runtime.test.ts` and `model.test.ts` run in the same process during combined-suite execution, a `mock.module("./model.ts")` call in either file contaminates the other. The fix is dependency injection: `tryCreateRoutingEmbeddingRuntime` accepts a `createEmbedder` factory parameter, so tests supply a fake without touching the module registry.

---

### Lazy-scheduler failure-path test injects embedder factory via parameter

**Source:** `packages/gateway/src/embedding/lazy-scheduler.test.ts:462` — added 2026-05-28
**Original comment (excerpt):** `The embedder factory is injected via the 6th param (after the optional preloadedEmbedder) — not mock.module(model.ts), which would leak a process-global fake into the sibling model.test.ts.`

Same isolation rationale as the routing-runtime test above. The lazy-scheduler failure-path cases need a `throwingCreateEmbedder` factory that simulates a `createLocalEmbedder` crash; the factory is threaded through as a positional parameter rather than via `mock.module` to avoid the cross-test leak.

---

### `model.test.ts` uses parameter injection to stay leak-proof

**Source:** `packages/gateway/src/embedding/model.test.ts:9` — added 2026-05-28
**Original comment (excerpt):** `createLocalEmbedder takes an injected loadPipeline (the @xenova boundary shim) so its body is unit-testable with a fake pipeline. We use parameter injection rather than mock.module deliberately: sibling embedding tests (create-routing-runtime, lazy-scheduler) used to mock.module(model.ts) process-globally, which leaked fakes into this file. They now inject too, so a plain default-parameter fake is leak-proof.`

`model.ts` exposes `createLocalEmbedder(options, loadPipeline)` where `loadPipeline` defaults to the real `@xenova/transformers` shim. Tests supply a synthetic `FakeTensor`-returning pipeline via the second parameter. This is the canonical solution to the three-way test contamination that occurred when any of the three embedding test files used `mock.module`.

---

### `model.ts` default-parameter pattern preserves `mock.module` safety

**Source:** `packages/gateway/src/embedding/model.ts:57` — added 2026-05-28
**Original comment (excerpt):** `loadPipeline is injected for tests only — production callers pass a single argument and get the real @xenova/transformers loader (the shim). Injection (rather than mock.module) is deliberate: sibling embedding tests (create-routing-runtime, lazy-scheduler) mock.module this very module process-globally, so a mock.module-based test here would be clobbered by their fakes.`

The `loadPipeline` parameter has a default (`loadFeatureExtractionPipeline`) so production callers remain unchanged. The explicit annotation keeps future contributors from reflexively adding a `mock.module` import when testing this module — the default-parameter pattern is the intentional alternative that survives combined-suite parallelism.

---

### Worker-security test uses PropertyDescriptor capture to avoid origin leak

**Source:** `packages/gateway/src/platform/worker-security.test.ts:12` — added 2026-05-28
**Original comment (excerpt):** `getGlobalOrigin reads globalThis.origin — we stub it via PropertyDescriptor capture/restore so we never leak state into sibling tests.`

`isAcceptableWorkerOrigin` reads `globalThis.origin` at call time. Overwriting `globalThis.origin` directly in a test would permanently alter the global for subsequent tests. The PropertyDescriptor save/restore pattern (capture the original descriptor in `beforeEach`, restore it in `afterEach`) ensures each test case starts with a clean slate regardless of run order or parallelism.

---

### Pipedrive fake-server test captures structured logs for token-leak assertion

**Source:** `packages/gateway/test/integration/connectors/pipedrive-sync-fake-server.test.ts:101` — added 2026-05-28
**Original comment (excerpt):** `Capture every structured log line so the token-leak assertion can scan them.`

Pipedrive encodes its API token as a query-string parameter (`?api_token=…`), making it unusually easy to accidentally log. The fake-server test wires a custom Pino `write` destination that collects every log line into a `CapturedLog[]` array. After each sync, the test asserts that no captured line contains the test token value, exercising the logger-redaction path in the same integration harness that exercises the sync logic.
