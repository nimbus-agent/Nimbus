// packages/gateway/src/connectors/lazy-mesh/iac-runner.ts
// The IaC runner (Phase 9.7 D2 and D3a, invariants I15, I1, I50, I54; static D43(d)). The `iac` and
// `kubernetes` connectors' listing slots have no network and no filesystem, so they can list their
// tools but cannot run Terraform or kubectl. This module runs each Terraform, CloudFormation or
// Kubernetes tool call in its OWN short-lived connector child under one of five per-RUN profiles,
// each built here and nowhere else:
//
//   plan  network of the granted clouds, their credential; workdir read+write, this run's staging dir
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
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { PreflightOutcome } from "../../engine/bound-write-capabilities.ts";
import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import type { PlatformPaths } from "../../platform/paths.ts";
import {
  type AppContainerGrantRevoker,
  appContainerGrantRevokerFor,
} from "../../platform/sandbox/win32-grant-revoke.ts";
import { isSameOrInside, pathApiFor, pathsOverlap } from "../../util/path-overlap.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { gcloudKeyFileEnv, loadGcpAuthFromVault } from "../_lib/gcp-auth.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import { iacCfnHosts, iacTerraformHosts } from "../connector-writes/iac-clouds.ts";
import {
  gateWorkdirChecked,
  type IacCloud,
  type IacGrants,
  type IacPathDeps,
  workdirsOverlap,
} from "../connector-writes/iac-grants.ts";
import {
  IAC_ESCALATE_AFTER_MS,
  IAC_EXIT_WAIT_MS,
  IAC_PREFLIGHT_REFUSALS,
  IAC_TOOL_TIMEOUTS_MS,
  iacEscalationGraceMs,
  isPlainStackName,
} from "../connector-writes/iac-limits.ts";
import { type K8sGrant, k8sGrantFor } from "../connector-writes/k8s-grants.ts";
import { K8S_PREFLIGHT_REFUSALS } from "../connector-writes/k8s-limits.ts";
import {
  buildSingleContextKubeconfig,
  inspectKubeconfig,
  type KubeFs,
  kubeconfigMatchesGrant,
  nodeKubeFs,
} from "../connector-writes/kubeconfig-facts.ts";
import { manifestForFirstParty } from "./first-party-manifests.ts";
import { connectorSpawn } from "./keys.ts";
import { loadAwsCreds } from "./phase3-shared.ts";
import type { ServerSpec } from "./slot.ts";
import { mcpClientToolKey } from "./tool-map.ts";
import { wrapIacServerSpec } from "./wrap-server-spec.ts";

// ---------------------------------------------------------------------------------------------
// Routing: which tool runs in which profile.

export type IacProfileKind = "plan" | "show" | "apply" | "cfn" | "kube";

/** The CLIs an iac or kube child runs. */
export type IacBinary = "terraform" | "aws" | "kubectl";

