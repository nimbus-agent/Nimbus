import { spawnSync } from "node:child_process";
import { type Dirent, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import * as tar from "tar";

import { resolveExtensionManifestPath } from "./manifest.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";

/**
 * `platform`/`env` default to the live process and exist so the Windows branch can be exercised on
 * any host — every production caller passes neither.
 */
export function resolveSystemTarCommand(
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (platform !== "win32") {
    return "tar";
  }
  const root = env["SystemRoot"] ?? env["windir"];
  if (root !== undefined && root !== "") {
    return join(root, "System32", "tar.exe");
  }
  return join("C:", "Windows", "System32", "tar.exe");
}

function checkExtractedEntry(absRoot: string, dir: string, ent: Dirent, stack: string[]): void {
  const full = join(dir, ent.name);
  const rel = relative(absRoot, resolve(full));
  if (rel.startsWith("..") || rel === "..") {
    throw new Error(`archive entry escapes install root: ${full}`);
  }
  const st = lstatSync(full);
  if (st.isSymbolicLink()) {
    throw new Error(`archive contains symlink: ${full}`);
  }
  if (st.isDirectory()) stack.push(full);
}

function assertNoEntryEscapes(destDir: string): void {
  const absRoot = resolve(destDir);
  const stack: string[] = [absRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      checkExtractedEntry(absRoot, dir, ent, stack);
    }
  }
}

export function extractTarGzToDirectory(archivePath: string, destDir: string): void {
  const cmd = resolveSystemTarCommand();
  const args = ["-x", "-z"];
  if (process.platform === "linux") {
    args.push("--no-overwrite-dir", "--no-same-owner", "--no-same-permissions");
  }
  args.push(`--file=${resolve(archivePath)}`, `--directory=${resolve(destDir)}`);
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) {
    const output = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim();
    const detail = output || `exit ${String(r.status)}`;
    throw new Error(`failed to extract archive: ${detail}`);
  }
  assertNoEntryEscapes(destDir);
}

/** Total declared (unpacked) bytes an extension package may carry. */
export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
/** Total entries (files and directories) an extension package may carry. */
export const MAX_PACKAGE_ENTRIES = 5000;

export type ExtractedPackage = { sourceRoot: string; treeDigest: string };

function hasEscapingPath(path: string): boolean {
  // Windows tar treats "\\" as a separator and a drive letter as absolute, so both are refused on every host.
  if (isAbsolute(path) || path.startsWith("/") || path.startsWith("\\")) return true;
  if (/^[A-Za-z]:/.test(path)) return true;
  return path.split(/[\\/]/).includes("..");
}

/** Plain-words name for a refused tar entry type, so the refusal reads as what it is. */
function plainEntryType(type: string): string {
  if (type === "SymbolicLink") return "symlink";
  if (type === "Link") return "hardlink";
  return type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/**
 * Reads the archive's headers only, writing nothing, and refuses a package that is too large, has too
 * many entries, or carries anything but plain files and directories (links, devices, FIFOs) or a path
 * that is absolute or climbs with `..`. Declared sizes are summed, so an archive cannot hide its
 * weight from this scan; the tar extractor then runs only on an archive that passed.
 */
async function scanPackage(archivePath: string): Promise<void> {
  let entries = 0;
  let bytes = 0;
  let refused: string | undefined;
  await tar.t({
    file: archivePath,
    onReadEntry: (entry) => {
      entries += 1;
      bytes += entry.size;
      if (refused === undefined && entry.type !== "File" && entry.type !== "Directory") {
        refused = `${entry.path} (${plainEntryType(entry.type)})`;
      } else if (refused === undefined && hasEscapingPath(entry.path)) {
        refused = entry.path;
      }
    },
  });
  if (refused !== undefined) {
    throw new Error(`package_entry_refused: ${refused}`);
  }
  if (entries > MAX_PACKAGE_ENTRIES) {
    throw new Error(
      `package_too_large: ${String(entries)} entries (max ${String(MAX_PACKAGE_ENTRIES)})`,
    );
  }
  if (bytes > MAX_UNPACKED_BYTES) {
    throw new Error(
      `package_too_large: ${String(bytes)} bytes unpacked (max ${String(MAX_UNPACKED_BYTES)})`,
    );
  }
}

export function findExtensionSourceRootInTree(extractedRoot: string): string {
  if (resolveExtensionManifestPath(extractedRoot) !== undefined) {
    return extractedRoot;
  }
  for (const ent of readdirSync(extractedRoot, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      const sub = join(extractedRoot, ent.name);
      if (resolveExtensionManifestPath(sub) !== undefined) {
        return sub;
      }
    }
  }
  throw new Error(
    "archive does not contain nimbus.extension.json (at root or one subdirectory deep)",
  );
}

/**
 * The one way an extension archive becomes a directory, for install and update alike: scan the
 * headers against the caps, extract, find the package root, and digest it — all before the caller
 * moves a byte into an install path.
 */
export async function extractPackage(
  archivePath: string,
  destDir: string,
): Promise<ExtractedPackage> {
  await scanPackage(archivePath);
  mkdirSync(destDir, { recursive: true });
  extractTarGzToDirectory(archivePath, destDir);
  const sourceRoot = findExtensionSourceRootInTree(destDir);
  return { sourceRoot, treeDigest: computeExtensionTreeDigest(sourceRoot) };
}
