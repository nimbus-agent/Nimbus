import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

const MCP_LIMIT_DEFAULT = 20;
const MCP_LIMIT_MAX = 50;
// Whitelisted rawMeta keys, verified against real connector item mappings (e.g. github-sync.ts
// stores a PR's author under `user`, plus `labels`/`merged`/`draft`/`repo`; pagerduty incidents
// use `status`/`severity`/`urgency`). Keep this tight — it is the only rawMeta that reaches the
// editor LLM (see the spec's security checklist).
const META_WHITELIST = [
  "state",
  "status",
  "number",
  "user",
  "author",
  "labels",
  "merged",
  "draft",
  "priority",
  "severity",
  "urgency",
  "environment",
  "conclusion",
  "repo",
] as const;
const META_STRING_MAX = 200;

/** Defense-in-depth: truncate long string values (including inside arrays) so a whitelisted key can't smuggle a large blob. */
function clampMetaValue(v: unknown): unknown {
  if (typeof v === "string") {
    return v.length > META_STRING_MAX ? v.slice(0, META_STRING_MAX) : v;
  }
  if (Array.isArray(v)) {
    return v.map(clampMetaValue);
  }
  return v;
}

/** Clamp an MCP-tool limit to [1, 50], defaulting to 20. Independent of the Gateway's own 1–500 clamp. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return MCP_LIMIT_DEFAULT;
  }
  return Math.min(MCP_LIMIT_MAX, Math.max(1, Math.floor(limit)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Project one ranked index item to a compact, whitelisted shape for an editor LLM. */
export function projectRankedItem(item: unknown): Record<string, unknown> {
  const r = asRecord(item);
  const out: Record<string, unknown> = {};
  if (typeof r["name"] === "string") {
    out["name"] = r["name"];
  }
  if (typeof r["service"] === "string") {
    out["service"] = r["service"];
  }
  // Prefer indexedType (the real type, e.g. "pr"); itemType collapses unknown types to "file".
  const type = typeof r["indexedType"] === "string" ? r["indexedType"] : r["itemType"];
  if (typeof type === "string") {
    out["type"] = type;
  }
  const url = typeof r["url"] === "string" ? r["url"] : r["canonicalUrl"];
  if (typeof url === "string") {
    out["url"] = url;
  }
  if (typeof r["score"] === "number") {
    out["score"] = r["score"];
  }
  if (typeof r["modifiedAt"] === "number") {
    out["modifiedAt"] = r["modifiedAt"];
  }
  if (typeof r["semanticSnippet"] === "string") {
    out["semanticSnippet"] = r["semanticSnippet"];
  }
  const meta = r["rawMeta"];
  if (typeof meta === "object" && meta !== null) {
    const m = meta as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const k of META_WHITELIST) {
      const val = m[k];
      if (val !== undefined && val !== null) {
        picked[k] = clampMetaValue(val);
      }
    }
    if (Object.keys(picked).length > 0) {
      out["meta"] = picked;
    }
  }
  return out;
}

/** Project a ranked-items array; tolerates a non-array input by returning []. */
export function projectRankedItems(rows: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map(projectRankedItem);
}

export const GATEWAY_DOWN_MESSAGE = "Nimbus Gateway is not running. Start it with: nimbus start";

/** Thrown when the adapter cannot reach the Gateway (no state file, or connect failed). */
export class GatewayUnavailableError extends Error {
  constructor() {
    super(GATEWAY_DOWN_MESSAGE);
    this.name = "GatewayUnavailableError";
  }
}

/** Minimal IPC surface the adapter needs — structurally satisfied by IPCClient. */
export interface IpcCallable {
  call<T>(method: string, params?: unknown): Promise<T>;
  disconnect(): Promise<void>;
}

export interface AdapterDeps {
  /** Returns a connected client, reusing a cached connection while it is healthy. */
  getClient(): Promise<IpcCallable>;
}

/** Injectable connection primitives so tests avoid real sockets. */
export interface ConnectionEnv {
  readState(): Promise<{ socketPath: string } | undefined>;
  connect(socketPath: string): Promise<IpcCallable>;
}

const DISCONNECT_MESSAGES: ReadonlySet<string> = new Set([
  "IPC client is not connected",
  "IPC connection closed",
  "IPC connection error",
]);

/** True when an error is one of IPCClient's transport-dead messages and a reconnect is warranted. */
export function isDisconnectError(e: unknown): boolean {
  return e instanceof Error && DISCONNECT_MESSAGES.has(e.message);
}

/** Wrap a raw client so a transport-dead call invalidates the cache, forcing the next getClient to reconnect. */
function makeReconnectingClient(raw: IpcCallable, invalidate: () => void): IpcCallable {
  return {
    async call<T>(method: string, params?: unknown): Promise<T> {
      try {
        return await raw.call<T>(method, params);
      } catch (e) {
        if (isDisconnectError(e)) {
          invalidate();
          void raw.disconnect().catch(() => {});
        }
        throw e;
      }
    },
    disconnect(): Promise<void> {
      return raw.disconnect();
    },
  };
}

export function createDeps(env: ConnectionEnv): AdapterDeps {
  let cached: IpcCallable | null = null;
  let connecting: Promise<IpcCallable> | null = null;
  const invalidate = (): void => {
    cached = null;
  };
  const openConnection = async (): Promise<IpcCallable> => {
    const state = await env.readState();
    if (state === undefined) {
      throw new GatewayUnavailableError();
    }
    let raw: IpcCallable;
    try {
      raw = await env.connect(state.socketPath);
    } catch {
      throw new GatewayUnavailableError();
    }
    const client = makeReconnectingClient(raw, invalidate);
    cached = client;
    return client;
  };
  return {
    async getClient(): Promise<IpcCallable> {
      if (cached !== null) {
        return cached;
      }
      if (connecting === null) {
        connecting = openConnection().finally(() => {
          connecting = null;
        });
      }
      return connecting;
    },
  };
}

/** Production deps: real gateway-state read + real IPCClient connect. */
export function createProductionDeps(): AdapterDeps {
  return createDeps({
    readState: async () => {
      const s = await readGatewayState(getCliPlatformPaths());
      return s === undefined ? undefined : { socketPath: s.socketPath };
    },
    connect: async (socketPath: string) => {
      const client = new IPCClient(socketPath);
      await client.connect();
      return client;
    },
  });
}
