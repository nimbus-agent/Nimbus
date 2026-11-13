import { readGoogleOAuthScopesForGmailEnv } from "../auth/oauth-vault-tokens.ts";
import { readConnectorSecret } from "../connectors/connector-vault.ts";
import { nodeKubeFs } from "../connectors/connector-writes/kubeconfig-facts.ts";
import type { LazyConnectorMesh } from "../connectors/lazy-mesh/index.ts";
import { adoptLocalAuth, parseAdoptRequest } from "../connectors/local-auth/adopt-local-auth.ts";
import { detectLocalAuth, parseSources } from "../connectors/local-auth/detect-local-auth.ts";
import { defaultLocalAuthHostDeps } from "../connectors/local-auth/local-auth-host.ts";
import type { ResolvedUserMcpRegistration } from "../connectors/user-mcp-registration.ts";
import type { ToolExecutor } from "../engine/executor.ts";
import type { ContinuityEntry } from "../extensions/continuity/continuity-table.ts";
import { describeNetworkReach, type ReachRunner } from "../extensions/extension-reach.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import { isConnectorConfigured } from "../sync/connector-configured.ts";
import type { SyncScheduler } from "../sync/scheduler.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { handleAgentWritesStatus } from "./connector-rpc-handlers/agent-writes.ts";
import type {
  ConnectorRpcHandlerContext,
  ConnectorRpcHit,
} from "./connector-rpc-handlers/context.ts";
import {
  assertUserMcpSandboxClean,
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
  handleConnectorUserMcpCall,
  handleConnectorUserMcpTools,
  handleConnectorWritesDisable,
  handleConnectorWritesEnable,
  handleConnectorWritesStatus,
  type ModelWritesDeps,
  refuseExtensionBackedRemoval,
  resolveConnectorAddMcp,
  withConfiguredInstance,
} from "./connector-rpc-handlers/index.ts";
import { asRecord, ConnectorRpcError } from "./connector-rpc-shared.ts";
import type { ClientKind } from "./server/client-kind.ts";

export { ConnectorRpcError } from "./connector-rpc-shared.ts";

/**
 * Extracted from the `connector.adoptLocalAuth` case below and exported so the WIRING — which
 * exact Vault key the gcloud consent clause's "will this clear a stored key?" question reads —
 * can be pinned directly. An inline arrow at the call site typechecks and passes every
 * `adopt-local-auth.test.ts` test whether it reads `gcp.credentials_json_path` (correct) or
 * `gcp.project_id` (silently wrong: the clause would then fire whenever a project id is on file,
 * disclosing a clear that will never happen) — that whole suite injects its own
 * `readGcpKeyPath` stub and never exercises this line. See `connector-rpc.test.ts`.
 */
/** `{ grantedScopes: { gmail } }` from the stored credential, or nothing when it cannot be read. */
async function gmailGrantedScopes(
  vault: NimbusVault,
): Promise<{ grantedScopes: Record<string, string | undefined> } | Record<string, never>> {
  try {
    return { grantedScopes: { gmail: await readGoogleOAuthScopesForGmailEnv(vault) } };
  } catch {
    return {};
  }
}

export function buildReadGcpKeyPath(vault: NimbusVault): () => Promise<string | null> {
  return () => readConnectorSecret(vault, "gcp", "credentials_json_path");
}

/**
 * `connector.addMcp`, in its fixed order: resolve and validate, build the exact consent payload,
 * ask the LOCAL owner, clear any stale sandbox leaf, and only then store. Each step is one line
 * below so the order reads as a list.
 */
async function addMcpBehindOwnerGate(
  ctx: ConnectorRpcHandlerContext,
  toolExecutor: ToolExecutor | undefined,
): Promise<ConnectorRpcHit> {
  if (toolExecutor === undefined) {
    throw new ConnectorRpcError(-32603, "connector.addMcp requires a toolExecutor");
  }
  // 1. Resolve and validate FIRST: an invalid request (protected read path, unknown command,
  //    bad host, id collision) throws here and never prompts the owner.
  const resolved = resolveConnectorAddMcp(ctx);
  // 2. The payload the owner approves IS the resolved registration that step 5 stores.
  const payload = buildAddMcpConsentPayload(resolved, ctx.sandboxRunner);
  // 3. The HITL gate: anything but "proceed" stops here, before any write.
  const gateResult = await toolExecutor.gate({ type: "connector.addMcp", payload });
  if (gateResult !== "proceed") return { kind: "hit", value: gateResult };
  // 4. A sandbox leaf left by an earlier registration of this id is cleared, or this refuses.
  await assertUserMcpSandboxClean(ctx, resolved.serviceId);
  // 5. Store exactly what was approved.
  return handleConnectorAddMcp(ctx, resolved);
}

