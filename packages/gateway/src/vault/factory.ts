import { platform } from "node:os";

import { PlatformInitError } from "../platform/errors.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import type { NimbusVault } from "./nimbus-vault.ts";

export async function createNimbusVault(paths: PlatformPaths): Promise<NimbusVault> {
  const p = platform();
  switch (p) {
    case "win32":
      return new (await import("./win32.ts")).DpapiVault(paths);
    case "darwin":
      return new (await import("./darwin.ts")).DarwinKeychainVault(paths);
    case "linux":
      return new (await import("./linux.ts")).LinuxSecretToolVault();
    default:
      throw new PlatformInitError(`Unsupported platform for vault: ${p}`);
  }
}