/** The eight tools the runner executes. Everything else the `iac` slot lists stays in the slot. */
export const IAC_TOOL_PROFILE: Readonly<Record<string, Exclude<IacProfileKind, "kube">>> =
  Object.freeze({
    iac_terraform_plan: "plan",
    iac_terraform_destroy_plan: "plan",
    iac_terraform_show_json: "show",
    iac_terraform_apply: "apply",
    iac_terraform_destroy: "apply",
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

/** The reasons a call is refused before any child exists; fixed text, never the path or the input. */
export const IAC_RUNNER_REFUSALS = Object.freeze({
  noRun: IAC_PREFLIGHT_REFUSALS.noRun,
  notApproved: IAC_PREFLIGHT_REFUSALS.notApprovedDirectory,
  badPlanFile: "iac: the plan file is not in this gateway's approved plan directory",
  noBinary: "iac: the required command line tool was not found",
  noCredential: IAC_PREFLIGHT_REFUSALS.noCloudCredential,
  notOurChangeSet: "iac: that change set is not one this gateway created",
  stopping: IAC_PREFLIGHT_REFUSALS.stopping,
  regionNotApproved: IAC_PREFLIGHT_REFUSALS.regionNotApproved,
  kubeNoRun: "kubernetes: this call is not part of an approved run",
  kubeNoBinary: K8S_PREFLIGHT_REFUSALS.noCommandLineTool,
  kubeNotApproved: K8S_PREFLIGHT_REFUSALS.notApprovedNamespace,
  kubeDrift: K8S_PREFLIGHT_REFUSALS.kubeconfigDrift,
  kubeBusy: K8S_PREFLIGHT_REFUSALS.busy,
  kubeStopping: K8S_PREFLIGHT_REFUSALS.stopping,
  kubeNoContext: "kubernetes: name the context; more than one is approved",
});

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
  if (req.kind === "plan" || req.kind === "apply") return req.net;
  return [];
}

/**
 * The profile of one call, per the plan's table (section 2.7 as corrected by the Task 0 probe).
 * PURE: `show` has no network and writes nothing; `read` is always (declared reads) UNION (writes).
 * Two phases in order: the kind's grants (`kindGrants`), then the manifest built from them.
 */
export function buildIacProfile(req: IacProfileRequest): IacProfile {
  const { kind } = req;
  const env: Record<string, string> = {};
  const terraform = kind === "plan" || kind === "show" || kind === "apply";
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

/** Is `p` under a directory the operating system owns (so a read grant there is neither needed nor safe)? */
export function isSystemOwnedDir(p: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return true;
  const roots = [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/etc",
    "/System",
    "/Library",
    "/private/etc",
  ];
  return roots.some((r) => p === r || p.startsWith(`${r}/`));
}

/** The folders an install directory must not be, hold or sit in: where the gateway reads them from. */
export interface InstallReadEnv {
  readonly homeDir: string;
  readonly tmpDir: string;
  readonly protectedRoots: readonly string[];
}

/** Directory names that are shared or personal, never "an install of one tool". */
const SHARED_DIR_NAMES: ReadonlySet<string> = new Set([
  "bin",
  "sbin",
  "downloads",
  "desktop",
  "documents",
  "tmp",
  "temp",
]);
/** A path segment under which a read grant would expose credentials or personal state. */
const SENSITIVE_SEGMENTS: ReadonlySet<string> = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".azure",
  ".kube",
]);

/**
 * Is `tree` a directory dedicated to one tool's install, safe to hand to a networked, credentialed
 * child as a read grant? Not a root; deep enough to be a product directory (three segments); not a
 * shared or personal folder, a dotfile folder or one under a credential folder; not home or temp or
 * a folder that holds them; and not overlapping a Nimbus folder in either direction.
 */
function isVettedInstallRoot(
  tree: string,
  env: InstallReadEnv,
  platform: NodeJS.Platform,
): boolean {
  const api = pathApiFor(platform);
  const segments = tree.split(api.sep).filter((s) => s !== "");
  if (segments.length < 3) return false;
  const last = (segments.at(-1) ?? "").toLowerCase();
  if (SHARED_DIR_NAMES.has(last) || last.startsWith(".")) return false;
  if (segments.some((s) => SENSITIVE_SEGMENTS.has(s.toLowerCase()))) return false;
  if (isSameOrInside(platform, env.homeDir, tree) || isSameOrInside(platform, env.tmpDir, tree)) {
    return false;
  }
  return !env.protectedRoots.some((r) => pathsOverlap(platform, tree, r));
}

/**
 * What the CLI child may READ of its own install, POSIX only (a Windows grant on a tree under
 * `C:\Program Files` fails in the helper and the image loads without one) and never for a
 * system-owned binary (bubblewrap and the sandbox profile already carry `/usr`). Terraform is one
 * static binary: the FILE alone is granted, never its directory, so a binary left in the home
 * directory, `~/Downloads` or `~/.local/bin` exposes nothing else to a child that has the network
 * and a cloud credential. The `aws` CLI needs its install directory as well; it gets it only when
 * that directory is a vetted install root (see {@link isVettedInstallRoot}), else only the file
 * (the call then fails, which is the safe direction).
 */
export function installReads(
  binaryRealPath: string | undefined,
  platform: NodeJS.Platform,
  tool: IacBinary,
  env: InstallReadEnv,
): string[] {
  if (binaryRealPath === undefined || platform === "win32") return [];
  const tree = dirname(binaryRealPath);
  if (isSystemOwnedDir(tree, platform)) return [];
  if (tool !== "aws" || !isVettedInstallRoot(tree, env, platform)) return [binaryRealPath];
  return [binaryRealPath, tree];
}

