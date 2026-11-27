// packages/gateway/src/connectors/lazy-mesh/iac-runner.ts
// The IaC runner (Phase 9.7 D2 and D3a, invariants I15, I1, I50, I54; static D43(d)). The `iac` and
// `kubernetes` connectors' listing slots have no network and no filesystem, so they can list their
// tools but cannot run Terraform or kubectl. This module runs each Terraform, CloudFormation or
// Kubernetes tool call in its OWN short-lived connector child under one of six per-RUN profiles,
// each built here and nowhere else:
//
//   plan  network of the granted clouds, their credential; workdir read+write, this run's staging dir
//   init  plan's network plus the Terraform registry hosts, the credential; workdir read+write only
//   show  NO network, NO credential; workdir read, the approved plan directory read, no write
//   apply the granted clouds' network and credential; workdir read+write, approved dir read-only
//   cfn   CloudFormation + STS endpoints, the AWS credential; this call's scratch dir read+write
//   kube  ONE owner-approved API server (host:port); read: a gateway-built single-context
//         kubeconfig; write: this call's scratch directory ONLY (no owner directory is writable)
//
// A profile's read list is DERIVED as (its declared reads) UNION (its writes): a directory a child
// writes and a CLI then reads is readable on macOS, whose profile builds `file-read*` from the read
// list alone. Every id is new per run, so Windows ACEs (which outlive a child) are released on exit
// and, for a crash, revoked from a persisted ledger before the next start (the Obsidian pattern).
// The workdir comes only from the owner's V85 approval, re-checked for every child.
//
// The child is the only thing this module trusts less than the gateway: a call has a budget after
// which the child is killed, and the per-directory run lock (and the run's staging and approved
// directories) are released only once every child of the run has actually exited.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { PreflightOutcome } from "../../engine/bound-write-capabilities.ts";
import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import {
  IAC_TERRAFORM_INIT_HOSTS,
  iacCfnHosts,
  iacTerraformHosts,
} from "../connector-writes/iac-clouds.ts";
import {
  gateWorkdirChecked,
  type IacCloud,
  type IacGrants,
  workdirsOverlap,
} from "../connector-writes/iac-grants.ts";
import { IAC_PREFLIGHT_REFUSALS, IAC_TOOL_TIMEOUTS_MS } from "../connector-writes/iac-limits.ts";
import { type K8sGrant, k8sGrantFor } from "../connector-writes/k8s-grants.ts";
import {
  buildSingleContextKubeconfig,
  inspectKubeconfig,
  kubeconfigMatchesGrant,
  nodeKubeFs,
} from "../connector-writes/kubeconfig-facts.ts";
import { manifestForFirstParty } from "./first-party-manifests.ts";
import {
  callChildTool,
  EXIT_WAIT_MS,
  escalationGraceMs,
  type IacChild,
  type IacChildSpawner,
  iacChildFromProcess,
  STOP_GRACE_MS,
  STOP_KILL_WAIT_MS,
} from "./iac-runner/iac-child.ts";
import { loadIacCloudEnv } from "./iac-runner/iac-cloud-env.ts";
import { IacWindowsGrants } from "./iac-runner/iac-grant-ledger.ts";
import { type IacBinary, installReads } from "./iac-runner/iac-install-reads.ts";
import { IacLiveChildren } from "./iac-runner/iac-live-children.ts";
import { IAC_RUNNER_REFUSALS } from "./iac-runner/iac-refusals.ts";
import { iacRootFor, isOurChangeSet } from "./iac-runner/iac-roots.ts";
import type { IacHost, IacRunnerDeps } from "./iac-runner/iac-runner-types.ts";
import { defaultRemoveTree } from "./iac-runner/iac-tree.ts";
import { connectorSpawn } from "./keys.ts";
import { loadAwsCreds } from "./phase3-shared.ts";
import { mcpClientToolKey } from "./tool-map.ts";
import { wrapIacServerSpec } from "./wrap-server-spec.ts";

// The public surface of this module is unchanged by the split (the pieces live in `./iac-runner/`).
export { IAC_APPLY_ESCALATE_AFTER_MS as APPLY_ESCALATE_AFTER_MS } from "../connector-writes/iac-limits.ts";
export {
  type ChildCall,
  callChildTool,
  escalationGraceMs,
  type IacChild,
  type IacChildSpawner,
  iacChildFromProcess,
} from "./iac-runner/iac-child.ts";
export {
  fileIacGrantLedger,
  type IacGrantLedger,
  type IacLedgerEntry,
  iacGrantLedgerFile,
} from "./iac-runner/iac-grant-ledger.ts";
export {
  type IacBinary,
  type InstallReadEnv,
  installReads,
  isSystemOwnedDir,
} from "./iac-runner/iac-install-reads.ts";
export { IAC_RUNNER_REFUSALS } from "./iac-runner/iac-refusals.ts";
export { iacProtectedRootsFor, iacRootFor } from "./iac-runner/iac-roots.ts";
export type { IacHost, IacRunnerDeps } from "./iac-runner/iac-runner-types.ts";

// ---------------------------------------------------------------------------------------------
// Routing: which tool runs in which profile.

export type IacProfileKind = "plan" | "init" | "show" | "apply" | "cfn" | "kube";

/** The tools the runner executes (eleven). Everything else the `iac` slot lists stays in it. */
export const IAC_TOOL_PROFILE: Readonly<Record<string, Exclude<IacProfileKind, "kube">>> =
  Object.freeze({
    iac_terraform_plan: "plan",
    iac_terraform_destroy_plan: "plan",
    iac_terraform_plan_refresh_only: "plan",
    iac_terraform_show_json: "show",
    iac_terraform_apply: "apply",
    iac_terraform_destroy: "apply",
    iac_terraform_apply_refresh_only: "apply",
    iac_terraform_init: "init",
    iac_cloudformation_changeset_create: "cfn",
    iac_cloudformation_changeset_discard: "cfn",
    iac_cloudformation_deploy: "cfn",
  });

