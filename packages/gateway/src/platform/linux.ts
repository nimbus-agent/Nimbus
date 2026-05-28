import { resolveSecretToolExecutable } from "../vault/linux.ts";
import { assemblePlatformServices } from "./assemble.ts";
import { PlatformInitError } from "./errors.ts";
import { createLinuxPaths } from "./paths.ts";
import type { PlatformServices } from "./types.ts";

const SECRET_TOOL_INSTALL_HINT =
  "secret-tool not found. Install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch) to use Nimbus on Linux.";

export function assertLinuxSecretToolAvailable(): void {
  if (process.env["NIMBUS_LINUX_VAULT_PROBE_STRICT_PATH"] === "1") {
    if (Bun.which("secret-tool") === null) {
      throw new PlatformInitError(SECRET_TOOL_INSTALL_HINT);
    }
    return;
  }
  if (resolveSecretToolExecutable() === null) {
    throw new PlatformInitError(SECRET_TOOL_INSTALL_HINT);
  }
}

export async function create(): Promise<PlatformServices> {
  assertLinuxSecretToolAvailable();
  const paths = createLinuxPaths();
  return assemblePlatformServices(paths);
}
