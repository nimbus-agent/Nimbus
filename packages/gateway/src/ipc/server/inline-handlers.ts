import { randomUUID } from "node:crypto";
import {
  blockedRunWorkflow,
  prepareResume,
  ResumeError,
} from "../../automation/workflow-resume.ts";
import { workflowRunLock } from "../../automation/workflow-run-lock.ts";
import { nonRunStepLabels, parseWorkflowSteps } from "../../automation/workflow-steps.ts";
import { abandonWorkflowRunRow, getWorkflowByName } from "../../automation/workflow-store.ts";
import { asRecord } from "../../connectors/unknown-record.ts";
import { getAgentLimits } from "../../engine/agent-limits.ts";
import {
  type AgentRequestContext,
  agentRequestContext,
} from "../../engine/agent-request-context.ts";
import { ComputerUseTurnError } from "../../engine/computer-use-turn-error.ts";
import { GatewayAgentUnavailableError } from "../../engine/gateway-agent-error.ts";
import { driftHintsFromIndex } from "../../index/drift-hints.ts";
import type { AgentInvokeContext } from "../agent-invoke.ts";
import { type AgentInvokeContextLike, createAskStreamHandler } from "../engine-ask-stream.ts";
import type { ClientSession } from "../session.ts";
import { assertStreamIdHasNoNulByte, workflowRegistryKey } from "../workflow-cancel.ts";
import type { WorkflowRunContext } from "../workflow-invoke.ts";
import {
  agentInvokeRequestStore,
  buildAgentInvokePayload,
  parseAgentInvokeParams,
  parseOptionalString,
  sendAgentChunkIfStreaming,
} from "./agent-invoke-params.ts";
import type { ClientKind } from "./client-kind.ts";
import type { ServerCtx } from "./context.ts";
import {
  assertSemanticSearchReady,
  buildSearchRankedQuery,
  searchRankedOptions,
  shapeSearchRankedResult,
} from "./index-search-ranked.ts";
import { RpcMethodError } from "./rpc-error.ts";

/**
 * Which callers may be offered the owner-registered user-MCP tools on an agent turn (I42, PR 2).
 *
 * Only the LOCAL OWNER: `cli`, `ui`, and `unknown` — the plain CLI never declares a kind, so it
 * arrives as `unknown`. Never `mcp` (an MCP client reaching the index through `nimbus mcp-server`),
 * `http` (a bearer-token holder), `chatops` (a shared room), `fleet` (unattended) or `push`.
 *
 * TOTAL over `ClientKind` on purpose: a new kind is a compile error here until someone decides,
 * rather than silently inheriting either answer. The kind is the session's server-held one
 * (`ctx.getClientKind`), looked up for the connection the request ARRIVED on — never a param.
 * LAN peers never reach these handlers: the LanServer's `onMessage` dispatches federation RPC
 * only (`federation/federation-server.ts`), whatever `engine.askStream`'s LAN write-list entry
 * suggests.
 */
export const USER_MCP_OFFER_BY_KIND: Readonly<Record<ClientKind, boolean>> = {
  cli: true,
  ui: true,
  unknown: true,
  mcp: false,
  http: false,
  chatops: false,
  fleet: false,
  push: false,
};

/**
 * Which callers may be offered the model's connector-write door (Phase 9.7): `cli` and `ui` only.
 * STRICTER than {@link USER_MCP_OFFER_BY_KIND}: `unknown` is FALSE, so a client that does not
 * declare itself gets no door (the CLI's `ask`/`repl` declare `cli`, the desktop bridge `ui`).
 *
 * The declared kind is SELF-REPORTED, not an authorization: any local process on the user-only
 * socket can declare `cli`. The boundary is the local socket plus the owner's HITL prompt on every
 * call; this map keeps the MCP adapter (`mcp`), HTTP, ChatOps, fleet, push and non-declaring
 * clients out. TOTAL over `ClientKind`, so a new kind is a compile error here until decided.
 */
export const CONNECTOR_WRITE_OFFER_BY_KIND: Readonly<Record<ClientKind, boolean>> = {
  cli: true,
  ui: true,
  unknown: false,
  mcp: false,
  http: false,
  chatops: false,
  fleet: false,
  push: false,
};

