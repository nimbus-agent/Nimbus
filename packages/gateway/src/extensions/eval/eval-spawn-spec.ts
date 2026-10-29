import type { SandboxPermissions } from "@nimbus-dev/registry-format";

import type { ServerSpec } from "../../connectors/lazy-mesh/slot.ts";
import { wrapServerSpecInCwd } from "../../connectors/lazy-mesh/wrap-server-spec.ts";
import type { RuntimeLayout } from "../../platform/runtime-layout.ts";
import type { SandboxPolicy } from "../../platform/sandbox/sandbox-policy.ts";
import { extensionEntryCommand } from "../extension-runtime.ts";
import { extensionProcessEnv } from "../spawn-env.ts";

/** A verified package staged for an eval: the code under test, never an installed extension. */
export interface EvalStagedPackage {
  readonly serviceId: string;
  readonly version: string;
  readonly stagePath: string;
  readonly entryPath: string;
}

/** Zero reach: no network, no write, read = the runtime's own paths (a run with zero grants). */
function evalPermissions(runtimeReadPaths: readonly string[]): SandboxPermissions {
  return { network: [], filesystem: { read: [...runtimeReadPaths], write: [] } };
}

/** The policy an eval spawns under, for `canConfine` before a spawn. Id `eval.<serviceId>`. */
export function evalSandboxPolicy(
  serviceId: string,
  runtimeReadPaths: readonly string[],
): SandboxPolicy {
  return { id: `eval.${serviceId}`, permissions: evalPermissions(runtimeReadPaths) };
}

/**
 * The spawn for an eval of a staged package (extensions/eval): the same confinement as a run with
 * ZERO grants — no network, no credentials (`extensionProcessEnv({})`: baseline keys only), the
 * stage as the working directory — under the identity `eval.<serviceId>`, so it never shares an
 * `ext.` AppContainer profile. Not an I43 spawn path: it reads no Vault, no grant and no install.
 */
export function buildExtensionEvalSpawnSpec(
  s: EvalStagedPackage,
  deps: { runtimeReadPaths: readonly string[]; layout?: RuntimeLayout },
): ServerSpec {
  const { command, args } = extensionEntryCommand(s.entryPath, deps.layout);
  // Baseline keys only: an eval is handed no credential, by construction.
  const env = extensionProcessEnv({});
  return wrapServerSpecInCwd(
    { command, args, env },
    {
      id: `eval.${s.serviceId}`,
      version: s.version,
      permissions: evalPermissions(deps.runtimeReadPaths),
      updateChannel: "stable",
    },
    s.stagePath,
  );
}
