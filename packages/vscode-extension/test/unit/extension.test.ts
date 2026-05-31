import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { activateWithDeps } from "../../src/extension.js";
import type {
  CommandsApi,
  ConfigurationChangeEventLike,
  ExtensionContextLike,
  MementoLike,
  StatusBarItemHandle,
  WindowApi,
  WorkspaceApi,
} from "../../src/vscode-shim.js";

class FakeMemento implements MementoLike {
  private readonly store = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.store.get(key) as T | undefined) ?? defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.store.delete(key);
    else this.store.set(key, value);
  }
}

type ActivateDeps = Parameters<typeof activateWithDeps>[1];
type ClientLike = Awaited<ReturnType<NonNullable<ActivateDeps["openClient"]>>>;

function makeFakeClient(overrides: Partial<ClientLike> = {}): () => Promise<ClientLike> {
  const base: ClientLike = {
    close: async () => undefined,
    subscribeHitl: () => ({ dispose: () => undefined }),
    askStream: () => ({}),
    cancelStream: async () => ({ ok: true }),
    getSessionTranscript: async () => ({ sessionId: "", turns: [], hasMore: false }),
  } as unknown as ClientLike;
  const merged = { ...base, ...overrides } as ClientLike;
  return async () => merged;
}

interface Captured {
  ctx: ExtensionContextLike;
  commandHandlers: Map<string, (...args: unknown[]) => unknown>;
  statusItem: StatusBarItemHandle;
  outputAppendLines: string[];
  outputShownGetter: number;
  errorMessages: string[];
  infoMessages: string[];
  configChangeHandlers: Array<(e: ConfigurationChangeEventLike) => void>;
  cfgValues: Record<string, unknown>;
}

const TEST_SOCKET_PATH = join(tmpdir(), `nimbus-test-${process.pid}.sock`);

function makeFixture(opts: {
  cfg?: Record<string, unknown>;
  inputBoxAnswers?: Array<string | undefined>;
  openClient?: () => Promise<ClientLike>;
  discoverSocket?: () => Promise<{ socketPath: string; source: string }>;
}): Captured & { deps: ActivateDeps } {
  const ctx: ExtensionContextLike = {
    subscriptions: [],
    workspaceState: new FakeMemento(),
  };
  const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const outputAppendLines: string[] = [];
  let outputShown = 0;
  const errorMessages: string[] = [];
  const infoMessages: string[] = [];
  const configChangeHandlers: Array<(e: ConfigurationChangeEventLike) => void> = [];
  const cfgValues = opts.cfg ?? {};
  const inputAnswers = [...(opts.inputBoxAnswers ?? [])];

  const statusItem: StatusBarItemHandle = {
    text: "",
    tooltip: undefined,
    command: undefined,
    backgroundColor: undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  };

  const window: WindowApi = {
    createOutputChannel: () => ({
      appendLine: (m: string) => outputAppendLines.push(m),
      show: () => {
        outputShown += 1;
      },
      dispose: () => undefined,
    }),
    createStatusBarItem: () => statusItem,
    showInformationMessage: vi.fn(async (m: string) => {
      infoMessages.push(m);
      return undefined;
    }) as unknown as WindowApi["showInformationMessage"],
    showErrorMessage: vi.fn(async (m: string) => {
      errorMessages.push(m);
      return undefined;
    }) as unknown as WindowApi["showErrorMessage"],
    showInputBox: vi.fn(async () => inputAnswers.shift()) as unknown as WindowApi["showInputBox"],
    showQuickPick: vi.fn(async () => undefined) as unknown as WindowApi["showQuickPick"],
    activeTextEditor: undefined,
  };

  const workspace: WorkspaceApi = {
    getConfiguration: () => ({
      get: <T>(key: string, dflt: T): T => {
        if (key in cfgValues) return cfgValues[key] as T;
        return dflt;
      },
    }),
    onDidChangeConfiguration: (handler) => {
      configChangeHandlers.push(handler);
      return { dispose: () => undefined };
    },
  };

  const commands: CommandsApi = {
    executeCommand: vi.fn(async (id: string) => {
      const h = commandHandlers.get(id);
      if (h !== undefined) await h();
      return undefined;
    }) as unknown as CommandsApi["executeCommand"],
    registerCommand: (id, h) => {
      commandHandlers.set(id, h);
      return { dispose: () => commandHandlers.delete(id) };
    },
  };

  const deps: ActivateDeps = {
    window,
    workspace,
    commands,
    discoverSocket:
      (opts.discoverSocket as ActivateDeps["discoverSocket"]) ??
      (async () => ({ socketPath: TEST_SOCKET_PATH, source: "default" }) as never),
    openClient: opts.openClient ?? makeFakeClient(),
    chatPanelFactory: () => {
      let revealed = 0;
      const disposeListeners: Array<() => void> = [];
      const panel = {
        reveal: () => {
          revealed += 1;
        },
        dispose: () => {
          for (const l of disposeListeners) l();
        },
        panel: () => undefined,
        onDispose: (h: () => void) => {
          disposeListeners.push(h);
        },
        onMessage: () => undefined,
        postMessage: () => Promise.resolve(true),
        isVisible: () => false,
        isActive: () => false,
      };
      return {
        createOrReveal: () => panel,
        current: () => (revealed > 0 ? panel : undefined),
      };
    },
  };

  return {
    ctx,
    commandHandlers,
    statusItem,
    outputAppendLines,
    get outputShownGetter(): number {
      return outputShown;
    },
    errorMessages,
    infoMessages,
    configChangeHandlers,
    cfgValues,
    deps,
  } as Captured & { deps: ActivateDeps };
}

