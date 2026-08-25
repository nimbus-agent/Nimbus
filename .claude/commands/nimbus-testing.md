---
name: nimbus-testing
description: >
  Complete testing reference for Nimbus: which test layer to use, file naming/location,
  coverage gates, isolation rules, and ready-to-use patterns (HITL, IPC, Vault, connectors,
  UI components, E2E CLI). Use when writing a test, deciding where it belongs or which tool
  to use, checking coverage requirements, mocking the Gateway, or choosing integration-vs-unit.
  Consult before writing any test file.
---

# Nimbus Testing Reference

## Five-Layer Pyramid

| Layer | Tool | Scope | Speed | When to use |
|---|---|---|---|---|
| **1. Unit** | `bun test` | Single module, no I/O | Milliseconds | Logic, invariants, pure functions, HITL set membership |
| **2. Integration** | `bun test` + real SQLite | Multi-module, real DB | Seconds | Index queries, sync cycles, extension loading, Vault contracts |
| **3. E2E CLI** | `bun test` + Gateway subprocess | Full CLI → Gateway → mock MCP | Seconds–minutes | Command flows, connector auth, HITL round-trips |
| **4. UI Components** | Vitest + Testing Library | React components (jsdom) | Seconds | Tauri pages/components; use when `bun test` can't (no jsdom) |
| **5. E2E Desktop** | Playwright + Tauri WebDriver | Full desktop app | Minutes | Full Tauri flows; runs on push to `main` and release tags only |

**Pick the lowest layer that can meaningfully test the behaviour.** Unit first, integration only when DB state matters, E2E CLI only when the full Gateway process is required.

---

## File Naming & Location

**Colocation is the default, and it is the majority.** ~843 tests sit next to the code they test as `packages/*/src/**/<module>.test.ts`; ~453 live under a package's `test/` tree. A new unit test for a source module goes **beside that module**, not into `test/unit/`:

```
packages/gateway/src/engine/executor.ts
packages/gateway/src/engine/executor.test.ts        ← here
```

Every engine test lives in `packages/gateway/src/engine/` — `packages/gateway/test/unit/` has **no** `engine` subdirectory at all. Its actual subdirectories are `auth`, `config`, `connectors`, `db`, `deployment`, `ipc`, `metrics`, `people`, `preflight`, `sync`, `telemetry`; that tree is for tests that are not about a single source module (multi-module integration, fixture-heavy, or subprocess-driven):

```
packages/<pkg>/test/
  unit/<subsystem>/<module>.test.ts        e.g. ipc/deployment-rpc.test.ts
  integration/<subsystem>/<module>.test.ts e.g. db/migration-v28.test.ts
  e2e/scenarios/<scenario>.e2e.test.ts     e.g. scenarios/decisions.e2e.test.ts
```

UI tests (Vitest) are grouped by kind — there are **no** flat files directly under `packages/ui/test/`:
```
packages/ui/test/
  components/   e.g. components/GatewayOfflineBanner.test.tsx, components/hitl/HitlPopupPage.test.tsx
  hooks/  ipc/  layouts/  lib/  pages/  providers/  store/  e2e/
```

**Verify before you place a file.** These trees move; `ls` the sibling directory and copy whatever the neighbours do rather than trusting the shape above.

**Rule:** the test file lives in the same package as the code it tests. Never reach across packages in a test.

---

## Coverage Gates

**The live list is `SCOPE_GATES` in [`scripts/coverage-floor/check-scopes.ts`](../../scripts/coverage-floor/check-scopes.ts) — read it, do not trust a copy.**

This section used to hold a nine-row table. It had drifted badly: three of its rows named scopes that do not exist (`engine.askStream streaming path`, `Data export/import + audit chain`, `New subsystems`), and it omitted **nineteen** of the twenty-four scopes actually enforced. A hand-maintained duplicate of two dozen numbers is a drift generator, so it is deliberately not reproduced here.

Two gates, run by `audit:coverage-scopes` over the merged lcov:

- **Per-scope floors** — `SCOPE_GATES` maps a path glob to a minimum. A scope whose glob matches **zero** files FAILS rather than passing vacuously; that is the bug the gate was rebuilt to close.
- **Per-file ratchet** — `audit:coverage-floor`, **≥ 85% line AND ≥ 80% branch** (two separate constants, `FLOOR_PCT` / `BRANCH_FLOOR_PCT`).

