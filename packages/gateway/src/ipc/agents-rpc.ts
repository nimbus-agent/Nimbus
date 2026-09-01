import type { Database } from "bun:sqlite";
import type { DecisionsInput } from "../agents/_lib/decisions-types.ts";
import type { GlossaryInput } from "../agents/_lib/glossary-types.ts";
import type { OwnershipInput } from "../agents/_lib/ownership-types.ts";
import type { PremortemInput } from "../agents/_lib/premortem-types.ts";
import type { SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import {
  isWhyPrInput,
  type WhyInput,
  type WhyPeek,
  type WhyRefInput,
} from "../agents/_lib/why-types.ts";
import { emitCatchupBrief } from "../agents/catchup.ts";
import { emitConflictsBrief } from "../agents/conflicts.ts";
import { emitDecisionsBrief } from "../agents/decisions.ts";
import { emitExpertBrief } from "../agents/expert.ts";
import { emitGhostBrief } from "../agents/ghost.ts";
import { emitGlossaryBrief } from "../agents/glossary.ts";
import { emitHuddleBrief } from "../agents/huddle.ts";
import { emitImpactBrief } from "../agents/impact.ts";
import { emitJanitorBrief } from "../agents/janitor.ts";
import { emitNegotiateBrief, MAX_SINCE_MS as MAX_NEGOTIATE_SINCE_MS } from "../agents/negotiate.ts";
import { emitOwnershipBrief } from "../agents/ownership.ts";
import { emitPreflightBrief } from "../agents/preflight.ts";
import { emitPremortemBrief } from "../agents/premortem.ts";
import { emitWhyBrief } from "../agents/why.ts";
import { runWhyPeek } from "../agents/why-peek.ts";
import { loadNimbusFilesystemRootsFromConfigDir } from "../config/filesystem-toml.ts";
import {
  loadNimbusDecisionsFromConfigDir,
  loadNimbusNegotiateFromConfigDir,
  loadNimbusServiceConfigsFromConfigDir,
  loadNimbusUserFromConfigDir,
} from "../config/nimbus-toml.ts";
import { recordAgentBriefEgress } from "../egress/agent-brief-egress.ts";
import { egressSourceTypeForClientKind } from "../egress/egress-bearing-kinds.ts";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { buildServiceIdentityResolver } from "../metrics/service-identity.ts";
import { ownershipRoots } from "../ownership/ownership-target.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
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
  runner?: SynthesisRunner;
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
    | "ownership"
    | "premortem"
    | "negotiate",
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
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    // sendOverWire is a test-only DI seam; when omitted, peer-fanout falls back to the real
    // sendFederatedOverWire, so production agents fan out over the wire with no extra wiring.
    ...(ctx.sendOverWire === undefined ? {} : { sendOverWire: ctx.sendOverWire }),
  };
}

async function handleExpert(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireExpertParams(params);
  const sessionId = newSessionId("expert");
  const expertCtx =
    ctx.runner === undefined
      ? { db: ctx.db, notify: ctx.notify, sessionId }
      : { db: ctx.db, runner: ctx.runner, notify: ctx.notify, sessionId };
  return await emitExpertBrief(input, expertCtx);
}

