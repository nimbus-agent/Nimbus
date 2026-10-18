/** Unpacks a registry package into a private work dir and reads what the index will record. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { extract, list } from "tar";
import { MAX_ENTRY_COUNT, MAX_MANIFEST_BYTES, MAX_UNPACKED_BYTES } from "./caps.ts";
import { RegistryError } from "./errors.ts";
import { rawManifestEntryRelPath } from "./manifest.ts";
import { PACKAGE_MANIFEST_FILE } from "./package-set.ts";

export interface InspectedPackage {
  manifestBytes: Buffer;
  manifest: Record<string, unknown>;
  entryHash: string;
  /** Every file in the archive, `/`-separated, sorted. */
  files: string[];
}

function describeEntryType(type: string): string {
  if (type === "SymbolicLink") return "symlink";
  if (type === "Link") return "hardlink";
  return `${type} entry`;
}

const extractFailed = (detail: string): RegistryError =>
  new RegistryError("ERR_REGISTRY_EXTRACT_FAILED", detail);
const manifestInvalid = (detail: string): RegistryError =>
  new RegistryError("ERR_REGISTRY_MANIFEST_INVALID", detail);

/**
 * Refuses a package every client would refuse BEFORE extracting anything (entry types, entry count,
 * declared unpacked size), then extracts into `<work>/x` and reads the manifest and entry file.
 */
export async function inspectPackage(tgz: string, work: string): Promise<InspectedPackage> {
  let entries = 0;
  let declaredBytes = 0;
  let badEntry: string | undefined;
  const files: string[] = [];
  await list({
    file: tgz,
    onReadEntry: (entry) => {
      entries++;
      if (badEntry === undefined && entry.type !== "File" && entry.type !== "Directory") {
        badEntry = `package entry ${entry.path} is a ${describeEntryType(entry.type)}; only files and directories are allowed`;
      }
      if (entry.type === "File") files.push(entry.path.replaceAll("\\", "/"));
      declaredBytes += entry.size ?? 0;
      entry.resume();
    },
  });
  if (badEntry !== undefined) throw extractFailed(badEntry);
  if (entries > MAX_ENTRY_COUNT) {
    throw extractFailed(`package has more than ${String(MAX_ENTRY_COUNT)} entries`);
  }
  if (declaredBytes > MAX_UNPACKED_BYTES) {
    throw extractFailed("package unpacked size exceeds 200 MiB");
  }
  const out = join(work, "x");
  mkdirSync(out);
  await extract({
    file: tgz,
    cwd: out,
    strict: true,
    filter: (_path, entry) => {
      const type = "type" in entry ? entry.type : "File";
      return type === "File" || type === "Directory";
    },
  });
  const manifestPath = join(out, PACKAGE_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw manifestInvalid(`package has no ${PACKAGE_MANIFEST_FILE} at its root`);
  }
  const manifestBytes = readFileSync(manifestPath);
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw manifestInvalid("manifest is too large");
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw manifestInvalid("manifest is not valid JSON");
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw manifestInvalid("manifest is not a JSON object");
  }
  const m = manifest as Record<string, unknown>;
  // The gateway's rule (`entry`, else the `entrypoint` alias, else the default), so the hash
  // recorded is the hash of the file a client will run.
  const entryRel = rawManifestEntryRelPath(m);
  const entryPath = resolve(out, entryRel);
  if (!entryPath.startsWith(resolve(out) + sep) || !existsSync(entryPath)) {
    throw manifestInvalid(`extension entry ${entryRel} is missing or outside the package`);
  }
  return {
    manifestBytes,
    manifest: m,
    entryHash: createHash("sha256").update(readFileSync(entryPath)).digest("hex"),
    files: files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}
