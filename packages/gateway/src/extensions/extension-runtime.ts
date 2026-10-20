import { listExtensions } from "../automation/extension-store.ts";
import {
  type ExtensionManifestReader,
  indexServiceIdForCodeServer,
} from "../connectors/extension-sync/extension-identity.ts";
import type { ExtensionSlotSource } from "../connectors/lazy-mesh/extension-slot-source.ts";
import type { ServerSpec } from "../connectors/lazy-mesh/slot.ts";
import { wrapServerSpecInCwd } from "../connectors/lazy-mesh/wrap-server-spec.ts";
import {
  DEFAULT_RUNTIME_LAYOUT,
  isCompiledBinary,
  type RuntimeLayout,
  selfSpawn,
} from "../platform/runtime-layout.ts";
import { extensionStageRootFor } from "../platform/sandbox/sandbox-cwd.ts";
import { readCredentialEnv } from "./extension-credentials.ts";
import {
  type ExtensionStageDeps,
  removeBestEffort,
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
 * verified per-spawn copy, a fresh gateway-owned directory that the sandbox grants as the
 * working directory (`extension-stage.ts`).
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
 * It carries no backslash (an escape in `-e` code reached the Windows child mangled), which is why
 * the message and the stack are two `console.error` calls rather than one joined string.
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
  "  if (err instanceof Error && err.stack !== undefined) console.error(err.stack);",
  "  process.exit(2);",
  "}",
].join("\n");

/**
 * Bun flags for the dev-tree form, ahead of `-e`. Neither is the boundary — the fresh per-spawn
 * stage is (`extension-stage.ts`) — they are hardening: `--no-env-file` stops a `.env` in the
 * working directory being loaded into the child's environment, and `--no-install` stops a missing
 * bare import from auto-installing code from a registry.
 */
const DEV_EXTENSION_BUN_FLAGS = ["--no-env-file", "--no-install"] as const;

/**
 * The child's environment is `extensionProcessEnv(credentialEnv)` (I1): the fixed baseline plus
 * the credential values `prepareSpawn` read from the Vault for the VERIFIED credential mapping,
 * and nothing else. This is the only path a credential value takes to the child; it never travels
 * in argv or in the sandbox policy.
 *
 * The child runs with the STAGE as its working directory (`wrapServerSpecInCwd`), never the
 * per-policy leaf `wrapServerSpec` would derive: a leaf persists across spawns, a stage is created
 * for this spawn alone. The sandbox manifest id stays `ext.<serviceId>`, which is what keys the
 * Windows AppContainer profile.
 */
export function buildExtensionSpawnSpec(
  v: StagedExtensionForSpawn,
  deps: {
    runtimeReadPaths: readonly string[];
    layout?: RuntimeLayout;
    /** env var -> value, from `readCredentialEnv` over the verified credentials. */
    credentialEnv: Readonly<Record<string, string>>;
  },
): ServerSpec {
  const layout = deps.layout ?? DEFAULT_RUNTIME_LAYOUT;
  const { command, args } = isCompiledBinary(layout)
    ? selfSpawn("extension", [v.entryPath], layout)
    : {
        command: layout.execPath,
        args: [...DEV_EXTENSION_BUN_FLAGS, "-e", DEV_EXTENSION_ROLE_INLINE, v.entryPath],
      };
  return wrapServerSpecInCwd(
    { command, args, env: extensionProcessEnv(deps.credentialEnv) },
    buildExtensionRuntimeManifest(v, deps.runtimeReadPaths),
    v.stagePath,
  );
}

export type ExtensionSlotSourceDeps = VerifiedExtensionDeps & {
  readonly sandboxDir: string;
  /** A thunk so it is recomputed per spawn. */
  readonly runtimeReadPaths: () => readonly string[];
  readonly isConnectorAllowed: (serviceId: string) => boolean;
  readonly verify?: typeof readVerifiedExtensionForSpawn;
  /** Test seam for the manifest read behind the policy id; production reads the install tree. */
  readonly readManifest?: ExtensionManifestReader;
  /** Test seams for the staged copy; production passes none. */
  readonly stage?: ExtensionStageDeps;
};

export function createExtensionSlotSource(deps: ExtensionSlotSourceDeps): ExtensionSlotSource {
  const verify = deps.verify ?? readVerifiedExtensionForSpawn;
  // Org policy names the INDEX id (`readwise` for a bound extension, else the `ext_` id). Derived
  // from the installed manifest and the same continuity table the verifier binds with; a spawn is
  // still refused by the verifier (step 9) if that manifest was tampered with. Bound: the id is read
  // from the hash-checked on-disk manifest BEFORE verify, and an unreadable manifest falls back to
  // the ext_ id — so if it is unreadable here but readable at verify time, an allowlist naming only
  // the ext_ id admits the spawn (no wider than before index-id policy existed).
  const policyIdFor = (serviceId: string): string =>
    indexServiceIdForCodeServer(deps.db, serviceId, deps.continuityTable, deps.readManifest);
  return {
    isAllowed(serviceId) {
      return deps.isConnectorAllowed(policyIdFor(serviceId));
    },
    disabledExtensionIdFor(serviceId) {
      const grant = listRunGrants(deps.db).find((g) => g.service_id === serviceId);
      if (grant === undefined) return undefined;
      const row = listExtensions(deps.db).find((r) => r.id === grant.extension_id);
      return row !== undefined && row.enabled !== 1 ? row.id : undefined;
    },
    listServiceIds() {
      const enabled = new Set(
        listExtensions(deps.db)
          .filter((r) => r.enabled === 1)
          .map((r) => r.id),
      );
      return listRunGrants(deps.db)
        .filter((g) => enabled.has(g.extension_id))
        .map((g) => g.service_id)
        .sort((a, b) => a.localeCompare(b));
    },
    async prepareSpawn(serviceId) {
      const grant = listRunGrants(deps.db).find((g) => g.service_id === serviceId);
      if (grant === undefined) {
        throw new ExtensionRunGrantError(
          "ERR_EXTENSION_RUN_NOT_APPROVED",
          `no extension run approval carries service id "${serviceId}"`,
        );
      }
      const policyId = policyIdFor(serviceId);
      if (!deps.isConnectorAllowed(policyId)) {
        throw new ExtensionRunGrantError(
          "ERR_EXTENSION_RUN_POLICY",
          `organization policy does not allow ${policyId}`,
        );
      }
      const verified = await verify(grant.extension_id, deps);
      if (verified.serviceId !== serviceId) {
        throw new ExtensionRunGrantError(
          "ERR_EXTENSION_RUN_CHANGED",
          `${grant.extension_id}'s service id changed; approve it again`,
        );
      }
      // Values for exactly the credentials the verifier re-resolved and found equal to the approved
      // grant; a blank or missing Vault value is omitted, never passed as "". Read before staging,
      // so a Vault failure leaves no stage behind.
      const credentialEnv = await readCredentialEnv(deps.vault, verified.credentials);
      // The code runs from a verified copy in a fresh, gateway-owned stage that is also the
      // child's working directory. The copy is re-digested against the digest the verifier just
      // took, and a mismatch refuses RUN_TREE_CHANGED with no stage left behind.
      const staged = stageVerifiedExtension(
        verified,
        extensionStageRootFor(deps.sandboxDir, verified.serviceId),
        deps.stage,
      );
      return {
        extensionId: staged.extensionId,
        serviceId: staged.serviceId,
        spec: buildExtensionSpawnSpec(staged, {
          runtimeReadPaths: deps.runtimeReadPaths(),
          credentialEnv,
        }),
        discard: () => removeBestEffort(staged.stagePath),
      };
    },
  };
}
