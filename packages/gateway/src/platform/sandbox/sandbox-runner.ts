import type { ChildProcess, SpawnOptions } from "node:child_process";
import { platform } from "node:os";
import type { SandboxPolicy } from "./sandbox-policy.ts";

export interface SandboxSpawnOptions {
  policy: SandboxPolicy;
  env: Record<string, string>;
  cwd: string;
  stdio?: SpawnOptions["stdio"];
}

export interface SandboxRunner {
  readonly platform: "linux" | "darwin" | "win32";
  spawn(cmd: string, args: string[], opts: SandboxSpawnOptions): ChildProcess;
  isFullyActive(): boolean;
  degradedReason(): string | null;
}

export async function createSandboxRunner(): Promise<SandboxRunner> {
  const p = platform();
  switch (p) {
    case "linux":
      return (await import("./linux.ts")).createLinuxSandboxRunner();
    case "darwin":
      return (await import("./darwin.ts")).createDarwinSandboxRunner();
    case "win32":
      return (await import("./win32.ts")).createWin32SandboxRunner();
    default:
      throw new Error(`Unsupported platform for sandbox: ${p}`);
  }
}
