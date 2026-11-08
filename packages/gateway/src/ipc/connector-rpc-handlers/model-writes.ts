// packages/gateway/src/ipc/connector-rpc-handlers/model-writes.ts
// `connector.writesEnable|writesDisable|writesStatus`: the owner's opt-in for model connector writes.
import type { Database } from "bun:sqlite";

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
import { iacWildcardHosts } from "../../connectors/lazy-mesh/first-party-manifests.ts";
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
import { isModelOfferableRow } from "../../connectors/connector-writes/model-offerable.ts";
import { isConnectorWriteModelAccessEnabled } from "../../connectors/connector-writes/model-write-capability.ts";
import type {
  ConnectorWriteRow,
  ConnectorWriteWave,
} from "../../connectors/connector-writes/types.ts";
import type { ToolExecutor } from "../../engine/executor.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import { ConnectorRpcError } from "../connector-rpc-shared.ts";

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
   * What approving the Obsidian append would let its sandbox write now (`LazyConnectorMesh.
   * obsidianWriteScope`), shown in the enable prompt. Absent: the prompt says the folders are unknown.
   */
  readonly obsidianWriteScope?: () => {
    readonly roots: readonly string[];
    /** Per vault, its daily-note file pattern (`<vault>/<daily folder>/<format>.md`). */
    readonly notes: readonly string[];
    readonly skipped: readonly { readonly path: string; readonly reason: string }[];
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
    workdirs: [...new Set(workdirs)].sort(),
    clouds: [...new Set(clouds)].sort(),
    regions: [...new Set(regions)].sort(),
    net: [...new Set(net)].sort(),
  };
}

/** What the prompt shows for the grants: names only, never a credential value. */
function iacPromptScope(grants: IacGrants, platform: NodeJS.Platform): Record<string, unknown> {
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
    ].sort(),
    hostScope:
      platform === "linux" ? "per_host" : platform === "darwin" ? "per_port" : "all_or_nothing",
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
): Promise<{ service: string; maxWave: ConnectorWriteWave; writes: number }> {
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
    const offerable = isModelOfferableRow(r);
    let state: EnableWriteState = "not_offerable";
    if (offerable) {
      state =
        existing?.approvedToolIds.has(r.toolId) === true ? "already_approved" : "newly_offerable";
    }
    return { toolId: r.toolId, actionType: r.actionType, wave: r.wave, offerable, state };
  });
  const payload: Record<string, unknown> = { service, maxWave, writes };
  // The approved directories and clouds are named in the prompt the owner approves (D2, I15).
  const iacGrants = service === IAC_SERVICE ? parseIacGrants(rec, deps) : undefined;
  if (iacGrants !== undefined) {
    payload["iacGrants"] = iacPromptScope(
      iacGrants,
      deps.iacPathDeps?.platform ?? process.platform,
    );
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
  // After the row: the restart's next spawn reads the grant from it.
  if (service === OBSIDIAN_SERVICE) await deps.onObsidianGrantChanged?.();
  return { service, maxWave, writes: writes.length };
}

/** Narrowing needs no approval; idempotent. Disabling `obsidian` also withdraws its write grant now. */
export async function handleConnectorWritesDisable(
  rec: Record<string, unknown> | undefined,
  deps: ModelWritesDeps,
): Promise<{ removed: boolean }> {
  const service = parseServiceForDisable(rec?.["service"]);
  let removed = removeModelWriteEnablement(deps.db, service);
  // Disabling `iac` drops the approved directories and clouds too (narrowing needs no approval).
  if (service === IAC_SERVICE && removeIacGrants(deps.db)) removed = true;
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
    writes: number;
    offerable: number;
    awaitingApproval: number;
  }>;
  policyAllows: boolean;
} {
  const enabled = new Map(listModelWriteEnablement(deps.db).map((e) => [e.service, e]));
  const services = modelWriteServices(deps.rows).map((service) => {
    const e = enabled.get(service);
    const maxWave = e?.maxWave ?? 4;
    const offerableNow = offerableWritesEnabledBy(service, maxWave, deps.rows);
    const approved = offerableNow.filter((r) => e?.approvedToolIds.has(r.toolId) === true).length;
    const counts = {
      writes: writesEnabledBy(service, maxWave, deps.rows).length,
      offerable: approved,
      awaitingApproval: offerableNow.length - approved,
    };
    const extra = service === IAC_SERVICE ? { iacGrants: getIacGrants(deps.db) } : {};
    return e === undefined
      ? { service, enabled: false, ...counts, ...extra }
      : { service, enabled: true, maxWave: e.maxWave, enabledAt: e.enabledAt, ...counts, ...extra };
  });
  return {
    services,
    policyAllows: isConnectorWriteModelAccessEnabled(deps.getEnforcedPolicy()),
  };
}
