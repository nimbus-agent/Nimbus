import { beforeEach, mock } from "bun:test";

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
    gatewayStatePath: (_paths: { dataDir: string }): string => "/tmp/fake-gateway-state.json",
    ensureGatewayDirs: async (_paths: unknown): Promise<void> => {},
  }));

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
