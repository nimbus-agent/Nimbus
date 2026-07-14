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
 * A single row of the append-only, BLAKE3-chained egress ledger.
 * Mirrors the Gateway's `EgressRow` shape (`egress/egress-verify.ts`).
 * The ledger records every gated outbound action before it dispatches.
 */
export type EgressRow = {
  id: number;
  timestamp: number;
  sourceType: string;
  sourceId: string | null;
  /** `serviceOf()` prefix of the action type — never a raw URL. */
  destination: string;
  method: string;
  /** Redacted, ≤256-byte debugging summary — NOT a security boundary. */
  payloadSummary: string;
  /** `"approved" | "not_required" | "rejected"`. */
  hitlStatus: string;
  /** `"authorized" | "blocked"`. */
  resultStatus: string;
  rowHash: string;
  prevHash: string;
};

/** Parameters for {@link NimbusClient.egressList}. */
export type EgressListParams = {
  /** Lower bound (inclusive) on row `timestamp`, epoch ms. */
  since?: number;
  /** Upper bound (inclusive) on row `timestamp`, epoch ms. */
  until?: number;
  /** Max rows. The Gateway clamps to 1..5000; default 1000. */
  limit?: number;
};

/** Result of {@link NimbusClient.egressList}. */
export type EgressListResult = {
  rows: EgressRow[];
};

/** Result of {@link NimbusClient.egressHead}: ledger head hash + row count. */
export type EgressHead = {
  head: string;
  count: number;
};

/**
 * Result of {@link NimbusClient.egressVerify}: an offline, timing-safe
 * BLAKE3-chain verification over the whole ledger.
 */
export type EgressVerifyResult = {
  ok: boolean;
  verifiedRows: number;
  /** Row id where the chain first broke, when `ok === false`. */
  brokenAt?: number;
  reason?: string;
};

/** Completeness tier attached to a prove-window result. */
export type EgressCompleteness = {
  tier: "authorized-actions";
  outboundEgressEvents: number;
};

/** An optional signed receipt over a prove-window (Ed25519, share keypair). */
export type EgressReceipt = {
  sigB64: string;
  pubkeyB64: string;
  digest: string;
};

/** Parameters for {@link NimbusClient.egressProveWindow}. */
export type EgressProveWindowParams = {
  /** Lower bound (inclusive) on the window, epoch ms. */
  since?: number;
  /** Upper bound (inclusive) on the window, epoch ms. */
  until?: number;
  /** When true, attach a signed `receipt` over the window digest. */
  sign?: boolean;
};

/** Result of {@link NimbusClient.egressProveWindow}. */
export type EgressProveWindowResult = {
  rows: EgressRow[];
  completeness: EgressCompleteness;
  /** Whole-ledger verify — the window claim is only sound if this is `ok`. */
  verify: EgressVerifyResult;
  receipt?: EgressReceipt;
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

  /** Egress ledger head hash + row count (read-only). */
  async egressHead(): Promise<EgressHead> {
    return await this.ipc.call<EgressHead>("egress.head");
  }

  /** List egress-ledger rows, optionally windowed and clamped (read-only). */
  async egressList(params: EgressListParams = {}): Promise<EgressListResult> {
    return await this.ipc.call<EgressListResult>("egress.list", {
      since: params.since,
      until: params.until,
      limit: params.limit,
    });
  }

  /** Offline, timing-safe verify of the whole egress chain (read-only). */
  async egressVerify(): Promise<EgressVerifyResult> {
    return await this.ipc.call<EgressVerifyResult>("egress.verify");
  }

  /**
   * Prove what left the machine in a window: the rows, the completeness tier,
   * a whole-ledger verify, and — when `sign` is set — a signed receipt.
   */
  async egressProveWindow(params: EgressProveWindowParams = {}): Promise<EgressProveWindowResult> {
    return await this.ipc.call<EgressProveWindowResult>("egress.proveWindow", {
      since: params.since,
      until: params.until,
      sign: params.sign,
    });
  }

  async close(): Promise<void> {
    await this.ipc.disconnect();
  }
}
