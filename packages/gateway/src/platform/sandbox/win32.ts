import type { ChildProcess } from "node:child_process";
import type { SandboxPolicy } from "./sandbox-policy.ts";
import type { SandboxRunner, SandboxSpawnOptions } from "./sandbox-runner.ts";

export function profileNameFor(manifest: { id: string }): string {
  return `nimbus-ext-${manifest.id}`;
}

export function capabilitiesForPolicy(policy: SandboxPolicy): string[] {
  const caps: string[] = [];
  if (policy.permissions.network.length > 0) {
    caps.push("internetClient");
  }
  return caps;
}

export function createWin32SandboxRunner(): SandboxRunner {
  return {
    platform: "win32",
    spawn(_cmd: string, _args: string[], _opts: SandboxSpawnOptions): ChildProcess {
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
      return false;
    },
    degradedReason(): string | null {
      return "Windows: per-host network filtering is degraded to all-or-nothing in T2 PR 1; see docs/sandbox.md#platform-asymmetry";
    },
  };
}
