/**
 * `memory.*` - the owner's view of long-term episodic memory (Phase 10, owner ruling OR-S4-MEM, I61).
 *
 *   - `memory.list { limit?, offset? }` -> `{ enabled, retentionDays, pendingTurns, total, memories: StoredMemory[] }`
 *     (`total` is every retained memory, so a caller can page with `offset` until it has them all)
 *   - `memory.forget { id }` or `memory.forget { all: true }` -> `{ forgotten }` (the count of memories removed;
 *     `all` also drops every turn still waiting to be summarised)
 *
 * Served only to a connection whose DECLARED kind is `cli` or `ui` (the CONNECTION's kind, never a param);
 * the whole `memory` namespace is LAN-forbidden (I5, `ipc/lan-rpc.ts`, a DENYLIST) and absent from the Tauri
 * allowlist (I7): a summary is a digest of the owner's private conversations, so the renderer, an MCP agent,
 * ChatOps, HTTP and a paired peer never read it. Both methods work while `[memory] episodic = false`, so the
 * owner can forget what an earlier opt-in stored. On a demo gateway (I41) memory is never attached and both
 * methods refuse.
 */

import { asRecord } from "../connectors/unknown-record.ts";
import type { EpisodicMemory } from "../memory/episodic-memory.ts";
import type { StoredMemory } from "../memory/episodic-store.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import type { ClientKind } from "./server/client-kind.ts";

export class MemoryRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

export const MEMORY_FORBIDDEN_CLIENT =
  "ERR_MEMORY_FORBIDDEN_CLIENT: episodic memory is served only to the owner's own surfaces (the CLI and the desktop), on a connection that declared its kind";
export const MEMORY_UNAVAILABLE =
  "ERR_MEMORY_UNAVAILABLE: episodic memory is not available on this gateway";
export const MEMORY_BAD_PARAMS =
  "ERR_MEMORY_BAD_PARAMS: memory.forget takes { id: string } or { all: true }, and no other field";

export const MEMORY_LIST_LIMIT_DEFAULT = 100;
export const MEMORY_LIST_LIMIT_MAX = 500;

export interface MemoryRpcCtx {
  /** Absent on a demo gateway (I41) and when the session store was not attached. */
  readonly memory: () => EpisodicMemory | undefined;
}

export type MemoryListReply = {
  enabled: boolean;
  retentionDays: number;
  pendingTurns: number;
  total: number;
  memories: StoredMemory[];
};

function memoryOf(ctx: MemoryRpcCtx, kind: ClientKind): EpisodicMemory {
  if (kind !== "cli" && kind !== "ui") throw new MemoryRpcError(-32000, MEMORY_FORBIDDEN_CLIENT);
  const m = ctx.memory();
  if (m === undefined) throw new MemoryRpcError(-32000, MEMORY_UNAVAILABLE);
  return m;
}

function limitOf(params: unknown): number {
  const raw = asRecord(params)?.["limit"];
  if (raw === undefined) return MEMORY_LIST_LIMIT_DEFAULT;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MEMORY_LIST_LIMIT_MAX) {
    throw new MemoryRpcError(
      -32602,
      `ERR_MEMORY_BAD_PARAMS: limit must be an integer 1..${String(MEMORY_LIST_LIMIT_MAX)}`,
    );
  }
  return raw;
}

function offsetOf(params: unknown): number {
  const raw = asRecord(params)?.["offset"];
  if (raw === undefined) return 0;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new MemoryRpcError(-32602, "ERR_MEMORY_BAD_PARAMS: offset must be an integer >= 0");
  }
  return raw;
}

type ForgetTarget = { readonly id: string } | { readonly all: true };

function forgetTarget(params: unknown): ForgetTarget {
  const rec = asRecord(params);
  if (rec === undefined) throw new MemoryRpcError(-32602, MEMORY_BAD_PARAMS);
  const keys = Object.keys(rec);
  if (keys.length === 1 && rec["all"] === true) return { all: true };
  const id = rec["id"];
  if (keys.length === 1 && typeof id === "string" && /^mem_[0-9a-f]{16}$/.test(id)) return { id };
  throw new MemoryRpcError(-32602, MEMORY_BAD_PARAMS);
}

export async function dispatchMemoryRpc(
  method: string,
  params: unknown,
  ctx: MemoryRpcCtx,
  caller: { readonly kind: ClientKind },
): Promise<RpcMissOrHit> {
  return dispatchByMethod<MemoryRpcCtx>(method, params, ctx, {
    "memory.list": (p, c): MemoryListReply => {
      const m = memoryOf(c, caller.kind);
      const limit = limitOf(p);
      const offset = offsetOf(p);
      const status = m.status();
      return {
        enabled: status.enabled,
        retentionDays: status.retentionDays,
        pendingTurns: status.pendingTurns,
        total: status.memories,
        memories: m.list(limit, offset),
      };
    },
    "memory.forget": (p, c) => {
      const m = memoryOf(c, caller.kind);
      const target = forgetTarget(p);
      if ("all" in target) return { forgotten: m.forgetAll() };
      return { forgotten: m.forget(target.id) ? 1 : 0 };
    },
  });
}
