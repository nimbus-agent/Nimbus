import { listExtensions } from "../automation/extension-store.ts";
import type { ExtensionSlotSource } from "../connectors/lazy-mesh/extension-slot-source.ts";
import type { ServerSpec } from "../connectors/lazy-mesh/slot.ts";
import { wrapServerSpec } from "../connectors/lazy-mesh/wrap-server-spec.ts";
import {
  DEFAULT_RUNTIME_LAYOUT,
  isCompiledBinary,
  type RuntimeLayout,
  selfSpawn,
} from "../platform/runtime-layout.ts";
import { sandboxCwdFor } from "../platform/sandbox/sandbox-cwd.ts";
import {
  type ExtensionStageDeps,
  type StagedExtensionForSpawn,
  stageVerifiedExtension,
} from "./extension-stage.ts";
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
 * manifest is assembled fresh from the VERIFIED grants plus the runtime read paths, added here at
 * every spawn and never stored in the grant. The install path is NOT granted: the code runs from a
 * verified per-spawn copy inside the extension's own sandbox leaf, which the sandbox already grants
 * as the working directory (`extension-stage.ts`).
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
        read: [...v.grants.read, ...runtimeReadPaths],
        write: [...v.grants.write],
      },
    },
    updateChannel: "stable",
  };
}

/**
 * The dev-tree form of the `__nimbus-extension` role, inline. In a dev tree the self-role would be
 * `bun <gateway>/src/index.ts __nimbus-extension <entry>`, and the confined child cannot load the
 * gateway's own source: it is not granted, and on Windows Bun's loader needs FILE_WRITE_ATTRIBUTES
 * on every module it opens. This does exactly what `run-extension-entry.ts` does, with no file of
 * its own to load. FULLY STATIC: the entry travels as the one argument after the code
 * (`bun -e <code> <entry>` hands the child `process.argv = [bun, <entry>]`), never interpolated.
 * A compiled binary does not honour `-e`, and runs the real self-role instead. That compiled
 * path is REASONED from a compiled probe (a `bun build --compile` binary importing a file from a
 * directory the AppContainer grants write), not exercised end to end: the e2e runs a dev tree.
 */
const DEV_EXTENSION_ROLE_INLINE = [
  'const { isAbsolute } = await import("node:path");',
  'const { pathToFileURL } = await import("node:url");',
  "const entry = process.argv.length === 2 ? process.argv[1] : undefined;",
  'if (entry === undefined || entry === "" || !isAbsolute(entry)) {',
  '  console.error("nimbus-gateway: extension role needs an absolute entry path");',
  "  process.exit(2);",
  "}",
  "try {",
  "  await import(pathToFileURL(entry).href);",
  "} catch (err) {",
  '  console.error("nimbus-gateway: " + (err instanceof Error ? err.message : String(err)));',
  "  process.exit(2);",
  "}",
].join("\n");

export function buildExtensionSpawnSpec(
  v: StagedExtensionForSpawn,
  deps: { runtimeReadPaths: readonly string[]; sandboxDir: string; layout?: RuntimeLayout },
): ServerSpec {
  const layout = deps.layout ?? DEFAULT_RUNTIME_LAYOUT;
  const { command, args } = isCompiledBinary(layout)
    ? selfSpawn("extension", [v.entryPath], layout)
    : { command: layout.execPath, args: ["-e", DEV_EXTENSION_ROLE_INLINE, v.entryPath] };
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
  /** Test seams for the staged copy; production passes none. */
  readonly stage?: ExtensionStageDeps;
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
      // The code runs from a verified copy in the extension's own sandbox leaf, the same leaf
      // `wrapServerSpec` makes its working directory. The copy is re-digested against the digest
      // the verifier just took, and a mismatch refuses RUN_TREE_CHANGED with no stage left behind.
      const staged = stageVerifiedExtension(
        verified,
        sandboxCwdFor(deps.sandboxDir, `ext.${verified.serviceId}`),
        deps.stage,
      );
      return {
        extensionId: staged.extensionId,
        serviceId: staged.serviceId,
        spec: buildExtensionSpawnSpec(staged, {
          runtimeReadPaths: deps.runtimeReadPaths(),
          sandboxDir: deps.sandboxDir,
        }),
      };
    },
  };
}
