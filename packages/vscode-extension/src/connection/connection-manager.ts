import type { Logger } from "../logging.js";

export type ConnectionState =
  | { kind: "idle" }
  | { kind: "connecting"; socketPath: string }
  | { kind: "connected"; socketPath: string }
  | { kind: "disconnected"; socketPath: string; reason: string }
  | { kind: "permission-denied"; socketPath: string }
  | { kind: "starting-gateway"; socketPath: string };

export interface NimbusClientLike {
  close(): Promise<void>;
}

export interface ConnectionDeps {
  open(socketPath: string): Promise<NimbusClientLike>;
  discoverSocket(override?: string): Promise<{ socketPath: string; source: string }>;
  log: Logger;
  reconnectDelayMs?: number;
  socketPathOverride?: string;
}

export interface ConnectionManager {
  start(): Promise<void>;
  dispose(): Promise<void>;
  reconnectNow(): Promise<void>;
  onState(listener: (s: ConnectionState) => void): { dispose(): void };
  current(): ConnectionState;
  client(): NimbusClientLike | undefined;
}

const DEFAULT_RECONNECT_MS = 3000;

export function createConnectionManager(deps: ConnectionDeps): ConnectionManager {
  const listeners: Array<(s: ConnectionState) => void> = [];
  let state: ConnectionState = { kind: "idle" };
  let client: NimbusClientLike | undefined;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const setState = (s: ConnectionState): void => {
    state = s;
    for (const l of listeners) l(s);
  };

  const tryConnect = async (): Promise<void> => {
    if (stopped) return;
    const disc = await deps.discoverSocket(deps.socketPathOverride);
    setState({ kind: "connecting", socketPath: disc.socketPath });
    try {
      const c = await deps.open(disc.socketPath);
      client = c;
      setState({ kind: "connected", socketPath: disc.socketPath });
      deps.log.info(`Connected to Gateway at ${disc.socketPath} (source=${disc.source})`);
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException).code;
      if (errno === "EACCES") {
        deps.log.error(`Permission denied accessing socket: ${disc.socketPath}`);
        setState({ kind: "permission-denied", socketPath: disc.socketPath });
        scheduleReconnect();
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      deps.log.warn(`Connect failed (${errno ?? "unknown"}): ${msg}`);
      setState({ kind: "disconnected", socketPath: disc.socketPath, reason: msg });
      scheduleReconnect();
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    if (reconnectTimer !== undefined) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void tryConnect();
    }, deps.reconnectDelayMs ?? DEFAULT_RECONNECT_MS);
  };

  return {
    async start(): Promise<void> {
      stopped = false;
      await tryConnect();
    },
    async dispose(): Promise<void> {
      stopped = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      if (client !== undefined) {
        await client.close().catch(() => undefined);
        client = undefined;
      }
      listeners.length = 0;
    },
    async reconnectNow(): Promise<void> {
      if (state.kind === "connected") return;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      await tryConnect();
    },
    onState(listener): { dispose(): void } {
      listeners.push(listener);
      listener(state);
      return {
        dispose: () => {
          const idx = listeners.indexOf(listener);
          if (idx >= 0) listeners.splice(idx, 1);
        },
      };
    },
    current: () => state,
    client: () => client,
  };
}
