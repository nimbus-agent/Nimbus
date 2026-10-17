import { listExtensions } from "../automation/extension-store.ts";
import type { ExtensionSlotSource } from "../connectors/lazy-mesh/extension-slot-source.ts";
import type { ServerSpec } from "../connectors/lazy-mesh/slot.ts";
import { wrapServerSpec } from "../connectors/lazy-mesh/wrap-server-spec.ts";
import { selfSpawn } from "../platform/runtime-layout.ts";
import type { ExtensionManifest } from "./manifest.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";
import { listRunGrants } from "./run-grant-store.ts";
import { extensionProcessEnv } from "./spawn-env.ts";
import {
  readVerifiedExtensionForSpawn,
  type VerifiedExtensionDeps,
  type VerifiedExtensionForSpawn,
} from "./verified-extension.ts";

/**
 * The ONE place an extension's spawn is built (invariant I43 / static rule D33(a)). The sandbox
 * manifest is assembled fresh from the VERIFIED grants: the install path and the runtime read paths
 * are added here at every spawn and never stored in the grant.
 */
export function buildExtensionRuntimeManifest(
  v: VerifiedExtensionForSpawn,
  runtimeReadPaths: readonly string[],
): ExtensionManifest {
  return {
    id: `ext.${v.serviceId}`,
    version: v.version,
    permissions: {
      network: [...v.grants.network],
      filesystem: {
        read: [...v.grants.read, v.installPath, ...runtimeReadPaths],
        write: [...v.grants.write],
      },
    },
    updateChannel: "stable",
  };
}

export function buildExtensionSpawnSpec(
  v: VerifiedExtensionForSpawn,
  deps: { runtimeReadPaths: readonly string[]; sandboxDir: string },
): ServerSpec {
  const { command, args } = selfSpawn("extension", [v.entryPath]);
  return wrapServerSpec(
    { command, args, env: extensionProcessEnv({}) },
    buildExtensionRuntimeManifest(v, deps.runtimeReadPaths),
    deps.sandboxDir,
  );
}

export type ExtensionSlotSourceDeps = VerifiedExtensionDeps & {
  readonly sandboxDir: string;
  /** A thunk so it is recomputed per spawn. */
  readonly runtimeReadPaths: () => readonly string[];
  readonly isConnectorAllowed: (serviceId: string) => boolean;
  readonly verify?: typeof readVerifiedExtensionForSpawn;
};

export function createExtensionSlotSource(deps: ExtensionSlotSourceDeps): ExtensionSlotSource {
  const verify = deps.verify ?? readVerifiedExtensionForSpawn;
  return {
    listServiceIds() {
      const enabled = new Set(
        listExtensions(deps.db)
          .filter((r) => r.enabled === 1)
          .map((r) => r.id),
      );
      return listRunGrants(deps.db)
        .filter((g) => enabled.has(g.extension_id))
        .map((g) => g.service_id)
        .sort();
    },
    async prepareSpawn(serviceId) {
      const grant = listRunGrants(deps.db).find((g) => g.service_id === serviceId);
      if (grant === undefined) {
        throw new ExtensionRunGrantError(
          "ERR_EXTENSION_RUN_NOT_APPROVED",
          `no extension run approval carries service id "${serviceId}"`,
        );
      }
      if (!deps.isConnectorAllowed(serviceId)) {
        throw new ExtensionRunGrantError(
          "ERR_EXTENSION_RUN_POLICY",
          `organization policy does not allow ${serviceId}`,
        );
      }
      const verified = await verify(grant.extension_id, deps);
      if (verified.serviceId !== serviceId) {
        throw new ExtensionRunGrantError(
          "ERR_EXTENSION_RUN_CHANGED",
          `${grant.extension_id}'s service id changed; approve it again`,
        );
      }
      return {
        extensionId: verified.extensionId,
        serviceId: verified.serviceId,
        spec: buildExtensionSpawnSpec(verified, {
          runtimeReadPaths: deps.runtimeReadPaths(),
          sandboxDir: deps.sandboxDir,
        }),
      };
    },
  };
}
