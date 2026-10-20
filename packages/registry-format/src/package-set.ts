/**
 * The package file set: the ONLY files of an extension directory that go into a registry package.
 * `nimbus.extension.json`, everything under `dist/`, and top-level README / LICENSE files.
 * Anything else (node_modules, src, tests, dotfiles) is left out.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const PACKAGE_MANIFEST_FILE = "nimbus.extension.json";
const DIST_DIR = "dist";
const DOC_FILE_RE = /^(README|LICENSE)(\..+)?$/i;

/** Whether a `/`-separated path relative to the extension root belongs to the package file set. */
export function isPackageFile(relPath: string): boolean {
  if (relPath === PACKAGE_MANIFEST_FILE) return true;
  if (relPath.startsWith(`${DIST_DIR}/`)) return relPath.length > DIST_DIR.length + 1;
  return !relPath.includes("/") && DOC_FILE_RE.test(relPath);
}

function collectDist(root: string, rel: string, out: string[]): void {
  for (const name of readdirSync(join(root, rel))) {
    const relPath = `${rel}/${name}`;
    const st = lstatSync(join(root, relPath));
    if (st.isSymbolicLink()) throw new Error(`refusing to pack a symlink: ${relPath}`);
    if (st.isDirectory()) collectDist(root, relPath, out);
    else if (st.isFile()) out.push(relPath);
    else throw new Error(`refusing to pack a special file: ${relPath}`);
  }
}

/**
 * The package files of `dir`: sorted by UTF-16 code unit, `/`-separated. A symlink or special file
 * INSIDE the set is refused; entries outside it are never looked at, so a `node_modules` link is fine.
 */
export function listPackageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name !== DIST_DIR && !isPackageFile(name)) continue;
    const st = lstatSync(join(dir, name));
    if (st.isSymbolicLink()) throw new Error(`refusing to pack a symlink: ${name}`);
    if (name === DIST_DIR) {
      if (st.isDirectory()) collectDist(dir, name, out);
      else throw new Error(`refusing to pack ${DIST_DIR}: it is not a directory`);
    } else if (st.isFile()) out.push(name);
    else throw new Error(`refusing to pack a special file: ${name}`);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
