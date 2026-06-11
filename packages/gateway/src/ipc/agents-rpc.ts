import type { Database } from "bun:sqlite";
import type { SynthesizerLlm } from "../agents/_lib/synthesize.ts";
import { emitCatchupBrief } from "../agents/catchup.ts";
import { emitConflictsBrief } from "../agents/conflicts.ts";
import { emitExpertBrief } from "../agents/expert.ts";
import { emitGhostBrief } from "../agents/ghost.ts";
import { emitHuddleBrief } from "../agents/huddle.ts";
import { emitImpactBrief } from "../agents/impact.ts";
import { loadNimbusUserFromConfigDir } from "../config/nimbus-toml.ts";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import type { sendFederatedOverWire } from "./lan-client.ts";
import type { BoxKeypair } from "./lan-crypto.ts";

export class AgentsRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "AgentsRpcError";
    this.rpcCode = rpcCode;
  }
}

export type AgentsRpcContext = {
  db: Database;
  llm?: SynthesizerLlm;
  notify: (method: string, params: unknown) => void;
  configDir?: string;
  index?: LocalIndex;
  selfIdentity?: BoxKeypair;
  sendOverWire?: typeof sendFederatedOverWire;
};

const MIN_TOPIC_LEN = 1;
const MAX_TOPIC_LEN = 1024;
const MAX_LIMIT = 25;

const MIN_FILE_LEN = 1;
const MAX_FILE_LEN = 2048;
const MIN_DEPTH = 1;
const MAX_IMPACT_DEPTH = 5;
const MAX_SERVICE_LEN = 64;

const MAX_SINCE_MS = 90 * 24 * 60 * 60 * 1000;
function requireExpertParams(params: unknown): { topicOrFile: string; limit?: number } {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "agents.expert requires { topicOrFile: string }");
  }
  const p = params as { topicOrFile?: unknown; limit?: unknown };
  if (typeof p.topicOrFile !== "string") {
    throw new AgentsRpcError(-32602, "topicOrFile must be a string");
  }
  const trimmed = p.topicOrFile.trim();
  if (trimmed.length < MIN_TOPIC_LEN || trimmed.length > MAX_TOPIC_LEN) {
    throw new AgentsRpcError(
      -32602,
      `topicOrFile must be ${MIN_TOPIC_LEN}..${MAX_TOPIC_LEN} chars after trim`,
    );
  }
  const out: { topicOrFile: string; limit?: number } = { topicOrFile: trimmed };
  if (p.limit !== undefined) {
    if (
      typeof p.limit !== "number" ||
      !Number.isInteger(p.limit) ||
      p.limit < 1 ||
      p.limit > MAX_LIMIT
    ) {
      throw new AgentsRpcError(-32602, `limit must be an integer in 1..${MAX_LIMIT}`);
    }
    out.limit = p.limit;
  }
  return out;
}

function requireImpactParams(params: unknown): {
  fileOrPrUrl: string;
  depth?: number;
  service?: string;
} {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "agents.impact requires { fileOrPrUrl: string }");
  }
  const p = params as { fileOrPrUrl?: unknown; depth?: unknown; service?: unknown };
  if (typeof p.fileOrPrUrl !== "string") {
    throw new AgentsRpcError(-32602, "fileOrPrUrl must be a string");
  }
  const trimmed = p.fileOrPrUrl.trim();
  if (trimmed.length < MIN_FILE_LEN || trimmed.length > MAX_FILE_LEN) {
    throw new AgentsRpcError(
      -32602,
      `fileOrPrUrl must be ${MIN_FILE_LEN}..${MAX_FILE_LEN} chars after trim`,
    );
  }
  const out: { fileOrPrUrl: string; depth?: number; service?: string } = { fileOrPrUrl: trimmed };
  if (p.depth !== undefined) {
    if (
      typeof p.depth !== "number" ||
      !Number.isInteger(p.depth) ||
      p.depth < MIN_DEPTH ||
      p.depth > MAX_IMPACT_DEPTH
    ) {
      throw new AgentsRpcError(
        -32602,
        `depth must be an integer in ${MIN_DEPTH}..${MAX_IMPACT_DEPTH}`,
      );
    }
    out.depth = p.depth;
  }
  if (p.service !== undefined) {
    if (
      typeof p.service !== "string" ||
      p.service.trim().length === 0 ||
      p.service.length > MAX_SERVICE_LEN
    ) {
      throw new AgentsRpcError(
        -32602,
        `service must be a non-empty string up to ${MAX_SERVICE_LEN} chars`,
      );
    }
    out.service = p.service.trim();
  }
  return out;
}

function requireCatchupParams(params: unknown): {
  sinceMs?: number;
  service?: string;
} {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "agents.catchup requires an object payload");
  }
  const p = params as { sinceMs?: unknown; service?: unknown };
  const out: { sinceMs?: number; service?: string } = {};
  if (p.sinceMs !== undefined) {
    if (
      typeof p.sinceMs !== "number" ||
      !Number.isInteger(p.sinceMs) ||
      p.sinceMs < 0 ||
      p.sinceMs > MAX_SINCE_MS
    ) {
      throw new AgentsRpcError(
        -32602,
        `sinceMs must be a non-negative integer up to ${MAX_SINCE_MS} ms (90 days)`,
      );
    }
    out.sinceMs = p.sinceMs;
  }
  if (p.service !== undefined) {
    if (
      typeof p.service !== "string" ||
      p.service.trim().length === 0 ||
      p.service.length > MAX_SERVICE_LEN
    ) {
      throw new AgentsRpcError(
        -32602,
        `service must be a non-empty string up to ${MAX_SERVICE_LEN} chars`,
      );
    }
    out.service = p.service.trim();
  }
  return out;
}