async function handleImpact(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireImpactParams(params);
  const sessionId = newSessionId("impact");
  const impactCtx =
    ctx.runner === undefined
      ? { db: ctx.db, notify: ctx.notify, sessionId }
      : { db: ctx.db, runner: ctx.runner, notify: ctx.notify, sessionId };
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
    ctx.runner === undefined
      ? { db: ctx.db, notify: ctx.notify, sessionId }
      : { db: ctx.db, runner: ctx.runner, notify: ctx.notify, sessionId };
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
const MAX_PR_URL_LEN = 2048;

function requireWhyRefParams(params: unknown): WhyRefInput {
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

/**
 * True when an http(s)-shaped URL carries userinfo (`user:pass@host`).
 * `new URL()` parses that happily, and forwarding it downstream would land
 * plaintext credentials in the brief's `query.ref` and get rendered back in
 * the miss line — this repo's rule is explicit: never store plaintext
 * credentials in logs, IPC messages, configuration, or source. This is the
 * durable fix: every caller of `agents.why` (the browser extension included)
 * goes through this validator, not just the CLI. An unparseable `prUrl` has
 * nothing to check here; `resolveItemByUrl` rejects it later as
 * `unresolvable_url`.
 */
function prUrlHasCredentials(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return false;
  }
}

/**
 * One URL-shaped arm's value, validated.
 *
 * Extracted so `prUrl` and `itemUrl` cannot drift apart: both come off a browser address
 * bar, so both need the same length bound and the same userinfo rejection. A second copy
 * of these three checks is a second thing to remember to update.
 */
function requireUrlArm(value: unknown, name: "prUrl" | "itemUrl"): string {
  if (typeof value !== "string") {
    throw new AgentsRpcError(-32602, `${name} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PR_URL_LEN) {
    throw new AgentsRpcError(-32602, `${name} must be 1..${MAX_PR_URL_LEN} chars after trim`);
  }
  if (prUrlHasCredentials(trimmed)) {
    throw new AgentsRpcError(-32602, `${name} must not contain userinfo (user:pass@) credentials`);
  }
  return trimmed;
}

const WHY_ARMS_MESSAGE = "agents.why requires exactly one of { ref }, { prUrl } or { itemUrl }";

function requireWhyParams(params: unknown): WhyInput {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, WHY_ARMS_MESSAGE);
  }
  const p = params as { ref?: unknown; prUrl?: unknown; itemUrl?: unknown };
  // A COUNT, not the `hasRef === hasPrUrl` equality this replaced: that trick reads
  // "exactly one" only while there are exactly two arms, and silently starts meaning
  // "an odd number" at three. Counting says what it means at any arity.
  const supplied = [p.ref, p.prUrl, p.itemUrl].filter((v) => v !== undefined).length;
  if (supplied !== 1) {
    throw new AgentsRpcError(-32602, WHY_ARMS_MESSAGE);
  }
  if (p.itemUrl !== undefined) {
    return { itemUrl: requireUrlArm(p.itemUrl, "itemUrl") };
  }
  if (p.prUrl !== undefined) {
    return { prUrl: requireUrlArm(p.prUrl, "prUrl") };
  }
  return requireWhyRefParams(params);
}

function whyRoots(ctx: AgentsRpcContext) {
  return ctx.configDir === undefined ? [] : loadNimbusFilesystemRootsFromConfigDir(ctx.configDir);
}

async function handleWhy(params: unknown, ctx: AgentsRpcContext): Promise<{ sessionId: string }> {
  const input = requireWhyParams(params);
  const sessionId = newSessionId("why");
  // `runWhy` never reads `roots` on the `prUrl` arm (it has no file/line subject to resolve
  // against a filesystem root) — skip the per-call TOML read on that arm rather than doing it
  // for nothing on the browser-facing path.
  const roots = isWhyPrInput(input) ? [] : whyRoots(ctx);
  return await emitWhyBrief(input, {
    db: ctx.db,
    roots,
    notify: ctx.notify,
    sessionId,
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
  });
}

/**
 * The namespace's first synchronous method: no coordinator, no LLM, no
 * notification — returns its payload directly (spec: "a 10-second hover is
 * not a hover").
 */
async function handleWhyPeek(params: unknown, ctx: AgentsRpcContext): Promise<WhyPeek> {
  const input = requireWhyRefParams(params);
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
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
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
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    ...(defaultMinConfidence === undefined ? {} : { defaultMinConfidence }),
  });
}

const MAX_PERSON_ID_LEN = 256;

/**
 * `agents.negotiate`'s OWN `sinceMs` bound — deliberately NOT the shared `MAX_SINCE_MS` (90
 * days) every sibling validator uses. `MAX_SINCE_MS` is sized for `catchup`'s "what happened
 * while I was away" use case; negotiate's headline use is preparing for a review cycle, and an
 * annual review needs a year of evidence. Clamping negotiate to a quarter would make the agent
 * unable to answer the question it exists for — see `agents/negotiate.ts`'s own
 * `MAX_SINCE_MS = 365 days`, which this IMPORTS (aliased) rather than restates. A second copy of
 * the literal was the shape to avoid: the two files diverging fails SILENTLY — the IPC would
 * accept a window `runNegotiate` then clamps with `Math.min`, printing a smaller window than the
 * caller asked for, which is the exact silent-clamping behaviour the explicit rejection below
 * exists to replace. This is a per-method bound, not a broader raise: every other `require*Params`
 * validator in this file stays on the shared 90-day constant.
 */
function requireNegotiateParams(params: unknown): { sinceMs?: number; personId?: string } {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "agents.negotiate requires an object payload");
  }
  const p = params as { sinceMs?: unknown; personId?: unknown };
  const out: { sinceMs?: number; personId?: string } = {};
  if (p.sinceMs !== undefined) {
    if (
      typeof p.sinceMs !== "number" ||
      !Number.isInteger(p.sinceMs) ||
      p.sinceMs < 0 ||
      p.sinceMs > MAX_NEGOTIATE_SINCE_MS
    ) {
      throw new AgentsRpcError(
        -32602,
        `sinceMs must be a non-negative integer up to ${MAX_NEGOTIATE_SINCE_MS} ms (365 days)`,
      );
    }
    out.sinceMs = p.sinceMs;
  }
  if (p.personId !== undefined) {
    if (
      typeof p.personId !== "string" ||
      p.personId.trim().length === 0 ||
      p.personId.length > MAX_PERSON_ID_LEN
    ) {
      throw new AgentsRpcError(
        -32602,
        `personId must be a non-empty string up to ${MAX_PERSON_ID_LEN} chars`,
      );
    }
    out.personId = p.personId.trim();
  }
  return out;
}

/**
 * `[negotiate] personal_sources` (spec § 3.3) — the personal-docs consent gate. Resolved HERE,
 * not defaulted inside `agents/negotiate.ts`, mirroring `handleOwnership`'s root-resolution rule:
 * `NegotiateContext.personalSources` is a REQUIRED field (Task 6), specifically so no caller can
 * omit it and silently disable the opt-in while `nimbus.toml` still claims it is active. With no
 * `configDir` — the test/embedded shape — the personal-docs opt-in is off (empty list), the same
 * fail-safe-toward-excluding default `nimbus-toml.ts` uses when the section is absent.
 */
function negotiatePersonalSources(ctx: AgentsRpcContext): readonly string[] {
  return ctx.configDir === undefined
    ? []
    : loadNimbusNegotiateFromConfigDir(ctx.configDir).personalSources;
}

async function handleNegotiate(
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<{ sessionId: string }> {
  const input = requireNegotiateParams(params);
  return await emitNegotiateBrief(input, {
    db: ctx.db,
    notify: ctx.notify,
    sessionId: newSessionId("negotiate"),
    personalSources: negotiatePersonalSources(ctx),
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
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
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
  });
}

/**
 * `services` (array, matching the CLI's repeatable `--service`) overrides derivation entirely —
 * see `agents/premortem.ts`'s `runPremortem`. `repropose` backs `nimbus pre-mortem <ref>
 * --repropose` (Task 5): clears this epic's watcher-proposal tombstones before the proposal path
 * runs. Both optional; omitting `services` lets the agent derive affected services itself.
 */
/**
 * Cap on `services`, which the per-entry 64-char bound does not provide.
 *
 * `agents.premortem` is the one renderer-callable agent that WRITES: every accepted service
 * becomes a `watcher` row plus a `premortem_watcher_proposal` tombstone. Without a length bound a
 * single call could ask for an unbounded number of both. 32 is comfortably above any real epic —
 * `affectedServicesForEpic` derives one service per distinct repo the epic's child PRs touch.
 */
const MAX_PREMORTEM_SERVICES = 32;

/**
 * The `epicRef` string, validated and trimmed.
 *
 * Both the type check and the length check raise the SAME message on purpose:
 * from the caller's side "you sent a number" and "you sent an empty string" are
 * the same mistake — the ref is not a usable reference — and splitting the
 * wording would imply a distinction the handler does not act on.
 */
function requireEpicRef(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new AgentsRpcError(
      -32602,
      `epicRef must be a non-empty string up to ${MAX_REF_LEN} chars`,
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length < MIN_REF_LEN || trimmed.length > MAX_REF_LEN) {
    throw new AgentsRpcError(
      -32602,
      `epicRef must be a non-empty string up to ${MAX_REF_LEN} chars`,
    );
  }
  return trimmed;
}

/**
 * The optional `services` override, or `undefined` when absent.
 *
 * Every rejection is a hard error rather than a filter: a caller who names five
 * services and gets three silently dropped would read the resulting brief as
 * covering all five. The count cap is enforced BEFORE the per-entry walk so a
 * caller cannot make the gateway iterate an arbitrarily long array to discover
 * it was too long.
 */
function readServiceOverrides(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new AgentsRpcError(-32602, "services must be an array of strings");
  }
  if (raw.length > MAX_PREMORTEM_SERVICES) {
    throw new AgentsRpcError(-32602, `services accepts at most ${MAX_PREMORTEM_SERVICES} entries`);
  }
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || v.trim().length === 0 || v.length > MAX_SERVICE_LEN) {
      throw new AgentsRpcError(
        -32602,
        `each service must be a non-empty string up to ${MAX_SERVICE_LEN} chars`,
      );
    }
    out.push(v.trim());
  }
  return out;
}

function requirePremortemParams(params: unknown): PremortemInput {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "agents.premortem requires { epicRef: string }");
  }
  const p = params as { epicRef?: unknown; services?: unknown; repropose?: unknown };
  const epicRef = requireEpicRef(p.epicRef);
  const serviceOverrides = readServiceOverrides(p.services);
  if (p.repropose !== undefined && typeof p.repropose !== "boolean") {
    throw new AgentsRpcError(-32602, "repropose must be a boolean");
  }
  return {
    epicRef,
    ...(serviceOverrides === undefined ? {} : { serviceOverrides }),
    ...(p.repropose === true ? { repropose: true } : {}),
  };
}

/**
 * Resolved HERE, not in the agent, mirroring `handleOwnership`'s root-resolution rule: it keeps
 * `agents/premortem.ts` free of a config-file dependency, and is re-read per call so a
 * `[metrics.dora.*]`/`[ci.service.*]` edit applies without a gateway restart. Same construction
 * `ipc/index-regraph-rpc.ts` uses for the same resolver — the "same place other agents get their
 * service-identity resolver" the incident-coupling gap (Task 4) pointed at. With no `configDir` —
 * the test/embedded shape — the resolver is left unset and incident coupling reports a named gap
 * rather than a fabricated measurement.
 *
 * DEGRADES rather than throws. `loadNimbusServiceConfigsFromConfigDir` reads and parses
 * `nimbus.toml` with no internal try/catch (`config/nimbus-toml.ts:1941-1965`), and rejects a
 * malformed `[metrics.dora.*]` / `[ci.service.*]` block outright — a bad `deploy_workflow_pattern`
 * regex, a missing `repos`, an out-of-range incident window — as does an unreadable file. Left
 * unguarded, a single config typo would take down the WHOLE brief: this runs before
 * `emitPremortemBrief`, so nothing would be emitted at all, and the four lanes that never touch
 * service identity would be lost along with the one that does. Falling back to no resolver puts
 * incident coupling on the exact path the no-`configDir` case already takes — a named gap, never a
 * fabricated measurement — and leaves every other lane intact. The same degrade-don't-abort call
 * was made for gateway startup in `platform/assemble.ts`'s `loadServiceConfigsOrDegrade` (M-1).
 *
 * The cause is written to stderr because the incident-coupling gap note cannot name it: that note
 * is authored in `premortem/risks.ts`, which is deliberately database- and config-free and is
 * already hedged across the two causes it CAN distinguish. Silently widening it to cover a third
 * would state a cause that may not be true. `loadNimbusServiceConfigsFromConfigDir` warns on
 * stderr the same way for duplicate service ids.
 */
function premortemResolveServiceId(ctx: AgentsRpcContext) {
  const { configDir } = ctx;
  if (configDir === undefined) return undefined;
  try {
    return buildServiceIdentityResolver(loadNimbusServiceConfigsFromConfigDir(configDir));
  } catch (err) {
    process.stderr.write(
      `agents.premortem: failed to load [metrics.dora.*]/[ci.service.*] from nimbus.toml ` +
        `(${err instanceof Error ? err.message : String(err)}); incident coupling will report ` +
        `an unmeasurable gap until this is fixed.\n`,
    );
    return undefined;
  }
}

async function handlePremortem(
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<{ sessionId: string }> {
  const input = requirePremortemParams(params);
  const resolveServiceId = premortemResolveServiceId(ctx);
  return await emitPremortemBrief(input, {
    db: ctx.db,
    notify: ctx.notify,
    sessionId: newSessionId("premortem"),
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    ...(resolveServiceId === undefined ? {} : { resolveServiceId }),
  });
}

/**
 * The `agents.*` methods this module answers.
 *
 * Declared once and used for BOTH the egress-append test and the dispatch, so the ledgered set is
 * definitionally the served set. A second, hand-maintained list of the same fifteen strings is how
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
  "agents.premortem": handlePremortem,
  "agents.preflight": handlePreflight,
  "agents.why": handleWhy,
  "agents.whyPeek": handleWhyPeek,
  "agents.glossary": handleGlossary,
  "agents.decisions": handleDecisions,
  "agents.negotiate": handleNegotiate,
} as const satisfies RpcMethodHandlerMap<AgentsRpcContext>;

const AGENTS_METHOD_PREFIX = "agents.";

/**
 * Methods served on the socket but deliberately NOT exposed on any EXTERNAL surface — today the
 * HTTP API (`POST /v1/agents/{agent}` / `GET /v1/agents`); ChatOps is the next surface to consume
 * this same set, via `resolveExternalAgentMethod`/`EXTERNAL_AGENT_NAMES` below. This exclusion set
 * is not HTTP-specific reasoning re-applied by coincidence — it is INHERITED, not re-decided, by
 * every external surface that reaches this map: every reason below is *stronger*, not weaker, in a
 * shared channel like ChatOps, where a prompt is typed by one person and read by everyone in the
 * room.
 *
 * `agents.preflight` — the I24 federated-action path. A caller that can invoke it can queue consent
 * prompts on the owner's machine; an external caller must never originate one. Carried over
 * unchanged from the MCP tool surface, for the same reason. In a shared channel this is WORSE, not
 * better: anyone who can type in the channel could queue a consent prompt on the owner's machine.
 *
 * `agents.whyPeek` — the namespace's one SYNCHRONOUS method. It returns a WhyPeek payload directly
 * and never calls `notify`, so it cannot be represented on the HTTP `{runId}` + poll contract: the
 * run would never complete and the caller would poll until the TTL turned a success into a 410.
 * Exposing it needs its own inline-result route, which is a later decision rather than a second
 * response shape bolted onto this one. Note it is still LEDGERED when reached over any transport —
 * it is a member of AGENTS_RPC_HANDLERS, and the egress append is gated on that map, not on this
 * one.
 *
 * `agents.premortem` — unlike every other brief in this map, building it is NOT a pure read:
 * `runPremortem` calls `proposeWatchers`, which writes paused `watcher` rows (and their
 * `premortem_watcher_proposal` tombstone) directly via `insertWatcherIfAbsent` — no HITL gate,
 * because the watcher is created paused rather than armed. `repropose: true` goes further and
 * DELETES this epic's tombstones outright. Those writes were reviewed and accepted for a
 * same-machine caller (CLI socket, Tauri renderer — I7's XSS threat model, not "arbitrary
 * network caller"), but an external caller reaching them unprompted is the same shape of
 * concern `agents.preflight` is excluded for: side effects on the owner's machine an external
 * caller can trigger without the owner initiating them. In a shared channel, anyone able to post a
 * command could trigger these writes — worse than a single bearer-token holder. Keep this out of
 * every external surface until that gets its own deliberate review — carried over from the MCP
 * tool surface, which also does not define a premortem tool.
 *
 * `agents.negotiate` — excluded for a DIFFERENT reason than the three above: it has no side
 * effects (it writes nothing) and its response shape fits the runId+poll contract fine, so
 * neither the `preflight`/`premortem` nor the `whyPeek` criterion applies. Combined with
 * `--person`, external exposure would let any holder of the `agents` token/scope assemble a
 * contribution dossier on any indexed person without the owner initiating it. The CLI and Tauri
 * renderer are same-machine, owner-initiated surfaces (I7's XSS threat model, not "arbitrary
 * network caller"); the local HTTP API is not — a bearer token can be held and replayed by
 * anything on the loopback/LAN boundary that surface trusts. A shared ChatOps channel makes this
 * exclusion's reasoning *stronger*, not weaker: `negotiate --person` is a dossier-builder for
 * anyone who can read the room, not just a single token holder.
 */
const EXTERNAL_EXCLUDED_AGENT_METHODS: ReadonlySet<string> = new Set([
  "agents.preflight",
  "agents.premortem",
  "agents.whyPeek",
  "agents.negotiate",
]);

/**
 * The agent names every external surface accepts — today `POST /v1/agents/{agent}` and
 * `GET /v1/agents` publish exactly this set; ChatOps consumes the same names rather than deciding
 * its own.
 *
 * DERIVED from AGENTS_RPC_HANDLERS so it cannot drift from the served set — a hand-maintained
 * second list of the same names is the defect shape that cost the most on the MCP work. Sorted for
 * a stable wire response.
 */
export const EXTERNAL_AGENT_NAMES: readonly string[] = Object.freeze(
  Object.keys(AGENTS_RPC_HANDLERS)
    .filter((m) => !EXTERNAL_EXCLUDED_AGENT_METHODS.has(m))
    .map((m) => m.slice(AGENTS_METHOD_PREFIX.length))
    // The SHARED `codeUnitCompare` (`util/code-unit-compare.ts`), not an inline
    // `(a, b) => a < b ? -1 : a > b ? 1 : 0` — that nested ternary was S3358, and the same ordering
    // rule already had one home, used by the share canonicalizer.
    // Explicit code-unit comparator, NOT `localeCompare` (which S2871's message suggests) and not a
    // bare `.sort()` (whose implicit string coercion is what S2871 flags). This array is a WIRE
    // RESPONSE: `localeCompare` is locale-sensitive, so two gateways under different locales could
    // publish the same eleven agents in different orders. The names are ASCII identifiers, so a
    // code-unit comparison is total, stable and identical on every machine.
    .sort(codeUnitCompare),
);

/**
 * The `agents.*` method for a caller-supplied agent name (an HTTP path segment, a ChatOps command
 * argument, …), or null when that name names nothing this — any — external surface serves.
 *
 * `Object.hasOwn`, never `in`: the name is caller-supplied, and `in` would resolve
 * `"constructor"` / `"toString"` against the object prototype. Same reasoning as the egress
 * append's membership gate.
 *
 * AGENTS_RPC_HANDLERS itself is NOT exported. Handing the map out would let another file invoke an
 * agent directly — a bypass D22(d) cannot see, since it is not an `agents/<name>.ts` import.
 */
export function resolveExternalAgentMethod(agent: string): string | null {
  const method = `${AGENTS_METHOD_PREFIX}${agent}`;
  if (!Object.hasOwn(AGENTS_RPC_HANDLERS, method)) return null;
  if (EXTERNAL_EXCLUDED_AGENT_METHODS.has(method)) return null;
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
