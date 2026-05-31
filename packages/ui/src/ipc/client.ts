import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  type AuditEntry,
  type AuditExportRow,
  type AuditSummary,
  type AuditVerifyResult,
  type ConnectionState,
  type ConnectorConfigPatch,
  type ConnectorStatus,
  type DataDeleteResult,
  type DataExportResult,
  type DataImportResult,
  type DeletePreflightResult,
  type DiagVersionResult,
  type ExportPreflightResult,
  type ExtensionInstallResult,
  type ExtensionListResult,
  GatewayOfflineError,
  type IndexMetrics,
  JsonRpcError,
  type JsonRpcErrorPayload,
  type JsonRpcNotification,
  type LlmAvailabilityResult,
  type LlmListModelsResult,
  type LlmPullStartedResult,
  type LlmTaskType,
  MethodNotAllowedError,
  type ProfileListResult,
  type RouterStatusResult,
  type TelemetryStatus,
  type UpdaterApplyStarted,
  type UpdaterCheckResult,
  type UpdaterRollbackResult,
  type UpdaterStatus,
  type WatcherCandidateRelationsResult,
  type WatcherCreateParams,
  type WatcherCreateResult,
  type WatcherListHistoryResult,
  type WatcherListResult,
  type WatcherValidateConditionResult,
  type WorkflowListResult,
  type WorkflowListRunsResult,
  type WorkflowRunParams,
  type WorkflowRunResult,
  type WorkflowSaveResult,
} from "./types";

export interface NimbusIpcClient {
  call<TResult>(method: string, params?: unknown): Promise<TResult>;
  subscribe(handler: (n: JsonRpcNotification) => void): Promise<() => void>;
  onConnectionState(handler: (s: ConnectionState) => void): Promise<() => void>;
  connectorListStatus(): Promise<ConnectorStatus[]>;
  indexMetrics(): Promise<IndexMetrics>;
  auditList(limit?: number): Promise<AuditEntry[]>;
  consentRespond(requestId: string, approved: boolean): Promise<void>;
  profileList(): Promise<ProfileListResult>;
  profileCreate(name: string): Promise<{ name: string }>;
  profileSwitch(name: string): Promise<{ active: string }>;
  profileDelete(name: string): Promise<{ deleted: string }>;
  telemetryGetStatus(): Promise<TelemetryStatus>;
  telemetrySetEnabled(enabled: boolean): Promise<{ enabled: boolean }>;
  connectorSetConfig(
    service: string,
    patch: ConnectorConfigPatch,
  ): Promise<{
    service: string;
    intervalMs: number | null;
    depth: "metadata_only" | "summary" | "full" | null;
    enabled: boolean | null;
  }>;
  llmListModels(): Promise<LlmListModelsResult>;
  llmGetStatus(): Promise<LlmAvailabilityResult>;
  llmGetRouterStatus(): Promise<RouterStatusResult>;
  llmPullModel(provider: "ollama" | "llamacpp", modelName: string): Promise<LlmPullStartedResult>;
  llmCancelPull(pullId: string): Promise<{ cancelled: boolean }>;
  llmLoadModel(provider: "ollama" | "llamacpp", modelName: string): Promise<{ isLoaded: true }>;
  llmUnloadModel(provider: "ollama" | "llamacpp", modelName: string): Promise<{ isLoaded: false }>;
  llmSetDefault(
    taskType: LlmTaskType,
    provider: "ollama" | "llamacpp" | "remote",
    modelName: string,
  ): Promise<{ taskType: LlmTaskType; provider: string; modelName: string }>;
  auditGetSummary(): Promise<AuditSummary>;
  auditVerify(full?: boolean): Promise<AuditVerifyResult>;
  auditExport(): Promise<ReadonlyArray<AuditExportRow>>;
  updaterGetStatus(): Promise<UpdaterStatus>;
  updaterCheckNow(): Promise<UpdaterCheckResult>;
  updaterApplyUpdate(): Promise<UpdaterApplyStarted>;
  updaterRollback(): Promise<UpdaterRollbackResult>;
  diagGetVersion(): Promise<DiagVersionResult>;
  dataGetExportPreflight(): Promise<ExportPreflightResult>;
  dataGetDeletePreflight(args: { service: string }): Promise<DeletePreflightResult>;
  dataExport(args: {
    output: string;
    passphrase: string;
    includeIndex: boolean;
  }): Promise<DataExportResult>;
  dataImport(args: {
    bundlePath: string;
    passphrase?: string;
    recoverySeed?: string;
  }): Promise<DataImportResult>;
  dataDelete(args: { service: string; dryRun: false }): Promise<DataDeleteResult>;
  watcherList(): Promise<WatcherListResult>;
  watcherCreate(params: WatcherCreateParams): Promise<WatcherCreateResult>;
  watcherDelete(id: string): Promise<{ ok: boolean }>;
  watcherPause(id: string): Promise<{ ok: boolean }>;
  watcherResume(id: string): Promise<{ ok: boolean }>;
  watcherListCandidateRelations(): Promise<WatcherCandidateRelationsResult>;
  watcherValidateCondition(
    graphPredicateJson: string,
    sinceMs: number,
  ): Promise<WatcherValidateConditionResult>;
  watcherListHistory(watcherId: string, limit: number): Promise<WatcherListHistoryResult>;
  extensionList(): Promise<ExtensionListResult>;
  extensionInstall(sourcePath: string): Promise<ExtensionInstallResult>;
  extensionEnable(id: string): Promise<{ ok: boolean }>;
  extensionDisable(id: string): Promise<{ ok: boolean }>;
  extensionRemove(id: string): Promise<{ ok: boolean }>;
  workflowList(): Promise<WorkflowListResult>;
  workflowListRuns(workflowName: string, limit: number): Promise<WorkflowListRunsResult>;
  workflowSave(params: {
    name: string;
    description?: string;
    stepsJson: string;
  }): Promise<WorkflowSaveResult>;
  workflowDelete(name: string): Promise<{ ok: boolean }>;
  workflowRun(params: WorkflowRunParams): Promise<WorkflowRunResult>;
}

