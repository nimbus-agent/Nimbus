import type { LazyConnectorMesh } from "../connectors/lazy-mesh/index.ts";
import { adoptLocalAuth, parseAdoptRequest } from "../connectors/local-auth/adopt-local-auth.ts";
import { detectLocalAuth, parseSources } from "../connectors/local-auth/detect-local-auth.ts";
import { defaultLocalAuthHostDeps } from "../connectors/local-auth/local-auth-host.ts";
import type { ToolExecutor } from "../engine/executor.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { isConnectorConfigured } from "../sync/connector-configured.ts";
import type { SyncScheduler } from "../sync/scheduler.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  handleConnectorAddMcp,
  handleConnectorAuth,
  handleConnectorHealthHistory,
  handleConnectorListStatus,
  handleConnectorPause,
  handleConnectorRemove,
  handleConnectorResume,
  handleConnectorSetConfig,
  handleConnectorSetInterval,
  handleConnectorStatus,
  handleConnectorSync,
} from "./connector-rpc-handlers/index.ts";
import { asRecord, ConnectorRpcError } from "./connector-rpc-shared.ts";

export { ConnectorRpcError } from "./connector-rpc-shared.ts";

export async function dispatchConnectorRpc(options: {
  method: string;
  params: unknown;
  vault: NimbusVault;
  localIndex: LocalIndex;
  openUrl: (url: string) => Promise<void>;
  syncScheduler: SyncScheduler | undefined;
  connectorMesh?: LazyConnectorMesh;
  notify?: (method: string, params: Record<string, unknown>) => void;
  toolExecutor?: ToolExecutor;
}): Promise<{ kind: "hit"; value: unknown } | { kind: "miss" }> {
  const {
    method,
    params,
    vault,
    localIndex,
    openUrl,
    syncScheduler,
    connectorMesh,
    notify,
    toolExecutor,
  } = options;
  const rec = asRecord(params);
  const ctx = {
    rec,
    vault,
    localIndex,
    openUrl,
    syncScheduler,
    connectorMesh,
    ...(notify === undefined ? {} : { notify }),
  };

  switch (method) {
    case "connector.addMcp": {
      if (toolExecutor === undefined) {
        throw new ConnectorRpcError(-32603, "connector.addMcp requires a toolExecutor");
      }
      const addMcpRec = asRecord(params) ?? {};
      // The payload MUST name the keys the handler actually consumes
      // (`serviceId`/`commandLine`) — it used to read `command`/`args`, which no
      // caller sends, so the owner was asked to authorize spawning an arbitrary
      // local process while the prompt, the audit row and the egress-ledger row
      // all rendered empty (#808). `commandLine` is the raw string the handler
      // parses; showing it verbatim keeps the prompt identical to what was asked
      // for, rather than a re-derivation that could disagree with it.
      const gateResult = await toolExecutor.gate({
        type: "connector.addMcp",
        payload: {
          serviceId: addMcpRec["serviceId"],
          commandLine: addMcpRec["commandLine"],
        },
      });
      if (gateResult !== "proceed") return { kind: "hit", value: gateResult };
      return handleConnectorAddMcp(ctx);
    }
    case "connector.listStatus":
      return handleConnectorListStatus(ctx);
    case "connector.pause":
      return handleConnectorPause(ctx);
    case "connector.resume":
      return handleConnectorResume(ctx);
    case "connector.setConfig":
      return handleConnectorSetConfig(ctx);
    case "connector.setInterval":
      return handleConnectorSetInterval(ctx);
    case "connector.status":
      return handleConnectorStatus(ctx);
    case "connector.healthHistory":
      return handleConnectorHealthHistory(ctx);
    case "connector.remove": {
      if (toolExecutor === undefined) {
        throw new ConnectorRpcError(-32603, "connector.remove requires a toolExecutor");
      }
      // `serviceId`, not `service`: `handleConnectorRemove` resolves the id via
      // `requireRegisteredSchedulerServiceId`, which reads `serviceId` only. The
      // gate read `service`, so this destructive action (deletes index entries,
      // clears Vault keys) also prompted blank (#808).
      const gateResult = await toolExecutor.gate({
        type: "connector.remove",
        payload: { serviceId: asRecord(params)?.["serviceId"] },
      });
      if (gateResult !== "proceed") return { kind: "hit", value: gateResult };
      return handleConnectorRemove(ctx);
    }
    case "connector.sync":
      return handleConnectorSync(ctx);
    case "connector.auth":
      return handleConnectorAuth(ctx);
    case "connector.detectLocalAuth": {
      const sources = parseSources(rec?.["sources"]);
      const findings = await detectLocalAuth(sources, {
        host: defaultLocalAuthHostDeps(),
        isConfigured: (svc) => isConnectorConfigured(vault, svc),
      });
      return { kind: "hit", value: findings };
    }
    case "connector.adoptLocalAuth": {
      if (toolExecutor === undefined) {
        throw new ConnectorRpcError(-32603, "connector.adoptLocalAuth requires a toolExecutor");
      }
      const req = parseAdoptRequest(rec);
      const value = await adoptLocalAuth(req, {
        detect: {
          host: defaultLocalAuthHostDeps(),
          isConfigured: (svc) => isConnectorConfigured(vault, svc),
        },
        gate: (action) => toolExecutor.gate(action),
        // The token travels in-process only, inside this synthetic rec; it never crosses IPC.
        authenticate: (authRec) => handleConnectorAuth({ ...ctx, rec: authRec }),
      });
      return { kind: "hit", value };
    }
    default:
      return { kind: "miss" };
  }
}