/**
 * The nine `kubernetes` tools the runner executes, ALL of them (D3a): the listing slot has no
 * network, so every `k8s_*` tool, the reads a before-state needs included, runs in a `kube` child.
 */
export const KUBE_TOOL_PROFILE: Readonly<Record<string, "kube">> = Object.freeze({
  k8s_pod_list: "kube",
  k8s_deployment_get: "kube",
  k8s_deployment_list: "kube",
  k8s_event_list: "kube",
  k8s_rollout_restart: "kube",
  k8s_pod_delete: "kube",
  k8s_deployment_scale: "kube",
  k8s_manifest_plan: "kube",
  k8s_manifest_apply: "kube",
});

/** The mesh key of a routed tool (`<server>_<tool id>`), for the mesh's override. */
export function iacRoutedKeys(): readonly string[] {
  return [
    ...Object.keys(IAC_TOOL_PROFILE).map((id) => mcpClientToolKey("iac", id)),
    ...Object.keys(KUBE_TOOL_PROFILE).map((id) => mcpClientToolKey("kubernetes", id)),
  ];
}

/**
 * The region a CloudFormation child uses: the Vault credential's own region, else the first
 * approved one, and ONLY when it is an approved region, so the child never reaches a host the
 * owner's enable prompt did not list. `undefined` refuses the call.
 */
export function cfnRegionFor(
  credentialRegion: string,
  approved: readonly string[],
): string | undefined {
  const region = credentialRegion !== "" ? credentialRegion : (approved[0] ?? "");
  return region !== "" && approved.includes(region) ? region : undefined;
}

// ---------------------------------------------------------------------------------------------
// Profiles (pure).

export interface IacProfileRequest {
  readonly kind: IacProfileKind;
  /** Random per run: the policy id, hence the Windows AppContainer, is new every time. */
  readonly runId: string;
  readonly platform: NodeJS.Platform;
  /** The approved canonical workdir (plan, show, apply). */
  readonly workdir?: string;
  /** This run's plan staging directory (plan). */
  readonly stagingDir?: string;
  /** `approved/<runId>`: what the show and apply children may read (never write). */
  readonly approvedRunDir?: string;
  /** This call's scratch directory (cfn). */
  readonly scratchDir?: string;
  readonly clouds: readonly IacCloud[];
  /** The AWS region the cfn child talks to. */
  readonly region?: string;
  /** Owner-typed extra hosts. */
  readonly net: readonly string[];
  /** CLI install trees to read (POSIX only, see {@link installTreeReads}). */
  readonly installTrees: readonly string[];
  /** A credential file the child must read (GCP key file). */
  readonly credentialFiles?: readonly string[];
  /** kube: the one approved API server as `host:port`. */
  readonly server?: string;
  /** kube: the pinned context (`KUBE_CONTEXT`). */
  readonly context?: string;
  /** kube: the gateway-built single-context kubeconfig FILE the child reads. */
  readonly kubeconfigFile?: string;
}

export interface IacProfile {
  readonly manifest: ExtensionManifest;
  /** The non-credential environment of the child. */
  readonly env: Readonly<Record<string, string>>;
}

const PROFILE_ID_PREFIX = "com.nimbus.iac-";

/** The profile id of a run: new on every run. */
export function iacProfileId(kind: IacProfileKind, runId: string): string {
  return `${PROFILE_ID_PREFIX}${kind}.${runId}`;
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** A one-element list for a defined value, else an empty one. */
function listOf(value: string | undefined): string[] {
  return value === undefined ? [] : [value];
}

function setEnvIfDefined(
  env: Record<string, string>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) env[key] = value;
}

/** What one profile kind may reach, read and write, before the manifest is assembled. */
interface KindGrants {
  readonly network: readonly string[];
  readonly declaredRead: readonly string[];
  readonly write: readonly string[];
}

/** Phase 1 of a profile: the network, reads and writes of its kind (and the env they need). */
function kindGrants(
  req: IacProfileRequest,
  wd: readonly string[],
  env: Record<string, string>,
): KindGrants {
  let network: string[] = [];
  let declaredRead: string[] = [];
  let write: string[] = [];
  switch (req.kind) {
    case "plan":
      network = [...iacTerraformHosts(req.clouds), ...req.net];
      declaredRead = [...req.installTrees, ...(req.credentialFiles ?? [])];
      write = [...wd, ...(req.stagingDir === undefined ? [] : [req.stagingDir])];
      setEnvIfDefined(env, "NIMBUS_IAC_PLAN_DIR", req.stagingDir);
      break;
    case "init":
      // The plan's hosts (a backend such as S3 is read at init) plus the registry the providers
      // and registry modules come from; it writes `.terraform/` and the lock file, nothing else.
      network = [...iacTerraformHosts(req.clouds), ...IAC_TERRAFORM_INIT_HOSTS, ...req.net];
      declaredRead = [...req.installTrees, ...(req.credentialFiles ?? [])];
      write = [...wd];
      break;
    case "show":
      // No network, no credential, no write: it renders one saved plan and nothing else.
      declaredRead = [...wd, ...listOf(req.approvedRunDir), ...req.installTrees];
      setEnvIfDefined(env, "NIMBUS_IAC_PLAN_DIR", req.approvedRunDir);
      break;
    case "apply":
      network = [...iacTerraformHosts(req.clouds), ...req.net];
      declaredRead = [
        ...listOf(req.approvedRunDir),
        ...req.installTrees,
        ...(req.credentialFiles ?? []),
      ];
      write = [...wd];
      setEnvIfDefined(env, "NIMBUS_IAC_PLAN_DIR", req.approvedRunDir);
      break;
    case "cfn":
      network = iacCfnHosts(req.region ?? "");
      declaredRead = [...req.installTrees];
      write = req.scratchDir === undefined ? [] : [req.scratchDir];
      setEnvIfDefined(env, "NIMBUS_CONNECTOR_SCRATCH_DIR", req.scratchDir);
      break;
    case "kube":
      return kubeGrants(req, env);
  }
  return { network, declaredRead, write };
}

