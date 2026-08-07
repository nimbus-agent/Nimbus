import type { Database } from "bun:sqlite";
import type { DecisionsInput } from "../agents/_lib/decisions-types.ts";
import type { GlossaryInput } from "../agents/_lib/glossary-types.ts";
import type { OwnershipInput } from "../agents/_lib/ownership-types.ts";
import type { SynthesizerLlm } from "../agents/_lib/synthesize.ts";
import type { WhyInput, WhyPeek } from "../agents/_lib/why-types.ts";
import { emitCatchupBrief } from "../agents/catchup.ts";
import { emitConflictsBrief } from "../agents/conflicts.ts";
import { emitDecisionsBrief } from "../agents/decisions.ts";
import { emitExpertBrief } from "../agents/expert.ts";
import { emitGhostBrief } from "../agents/ghost.ts";
import { emitGlossaryBrief } from "../agents/glossary.ts";
import { emitHuddleBrief } from "../agents/huddle.ts";
import { emitImpactBrief } from "../agents/impact.ts";
import { emitJanitorBrief } from "../agents/janitor.ts";
import { emitOwnershipBrief } from "../agents/ownership.ts";
import { emitPreflightBrief } from "../agents/preflight.ts";
import { emitWhyBrief } from "../agents/why.ts";
import { runWhyPeek } from "../agents/why-peek.ts";
import { loadNimbusFilesystemRootsFromConfigDir } from "../config/filesystem-toml.ts";
import {
  loadNimbusDecisionsFromConfigDir,
  loadNimbusUserFromConfigDir,
} from "../config/nimbus-toml.ts";
import { recordAgentBriefEgress } from "../egress/agent-brief-egress.ts";
import { egressSourceTypeForClientKind } from "../egress/egress-bearing-kinds.ts";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { ownershipRoots } from "../ownership/ownership-target.ts";
import {
  dispatchByMethod,
  type RpcMethodHandlerMap,
  type RpcMissOrHit,
} from "./_lib/dispatch-by-method.ts";
import type { sendFederatedOverWire } from "./lan-client.ts";
import type { BoxKeypair } from "./lan-crypto.ts";
import type { ClientKind } from "./server/client-kind.ts";

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
  /** Who is calling. Server-derived; absent in unit tests and non-socket callers. */
  caller?: { clientId: string; kind: ClientKind };
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
  kind:
    | "expert"
    | "impact"
    | "catchup"
    | "ghost"
    | "glossary"
    | "conflicts"
    | "huddle"
    | "janitor"
    | "preflight"
    | "why"
    | "decisions"
    | "ownership",
): string {
  return `${kind}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function parseNamespaces(p: { namespace?: unknown; namespaces?: unknown }): string[] {
  // `namespaces` (array) takes precedence over the singular `namespace` alias when both are given.
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
        `sinceMs must be a non-negative integer up to ${MAX_SINCE_MS} ms (90 days)`,
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
    // sendOverWire is a test-only DI seam; when omitted, peer-fanout falls back to the real
    // sendFederatedOverWire, so production agents fan out over the wire with no extra wiring.
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

function requireJanitorParams(params: unknown): {
  resourceRef: string;
  idleDays: number;
  cleanupAction: string | null;
  allowGaps: boolean;
} {
  if (params === null || typeof params !== "object") {
    throw new AgentsRpcError(-32602, "agents.janitor: object params required");
  }
  const p = params as Record<string, unknown>;
  const resourceRef = typeof p["resourceRef"] === "string" ? p["resourceRef"].trim() : "";
  if (resourceRef.length === 0) {
    throw new AgentsRpcError(-32602, "agents.janitor: resourceRef (non-empty string) required");
  }
  const idleDaysRaw = p["idleDays"];
  return {
    resourceRef,
    idleDays:
      typeof idleDaysRaw === "number" && Number.isInteger(idleDaysRaw) && idleDaysRaw > 0
        ? idleDaysRaw
        : 14,
    cleanupAction:
      typeof p["cleanupAction"] === "string" && p["cleanupAction"].length > 0
        ? p["cleanupAction"]
        : null,
    allowGaps: p["allowGaps"] === true,
  };
}

async function handleJanitor(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireJanitorParams(params);
  return await emitJanitorBrief(input, federatedAgentBase(ctx, newSessionId("janitor")));
}

function requirePreflightParams(params: unknown): {
  ref: string;
  namespace: string;
  changedSurface: string[];
} {
  if (params === null || typeof params !== "object") {
    throw new AgentsRpcError(-32602, "agents.preflight: object params required");
  }
  const p = params as Record<string, unknown>;
  const ref = typeof p["ref"] === "string" ? p["ref"].trim() : "";
  if (ref.length === 0) {
    throw new AgentsRpcError(-32602, "agents.preflight: ref (non-empty string) required");
  }
  const namespace = typeof p["namespace"] === "string" ? p["namespace"].trim() : "";
  if (namespace.length === 0) {
    throw new AgentsRpcError(-32602, "agents.preflight: namespace (non-empty string) required");
  }
  const surface = Array.isArray(p["changedSurface"])
    ? p["changedSurface"].filter((s): s is string => typeof s === "string")
    : [];
  return { ref, namespace, changedSurface: surface };
}

async function handlePreflight(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requirePreflightParams(params);
  return await emitPreflightBrief(input, federatedAgentBase(ctx, newSessionId("preflight")));
}

const MIN_REF_LEN = 1;
const MAX_REF_LEN = 1024;

function requireWhyParams(params: unknown): WhyInput {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "agents.why requires { ref: string, line?: number }");
  }
  const p = params as { ref?: unknown; line?: unknown };
  if (typeof p.ref !== "string") {
    throw new AgentsRpcError(-32602, `ref must be a non-empty string up to ${MAX_REF_LEN} chars`);
  }
  const trimmed = p.ref.trim();
  if (trimmed.length < MIN_REF_LEN || trimmed.length > MAX_REF_LEN) {
    throw new AgentsRpcError(-32602, `ref must be a non-empty string up to ${MAX_REF_LEN} chars`);
  }
  if (
    p.line !== undefined &&
    (typeof p.line !== "number" || !Number.isInteger(p.line) || p.line < 1)
  ) {
    throw new AgentsRpcError(-32602, "line must be a positive integer");
  }
  return { ref: trimmed, ...(p.line === undefined ? {} : { line: p.line }) };
}

function whyRoots(ctx: AgentsRpcContext) {
  return ctx.configDir === undefined ? [] : loadNimbusFilesystemRootsFromConfigDir(ctx.configDir);
}

async function handleWhy(params: unknown, ctx: AgentsRpcContext): Promise<{ sessionId: string }> {
  const input = requireWhyParams(params);
  const sessionId = newSessionId("why");
  return await emitWhyBrief(input, {
    db: ctx.db,
    roots: whyRoots(ctx),
    notify: ctx.notify,
    sessionId,
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
  });
}

/**
 * The namespace's first synchronous method: no coordinator, no LLM, no
 * notification — returns its payload directly (spec: "a 10-second hover is
 * not a hover").
 */
async function handleWhyPeek(params: unknown, ctx: AgentsRpcContext): Promise<WhyPeek> {
  const input = requireWhyParams(params);
  return await runWhyPeek(input, { db: ctx.db, roots: whyRoots(ctx) });
}

function requireGlossaryParams(params: unknown): GlossaryInput {
  if (params === null || typeof params !== "object") return {};
  const p = params as { term?: unknown; limit?: unknown };
  if (p.term !== undefined && typeof p.term !== "string") {
    throw new AgentsRpcError(-32602, "term must be a string");
  }
  if (
    p.limit !== undefined &&
    (typeof p.limit !== "number" || !Number.isInteger(p.limit) || p.limit < 1)
  ) {
    throw new AgentsRpcError(-32602, "limit must be a positive integer");
  }
  return {
    ...(p.term === undefined ? {} : { term: p.term }),
    ...(p.limit === undefined ? {} : { limit: p.limit as number }),
  };
}

async function handleGlossary(
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<{ sessionId: string }> {
  const input = requireGlossaryParams(params);
  return await emitGlossaryBrief(input, {
    db: ctx.db,
    notify: ctx.notify,
    sessionId: newSessionId("glossary"),
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
  });
}

function requireDecisionsParams(params: unknown): DecisionsInput {
  if (params === null || params === undefined) return {};
  if (typeof params !== "object") {
    throw new AgentsRpcError(-32602, "params must be an object");
  }
  const p = params as {
    sinceMs?: unknown;
    minConfidence?: unknown;
    service?: unknown;
    explain?: unknown;
    limit?: unknown;
  };
  if (
    p.sinceMs !== undefined &&
    (typeof p.sinceMs !== "number" || !Number.isInteger(p.sinceMs) || p.sinceMs < 0)
  ) {
    throw new AgentsRpcError(-32602, "sinceMs must be a non-negative integer");
  }
  if (
    p.minConfidence !== undefined &&
    (typeof p.minConfidence !== "number" || p.minConfidence < 0 || p.minConfidence > 1)
  ) {
    throw new AgentsRpcError(-32602, "minConfidence must be between 0 and 1");
  }
  if (p.service !== undefined && typeof p.service !== "string") {
    throw new AgentsRpcError(-32602, "service must be a string");
  }
  if (
    p.limit !== undefined &&
    (typeof p.limit !== "number" || !Number.isInteger(p.limit) || p.limit < 1)
  ) {
    throw new AgentsRpcError(-32602, "limit must be a positive integer");
  }
  return {
    ...(p.sinceMs === undefined ? {} : { sinceMs: p.sinceMs as number }),
    ...(p.minConfidence === undefined ? {} : { minConfidence: p.minConfidence as number }),
    ...(p.service === undefined ? {} : { service: p.service as string }),
    ...(p.explain === true ? { explain: true } : {}),
    ...(p.limit === undefined ? {} : { limit: p.limit as number }),
  };
}

/**
 * `[decisions].min_confidence` as the read-path floor a caller gets when it
 * sends no `minConfidence`. Read here rather than in `agents/decisions.ts` so
 * the agent keeps no config-file dependency, and re-read per call (like the
 * `[user]` block above) so an edit applies without a gateway restart. With no
 * `configDir` — the test/embedded shape — the agent falls back to `0`.
 */
function decisionsMinConfidenceDefault(ctx: AgentsRpcContext): number | undefined {
  return ctx.configDir === undefined
    ? undefined
    : loadNimbusDecisionsFromConfigDir(ctx.configDir).minConfidence;
}

async function handleDecisions(
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<{ sessionId: string }> {
  const input = requireDecisionsParams(params);
  const defaultMinConfidence = decisionsMinConfidenceDefault(ctx);
  return await emitDecisionsBrief(input, {
    db: ctx.db,
    notify: ctx.notify,
    sessionId: newSessionId("decisions"),
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    ...(defaultMinConfidence === undefined ? {} : { defaultMinConfidence }),
  });
}

function requireOwnershipParams(params: unknown): OwnershipInput {
  if (params === null || params === undefined) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "agents.ownership requires an object payload");
  }
  const p = params as { path?: unknown; service?: unknown };
  if (p.path !== undefined && p.service !== undefined) {
    throw new AgentsRpcError(
      -32602,
      "path and service are mutually exclusive — pass one, or neither for a coverage summary",
    );
  }
  const out: { path?: string; service?: string } = {};
  if (p.path !== undefined) {
    if (typeof p.path !== "string") {
      throw new AgentsRpcError(-32602, "path must be a string");
    }
    const trimmed = p.path.trim();
    if (trimmed.length < MIN_FILE_LEN || trimmed.length > MAX_FILE_LEN) {
      throw new AgentsRpcError(-32602, `path must be ${MIN_FILE_LEN}..${MAX_FILE_LEN} chars`);
    }
    out.path = trimmed;
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

/**
 * Roots are resolved HERE, not in the agent, so `agents/ownership.ts` keeps no config-file
 * dependency (the rule `handleDecisions` follows for `[decisions].min_confidence`), and are
 * re-read per call so a `[[filesystem.roots]]` edit or a fresh `nimbus index add` applies
 * without a gateway restart. With no configDir — the test/embedded shape — the root set is
 * empty and the brief reports that as its first gap rather than pretending to be complete.
 */
async function handleOwnership(
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<{ sessionId: string }> {
  const input = requireOwnershipParams(params);
  return await emitOwnershipBrief(input, {
    db: ctx.db,
    roots: ctx.configDir === undefined ? [] : ownershipRoots(ctx.configDir),
    notify: ctx.notify,
    sessionId: newSessionId("ownership"),
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
  });
}

/**
 * The `agents.*` methods this module answers.
 *
 * Declared once and used for BOTH the egress-append test and the dispatch, so the ledgered set is
 * definitionally the served set. A second, hand-maintained list of the same twelve strings is how
 * the over-counting defect this replaces was introduced: `method.startsWith("agents.")` appended an
 * `authorized` row for `agents.<anything>`, which then failed `-32601` having done no work — so
 * `nimbus prove` over-counted, and an unbounded caller-supplied `method` reached a hashed,
 * append-only column whose only mutation path is a HITL-gated prune.
 */
const AGENTS_RPC_HANDLERS = {
  "agents.expert": handleExpert,
  "agents.impact": handleImpact,
  "agents.catchup": handleCatchup,
  "agents.ghost": handleGhost,
  "agents.conflicts": handleConflicts,
  "agents.huddle": handleHuddle,
  "agents.janitor": handleJanitor,
  "agents.ownership": handleOwnership,
  "agents.preflight": handlePreflight,
  "agents.why": handleWhy,
  "agents.whyPeek": handleWhyPeek,
  "agents.glossary": handleGlossary,
  "agents.decisions": handleDecisions,
} as const satisfies RpcMethodHandlerMap<AgentsRpcContext>;

const AGENTS_METHOD_PREFIX = "agents.";

/**
 * Methods served on the socket but deliberately NOT exposed on the HTTP API.
 *
 * `agents.preflight` — the I24 federated-action path. A caller that can invoke it can queue consent
 * prompts on the owner's machine; an external caller must never originate one. Carried over
 * unchanged from the MCP tool surface, for the same reason.
 *
 * `agents.whyPeek` — the namespace's one SYNCHRONOUS method. It returns a WhyPeek payload directly
 * and never calls `notify`, so it cannot be represented on the HTTP `{runId}` + poll contract: the
 * run would never complete and the caller would poll until the TTL turned a success into a 410.
 * Exposing it needs its own inline-result route, which is a later decision rather than a second
 * response shape bolted onto this one. Note it is still LEDGERED when reached over any transport —
 * it is a member of AGENTS_RPC_HANDLERS, and the egress append is gated on that map, not on this
 * one.
 */
const HTTP_EXCLUDED_AGENT_METHODS: ReadonlySet<string> = new Set([
  "agents.preflight",
  "agents.whyPeek",
]);

/**
 * The agent names `POST /v1/agents/{agent}` accepts and `GET /v1/agents` publishes.
 *
 * DERIVED from AGENTS_RPC_HANDLERS so it cannot drift from the served set — a hand-maintained
 * second list of the same names is the defect shape that cost the most on the MCP work. Sorted for
 * a stable wire response.
 */
export const HTTP_AGENT_NAMES: readonly string[] = Object.freeze(
  Object.keys(AGENTS_RPC_HANDLERS)
    .filter((m) => !HTTP_EXCLUDED_AGENT_METHODS.has(m))
    .map((m) => m.slice(AGENTS_METHOD_PREFIX.length))
    // Explicit code-unit comparator, NOT `localeCompare` (which S2871's message suggests) and not a
    // bare `.sort()` (whose implicit string coercion is what S2871 flags). This array is a WIRE
    // RESPONSE: `localeCompare` is locale-sensitive, so two gateways under different locales could
    // publish the same eleven agents in different orders. The names are ASCII identifiers, so a
    // code-unit comparison is total, stable and identical on every machine.
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
);

/**
 * The `agents.*` method for an HTTP path segment, or null when that segment names nothing this
 * surface serves.
 *
 * `Object.hasOwn`, never `in`: the segment is caller-supplied, and `in` would resolve
 * `"constructor"` / `"toString"` against the object prototype. Same reasoning as the egress
 * append's membership gate.
 *
 * AGENTS_RPC_HANDLERS itself is NOT exported. Handing the map out would let another file invoke an
 * agent directly — a bypass D22(d) cannot see, since it is not an `agents/<name>.ts` import.
 */
export function resolveHttpAgentMethod(agent: string): string | null {
  const method = `${AGENTS_METHOD_PREFIX}${agent}`;
  if (!Object.hasOwn(AGENTS_RPC_HANDLERS, method)) return null;
  if (HTTP_EXCLUDED_AGENT_METHODS.has(method)) return null;
  return method;
}

export async function dispatchAgentsRpc(
  method: string,
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<RpcMissOrHit> {
  // I29/D22(c): an externally-originated brief is egress — the gateway synthesises from the private
  // index and hands the result to whatever model the calling client uses. Append BEFORE any work,
  // and let a failure propagate: no row, no brief. Gated on a RECOGNISED method, never on the
  // namespace prefix, so an unrecognised call is a `miss` that ledgers nothing.
  //
  // The caller kind selects the source type through a TOTAL map (egress/egress-bearing-kinds.ts)
  // rather than an equality. This read `ctx.caller?.kind === "mcp"` while stdio was the only
  // external transport; as an equality it was not wrong so much as unable to grow — the second
  // transport would have served briefs and appended nothing, passing every test. `cli`/`ui`/
  // `unknown`/absent map to null and append nothing, exactly as before.
  const egressSourceType = egressSourceTypeForClientKind(ctx.caller?.kind);
  if (egressSourceType !== null && Object.hasOwn(AGENTS_RPC_HANDLERS, method)) {
    recordAgentBriefEgress(ctx.db, {
      sourceType: egressSourceType,
      method,
      params,
      // Unreachable when null: a non-null source type implies ctx.caller exists. TypeScript cannot
      // narrow across the helper call, and `!` would assert what the compiler declines to check —
      // so the impossible branch is spelled out and made harmless instead.
      clientId: ctx.caller?.clientId ?? "",
      now: Date.now(),
    });
  }
  return dispatchByMethod<AgentsRpcContext>(method, params, ctx, AGENTS_RPC_HANDLERS);
}
