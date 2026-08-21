import type { ExtensionManifest } from "../../extensions/manifest.ts";
import type { SandboxPermissions } from "../../extensions/permissions-validator.ts";

/**
 * What a sandbox runner needs to know to confine a process.
 *
 * Deliberately NOT an `ExtensionManifest`: the runners only ever read `.permissions` and `.id`,
 * and a one-shot execution has no manifest to offer. Keeping the input this narrow is what lets
 * a per-execution capability set reach the same three runners a connector uses.
 */
export interface SandboxPolicy {
  /** Naming key. The Windows AppContainer profile name derives from it; Linux/macOS ignore it. */
  readonly id: string;
  readonly permissions: SandboxPermissions;
  /**
   * One-shot executions only. DECLARED BUT NOT ENFORCED by any runner in this release — the
   * execution surface adds enforcement (on Windows, a limit on the Job Object the helper already
   * assigns). Nothing may treat a set value here as a guarantee.
   */
  readonly limits?: { readonly wallClockMs?: number };
}

/** The single manifest -> policy derivation. `wrapServerSpec` is its only production caller. */
export function policyFromManifest(manifest: ExtensionManifest): SandboxPolicy {
  return { id: manifest.id, permissions: manifest.permissions };
}