/**
 * The kube profile's grants (D3a). One owner-approved API server (an owner-configured entry: a
 * private or loopback cluster is reachable because the owner chose it; no wildcard). The ONLY
 * credential is the gateway's copy; the ONLY writable path is this call's scratch directory.
 */
function kubeGrants(req: IacProfileRequest, env: Record<string, string>): KindGrants {
  const network = req.server === undefined ? [] : [req.server];
  const declaredRead = [
    ...req.installTrees,
    ...(req.kubeconfigFile === undefined ? [] : [dirname(req.kubeconfigFile)]),
  ];
  const write = req.scratchDir === undefined ? [] : [req.scratchDir];
  if (req.kubeconfigFile !== undefined) env["KUBECONFIG"] = req.kubeconfigFile;
  if (req.context !== undefined) env["KUBE_CONTEXT"] = req.context;
  if (req.scratchDir !== undefined) {
    env["NIMBUS_CONNECTOR_SCRATCH_DIR"] = req.scratchDir;
    env["KUBECACHEDIR"] = join(req.scratchDir, "cache");
  }
  return { network, declaredRead, write };
}

/**
 * The hosts the owner configured (rather than the first-party table): the kube server, a terraform
 * plan's or apply's owner-typed extra hosts; none for show and cfn.
 */
function ownerConfiguredHosts(
  req: IacProfileRequest,
  network: readonly string[],
): readonly string[] {
  if (req.kind === "kube") return network;
  return req.kind === "show" || req.kind === "cfn" ? [] : req.net;
}

/**
 * The profile of one call, per the plan's table (section 2.7 as corrected by the Task 0 probe).
 * PURE: `show` has no network and writes nothing; `read` is always (declared reads) UNION (writes).
 * Two phases in order: the kind's grants (`kindGrants`), then the manifest built from them.
 */
export function buildIacProfile(req: IacProfileRequest): IacProfile {
  const { kind } = req;
  const env: Record<string, string> = {};
  const terraform = kind !== "cfn" && kind !== "kube";
  if (terraform) {
    env["TF_IN_AUTOMATION"] = "1";
    env["TF_INPUT"] = "0";
    env["CHECKPOINT_DISABLE"] = "1";
  }
  const { network, declaredRead, write } = kindGrants(req, listOf(req.workdir), env);
  const writes = uniq(write);
  const reads = uniq([...declaredRead, ...writes]);
  const base = manifestForFirstParty(
    kind === "kube" ? "kubernetes" : "iac",
    terraform && kind !== "show" ? req.clouds.map((c) => `iac_${c}`) : [],
  );
  const owned = ownerConfiguredHosts(req, network);
  const manifest: ExtensionManifest = {
    ...base,
    id: iacProfileId(kind, req.runId),
    permissions: {
      network: uniq(network),
      filesystem: { read: reads, write: writes },
    },
    ...(owned.length === 0 ? {} : { ownerConfiguredNetwork: uniq(owned) }),
    canonicalWritePaths: writes,
  };
  return { manifest, env };
}

/** The production spawner: a hidden child process with the wrapped spec's own environment. */
export const spawnIacChild: IacChildSpawner = (spec) =>
  iacChildFromProcess(
    // The environment was built from extensionProcessEnv(...) (I1) and wrapped by wrapIacServerSpec.
    spawn(spec.command, spec.args, {
      // extensionProcessEnv(...) plus the policy wire, built by the caller (I1).
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }),
  );

interface Run {
  readonly id: string;
  readonly workdir: string;
  readonly stagingDir: string;
  readonly approvedRunDirs: Set<string>;
  released: boolean;
  live: number;
}

/** One in-flight bound Kubernetes apply per (context, namespace), held until its children have exited. */
interface KubeRun {
  released: boolean;
  live: number;
}

const K8S_APPLY_ROW = "k8s_manifest_apply";
/** The two tools of a bound run: they run only inside a run the preflight opened. */
const KUBE_RUN_TOOLS: ReadonlySet<string> = new Set(["k8s_manifest_plan", "k8s_manifest_apply"]);
/** The reads: `namespace` may be absent (the connector defaults it to `default`), `context` too. */
const KUBE_READ_TOOLS: ReadonlySet<string> = new Set([
  "k8s_pod_list",
  "k8s_deployment_get",
  "k8s_deployment_list",
  "k8s_event_list",
]);

/** The lock key of a pair. NUL cannot occur in either name, so two pairs never share a key. */
function kubeRunKey(context: string, namespace: string): string {
  return `${context}\0${namespace}`;
}

