// packages/cli/test/helpers/cli-mocks.ts
//
// Single source of mock.module for the CLI test suite.
//
// Phase 5 lesson: mock.module is process-global under `bun test --coverage`
// (build-lcov.sh runs one bun-test process per package). An `afterAll`
// reset does NOT prevent cross-file contamination — consumer files load
// their references during module-load (before afterAll fires), and the
// last mock.module call wins for the rest of the process.
//
// The fix is structural: this file installs the per-cross-cutting-dep
// mock.module calls exactly once at module-load time. Per-test state
// lives in `globalThis.__nimbusCliFixture` (set in `beforeEach`, cleared
// in `afterEach`). Test files import this helper for its side effects.
//
// Serial-within-process is assumed. Never invoke `bun test --concurrent`
// against the CLI suite — the global-slot delegation pattern depends on
// serial execution.

import { mock } from "bun:test";

export interface CliTestFixture {
  gatewayState?: { socketPath: string; pid?: number };
  /**
   * Controls the return value of the mocked `isProcessAlive(pid)` from
   * `lib/gateway-process.ts`. Defaults to `true` when unset — i.e. the
   * recorded gateway state is treated as live unless the test opts out.
   */
  processAlive?: boolean;
  clackAnswer?: boolean | symbol;
  /**
   * Optional IPCClient-shaped object the mocked
   * `new IPCClient(socketPath)` constructor returns. Use
   * `createMockIpcClient(...)` from `mock-ipc-client.ts`. When undefined,
   * the dispatcher's `withIpc()` will still construct a fake client but
   * its `connect` / `call` / `disconnect` are no-ops — useful for
   * exercising the dispatcher's branch coverage without wiring up a real
   * response queue.
   */
  ipcClient?: { call: unknown; connect: unknown; disconnect: unknown };
}

declare global {
  // eslint-disable-next-line no-var
  var __nimbusCliFixture: CliTestFixture | undefined;
}

const cancelSymbol = Symbol.for("clack:cancel");

mock.module("@clack/prompts", () => ({
  intro: (): void => {},
  outro: (): void => {},
  confirm: async (): Promise<boolean | symbol> =>
    globalThis.__nimbusCliFixture?.clackAnswer ?? true,
  isCancel: (v: unknown): boolean => v === cancelSymbol,
}));

mock.module("../../src/lib/gateway-process.ts", () => ({
  readGatewayState: async (): Promise<CliTestFixture["gatewayState"]> =>
    globalThis.__nimbusCliFixture?.gatewayState,
  // Default: pretend the recorded pid is alive. Tests that need a stale
  // state file should set fixture.processAlive = false.
  isProcessAlive: (_pid: number): boolean => globalThis.__nimbusCliFixture?.processAlive ?? true,
  gatewayStatePath: (_paths: { dataDir: string }): string => "/tmp/fake-gateway-state.json",
  ensureGatewayDirs: async (_paths: unknown): Promise<void> => {},
}));

// Replace the IPCClient class so the dispatcher's `withIpc()` helper
// does not attempt a real socket connect. When a test sets
// `fixture.ipcClient`, the constructor returns that client; otherwise it
// returns a no-op stub.
mock.module("../../src/ipc-client/index.ts", () => ({
  IPCClient: class FakeIPCClient {
    constructor(_socketPath: string) {}
    async connect(): Promise<void> {}
    async disconnect(): Promise<void> {}
    async call<T>(method: string, params?: unknown): Promise<T> {
      const ipc = globalThis.__nimbusCliFixture?.ipcClient;
      if (ipc !== undefined) {
        return (ipc.call as (m: string, p: unknown) => Promise<T>)(method, params);
      }
      return undefined as T;
    }
    onNotification(_event: string, _handler: (params: unknown) => void): void {}
  },
}));

export function setFixture(f: CliTestFixture): void {
  globalThis.__nimbusCliFixture = f;
}

export function clearFixture(): void {
  globalThis.__nimbusCliFixture = undefined;
}

export const CLACK_CANCEL: symbol = cancelSymbol;