// ---------------------------------------------------------------------------------------------
// The child and the one MCP call it makes.

/** A started child as the runner sees it (a node child process in production, a fake in tests). */
export interface IacChild {
  /** The OS process id, when the child started (recorded so a later boot knows what may be alive). */
  readonly pid?: number;
  /** Writes one JSON-RPC line to the child's stdin. */
  send(line: string): void;
  /** Called with every complete line the child writes to stdout. */
  onLine(cb: (line: string) => void): void;
  /** Called once, when the process has actually exited (or failed to start). */
  onExit(cb: (code: number | null) => void): void;
  /** SIGTERM-class (`force` false) or SIGKILL-class (`force` true). */
  kill(force: boolean): void;
  /** Closes stdin (the connector exits on EOF). */
  closeInput(): void;
}

export type IacChildSpawner = (spec: ServerSpec) => IacChild;

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

/**
 * Wraps a started process. The child counts as exited when the OS reports it closed, or when it
 * never started; a later `"error"` event (a kill or a write that failed) says nothing about the
 * process being gone, so it must not free the run lock.
 */
export function iacChildFromProcess(proc: ChildProcess): IacChild {
  let exited = false;
  const exitCbs: Array<(code: number | null) => void> = [];
  const finish = (code: number | null): void => {
    if (exited) return;
    exited = true;
    for (const cb of exitCbs) cb(code);
  };
  proc.on("close", (code) => finish(code));
  proc.on("error", () => {
    // pid is undefined only when the spawn itself failed; any other error leaves the process there.
    if (proc.pid === undefined) finish(null);
  });
  proc.stderr?.on("data", () => {
    // Drained and dropped: a connector's stderr never reaches the model, the owner or a log.
  });
  proc.stdin?.on("error", () => {
    // A write after the child exited; the exit path reports it.
  });
  return {
    ...(proc.pid === undefined ? {} : { pid: proc.pid }),
    send: (line) => {
      proc.stdin?.write(`${line}\n`);
    },
    onLine: (cb) => {
      let buf = "";
      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (d: string) => {
        buf += d;
        let i = buf.indexOf("\n");
        while (i >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line !== "") cb(line);
          i = buf.indexOf("\n");
        }
      });
    },
    onExit: (cb) => {
      if (exited) cb(proc.exitCode);
      else exitCbs.push(cb);
    },
    kill: (force) => {
      try {
        proc.kill(force ? "SIGKILL" : "SIGTERM");
      } catch {
        // already gone
      }
    },
    closeInput: () => {
      try {
        proc.stdin?.end();
      } catch {
        // already closed
      }
    },
  };
}

/** At gateway stop: the grace children get to finish (a state write) before SIGKILL. */
const STOP_GRACE_MS = 15_000;
const STOP_KILL_WAIT_MS = 5_000;

// The SIGTERM-to-SIGKILL grace, the plan's reap wait and the dispatcher's race over them live in
// `iac-limits.ts`, so the dispatcher's timeout is derived from the same numbers (it must outlast
// all of these: the runner always settles first).
export { IAC_APPLY_ESCALATE_AFTER_MS as APPLY_ESCALATE_AFTER_MS } from "../connector-writes/iac-limits.ts";
export const escalationGraceMs = iacEscalationGraceMs;
const ESCALATE_AFTER_MS = IAC_ESCALATE_AFTER_MS;
const EXIT_WAIT_MS = IAC_EXIT_WAIT_MS;

/** What one call to a child produced; `exited` resolves when the process is really gone. */
interface ChildCall {
  readonly result: Promise<unknown>;
  readonly exited: Promise<void>;
}

/** The global timers, read at call time (a test may replace them after this module loads). */
function globalTimers(): { set: typeof setTimeout; clear: typeof clearTimeout } {
  return { set: setTimeout, clear: clearTimeout };
}

/**
 * Runs `initialize` then one `tools/call` against `child` and resolves with the call's MCP result.
 * On expiry of `budgetMs` the child is killed (SIGTERM, then SIGKILL after a grace period) and the
 * call rejects with `timeoutText`; a child that exits first rejects the call. `exited` settles only
 * when the process has exited, which is what the run lock waits for.
 */
