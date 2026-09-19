import { platform } from "node:os";

import { PlatformInitError } from "../platform/errors.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import { EphemeralVault } from "./ephemeral.ts";
import type { NimbusVault } from "./nimbus-vault.ts";

export async function createNimbusVault(paths: PlatformPaths): Promise<NimbusVault> {
  // I41 clause 3: a demo-rooted process never opens the OS credential store. On macOS (Keychain,
  // fixed service `dev.nimbus`) and Linux (libsecret) that store is NOT under configDir, so path
  // isolation alone would hand a demo gateway the owner's real credentials.
  if (paths.demo === true) {
    return new EphemeralVault();
  }

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
