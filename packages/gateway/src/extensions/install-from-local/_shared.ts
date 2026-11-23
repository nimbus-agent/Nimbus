import { createHash } from "node:crypto";
import { join } from "node:path";
import { assertSafeExtensionId } from "@nimbus-dev/registry-format";

export function sha256HexOfBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function extensionInstallDirectory(extensionsDir: string, extensionId: string): string {
  assertSafeExtensionId(extensionId);
  const normalized = extensionId.replaceAll("\\", "/");
  const parts = normalized.split("/").filter((p) => p !== "" && p !== ".");
  return join(extensionsDir, ...parts);
}