export function callChildTool(
  child: IacChild,
  toolName: string,
  args: Record<string, unknown>,
  budgetMs: number,
  timeoutText: string,
  timers: { set: typeof setTimeout; clear: typeof clearTimeout } = globalTimers(),
  escalateAfterMs: number = ESCALATE_AFTER_MS,
): ChildCall {
  let settled = false;
  let resolveExit: () => void = () => undefined;
  const exited = new Promise<void>((r) => {
    resolveExit = r;
  });
  const waiters = new Map<number, (m: Record<string, unknown>) => void>();
  let failCall: (e: Error) => void = () => undefined;

  child.onLine((line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not JSON-RPC (a stray log line): ignored
    }
    if (typeof msg !== "object" || msg === null) return;
    const rec = msg as Record<string, unknown>;
    const id = rec["id"];
    if (typeof id === "number") waiters.get(id)?.(rec);
  });
  const request = (id: number, method: string, params: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      failCall = reject;
      waiters.set(id, (m) => {
        if (m["error"] !== undefined) reject(new Error("iac: the connector reported an error"));
        else resolve(m);
      });
      child.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let terminating = false;
  const terminate = (): void => {
    if (terminating) return;
    terminating = true;
    child.closeInput();
    child.kill(false);
    escalation = timers.set(() => child.kill(true), escalateAfterMs);
  };
  child.onExit(() => {
    if (escalation !== undefined) timers.clear(escalation);
    if (killTimer !== undefined) timers.clear(killTimer);
    failCall(new Error("iac: the connector exited before it answered"));
    resolveExit();
  });

  const result = new Promise<unknown>((resolve, reject) => {
    killTimer = timers.set(() => {
      if (settled) return;
      settled = true;
      terminate();
      reject(new Error(timeoutText));
    }, budgetMs);
    void (async () => {
      try {
        await request(1, "initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "nimbus-iac-runner", version: "1" },
        });
        child.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
        const reply = await request(2, "tools/call", { name: toolName, arguments: args });
        if (settled) return;
        settled = true;
        resolve(reply["result"]);
      } catch (e) {
        if (settled) return;
        settled = true;
        reject(e instanceof Error ? e : new Error("iac: the call failed"));
      } finally {
        if (killTimer !== undefined) timers.clear(killTimer);
        terminate();
      }
    })();
  });
  return { result, exited };
}

// ---------------------------------------------------------------------------------------------
// The Windows persisted-grants ledger.

/** One profile id and every path its spawn was handed a grant on. */
export interface IacLedgerEntry {
  readonly id: string;
  readonly paths: readonly string[];
}

export interface IacGrantLedger {
  /** The recorded entries. Missing: `[]`. Unreadable or malformed: THROWS (fail closed). */
  load(): readonly IacLedgerEntry[];
  save(entries: readonly IacLedgerEntry[]): void;
}

export function iacGrantLedgerFile(configDir: string): string {
  return join(configDir, "sandbox-grants", "iac-ledger.json");
}

