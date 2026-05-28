import type { SessionMemoryStore } from "../memory/session-memory-store.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { asRecord } from "./connector-rpc-shared.ts";

export class SessionRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.rpcCode = rpcCode;
    this.name = "SessionRpcError";
  }
}

function requireString(rec: Record<string, unknown> | undefined, key: string): string {
  if (rec === undefined) {
    throw new SessionRpcError(-32602, `Missing or invalid ${key}`);
  }
  const v = rec[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new SessionRpcError(-32602, `Missing or invalid ${key}`);
  }
  return v.trim();
}

async function handleSessionAppend(params: unknown, store: SessionMemoryStore): Promise<unknown> {
  const rec = asRecord(params);
  const sessionId = requireString(rec, "sessionId");
  const chunkText = requireString(rec, "chunkText");
  const roleRaw = requireString(rec, "role");
  if (roleRaw !== "user" && roleRaw !== "assistant" && roleRaw !== "tool") {
    throw new SessionRpcError(-32602, "role must be user, assistant, or tool");
  }
  await store.append({
    sessionId,
    text: chunkText,
    role: roleRaw,
    createdAt: Date.now(),
  });
  return { ok: true };
}

async function handleSessionRecall(params: unknown, store: SessionMemoryStore): Promise<unknown> {
  const rec = asRecord(params);
  const sessionId = requireString(rec, "sessionId");
  const query = requireString(rec, "query");
  const topKRaw = rec?.["topK"];
  const topK =
    typeof topKRaw === "number" && Number.isFinite(topKRaw)
      ? Math.min(32, Math.max(1, Math.floor(topKRaw)))
      : 8;
  const chunks = await store.recall(sessionId, query, topK);
  return { chunks };
}

function handleSessionList(_p: unknown, store: SessionMemoryStore): unknown {
  return { sessions: store.listSessions() };
}

function handleSessionClear(params: unknown, store: SessionMemoryStore): unknown {
  const rec = asRecord(params);
  const sid =
    rec !== undefined && typeof rec["sessionId"] === "string" ? rec["sessionId"].trim() : "";
  if (sid === "") {
    for (const s of store.listSessions()) {
      store.deleteSession(s.sessionId);
    }
    return { ok: true, cleared: "all" };
  }
  store.deleteSession(sid);
  return { ok: true, cleared: sid };
}

export async function dispatchSessionRpc(options: {
  method: string;
  params: unknown;
  store: SessionMemoryStore;
}): Promise<RpcMissOrHit> {
  return dispatchByMethod<SessionMemoryStore>(options.method, options.params, options.store, {
    "session.append": handleSessionAppend,
    "session.recall": handleSessionRecall,
    "session.list": handleSessionList,
    "session.clear": handleSessionClear,
  });
}
