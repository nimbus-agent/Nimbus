import type { LazyConnectorMesh } from "../connectors/lazy-mesh/index.ts";
import type { ToolExecutor } from "../engine/executor.ts";
import type { LocalIndex } from "../index/local-index.ts";
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

let warnedConnectorStartAuth = false;

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
    case "connector.startAuth":
    case "connector.auth": {
      if (method === "connector.startAuth" && !warnedConnectorStartAuth) {
        warnedConnectorStartAuth = true;
        process.stderr.write(
          "connector.startAuth is deprecated; use connector.auth (S4-F2 alias)\n",
        );
      }
      return handleConnectorAuth(ctx);
    }
    default:
      return { kind: "miss" };
  }
}

export function _resetStartAuthWarnFlagForTest(): void {
  warnedConnectorStartAuth = false;
}
