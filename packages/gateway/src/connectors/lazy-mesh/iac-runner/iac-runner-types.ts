// packages/gateway/src/connectors/lazy-mesh/iac-runner/iac-runner-types.ts
// The runner's dependency record and the host surface the registry needs of it (invariants I15,
// I54; static D43(d)). Types only; split out of `iac-runner.ts` with no behaviour change.
import type { PreflightOutcome } from "../../../engine/bound-write-capabilities.ts";
import type { PlatformPaths } from "../../../platform/paths.ts";
import type { AppContainerGrantRevoker } from "../../../platform/sandbox/win32-grant-revoke.ts";
import type { NimbusVault } from "../../../vault/nimbus-vault.ts";
import type { IacGrants, IacPathDeps } from "../../connector-writes/iac-grants.ts";
import type { K8sGrant } from "../../connector-writes/k8s-grants.ts";
import type { KubeFs } from "../../connector-writes/kubeconfig-facts.ts";
import type { IacChildSpawner } from "./iac-child.ts";
import type { IacGrantLedger } from "./iac-grant-ledger.ts";
import type { IacBinary } from "./iac-install-reads.ts";

export interface IacRunnerDeps {
  readonly paths: Pick<PlatformPaths, "sandboxDir" | "configDir" | "dataDir">;
  readonly vault: NimbusVault;
  readonly platform: NodeJS.Platform;
  /** The owner's V85 approval, read fresh for every call. */
  readonly grants: () => IacGrants;
  readonly pathDeps: IacPathDeps;
  /** Test seam; production: `spawnIacChild`. */
  readonly spawnChild?: IacChildSpawner;
  /** Test seam; production: `Bun.which` then realpath. */
  readonly resolveBinary?: (name: IacBinary) => string | undefined;
  /** The owner's V86 (context, namespace) approvals, read fresh for every call. Absent: nothing approved. */
  readonly k8sGrants?: () => readonly K8sGrant[];
  /** Test seam for the kubeconfig reads; production: `nodeKubeFs`. */
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
   * fails closed (`EXIT_WAIT_MS` when absent).
   */
  readonly exitWaitMs?: number;
  /** Test seam: the SIGTERM-to-SIGKILL grace for every tool; production: `escalationGraceMs`. */
  readonly escalateAfterMs?: number;
  /** `stop()`: how long children get after SIGTERM before SIGKILL (default `STOP_GRACE_MS`). */
  readonly stopGraceMs?: number;
  /** `stop()`: how long to wait for children after SIGKILL (default `STOP_KILL_WAIT_MS`). */
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