/** The tools a Terraform run is opened for: the three bound rows (by their preflight) and the init (by itself). */
const TERRAFORM_ROWS: ReadonlySet<string> = new Set(
  Object.keys(IAC_TOOL_PROFILE).filter((id) =>
    ["apply", "init"].includes(IAC_TOOL_PROFILE[id] ?? ""),
  ),
);
const CFN_ROW = "iac_cloudformation_deploy";
const HEX32 = /^[0-9a-f]{32}$/;
const PLAN_NAMES = new Set(["plan.tfplan", "destroy.tfplan", "refresh.tfplan"]);

export class IacRunner implements IacHost {
  private readonly runs = new Map<string, Run>();
  private readonly kubeRuns = new Map<string, KubeRun>();
  private readonly iacRoot: string;
  private realApproved: string | undefined;
  /** Children this process started and has not seen exit; `stop()` kills and waits for them. */
  private readonly liveChildren = new Set<{
    readonly child: IacChild;
    readonly exited: Promise<void>;
  }>();
  private stopped = false;
  private readonly hex: (bytes: number) => string;
  private readonly removeTree: (p: string) => void;
  private readonly live: IacLiveChildren;
  private readonly winGrants: IacWindowsGrants;

  constructor(private readonly deps: IacRunnerDeps) {
    this.iacRoot = iacRootFor(deps.paths);
    this.hex = deps.randomHex ?? ((n) => randomBytes(n).toString("hex"));
    this.removeTree = deps.removeTree ?? defaultRemoveTree;
    this.live = new IacLiveChildren(this.iacRoot, (p) => this.removeTree(p), deps.isPidAlive);
    this.winGrants = new IacWindowsGrants(deps);
  }

  /** `<iacRoot>/approved`: where the settler moves an approved plan. */
  private approvedRoot(): string {
    return join(this.iacRoot, "approved");
  }

  /**
   * The same directory as the kernel names it (a macOS `/var`, a Windows 8.3 or junction component
   * resolved), cached once it exists. A plan path is compared with THIS, never the configured spelling.
   */
  private realApprovedRoot(): string {
    if (this.realApproved !== undefined) return this.realApproved;
    try {
      this.realApproved = realpathSync.native(this.approvedRoot());
      return this.realApproved;
    } catch {
      return this.approvedRoot();
    }
  }

  recheckGit(workdir: string): string | undefined {
    return this.deps.pathDeps.gitScan(workdir) === "clean"
      ? undefined
      : IAC_PREFLIGHT_REFUSALS.gitRepository;
  }

  k8sServerFor(context: string, namespace: string): string | undefined {
    return k8sGrantFor(this.deps.k8sGrants?.() ?? [], context, namespace)?.server;
  }

  terraformRunDirs(workdir: string): { stagingDir: string; approvedRoot: string } | undefined {
    const run = this.runs.get(workdir);
    return run === undefined
      ? undefined
      : { stagingDir: run.stagingDir, approvedRoot: this.approvedRoot() };
  }

