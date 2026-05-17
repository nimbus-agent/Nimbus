import type { ChildProcess } from "node:child_process";
import type { ExtensionManifest } from "../../extensions/manifest.ts";
import type { SandboxRunner, SandboxSpawnOptions } from "./sandbox-runner.ts";

/**
 * Derive the AppContainer profile name from an extension id.
 * Format: `nimbus-ext-<id>`. Used by `CreateAppContainerProfile`
 * at install (Task 12 FFI follow-up) and by the orphan-reap
 * cross-reference at Gateway startup (Task 11).
 */
export function profileNameFor(manifest: { id: string }): string {
  return `nimbus-ext-${manifest.id}`;
}

/**
 * Derive the AppContainer capability list from a manifest.
 * Currently: `internetClient` iff `permissions.network` is non-empty.
 * Empty array means no network capability.
 *
 * Windows is intentionally all-or-nothing in PR 1; per-host filtering
 * would require WFP callout drivers (kernel-mode signing + Windows
 * Hardware Program enrollment) and is a tracked follow-up. See
 * docs/sandbox.md#platform-asymmetry.
 */
export function capabilitiesForManifest(manifest: ExtensionManifest): string[] {
  const caps: string[] = [];
  if (manifest.permissions.network.length > 0) {
    caps.push("internetClient");
  }
  return caps;
}

export function createWin32SandboxRunner(): SandboxRunner {
  return {
    platform: "win32",
    spawn(_cmd: string, _args: string[], _opts: SandboxSpawnOptions): ChildProcess {
      // Implementation uses bun:ffi to call:
      //   userenvapi.dll!CreateAppContainerProfile
      //   userenvapi.dll!DeriveAppContainerSidFromAppContainerName
      //   advapi32.dll!CreateProcessAsUserW
      //   kernel32.dll!InitializeProcThreadAttributeList
      //   kernel32.dll!UpdateProcThreadAttribute
      //
      // The full FFI surface is large; the plan defers this to a
      // tracked follow-up sub-issue ("T2 PR 1 Windows FFI").
      // PR 1 ships the AppContainer profile name + capability surface
      // (testable + load-bearing for the orphan-reap) and routes the
      // spawn call to a user-friendly error pointing at the docs.
      throw new Error(
        "Windows sandbox spawn FFI is a work-in-progress in PR 1 — " +
          "the AppContainer profile + capability surface is locked but the " +
          "CreateProcessAsUserW FFI binding lands in the tracked follow-up. " +
          "See docs/sandbox.md#windows-platform-status. " +
          "If you are seeing this error in production, file an issue with " +
          "your Nimbus version + extension id.",
      );
    },
    isFullyActive(): boolean {
      // Returns false on Windows because per-host network filtering
      // is not enforced (asymmetry). The `internetClient` capability
      // grants all-or-nothing network when permissions.network is
      // non-empty. PR 1 accepts this gap; WFP per-host filtering is
      // the tracked follow-up.
      return false;
    },
    degradedReason(): string | null {
      return "Windows: per-host network filtering is degraded to all-or-nothing in T2 PR 1; see docs/sandbox.md#platform-asymmetry";
    },
  };
}
