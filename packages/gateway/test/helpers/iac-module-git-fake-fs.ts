// packages/gateway/test/helpers/iac-module-git-fake-fs.ts
// An injected filesystem for `lazy-mesh/iac-runner/iac-module-git.ts` tests: the cases a real disk
// cannot produce on demand (hostile names, a link swapped in between a listing and an lstat).
import type { Dirent } from "node:fs";
import { basename, dirname } from "node:path";
import type { ModuleGitFs } from "../../src/connectors/lazy-mesh/iac-runner/iac-module-git.ts";

export function dirent(name: string, kind: "dir" | "file" | "link"): Dirent {
  return {
    name,
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "link",
  } as unknown as Dirent;
}

export type FakeModuleGitFs = ModuleGitFs & {
  readonly removed: string[];
  readonly touched: string[];
  readonly listed: string[];
};

/**
 * A fake disk: `tree` maps a directory to its entries; every path is its own realpath. `lstatKind`
 * answers from the tree (a listed directory) or from the parent's listing (a file or a link).
 */
export function fakeFs(
  tree: Record<string, Dirent[]>,
  over: Partial<ModuleGitFs> = {},
): FakeModuleGitFs {
  const removed: string[] = [];
  const touched: string[] = [];
  const listed: string[] = [];
  return {
    removed,
    touched,
    listed,
    readDir: (d) => {
      const e = tree[d];
      if (e === undefined) throw new Error("ENOENT");
      listed.push(d);
      return e;
    },
    lstatKind: (p) => {
      if (tree[p] !== undefined) return "dir";
      const entry = tree[dirname(p)]?.find((e) => e.name === basename(p));
      if (entry === undefined) return undefined;
      if (entry.isSymbolicLink()) return "link";
      return entry.isDirectory() ? "dir" : "other";
    },
    realpath: (p) => p,
    makeWritable: (p) => {
      touched.push(p);
    },
    removeTree: (p) => {
      removed.push(p);
    },
    ...over,
  };
}
