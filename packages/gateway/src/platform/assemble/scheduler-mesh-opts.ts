/**
 * DECLARATION-ONLY. Do not add runtime logic to this file.
 *
 * It is coverage-exempt by exact path (`scripts/coverage-floor/exclusions.ts`) because a file with
 * no executable statement emits no lcov record, reads as 0%, and can never rejoin the floor. The
 * moment a function or constant lands here that exemption becomes a hole rather than an accounting
 * fact: put such code in `scheduler-mesh.ts`, which is gated normally.
 */
import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import type { WatcherChatNotifier } from "../../automation/watcher-chat-notifier.ts";
import type { LazyConnectorMesh } from "../../connectors/lazy-mesh/index.ts";
import type { DecisionLlm } from "../../decisions/decision-llm-adapter.ts";
import type { DecisionRefresher } from "../../decisions/decision-refresh.ts";
import type { ContinuityEntry } from "../../extensions/continuity/continuity-table.ts";
import type { ConsolidatorLlm } from "../../glossary/glossary-consolidate.ts";
import type { GlossaryRefresher } from "../../glossary/glossary-refresh.ts";
import type { IncidentEngine } from "../../incident/incident-engine.ts";
import type { LocalIndex } from "../../index/local-index.ts";
import type { OncallPushRuntime } from "../../oncall-push/push-runtime.ts";
import type { OwnershipRefresher } from "../../ownership/ownership-refresh.ts";
import type { PremortemRefresher } from "../../premortem/premortem-refresh.ts";
import type { SyncScheduler } from "../../sync/scheduler.ts";
import type { SyncRuntimeContext } from "../../sync/types.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { PlatformPaths } from "../paths.ts";
import type { SandboxPolicy } from "../sandbox/sandbox-policy.ts";
import type { NotificationService } from "../types.ts";

export interface SchedulerWithMeshOpts {
  paths: PlatformPaths;
  vault: NimbusVault;
  db: Database;
  syncContext: SyncRuntimeContext;
  localIndex: LocalIndex;
  notifications: NotificationService;
  syncLogger: Logger;
  isConnectorAllowed: (serviceId: string) => boolean;
  /**
   * Local-only consolidation model for the glossary pass. Optional so tests and
   * degraded boots keep the snippet path. Gated below on `[glossary].use_llm`.
   */
  glossaryLlm?: ConsolidatorLlm;
  /**
   * Local-only extraction model for the decisions pass. Optional so tests and
   * degraded boots keep the snippet path. Gated below on `[decisions].use_llm`.
   */
  decisionLlm?: DecisionLlm;
  /** Settles when the boot-time Windows data-directory revoke is done; gates the filesystem MCP’s first spawn. */
  filesystemSpawnGate?: Promise<void>;
  /**
   * The sandbox runner's answer for a user MCP write-directory policy (I15, AD5b). Absent, a user
   * MCP server with a write directory is never spawned.
   */
  userMcpCanConfine?: (policy: SandboxPolicy) => string | null;
  /**
   * `isExtensionRuntimeEnabled` (`[extensions] runtime` AND not demo-rooted, I41). When false the
   * mesh gets no extension slot source at all, so no approved extension can spawn.
   */
  extensionRuntimeEnabled: boolean;
  /** Settles once the boot-time extension verification pass has finished (or thrown). */
  extensionSpawnGate: Promise<void>;
  /**
   * The continuity table the spawn verifier binds a legacy connector id through — the SAME value
   * the migration engine, the sync registrar and the credential resolver get (ruling B1).
   */
  continuityTable: readonly ContinuityEntry[];
  /** `<dataDir>/extension-observations`, created at boot by `startExtensionObservation`. */
  extensionObservationDir: string;
}

/** What `createSchedulerWithMesh` returns. */
export interface SchedulerWithMesh {
  syncScheduler: SyncScheduler;
  connectorMesh: LazyConnectorMesh;
  glossaryRefresher: GlossaryRefresher;
  decisionsRefresher: DecisionRefresher | undefined;
  ownershipRefresher: OwnershipRefresher | undefined;
  premortemRefresher: PremortemRefresher | undefined;
  oncallPush: OncallPushRuntime;
  /** The incident engine (Phase 10 IC3); the sync hook triggers it ahead of the on-call push. */
  incidentEngine: IncidentEngine;
  /**
   * The ChatOps watcher notice (I23, I29), or `undefined` when `[watcher.chatops]` is off or this is
   * a demo gateway. It holds fires until `settleWatcherChatops` binds the poster after ChatOps boots.
   */
  watcherChat: WatcherChatNotifier | undefined;
  /**
   * The owner's pinned watcher-notice channel (I23 amendment) from the boot-time
   * `[watcher.chatops].channel`: set only when the notifier exists (so never in a demo) and the
   * destination resolved to `pinned`. Handed to the ChatOps boot at construction and nowhere else.
   */
  watcherPinnedChannel: string | undefined;
  /** The I22 policy-filtered `register`, for the extension sync host built after the boot gate. */
  policyFilteredRegistrar: Pick<SyncScheduler, "register">;
}
