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
// mock.module calls at module-load time AND re-installs them in a
// `beforeEach` registered here. Re-installation matters because the CLI
// suite does not always run in its own process: the PR-only cross-platform
// job runs `bun test packages/gateway/src packages/cli/src` (gateway + cli
// in ONE process), and a sibling gateway test's global `mock.restore()` can
// clear these process-global `mock.module` registrations. Without the
// per-test re-install, the next CLI test then resolves the REAL
// ipc-client / gateway-process modules and the whole file fails (observed
// intermittently on macOS). Per-test state lives in
// `globalThis.__nimbusCliFixture` (set/cleared by consumer beforeEach/afterEach).
// Test files import this helper for its side effects.
//
// Serial-within-process is assumed. Never invoke `bun test --concurrent`
// against the CLI suite — the global-slot delegation pattern depends on
// serial execution.

import { beforeEach, mock } from "bun:test";

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
   *
   * Optional `onNotification` is consulted when the code under test
   * subscribes to gateway notifications (`index.reembedProgress`,
   * `index.reembedDone`, etc). When absent, the harness's
   * `onNotification` is a no-op so callers that never subscribe stay
   * branch-coverage-clean.
   */
  ipcClient?: {
    call: unknown;
    connect: unknown;
    disconnect: unknown;
    onNotification?: unknown;
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __nimbusCliFixture: CliTestFixture | undefined;
}

const cancelSymbol = Symbol.for("clack:cancel");

/**
 * (Re)install the CLI cross-cutting mock.module registrations. Called once at
 * module load and again before every test (see `beforeEach` below) so the
 * mocks survive a sibling package's global `mock.restore()` in a combined
 * `bun test packages/gateway/src packages/cli/src` process.
 */
export function installCliMocks(): void {
  mock.module("@clack/prompts", () => ({
    intro: (): void => {},
    outro: (): void => {},
    confirm: async (): Promise<boolean | symbol> =>
      globalThis.__nimbusCliFixture?.clackAnswer ?? true,
    isCancel: (v: unknown): boolean => v === cancelSymbol,
    // `spinner()` is used by lifecycle commands (start/stop/serve). The mock
    // returns a no-op shim so the dispatcher's `s.start()` / `s.message()` /
    // `s.stop()` calls do not write to stdout under test.
    spinner: (): {
      start: (msg?: string) => void;
      message: (msg?: string) => void;
      stop: (msg?: string) => void;
    } => ({
      start: (): void => {},
      message: (): void => {},
      stop: (): void => {},
    }),
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
      onNotification(event: string, handler: (params: unknown) => void): void {
        const ipc = globalThis.__nimbusCliFixture?.ipcClient;
        const on = ipc?.onNotification as
          | undefined
          | ((e: string, h: (params: unknown) => void) => void);
        if (on !== undefined) {
          on(event, handler);
        }
      }
    },
  }));
}

// Install at module load (preserves the original single-shot behavior for the
// per-package `bun test` path) …
installCliMocks();
// … and re-install before every test in every file that imports this helper,
// so a sibling package's `mock.restore()` in a combined process cannot leave a
// CLI test running against the real modules.
beforeEach(() => {
  installCliMocks();
});

export function setFixture(f: CliTestFixture): void {
  globalThis.__nimbusCliFixture = f;
}

export function clearFixture(): void {
  globalThis.__nimbusCliFixture = undefined;
}

export const CLACK_CANCEL: symbol = cancelSymbol;