Both denominators are non-exempt files only. Neither is enforced by the `test:coverage:*` scripts: their `--coverage-threshold-lines` flag **does not exist in Bun** and is silently ignored, and `bunfig.toml`'s `[test] coverage = false` suppresses collection anyway. `audit:coverage-floor` is **CI-Linux-authoritative** — a Windows run reports false violations.

---

## Isolation Rules (non-negotiable)

- **Every integration test gets a fresh temp dir + fresh SQLite DB.** Never share DB state between tests.
- **Unit tests have zero I/O.** No file system, no sockets, no real Vault calls.
- **E2E CLI tests use mock MCP servers.** Never call real cloud APIs in automated tests.
- **UI tests mock the Tauri `invoke` bridge.** Never open a real Gateway socket.
- **Vault in tests:** use the gateway-internal `MockVault` (`packages/gateway/src/vault/mock.ts`) — never the real DPAPI/Keychain/libsecret in unit or integration tests.

---

## Test shapes that go red only in CI

The CI runner is **~13–18× slower than a dev machine** at temp-dir SQLite work and shares a host
with other tenants. Two shapes pass locally on every run and fail in CI on some runs. Both have a
correct version — the fix is never to delete the test.

### Wall-clock assertions: guard the numerator, not just the denominator

Timing tests are the only thing that catches quadratic backtracking (a correctness test never
will), so the pattern stays. But an assertion like this is not measuring what it claims:

```ts
// Flags a ReDoS regression — and also a GC pause, a noisy neighbour, or a cold JIT.
expect(last / Math.max(first, 0.5)).toBeLessThan(16);
```

Flooring `first` protects against a *fast* baseline manufacturing a huge ratio. Nothing protects
against a slow `last`: one 8 ms scheduling stall on an operation whose true cost is 0.5 ms blows a
16× ceiling with the algorithm completely unchanged. That is a real macOS-leg failure
(`decisions/cue-mining.test.ts`, 2026-08-21).

- **Take the minimum of N repeats per size**, not a single sample. A stall inflates a measurement;
  it never deflates one, so `min` is the noise-robust estimator here.
- Floor **both** ends, and prefer a ceiling wide enough that only a complexity-class change trips
  it — the signal you want is 100×, not 16×.
- Assert the *shape* over ≥3 doublings rather than an endpoint ratio, so one bad sample can't
  carry the verdict alone.

### Sandboxed child processes get no ambient OS facilities

Sandbox grants are **leaf-only and deliberate** — do not widen a policy to make a test pass. That
means a child spawned through the wrapper cannot reach anything the policy did not name, including
things that look like language built-ins:

```ts
// Windows leg: exits 0, writes nothing, and stderr says
// "ConvertTo-Json is not recognized" — the cmdlet lives in Microsoft.PowerShell.Utility,
// which PowerShell auto-loads from $PSHOME\Modules, a path the policy does not grant.
IS_WIN ? "$args | ConvertTo-Json -Compress" : "process.stdout.write(JSON.stringify(...))"
```

The symptom is a **status 0 with empty stdout**, then a downstream `JSON.parse` failing with
`Unexpected EOF` — the parse error names the wrong culprit entirely. Write sandboxed child programs
against only what the policy grants, and assert on the child's `stderr` before parsing its `stdout`
so the failure names itself.

### A green cross-platform leg may have retried

Both retry wrappers (`ci.yml`, `_test-suite.yml`) re-run the whole suite once and emit a
`::warning title=Retry masked a failure::` annotation naming the failing test. A job that is green
but mysteriously slow probably paid for two full suite runs. **Read the annotations on a green
job**, not just the conclusion.

---

## Patterns by Subsystem

### HITL Executor (unit)

Test that the `HITL_REQUIRED` set contains what it should, and that the gate fires before any connector call. `executor.ts` exports the `HITL_REQUIRED` frozen set and the `ToolExecutor` **class** (there is no singleton `executor` and no `.run()` — instantiate `ToolExecutor` and call `.gate(action)`, where `action` is a `PlannedAction` `{ type, payload }`):

