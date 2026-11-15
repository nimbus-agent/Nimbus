// packages/gateway/src/ipc/connector-rpc-handlers/model-writes.ts
// `connector.writesEnable|writesDisable|writesStatus`: the owner's opt-in for model connector writes.
import type { Database } from "bun:sqlite";

import { removeDoorApprovals } from "../../connectors/connector-writes/door-approval-store.ts";
import {
  getModelWriteEnablement,
  listModelWriteEnablement,
  modelWriteServices,
  OBSIDIAN_APPEND_TOOL_ID,
  offerableWritesEnabledBy,
  removeModelWriteEnablement,
  setModelWriteEnablement,
  writesEnabledBy,
} from "../../connectors/connector-writes/enablement-store.ts";
import {
  IAC_CLOUD_ENV_NAMES,
  iacCfnHosts,
  iacTerraformHosts,
  isSafeIacRegion,
  isValidIacExtraHost,
} from "../../connectors/connector-writes/iac-clouds.ts";
import {
  approveWorkdir,
  getIacGrants,
  IAC_CLOUDS,
  type IacCloud,
  type IacGrants,
  type IacPathDeps,
  removeIacGrants,
  setIacGrants,
} from "../../connectors/connector-writes/iac-grants.ts";
import {
  getK8sGrants,
  type K8sGrant,
  removeK8sGrants,
  setK8sGrants,
} from "../../connectors/connector-writes/k8s-grants.ts";
import { isDnsLabel, isProtectedNamespace } from "../../connectors/connector-writes/k8s-limits.ts";
import { isPlainContext } from "../../connectors/connector-writes/k8s-manifest.ts";
import {
  inspectKubeconfig,
  type KubeFs,
} from "../../connectors/connector-writes/kubeconfig-facts.ts";
import { isModelOfferableRow } from "../../connectors/connector-writes/model-offerable.ts";
import { isConnectorWriteModelAccessEnabled } from "../../connectors/connector-writes/model-write-capability.ts";
import { scopeGatedReason } from "../../connectors/connector-writes/scope-gated.ts";
import type {
  ConnectorWriteRow,
  ConnectorWriteWave,
} from "../../connectors/connector-writes/types.ts";
import { iacWildcardHosts } from "../../connectors/lazy-mesh/first-party-manifests.ts";
import type { ToolExecutor } from "../../engine/executor.ts";
import type { ReachRunner } from "../../extensions/extension-reach.ts";
import {
  type SandboxNetworkPosture,
  sandboxNetworkPosture,
} from "../../platform/sandbox/sandbox-posture.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import { codeUnitCompare } from "../../util/code-unit-compare.ts";
import { ConnectorRpcError } from "../connector-rpc-shared.ts";
import type { ClientKind } from "../server/client-kind.ts";
import { type AgentEnableReply, handleAgentWritesEnable, parseWriteDoor } from "./agent-writes.ts";
import {
  handleUserMcpAgentWritesEnable,
  isUserMcpServiceParam,
  type UserMcpAgentEnableReply,
} from "./agent-writes-user-mcp.ts";