const FORBIDDEN_VALUE_KEYS: readonly string[] = [
  "passphrase",
  "recoverySeed",
  "mnemonic",
  "privateKey",
  "encryptedVaultManifest",
  "pat",
];

const SENSITIVE_KEY_PATTERN = /(token|key|secret|password|credential|bearer|auth)/i;

function isSensitiveKeyName(name: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(name);
}

export { isSensitiveKeyName };

function redactSensitiveSubstrings(input: string): string {
  let out = input;
  for (const key of FORBIDDEN_VALUE_KEYS) {
    const assignRe = new RegExp(String.raw`${key}\s*[=:]\s*"?([^\s",}]+)"?`, "gi");
    out = out.replace(assignRe, `${key}=[REDACTED]`);
    const jsonRe = new RegExp(String.raw`"${key}"\s*:\s*"[^"]*"`, "gi");
    out = out.replace(jsonRe, `"${key}":"[REDACTED]"`);
  }
  out = out.replaceAll(
    /"(\w*(?:token|key|secret|password|credential|bearer|auth)\w*)"\s*:\s*"[^"]*"/gi,
    (_match, k: string) => `"${k}":"[REDACTED]"`,
  );
  out = out.replaceAll(
    /(\b\w*(?:token|key|secret|password|credential|bearer|auth)\w*)\s*[=:]\s*"?([^\s",}]+)"?/gi,
    (_match, k: string) => `${k}=[REDACTED]`,
  );
  return out;
}

export { redactSensitiveSubstrings };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function assertShape<T>(
  v: unknown,
  name: string,
  check: (r: Record<string, unknown>) => boolean,
): T {
  if (!isRecord(v) || !check(v)) {
    throw new Error(`IPC response for ${name} has unexpected shape`);
  }
  return v as unknown as T;
}

function parseError(err: unknown): Error {
  let msg: string;
  if (typeof err === "string") {
    msg = err;
  } else if (err instanceof Error) {
    msg = err.message;
  } else {
    msg = JSON.stringify(err);
  }
  msg = redactSensitiveSubstrings(msg);
  if (msg.startsWith("ERR_METHOD_NOT_ALLOWED")) {
    const method = msg.split(":")[1] ?? "unknown";
    return new MethodNotAllowedError(method);
  }
  if (msg.startsWith("ERR_GATEWAY_OFFLINE")) return new GatewayOfflineError();
  try {
    const parsed = JSON.parse(msg) as JsonRpcErrorPayload;
    if (typeof parsed.code === "number" && typeof parsed.message === "string") {
      return new JsonRpcError(parsed);
    }
  } catch {
    /* not a JSON-RPC error payload */
  }
  return new Error(msg);
}

let singleton: NimbusIpcClient | null = null;

