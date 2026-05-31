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
  | "paused";

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
  degradationReason?: string;
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
  readonly hitlStatus: "approved" | "rejected" | "not_required";
  readonly actionJson: string;
  readonly timestamp: number;
}

export interface HitlRequest {
  requestId: string;
  prompt: string;
  details?: Record<string, unknown>;
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
  readonly hitlStatus: "approved" | "rejected" | "not_required";
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

export interface UpdaterStatus {
  readonly state: UpdaterStateName;
  readonly currentVersion: string;
  readonly configUrl: string;
  readonly lastCheckAt?: string;
  readonly lastError?: string;
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
