import type { IPCClient } from "@nimbus-dev/client";

export interface StubClientOptions {
  readonly results?: Record<string, unknown>;
  readonly errors?: Record<string, Error>;
}

export class StubIpcClient {
  private readonly handlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly options: StubClientOptions;
  public readonly calls: Array<{ method: string; params: unknown }> = [];
  public disconnected = false;

  constructor(options: StubClientOptions = {}) {
    this.options = options;
  }

  async connect(): Promise<void> {
    this.disconnected = false;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    const err = this.options.errors?.[method];
    if (err !== undefined) {
      throw err;
    }
    if (this.options.results && method in this.options.results) {
      return this.options.results[method] as T;
    }
    throw new Error(`StubIpcClient: no result configured for method "${method}"`);
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    let set = this.handlers.get(method);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
  }

  emit(method: string, params: unknown): void {
    const set = this.handlers.get(method);
    if (set === undefined) {
      return;
    }
    for (const h of set) {
      h(params);
    }
  }

  asClient(): IPCClient {
    return this as unknown as IPCClient;
  }
}
