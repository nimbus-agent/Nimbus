// packages/gateway/src/ipc/connector-rpc-handlers/model-writes-grants.ts
// The grant halves of `connector.writesEnable` for `iac` and `kubernetes` (D2, D3a, I15): argument
// validation and the prompt's scope text. Nothing here stores anything; `model-writes.ts` does that
// after the owner's gate.
import {
  IAC_CLOUD_ENV_NAMES,
  IAC_TERRAFORM_INIT_HOSTS,
  iacCfnHosts,
  iacTerraformHosts,
  isSafeIacRegion,
  isValidIacExtraHost,
} from "../../connectors/connector-writes/iac-clouds.ts";
import {
  approveWorkdir,
  IAC_CLOUDS,
  type IacCloud,
  type IacGrants,
  type IacPathDeps,
} from "../../connectors/connector-writes/iac-grants.ts";
import type { K8sGrant } from "../../connectors/connector-writes/k8s-grants.ts";
import { isDnsLabel, isProtectedNamespace } from "../../connectors/connector-writes/k8s-limits.ts";
import { isPlainContext } from "../../connectors/connector-writes/k8s-manifest.ts";
import {
  inspectKubeconfig,
  type KubeFs,
} from "../../connectors/connector-writes/kubeconfig-facts.ts";
import type { ConnectorWriteWave } from "../../connectors/connector-writes/types.ts";
import { iacWildcardHosts } from "../../connectors/lazy-mesh/first-party-manifests.ts";
import type { ReachRunner } from "../../extensions/extension-reach.ts";
import {
  type SandboxNetworkPosture,
  sandboxNetworkPosture,
} from "../../platform/sandbox/sandbox-posture.ts";
import { codeUnitCompare } from "../../util/code-unit-compare.ts";
import { ConnectorRpcError } from "../connector-rpc-shared.ts";

/** The service whose opt-in also carries the approved contexts and namespaces (D3a, V86). */
export const KUBERNETES_SERVICE = "kubernetes";

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
  deps: K8sGrantDeps,
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
export const IAC_SERVICE = "iac";

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
function parseIacGrants(rec: Record<string, unknown> | undefined, deps: IacGrantDeps): IacGrants {
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
        // The init child's registry hosts (connectors 0.21.0), whatever cloud is granted.
        ...IAC_TERRAFORM_INIT_HOSTS,
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

/** The deps `enable kubernetes` reads (a slice of `ModelWritesDeps`, so this file imports no handler). */
export interface K8sGrantDeps {
  readonly readKubeconfigPath?: () => Promise<string | undefined>;
  readonly kubeFs?: KubeFs;
}

/** The deps `enable iac` reads. */
export interface IacGrantDeps {
  readonly iacPathDeps?: IacPathDeps;
}

export interface GrantEnableDeps extends K8sGrantDeps, IacGrantDeps {
  readonly sandboxRunner?: ReachRunner;
  readonly platform?: NodeJS.Platform;
}

/** What `enable <service>` stores beside the wave (the grants) and what its prompt shows of them. */
export interface EnableGrants {
  readonly iacGrants?: IacGrants;
  readonly k8sGrants?: K8sGrant[];
  readonly promptScope: Record<string, unknown>;
}

/**
 * The approved directories, clouds and clusters are named in the prompt the owner approves (D2,
 * D3a, I15). Validation happens here, BEFORE the owner's gate; nothing is stored here.
 */
export async function enableGrantsOf(
  service: string,
  rec: Record<string, unknown> | undefined,
  maxWave: ConnectorWriteWave,
  deps: GrantEnableDeps,
): Promise<EnableGrants> {
  // No runner to ask: say the weakest thing (a port, not a host), never "per host".
  const posture =
    deps.sandboxRunner === undefined ? "all_or_nothing" : sandboxNetworkPosture(deps.sandboxRunner);
  const iacGrants = service === IAC_SERVICE ? parseIacGrants(rec, deps) : undefined;
  const k8sGrants =
    service === KUBERNETES_SERVICE ? await parseK8sGrants(rec, maxWave, deps) : undefined;
  return {
    ...(iacGrants === undefined ? {} : { iacGrants }),
    ...(k8sGrants === undefined ? {} : { k8sGrants }),
    promptScope: {
      ...(iacGrants === undefined ? {} : { iacGrants: iacPromptScope(iacGrants, posture) }),
      ...(k8sGrants === undefined
        ? {}
        : { k8sGrants: k8sPromptScope(k8sGrants, posture, deps.platform ?? process.platform) }),
    },
  };
}
