import { asRecord } from "../../connectors/unknown-record.ts";
import type { AgentRequestContext } from "../../engine/agent-request-context.ts";
import { GAS_LIMIT_REACHED_NOTIFICATION, type GasLimitEvent } from "../../engine/step-budget.ts";
import { type AtTimeError, parseAtParam } from "../../util/point-in-time-parse.ts";
import { gatewayZone } from "../../util/zoned-time.ts";
import type { AgentInvokeContext } from "../agent-invoke.ts";
import type { ClientSession } from "../session.ts";
import { RpcMethodError } from "./rpc-error.ts";

/** What `dispatchAgentInvoke` reads from the wire, parsed and validated, before any handler runs. */
export interface AgentInvokeRequest {
  readonly input: string;
  readonly stream: boolean;
  readonly sessionId: string | undefined;
  readonly agent: string | undefined;
  readonly devil: boolean;
  readonly pointInTimeMs: number | undefined;
  readonly streamId: string | undefined;
  readonly computerSessionId: string | undefined;
}

export interface AgentInvokeOffers {
  readonly offerUserMcpTools: boolean;
  readonly offerConnectorWriteTools: boolean;
  readonly offerComputerUse: boolean;
}

export function parseOptionalString(
  rec: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const raw = rec?.[key];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return raw.trim();
}

export function sendAgentChunkIfStreaming(
  session: ClientSession,
  stream: boolean,
  text: string,
  streamId?: string,
): void {
  if (!stream) {
    return;
  }
  session.writeNotification({
    jsonrpc: "2.0",
    method: "agent.chunk",
    // Additive by design: without a streamId the params are byte-identical to
    // what every shipped client already parses.
    params: streamId === undefined ? { text } : { streamId, text },
  });
}

/**
 * UNICAST to the acting session — never `ctx.broadcastNotification`: the event describes one
 * caller's turn, and its `streamId` is that caller's own. Sent whether or not the call streams
 * (the reply's disclosure line carries the same fact for clients that ignore notifications).
 */
function sendGasLimitReached(
  session: ClientSession,
  event: GasLimitEvent,
  streamId: string | undefined,
): void {
  session.writeNotification({
    jsonrpc: "2.0",
    method: GAS_LIMIT_REACHED_NOTIFICATION,
    params: streamId === undefined ? { ...event } : { ...event, streamId },
  });
}

function parseAgentInvokeAt(raw: unknown): number | undefined {
  try {
    return parseAtParam(raw, Date.now(), gatewayZone());
  } catch (e) {
    throw new RpcMethodError(-32602, `agent.invoke: ${(e as AtTimeError).message}`);
  }
}

/** Parse and validate `agent.invoke` params; every refusal happens here, before the handler. */
export function parseAgentInvokeParams(params: unknown): AgentInvokeRequest {
  const rec = asRecord(params);
  const pointInTimeMs = parseAgentInvokeAt(rec?.["at"]);
  const computerSessionId = parseOptionalString(rec, "computerSession");
  // `nimbus ask --computer <id>`: the session the owner opened; honoured only for a `cli` caller,
  // refused with `--at` (a point-in-time turn drives nothing).
  if (computerSessionId !== undefined && pointInTimeMs !== undefined) {
    throw new RpcMethodError(-32602, "computerSession cannot be combined with at");
  }
  return {
    input: typeof rec?.["input"] === "string" ? rec["input"] : "",
    stream: rec?.["stream"] === true,
    sessionId: parseOptionalString(rec, "sessionId"),
    agent: parseOptionalString(rec, "agent"),
    // `=== true`, matching `stream`: a truthy non-boolean from a hand-rolled client must
    // not silently switch the answer's whole posture.
    devil: rec?.["devil"] === true,
    pointInTimeMs,
    streamId: parseOptionalString(rec, "streamId"),
    computerSessionId,
  };
}

export function agentInvokeRequestStore(req: AgentInvokeRequest): AgentRequestContext {
  const store: AgentRequestContext = {};
  if (req.sessionId !== undefined) {
    store.sessionId = req.sessionId;
  }
  if (req.pointInTimeMs !== undefined) {
    store.pointInTimeMs = req.pointInTimeMs;
  }
  return store;
}

export function buildAgentInvokePayload(
  req: AgentInvokeRequest,
  clientId: string,
  session: ClientSession,
  offers: AgentInvokeOffers,
): AgentInvokeContext {
  const payload: AgentInvokeContext = {
    clientId,
    input: req.input,
    stream: req.stream,
    sendChunk: (text: string) => {
      sendAgentChunkIfStreaming(session, req.stream, text, req.streamId);
    },
    ...offers,
    ...(req.computerSessionId === undefined ? {} : { computerSessionId: req.computerSessionId }),
    notifyGasLimit: (event: GasLimitEvent) => {
      sendGasLimitReached(session, event, req.streamId);
    },
  };
  if (req.sessionId !== undefined) {
    payload.sessionId = req.sessionId;
  }
  if (req.agent !== undefined) {
    payload.agent = req.agent;
  }
  if (req.devil) {
    payload.devil = true;
  }
  if (req.pointInTimeMs !== undefined) {
    payload.pointInTimeMs = req.pointInTimeMs;
  }
  return payload;
}