/**
 * The payload MUST name exactly what the handler consumes and stores. It used to read
 * `command`/`args` off the raw params, which no caller sent, so the owner was asked to
 * authorize spawning an arbitrary local process while the prompt, the audit row and the
 * egress-ledger row all rendered empty (#808). It is now the RESOLVED registration itself
 * — absolute command, verbatim args, canonical read paths, normalised hosts — the same
 * object `handleConnectorAddMcp` writes, so what the owner approves cannot disagree with
 * what is stored.
 */
export function buildAddMcpConsentPayload(
  resolved: ResolvedUserMcpRegistration,
  sandbox: ReachRunner | undefined,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    serviceId: resolved.serviceId,
    command: resolved.command,
    args: resolved.args,
    readPaths: resolved.readPaths,
    netHosts: resolved.netHosts,
    modelAccess: resolved.modelAccess,
  };
  if (resolved.netHosts.length > 0) {
    // Only where the reach is wider than the listed hosts (or unknown): a per-host sandbox needs no note.
    const reach = describeNetworkReach(sandbox, resolved.netHosts);
    if (reach.kind !== "hosts" && reach.kind !== "none") payload["networkNote"] = reach.text;
  }
  return payload;
}

export async function dispatchConnectorRpc(options: {
  method: string;
  params: unknown;
  vault: NimbusVault;
  localIndex: LocalIndex;
  openUrl: (url: string) => Promise<void>;
  syncScheduler: SyncScheduler | undefined;
  connectorMesh?: LazyConnectorMesh;
  /**
   * The host OS (PAL: passed in, never read from `process.platform` in this module). Optional only
   * because no method but `connector.addMcp` reads it; that one refuses without it.
   */
  platform?: NodeJS.Platform;
  /** The sandbox runner `connector.addMcp`'s prompt describes the network reach from. */
  sandboxRunner?: ReachRunner;
  notify?: (method: string, params: Record<string, unknown>) => void;
  toolExecutor?: ToolExecutor;
  /**
   * `connector.userMcpCall` only: a DISPATCHING executor (real connector dispatcher + real egress
   * sink), unlike the gate-only `toolExecutor`. Its `gate()` writes the audit and I29 egress rows
   * and asks the local owner (I42) before the user MCP tool runs.
   */
  userMcpExecutor?: ToolExecutor;
  /** Test seam for `connector.addMcp`: PATH lookup (production: `Bun.which`). */
  resolveCommand?: (cmd: string) => string | null;
  /** Test seam for `connector.addMcp`: canonicalisation (production: `realpathSync.native`). */
  realpath?: (p: string) => string;
  /** The composition's continuity table (`connector.remove`'s refusal); absent = production default. */
  continuityTable?: readonly ContinuityEntry[];
  /**
   * LIVE read of the resolved org policy (I22), REQUIRED so no caller can forget it: `undefined`
   * means "cannot tell" and `connector.writesEnable` refuses (fail-closed).
   */
  getEnforcedPolicy: () => Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined;
  /** Test seam for the enablement timestamp (production: `Date.now`). */
  now?: () => number;
  /**
   * Phase 28 AD3a-1: the connection's declared kind (`ctx.getClientKind(clientId)`), never a param.
   * Absent reads as `unknown`, which cannot approve connector writes for outside agents.
   */
  clientKind?: ClientKind;
  /** True once the dispatcher's human-only consent wrapper turned an approval into a decline. */
  agentAnswerWasNonHuman?: () => boolean;
}): Promise<{ kind: "hit"; value: unknown } | { kind: "miss" }> {
  const {
    method,
    params,
    vault,
    localIndex,
    openUrl,
    syncScheduler,
    connectorMesh,
    platform,
    sandboxRunner,
    notify,
    toolExecutor,
    userMcpExecutor,
    resolveCommand,
    realpath,
    continuityTable,
    getEnforcedPolicy,
    now,
    clientKind,
    agentAnswerWasNonHuman,
  } = options;
  const rec = asRecord(params);
  const ctx = {
    rec,
    vault,
    localIndex,
    openUrl,
    syncScheduler,
    connectorMesh,
    ...(platform === undefined ? {} : { platform }),
    ...(sandboxRunner === undefined ? {} : { sandboxRunner }),
    ...(notify === undefined ? {} : { notify }),
    ...(resolveCommand === undefined ? {} : { resolveCommand }),
    ...(realpath === undefined ? {} : { realpath }),
    ...(continuityTable === undefined ? {} : { continuityTable }),
  };

  const modelWritesDeps = async (): Promise<ModelWritesDeps> => ({
    db: localIndex.getDatabase(),
    // SA2: which scopes the stored Gmail credential holds, so `status` and the enable prompt can
    // say the archive row needs a re-authorisation. A failed read makes no claim.
    ...(await gmailGrantedScopes(vault)),
    // D3a: the kubeconfig the Vault names, read through the real filesystem (kubectl never sees it).
    readKubeconfigPath: async () =>
      (await readConnectorSecret(vault, "kubernetes", "kubeconfig")) ?? undefined,
    kubeFs: nodeKubeFs,
    toolExecutor,
    getEnforcedPolicy,
    now: now ?? Date.now,
    // Phase 28 AD3a-1: what the agent-door enable and status need (the listing may start a connector).
    ...(clientKind === undefined ? {} : { clientKind }),
    ...(agentAnswerWasNonHuman === undefined ? {} : { agentAnswerWasNonHuman }),
    ...(connectorMesh === undefined
      ? {}
      : { listServerTools: (service: string) => connectorMesh.listFirstPartyServerTools(service) }),
    // The enable prompt's host line is read from the sandbox's live posture (D2 review 4).
    ...(sandboxRunner === undefined ? {} : { sandboxRunner }),
    // The Obsidian opt-in is also the trigger of its sandbox write grant (I15, B4b).
    ...(connectorMesh === undefined
      ? {}
      : {
          onObsidianGrantChanged: () => connectorMesh.restartObsidian(),
          obsidianWriteScope: () => connectorMesh.obsidianWriteScope(),
          iacPathDeps: connectorMesh.iacPathDepsForEnable(),
        }),
  });

  switch (method) {
    case "connector.addMcp":
      return addMcpBehindOwnerGate(ctx, toolExecutor);
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
      return withConfiguredInstance(ctx, handleConnectorStatus(ctx));
    case "connector.healthHistory":
      return handleConnectorHealthHistory(ctx);
    case "connector.remove": {
      if (toolExecutor === undefined) {
        throw new ConnectorRpcError(-32603, "connector.remove requires a toolExecutor");
      }
      // Refused BEFORE the gate: no prompt, and no audit row for a removal that cannot run.
      refuseExtensionBackedRemoval(ctx);
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
    case "connector.userMcpTools":
      return { kind: "hit", value: await handleConnectorUserMcpTools(connectorMesh, rec) };
    case "connector.userMcpCall":
      return {
        kind: "hit",
        value: await handleConnectorUserMcpCall(connectorMesh, userMcpExecutor, rec),
      };
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
        readGcpKeyPath: buildReadGcpKeyPath(vault),
        readGithubApiBase: () => readConnectorSecret(vault, "github", "api_base"),
      });
      return { kind: "hit", value };
    }
    case "connector.writesEnable":
      return {
        kind: "hit",
        value: await handleConnectorWritesEnable(rec, await modelWritesDeps()),
      };
    case "connector.writesDisable":
      return {
        kind: "hit",
        value: await handleConnectorWritesDisable(rec, await modelWritesDeps()),
      };
    case "connector.writesStatus": {
      const deps = await modelWritesDeps();
      // The model part is exactly what it was; the agent door's list is a member of its own.
      return {
        kind: "hit",
        value: { ...handleConnectorWritesStatus(deps), agent: await handleAgentWritesStatus(deps) },
      };
    }
    default:
      return { kind: "miss" };
  }
}