export interface ModelWritesDeps {
  readonly db: Database;
  readonly toolExecutor: ToolExecutor | undefined;
  /** LIVE resolved policy (I22); `undefined` means "cannot tell" and refuses. */
  readonly getEnforcedPolicy: () => Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined;
  readonly now: () => number;
  /** Test seam; production uses the write table. */
  readonly rows?: readonly ConnectorWriteRow[];
  /**
   * Called after the `obsidian` opt-in changes (an approved enable, any disable): the mesh stops the
   * Obsidian slot so its next spawn reads the new grant, and on Windows revokes its ACEs. Must
   * never reject (`LazyConnectorMesh.restartObsidian`). Absent: nothing restarts.
   */
  readonly onObsidianGrantChanged?: () => Promise<void>;
  /**
   * The filesystem facts the approved-directory rule reads (D2, V85). Absent: `enable iac` is
   * refused (it cannot canonicalise a directory it cannot see).
   */
  readonly iacPathDeps?: IacPathDeps;
  /**
   * The sandbox runner the iac children will run under; the enable prompt's host line is read from
   * its live posture. Absent: the prompt makes no per-host claim.
   */
  readonly sandboxRunner?: ReachRunner;
  /**
   * D3a: the kubeconfig path the Vault holds for the `kubernetes` connector (`kubernetes.kubeconfig`),
   * and the filesystem its facts are read from. Absent: `enable kubernetes` is refused (it cannot
   * read a kubeconfig it cannot see).
   */
  readonly readKubeconfigPath?: () => Promise<string | undefined>;
  readonly kubeFs?: KubeFs;
  /** The OS the gateway runs on (the Windows local-cluster warning); default `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /**
   * What approving the Obsidian append would let its sandbox write now (`LazyConnectorMesh.
   * obsidianWriteScope`), shown in the enable prompt. Absent: the prompt says the folders are unknown.
   */
  /**
   * Phase 10 SA2: per service, the space-separated OAuth scopes its stored credential holds (read
   * before the call; `undefined` value: it records none). A write whose connector lists it only
   * with a scope (`gmail_thread_archive`) is shown as not offered, with the re-authorise reason,
   * when the credential lacks it. A service absent here makes no claim.
   */
  readonly grantedScopes?: Readonly<Record<string, string | undefined>>;
  /** Phase 28 AD3a-1 (agent door only): the connector's raw tool listing, as the model door reads it. */
  readonly listServerTools?: (
    service: string,
  ) => Promise<Readonly<Record<string, unknown>> | undefined>;
  /** The connection's declared kind (`ctx.getClientKind`), never a param; absent reads as `unknown`. */
  readonly clientKind?: ClientKind;
  /** True once the human-only consent wrapper turned a non-human approval into a decline. */
  readonly agentAnswerWasNonHuman?: () => boolean;
  /** AD5a (agent door, user MCP servers): see `AgentWritesDeps.listUserMcpDefinitions`. */
  readonly listUserMcpDefinitions?: (
    serviceId: string,
  ) => Promise<Readonly<Record<string, unknown>> | undefined>;
  /** AD5a: see `AgentWritesDeps.userMcpNetworkNote`. */
  readonly userMcpNetworkNote?: (netHosts: readonly string[]) => string | undefined;
  readonly obsidianWriteScope?: () => {
    readonly roots: readonly string[];
    /** Per vault, its daily-note file pattern (`<vault>/<daily folder>/<format>.md`). */
    readonly notes: readonly string[];
    readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  };
}

/** The service whose opt-in also carries the approved contexts and namespaces (D3a, V86). */
const KUBERNETES_SERVICE = "kubernetes";

/** Hosts that name this machine: a sandboxed child on Windows cannot reach them (probed 2026-11-10). */
function isLocalApiServer(server: string): boolean {
  const host = server.slice(0, server.lastIndexOf(":"));
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127./.test(host) ||
    host === "host.docker.internal" ||
    host === "kubernetes.docker.internal"
  );
}

const MAX_K8S_GRANTS = 100;

/**
 * Validates the `enable kubernetes` arguments into the grants to store: every (context, namespace)
 * pair is checked (a plain DNS-label namespace outside the protected three, a context that can be
 * typed), and every distinct context is read from the kubeconfig the Vault names, which must pass the
 * allowlist (R2-6). Every refusal is a fixed sentence that echoes nothing.
 */
async function parseK8sGrants(
  rec: Record<string, unknown> | undefined,
  maxWave: ConnectorWriteWave,
  deps: ModelWritesDeps,
): Promise<K8sGrant[]> {
  if (deps.readKubeconfigPath === undefined || deps.kubeFs === undefined) {
    throw new ConnectorRpcError(
      -32603,
      "ERR_CONNECTOR_WRITES_K8S_UNAVAILABLE: this gateway cannot read a kubeconfig",
    );
  }
  // Phase 1: every pair is checked before the kubeconfig is read at all.
  const pairs = validatedK8sPairs(rec, maxWave);
  // Phase 2: every distinct context is read from the kubeconfig the Vault names.
  return k8sGrantsFromKubeconfig(pairs, deps.kubeFs, await deps.readKubeconfigPath());
}

function k8sBadArgs(m: string): never {
  throw new ConnectorRpcError(-32602, `ERR_CONNECTOR_WRITES_K8S_BAD_ARGS: ${m}`);
}

