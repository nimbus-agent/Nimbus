import { vi } from "vitest";

export const callMock = vi.fn<(method: string, params?: unknown) => Promise<unknown>>();
export const subscribeMock = vi.fn<
  (handler: (n: { method: string; params: unknown }) => void) => Promise<() => void>
>(async () => () => {});
export const onConnectionStateMock = vi.fn<() => Promise<() => void>>(async () => () => {});

export const connectorListStatusMock = vi.fn<() => Promise<unknown>>();
export const indexMetricsMock = vi.fn<() => Promise<unknown>>();
export const auditListMock = vi.fn<(limit?: number) => Promise<unknown>>();
export const consentRespondMock = vi.fn<(requestId: string, approved: boolean) => Promise<void>>(
  async () => undefined,
);

export const profileListMock = vi.fn<() => Promise<unknown>>();
export const profileCreateMock = vi.fn<(name: string) => Promise<unknown>>();
export const profileSwitchMock = vi.fn<(name: string) => Promise<unknown>>();
export const profileDeleteMock = vi.fn<(name: string) => Promise<unknown>>();
export const telemetryGetStatusMock = vi.fn<() => Promise<unknown>>();
export const telemetrySetEnabledMock = vi.fn<(enabled: boolean) => Promise<unknown>>();

export const connectorSetConfigMock =
  vi.fn<(service: string, patch: Record<string, unknown>) => Promise<unknown>>();
export const llmListModelsMock = vi.fn<() => Promise<unknown>>();
export const llmGetStatusMock = vi.fn<() => Promise<unknown>>();
export const llmGetRouterStatusMock = vi.fn<() => Promise<unknown>>();
export const llmPullModelMock = vi.fn<(provider: string, modelName: string) => Promise<unknown>>();
export const llmCancelPullMock = vi.fn<(pullId: string) => Promise<unknown>>();
export const llmLoadModelMock = vi.fn<(provider: string, modelName: string) => Promise<unknown>>();
export const llmUnloadModelMock =
  vi.fn<(provider: string, modelName: string) => Promise<unknown>>();
export const llmSetDefaultMock =
  vi.fn<(taskType: string, provider: string, modelName: string) => Promise<unknown>>();

export const auditGetSummaryMock = vi.fn<() => Promise<unknown>>();
export const auditVerifyMock = vi.fn<(full?: boolean) => Promise<unknown>>();
export const auditExportMock = vi.fn<() => Promise<unknown>>();
export const updaterGetStatusMock = vi.fn<() => Promise<unknown>>();
export const updaterCheckNowMock = vi.fn<() => Promise<unknown>>();
export const updaterApplyUpdateMock = vi.fn<() => Promise<unknown>>();
export const updaterRollbackMock = vi.fn<() => Promise<unknown>>();
export const diagGetVersionMock = vi.fn<() => Promise<unknown>>();

export const dataGetExportPreflightMock = vi.fn<() => Promise<unknown>>();
export const dataGetDeletePreflightMock = vi.fn<(args: { service: string }) => Promise<unknown>>();
export const dataExportMock =
  vi.fn<
    (args: { output: string; passphrase: string; includeIndex: boolean }) => Promise<unknown>
  >();
export const dataImportMock =
  vi.fn<
    (args: { bundlePath: string; passphrase?: string; recoverySeed?: string }) => Promise<unknown>
  >();
export const dataDeleteMock =
  vi.fn<(args: { service: string; dryRun: false }) => Promise<unknown>>();

export const watcherListMock = vi.fn<() => Promise<unknown>>();
export const watcherCreateMock = vi.fn<(params: Record<string, unknown>) => Promise<unknown>>();
export const watcherDeleteMock = vi.fn<(id: string) => Promise<unknown>>();
export const watcherPauseMock = vi.fn<(id: string) => Promise<unknown>>();
export const watcherResumeMock = vi.fn<(id: string) => Promise<unknown>>();
export const watcherListCandidateRelationsMock = vi.fn<() => Promise<unknown>>();
export const watcherValidateConditionMock =
  vi.fn<(graphPredicateJson: string, sinceMs: number) => Promise<unknown>>();
