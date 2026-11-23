/**
 * `nimbus extension` CLI. The implementation lives in `./extension/<group>.ts`, one module per
 * subcommand group; this file keeps the public names importers and tests use.
 */

export { printable, runExtensionApprove, runExtensionRevoke } from "./extension/approve.ts";
export { type CredentialCliIo, runExtensionCredential } from "./extension/credential.ts";
export {
  refuseNetworkOutsideApprove,
  rpcTimeoutForExtensionSub,
  runExtension,
} from "./extension/dispatch.ts";
export {
  type ExtensionInfoForDowngrade,
  type RunExtensionDowngradeOpts,
  runExtensionDowngrade,
  runExtensionDowngradeWithCaller,
} from "./extension/downgrade.ts";
export { hasFlag, stripFlags, takeFlagValue } from "./extension/flags.ts";
export {
  fetchSandboxPosture,
  formatEnabledLine,
  formatExtensionInfoHuman,
  runExtensionInfo,
} from "./extension/info.ts";
export {
  type InstallWalkDeps,
  runExtensionInstall,
  runExtensionRehash,
} from "./extension/install.ts";
export { runExtensionKeygen, runExtensionSign } from "./extension/keys.ts";
export {
  type ExtensionRemoveIo,
  runExtensionDisable,
  runExtensionEnable,
  runExtensionRemove,
} from "./extension/lifecycle.ts";
export {
  type ExtensionListTableRow,
  formatBlockLines,
  formatExtensionListTable,
  formatRunLine,
  runExtensionList,
  runStateLabel,
  type TrustBlockView,
} from "./extension/list.ts";
export {
  type AutoUpdateIpcCaller,
  type AvailableUpdateCli,
  extensionUpdateApplies,
  type RunExtensionUpdateOpts,
  runExtensionUpdate,
  runExtensionUpdateWithCaller,
  type UpdateApplyResultCli,
} from "./extension/update.ts";