/** The distinct (context, namespace) pairs of the arguments, each checked; a fixed refusal otherwise. */
function validatedK8sPairs(
  rec: Record<string, unknown> | undefined,
  maxWave: ConnectorWriteWave,
): Map<string, { namespace: string; context: string }> {
  if (maxWave !== 4) k8sBadArgs("kubernetes writes are wave 4: pass --wave 4");
  const raw = rec?.["k8sGrants"];
  if (!Array.isArray(raw) || raw.length === 0)
    k8sBadArgs("name at least one --grant <namespace>@<context>");
  const list = raw as unknown[];
  if (list.length > MAX_K8S_GRANTS) k8sBadArgs("too many grants");
  const pairs = new Map<string, { namespace: string; context: string }>();
  for (const entry of list) {
    const e = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    const { namespace, context } = e;
    if (!isDnsLabel(namespace) || !isPlainContext(context)) {
      k8sBadArgs("a grant needs a namespace name and a context name that can be typed");
    }
    if (isProtectedNamespace(namespace as string)) {
      k8sBadArgs("kube-system, kube-public and kube-node-lease cannot be approved");
    }
    pairs.set(JSON.stringify([context, namespace]), {
      namespace: namespace as string,
      context: context as string,
    });
  }
  return pairs;
}

/** The grants to store, in a stable order: each pair with its context's server and credential form. */
function k8sGrantsFromKubeconfig(
  pairs: ReadonlyMap<string, { namespace: string; context: string }>,
  kubeFs: KubeFs,
  path: string | undefined,
): K8sGrant[] {
  const facts = new Map<string, { server: string; credentialForm: K8sGrant["credentialForm"] }>();
  const grants: K8sGrant[] = [];
  for (const { namespace, context } of [...pairs.values()].sort(
    (a, b) => codeUnitCompare(a.context, b.context) || codeUnitCompare(a.namespace, b.namespace),
  )) {
    let f = facts.get(context);
    if (f === undefined) {
      const r = inspectKubeconfig(kubeFs, path, context);
      if (!r.ok) {
        throw new ConnectorRpcError(-32602, `ERR_CONNECTOR_WRITES_K8S_KUBECONFIG: ${r.reason}`);
      }
      f = { server: r.server, credentialForm: r.credentialForm };
      facts.set(context, f);
    }
    grants.push({ context, namespace, server: f.server, credentialForm: f.credentialForm });
  }
  return grants;
}

/** What the prompt shows for the grants: names, servers and credential FORMS, never a value. */
function k8sPromptScope(
  grants: readonly K8sGrant[],
  posture: SandboxNetworkPosture,
  platform: NodeJS.Platform,
): Record<string, unknown> {
  return {
    grants: grants.map((g) => ({
      context: g.context,
      namespace: g.namespace,
      server: g.server,
      // Not `credentialForm`: the prompt's redaction masks any key with "credential" in it.
      form: g.credentialForm,
    })),
    hostScope: posture,
    // A cluster on this machine cannot be reached from the Windows sandbox.
    localServerOnWindows: platform === "win32" && grants.some((g) => isLocalApiServer(g.server)),
  };
}

/** The service whose opt-in also carries the approved directories and clouds (D2, V85, I15). */
const IAC_SERVICE = "iac";

function stringArray(raw: unknown, what: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((x): x is string => typeof x === "string")) {
    throw new ConnectorRpcError(
      -32602,
      `ERR_CONNECTOR_WRITES_IAC_BAD_ARGS: ${what} must be a list of strings`,
    );
  }
  return raw;
}