  async preflight(
    rowToolId: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<PreflightOutcome> {
    if (this.stopped) return { ok: false, reason: IAC_RUNNER_REFUSALS.stopping };
    this.live.sweep();
    const unreadable = this.live.liveRecordRefusal();
    if (unreadable !== undefined) return { ok: false, reason: unreadable };
    if (rowToolId === CFN_ROW) return this.preflightCfn();
    if (rowToolId === K8S_APPLY_ROW) return this.preflightKube(input);
    if (!TERRAFORM_ROWS.has(rowToolId)) {
      return { ok: false, reason: IAC_RUNNER_REFUSALS.noRun };
    }
    const gated = gateWorkdirChecked(
      input["workingDirectory"],
      this.deps.grants(),
      this.deps.pathDeps,
    );
    if (!gated.ok) return { ok: false, reason: this.gateRefusal(gated.reason) };
    const workdir = gated.path;
    // One run per workdir, held until its children have exited (not merely until the gate returns).
    // A child a previous gateway left running may still be writing this directory.
    this.live.orphans = this.live.orphans.filter((o) => this.live.pidAlive(o.pid));
    for (const o of this.live.orphans) {
      if (
        o.workdir !== undefined &&
        workdirsOverlap(o.workdir, workdir, this.deps.pathDeps.platform)
      ) {
        return { ok: false, reason: IAC_PREFLIGHT_REFUSALS.busy };
      }
    }
    // Nested directories overlap too: a plan child writing `/a` can edit `/a/b` between its plan and apply.
    for (const live of this.runs.keys()) {
      if (workdirsOverlap(live, workdir, this.deps.pathDeps.platform)) {
        return { ok: false, reason: IAC_PREFLIGHT_REFUSALS.busy };
      }
    }
    const id = this.hex(8);
    const run: Run = {
      id,
      workdir,
      stagingDir: join(this.iacRoot, "staging", id),
      approvedRunDirs: new Set(),
      released: false,
      live: 0,
    };
    this.runs.set(workdir, run);
    return { ok: true, workingDirectory: workdir, release: () => this.release(run) };
  }

  private gateRefusal(reason: "not-approved" | "git"): string {
    return reason === "git"
      ? IAC_PREFLIGHT_REFUSALS.gitRepository
      : IAC_PREFLIGHT_REFUSALS.notApprovedDirectory;
  }

  /**
   * The Kubernetes apply's cheap refusals (D3a), before any child exists: the (context, namespace)
   * pair is one the owner approved, no other bound run holds it, the kubeconfig still names the
   * approved cluster, and `kubectl` resolves. The lock is taken BEFORE the first await and given
   * back on every refusal; it is held until the gate releases it AND every child has exited.
   */
  private async preflightKube(input: Readonly<Record<string, unknown>>): Promise<PreflightOutcome> {
    const context = input["context"];
    const namespace = input["namespace"];
    const refuse = (reason: string): PreflightOutcome => ({ ok: false, reason });
    if (typeof context !== "string" || typeof namespace !== "string") {
      return refuse(IAC_RUNNER_REFUSALS.kubeNotApproved);
    }
    const grant = k8sGrantFor(this.deps.k8sGrants?.() ?? [], context, namespace);
    if (grant === undefined) return refuse(IAC_RUNNER_REFUSALS.kubeNotApproved);
    const key = kubeRunKey(context, namespace);
    if (this.kubeRuns.has(key)) return refuse(IAC_RUNNER_REFUSALS.kubeBusy);
    const run: KubeRun = { released: false, live: 0 };
    this.kubeRuns.set(key, run);
    const release = (): void => {
      run.released = true;
      this.maybeFreeKube(key, run);
    };
    let reason: string | undefined;
    try {
      reason = await this.kubeRefusal(context, grant);
    } catch {
      reason = IAC_RUNNER_REFUSALS.kubeDrift;
    }
    if (reason !== undefined) {
      release();
      return refuse(reason);
    }
    return { ok: true, release };
  }

  /** Why a Kubernetes call for `grant` cannot start now: the kubeconfig drifted or kubectl is missing. */
  private async kubeRefusal(context: string, grant: K8sGrant): Promise<string | undefined> {
    const facts = inspectKubeconfig(
      this.deps.kubeFs ?? nodeKubeFs,
      await this.kubeconfigPath(),
      context,
    );
    if (!facts.ok || !kubeconfigMatchesGrant(facts, grant)) return IAC_RUNNER_REFUSALS.kubeDrift;
    return this.resolve("kubectl") === undefined ? IAC_RUNNER_REFUSALS.kubeNoBinary : undefined;
  }

  private async kubeconfigPath(): Promise<string | undefined> {
    if (this.deps.kubeconfigPath !== undefined) return this.deps.kubeconfigPath();
    return (await readConnectorSecret(this.deps.vault, "kubernetes", "kubeconfig")) ?? undefined;
  }

  private maybeFreeKube(key: string, run: KubeRun): void {
    if (!run.released || run.live > 0) return;
    if (this.kubeRuns.get(key) === run) this.kubeRuns.delete(key);
  }

  private async preflightCfn(): Promise<PreflightOutcome> {
    const grants = this.deps.grants();
    if (!grants.clouds.includes("aws"))
      return { ok: false, reason: IAC_PREFLIGHT_REFUSALS.noCloudCredential };
    const creds = await loadAwsCreds(this.deps.vault);
    if (!creds.ok) return { ok: false, reason: IAC_PREFLIGHT_REFUSALS.noCloudCredential };
    if (cfnRegionFor(creds.region, grants.regions) === undefined) {
      return { ok: false, reason: IAC_PREFLIGHT_REFUSALS.regionNotApproved };
    }
    return { ok: true, release: () => undefined };
  }

  /**
   * Gateway stop (the mesh's `disconnect`): refuse new work, ask every live child to finish
   * (SIGTERM), give it {@link STOP_GRACE_MS} to write its state, kill it hard, wait for the process to
   * be gone, then free every run whose children are gone. A child that will not die keeps its run
   * (and its directories): nothing is freed under a process that may still be writing. Never rejects.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    const live = [...this.liveChildren];
    const wait = async (ms: number): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), ms);
      });
      try {
        return await Promise.race([
          Promise.all(live.map((l) => l.exited)).then(() => true),
          timedOut,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    for (const l of live) {
      l.child.closeInput();
      l.child.kill(false);
    }
    if (live.length > 0 && !(await wait(this.deps.stopGraceMs ?? STOP_GRACE_MS))) {
      for (const l of live) l.child.kill(true);
      await wait(this.deps.stopKillWaitMs ?? STOP_KILL_WAIT_MS);
    }
    for (const run of this.runs.values()) {
      run.released = true;
      this.maybeFree(run);
    }
    for (const [key, run] of this.kubeRuns) {
      run.released = true;
      this.maybeFreeKube(key, run);
    }
  }

  private release(run: Run): void {
    run.released = true;
    this.maybeFree(run);
  }

  /** Frees a run only when the gate is done with it AND no child of it is still alive. */
  private maybeFree(run: Run): void {
    if (!run.released || run.live > 0) return;
    if (this.runs.get(run.workdir) !== run) return;
    for (const d of [run.stagingDir, ...run.approvedRunDirs]) {
      try {
        this.removeTree(d);
      } catch {
        // swept at the next gateway boot
      }
    }
    this.runs.delete(run.workdir);
  }

  /** Runs one routed tool. Rejects with a fixed-text error; never a path or the connector's words. */
  async execute(toolId: string, input: unknown): Promise<unknown> {
    const args =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const budget = (this.deps.timeoutsMs ?? IAC_TOOL_TIMEOUTS_MS)[toolId] ?? 60_000;
    if (Object.hasOwn(KUBE_TOOL_PROFILE, toolId)) {
      if (this.stopped) throw new Error(IAC_RUNNER_REFUSALS.kubeStopping);
      return this.runKube(toolId, args, budget);
    }
    const kind = Object.hasOwn(IAC_TOOL_PROFILE, toolId) ? IAC_TOOL_PROFILE[toolId] : undefined;
    if (kind === undefined) throw new Error(IAC_RUNNER_REFUSALS.noRun);
    if (this.stopped) throw new Error(IAC_RUNNER_REFUSALS.stopping);
    if (kind === "cfn") return this.runCfn(toolId, args, budget);
    if (kind === "init") return this.runInit(toolId, args, budget);
    return this.runTerraform(toolId, kind, args, budget);
  }

  /**
   * `iac_terraform_init`, the one runner write with no bound step and so no preflight: it opens
   * its own run through the same checks (approved directory, no `.git`, no overlapping run or
   * orphan), runs ONE child on the gateway-resolved path alone (no other input key reaches it) and
   * gives the run back; the lock is held until that child has exited, as for every run.
   */
  private async runInit(
    toolId: string,
    args: Record<string, unknown>,
    budget: number,
  ): Promise<unknown> {
    const opened = await this.preflight(toolId, args);
    if (!opened.ok) throw new Error(opened.reason);
    try {
      const workingDirectory = opened.workingDirectory ?? args["workingDirectory"];
      return await this.runTerraform(toolId, "init", { workingDirectory }, budget);
    } finally {
      opened.release();
    }
  }

  /**
   * The approved pair a kube call runs for, read from a FRESH copy of the owner's V86 approvals: a
   * read that names no context takes the only approved one (refused when there are several) and no
   * namespace means `default`; a write names both. Anything not approved is refused.
   */
  private approvedKubePair(
    toolId: string,
    args: Record<string, unknown>,
  ): { context: string; grant: NonNullable<ReturnType<typeof k8sGrantFor>>; key: string } {
    const grants = this.deps.k8sGrants?.() ?? [];
    const isRead = KUBE_READ_TOOLS.has(toolId);
    const contexts = [...new Set(grants.map((g) => g.context))];
    let context: unknown = args["context"];
    if (context === undefined && isRead) {
      if (contexts.length > 1) throw new Error(IAC_RUNNER_REFUSALS.kubeNoContext);
      context = contexts[0];
    }
    const given = args["namespace"];
    const namespace: unknown = given === undefined && isRead ? "default" : given;
    if (typeof context !== "string" || typeof namespace !== "string") {
      throw new TypeError(IAC_RUNNER_REFUSALS.kubeNotApproved);
    }
    const grant = k8sGrantFor(grants, context, namespace);
    if (grant === undefined) throw new Error(IAC_RUNNER_REFUSALS.kubeNotApproved);
    return { context, grant, key: kubeRunKey(context, namespace) };
  }

  /** The open, unreleased run a plan or apply belongs to (refused without one); undefined for a read. */
  private openKubeRunFor(toolId: string, key: string): KubeRun | undefined {
    if (!KUBE_RUN_TOOLS.has(toolId)) return undefined;
    const run = this.kubeRuns.get(key);
    if (run === undefined || run.released) throw new Error(IAC_RUNNER_REFUSALS.kubeNoRun);
    return run;
  }

  /**
   * One Kubernetes tool call in its own `kube` child (D3a). The (context, namespace) pair is
   * re-checked against a FRESH read of the owner's V86 approvals for every child, the child's
   * kubeconfig is rebuilt from the owner's file for exactly that context (its server and credential
   * form must still equal what the owner approved), and a plan or apply runs only inside the run the
   * preflight opened. A read that names no context takes the only approved one.
   */
  private async runKube(
    toolId: string,
    args: Record<string, unknown>,
    budget: number,
  ): Promise<unknown> {
    // A read can be the first call after boot: the boot sweep must have run (it clears the run
    // directories a crashed gateway left) before this call makes its own, and an unreadable
    // live-children record refuses, as it does for a preflight.
    this.live.sweep();
    const unreadable = this.live.liveRecordRefusal();
    if (unreadable !== undefined) throw new Error(unreadable);
    // Phase 1: the (context, namespace) pair, against a FRESH read of the owner's approvals.
    const { context, grant, key } = this.approvedKubePair(toolId, args);
    // Phase 2: a plan or apply only inside the run the preflight opened.
    const run = this.openKubeRunFor(toolId, key);
    // Taken BEFORE the first await: a gate that releases while the kubeconfig is read must not free
    // the run under a child that is about to start.
    if (run !== undefined) run.live += 1;
    const callId = this.hex(8);
    const kubeDir = join(this.iacRoot, "kube", callId);
    const scratchDir = join(this.iacRoot, "scratch", callId);
    const onExited = (): void => {
      this.safeRemove(kubeDir);
      this.safeRemove(scratchDir);
      if (run !== undefined) {
        run.live -= 1;
        this.maybeFreeKube(key, run);
      }
    };
    let handedOff = false;
    try {
      const kubectl = this.resolve("kubectl");
      if (kubectl === undefined) throw new Error(IAC_RUNNER_REFUSALS.kubeNoBinary);
      const built = buildSingleContextKubeconfig(
        this.deps.kubeFs ?? nodeKubeFs,
        await this.kubeconfigPath(),
        context,
      );
      if (!built.ok || !kubeconfigMatchesGrant(built, grant)) {
        throw new Error(IAC_RUNNER_REFUSALS.kubeDrift);
      }
      mkdirSync(kubeDir, { recursive: true, mode: 0o700 });
      const kubeconfigFile = join(kubeDir, "config");
      writeFileSync(kubeconfigFile, built.text, { mode: 0o600 });
      mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
      const profile = buildIacProfile({
        kind: "kube",
        runId: callId,
        platform: this.deps.platform,
        scratchDir,
        clouds: [],
        net: [],
        installTrees: [
          ...installReads(kubectl, this.deps.platform, "kubectl", this.deps.pathDeps),
          ...(this.deps.extraReadPaths ?? []),
        ],
        server: grant.server,
        context,
        kubeconfigFile,
      });
      const timeoutText =
        toolId === K8S_APPLY_ROW
          ? "timed out; the cluster may be partly changed; check it with kubectl"
          : "kubernetes: the call exceeded its time limit";
      // The child is told the context it was granted, always: a read that named none gets it here.
      // From here `spawnAndCall` owns `onExited`: it runs it on a failed spawn or when the child exits.
      handedOff = true;
      return await this.spawnAndCall(
        profile,
        {},
        { toolId, args: { ...args, context }, budget, timeoutText },
        onExited,
        { service: "kubernetes" },
      );
    } catch (e) {
      if (!handedOff) onExited();
      throw e;
    }
  }

  private async runTerraform(
    toolId: string,
    kind: "plan" | "init" | "show" | "apply",
    args: Record<string, unknown>,
    budget: number,
  ): Promise<unknown> {
    // Defence in depth: the workdir is re-checked against a FRESH read of the owner's grants for
    // every child, and must belong to a run the preflight opened.
    const gated = gateWorkdirChecked(
      args["workingDirectory"],
      this.deps.grants(),
      this.deps.pathDeps,
    );
    if (!gated.ok) throw new Error(this.gateRefusal(gated.reason));
    const workdir = gated.path;
    const run = this.runs.get(workdir);
    if (run === undefined) throw new Error(IAC_RUNNER_REFUSALS.noRun);
    const terraform = this.resolve("terraform");
    if (terraform === undefined) throw new Error(IAC_RUNNER_REFUSALS.noBinary);

    let approvedRunDir: string | undefined;
    if (kind === "show" || kind === "apply") {
      approvedRunDir = this.approvedRunDirOf(args["planFile"]);
      if (approvedRunDir === undefined) throw new Error(IAC_RUNNER_REFUSALS.badPlanFile);
      run.approvedRunDirs.add(approvedRunDir);
    }
    // Taken BEFORE the first await: a gate that finishes while the credential loads must not free
    // the run (and delete its staging) under a child that is about to start.
    run.live += 1;
    const onExited = (): void => {
      run.live -= 1;
      this.maybeFree(run);
    };
    let cloudEnv: { env: Record<string, string>; files: string[] };
    let profile: IacProfile;
    try {
      cloudEnv =
        kind === "show"
          ? { env: {}, files: [] as string[] }
          : await this.cloudEnv(this.deps.grants());
      profile = this.terraformProfile(
        kind,
        run,
        workdir,
        approvedRunDir,
        terraform,
        cloudEnv.files,
      );
    } catch (e) {
      onExited();
      throw e;
    }
    const timeoutText =
      kind === "apply"
        ? `timed out after ${String(Math.round(budget / 60_000))} minutes; the infrastructure may be partly changed; check the Terraform state`
        : "iac: the call exceeded its time limit";
    // The run stays alive until the child has actually exited (onExited), whatever the call did.
    // A plan writes the file the gateway will move, hash and show: its process must be gone first.
    return this.spawnAndCall(
      profile,
      { ...cloudEnv.env },
      { toolId, args, budget, timeoutText },
      onExited,
      { awaitExit: kind === "plan", workdir },
    );
  }

  private terraformProfile(
    kind: "plan" | "init" | "show" | "apply",
    run: Run,
    workdir: string,
    approvedRunDir: string | undefined,
    terraform: string,
    credentialFiles: string[],
  ): IacProfile {
    const callId = this.hex(8);
    if (kind === "plan") mkdirSync(run.stagingDir, { recursive: true, mode: 0o700 });
    return buildIacProfile({
      kind,
      runId: callId,
      platform: this.deps.platform,
      workdir,
      ...(kind === "plan" ? { stagingDir: run.stagingDir } : {}),
      ...(approvedRunDir === undefined ? {} : { approvedRunDir }),
      clouds: kind === "show" ? [] : this.deps.grants().clouds,
      net: kind === "show" ? [] : this.deps.grants().net,
      installTrees: [
        ...installReads(terraform, this.deps.platform, "terraform", this.deps.pathDeps),
        ...(this.deps.extraReadPaths ?? []),
      ],
      credentialFiles,
    });
  }

  private async runCfn(
    toolId: string,
    args: Record<string, unknown>,
    budget: number,
  ): Promise<unknown> {
    const grants = this.deps.grants();
    if (!grants.clouds.includes("aws")) throw new Error(IAC_RUNNER_REFUSALS.noCredential);
    const aws = this.resolve("aws");
    if (aws === undefined) throw new Error(IAC_RUNNER_REFUSALS.noBinary);
    const creds = await loadAwsCreds(this.deps.vault);
    if (!creds.ok) throw new Error(IAC_RUNNER_REFUSALS.noCredential);
    const region = cfnRegionFor(creds.region, grants.regions);
    if (region === undefined) throw new Error(IAC_RUNNER_REFUSALS.regionNotApproved);
    if (toolId === "iac_cloudformation_changeset_discard" && !isOurChangeSet(args, region)) {
      throw new Error(IAC_RUNNER_REFUSALS.notOurChangeSet);
    }
    const callId = this.hex(8);
    const scratchDir = join(this.iacRoot, "scratch", callId);
    mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
    const profile = buildIacProfile({
      kind: "cfn",
      runId: callId,
      platform: this.deps.platform,
      scratchDir,
      clouds: ["aws"],
      region,
      net: [],
      installTrees: [
        ...installReads(aws, this.deps.platform, "aws", this.deps.pathDeps),
        ...(this.deps.extraReadPaths ?? []),
      ],
    });
    return this.spawnAndCall(
      profile,
      // The approved region, always: a profile-only credential would otherwise use its own.
      { ...creds.env, AWS_DEFAULT_REGION: region, AWS_REGION: region },
      { toolId, args, budget, timeoutText: "iac: the call exceeded its time limit" },
      () => this.safeRemove(scratchDir),
    );
  }

  /** Spawns the profile's child, makes the one call, and calls `onExited` once the child is dead. */
  private async spawnAndCall(
    profile: IacProfile,
    credentialEnv: Record<string, string>,
    callSpec: {
      readonly toolId: string;
      readonly args: Record<string, unknown>;
      readonly budget: number;
      readonly timeoutText: string;
    },
    onExited: () => void,
    opts: {
      readonly awaitExit?: boolean;
      readonly workdir?: string;
      /** The connector whose entrypoint the child runs (default `iac`). */
      readonly service?: "iac" | "kubernetes";
    } = {},
  ): Promise<unknown> {
    const { toolId, args, budget, timeoutText } = callSpec;
    const awaitExit = opts.awaitExit === true;
    const manifest = profile.manifest;
    const cwd = join(this.iacRoot, "cwd", manifest.id);
    const paths = uniq([
      cwd,
      ...manifest.permissions.filesystem.read,
      ...manifest.permissions.filesystem.write,
    ]);
    let child: IacChild | undefined;
    let prepared = false;
    try {
      await this.winGrants.prepareGrants(manifest.id, paths);
      prepared = true;
      // I1: the child's environment is extensionProcessEnv plus exactly the named variables.
      const wrapped = wrapIacServerSpec(
        {
          ...connectorSpawn(opts.service ?? "iac"),
          env: extensionProcessEnv({ ...profile.env, ...credentialEnv }),
        },
        manifest,
        cwd,
      );
      child = (this.deps.spawnChild ?? spawnIacChild)(wrapped);
    } catch (e) {
      // A spawn that failed after its grants were recorded releases them like a child that exited.
      if (prepared) await this.winGrants.afterExit(manifest.id, paths);
      this.safeRemove(cwd);
      onExited();
      throw e;
    }
    const call = callChildTool(
      child,
      toolId,
      args,
      budget,
      timeoutText,
      undefined,
      this.deps.escalateAfterMs ?? escalationGraceMs(toolId),
    );
    const live = { child, exited: call.exited };
    this.liveChildren.add(live);
    const pid = child.pid;
    if (pid !== undefined) this.live.recordLive(pid, opts.workdir);
    // A stop that began while the spawn was in flight could not see this child: kill it now.
    if (this.stopped) {
      child.closeInput();
      child.kill(true);
    }
    const done = call.exited.then(async () => {
      this.liveChildren.delete(live);
      if (pid !== undefined) this.live.forgetLive(pid);
      await this.winGrants.afterExit(manifest.id, paths);
      this.safeRemove(cwd);
      onExited();
    });
    if (!awaitExit) return call.result;
    // The connector's answer is not the end of the process: a descendant holding a writable handle
    // on the plan file could still rewrite it after it was hashed and shown. Wait for the child to be
    // reaped (on Linux the namespace teardown takes its tree with it) BEFORE the settler moves,
    // reads and hashes the file. A child that will not go away fails the plan; the run stays locked.
    const out = await call.result;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("iac: the plan process did not exit")),
            this.deps.exitWaitMs ?? EXIT_WAIT_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return out;
  }