/**
 * Which callers may drive a computer-use session through the model (I35, owner ruling OR-MCU-1):
 * `cli` ONLY. The desktop (`ui`) is excluded on purpose (OR-MCU-1: no desktop consent UX, and
 * `computer.approvalRespond` stays off the renderer allowlist, I7), as is every other kind. The
 * declared kind is self-reported on the user-only socket; every actuation still asks a person on
 * this connection (OR-MCU-2). TOTAL over `ClientKind`.
 */
export const COMPUTER_USE_OFFER_BY_KIND: Readonly<Record<ClientKind, boolean>> = {
  cli: true,
  ui: false,
  unknown: false,
  mcp: false,
  http: false,
  chatops: false,
  fleet: false,
  push: false,
};

function requireNonEmptyRpcString(rec: Record<string, unknown> | undefined, key: string): string {
  if (rec === undefined) {
    throw new RpcMethodError(-32602, `Missing or invalid ${key}`);
  }
  const v = rec[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new RpcMethodError(-32602, `Missing or invalid ${key}`);
  }
  return v.trim();
}

export async function dispatchAgentInvoke(
  ctx: ServerCtx,
  session: ClientSession,
  clientId: string,
  params: unknown,
): Promise<unknown> {
  const req = parseAgentInvokeParams(params);
  const clientKind = ctx.getClientKind(clientId);
  const offers = {
    offerUserMcpTools: USER_MCP_OFFER_BY_KIND[clientKind],
    offerConnectorWriteTools: CONNECTOR_WRITE_OFFER_BY_KIND[clientKind],
    offerComputerUse: COMPUTER_USE_OFFER_BY_KIND[clientKind],
  };
  const handler = ctx.getAgentInvokeHandler();
  if (handler === undefined) {
    return {
      reply: `Agent invoke is not configured (no handler). Echo: ${req.input.slice(0, 500)}`,
      stream: req.stream,
    };
  }
  try {
    return await agentRequestContext.run(agentInvokeRequestStore(req), async () =>
      handler(buildAgentInvokePayload(req, clientId, session, offers)),
    );
  } catch (e) {
    if (e instanceof GatewayAgentUnavailableError || e instanceof ComputerUseTurnError) {
      throw new RpcMethodError(-32000, e.message);
    }
    throw e;
  }
}

function parseWorkflowRunParamsOverride(
  rec: Record<string, unknown> | undefined,
): Readonly<Record<string, Record<string, unknown>>> | undefined {
  const raw = rec?.["paramsOverride"];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RpcMethodError(
      -32602,
      "workflow.run: paramsOverride must be an object keyed by step label",
    );
  }
  return raw as Readonly<Record<string, Record<string, unknown>>>;
}

/**
 * How a `workflow.run` started, derived from the client kind the CONNECTION declared (`cli` /
 * `ui` on the local socket); every other kind gets no trigger, so its write actions carry no
 * provenance. Never read from params (Phase 10 SA2, spec § 5.1).
 */
export function workflowTriggerOf(kind: ClientKind): WorkflowRunContext["trigger"] {
  if (kind === "cli") return "owner_cli";
  if (kind === "ui") return "owner_ui";
  return undefined;
}

/** A `trigger` or `provenance` key in the params would be a caller naming its own origin. */
function refuseSuppliedOrigin(rec: Record<string, unknown> | undefined): void {
  if (rec === undefined) return;
  for (const key of ["trigger", "provenance"]) {
    if (Object.hasOwn(rec, key)) {
      throw new RpcMethodError(
        -32602,
        `workflow.run: ${key} is derived by the gateway and may not be sent`,
      );
    }
  }
}

/**
 * Only `run` steps take `paramsOverride`: an entry keyed by a write or query step's label would
 * change what the hashed definition says (review S2-3). A workflow that is unknown or does not parse
 * is left to the runner, which reports it.
 */
function refuseNonRunOverrides(
  ctx: ServerCtx,
  workflowName: string,
  paramsOverride: unknown,
): void {
  if (paramsOverride === undefined || ctx.options.localIndex === undefined) return;
  const wf = getWorkflowByName(ctx.options.localIndex.getDatabase(), workflowName);
  if (wf === null) return;
  let fixed: string[];
  try {
    fixed = nonRunStepLabels(parseWorkflowSteps(wf.steps_json));
  } catch {
    return;
  }
  for (const key of Object.keys(paramsOverride as Record<string, unknown>)) {
    if (fixed.includes(key)) {
      throw new RpcMethodError(
        -32602,
        `workflow.run: paramsOverride may not name a write or query step ("${key}")`,
      );
    }
  }
}