/** Validates the `enable iac` arguments into the grants to store; every refusal is a fixed sentence. */
function parseIacGrants(
  rec: Record<string, unknown> | undefined,
  deps: ModelWritesDeps,
): IacGrants {
  const bad = (m: string): never => {
    throw new ConnectorRpcError(-32602, `ERR_CONNECTOR_WRITES_IAC_BAD_ARGS: ${m}`);
  };
  if (deps.iacPathDeps === undefined) {
    throw new ConnectorRpcError(
      -32603,
      "ERR_CONNECTOR_WRITES_IAC_UNAVAILABLE: this gateway cannot check directories",
    );
  }
  const workdirs: string[] = [];
  for (const raw of stringArray(rec?.["workdirs"], "workdirs")) {
    const r = approveWorkdir(raw, deps.iacPathDeps);
    if (!r.ok) {
      throw new ConnectorRpcError(-32602, `ERR_CONNECTOR_WRITES_IAC_WORKDIR: ${r.reason}`);
    }
    workdirs.push(r.path);
  }
  const clouds = stringArray(rec?.["clouds"], "clouds").map((c) =>
    (IAC_CLOUDS as readonly string[]).includes(c)
      ? (c as IacCloud)
      : bad("a cloud must be aws, azure or gcp"),
  );
  const regions = stringArray(rec?.["regions"], "regions").map((r) =>
    isSafeIacRegion(r) ? r : bad("a region is not a plain region name"),
  );
  const net = stringArray(rec?.["net"], "net").map((h) => {
    const host = h.trim().toLowerCase();
    return isValidIacExtraHost(host) ? host : bad("a host must be a plain host name or host:port");
  });
  if (workdirs.length === 0 && clouds.length === 0) {
    bad("name at least one --workdir or --cloud");
  }
  return {
    workdirs: [...new Set(workdirs)].sort(codeUnitCompare),
    clouds: [...new Set(clouds)].sort(codeUnitCompare),
    regions: [...new Set(regions)].sort(codeUnitCompare),
    net: [...new Set(net)].sort(codeUnitCompare),
  };
}

/** What the prompt shows for the grants: names only, never a credential value. */
function iacPromptScope(
  grants: IacGrants,
  posture: SandboxNetworkPosture,
): Record<string, unknown> {
  const cfn = grants.clouds.includes("aws")
    ? iacCfnHosts(grants.regions[0] ?? "").concat(grants.regions.slice(1).flatMap(iacCfnHosts))
    : [];
  return {
    workdirs: grants.workdirs,
    clouds: grants.clouds,
    regions: grants.regions,
    net: grants.net,
    envNames: Object.fromEntries(grants.clouds.map((c) => [c, IAC_CLOUD_ENV_NAMES[c]])),
    hosts: [
      ...new Set([
        ...iacTerraformHosts(grants.clouds),
        ...iacWildcardHosts(grants.clouds),
        ...cfn,
        ...grants.net,
      ]),
    ].sort(codeUnitCompare),
    // The SAME decision the sandbox makes at spawn (helper found and the forwarder probe passing
    // on Linux), never a guess from the platform name.
    hostScope: posture,
  };
}

/** The service whose opt-in also decides a sandbox write grant (I15, OR-B4-1). */
const OBSIDIAN_SERVICE = "obsidian";

/**
 * How the enable prompt marks one write (F7): offered under the CURRENT opt-in, offerable now but
 * offered only once this prompt is approved, or not offerable yet (approving does not offer it).
 */
export type EnableWriteState = "already_approved" | "newly_offerable" | "not_offerable";

const DEFAULT_WAVE: ConnectorWriteWave = 3;

function parseWave(raw: unknown): ConnectorWriteWave {
  if (raw === undefined) return DEFAULT_WAVE;
  if (raw === 2 || raw === 3 || raw === 4) return raw;
  throw new ConnectorRpcError(-32602, "ERR_CONNECTOR_WRITES_BAD_WAVE: wave must be 2, 3 or 4");
}

function parseEligibleService(
  raw: unknown,
  rows: readonly ConnectorWriteRow[] | undefined,
): string {
  if (typeof raw !== "string" || !modelWriteServices(rows).includes(raw)) {
    throw new ConnectorRpcError(
      -32602,
      "ERR_CONNECTOR_WRITES_UNKNOWN_SERVICE: that service has no connector writes",
    );
  }
  return raw;
}

function parseServiceForDisable(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ConnectorRpcError(-32602, "ERR_CONNECTOR_WRITES_UNKNOWN_SERVICE: service required");
  }
  return raw;
}

/** The Obsidian write scope for the prompt, only when approving would grant it; never throws. */
function obsidianScopeFor(
  service: string,
  writes: readonly { readonly toolId: string; readonly offerable: boolean }[],
  deps: ModelWritesDeps,
): ReturnType<NonNullable<ModelWritesDeps["obsidianWriteScope"]>> | undefined {
  if (service !== OBSIDIAN_SERVICE || deps.obsidianWriteScope === undefined) return undefined;
  if (!writes.some((w) => w.toolId === OBSIDIAN_APPEND_TOOL_ID && w.offerable)) return undefined;
  try {
    return deps.obsidianWriteScope();
  } catch {
    return undefined; // the prompt then says the folders are not known
  }
}