  private safeRemove(p: string): void {
    try {
      this.removeTree(p);
    } catch {
      // swept at the next gateway boot
    }
  }

  /** The approved run directory a plan file lives in, or `undefined` when it is not under ours. */
  private approvedRunDirOf(planFile: unknown): string | undefined {
    if (typeof planFile !== "string") return undefined;
    let real: string;
    try {
      real = realpathSync.native(planFile);
    } catch {
      return undefined;
    }
    const approvedRoot = this.realApprovedRoot();
    const rel = relative(approvedRoot, real).split(sep);
    // <runId>/<planId>/<plan|destroy|refresh>.tfplan, and nothing else.
    if (rel.length !== 3 || rel.some((s) => s === "" || s === "..")) return undefined;
    const [runId, planId, name] = rel as [string, string, string];
    if (!HEX32.test(planId) || !HEX32.test(runId) || !PLAN_NAMES.has(name)) return undefined;
    return join(approvedRoot, runId);
  }

  private resolve(name: IacBinary): string | undefined {
    if (this.deps.resolveBinary !== undefined) return this.deps.resolveBinary(name);
    const found = Bun.which(name);
    if (found === null) return undefined;
    try {
      return realpathSync(found);
    } catch {
      return found;
    }
  }

  private cloudEnv(grants: IacGrants): Promise<{ env: Record<string, string>; files: string[] }> {
    return loadIacCloudEnv(this.deps.vault, grants);
  }
}

/**
 * The mesh's override of the routed tool keys: each key's `execute` becomes a runner call, so the
 * dispatcher's own asserts (prepare/write class, service, size cap, timeout) still run on the same
 * keys. A key the listing does not carry (the `iac` slot is off) is left absent.
 */
export function routeIacTools(
  merged: Record<string, { execute?: (input: unknown, context?: unknown) => Promise<unknown> }>,
  runner: Pick<IacRunner, "execute">,
): void {
  const routed: ReadonlyArray<readonly [string, string]> = [
    ...Object.keys(IAC_TOOL_PROFILE).map((id) => ["iac", id] as const),
    // D3a: every kubernetes tool runs in a `kube` child (the listing slot has no network).
    ...Object.keys(KUBE_TOOL_PROFILE).map((id) => ["kubernetes", id] as const),
  ];
  for (const [server, id] of routed) {
    const key = mcpClientToolKey(server, id);
    if (merged[key]?.execute === undefined) continue;
    merged[key] = { execute: (input: unknown) => runner.execute(id, input) };
  }
}