export function createIpcClient(): NimbusIpcClient {
  if (singleton) return singleton;

  const client: NimbusIpcClient = {
    async call<TResult>(method: string, params: unknown = null): Promise<TResult> {
      try {
        const result = await invoke<TResult>("rpc_call", { method, params });
        return result;
      } catch (err) {
        throw parseError(err);
      }
    },
    async subscribe(handler): Promise<() => void> {
      return listen<JsonRpcNotification>("gateway://notification", (evt) => handler(evt.payload));
    },
    async onConnectionState(handler): Promise<() => void> {
      return listen<ConnectionState>("gateway://connection-state", (evt) => handler(evt.payload));
    },
    async connectorListStatus(): Promise<ConnectorStatus[]> {
      const res = await this.call<unknown>("connector.listStatus", {});
      if (!Array.isArray(res)) throw new Error("connector.listStatus: expected array");
      return res as ConnectorStatus[];
    },
    async indexMetrics(): Promise<IndexMetrics> {
      const res = await this.call<unknown>("index.metrics", {});
      if (typeof res !== "object" || res === null)
        throw new Error("index.metrics: expected object");
      return res as IndexMetrics;
    },
    async auditList(limit = 25): Promise<AuditEntry[]> {
      const res = await this.call<unknown>("audit.list", { limit });
      if (!Array.isArray(res)) throw new Error("audit.list: expected array");
      return res as AuditEntry[];
    },
    async consentRespond(requestId: string, approved: boolean): Promise<void> {
      await this.call<unknown>("consent.respond", { requestId, approved });
      await invoke("hitl_resolved", { requestId, approved });
    },
    async profileList(): Promise<ProfileListResult> {
      const res = await this.call<unknown>("profile.list", {});
      if (typeof res !== "object" || res === null) throw new Error("profile.list: expected object");
      return res as ProfileListResult;
    },
    async profileCreate(name: string): Promise<{ name: string }> {
      return await this.call<{ name: string }>("profile.create", { name });
    },
    async profileSwitch(name: string): Promise<{ active: string }> {
      return await this.call<{ active: string }>("profile.switch", { name });
    },
    async profileDelete(name: string): Promise<{ deleted: string }> {
      return await this.call<{ deleted: string }>("profile.delete", { name });
    },
    async telemetryGetStatus(): Promise<TelemetryStatus> {
      const res = await this.call<unknown>("telemetry.getStatus", {});
      if (typeof res !== "object" || res === null)
        throw new Error("telemetry.getStatus: expected object");
      return res as TelemetryStatus;
    },
    async telemetrySetEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
      return await this.call<{ enabled: boolean }>("telemetry.setEnabled", { enabled });
    },
    async connectorSetConfig(service, patch) {
      const params: Record<string, unknown> = { service };
      if (patch.intervalMs !== undefined) params.intervalMs = patch.intervalMs;
      if (patch.depth !== undefined) params.depth = patch.depth;
      if (patch.enabled !== undefined) params.enabled = patch.enabled;
      return await this.call("connector.setConfig", params);
    },
    async llmListModels(): Promise<LlmListModelsResult> {
      const res = await this.call<unknown>("llm.listModels", {});
      if (typeof res !== "object" || res === null)
        throw new Error("llm.listModels: expected object");
      return res as LlmListModelsResult;
    },
    async llmGetStatus(): Promise<LlmAvailabilityResult> {
      const res = await this.call<unknown>("llm.getStatus", {});
      if (typeof res !== "object" || res === null)
        throw new Error("llm.getStatus: expected object");
      return res as LlmAvailabilityResult;
    },
    async llmGetRouterStatus(): Promise<RouterStatusResult> {
      const res = await this.call<unknown>("llm.getRouterStatus", {});
      if (typeof res !== "object" || res === null)
        throw new Error("llm.getRouterStatus: expected object");
      return res as RouterStatusResult;
    },
    async llmPullModel(provider, modelName) {
      return await this.call("llm.pullModel", { provider, modelName });
    },
    async llmCancelPull(pullId) {
      return await this.call("llm.cancelPull", { pullId });
    },
    async llmLoadModel(provider, modelName) {
      return await this.call("llm.loadModel", { provider, modelName });
    },
    async llmUnloadModel(provider, modelName) {
      return await this.call("llm.unloadModel", { provider, modelName });
    },
    async llmSetDefault(taskType, provider, modelName) {
      return await this.call("llm.setDefault", { taskType, provider, modelName });
    },
    async auditGetSummary(): Promise<AuditSummary> {
      const res = await this.call<unknown>("audit.getSummary", {});
      if (typeof res !== "object" || res === null)
        throw new Error("audit.getSummary: expected object");
      return res as AuditSummary;
    },
    async auditVerify(full = false): Promise<AuditVerifyResult> {
      const res = await this.call<unknown>("audit.verify", { full });
      if (typeof res !== "object" || res === null) throw new Error("audit.verify: expected object");
      return res as AuditVerifyResult;
    },
    async auditExport(): Promise<ReadonlyArray<AuditExportRow>> {
      const res = await this.call<unknown>("audit.export", {});
      if (!Array.isArray(res)) throw new Error("audit.export: expected array");
      return res as ReadonlyArray<AuditExportRow>;
    },
    async updaterGetStatus(): Promise<UpdaterStatus> {
      const res = await this.call<unknown>("updater.getStatus", {});
      if (typeof res !== "object" || res === null)
        throw new Error("updater.getStatus: expected object");
      return res as UpdaterStatus;
    },
    async updaterCheckNow(): Promise<UpdaterCheckResult> {
      const res = await this.call<unknown>("updater.checkNow", {});
      if (typeof res !== "object" || res === null)
        throw new Error("updater.checkNow: expected object");
      return res as UpdaterCheckResult;
    },
    async updaterApplyUpdate(): Promise<UpdaterApplyStarted> {
      const res = await this.call<unknown>("updater.applyUpdate", {});
      if (typeof res !== "object" || res === null)
        throw new Error("updater.applyUpdate: expected object");
      return res as UpdaterApplyStarted;
    },
    async updaterRollback(): Promise<UpdaterRollbackResult> {
      const res = await this.call<unknown>("updater.rollback", {});
      if (typeof res !== "object" || res === null)
        throw new Error("updater.rollback: expected object");
      return res as UpdaterRollbackResult;
    },
    async diagGetVersion(): Promise<DiagVersionResult> {
      const res = await this.call<unknown>("diag.getVersion", {});
      if (typeof res !== "object" || res === null)
        throw new Error("diag.getVersion: expected object");
      return res as DiagVersionResult;
    },
    async dataGetExportPreflight() {
      const raw = await this.call<unknown>("data.getExportPreflight", {});
      return assertShape<ExportPreflightResult>(
        raw,
        "data.getExportPreflight",
        (r) =>
          (r.lastExportAt === null || typeof r.lastExportAt === "number") &&
          typeof r.estimatedSizeBytes === "number" &&
          typeof r.itemCount === "number",
      );
    },
    async dataGetDeletePreflight(args) {
      const raw = await this.call<unknown>("data.getDeletePreflight", { service: args.service });
      return assertShape<DeletePreflightResult>(
        raw,
        "data.getDeletePreflight",
        (r) =>
          typeof r.service === "string" &&
          typeof r.itemCount === "number" &&
          typeof r.embeddingCount === "number" &&
          typeof r.vaultKeyCount === "number",
      );
    },
    async dataExport(args) {
      const raw = await this.call<unknown>("data.export", {
        output: args.output,
        passphrase: args.passphrase,
        includeIndex: args.includeIndex,
      });
      return assertShape<DataExportResult>(
        raw,
        "data.export",
        (r) =>
          typeof r.outputPath === "string" &&
          typeof r.recoverySeed === "string" &&
          typeof r.recoverySeedGenerated === "boolean" &&
          typeof r.itemsExported === "number",
      );
    },
    async dataImport(args) {
      const params: Record<string, unknown> = { bundlePath: args.bundlePath };
      if (args.passphrase !== undefined) params.passphrase = args.passphrase;
      if (args.recoverySeed !== undefined) params.recoverySeed = args.recoverySeed;
      const raw = await this.call<unknown>("data.import", params);
      return assertShape<DataImportResult>(
        raw,
        "data.import",
        (r) =>
          typeof r.credentialsRestored === "number" && typeof r.oauthEntriesFlagged === "number",
      );
    },
    async dataDelete(args) {
      const raw = await this.call<unknown>("data.delete", {
        service: args.service,
        dryRun: args.dryRun,
      });
      return assertShape<DataDeleteResult>(
        raw,
        "data.delete",
        (r) =>
          typeof r.deleted === "boolean" &&
          isRecord(r.preflight) &&
          typeof r.preflight.service === "string" &&
          typeof r.preflight.itemsToDelete === "number" &&
          typeof r.preflight.vaultEntriesToDelete === "number",
      );
    },
    async watcherList(): Promise<WatcherListResult> {
      const res = await this.call<unknown>("watcher.list", {});
      if (typeof res !== "object" || res === null) throw new Error("watcher.list: expected object");
      return res as WatcherListResult;
    },
    async watcherCreate(params: WatcherCreateParams): Promise<WatcherCreateResult> {
      return await this.call<WatcherCreateResult>("watcher.create", params);
    },
    async watcherDelete(id: string): Promise<{ ok: boolean }> {
      return await this.call<{ ok: boolean }>("watcher.delete", { id });
    },
    async watcherPause(id: string): Promise<{ ok: boolean }> {
      return await this.call<{ ok: boolean }>("watcher.pause", { id });
    },
    async watcherResume(id: string): Promise<{ ok: boolean }> {
      return await this.call<{ ok: boolean }>("watcher.resume", { id });
    },
    async watcherListCandidateRelations(): Promise<WatcherCandidateRelationsResult> {
      const res = await this.call<unknown>("watcher.listCandidateRelations", {});
      if (typeof res !== "object" || res === null)
        throw new Error("watcher.listCandidateRelations: expected object");
      return res as WatcherCandidateRelationsResult;
    },
    async watcherValidateCondition(
      graphPredicateJson: string,
      sinceMs: number,
    ): Promise<WatcherValidateConditionResult> {
      const res = await this.call<unknown>("watcher.validateCondition", {
        graphPredicateJson,
        sinceMs,
      });
      if (typeof res !== "object" || res === null)
        throw new Error("watcher.validateCondition: expected object");
      return res as WatcherValidateConditionResult;
    },
    async watcherListHistory(watcherId: string, limit: number): Promise<WatcherListHistoryResult> {
      const res = await this.call<unknown>("watcher.listHistory", { watcherId, limit });
      if (
        typeof res !== "object" ||
        res === null ||
        !Array.isArray((res as WatcherListHistoryResult).events)
      ) {
        throw new Error("watcher.listHistory: expected { events: [] }");
      }
      return res as WatcherListHistoryResult;
    },
    async extensionList(): Promise<ExtensionListResult> {
      const res = await this.call<unknown>("extension.list", {});
      if (typeof res !== "object" || res === null)
        throw new Error("extension.list: expected object");
      return res as ExtensionListResult;
    },
    async extensionInstall(sourcePath: string): Promise<ExtensionInstallResult> {
      return await this.call<ExtensionInstallResult>("extension.install", { sourcePath });
    },
    async extensionEnable(id: string): Promise<{ ok: boolean }> {
      return await this.call<{ ok: boolean }>("extension.enable", { id });
    },
    async extensionDisable(id: string): Promise<{ ok: boolean }> {
      return await this.call<{ ok: boolean }>("extension.disable", { id });
    },
    async extensionRemove(id: string): Promise<{ ok: boolean }> {
      return await this.call<{ ok: boolean }>("extension.remove", { id });
    },
    async workflowList(): Promise<WorkflowListResult> {
      const res = await this.call<unknown>("workflow.list", {});
      if (typeof res !== "object" || res === null)
        throw new Error("workflow.list: expected object");
      return res as WorkflowListResult;
    },
    async workflowListRuns(workflowName: string, limit: number): Promise<WorkflowListRunsResult> {
      const res = await this.call<unknown>("workflow.listRuns", { workflowName, limit });
      if (
        typeof res !== "object" ||
        res === null ||
        !Array.isArray((res as WorkflowListRunsResult).runs)
      ) {
        throw new Error("workflow.listRuns: expected { runs: [] }");
      }
      return res as WorkflowListRunsResult;
    },
    async workflowSave(params: {
      name: string;
      description?: string;
      stepsJson: string;
    }): Promise<WorkflowSaveResult> {
      return await this.call<WorkflowSaveResult>("workflow.save", {
        name: params.name,
        description: params.description ?? null,
        stepsJson: params.stepsJson,
      });
    },
    async workflowDelete(name: string): Promise<{ ok: boolean }> {
      return await this.call<{ ok: boolean }>("workflow.delete", { name });
    },
    async workflowRun(params: WorkflowRunParams): Promise<WorkflowRunResult> {
      return await this.call<WorkflowRunResult>("workflow.run", params);
    },
  };
  singleton = client;
  return client;
}

export function __resetIpcClientForTests(): void {
  singleton = null;
}
