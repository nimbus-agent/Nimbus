import type { NimbusItem } from "@nimbus-dev/sdk";

import { createAskStream } from "./ask-stream.js";
import { IPCClient } from "./ipc-transport.js";
import type { AskStreamHandle, AskStreamOptions, HitlRequest } from "./stream-events.js";

export type NimbusClientOptions = {
  socketPath: string;
};

/** Parameters for {@link NimbusClient.searchRanked}. */
export type RankedSearchParams = {
  /** Free-text name/title query. Empty/omitted returns the top-ranked items. */
  name?: string;
  /** Restrict results to a single connector/service id. */
  service?: string;
  /** Restrict results to a single item type (e.g. "file", "email"). */
  itemType?: string;
  /** Max results. The Gateway clamps to 1..500; default 20. */
  limit?: number;
  /** Blend semantic (vector) ranking with keyword search. Defaults to true on the Gateway. */
  semantic?: boolean;
  /** Neighbouring chunks to include per hit. The Gateway clamps to 0..8; default 2. */
  contextChunks?: number;
};

/**
 * A ranked index hit: a {@link NimbusItem} enriched with ranking metadata.
 * Mirrors the Gateway's `index.searchRanked` result shape.
 */
export type RankedSearchItem = NimbusItem & {
  score: number;
  indexPrimaryKey: string;
  indexedType: string;
  canonicalUrl?: string;
  duplicates?: readonly string[];
  semanticSnippet?: string;
  bm25Rank?: number | null;
  vectorRank?: number | null;
};

export type SessionTranscript = {
  sessionId: string;
  turns: Array<{
    role: "user" | "assistant";
    text: string;
    timestamp: number;
    auditLogId?: number;
  }>;
  hasMore: boolean;
};

/**
 * Typed convenience wrapper over the Gateway JSON-RPC IPC surface.
 */
export class NimbusClient {
  private readonly ipc: IPCClient;

  private constructor(ipc: IPCClient) {
    this.ipc = ipc;
  }

  static async open(opts: NimbusClientOptions): Promise<NimbusClient> {
    const ipc = new IPCClient(opts.socketPath);
    await ipc.connect();
    return new NimbusClient(ipc);
  }

  async agentInvoke(
    input: string,
    options?: { stream?: boolean; sessionId?: string; agent?: string },
  ): Promise<{ reply?: string } & Record<string, unknown>> {
    return await this.ipc.call("agent.invoke", {
      input,
      stream: options?.stream ?? false,
      ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options?.agent === undefined ? {} : { agent: options.agent }),
    });
  }

  askStream(input: string, opts?: AskStreamOptions): AskStreamHandle {
    return createAskStream(this.ipc, input, opts);
  }

  subscribeHitl(handler: (req: HitlRequest) => void): { dispose(): void } {
    const onBatch = (params: unknown): void => {
      if (typeof params !== "object" || params === null) return;
      const p = params as Record<string, unknown>;
      if (typeof p["requestId"] !== "string" || typeof p["prompt"] !== "string") return;
      const req: HitlRequest =
        typeof p["streamId"] === "string"
          ? {
              requestId: p["requestId"],
              prompt: p["prompt"],
              details: p["details"],
              streamId: p["streamId"],
            }
          : { requestId: p["requestId"], prompt: p["prompt"], details: p["details"] };
      handler(req);
    };
    this.ipc.onNotification("agent.hitlBatch", onBatch);
    return {
      dispose: () => {
        // IPCClient has no off(); guarded by handler-side dedupe in HitlRouter
      },
    };
  }

  async getSessionTranscript(params: {
    sessionId: string;
    limit?: number;
  }): Promise<SessionTranscript> {
    return await this.ipc.call<SessionTranscript>("engine.getSessionTranscript", params);
  }

  async cancelStream(streamId: string): Promise<{ ok: boolean }> {
    return await this.ipc.call<{ ok: boolean }>("engine.cancelStream", { streamId });
  }

  async queryItems(params: {
    services?: string[];
    types?: string[];
    sinceMs?: number;
    untilMs?: number;
    limit?: number;
  }): Promise<{ items: Record<string, unknown>[]; meta: { limit: number; total: number } }> {
    return await this.ipc.call("index.queryItems", {
      services: params.services,
      types: params.types,
      sinceMs: params.sinceMs,
      untilMs: params.untilMs,
      limit: params.limit,
    });
  }

  async searchRanked(params: RankedSearchParams = {}): Promise<RankedSearchItem[]> {
    return await this.ipc.call<RankedSearchItem[]>("index.searchRanked", {
      name: params.name,
      service: params.service,
      itemType: params.itemType,
      limit: params.limit,
      semantic: params.semantic,
      contextChunks: params.contextChunks,
    });
  }

  async querySql(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
    return await this.ipc.call("index.querySql", { sql });
  }

  async auditList(limit?: number): Promise<unknown[]> {
    return await this.ipc.call("audit.list", { limit: limit ?? 50 });
  }

  async close(): Promise<void> {
    await this.ipc.disconnect();
  }
}