function buildWorkflowRunContext(
  clientId: string,
  session: ClientSession,
  params: unknown,
  signal: AbortSignal,
  kind: ClientKind,
): { ctx: WorkflowRunContext; sessionId: string | undefined; streamId: string | undefined } {
  const rec = asRecord(params);
  refuseSuppliedOrigin(rec);
  const workflowName = requireNonEmptyRpcString(rec, "name");
  const triggeredBy = parseOptionalString(rec, "triggeredBy") ?? clientId;
  const dryRun = rec?.["dryRun"] === true;
  const stream = rec?.["stream"] === true;
  const sessionId = parseOptionalString(rec, "sessionId");
  const agent = parseOptionalString(rec, "agent");
  const paramsOverride = parseWorkflowRunParamsOverride(rec);
  const streamId = parseOptionalString(rec, "streamId");
  if (streamId !== undefined) {
    assertStreamIdHasNoNulByte(streamId, "workflow.run");
  }

  const ctx: WorkflowRunContext = {
    clientId,
    workflowName,
    triggeredBy,
    dryRun,
    stream,
    sendChunk: (text: string) => {
      sendAgentChunkIfStreaming(session, stream, text, streamId);
    },
    signal,
  };
  if (sessionId !== undefined) ctx.sessionId = sessionId;
  if (agent !== undefined) ctx.agent = agent;
  if (paramsOverride !== undefined) ctx.paramsOverride = paramsOverride;
  if (streamId !== undefined) ctx.streamId = streamId;
  const trigger = workflowTriggerOf(kind);
  if (trigger !== undefined) ctx.trigger = trigger;
  return { ctx, sessionId, streamId };
}

/** The refusals of `workflow.resume`, as RPC errors a client can match on `data.code`. */
const resumeError = (code: string, message: string): RpcMethodError =>
  new RpcMethodError(-32001, `${code}: ${message}`, { code });

/** The record `workflow.resume` takes: only `runId` and `discard`; nothing names its own origin. */
function resumeParams(params: unknown): { runId: string; discard: boolean } {
  const rec = asRecord(params);
  for (const key of ["trigger", "provenance", "clientKind", "resume", "name"]) {
    if (rec !== undefined && Object.hasOwn(rec, key)) {
      throw new RpcMethodError(
        -32602,
        `workflow.resume: ${key} is derived by the gateway and may not be sent`,
      );
    }
  }
  const runId = rec?.["runId"];
  if (typeof runId !== "string" || runId.trim() === "" || runId.length > 128) {
    throw new RpcMethodError(-32602, "workflow.resume: runId must be a run id");
  }
  return { runId: runId.trim(), discard: rec?.["discard"] === true };
}

/**
 * `workflow.resume { runId, discard? }` (Phase 10 SA4, plan task 7). Only the owner's CLI or desktop on
 * the local socket (the same declared-kind rule as the trigger; every other kind, and a LAN peer
 * whatever its `writeAllowed`, is refused). It takes the workflow's run lock, so it cannot overlap a
 * scheduled fire or another resume. `discard` abandons the blocked run and runs nothing; otherwise
 * the run continues from the blocked step on THIS connection's own executor, with a normal prompt
 * and the owner's trigger (so a standing rule may still cover it, as on any owner-started run).
 */
