import type { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { asRecord } from "../connectors/unknown-record.ts";
import { safeFetch } from "../share/safe-fetch.ts";
import { type CreateShareRequest, createShare, type ShareSink } from "../share/share-gate.ts";
import { ensureShareKeypair } from "../share/share-keypair.ts";
import { getShareRecord, listShareRecords, pruneExpiredShares } from "../share/share-store.ts";
import { verifyShareFromBytes, verifyShareFromInput } from "../share/verify-share.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  dispatchByMethod,
  type RpcMethodHandlerMap,
  type RpcMissOrHit,
} from "./_lib/dispatch-by-method.ts";

/** A `ShareRpcError` carries the JSON-RPC error code surfaced by the dispatcher chain. */
export class ShareRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "ShareRpcError";
    this.rpcCode = rpcCode;
  }
}

/**
 * Config-pinned HTTP sink (the only host the `--http` share sink may target). `url === ""` means the
 * http sink is not configured → `share.create` with an http sink fails closed. The bearer token is
 * Vault-only (Non-Negotiable #3): config holds only the Vault key NAME (`authVaultKey`).
 */
export interface ShareHttpSinkConfig {
  readonly url: string;
  readonly authHeaderName?: string;
  readonly authVaultKey?: string;
}

/** Pre-resolved session content handed to `createShare`'s sync `collectSession`. */
export interface ShareSessionContent {
  readonly turns: readonly { role: "user" | "assistant"; text: string; timestamp: number }[];
  readonly toolCalls: readonly {
    toolId: string;
    service: string;
    params: unknown;
    status: string;
  }[];
}

export interface ShareRpcCtx {
  readonly db: Database;
  readonly vault: NimbusVault;
  /** Origin display label embedded in the signed share body (e.g. the hostname). */
  readonly label: string;
  readonly now: () => number;
  /**
   * Pre-resolves the session content (async). `share.create` awaits this, then hands `createShare` a
   * sync closure over the result — keeping `createShare`'s sync `collectSession` contract intact.
   */
  readonly collectSession: (sessionId: string) => Promise<ShareSessionContent>;
  /**
   * The OWNER-HITL approval round-trip. In production this MUST route to the fail-closed
   * `shareConsent` broker (wired in `platform/assemble.ts`, D21-extension): a denied/timed-out
   * approval persists + signs NOTHING. Never an always-true stub.
   */
  readonly requestApproval: (
    sessionId: string,
    kind: string,
    sink: string,
    preview: unknown,
    redactionSet: readonly string[],
  ) => Promise<boolean>;
  readonly recordAudit: (e: {
    actionType: string;
    hitlStatus: string;
    actionJson: string;
    timestamp: number;
    sessionId?: string;
  }) => void;
  /** Owner-side answer to a pending approval → `shareConsent.respond`. Returns true if it matched. */
  readonly respondApproval: (requestId: string, approved: boolean) => boolean;
  readonly httpSink: ShareHttpSinkConfig;
}

function requireString(params: unknown, key: string): string {
  const rec = asRecord(params);
  const v = rec === undefined ? undefined : rec[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ShareRpcError(-32602, `ERR_INVALID_PARAMS: ${key} (non-empty string) required`);
  }
  return v;
}

/** Parse the caller's `sink` selector into a {@link ShareSink} + (for the file sink) a target path. */
function parseSink(params: unknown): { sink: ShareSink; filePath?: string } {
  const rec = asRecord(params) ?? {};
  const s = asRecord(rec["sink"]) ?? { type: "file" };
  const type = s["type"];
  if (type === "http") return { sink: { type: "http", url: "" } };
  if (type === "peer") {
    const peerId = typeof s["peerId"] === "string" ? s["peerId"] : "";
    return { sink: { type: "peer", peerId } };
  }
  if (type === undefined || type === "file") {
    const path = typeof s["path"] === "string" ? s["path"] : undefined;
    return { sink: { type: "file" }, ...(path === undefined ? {} : { filePath: path }) };
  }
  // Reject an unrecognized sink rather than silently coercing it to a file write.
  throw new ShareRpcError(-32602, `ERR_INVALID_PARAMS: unknown sink.type ${String(type)}`);
}

/** Escape a caller-supplied literal so it is matched verbatim (no regex injection / ReDoS). */
function literalToRegExp(s: string): RegExp {
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
}

async function emitFile(filePath: string, json: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await Bun.write(filePath, json);
}