```ts
import { HITL_REQUIRED, ToolExecutor } from '../../engine/executor.ts';
import { NULL_EGRESS_SINK } from '../../egress/egress-ledger.ts';

describe('HITL gate', () => {
  it('requires consent for write actions', () => {
    expect(HITL_REQUIRED.has('email.send')).toBe(true);
  });

  it('allows read-only actions', () => {
    expect(HITL_REQUIRED.has('gmail.list')).toBe(false);
  });

  it('routes a HITL action through the consent gate', async () => {
    // FIVE required positional params — all of them, in order:
    //   (consent, audit, connectors, delegation | undefined, egressSink)
    const exec = new ToolExecutor(consent, audit, connectors, undefined, NULL_EGRESS_SINK);
    const result = await exec.gate({ type: 'email.send', payload: {} });
    // gate() returns "proceed" on approval, or an ActionResult on rejection
    expect(consent.requestApproval).toHaveBeenCalled();
  });
});
```

**The 4th and 5th params are required, not optional.** `delegation` takes an explicit `undefined` when there is none, and `egressSink` became required in #1038 (invariant `I29`) — a test that omits it does not compile. Use `NULL_EGRESS_SINK` (the *named* "this executor performs no egress" sink) when the test is not asserting on ledger rows, and a capturing fake when it is; an omitted optional would have been indistinguishable from forgetting to wire one, which is exactly why the parameter is positional and mandatory. Real call sites to copy: `packages/gateway/src/engine/audit-payload-safety.test.ts:55` and `engine.test.ts:537`.

The audit-before-dispatch ordering is enforced inside `gate()`; see `executor-delegation.test.ts` for the full `ToolExecutor` wiring (consent/audit/connector dependency injection).

### IPC Method (unit)

Mock the Gateway internals; test request/response serialisation and notification emission:

```ts
// packages/gateway/src/ipc/engine-ask-stream.test.ts
it('emits streamToken notifications then streamDone', async () => {
  const { notifications } = setupMockIpcSession();
  mockLlmRouter.setTokens(['hello', ' world']);

  const { streamId } = await ipc.call('engine.askStream', { prompt: 'hi' });

  const tokens = notifications.filter(n => n.method === 'engine.streamToken');
  const done   = notifications.find(n => n.method === 'engine.streamDone');

  expect(tokens).toHaveLength(2);
  expect(tokens.every(t => t.params.streamId === streamId)).toBe(true);
  expect(done.params.streamId).toBe(streamId);
});
```

### Tauri UI `ALLOWED_METHODS` (unit — Vitest)

```ts
// packages/ui/test/ipc/client.test.ts
it('rejects vault.get from the frontend', async () => {
  const result = await invoke('rpc_call', { method: 'vault.get', params: { key: 'x' } });
  expect(result.error.code).toBe(-32000); // ERR_METHOD_NOT_ALLOWED
});

it('allows connector.listStatus', async () => {
  mockGateway.connector.listStatus.mockResolvedValue([]);
  const result = await invoke('rpc_call', { method: 'connector.listStatus', params: {} });
  expect(result.error).toBeUndefined();
});
```

### Vault (unit — use MockVault)

`MockVault` is a gateway-internal helper at `packages/gateway/src/vault/mock.ts` (an in-memory `NimbusVault` — it never touches DPAPI/Keychain/libsecret). Import it via a relative path; it is **not** exported from `@nimbus-dev/sdk/testing`:

```ts
import { MockVault } from '../../vault/mock.ts'; // relative to packages/gateway/src/
// or: import { createMockVault } from '../../vault/mock.ts';

const vault = new MockVault();
await vault.set('github.pat', 'ghp_test');
expect(await vault.get('github.pat')).toBe('ghp_test');
```

### Integration test with fresh DB

```ts
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../src/db/migrations';

let tmpDir: string;
let db: Database;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'nimbus-test-'));
  db = new Database(join(tmpDir, 'nimbus.db'));
  await runMigrations(db);
});

afterEach(() => {
  db.close();
  // tmpDir cleaned up by OS on reboot; or use rmSync if you need immediate cleanup
});
```

### Multi-agent HITL (E2E CLI)

The canonical pattern for verifying HITL cannot be bypassed:

```ts
// packages/gateway/test/e2e/scenarios/hitl-write-ops.test.ts
it('parallel sub-agents cannot auto-approve HITL', async () => {
  const session = await gateway.runAsk('find my PRs and post summary to Slack');
  const plan = await gateway.ipc.call('agent.getSubTaskPlan', { sessionId: session.id });

  const hitlTasks = plan.subTasks.filter(t => t.hitlRequired);
  expect(hitlTasks.length).toBeGreaterThan(0);

  // Verify none executed before consent
  for (const task of hitlTasks) {
    const result = await db.get('SELECT status FROM sub_task_results WHERE id = ?', task.id);
    expect(result.status).toBe('hitl_paused');
  }
});

it('rejected sub-task marks transitive dependents as skipped not failed', async () => {
  // ... reject action A, assert B (depends on A) → skipped, C (no dependency) → unaffected
});
```

### Connector sync (integration)

```ts
it('transitions to rate_limited on 429', async () => {
  mockMcpServer.respondWith(429);
  await scheduler.runOnce('github');
  const state = await db.get('SELECT health FROM sync_state WHERE service = ?', 'github');
  expect(state.health).toBe('rate_limited');
});
```

### UI Component (Vitest + Testing Library)

```tsx
// packages/ui/test/components/hitl/HitlPopupPage.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { HitlDialog } from '../../src/components/HitlDialog';

it('renders action summary and calls onApprove', async () => {
  const onApprove = vi.fn();
  render(<HitlDialog actions={[{ actionId: 'a1', summary: 'Delete file.txt' }]} onApprove={onApprove} onReject={vi.fn()} />);

  expect(screen.getByText('Delete file.txt')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /approve/i }));
  expect(onApprove).toHaveBeenCalledWith(['a1']);
});
```

---

## Security-Specific Tests (required for HITL and Vault changes)

Every PR touching `executor.ts` or vault code must include tests for:

| Scenario | What to assert |
|---|---|
| HITL gate fires before connector dispatch | Audit log `append` call order < connector `dispatch` call order |
| HITL gate is not bypassable via config | Setting `hitlRequired = false` in config has no effect on the frozen set |
| No credential in IPC response | Vault `get` response never appears in any IPC `result` payload |
| No credential in logs | Logger output does not contain the literal token value |
| Audit log written on rejection | Rejected actions still appear in the audit log with `hitl_status = 'rejected'` |

---

## Running Tests

```bash
# Unit + integration (Gateway and CLI)
bun test

# With coverage
bun test --coverage

# UI components only
cd packages/ui && bunx vitest run

# UI with coverage
cd packages/ui && bunx vitest run --coverage

# Specific test file
bun test packages/gateway/src/engine/executor.test.ts

# E2E desktop (CI only — requires a built Tauri app + WebDriver).
# There is NO test:e2e:desktop script; CI runs the directory directly.
bun test packages/ui/test/e2e/

# Query latency benchmark (strict mode) — the only opt-in benchmark env var
# that exists. Read in packages/gateway/test/benchmark/item-query-latency.test.ts.
NIMBUS_RUN_QUERY_BENCH=1 bun test
```

---

## CI Test Matrix

| Trigger | Jobs |
|---|---|
| PR opened/updated | `pr-quality` on Ubuntu: lint (Biome), typecheck, unit + integration tests, `bun audit` — **plus** `pr-quality-cross-platform`: one `macos-15` leg and one `windows-2025` leg, each running the same whole-repo `bun test packages/gateway packages/cli packages/mcp-connectors scripts` as the push matrix, in one process |
| Push to `main` / `develop` | Full 3-platform matrix: `windows-2025`, `macos-15`, `ubuntu-24.04` |
| Push to `main` + release tags | E2E Desktop (Playwright + Tauri WebDriver) on all three platforms |

The PR cross-platform legs carry **no coverage and no packaging** — both are Ubuntu-only by design
(the coverage floor is CI-Linux-authoritative; packaging is a separate job). They **do** carry
integration and e2e: `bun test packages/gateway` recurses into every subdirectory, `test/integration/`
and `test/e2e/` included, and `bunfig.toml` configures no path exclusions. So a regression confined
to `test/e2e/` is a PR-time discovery now, not a post-merge one — that changed on 2026-08-23.

**Exactly one check gates the merge:** `PR quality — required gates`, an `if: always()` aggregator
over every other PR job. See the `nimbus-preflight` skill § _Merging_ — the ruleset's org-admin
bypass is silent, so merging before that check reports is the single largest source of red `main`.

Security scans run on every PR: `bun audit`, `trivy`, CodeQL. HIGH/CRITICAL findings block the merge.