const MAX_NAMESPACE_LEN = 256;

/** Zero keypair used as a degraded-path fallback when federation is not configured. */
const ZERO_IDENTITY: BoxKeypair = {
  publicKey: new Uint8Array(32),
  secretKey: new Uint8Array(32),
};

function newSessionId(
  kind: "expert" | "impact" | "catchup" | "ghost" | "conflicts" | "huddle",
): string {
  return `${kind}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function parseNamespaces(p: { namespace?: unknown; namespaces?: unknown }): string[] {
  const raw = p.namespaces ?? p.namespace;
  if (raw === undefined) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const v of arr) {
    if (typeof v !== "string" || v.trim().length === 0 || v.length > MAX_NAMESPACE_LEN) {
      throw new AgentsRpcError(
        -32602,
        `namespace must be a non-empty string up to ${MAX_NAMESPACE_LEN} chars`,
      );
    }
    out.push(v.trim());
  }
  return out;
}

function requireFileParam(params: unknown): { file: string; namespaces: string[] } {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "requires { file: string }");
  }
  const p = params as { file?: unknown; namespace?: unknown; namespaces?: unknown };
  if (typeof p.file !== "string") {
    throw new AgentsRpcError(-32602, "requires { file: string }");
  }
  const trimmed = p.file.trim();
  if (trimmed.length < MIN_FILE_LEN || trimmed.length > MAX_FILE_LEN) {
    throw new AgentsRpcError(-32602, `file must be ${MIN_FILE_LEN}..${MAX_FILE_LEN} chars`);
  }
  return { file: trimmed, namespaces: parseNamespaces(p) };
}

function requireHuddleParams(params: unknown): { sinceMs?: number; namespaces: string[] } {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "agents.huddle requires an object payload");
  }
  const p = params as { sinceMs?: unknown; namespace?: unknown; namespaces?: unknown };
  const out: { sinceMs?: number; namespaces: string[] } = { namespaces: parseNamespaces(p) };
  if (p.sinceMs !== undefined) {
    if (
      typeof p.sinceMs !== "number" ||
      !Number.isInteger(p.sinceMs) ||
      p.sinceMs < 0 ||
      p.sinceMs > MAX_SINCE_MS
    ) {
      throw new AgentsRpcError(
        -32602,
        `sinceMs must be a non-negative integer up to ${MAX_SINCE_MS} ms`,
      );
    }
    out.sinceMs = p.sinceMs;
  }
  return out;
}

/**
 * Build the shared context base for the federated read-only agents. Degrades gracefully:
 * - missing index  → fresh LocalIndex on the existing db  (→ "no paired peers" gap)
 * - missing identity → zero keypair                       (→ any wire call fails → per-peer gap)
 * Never throws.
 */
function federatedAgentBase(ctx: AgentsRpcContext, sessionId: string) {
  const index = ctx.index ?? new LocalIndex(ctx.db);
  const selfIdentity = ctx.selfIdentity ?? ZERO_IDENTITY;
  const store = new KnownNamespaceStore(ctx.db);
  const base = { db: ctx.db, index, selfIdentity, store, notify: ctx.notify, sessionId };
  return {
    ...base,
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    ...(ctx.sendOverWire === undefined ? {} : { sendOverWire: ctx.sendOverWire }),
  };
}

async function handleExpert(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireExpertParams(params);
  const sessionId = newSessionId("expert");
  const expertCtx =
    ctx.llm === undefined
      ? { db: ctx.db, notify: ctx.notify, sessionId }
      : { db: ctx.db, llm: ctx.llm, notify: ctx.notify, sessionId };
  return await emitExpertBrief(input, expertCtx);
}

async function handleImpact(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireImpactParams(params);
  const sessionId = newSessionId("impact");
  const impactCtx =
    ctx.llm === undefined
      ? { db: ctx.db, notify: ctx.notify, sessionId }
      : { db: ctx.db, llm: ctx.llm, notify: ctx.notify, sessionId };
  return await emitImpactBrief(input, impactCtx);
}

async function handleCatchup(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireCatchupParams(params);
  const sessionId = newSessionId("catchup");
  const userToml = ctx.configDir === undefined ? {} : loadNimbusUserFromConfigDir(ctx.configDir);
  const catchupInput =
    userToml.mePersonId === undefined
      ? input
      : { ...input, mePersonIdOverride: userToml.mePersonId };
  const catchupCtx =
    ctx.llm === undefined
      ? { db: ctx.db, notify: ctx.notify, sessionId }
      : { db: ctx.db, llm: ctx.llm, notify: ctx.notify, sessionId };
  return await emitCatchupBrief(catchupInput, catchupCtx);
}

async function handleGhost(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireFileParam(params);
  return await emitGhostBrief(input, federatedAgentBase(ctx, newSessionId("ghost")));
}

async function handleConflicts(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireFileParam(params);
  return await emitConflictsBrief(input, federatedAgentBase(ctx, newSessionId("conflicts")));
}

async function handleHuddle(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireHuddleParams(params);
  return await emitHuddleBrief(input, federatedAgentBase(ctx, newSessionId("huddle")));
}

export async function dispatchAgentsRpc(
  method: string,
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<AgentsRpcContext>(method, params, ctx, {
    "agents.expert": handleExpert,
    "agents.impact": handleImpact,
    "agents.catchup": handleCatchup,
    "agents.ghost": handleGhost,
    "agents.conflicts": handleConflicts,
    "agents.huddle": handleHuddle,
  });
}
