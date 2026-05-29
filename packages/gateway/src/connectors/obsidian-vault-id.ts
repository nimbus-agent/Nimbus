import { createHash } from "node:crypto";
import { basename } from "node:path";
import { stripTrailingChars } from "../util/strip-affixes.ts";

export function vaultIdFromAbsolutePath(absolutePath: string): string {
  return createHash("sha256").update(absolutePath).digest("hex").slice(0, 12);
}

export function formatVaultName(absolutePath: string): string {
  const trimmed = stripTrailingChars(absolutePath, "/\\");
  return basename(trimmed);
}
