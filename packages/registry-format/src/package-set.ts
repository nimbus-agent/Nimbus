/**
 * The package file set: the ONLY files of an extension directory that go into a registry package.
 * `nimbus.extension.json`, everything under `dist/` and `evals/`, and top-level README / LICENSE files.
 * Anything else (node_modules, src, tests, dotfiles) is left out.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { codeUnitCompare } from "./code-unit-compare.ts";

export const PACKAGE_MANIFEST_FILE = "nimbus.extension.json";
/** The eval suites directory (`evals/<name>.eval.json`); defined here so `eval-suite.ts` can import the file set. */
export const EVALS_DIR = "evals";
const DIST_DIR = "dist";
const DOC_FILE_RE = /^(README|LICENSE)(\..+)?$/i;

/** Whether a `/`-separated path relative to the extension root belongs to the package file set. */
export function isPackageFile(relPath: string): boolean {
  if (relPath === PACKAGE_MANIFEST_FILE) return true;
  if (relPath.startsWith(`${DIST_DIR}/`)) return relPath.length > DIST_DIR.length + 1;
  if (relPath.startsWith(`${EVALS_DIR}/`)) return relPath.length > EVALS_DIR.length + 1;
  return !relPath.includes("/") && DOC_FILE_RE.test(relPath);
}

function collectTree(root: string, rel: string, out: string[]): void {
  for (const name of readdirSync(join(root, rel))) {
    const relPath = `${rel}/${name}`;
    const st = lstatSync(join(root, relPath));
    if (st.isSymbolicLink()) throw new Error(`refusing to pack a symlink: ${relPath}`);
    if (st.isDirectory()) collectTree(root, relPath, out);
    else if (st.isFile()) out.push(relPath);
    else throw new Error(`refusing to pack a special file: ${relPath}`);
  }
}

/**
 * The package files of `dir`: sorted by UTF-16 code unit, `/`-separated. A symlink or special file
 * INSIDE the set is refused; entries outside it are never looked at, so a `node_modules` link is fine.
 * `dist` and `evals` are reserved directory names: each must be a directory, and both are walked.
 */
export function listPackageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name !== DIST_DIR && name !== EVALS_DIR && !isPackageFile(name)) continue;
    const st = lstatSync(join(dir, name));
    if (st.isSymbolicLink()) throw new Error(`refusing to pack a symlink: ${name}`);
    if (name === DIST_DIR || name === EVALS_DIR) {
      if (st.isDirectory()) collectTree(dir, name, out);
      else throw new Error(`refusing to pack ${name}: it is not a directory`);
    } else if (st.isFile()) out.push(name);
    else throw new Error(`refusing to pack a special file: ${name}`);
  }
  return out.sort(codeUnitCompare);
}