async function emitHttp(ctx: ShareRpcCtx, json: string): Promise<void> {
  const url = ctx.httpSink.url;
  if (url === "") {
    throw new ShareRpcError(-32603, "ERR_SHARE_HTTP_SINK_UNCONFIGURED");
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ctx.httpSink.authHeaderName !== undefined && ctx.httpSink.authVaultKey !== undefined) {
    const token = await ctx.vault.get(ctx.httpSink.authVaultKey);
    if (token !== null) {
      headers[ctx.httpSink.authHeaderName] = token;
    }
  }
  // SSRF-safe (private-IP blocked); the host is the config-pinned [share.http_sink].url.
  await safeFetch(url, { method: "POST", headers, body: json });
}

const HANDLERS: RpcMethodHandlerMap<ShareRpcCtx> = {
  // CREATE — the I27 outbound-share chokepoint: collect → redact → owner HITL → sign+persist → emit.
  "share.create": async (params, ctx) => {
    const sessionId = requireString(params, "sessionId");
    const rec = asRecord(params) ?? {};
    const kind: "transcript" | "recipe" = rec["kind"] === "recipe" ? "recipe" : "transcript";
    const { sink, filePath } = parseSink(params);

    // Relative expiry (ms from now) → absolute expiresAt; caller redaction literals → escaped
    // global patterns threaded into the gate's redaction pass (no longer silent no-ops).
    const expiresMsRaw = rec["expiresMs"];
    const expiresAt =
      typeof expiresMsRaw === "number" && Number.isFinite(expiresMsRaw) && expiresMsRaw > 0
        ? ctx.now() + expiresMsRaw
        : null;
    const redactRaw = rec["redact"];
    const callerPatterns = Array.isArray(redactRaw)
      ? redactRaw.filter((x): x is string => typeof x === "string").map(literalToRegExp)
      : [];

    const content = await ctx.collectSession(sessionId);
    const req: CreateShareRequest = { sessionId, kind, sink, expiresAt, callerPatterns };

    const result = await createShare(req, {
      db: ctx.db,
      vault: ctx.vault,
      label: ctx.label,
      now: ctx.now,
      collectSession: () => content,
      requestApproval: (preview, redactionSet) =>
        ctx.requestApproval(sessionId, kind, sink.type, preview, redactionSet),
      recordAudit: ctx.recordAudit,
    });

    if (result.status !== "ok") {
      return { status: "rejected" } as const;
    }

    const json = JSON.stringify(result.share);
    if (sink.type === "file") {
      if (filePath !== undefined) {
        await emitFile(filePath, json);
      }
    } else if (sink.type === "http") {
      await emitHttp(ctx, json);
    }
    // peer sink: persisted + signed, but NOT forwarded over the wire yet (explicit Slice-8d stub).
    return { status: "ok", contentHash: result.share.contentHash } as const;
  },

  "share.list": (params, ctx) => {
    const rec = asRecord(params) ?? {};
    const includeExpired = rec["includeExpired"] === true;
    return { shares: listShareRecords(ctx.db, { now: ctx.now(), includeExpired }) };
  },

  "share.get": (params, ctx) => {
    const record = getShareRecord(ctx.db, requireString(params, "contentHash"));
    return { share: record ?? null };
  },

  "share.pubkey": async (_params, ctx) => {
    const kp = await ensureShareKeypair(ctx.vault);
    return { pubkey: kp.pubkeyB64 };
  },

  "share.verify": async (params, ctx) => {
    const rec = asRecord(params) ?? {};
    if (typeof rec["input"] === "string") {
      return await verifyShareFromInput(rec["input"], { now: ctx.now() });
    }
    if (typeof rec["bytesB64"] === "string") {
      const bytes = Uint8Array.from(Buffer.from(rec["bytesB64"], "base64"));
      return verifyShareFromBytes(bytes, { now: ctx.now() });
    }
    throw new ShareRpcError(-32602, "ERR_INVALID_PARAMS: input (url/path) or bytesB64 required");
  },

  "share.prune": (_params, ctx) => ({ removed: pruneExpiredShares(ctx.db, ctx.now()) }),

  // Owner answers a pending approval — mirrors federation.preflightRespond.
  "share.approvalRespond": (params, ctx) => {
    const rec = asRecord(params) ?? {};
    const matched = ctx.respondApproval(
      requireString(params, "requestId"),
      rec["approved"] === true,
    );
    return { matched };
  },
} as const;

export function dispatchShareRpc(
  method: string,
  params: unknown,
  ctx: ShareRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, HANDLERS);
}
