import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { selfSpawn } from "../../platform/runtime-layout.ts";
import { sandboxCwdFor } from "../../platform/sandbox/sandbox-cwd.ts";
import {
  declaresNetwork,
  isSandboxWrapperOnlyEnv,
  policyFromManifest,
  SANDBOX_CWD_ENV,
  SANDBOX_OBSERVATION_FILE_ENV,
  SANDBOX_OBSERVATION_LABEL_ENV,
  SANDBOX_POLICY_ENV,
  sandboxWrapperOnlyEnv,
} from "../../platform/sandbox/sandbox-policy.ts";
import type { ServerSpec } from "./slot.ts";

function wrapWithCwd(
  spec: ServerSpec,
  manifest: ExtensionManifest,
  cwd: string,
  wrapperEnv: Readonly<Record<string, string>> = {},
  iacProfile = false,
): ServerSpec {
  const { command, args } = selfSpawn("sandbox", [spec.command, ...spec.args]);
  return {
    command,
    args,
    env: {
      ...spec.env,
      // A child with no network needs neither, so a no-network spawn keeps exactly the baseline env.
      ...(declaresNetwork(policyFromManifest(manifest)) ? sandboxWrapperOnlyEnv() : {}),
      ...wrapperEnv,
      [SANDBOX_POLICY_ENV]: JSON.stringify({
        ...policyFromManifest(manifest),
        ...(iacProfile ? { iacProfile: true } : {}),
      }),
      [SANDBOX_CWD_ENV]: cwd,
    },
  };
}

/**
 * What `wrapperEnv` may carry: the observation channel's two keys and nothing else. Both are
 * wrapper-only (stripped from the child on every OS); the forwarder's other wrapper-only keys come
 * only from `sandboxWrapperOnlyEnv()`, so no caller can redirect the helper through this argument.
 */
const WRAPPER_ENV_KEYS: ReadonlySet<string> = new Set([
  SANDBOX_OBSERVATION_FILE_ENV,
  SANDBOX_OBSERVATION_LABEL_ENV,
]);

/** Refuses any key but the two observation keys, and re-checks each is one the wrapper strips. */
function assertWrapperOnly(wrapperEnv: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(wrapperEnv)) {
    if (!WRAPPER_ENV_KEYS.has(key) || !isSandboxWrapperOnlyEnv(key)) {
      throw new Error(
        `wrapperEnv may carry only the observation wrapper-only variables, not ${key}`,
      );
    }
  }
}

/**
 * I15: every connector ServerSpec passes through here, so the sandbox is not optional. The wrapper
 * runs as the `__nimbus-sandbox` role of this same executable — previously it was
 * `process.execPath` plus a path to sandbox-wrapper.ts, which does not exist in a compiled binary.
 *
 * The working directory is a per-policy leaf (`sandboxCwdFor(sandboxRoot, manifest.id)`) under a
 * root that is never the data or config dir (spec § A); the sandbox wrapper creates it before spawn.
 */
export function wrapServerSpec(
  spec: ServerSpec,
  manifest: ExtensionManifest,
  sandboxRoot: string,
): ServerSpec {
  return wrapWithCwd(spec, manifest, sandboxCwdFor(sandboxRoot, manifest.id));
}

/**
 * `wrapServerSpec` with an EXACT working directory instead of a per-policy leaf. Only for a spawn
 * whose cwd is already a directory of its own — a generated tool runs in its script's directory,
 * an approved extension in its fresh per-spawn stage (I43). Never pass `paths.dataDir` or
 * `paths.configDir` here.
 *
 * `wrapperEnv` is for the WRAPPER, never the child: it may carry only the two observation keys,
 * both of which the wrapper strips before its child starts, and any other key throws. An approved extension's
 * observation prefix and label ride here (I43), so the child never learns where its evidence goes.
 */
export function wrapServerSpecInCwd(
  spec: ServerSpec,
  manifest: ExtensionManifest,
  cwd: string,
  wrapperEnv?: Readonly<Record<string, string>>,
): ServerSpec {
  if (wrapperEnv !== undefined) assertWrapperOnly(wrapperEnv);
  return wrapWithCwd(spec, manifest, cwd, wrapperEnv);
}

/**
 * The iac connector's per-run iac child, D2, OR-D2-5, static D43(d): `wrapServerSpecInCwd` plus the
 * policy's `iacProfile` flag, which gives a Linux child the seccomp program that answers
 * `pidfd_send_signal` with ENOSYS (Terraform's Go runtime probes it) and makes the Windows wrapper
 * release the run's grants on exit. The ONLY function that sets the flag; only
 * `connectors/lazy-mesh/iac-runner.ts` may call it (a static rule pins that), and it takes the
 * exact per-run working directory, never `dataDir`, `configDir` or the iac root.
 */
export function wrapIacServerSpec(
  spec: ServerSpec,
  manifest: ExtensionManifest,
  cwd: string,
): ServerSpec {
  return wrapWithCwd(spec, manifest, cwd, {}, true);
}
