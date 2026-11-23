import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import {
  loadNimbusExtensionsFromConfigDir,
  loadNimbusUpdaterFromConfigDir,
} from "../../config/nimbus-toml.ts";
import type { LazyConnectorMesh } from "../../connectors/lazy-mesh/index.ts";
import {
  type AutoUpdateRuntime,
  createAutoUpdateRuntime,
} from "../../extensions/auto-update-init.ts";
import type { RegistryFetchDeps } from "../../extensions/registry/registry-fetch.ts";
import type { createIpcServer } from "../../ipc/index.ts";
import { createUpdaterFromConfig } from "../../updater/factory.ts";
import { buildUpdateAuditRecorder } from "../../updater/update-audit.ts";
import { redactUrlUserinfo } from "../../updater/updater.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { GATEWAY_VERSION } from "../../version.ts";
import { bootPolicyFor } from "../demo-boot.ts";
import type { PlatformPaths } from "../paths.ts";

/** Start the extensions auto-update daemon whenever boot policy allows it and
 *  `NIMBUS_EXTENSIONS_DISABLE_AUTO_UPDATE` does not veto. Each tick reads the CURRENT registry
 *  table, so with no registries a tick does nothing and a registry added later is polled on the
 *  next one. `registryFetch` is the SAME deps object the `registry.*` methods get (one air-gap
 *  switch). Returns the runtime, or undefined when not started. */
export function maybeStartAutoUpdateRuntime(deps: {
  db: Database;
  vault: NimbusVault;
  paths: PlatformPaths;
  connectorMesh: LazyConnectorMesh;
  sidecarStops: Array<() => void>;
  registryFetch: Omit<RegistryFetchDeps, "db">;
  onUpdateApplied: (extensionId: string) => void;
  freshenTrust: () => Promise<unknown>;
}): AutoUpdateRuntime | undefined {
  const { db, vault, paths, connectorMesh, sidecarStops, registryFetch, onUpdateApplied } = deps;
  let autoUpdateRuntime: AutoUpdateRuntime | undefined;
  const autoUpdateDisabled = process.env["NIMBUS_EXTENSIONS_DISABLE_AUTO_UPDATE"] === "1";
  if (!autoUpdateDisabled && bootPolicyFor(paths).extensionsAutoUpdate) {
    const extensionsCfg = loadNimbusExtensionsFromConfigDir(paths.configDir);
    autoUpdateRuntime = createAutoUpdateRuntime({
      db,
      vault,
      extensionsDir: paths.extensionsDir,
      dataDir: paths.dataDir,
      fetch: registryFetch,
      intervalHours: extensionsCfg.updateCheckIntervalHours,
      stopExtensionClient: (id) => connectorMesh.stopExtensionClient(id),
      onUpdateApplied,
      freshenTrust: deps.freshenTrust,
    });
    void autoUpdateRuntime.daemon.start();
    sidecarStops.push(() => {
      autoUpdateRuntime?.abortController.abort();
      void autoUpdateRuntime?.daemon.stop();
    });
  }
  return autoUpdateRuntime;
}

/** The auto-update slices of the IPC server options; empty when the daemon is not running. */
export function autoUpdateIpcOpts(
  runtime: AutoUpdateRuntime | undefined,
  configDir: string,
  airGapBlocked: boolean,
): Pick<
  Parameters<typeof createIpcServer>[0],
  "extensionsAutoUpdate" | "extensionsAutoUpdateDiag"
> {
  if (runtime === undefined) {
    return {};
  }
  const autoUpdateDeps = runtime.deps;
  return {
    extensionsAutoUpdate: autoUpdateDeps,
    extensionsAutoUpdateDiag: {
      cachedUpdatesCount: (): number => autoUpdateDeps.cache.list().length,
      intervalHours: loadNimbusExtensionsFromConfigDir(configDir).updateCheckIntervalHours,
      airGapBlocked,
    },
  };
}

/** Build the updater from config (when [updater] enables one), hand it to the IPC server, and run
 *  the best-effort startup check. */
export function wireUpdaterIntoIpc(
  configDir: string,
  ipc: ReturnType<typeof createIpcServer>,
  syncLogger: Logger,
  db: Database,
): void {
  const updaterCfg = loadNimbusUpdaterFromConfigDir(configDir);
  const updater = createUpdaterFromConfig({
    updaterCfg,
    currentVersion: GATEWAY_VERSION,
    emit: (name, payload) => ipc.broadcast(name, payload ?? {}),
    logger: syncLogger,
    recordUpdateEvent: buildUpdateAuditRecorder(db, syncLogger),
  });
  if (updater !== undefined) {
    ipc.setUpdater(updater);
    if (updaterCfg.checkOnStartup) {
      void updater
        .checkNow()
        .catch((err: unknown) =>
          syncLogger.warn(
            { err: redactUrlUserinfo(err instanceof Error ? err.message : String(err)) },
            "updater startup check failed",
          ),
        );
    }
  }
}
