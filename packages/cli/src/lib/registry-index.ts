/**
 * CLI-side file I/O for the signed registry index. The index model, the signer and the verifier
 * live in `@nimbus-dev/registry-format`, shared with the gateway.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RegistryIndex } from "@nimbus-dev/registry-format";

/** Structural parse only: the signature is verified by the gateway, not here. */
export function readIndexFile(path: string): RegistryIndex {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path} is not a registry index object`);
  }
  const o = raw as Record<string, unknown>;
  if (
    o["format"] !== 1 ||
    typeof o["rootKey"] !== "string" ||
    typeof o["sequence"] !== "number" ||
    typeof o["generatedAt"] !== "string" ||
    typeof o["signature"] !== "string" ||
    o["extensions"] === null ||
    typeof o["extensions"] !== "object"
  ) {
    throw new Error(`${path} is not a valid registry index`);
  }
  return o as unknown as RegistryIndex;
}

export function writeIndexAtomic(dir: string, index: RegistryIndex): void {
  const tmp = join(dir, `index.json.${String(process.pid)}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`);
  renameSync(tmp, join(dir, "index.json"));
}