/** In a fixed order: validate, eligible service, LIVE policy, the owner's gate, then the write. */
export async function handleConnectorWritesEnable(
  rec: Record<string, unknown> | undefined,
  deps: ModelWritesDeps,
): Promise<
  | { service: string; maxWave: ConnectorWriteWave; writes: number }
  | AgentEnableReply
  | UserMcpAgentEnableReply
> {
  if (parseWriteDoor(rec?.["door"]) === "agent") {
    // A user-registered MCP server has its own enable (AD5a): no waves, no write rows, exact tool names.
    return isUserMcpServiceParam(rec?.["service"])
      ? handleUserMcpAgentWritesEnable(rec, deps)
      : handleAgentWritesEnable(rec, deps);
  }
  if (rec?.["approve"] !== undefined) {
    throw new ConnectorRpcError(
      -32602,
      "ERR_CONNECTOR_WRITES_BAD_APPROVE: --approve belongs to --door agent",
    );
  }
  if (deps.toolExecutor === undefined) {
    throw new ConnectorRpcError(-32603, "connector.writesEnable requires a toolExecutor");
  }
  const maxWave = parseWave(rec?.["wave"]);
  const service = parseEligibleService(rec?.["service"], deps.rows);
  if (!isConnectorWriteModelAccessEnabled(deps.getEnforcedPolicy())) {
    throw new ConnectorRpcError(
      -32000,
      "ERR_CONNECTOR_WRITES_POLICY: org policy does not allow model connector writes",
    );
  }
  // Read BEFORE the gate: the prompt says which writes the current opt-in already offers.
  const existing = getModelWriteEnablement(deps.db, service);
  const writes = writesEnabledBy(service, maxWave, deps.rows).map((r) => {
    const reason = scopeGatedReason(r.toolId, deps.grantedScopes);
    const offerable = isModelOfferableRow(r) && reason === undefined;
    let state: EnableWriteState = "not_offerable";
    if (offerable) {
      state =
        existing?.approvedToolIds.has(r.toolId) === true ? "already_approved" : "newly_offerable";
    }
    return {
      toolId: r.toolId,
      actionType: r.actionType,
      wave: r.wave,
      offerable,
      state,
      ...(reason === undefined ? {} : { reason }),
    };
  });
  const payload: Record<string, unknown> = { service, maxWave, writes };
  // The approved directories and clouds are named in the prompt the owner approves (D2, I15).
  const iacGrants = service === IAC_SERVICE ? parseIacGrants(rec, deps) : undefined;
  if (iacGrants !== undefined) {
    // No runner to ask: say the weakest thing (a port, not a host), never "per host".
    const posture =
      deps.sandboxRunner === undefined
        ? "all_or_nothing"
        : sandboxNetworkPosture(deps.sandboxRunner);
    payload["iacGrants"] = iacPromptScope(iacGrants, posture);
  }
  const k8sGrants =
    service === KUBERNETES_SERVICE ? await parseK8sGrants(rec, maxWave, deps) : undefined;
  if (k8sGrants !== undefined) {
    const posture =
      deps.sandboxRunner === undefined
        ? "all_or_nothing"
        : sandboxNetworkPosture(deps.sandboxRunner);
    payload["k8sGrants"] = k8sPromptScope(k8sGrants, posture, deps.platform ?? process.platform);
  }
  // The Obsidian widening is named in the prompt the owner approves (I15, OR-B4-1).
  const scope = obsidianScopeFor(service, writes, deps);
  if (scope !== undefined) payload["fileWriteScope"] = scope;
  const gate = await deps.toolExecutor.gate({ type: "connector.writes.enable", payload });
  if (gate !== "proceed") {
    throw new ConnectorRpcError(-32000, "ERR_CONNECTOR_WRITES_DECLINED: nothing was enabled");
  }
  // The approved set is exactly the offerable-now writes the owner just saw listed (V84).
  const approved = writes.filter((w) => w.offerable).map((w) => w.toolId);
  setModelWriteEnablement(deps.db, service, maxWave, deps.now(), approved);
  if (iacGrants !== undefined) setIacGrants(deps.db, iacGrants, deps.now());
  if (k8sGrants !== undefined) setK8sGrants(deps.db, k8sGrants, deps.now());
  // After the row: the restart's next spawn reads the grant from it.
  if (service === OBSIDIAN_SERVICE) await deps.onObsidianGrantChanged?.();
  return { service, maxWave, writes: writes.length };
}