export const watcherListHistoryMock =
  vi.fn<(watcherId: string, limit: number) => Promise<unknown>>();
export const extensionListMock = vi.fn<() => Promise<unknown>>();
export const extensionInstallMock = vi.fn<(sourcePath: string) => Promise<unknown>>();
export const extensionEnableMock = vi.fn<(id: string) => Promise<unknown>>();
export const extensionDisableMock = vi.fn<(id: string) => Promise<unknown>>();
export const extensionRemoveMock = vi.fn<(id: string) => Promise<unknown>>();
export const workflowListMock = vi.fn<() => Promise<unknown>>();
export const workflowListRunsMock =
  vi.fn<(workflowName: string, limit: number) => Promise<unknown>>();
export const workflowSaveMock =
  vi.fn<(params: { name: string; description?: string; stepsJson: string }) => Promise<unknown>>();
export const workflowDeleteMock = vi.fn<(name: string) => Promise<unknown>>();
export const workflowRunMock =
  vi.fn<
    (params: {
      name: string;
      dryRun: boolean;
      paramsOverride?: Record<string, Record<string, unknown>>;
    }) => Promise<unknown>
  >();

export const createIpcClient = () => ({
  call: callMock,
  subscribe: subscribeMock,
  onConnectionState: onConnectionStateMock,
  connectorListStatus: connectorListStatusMock,
  indexMetrics: indexMetricsMock,
  auditList: auditListMock,
  consentRespond: consentRespondMock,
  profileList: profileListMock,
  profileCreate: profileCreateMock,
  profileSwitch: profileSwitchMock,
  profileDelete: profileDeleteMock,
  telemetryGetStatus: telemetryGetStatusMock,
  telemetrySetEnabled: telemetrySetEnabledMock,
  connectorSetConfig: connectorSetConfigMock,
  llmListModels: llmListModelsMock,
  llmGetStatus: llmGetStatusMock,
  llmGetRouterStatus: llmGetRouterStatusMock,
  llmPullModel: llmPullModelMock,
  llmCancelPull: llmCancelPullMock,
  llmLoadModel: llmLoadModelMock,
  llmUnloadModel: llmUnloadModelMock,
  llmSetDefault: llmSetDefaultMock,
  auditGetSummary: auditGetSummaryMock,
  auditVerify: auditVerifyMock,
  auditExport: auditExportMock,
  updaterGetStatus: updaterGetStatusMock,
  updaterCheckNow: updaterCheckNowMock,
  updaterApplyUpdate: updaterApplyUpdateMock,
  updaterRollback: updaterRollbackMock,
  diagGetVersion: diagGetVersionMock,
  dataGetExportPreflight: dataGetExportPreflightMock,
  dataGetDeletePreflight: dataGetDeletePreflightMock,
  dataExport: dataExportMock,
  dataImport: dataImportMock,
  dataDelete: dataDeleteMock,
  watcherList: watcherListMock,
  watcherCreate: watcherCreateMock,
  watcherDelete: watcherDeleteMock,
  watcherPause: watcherPauseMock,
  watcherResume: watcherResumeMock,
  watcherListCandidateRelations: watcherListCandidateRelationsMock,
  watcherValidateCondition: watcherValidateConditionMock,
  watcherListHistory: watcherListHistoryMock,
  extensionList: extensionListMock,
  extensionInstall: extensionInstallMock,
  extensionEnable: extensionEnableMock,
  extensionDisable: extensionDisableMock,
  extensionRemove: extensionRemoveMock,
  workflowList: workflowListMock,
  workflowListRuns: workflowListRunsMock,
  workflowSave: workflowSaveMock,
  workflowDelete: workflowDeleteMock,
  workflowRun: workflowRunMock,
});

export const __resetIpcClientForTests = () => {};
