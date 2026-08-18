import type { LlmGenerateResult } from "../llm/types.ts";
import type { AgentInvokeResult } from "./agent-invoke.ts";

export type StreamNotification = {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
};

export type AgentInvokeContextLike = {
  clientId: string;
  input: string;
  stream: true;
  sendChunk?: (text: string) => void;
  sessionId?: string;
  signal?: AbortSignal;
  /** Devil's-advocate mode — see `engine/devil-advocate.ts`. */
  devil?: boolean;
};

export type RequestContextLike = { sessionId?: string };

export type StreamRegistry = {
  register(streamId: string, ac: AbortController): void;
  cancel(streamId: string): boolean;
  unregister(streamId: string): void;
  /**
   * Compare-and-delete: removes the entry only if `ac` is still the
   * controller currently registered under `streamId`. A plain `unregister`
   * in a `finally` can otherwise evict a *different* run's live entry once
   * an id has been cancelled and reused — the cancelled run's cleanup fires
   * after the reuse has already registered its own controller under the
   * same key.
   */
  unregisterIf(streamId: string, ac: AbortController): void;
  has(streamId: string): boolean;
  size(): number;
};

export type AskStreamHandlerDeps = {
  registry: StreamRegistry;
  randomId: () => string;
  sessionWriteNotification: (n: StreamNotification) => void;
  runWithRequestContext: <T>(ctx: RequestContextLike, fn: () => Promise<T>) => Promise<T>;
  agentInvokeHandler: (ctx: AgentInvokeContextLike) => Promise<AgentInvokeResult>;
};

export type AskStreamParams = {
  input: string;
  sessionId?: string;
  devil?: boolean;
};

export type AskStreamResult = { streamId: string };

function streamMetaFromModelMeta(meta: LlmGenerateResult): Record<string, unknown> {
  return {
    modelUsed: meta.modelUsed,
    isLocal: meta.isLocal,
    provider: meta.provider,
    tokensIn: meta.tokensIn,
    tokensOut: meta.tokensOut,
  };
}

export function createAskStreamHandler(
  deps: AskStreamHandlerDeps,
): (clientId: string, params: AskStreamParams) => Promise<AskStreamResult> {
  return async (clientId, params): Promise<AskStreamResult> => {
    const streamId = deps.randomId();
    const ac = new AbortController();
    deps.registry.register(streamId, ac);

    const sendChunk = (text: string): void => {
      if (ac.signal.aborted) return;
      deps.sessionWriteNotification({
        jsonrpc: "2.0",
        method: "engine.streamToken",
        params: { streamId, text },
      });
    };

    void (async (): Promise<void> => {
      try {
        let modelMeta: LlmGenerateResult | undefined;
        const ctx: RequestContextLike = {};
        if (params.sessionId !== undefined) ctx.sessionId = params.sessionId;
        await deps.runWithRequestContext(ctx, async () => {
          const payload: AgentInvokeContextLike = {
            clientId,
            input: params.input,
            stream: true,
            sendChunk,
            signal: ac.signal,
          };
          if (params.sessionId !== undefined) payload.sessionId = params.sessionId;
          if (params.devil === true) payload.devil = true;
          const invokeResult = await deps.agentInvokeHandler(payload);
          modelMeta = invokeResult.modelMeta;
        });
        if (ac.signal.aborted) {
          deps.sessionWriteNotification({
            jsonrpc: "2.0",
            method: "engine.streamError",
            params: { streamId, code: "cancelled", error: "Stream cancelled" },
          });
        } else {
          deps.sessionWriteNotification({
            jsonrpc: "2.0",
            method: "engine.streamDone",
            params: {
              streamId,
              meta:
                modelMeta === undefined
                  ? { modelUsed: "default", isLocal: false, provider: "remote" }
                  : streamMetaFromModelMeta(modelMeta),
            },
          });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "Stream error";
        const code = ac.signal.aborted ? "cancelled" : "stream_error";
        deps.sessionWriteNotification({
          jsonrpc: "2.0",
          method: "engine.streamError",
          params: { streamId, code, error: message },
        });
      } finally {
        deps.registry.unregister(streamId);
      }
    })();

    return { streamId };
  };
}

export function createStreamRegistry(): StreamRegistry {
  const map = new Map<string, AbortController>();
  return {
    register(id, ac): void {
      map.set(id, ac);
    },
    cancel(id): boolean {
      const ac = map.get(id);
      if (ac === undefined) return false;
      ac.abort();
      map.delete(id);
      return true;
    },
    unregister(id): void {
      map.delete(id);
    },
    unregisterIf(id, ac): void {
      if (map.get(id) === ac) {
        map.delete(id);
      }
    },
    has(id): boolean {
      return map.has(id);
    },
    size(): number {
      return map.size;
    },
  };
}