export async function dispatchWorkflowResumeRpc(
  ctx: ServerCtx,
  clientId: string,
  session: ClientSession,
  params: unknown,
): Promise<unknown> {
  if (ctx.options.localIndex === undefined) {
    throw new RpcMethodError(-32603, "Local index is not available");
  }
  const kind = ctx.getClientKind(clientId);
  if (workflowTriggerOf(kind) === undefined) {
    throw resumeError(
      "ERR_RESUME_LOCAL_ONLY",
      "a blocked run is resumed only from the owner's CLI or desktop on the local socket",
    );
  }
  const { runId, discard } = resumeParams(params);
  const db = ctx.options.localIndex.getDatabase();
  const handler = ctx.getWorkflowRunHandler();
  if (handler === undefined) {
    throw new RpcMethodError(-32603, "Workflow runner is not configured");
  }
  try {
    const target = discard ? blockedRunWorkflow(db, runId) : prepareResume(db, runId);
    const locked = await workflowRunLock.withLock(target.workflowId, async () => {
      if (discard) {
        abandonWorkflowRunRow(db, runId, Date.now());
        return { runId, status: "abandoned" };
      }
      const prepared = prepareResume(db, runId);
      const { ctx: workflowCtx } = buildWorkflowRunContext(
        clientId,
        session,
        { name: prepared.workflowName },
        new AbortController().signal,
        kind,
      );
      workflowCtx.resume = {
        runId,
        blockedStep: prepared.blockedStep,
        expectedSha256: prepared.expectedSha256,
      };
      return handler(workflowCtx);
    });
    if (locked === undefined) {
      throw resumeError(
        "ERR_WORKFLOW_BUSY",
        "the workflow is running right now; try again shortly",
      );
    }
    return locked.value;
  } catch (e) {
    if (e instanceof ResumeError) throw resumeError(e.code, e.message.replace(`${e.code}: `, ""));
    if (e instanceof Error && e.message.startsWith("ERR_")) {
      const code = e.message.split(":")[0] ?? "ERR_RESUME";
      throw resumeError(code, e.message.slice(code.length + 1).trim());
    }
    throw e;
  }
}

export async function dispatchWorkflowRunRpc(
  ctx: ServerCtx,
  clientId: string,
  session: ClientSession,
  params: unknown,
): Promise<unknown> {
  if (ctx.options.localIndex === undefined) {
    throw new RpcMethodError(-32603, "Local index is not available");
  }
  const handler = ctx.getWorkflowRunHandler();
  if (handler === undefined) {
    throw new RpcMethodError(-32603, "Workflow runner is not configured");
  }
  const ac = new AbortController();
  const {
    ctx: workflowCtx,
    sessionId,
    streamId,
  } = buildWorkflowRunContext(clientId, session, params, ac.signal, ctx.getClientKind(clientId));
  refuseNonRunOverrides(ctx, workflowCtx.workflowName, workflowCtx.paramsOverride);

  // The id is supplied by the CLIENT: workflow.run resolves only when the run
  // ends, so a server-minted id could never reach the caller in time to cancel.
  // That makes the key composite — a bare id is shared across every session on
  // this registry, so one client could otherwise abort another's run.
  const registryKey = streamId === undefined ? undefined : workflowRegistryKey(clientId, streamId);
  if (registryKey !== undefined) {
    if (ctx.streamRegistry.has(registryKey)) {
      throw new RpcMethodError(
        -32602,
        "workflow.run: streamId is already in use by a running workflow for this client",
      );
    }
    ctx.streamRegistry.register(registryKey, ac);
  }

  try {
    const requestStore: AgentRequestContext = {};
    if (sessionId !== undefined) {
      requestStore.sessionId = sessionId;
    }
    return await agentRequestContext.run(requestStore, async () => handler(workflowCtx));
  } catch (e) {
    if (e instanceof GatewayAgentUnavailableError) {
      throw new RpcMethodError(-32000, e.message);
    }
    throw e;
  } finally {
    if (registryKey !== undefined) {
      // Compare-and-delete: if this streamId was cancelled and reused while
      // this run was winding down, a plain unregister here would evict the
      // reuse's live entry instead of this run's (already-deleted) one.
      ctx.streamRegistry.unregisterIf(registryKey, ac);
    }
  }
}

export function rpcGatewayPing(ctx: ServerCtx, params: unknown): unknown {
  const extra = ctx.options.getEmbeddingStatus?.() ?? {};
  const base: Record<string, unknown> = {
    version: ctx.options.version,
    uptime: Date.now() - ctx.startedAtMs,
    // The boot-resolved caps (env > [llm] toml > default), not `Config`'s env-only snapshot.
    agentLimits: { ...getAgentLimits() },
    ...extra,
  };
  const rec = asRecord(params);
  if (rec?.["includeDrift"] !== true) {
    return base;
  }
  if (ctx.options.localIndex === undefined) {
    return { ...base, drift: { lines: ["Local index is not available."] as const } };
  }
  const lines = driftHintsFromIndex(ctx.options.localIndex.getDatabase());
  return { ...base, drift: { lines } };
}

