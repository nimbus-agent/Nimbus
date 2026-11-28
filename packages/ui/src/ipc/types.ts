export type ConnectionState = "initializing" | "connecting" | "connected" | "disconnected";

export interface DiagSnapshot {
  readonly indexTotalItems: number;
  readonly connectorCount: number;
}

export type ConnectorHealth =
  | "healthy"
  | "degraded"
  | "error"
  | "rate_limited"
  | "unauthenticated"
  | "paused"
  | "not_configured";

export interface ConnectorSummary {
  readonly name: string;
  readonly state: ConnectorHealth;
}

export interface JsonRpcNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface JsonRpcErrorPayload {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export class MethodNotAllowedError extends Error {
  constructor(public readonly method: string) {
    super(`ERR_METHOD_NOT_ALLOWED: ${method}`);
    this.name = "MethodNotAllowedError";
  }
}

export class GatewayOfflineError extends Error {
  constructor(message = "Gateway is not connected") {
    super(message);
    this.name = "GatewayOfflineError";
  }
}

export class JsonRpcError extends Error {
  constructor(public readonly payload: JsonRpcErrorPayload) {
    super(payload.message);
    this.name = "JsonRpcError";
  }
}

export type ConnectorStatus = {
  name: string;
  health: ConnectorHealth;
  lastSyncAt?: string;
  // `| undefined`, not just `?:` — `ConnectorGrid`'s `onHealth` needs to explicitly CLEAR a stale
  // reason on a `degraded -> healthy` recovery, which under `exactOptionalPropertyTypes` requires
  // the property's own type to admit `undefined`, not merely allow omission.
  degradationReason?: string | undefined;
  lastError?: string;
  itemCount?: number;
  intervalMs?: number;
  depth?: "metadata_only" | "summary" | "full";
  enabled?: boolean;
};

export interface IndexMetrics {
  itemsTotal: number;
  embeddingCoveragePct: number;
  queryP95Ms: number;
  indexSizeBytes: number;
}

export interface AuditEntry {
  readonly id: number;
  readonly actionType: string;
  readonly hitlStatus: "approved" | "rejected" | "not_required" | "standing_approved";
  readonly actionJson: string;
  readonly timestamp: number;
}

export interface HitlRequest {
  requestId: string;
  prompt: string;
  details?: Record<string, unknown>;
  /** The gateway HITL action type (data.delete, extension.migrate, ...). Absent from an older gateway. */
  actionType?: string;
  /** Wave 4 connector write: the exact text the owner must type to approve. Absent otherwise. */
  confirmText?: string;
  receivedAtMs: number;
}

export interface ProfileSummary {
  readonly name: string;
  readonly lastSwitchedAt?: string;
}

export interface ProfileListResult {
  readonly profiles: ReadonlyArray<ProfileSummary>;
  readonly active: string | null;
}

export interface TelemetryStatusDisabled {
  readonly enabled: false;
}

export interface TelemetryPreviewPayload {
  readonly session_id: string;
  readonly nimbus_version: string;
  readonly platform: "win32" | "darwin" | "linux";
  readonly connector_error_rate: Readonly<Record<string, number>>;
  readonly connector_health_transitions: Readonly<Record<string, number>>;
  readonly query_latency_p50_ms: number;
  readonly query_latency_p95_ms: number;
  readonly query_latency_p99_ms: number;
  readonly agent_invocation_latency_p50_ms: number;
  readonly agent_invocation_latency_p95_ms: number;
  readonly sync_duration_p50_ms: Readonly<Record<string, number>>;
  readonly cold_start_ms: number;
  readonly extension_installs_by_id: Readonly<Record<string, number>>;
  readonly extension_uninstalls_by_id: Readonly<Record<string, number>>;
}

export interface TelemetryStatusEnabled extends TelemetryPreviewPayload {
  readonly enabled: true;
}

export type TelemetryStatus = TelemetryStatusDisabled | TelemetryStatusEnabled;

export interface RouterDecision {
  readonly providerId: "ollama" | "llamacpp" | "remote";
  readonly modelName: string;
  readonly reason: string;
}

export type LlmTaskType = "classification" | "reasoning" | "summarisation" | "agent_step";

export interface RouterStatusResult {
  readonly decisions: Readonly<Partial<Record<LlmTaskType, RouterDecision | undefined>>>;
}

export interface LlmModelInfo {
  readonly provider: "ollama" | "llamacpp" | "remote";
  readonly modelName: string;
  readonly parameterCount?: number;
  readonly contextWindow?: number;
  readonly quantization?: string;
  readonly vramEstimateMb?: number;
}

export interface LlmListModelsResult {
  readonly models: ReadonlyArray<LlmModelInfo>;
}

export interface LlmAvailabilityResult {
  readonly available: Readonly<Record<string, boolean>>;
}

export interface LlmPullStartedResult {
  readonly pullId: string;
}

export interface LlmPullProgressPayload {
  readonly pullId: string;
  readonly provider: "ollama" | "llamacpp";
  readonly modelName: string;
  readonly status: string;
  readonly completedBytes?: number;
  readonly totalBytes?: number;
}

export interface LlmPullTerminalPayload {
  readonly pullId: string;
  readonly provider: "ollama" | "llamacpp";
  readonly modelName: string;
  readonly error?: string;
}

export interface LlmModelLoadPayload {
  readonly provider: "ollama" | "llamacpp";
  readonly modelName: string;
}

export interface ConnectorConfigPatch {
  readonly intervalMs?: number;
  readonly depth?: "metadata_only" | "summary" | "full";
  readonly enabled?: boolean;
}

export interface ConnectorConfigChangedPayload {
  readonly service: string;
  readonly intervalMs: number;
  readonly depth: "metadata_only" | "summary" | "full";
  readonly enabled: boolean;
}

export interface AuditSummary {
  readonly byOutcome: Readonly<Record<string, number>>;
  readonly byService: Readonly<Record<string, number>>;
  readonly total: number;
}

export interface AuditVerifyOk {
  readonly ok: true;
  readonly lastVerifiedId: number;
  readonly totalChecked: number;
}

export interface AuditVerifyBroken {
  readonly ok: false;
  readonly brokenAtId: number;
  readonly expectedHash: string;
  readonly actualHash: string;
}

export type AuditVerifyResult = AuditVerifyOk | AuditVerifyBroken;

export interface AuditExportRow {
  readonly id: number;
  readonly actionType: string;
  readonly hitlStatus: "approved" | "rejected" | "not_required" | "standing_approved";
  readonly actionJson: string;
  readonly timestamp: number;
  readonly rowHash: string;
  readonly prevHash: string;
}

export type UpdaterStateName =
  | "idle"
  | "checking"
  | "downloading"
  | "verifying"
  | "applying"
  | "rolled_back"
  | "failed";

/** Mirrors the gateway's cached result of its last SUCCESSFUL `updater.checkNow`. */
export interface UpdaterLastCheck {
  readonly latestVersion: string;
  readonly updateAvailable: boolean;
  readonly notes?: string;
  readonly checkedAt: string;
}

export interface UpdaterStatus {
  readonly state: UpdaterStateName;
  readonly currentVersion: string;
  readonly configUrl: string;
  readonly lastCheckAt?: string;
  readonly lastError?: string;
  readonly lastCheck?: UpdaterLastCheck;
}

export interface UpdaterCheckResult {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly updateAvailable: boolean;
  readonly notes?: string;
}

export interface UpdaterApplyStarted {
  readonly jobId: string;
}

export interface UpdaterRollbackResult {
  readonly ok: true;
}

export interface UpdaterUpdateAvailablePayload {
  readonly version: string;
  readonly notes?: string;
}

export interface UpdaterDownloadProgressPayload {
  readonly receivedBytes: number;
  readonly totalBytes?: number;
}

export interface UpdaterRestartingPayload {
  readonly fromVersion: string;
  readonly toVersion: string;
}

export interface UpdaterRolledBackPayload {
  readonly reason: "download_failed" | "hash_mismatch" | "signature_invalid" | "installer_failed";
}

export interface UpdaterVerifyFailedPayload {
  readonly reason: "hash_mismatch" | "signature_invalid";
}

export interface DiagVersionResult {
  readonly version: string;
}

export interface ExportPreflightResult {
  readonly lastExportAt: number | null;
  readonly estimatedSizeBytes: number;
  readonly itemCount: number;
}

export interface DeletePreflightResult {
  readonly service: string;
  readonly itemCount: number;
  readonly embeddingCount: number;
  readonly vaultKeyCount: number;
}

export interface DataExportResult {
  readonly outputPath: string;
  readonly recoverySeed: string;
  readonly recoverySeedGenerated: boolean;
  readonly itemsExported: number;
}

export interface DataImportResult {
  readonly credentialsRestored: number;
  readonly oauthEntriesFlagged: number;
}

export interface DataDeletePreflight {
  readonly service: string;
  readonly itemsToDelete: number;
  readonly itemHistoryRowsToDelete?: number;
  readonly vecRowsToDelete: number;
  readonly syncTokensToDelete: number;
  readonly vaultEntriesToDelete: number;
  readonly vaultKeys: readonly string[];
  readonly peopleUnlinked: number;
}

export interface DataDeleteResult {
  readonly preflight: DataDeletePreflight;
  readonly deleted: boolean;
}

export interface DataExportProgressPayload {
  readonly stage: string;
  readonly bytesWritten: number;
  readonly totalBytes?: number;
}

export interface DataImportProgressPayload {
  readonly stage: string;
  readonly bytesRead: number;
  readonly totalBytes?: number;
}

export interface DataImportCompletedPayload {
  readonly credentialsRestored: number;
}

export interface DataImportVersionIncompatibleData {
  readonly kind: "version_incompatible";
  readonly archiveSchemaVersion: number;
  readonly currentSchemaVersion: number;
  readonly relation: "archive_newer" | "archive_older_unsupported";
}

export type GraphRelationKind = "owned_by" | "upstream_of" | "downstream_of";

export interface CandidateRelation {
  readonly relation: GraphRelationKind;
  readonly description: string;
  readonly underlyingRelationTypes: readonly string[];
}

export interface WatcherCandidateRelationsResult {
  readonly relations: ReadonlyArray<CandidateRelation>;
}

export interface WatcherValidateConditionResult {
  readonly matchCount: number;
}

export interface WatcherSummary {
  readonly id: string;
  readonly name: string;
  readonly enabled: number;
  readonly condition_type: string;
  readonly condition_json: string;
  readonly action_type: string;
  readonly action_json: string;
  readonly created_at: number;
  readonly last_checked_at: number | null;
  readonly last_fired_at: number | null;
  readonly graph_predicate_json: string | null;
}

export interface WatcherListResult {
  readonly watchers: ReadonlyArray<WatcherSummary>;
}

export interface WatcherHistoryEntry {
  readonly firedAt: number;
  readonly conditionSnapshot: string;
  readonly actionResult: string;
}

export interface WatcherListHistoryResult {
  readonly events: ReadonlyArray<WatcherHistoryEntry>;
}

export interface WatcherCreateParams {
  readonly name: string;
  readonly conditionType: string;
  readonly conditionJson: string;
  readonly actionType: string;
  readonly actionJson: string;
  readonly graphPredicateJson?: string;
}

export interface WatcherCreateResult {
  readonly id: string;
}

export interface ExtensionSummary {
  readonly id: string;
  readonly version: string;
  readonly enabled: number;
  readonly installPath: string;
  readonly manifestHash: string;
  /** Present (true) when the extension is installed only as a dependency that nothing needs now. */
  readonly orphaned?: true;
}

export interface ExtensionListResult {
  readonly extensions: ReadonlyArray<ExtensionSummary>;
}

export interface ExtensionInstallResult {
  readonly id: string;
  readonly version: string;
  readonly installPath: string;
  readonly manifestHash: string;
  readonly entryHash: string;
}

export interface WorkflowSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly steps_json: string;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface WorkflowListResult {
  readonly workflows: ReadonlyArray<WorkflowSummary>;
}

export interface WorkflowRunHistoryEntry {
  readonly id: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly durationMs: number | null;
  readonly status: string;
  readonly errorMsg: string | null;
  readonly dryRun: boolean;
  readonly paramsOverrideJson: string | null;
  readonly triggeredBy: string;
}

export interface WorkflowListRunsResult {
  readonly runs: ReadonlyArray<WorkflowRunHistoryEntry>;
}

export interface WorkflowRunParams {
  readonly name: string;
  readonly dryRun: boolean;
  readonly paramsOverride?: Readonly<Record<string, Record<string, unknown>>>;
}

export interface WorkflowSaveResult {
  readonly id: string;
}

export interface WorkflowRunResult {
  readonly ok: boolean;
  readonly dryRun: boolean;
}

export interface PushedBriefSummary {
  readonly incidentId: string;
  readonly status: "ok" | "failed";
  readonly createdAt: number;
  readonly retriedAt: number | null;
  readonly title: string | null;
  readonly service: string | null;
}

export interface PushSinkOutcome {
  readonly outcome: string;
  readonly reason?: string;
  readonly at: number;
}

export interface PushedBriefDetail extends PushedBriefSummary {
  readonly briefMarkdown: string | null;
  readonly failureCode: string | null;
  readonly delivery: Readonly<Record<string, PushSinkOutcome>>;
  /** The proposal the push carried (IC5b), run only by `nimbus oncall pushed <id> --remediate`, never here; absent from an older gateway. */
  readonly proposal?: PushedBriefProposal | null;
}

export interface PushedBriefProposal {
  readonly recordId: string;
  readonly proposalId: string;
  readonly kind: string;
  readonly toolId: string;
  readonly reversibility: "reversible" | "irreversible" | "unknown";
  readonly confidence: number | null;
  readonly expiresAtMs: number;
}

export interface PushedBriefList {
  readonly enabled: boolean;
  readonly identity: "resolved" | "unresolved";
  readonly briefs: readonly PushedBriefSummary[];
  /** Whether pushed briefs can post to ChatOps. Optional: a gateway before this field omits it. */
  readonly chatops?: { readonly namespace: string | null; readonly posting: boolean };
}

export interface PushedBriefGet {
  readonly brief: PushedBriefDetail | null;
}

/** Wire shapes of `captures.list` / `captures.get` (gateway `mcp-sink/capture-gate.ts`). */
export type CaptureKind = "note" | "decision" | "term" | "link" | "action";

export type CaptureState =
  | "live"
  | "proposed"
  | "accepted"
  | "rejected"
  | "revoked"
  | "executing"
  | "executed"
  | "failed"
  | "expired";

export interface CaptureSummary {
  readonly id: string;
  readonly kind: CaptureKind;
  readonly state: CaptureState;
  readonly title: string;
  readonly clientLabel: string | null;
  readonly createdAt: number;
  readonly decidedAt: number | null;
  readonly expiresAt: number | null;
}

export interface CaptureDetail extends CaptureSummary {
  /** Agent-authored; `null` once a capture is revoked or a finished action's input is purged. */
  readonly payload: unknown;
  readonly payloadBytes: number;
  readonly itemId: string | null;
  readonly nativeRef: string | null;
  readonly nativeStatus: "owned" | "superseded" | "absent" | null;
  readonly outcomeRef: string | null;
  readonly errorCode: string | null;
}

export interface CaptureList {
  readonly captures: readonly CaptureSummary[];
}

export type CatalogParamKind = "string" | "number" | "boolean" | "stringArray";

export interface CatalogParam {
  readonly name: string;
  readonly kind: CatalogParamKind;
  readonly label: string;
  readonly required: boolean;
  readonly oneOf?: {
    readonly group: string;
    readonly arm: string;
    readonly required: boolean;
    readonly armRequired: boolean;
  };
}

export interface CatalogAgent {
  readonly name: string;
  readonly method: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: "catch-up" | "code" | "knowledge" | "operations" | "people";
  readonly roles: readonly string[];
  readonly params: readonly CatalogParam[];
  readonly surfaces: { readonly external: boolean; readonly fleet: boolean };
  readonly visible: boolean;
}

export interface CatalogListResult {
  readonly agents: readonly CatalogAgent[];
  readonly connectors: readonly unknown[];
  readonly visibility: {
    readonly basis: "all" | "packs";
    readonly packs: readonly string[];
    readonly notes: readonly string[];
  };
}

export interface PackListResult {
  readonly profile: string;
  readonly installed: readonly {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly source: "bundled" | "file";
    readonly updateAvailable: boolean;
    /** Optional: an older gateway omits it. */
    readonly visibleAgents?: readonly string[];
    /** Optional: an older gateway omits it. */
    readonly sourceMappings?: readonly { readonly serviceType: string; readonly kind: string }[];
    /** Optional: an older gateway omits it. */
    readonly roles?: readonly string[];
    /** Optional: an older gateway omits it. */
    readonly suggestedConnectors?: readonly string[];
  }[];
  readonly available: readonly unknown[];
  readonly skipped: readonly { readonly packId: string; readonly reason: string }[];
  readonly listError?: string;
}

export interface FleetBriefRow {
  readonly id: string;
  readonly runId: string;
  readonly jobId: string;
  readonly subjectKey: string;
  readonly agentMethod: string;
  readonly briefMarkdown: string | null;
  readonly createdAt: number;
}

export interface FleetBriefsResult {
  readonly briefs: readonly FleetBriefRow[];
}

export interface FleetShowResult {
  readonly brief: FleetBriefRow | null;
}

/** Wire shapes of `incident.list` / `incident.get` / `incident.timeline` (gateway `ipc/incident-rpc.ts`). Read-only. */
export interface IncidentSummary {
  readonly id: string;
  readonly triggerItemId: string;
  readonly triggerService: string;
  readonly service: string | null;
  readonly title: string;
  readonly severity: string | null;
  readonly status: string;
  readonly openedAtMs: number | null;
  readonly version: number;
  readonly assembledAtMs: number;
  readonly checkedAtMs: number;
}

export interface IncidentCascadeGroup {
  readonly root: string;
  readonly members: ReadonlyArray<{
    readonly recordId: string;
    readonly role?: string;
    readonly title?: string;
    readonly service?: string | null;
  }>;
}

export interface IncidentListResult {
  readonly status: "ok" | "none" | "no_data";
  readonly records: readonly IncidentSummary[];
  readonly sources: ReadonlyArray<{
    readonly service: string;
    readonly connected: boolean;
    readonly lastSyncMs: number | null;
  }>;
  /** Present with `cascade: true`; `null` when the open records could not be read. */
  readonly groups?: readonly IncidentCascadeGroup[] | null;
}

export type IncidentCascade =
  | {
      readonly status: "ok";
      readonly role: string;
      readonly rootRecordId: string;
      readonly truncated: boolean;
      readonly markdown: string;
    }
  | { readonly status: "unavailable" };

export interface IncidentGetResult {
  readonly record: {
    readonly summary: IncidentSummary;
    readonly markdown: string;
    readonly versions: ReadonlyArray<{
      readonly version: number;
      readonly assembledAtMs: number;
      readonly sha256: string;
    }>;
    readonly triggerStillIndexed: boolean;
    /** `null`: the record is in no open group. */
    readonly cascade: IncidentCascade | null;
  } | null;
  readonly reason?: string;
}

export interface IncidentTimelineEvent {
  readonly atMs: number;
  readonly atBasis: "source" | "observed";
  readonly kind: string;
  readonly source: string;
  readonly itemId: string | null;
  readonly text: string;
  readonly rule: string | null;
}

export interface IncidentTimelineResult {
  readonly recordId: string;
  readonly version: number;
  readonly currentVersion: number;
  readonly events: readonly IncidentTimelineEvent[];
  readonly notes: readonly string[];
}

/** Wire shape of `incident.proposals` (gateway `incident/remediation.ts` `ProposalsResult`, IC5a). Read-only. */
export interface IncidentProposal {
  readonly id: string;
  readonly kind: string;
  readonly toolId: string;
  readonly input: unknown;
  readonly evidence: {
    readonly rule: string;
    readonly items: readonly string[];
    readonly blast: {
      readonly service: string | null;
      readonly environment: string | null;
      readonly dependents: readonly string[];
      readonly dependentsTruncated: boolean;
    };
    readonly confidence: {
      readonly terms: ReadonlyArray<{
        readonly name: string;
        readonly weight: number;
        readonly met: boolean;
      }>;
      readonly total: number;
    } | null;
    readonly dryRun: string;
    readonly target: string;
  } | null;
  readonly confidence: number | null;
  readonly reversibility: string;
  /** The condition a conditionally reversible row's undo rests on (the Unleash toggle); absent otherwise. */
  readonly reversibleIf?: string;
  readonly irreversibleReason: string | null;
  readonly status: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly actionId: string | null;
  readonly undoStatus: string | null;
  readonly undoable: boolean;
}

export interface IncidentProposalsResult {
  readonly recordId: string;
  readonly version: number;
  readonly advisory: boolean;
  readonly proposals: readonly IncidentProposal[];
  readonly unavailable: ReadonlyArray<{
    readonly kind: string;
    readonly code: string;
    readonly reason: string;
    readonly app?: string;
  }>;
}

/** Wire shape of `incident.findings` (gateway `ipc/incident-rpc.ts`, IC8). Read-only. */
export interface IncidentFinding {
  readonly id: string;
  readonly kind: string;
  readonly key: string;
  readonly service: string | null;
  readonly detail: unknown;
  readonly openedAtMs: number;
  readonly lastSeenAtMs: number;
  readonly clearedAtMs: number | null;
}

export interface IncidentFindingsResult {
  readonly findings: readonly IncidentFinding[];
}

/** S4 marketplace tile: `registry.list` (the owner's added registries; the database only). */
export interface RegistryListEntry {
  readonly name: string;
  readonly url: string;
  readonly rootFingerprint: string;
  readonly stale?: boolean;
}

export interface RegistryListResult {
  readonly registries: ReadonlyArray<RegistryListEntry>;
}

export interface RegistryQuality {
  readonly score: number;
  readonly cases: number;
  readonly passed: number;
}

export interface RegistryVerifiedPublisher {
  readonly github: string;
  readonly verifiedAt: string;
}

/** One `registry.search` hit (the offered version: newest stable, else beta, else newest). */
export interface RegistrySearchHit {
  readonly registry: string;
  readonly id: string;
  readonly name: string;
  readonly publisherId: string;
  readonly latestStable: string | null;
  readonly latestBeta: string | null;
  readonly blocked: boolean;
  readonly verifiedPublisher: RegistryVerifiedPublisher | null;
  readonly quality: RegistryQuality | null;
}

export interface RegistrySearchResult {
  readonly results: ReadonlyArray<RegistrySearchHit>;
  readonly errors: ReadonlyArray<{ readonly registry: string; readonly error: string }>;
  /** Present only with `includeBuiltin`: air gap kept the built-in official registry out. */
  readonly builtinSkippedForAirGap?: boolean;
}

/** Each evidence line carries its rendered `text`; the page shows it verbatim. */
export interface RegistryEvidenceLine {
  readonly text: string;
}

export interface RegistryAccess {
  readonly networkReach: string;
  readonly fileAccess: string;
  readonly canRunHere: boolean | null;
}

export interface RegistryInfoVersion {
  readonly version: string;
  readonly channel: string;
  readonly publishedAt: string;
  readonly packageSizeBytes: number;
  readonly blocked: boolean;
  readonly quality: RegistryQuality | null;
  readonly permissions?: {
    readonly network: ReadonlyArray<string>;
    readonly filesystem: {
      readonly read: ReadonlyArray<string>;
      readonly write: ReadonlyArray<string>;
    };
  };
  readonly access?: RegistryAccess;
}

export interface RegistryInfoResult {
  readonly registry: string;
  readonly id: string;
  readonly publisherId: string;
  readonly publisherFingerprint: string;
  readonly provenance: {
    readonly sourceRepository: string;
    readonly commit: string;
    readonly workflow: string;
  } | null;
  readonly license: string | null;
  readonly funding: ReadonlyArray<{ readonly url: string; readonly label?: string }> | null;
  readonly evidence: {
    readonly baseline: RegistryEvidenceLine;
    readonly tested: RegistryEvidenceLine;
    readonly history: RegistryEvidenceLine;
    readonly checked: RegistryEvidenceLine;
  };
  readonly evidenceFor: { readonly version: string; readonly channel: string };
  readonly verifiedPublisher: RegistryVerifiedPublisher | null;
  readonly versions: ReadonlyArray<RegistryInfoVersion>;
}
