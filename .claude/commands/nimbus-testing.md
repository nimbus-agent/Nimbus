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

```
packages/<pkg>/test/
  unit/
    <subsystem>/
      <module>.test.ts          e.g. engine/hitl-executor.test.ts
  integration/
    <subsystem>/
      <module>.test.ts          e.g. db/migration-rollback.test.ts
  e2e/
    scenarios/
      <scenario>.e2e.test.ts    e.g. multi-agent-hitl.e2e.test.ts
```

UI tests (Vitest):
```
packages/ui/test/
  <Component>.test.tsx          e.g. HitlDialog.test.tsx
  ipc-client.test.ts
```

**Rule:** the test file lives in the same package as the code it tests. Never reach across packages in a test.

---

## Coverage Gates

| Subsystem | Minimum |
|---|---|
| Engine (`packages/gateway/src/engine/`) | ≥ 85% |
| Vault (`packages/gateway/src/vault/`) | ≥ 90% |
| Sync scheduler (`packages/gateway/src/sync/`) | ≥ 80% |
| Rate limiter | ≥ 85% |
| People graph | ≥ 80% |
| LLM layer (`packages/gateway/src/llm/`) | ≥ 85% |
| `engine.askStream` streaming path | ≥ 80% |
| Data export/import + audit chain | ≥ 85% |
| **New subsystems** | ≥ 85% (default target) |

Coverage is checked in CI on push to `main`. PRs that drop a gate fail the `pr-quality` job.

---

## Isolation Rules (non-negotiable)

- **Every integration test gets a fresh temp dir + fresh SQLite DB.** Never share DB state between tests.
- **Unit tests have zero I/O.** No file system, no sockets, no real Vault calls.
- **E2E CLI tests use mock MCP servers.** Never call real cloud APIs in automated tests.
- **UI tests mock the Tauri `invoke` bridge.** Never open a real Gateway socket.
- **Vault in tests:** use the gateway-internal `MockVault` (`packages/gateway/src/vault/mock.ts`) — never the real DPAPI/Keychain/libsecret in unit or integration tests.

---

## Patterns by Subsystem

### HITL Executor (unit)

Test that the `HITL_REQUIRED` set contains what it should, and that the gate fires before any connector call. `executor.ts` exports the `HITL_REQUIRED` frozen set and the `ToolExecutor` **class** (there is no singleton `executor` and no `.run()` — instantiate `ToolExecutor` and call `.gate(action)`, where `action` is a `PlannedAction` `{ type, payload }`):

```ts
import { HITL_REQUIRED, ToolExecutor } from '../../engine/executor.ts';

describe('HITL gate', () => {
  it('requires consent for write actions', () => {
    expect(HITL_REQUIRED.has('email.send')).toBe(true);
  });

  it('allows read-only actions', () => {
    expect(HITL_REQUIRED.has('gmail.list')).toBe(false);
  });

  it('routes a HITL action through the consent gate', async () => {
    // new ToolExecutor(consent, audit, connectors, delegation?)
    const exec = new ToolExecutor(consent, audit, connectors);
    const result = await exec.gate({ type: 'email.send', payload: {} });
    // gate() returns "proceed" on approval, or an ActionResult on rejection
    expect(consent.requestApproval).toHaveBeenCalled();
  });
});
```

The audit-before-dispatch ordering is enforced inside `gate()`; see `executor-delegation.test.ts` for the full `ToolExecutor` wiring (consent/audit/connector dependency injection).

### IPC Method (unit)

Mock the Gateway internals; test request/response serialisation and notification emission:

```ts
// packages/gateway/test/unit/ipc/engine-stream.test.ts
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
// packages/ui/test/ipc-client.test.ts
it('rejects vault.get from the frontend', async () => {
  const result = await invoke('rpc_call', { method: 'vault.get', params: { key: 'x' } });
  expect(result.error.code).toBe(-32000); // ERR_METHOD_NOT_ALLOWED
});

it('allows connector.list', async () => {
  mockGateway.connector.list.mockResolvedValue([]);
  const result = await invoke('rpc_call', { method: 'connector.list', params: {} });
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
// packages/gateway/test/e2e/scenarios/multi-agent-hitl.e2e.test.ts
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
// packages/ui/test/HitlDialog.test.tsx
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
bun test packages/gateway/test/unit/engine/hitl-executor.test.ts

# E2E desktop (CI only — requires Tauri WebDriver)
bun run test:e2e:desktop

# Query latency benchmark (strict mode)
NIMBUS_RUN_QUERY_BENCH=1 bun test

# LLM local benchmark gate
NIMBUS_RUN_LOCAL_BENCH=1 bun test
```

---

## CI Test Matrix

| Trigger | Jobs |
|---|---|
| PR opened/updated | `pr-quality` on Ubuntu only: lint (Biome), typecheck, unit + integration tests, `bun audit` |
| Push to `main` / `develop` | Full 3-platform matrix: `windows-2025`, `macos-15`, `ubuntu-24.04` |
| Push to `main` + release tags | E2E Desktop (Playwright + Tauri WebDriver) on all three platforms |

Security scans run on every PR: `bun audit`, `trivy`, CodeQL. HIGH/CRITICAL findings block the merge.
