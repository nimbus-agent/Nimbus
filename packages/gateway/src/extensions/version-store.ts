import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import semver from "semver";

/**
 * The versions area: where an extension's previous versions, in-flight upgrades and swap scratch
 * space live. It is a SIBLING of `extensionsDir`, never inside an install dir, so the install path
 * stays the flat `<extensionsDir>/<id>` that install writes and the row records.
 *
 * Keyed by a slug of the id (not the id itself) because ids may contain `/` or differ only in
 * punctuation (`acme/foo` vs `acme-foo`), which must not share a directory.
 */
export function extensionVersionsRoot(extensionsDir: string): string {
  return join(dirname(extensionsDir), "extension-versions");
}

export function extensionSlug(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex").slice(0, 16);
}

function slugDir(extensionsDir: string, id: string): string {
  return join(extensionVersionsRoot(extensionsDir), extensionSlug(id));
}

export function prevVersionsDir(extensionsDir: string, id: string): string {
  return join(slugDir(extensionsDir, id), "prev");
}

export function prevVersionDir(extensionsDir: string, id: string, version: string): string {
  return join(prevVersionsDir(extensionsDir, id), version);
}

export function pendingDir(extensionsDir: string, id: string, version: string): string {
  return join(slugDir(extensionsDir, id), "pending", version);
}

export function holdingDir(extensionsDir: string, id: string): string {
  return join(slugDir(extensionsDir, id), "holding");
}

/** Scratch directory the downgrade swap parks the current install in. */
export function swapBufferDir(extensionsDir: string, id: string): string {
  return join(slugDir(extensionsDir, id), "swap-buffer");
}

/** The semver-greatest entry of `prev/`; entries that are not semver are ignored. */
export function newestPrevVersion(extensionsDir: string, id: string): string | undefined {
  const dir = prevVersionsDir(extensionsDir, id);
  if (!existsSync(dir)) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  let best: string | undefined;
  for (const e of entries) {
    if (semver.valid(e) === null) continue;
    if (best === undefined || Bun.semver.order(e, best) > 0) best = e;
  }
  return best;
}

export function removeExtensionVersionStore(extensionsDir: string, id: string): void {
  rmSync(slugDir(extensionsDir, id), { recursive: true, force: true });
}