// Wait for the connection manager's `void connection.start()` to settle.
async function waitForConnect(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Tests

describe("activateWithDeps", () => {
  test("registers the expected commands and pushes disposables to ctx.subscriptions", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();

    const expected = [
      "nimbus.ask",
      "nimbus.askAboutSelection",
      "nimbus.search",
      "nimbus.searchSelection",
      "nimbus.runWorkflow",
      "nimbus.newConversation",
      "nimbus.startGateway",
      "nimbus.reconnect",
      "nimbus.openLogs",
      "nimbus.showPendingHitl",
    ];
    for (const id of expected) {
      expect(f.commandHandlers.has(id), `command ${id} missing`).toBe(true);
    }
    expect(f.ctx.subscriptions.length).toBeGreaterThanOrEqual(17);
  });

  test("nimbus.ask asks the user and starts a chat stream when input is non-empty", async () => {
    const askStream = vi.fn(() => ({
      streamId: "s1",
      cancel: async () => undefined,
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ value: { type: "done", reply: "", sessionId: "" }, done: false }),
      }),
    }));
    const f = makeFixture({
      inputBoxAnswers: ["what's up?"],
      openClient: makeFakeClient({ askStream } as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();

    const handler = f.commandHandlers.get("nimbus.ask");
    expect(handler).toBeDefined();
    if (handler === undefined) return;
    await handler();
    expect(askStream).toHaveBeenCalledTimes(1);
    const firstCall = askStream.mock.calls[0] as unknown as [string, ...unknown[]];
    expect(firstCall[0]).toBe("what's up?");
  });

  test("nimbus.ask is a no-op when the user cancels the input box", async () => {
    const askStream = vi.fn();
    const f = makeFixture({
      inputBoxAnswers: [undefined],
      openClient: makeFakeClient({ askStream } as Partial<ClientLike>),
    });
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();

    const handler = f.commandHandlers.get("nimbus.ask");
    if (handler === undefined) throw new Error("ask handler not registered");
    await handler();
    expect(askStream).not.toHaveBeenCalled();
  });

  test("nimbus.openLogs reveals the output channel", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const before = f.outputShownGetter;
    const handler = f.commandHandlers.get("nimbus.openLogs");
    if (handler === undefined) throw new Error("openLogs handler not registered");
    handler();
    expect(f.outputShownGetter).toBeGreaterThan(before);
  });

  test("connecting paints the status bar with the connected text", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    expect(f.statusItem.text).toMatch(/Nimbus:/);
  });

  test("a nimbus.* configuration change re-renders the status bar", async () => {
    const f = makeFixture({});
    const handle = activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const before = f.statusItem.text;
    f.statusItem.text = "(reset)";
    for (const h of f.configChangeHandlers) h({ affectsConfiguration: () => true });
    expect(f.statusItem.text).not.toBe("(reset)");
    expect(handle.fireConnectionState).toBeTypeOf("function");
    expect(typeof before).toBe("string");
  });

  test("disposing every subscription tears down without throwing", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    expect(() => {
      for (const s of f.ctx.subscriptions) s.dispose();
    }).not.toThrow();
  });

  test("nimbus.startGateway exercises the auto-starter without throwing", async () => {
    const f = makeFixture({});
    activateWithDeps(f.ctx, f.deps);
    await waitForConnect();
    const handler = f.commandHandlers.get("nimbus.startGateway");
    if (handler === undefined) throw new Error("startGateway handler not registered");
    await expect(handler()).resolves.toBeUndefined();
    expect(f.ctx.subscriptions.length).toBeGreaterThan(0);
  });
});
