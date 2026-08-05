import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import type net from "node:net";
import { platform } from "node:os";
import type { Updater } from "../../updater/updater.ts";
import type { AgentInvokeHandler } from "../agent-invoke.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import { createCancelStreamHandler } from "../engine-cancel-stream.ts";
import { createGetSessionTranscriptHandler } from "../engine-get-session-transcript.ts";
import {
  errorResponse,
  isRequest,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "../jsonrpc.ts";
import { ClientSession, type SessionWrite } from "../session.ts";
import type { IPCServer } from "../types.ts";
import type { WorkflowRunHandler } from "../workflow-invoke.ts";
import { ClientKindStore } from "./client-kind.ts";
import {
  automationRpcSkipped,
  connectorRpcSkipped,
  diagnosticsRpcSkipped,
  peopleRpcSkipped,
  phase4RpcSkipped,
  type ServerCtx,
  sessionRpcSkipped,
} from "./context.ts";
import {
  tryDispatchAutomationRpc,
  tryDispatchConnectorRpc,
  tryDispatchDiagnosticsRpc,
  tryDispatchPeopleRpc,
  tryDispatchPhase4Rpc,
  tryDispatchSessionRpc,
} from "./dispatchers.ts";
import {
  dispatchAgentInvoke,
  dispatchEngineAskStream,
  rpcAuditList,
  rpcConsentRespond,
  rpcGatewayPing,
  rpcIndexSearchRanked,
} from "./inline-handlers.ts";
import type { BunSessionData, CreateIpcServerOptions } from "./options.ts";
import { RpcMethodError } from "./rpc-error.ts";
import {
  chmodListenSocketBestEffort,
  removeStaleUnixSocketIfPresent,
  startBunUnixListener,
  startWin32NetServer,
} from "./socket-listeners.ts";
import { rpcVaultOrMethodNotFound } from "./vault-dispatch.ts";

export function createIpcServer(options: CreateIpcServerOptions): IPCServer {
  const startedAtMs = options.startedAtMs ?? Date.now();
  let agentInvokeHandler: AgentInvokeHandler | undefined = options.agentInvoke;
  let workflowRunHandler: WorkflowRunHandler | undefined = options.workflowRun;
  const sessions = new Map<string, ClientSession>();
  const clientKinds = options.clientKinds ?? new ClientKindStore();
  const consentImpl = new ConsentCoordinatorImpl((clientId) => {
    const session = sessions.get(clientId);
    return session === undefined ? undefined : (n) => session.writeNotification(n);
  });

  const streamRegistry = createStreamRegistry();

  let bunListener: ReturnType<typeof Bun.listen<BunSessionData>> | undefined;
  let netServer: net.Server | undefined;
  let winSockets: Set<net.Socket> = new Set();

  function broadcastNotification(method: string, params: Record<string, unknown>): void {
    for (const session of sessions.values()) {
      session.writeNotification({ jsonrpc: "2.0", method, params });
    }
  }

  if (options.voiceService !== undefined) {
    options.voiceService.onMicrophoneStateChange = (e) => {
      broadcastNotification("voice.microphoneActive", { active: e.active, source: e.source });
    };
  }

  const ctx: ServerCtx = {
    options,
    consentImpl,
    startedAtMs,
    streamRegistry,
    broadcastNotification,
    getAgentInvokeHandler: () => agentInvokeHandler,
    getWorkflowRunHandler: () => workflowRunHandler,
    getClientKind: (clientId: string) => clientKinds.get(clientId),
  };

  function attachSession(write: SessionWrite): ClientSession {
    const clientId = randomUUID();
    const session = new ClientSession(clientId, write, handleRpc, (cid) => {
      sessions.delete(cid);
      clientKinds.forget(cid);
      consentImpl.onClientDisconnect(cid);
    });
    sessions.set(clientId, session);
    options.onClientConnected?.(clientId);
    return session;
  }

  async function handleRpc(
    clientId: string,
    msg: JsonRpcRequest | JsonRpcNotification,
  ): Promise<void> {
    const session = sessions.get(clientId);
    if (session === undefined) {
      return;
    }

    if (!isRequest(msg)) {
      return;
    }

    const req = msg;
    const id: JsonRpcId = req.id;

    try {
      const result = await dispatchMethod(clientId, session, req);
      session.writeOutbound({ jsonrpc: "2.0", id, result });
    } catch (e) {
      if (e instanceof RpcMethodError) {
        session.writeOutbound(errorResponse(id, e.rpcCode, e.message, e.rpcData));
      } else {
        const message = e instanceof Error ? e.message : "Internal error";
        session.writeOutbound(errorResponse(id, -32603, message));
      }
    }
  }

  async function dispatchMethod(
    clientId: string,
    session: ClientSession,
    req: JsonRpcRequest,
  ): Promise<unknown> {
    const { method } = req;
    const params = req.params;

    if (method === "session.declareKind") {
      const p = params as { kind?: unknown } | undefined;
      return { kind: clientKinds.declare(clientId, p?.kind) };
    }

    const sessionOutcome = await tryDispatchSessionRpc(ctx, method, params);
    if (sessionOutcome !== sessionRpcSkipped) return sessionOutcome;

    const automationOutcome = await tryDispatchAutomationRpc(
      ctx,
      clientId,
      session,
      method,
      params,
    );
    if (automationOutcome !== automationRpcSkipped) return automationOutcome;

    const connectorOutcome = await tryDispatchConnectorRpc(ctx, method, params, clientId);
    if (connectorOutcome !== connectorRpcSkipped) return connectorOutcome;

    const diagnosticsHit = await tryDispatchDiagnosticsRpc(ctx, method, params);
    if (diagnosticsHit !== diagnosticsRpcSkipped) return diagnosticsHit;

    const peopleOutcome = tryDispatchPeopleRpc(ctx, method, params);
    if (peopleOutcome !== peopleRpcSkipped) return peopleOutcome;

    const phase4Outcome = await tryDispatchPhase4Rpc(ctx, method, params, clientId);
    if (phase4Outcome !== phase4RpcSkipped) return phase4Outcome;

    switch (method) {
      case "gateway.ping":
        return rpcGatewayPing(ctx, params);
      case "index.searchRanked":
        return await rpcIndexSearchRanked(ctx, params);
      case "agent.invoke":
        return await dispatchAgentInvoke(ctx, session, clientId, params);
      case "consent.respond":
        return rpcConsentRespond(ctx, clientId, params);
      case "audit.list":
        return rpcAuditList(ctx, params);
      case "engine.askStream":
        return dispatchEngineAskStream(ctx, session, clientId, params);
      case "engine.cancelStream":
        return createCancelStreamHandler(ctx.streamRegistry)(params);
      case "engine.getSessionTranscript": {
        const li = ctx.options.localIndex;
        if (li === undefined) {
          throw new RpcMethodError(
            -32603,
            "engine.getSessionTranscript requires a configured local index",
          );
        }
        return await createGetSessionTranscriptHandler(li.rawDb)(params);
      }
      default:
        return await rpcVaultOrMethodNotFound(ctx, method, params, clientId);
    }
  }

  return {
    listenPath: options.listenPath,
    consent: consentImpl,
    setAgentInvokeHandler(handler: AgentInvokeHandler | undefined): void {
      agentInvokeHandler = handler;
    },
    setWorkflowRunHandler(handler: WorkflowRunHandler | undefined): void {
      workflowRunHandler = handler;
    },
    setUpdater(updater: Updater): void {
      options.updater = updater;
    },
    broadcast(method: string, params: Record<string, unknown>): void {
      broadcastNotification(method, params);
    },
    async start(): Promise<void> {
      if (platform() === "win32") {
        const handle = await startWin32NetServer(options.listenPath, attachSession);
        netServer = handle.netServer;
        winSockets = handle.winSockets;
        return;
      }

      removeStaleUnixSocketIfPresent(options.listenPath);
      bunListener = startBunUnixListener(options.listenPath, attachSession);
      chmodListenSocketBestEffort(options.listenPath);
    },

    async stop(): Promise<void> {
      consentImpl.rejectAllPending("Gateway shutting down", "gateway shutting down");
      if (netServer !== undefined) {
        const s = netServer;
        netServer = undefined;
        for (const sock of winSockets) {
          sock.destroy();
        }
        winSockets.clear();
        await new Promise<void>((resolve) => {
          s.close(() => resolve());
        });
        return;
      }

      if (bunListener !== undefined) {
        const l = bunListener;
        bunListener = undefined;
        for (const sess of sessions.values()) {
          sess.dispose();
        }
        sessions.clear();
        l.stop(true);
        if (existsSync(options.listenPath)) {
          try {
            unlinkSync(options.listenPath);
          } catch {
            /* ignore */
          }
        }
      }
    },
  };
}