export async function rpcIndexSearchRanked(ctx: ServerCtx, params: unknown): Promise<unknown> {
  if (ctx.options.localIndex === undefined) {
    throw new RpcMethodError(-32603, "Local index is not available");
  }
  const rec = asRecord(params);
  if (rec === undefined) {
    throw new RpcMethodError(-32602, "Invalid params");
  }
  const options = searchRankedOptions(rec);
  assertSemanticSearchReady(ctx, options.semantic);
  const query = buildSearchRankedQuery(rec);
  const result = await ctx.options.localIndex.searchRankedAsync(query, options);
  return shapeSearchRankedResult(result, rec["envelope"] === true);
}

export function rpcConsentRespond(ctx: ServerCtx, clientId: string, params: unknown): unknown {
  const err = ctx.consentImpl.handleRespond(clientId, params);
  if (err !== null) {
    throw new RpcMethodError(err.code, err.message);
  }
  return { ok: true };
}

export function rpcAuditList(ctx: ServerCtx, params: unknown): unknown {
  const rec = asRecord(params);
  let limit = 100;
  if (rec !== undefined && typeof rec["limit"] === "number" && Number.isFinite(rec["limit"])) {
    limit = Math.min(1000, Math.max(1, Math.floor(rec["limit"])));
  }
  if (ctx.options.localIndex === undefined) {
    return [];
  }
  return ctx.options.localIndex.listAudit(limit);
}

export function dispatchEngineAskStream(
  ctx: ServerCtx,
  session: ClientSession,
  clientId: string,
  params: unknown,
): Promise<{ streamId: string }> {
  const rec = asRecord(params);
  const input = rec !== undefined && typeof rec["input"] === "string" ? rec["input"] : "";
  const sessionIdRaw = rec?.["sessionId"];
  const sessionId =
    typeof sessionIdRaw === "string" && sessionIdRaw.trim() !== ""
      ? sessionIdRaw.trim()
      : undefined;

  const handler = ctx.getAgentInvokeHandler();
  if (handler === undefined) {
    throw new RpcMethodError(-32603, "No agent handler configured for engine.askStream");
  }
  // Decided from THIS session's kind, the same way `dispatchAgentInvoke` decides it — this is the
  // desktop/editor path, and wiring the decision into only one entry would leave the other open.
  const clientKind = ctx.getClientKind(clientId);
  const offerUserMcpTools = USER_MCP_OFFER_BY_KIND[clientKind];
  const offerConnectorWriteTools = CONNECTOR_WRITE_OFFER_BY_KIND[clientKind];

  const dispatch = createAskStreamHandler({
    registry: ctx.streamRegistry,
    randomId: () => randomUUID(),
    sessionWriteNotification: (n) => session.writeNotification(n),
    runWithRequestContext: (rc, fn) => {
      const requestStore: AgentRequestContext = {};
      if (rc.sessionId !== undefined) requestStore.sessionId = rc.sessionId;
      return agentRequestContext.run(requestStore, fn);
    },
    agentInvokeHandler: async (innerCtx: AgentInvokeContextLike) => {
      const payload: AgentInvokeContext = {
        clientId: innerCtx.clientId,
        input: innerCtx.input,
        stream: innerCtx.stream,
        sendChunk: innerCtx.sendChunk ?? (() => undefined),
        offerUserMcpTools,
        offerConnectorWriteTools,
      };
      if (innerCtx.sessionId !== undefined) payload.sessionId = innerCtx.sessionId;
      if (innerCtx.devil === true) payload.devil = true;
      return await handler(payload);
    },
  });

  const askParams: { input: string; sessionId?: string; devil?: boolean } = { input };
  if (sessionId !== undefined) askParams.sessionId = sessionId;
  // Same `=== true` rule as `dispatchAgentInvoke` — this is the UI/editor path into the mode.
  if (rec?.["devil"] === true) askParams.devil = true;
  return dispatch(clientId, askParams);
}