/** Narrowing needs no approval; idempotent. Disabling `obsidian` also withdraws its write grant now. */
export async function handleConnectorWritesDisable(
  rec: Record<string, unknown> | undefined,
  deps: ModelWritesDeps,
): Promise<{ removed: boolean }> {
  const door = parseWriteDoor(rec?.["door"]);
  const service = parseServiceForDisable(rec?.["service"]);
  // The agent door's list alone: the shared wave and the model's approvals are left as they are.
  if (door === "agent") return { removed: removeDoorApprovals(deps.db, service, "agent") > 0 };
  let removed = removeModelWriteEnablement(deps.db, service);
  // Disabling a service withdraws the agent door's approvals of it too (narrowing needs no approval).
  if (removeDoorApprovals(deps.db, service) > 0) removed = true;
  // Disabling `iac` drops the approved directories and clouds too (narrowing needs no approval).
  if (service === IAC_SERVICE && removeIacGrants(deps.db)) removed = true;
  // Disabling `kubernetes` drops the approved contexts and namespaces too.
  if (service === KUBERNETES_SERVICE && removeK8sGrants(deps.db)) removed = true;
  if (service === OBSIDIAN_SERVICE) await deps.onObsidianGrantChanged?.();
  return { removed };
}

/**
 * Per service: `offerable` is what the model is offered now (offerable AND approved by name, V84)
 * and `awaitingApproval` is what is offerable now but not approved (re-enable to approve it). A
 * service that is not enabled has nothing approved, so its offerable writes all await approval.
 */
export function handleConnectorWritesStatus(deps: ModelWritesDeps): {
  services: Array<{
    service: string;
    enabled: boolean;
    maxWave?: ConnectorWriteWave;
    enabledAt?: number;
    /** `iac` only: the approved directories, clouds, regions and extra hosts. */
    iacGrants?: IacGrants;
    /** `kubernetes` only: the approved (context, namespace) pairs with their server and form. */
    k8sGrants?: K8sGrant[];
    writes: number;
    offerable: number;
    awaitingApproval: number;
    /** Offerable rows whose credential lacks a scope the connector needs to list them (SA2). */
    notOffered?: Array<{ toolId: string; reason: string }>;
  }>;
  policyAllows: boolean;
} {
  const enabled = new Map(listModelWriteEnablement(deps.db).map((e) => [e.service, e]));
  const services = modelWriteServices(deps.rows).map((service) => {
    const e = enabled.get(service);
    const maxWave = e?.maxWave ?? 4;
    const gated: Array<{ toolId: string; reason: string }> = [];
    const offerableNow = offerableWritesEnabledBy(service, maxWave, deps.rows).filter((r) => {
      const reason = scopeGatedReason(r.toolId, deps.grantedScopes);
      if (reason !== undefined) gated.push({ toolId: r.toolId, reason });
      return reason === undefined;
    });
    const approved = offerableNow.filter((r) => e?.approvedToolIds.has(r.toolId) === true).length;
    const counts = {
      writes: writesEnabledBy(service, maxWave, deps.rows).length,
      offerable: approved,
      awaitingApproval: offerableNow.length - approved,
    };
    let extra: Record<string, unknown> = gated.length > 0 ? { notOffered: gated } : {};
    if (service === IAC_SERVICE) extra = { ...extra, iacGrants: getIacGrants(deps.db) };
    if (service === KUBERNETES_SERVICE) extra = { ...extra, k8sGrants: getK8sGrants(deps.db) };
    return e === undefined
      ? { service, enabled: false, ...counts, ...extra }
      : { service, enabled: true, maxWave: e.maxWave, enabledAt: e.enabledAt, ...counts, ...extra };
  });
  return {
    services,
    policyAllows: isConnectorWriteModelAccessEnabled(deps.getEnforcedPolicy()),
  };
}
