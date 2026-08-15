import { beforeEach, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shared, S5443-compliant fake paths for the mocked gateway. The IPC client and
// gateway-state reader are fully mocked (the socket is never bound, the state
// file is never written), so these only need to be unique, non-publicly-writable
// strings — one real `mkdtempSync` root, derived paths via `join`. Replaces the
// hardcoded fake socket / gateway-state path literals that every command test
// repeated.
const FAKE_GATEWAY_ROOT = mkdtempSync(join(tmpdir(), "nimbus-cli-mock-"));
export const FAKE_SOCKET_PATH: string = join(FAKE_GATEWAY_ROOT, "fake.sock");
export const FAKE_GATEWAY_STATE_PATH: string = join(FAKE_GATEWAY_ROOT, "fake-gateway-state.json");

/**
 * Build a unique, S5443-compliant fake path under the shared mkdtemp root for an
 * arbitrary file name. The path is never written to disk — use it wherever a test
 * needs a non-publicly-writable stand-in for a `/tmp/...` argument literal.
 */
export const fakePath = (name: string): string => join(FAKE_GATEWAY_ROOT, name);

/**
 * One `new IPCClient(socketPath, opts)` the code under test performed.
 *
 * `opts` is what distinguishes a command that opted into a long request budget from
 * one that silently took the transport's 30s default, so a test asserting a blocking
 * RPC is not bounded at 30s has to be able to see it. `undefined` means the site
 * passed no options object at all — which is the pre-fix behaviour, not a synonym
 * for "default": the two are only equivalent by the transport's own `?? DEFAULT`.
 */
export interface RecordedClientConstruction {
  readonly socketPath: string;
  readonly opts: { requestTimeoutMs?: number } | undefined;
}

export interface CliTestFixture {
  gatewayState?: { socketPath: string; pid?: number };
  processAlive?: boolean;
  clackAnswer?: boolean | symbol;
  ipcClient?: {
    call: unknown;
    connect: unknown;
    disconnect: unknown;
    onNotification?: unknown;
  };
  /**
   * Populated by the fake client's constructor when present. Tests that care opt in
   * by passing an empty array; leaving it unset keeps the fake allocation-free for
   * the many tests that do not.
   */
  clientConstructions?: RecordedClientConstruction[];
}

declare global {
  // eslint-disable-next-line no-var
  var __nimbusCliFixture: CliTestFixture | undefined;
}

const cancelSymbol = Symbol.for("clack:cancel");

export function installCliMocks(): void {
  mock.module("@clack/prompts", () => ({
    intro: (): void => {},
    outro: (): void => {},
    confirm: async (): Promise<boolean | symbol> =>
      globalThis.__nimbusCliFixture?.clackAnswer ?? true,
    isCancel: (v: unknown): boolean => v === cancelSymbol,
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
    isProcessAlive: (_pid: number): boolean => globalThis.__nimbusCliFixture?.processAlive ?? true,
    gatewayStatePath: (_paths: { dataDir: string }): string => FAKE_GATEWAY_STATE_PATH,
    ensureGatewayDirs: async (_paths: unknown): Promise<void> => {},
  }));

  mock.module("../../src/ipc-client/index.ts", () => ({
    IPCClient: class FakeIPCClient {
      constructor(socketPath: string, opts?: { requestTimeoutMs?: number }) {
        globalThis.__nimbusCliFixture?.clientConstructions?.push({ socketPath, opts });
      }
      async connect(): Promise<void> {
        const ipc = globalThis.__nimbusCliFixture?.ipcClient;
        const connectFn = ipc?.connect as (() => Promise<void>) | undefined;
        if (connectFn !== undefined) {
          await connectFn();
        }
      }
      async disconnect(): Promise<void> {
        const ipc = globalThis.__nimbusCliFixture?.ipcClient;
        const disconnectFn = ipc?.disconnect as (() => Promise<void>) | undefined;
        if (disconnectFn !== undefined) {
          await disconnectFn();
        }
      }
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

installCliMocks();
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