export function fileIacGrantLedger(file: string): IacGrantLedger {
  return {
    load: () => {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch (err) {
        if ((err as { code?: unknown }).code === "ENOENT") return [];
        throw err;
      }
      const parsed: unknown = JSON.parse(raw);
      if (
        !Array.isArray(parsed) ||
        !parsed.every(
          (e) =>
            typeof e === "object" &&
            e !== null &&
            typeof (e as IacLedgerEntry).id === "string" &&
            Array.isArray((e as IacLedgerEntry).paths) &&
            (e as IacLedgerEntry).paths.every((p) => typeof p === "string"),
        )
      ) {
        throw new Error(`the iac grant ledger is malformed: ${file}`);
      }
      return parsed as IacLedgerEntry[];
    },
    save: (entries) => {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
      renameSync(tmp, file);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The runner.

export interface IacRunnerDeps {
  readonly paths: Pick<PlatformPaths, "sandboxDir" | "configDir" | "dataDir">;
  readonly vault: NimbusVault;
  readonly platform: NodeJS.Platform;
  /** The owner's V85 approval, read fresh for every call. */
  readonly grants: () => IacGrants;
  readonly pathDeps: IacPathDeps;
  /** Test seam; production: {@link spawnIacChild}. */
  readonly spawnChild?: IacChildSpawner;
  /** Test seam; production: `Bun.which` then realpath. */
  readonly resolveBinary?: (name: IacBinary) => string | undefined;
  /** The owner's V86 (context, namespace) approvals, read fresh for every call. Absent: nothing approved. */
  readonly k8sGrants?: () => readonly K8sGrant[];
  /** Test seam for the kubeconfig reads; production: {@link nodeKubeFs}. */
  readonly kubeFs?: KubeFs;
  /** The kubeconfig path the Vault holds for the kubernetes connector; production reads the Vault. */
  readonly kubeconfigPath?: () => Promise<string | undefined>;
  /** Windows only. Production: the helper-backed revoker. */
  readonly revokerFor?: (profileId: string) => AppContainerGrantRevoker;
  readonly ledger?: IacGrantLedger;
  readonly randomHex?: (bytes: number) => string;
  /** Test seam for removing a directory tree; production: forced `rmSync` with retries. */
  readonly removeTree?: (p: string) => void;
  readonly timeoutsMs?: Readonly<Record<string, number>>;
  /**
   * How long a plan call waits, after the connector answered, for its process to be gone before it
   * fails closed ({@link EXIT_WAIT_MS} when absent).
   */
  readonly exitWaitMs?: number;
  /** Test seam: the SIGTERM-to-SIGKILL grace for every tool; production: {@link escalationGraceMs}. */
  readonly escalateAfterMs?: number;
  /** `stop()`: how long children get after SIGTERM before SIGKILL (default {@link STOP_GRACE_MS}). */
  readonly stopGraceMs?: number;
  /** `stop()`: how long to wait for children after SIGKILL (default {@link STOP_KILL_WAIT_MS}). */
  readonly stopKillWaitMs?: number;
  /** Test seam: is this process id alive? Production: signal 0. */
  readonly isPidAlive?: (pid: number) => boolean;
  /**
   * Test seam: extra READ paths for every child (never write). A dev tree runs the connector as
   * `bun <gateway source>`, which a sandboxed child cannot read; the integration test hands it the
   * source root. Production leaves it empty: the compiled gateway re-executes itself.
   */
  readonly extraReadPaths?: readonly string[];
}

/** What the registry's `BoundWriteCapabilities` needs of the runner. */
export interface IacHost {
  preflight(rowToolId: string, input: Readonly<Record<string, unknown>>): Promise<PreflightOutcome>;
  /**
   * The bounded `.git` scan, run again after the plan child has exited and before anything is shown
   * to the owner (D2 review 5): a plan child can write a `.git` into its working directory. The fixed
   * refusal reason when the directory is not clean (found, over the caps or unreadable), else
   * `undefined`. It deletes nothing: the owner's directory is left as the child left it.
   */
  recheckGit(workdir: string): string | undefined;
  /** The directories THIS run's plan child writes and the settler reads. */
  terraformRunDirs(
    workdir: string,
  ): { readonly stagingDir: string; readonly approvedRoot: string } | undefined;
  /** The API server `host:port` the owner approved for exactly this (context, namespace), or `undefined`. */
  k8sServerFor?(context: string, namespace: string): string | undefined;
}

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

const TERRAFORM_ROWS: ReadonlySet<string> = new Set([
  "iac_terraform_apply",
  "iac_terraform_destroy",
]);
const CFN_ROW = "iac_cloudformation_deploy";
const HEX32 = /^[0-9a-f]{32}$/;
const PLAN_NAMES: ReadonlySet<string> = new Set(["plan.tfplan", "destroy.tfplan"]);

/** An approved plan directory is read-only (0500): make a tree removable before removing it. */
function makeTreeWritable(p: string): void {
  try {
    chmodSync(p, 0o700);
    for (const e of readdirSync(p, { withFileTypes: true })) {
      if (e.isDirectory()) makeTreeWritable(join(p, e.name));
    }
  } catch {
    // missing or not ours to change: the removal below reports what matters
  }
}

function defaultRemoveTree(p: string): void {
  makeTreeWritable(p);
  rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

export class IacRunner implements IacHost {
  private readonly runs = new Map<string, Run>();
  private readonly kubeRuns = new Map<string, KubeRun>();
  private readonly iacRoot: string;
  private swept = false;
  private realApproved: string | undefined;
  private ledgerTail: Promise<void> = Promise.resolve();
  /** Profile ids whose child THIS process started and has not yet seen exit and release. */
  private readonly runningProfiles = new Set<string>();
  /** Children this process started and has not seen exit; `stop()` kills and waits for them. */
  private readonly liveChildren = new Set<{
    readonly child: IacChild;
    readonly exited: Promise<void>;
  }>();
  private stopped = false;
  /** Children a previous gateway process recorded and that are still alive at boot (see sweep). */
  private orphans: Array<{ pid: number; workdir?: string }> = [];
  /** The live-children record existed but could not be read: no run starts until it can be. */
  private liveRecordUnreadable = false;
  private readonly hex: (bytes: number) => string;
  private readonly removeTree: (p: string) => void;

  constructor(private readonly deps: IacRunnerDeps) {
    this.iacRoot = iacRootFor(deps.paths);
    this.hex = deps.randomHex ?? ((n) => randomBytes(n).toString("hex"));
    this.removeTree = deps.removeTree ?? defaultRemoveTree;
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

  private liveFile(): string {
    return join(this.iacRoot, "live-children.json");
  }

  private pidAlive(pid: number): boolean {
    if (this.deps.isPidAlive !== undefined) return this.deps.isPidAlive(pid);
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as { code?: unknown }).code === "EPERM";
    }
  }

  /** The children recorded as started; `undefined` when the record exists but cannot be read. */
  private readLive(): Array<{ pid: number; workdir?: string }> | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.liveFile(), "utf8");
    } catch (e) {
      return (e as { code?: unknown }).code === "ENOENT" ? [] : undefined;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return undefined;
      const out: Array<{ pid: number; workdir?: string }> = [];
      for (const e of parsed as unknown[]) {
        const rec = e as { pid?: unknown; workdir?: unknown };
        if (typeof rec.pid !== "number" || !Number.isInteger(rec.pid)) return undefined;
        out.push(
          typeof rec.workdir === "string"
            ? { pid: rec.pid, workdir: rec.workdir }
            : { pid: rec.pid },
        );
      }
      return out;
    } catch {
      return undefined;
    }
  }

  private writeLive(entries: ReadonlyArray<{ pid: number; workdir?: string }>): void {
    try {
      mkdirSync(this.iacRoot, { recursive: true, mode: 0o700 });
      // Atomic: a crash mid-write leaves the previous record, never a truncated one.
      const tmp = `${this.liveFile()}.tmp`;
      writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
      renameSync(tmp, this.liveFile());
    } catch {
      // best effort: the record only narrows what a later boot deletes
    }
  }

  // An unreadable record is never overwritten: it is the only evidence of what may still be running.
  private recordLive(pid: number, workdir: string | undefined): void {
    const cur = this.readLive();
    if (cur === undefined) return;
    this.writeLive([
      ...cur.filter((e) => e.pid !== pid),
      workdir === undefined ? { pid } : { pid, workdir },
    ]);
  }

  private forgetLive(pid: number): void {
    const cur = this.readLive();
    if (cur === undefined) return;
    this.writeLive(cur.filter((e) => e.pid !== pid));
  }

  /**
   * Boot sweep, once: nothing a crashed gateway left under the iac root is worth keeping, EXCEPT
   * while a child it recorded may still be alive (a macOS child can outlive the gateway; a Linux
   * child dies with it by `--die-with-parent`, a Windows child by its job object): then the run
   * directories are left for a later boot, and a run on that child's workdir is refused. A record
   * that cannot be read fails closed: it is kept as it is, nothing is deleted, and every run is
   * refused until a later read of it succeeds ({@link liveRecordRefusal}).
   */
  private sweep(): void {
    if (this.swept) return;
    this.swept = true;
    const recorded = this.readLive();
    if (recorded === undefined) {
      this.liveRecordUnreadable = true;
      return;
    }
    const alive = recorded.filter((e) => this.pidAlive(e.pid));
    this.orphans = alive;
    this.writeLive(alive);
    if (alive.length > 0) return;
    for (const d of ["staging", "approved", "scratch", "cwd", "kube"]) {
      try {
        this.removeTree(join(this.iacRoot, d));
      } catch {
        // best effort
      }
    }
  }

  async preflight(
    rowToolId: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<PreflightOutcome> {
    if (this.stopped) return { ok: false, reason: IAC_RUNNER_REFUSALS.stopping };
    this.sweep();
    const unreadable = this.liveRecordRefusal();
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
    this.orphans = this.orphans.filter((o) => this.pidAlive(o.pid));
    for (const o of this.orphans) {
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

  /**
   * While the live-children record is unreadable, re-read it: once it parses, its live children
   * become the orphans a run must not overlap (their directories are still not deleted this boot).
   */
  private liveRecordRefusal(): string | undefined {
    if (!this.liveRecordUnreadable) return undefined;
    const recorded = this.readLive();
    if (recorded === undefined) return IAC_PREFLIGHT_REFUSALS.liveRecordUnreadable;
    this.liveRecordUnreadable = false;
    this.orphans = recorded.filter((e) => this.pidAlive(e.pid));
    this.writeLive(this.orphans);
    return undefined;
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
    return this.runTerraform(toolId, kind, args, budget);
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
    this.sweep();
    const unreadable = this.liveRecordRefusal();
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
    kind: "plan" | "show" | "apply",
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
    if (kind !== "plan") {
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
    kind: "plan" | "show" | "apply",
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
      await this.prepareGrants(manifest.id, paths);
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
      if (prepared) await this.afterExit(manifest.id, paths);
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
    if (pid !== undefined) this.recordLive(pid, opts.workdir);
    // A stop that began while the spawn was in flight could not see this child: kill it now.
    if (this.stopped) {
      child.closeInput();
      child.kill(true);
    }
    const done = call.exited.then(async () => {
      this.liveChildren.delete(live);
      if (pid !== undefined) this.forgetLive(pid);
      await this.afterExit(manifest.id, paths);
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
    // <runId>/<planId>/<plan.tfplan|destroy.tfplan>, and nothing else.
    if (rel.length !== 3 || rel.some((s) => s === "" || s === "..")) return undefined;
    const [runId, planId, name] = rel as [string, string, string];
    if (!HEX32.test(planId) || !/^[0-9a-f]{32}$/.test(runId) || !PLAN_NAMES.has(name))
      return undefined;
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

  /** The granted clouds' credential environment and the credential files the child must read. */
  private async cloudEnv(
    grants: IacGrants,
  ): Promise<{ env: Record<string, string>; files: string[] }> {
    const env: Record<string, string> = {};
    const files: string[] = [];
    if (grants.clouds.includes("aws")) {
      const creds = await loadAwsCreds(this.deps.vault);
      if (creds.ok) Object.assign(env, creds.env);
    }
    if (grants.clouds.includes("azure")) {
      const t = (await readConnectorSecret(this.deps.vault, "azure", "tenant_id"))?.trim() ?? "";
      const c = (await readConnectorSecret(this.deps.vault, "azure", "client_id"))?.trim() ?? "";
      const s =
        (await readConnectorSecret(this.deps.vault, "azure", "client_secret"))?.trim() ?? "";
      if (t !== "" && c !== "" && s !== "") {
        env["ARM_TENANT_ID"] = t;
        env["ARM_CLIENT_ID"] = c;
        env["ARM_CLIENT_SECRET"] = s;
      }
    }
    if (grants.clouds.includes("gcp")) {
      const auth = await loadGcpAuthFromVault(this.deps.vault);
      if (auth?.kind === "key") {
        Object.assign(env, gcloudKeyFileEnv(auth.credPath));
        files.push(auth.credPath);
      }
    }
    return { env, files };
  }

  // ---- Windows grants: revoke what earlier spawns left, record what this one will leave --------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.ledgerTail.then(fn, fn);
    this.ledgerTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private revoker(profileId: string): AppContainerGrantRevoker {
    return (this.deps.revokerFor ?? ((id) => appContainerGrantRevokerFor(this.deps.platform, id)))(
      profileId,
    );
  }

  /**
   * Windows only. The ledger holds ONE entry per profile id. Entries whose child this process is
   * not running (a crash, an earlier boot, a release that failed) are revoked FIRST (an ACE outlives
   * its child; a failure refuses the spawn, fail closed, and the stale entry stays); an entry of a
   * child that is still running is left alone, so a sibling mid-apply keeps its grants. Then this
   * spawn's paths are recorded BEFORE it can be granted anything. The helper's DACL rewrites are
   * serialised behind this one chain.
   */
  private prepareGrants(profileId: string, paths: readonly string[]): Promise<void> {
    if (!this.revoker(profileId).active) return Promise.resolve();
    const ledger =
      this.deps.ledger ?? fileIacGrantLedger(iacGrantLedgerFile(this.deps.paths.configDir));
    return this.serial(async () => {
      const entries = ledger.load();
      const keep: IacLedgerEntry[] = [];
      for (const e of entries) {
        if (this.runningProfiles.has(e.id)) {
          keep.push(e);
          continue;
        }
        await this.revoker(e.id).revoke(e.paths); // ACL revocations run one at a time, in ledger order, under the serial lock
      }
      ledger.save([...keep, { id: profileId, paths }]);
      this.runningProfiles.add(profileId);
    });
  }

  /** After the child is gone: release this profile's ACEs and drop its ledger entry on success. */
  private afterExit(profileId: string, paths: readonly string[]): Promise<void> {
    const revoker = this.revoker(profileId);
    if (!revoker.active) return Promise.resolve();
    const ledger =
      this.deps.ledger ?? fileIacGrantLedger(iacGrantLedgerFile(this.deps.paths.configDir));
    return this.serial(async () => {
      // The child is gone whether or not the release below succeeds: a kept entry is retried by the
      // next spawn, which treats any entry it is not running as stale.
      this.runningProfiles.delete(profileId);
      try {
        await revoker.revoke(paths);
        ledger.save(ledger.load().filter((e) => e.id !== profileId));
      } catch {
        // The entry stays; the next spawn revokes it first (fail closed there).
      }
    });
  }
}

const OUR_CHANGE_SET_ARN =
  /^arn:aws[a-z-]*:cloudformation:([a-z0-9-]+):\d{12}:changeSet\/nimbus-[0-9a-f]{64}-[0-9a-f]{12}\/[0-9a-f-]{36}$/;

/**
 * A discard may only name a change set this gateway could have created: a plain stack name, an ARN
 * whose name has the `nimbus-<template sha256>-<12 hex>` form the prepare step gives, in the region
 * this run's credential uses. Anything else (another region, someone else's change set) never
 * reaches a child, whoever asked.
 */
function isOurChangeSet(args: Record<string, unknown>, region: string): boolean {
  const id = args["changeSetId"];
  if (region === "" || !isPlainStackName(args["stackName"]) || typeof id !== "string") return false;
  return OUR_CHANGE_SET_ARN.exec(id)?.[1] === region;
}

/**
 * The folders no approved Terraform directory may overlap (is, contain or sit inside): Nimbus's data,
 * config and sandbox directories, the extensions directory, the WHOLE cache root the sandbox and the
 * iac root live under, the temp directory Nimbus uses (`$TMP/nimbus`), the iac root itself and, on
 * Linux, the runtime directory (`XDG_RUNTIME_DIR`, which holds the gateway's socket).
 */
export function iacProtectedRootsFor(
  paths: Pick<PlatformPaths, "dataDir" | "configDir" | "sandboxDir" | "extensionsDir" | "tempDir">,
  platform: NodeJS.Platform,
  runtimeDir: string | undefined,
): readonly string[] {
  return [
    paths.dataDir,
    paths.configDir,
    paths.sandboxDir,
    paths.extensionsDir,
    paths.tempDir,
    dirname(paths.sandboxDir),
    iacRootFor(paths),
    ...(platform === "linux" && runtimeDir !== undefined && runtimeDir !== "" ? [runtimeDir] : []),
  ];
}

/** `<cache>/iac-runs`, a sibling of the sandbox root: never `dataDir` (the filesystem MCP writes there). */
export function iacRootFor(paths: Pick<PlatformPaths, "sandboxDir">): string {
  return join(dirname(paths.sandboxDir), "iac-runs");
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
