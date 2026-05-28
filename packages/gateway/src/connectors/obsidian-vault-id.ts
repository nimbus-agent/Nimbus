import { createHash } from "node:crypto";
import { basename } from "node:path";

export function vaultIdFromAbsolutePath(absolutePath: string): string {
  return createHash("sha256").update(absolutePath).digest("hex").slice(0, 12);
}

export function formatVaultName(absolutePath: string): string {
  const trimmed = absolutePath.replace(/[/\\]+$/, "");
  return basename(trimmed);
}
