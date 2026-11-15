// An in-memory machine for the agent kit tests: no real home directory is ever read or written.
import { dirname, join, resolve } from "node:path";

import type { ApplyFs } from "./apply.ts";
import type { KitEnv, PathKind } from "./kit-types.ts";

export const HOME = resolve("/fake-home");
export const REPO = resolve("/fake-repo");
export const NIMBUS = "nimbus";

export interface FakeMachine {
  readonly env: KitEnv;
  readonly files: Map<string, string>;
  readonly links: Set<string>;
  readonly vars: Record<string, string | undefined>;
  /** An `ApplyFs` over the same files; `renames` counts attempts. */
  readonly fs: ApplyFs & { renames: number; renameError?: () => Error | undefined; slept: number };
}

/** A machine whose working directory is a repository (it has a `.git` entry). */
export function fakeMachine(initial: Record<string, string> = {}, repo = true): FakeMachine {
  const files = new Map<string, string>(Object.entries(initial));
  const links = new Set<string>();
  const vars: Record<string, string | undefined> = {};
  if (repo) files.set(join(REPO, ".git", "HEAD"), "ref: refs/heads/main\n");
  const kind = (path: string): PathKind => {
    if (links.has(path)) return "link";
    if (files.has(path)) return "file";
    for (const f of files.keys()) {
      if (dirname(f) === path || f.startsWith(join(path, "x").slice(0, -1))) return "dir";
    }
    return "absent";
  };
  const env: KitEnv = {
    home: HOME,
    cwd: REPO,
    nimbus: NIMBUS,
    read: (p) => files.get(p) ?? null,
    kind,
    envVar: (n) => vars[n],
  };
  const fs: FakeMachine["fs"] = {
    renames: 0,
    slept: 0,
    read: (p) => files.get(p) ?? null,
    kind,
    exists: (p) => files.has(p),
    mkdirp: () => {},
    copy: (from, to) => {
      files.set(to, files.get(from) ?? "");
    },
    write: (p, text) => {
      if (files.has(p)) throw new Error(`EEXIST ${p}`);
      files.set(p, text);
    },
    modeOf: () => undefined,
    rename: (from, to) => {
      fs.renames += 1;
      const err = fs.renameError?.();
      if (err !== undefined) throw err;
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    remove: (p) => {
      files.delete(p);
    },
    sleep: () => {
      fs.slept += 1;
      return Promise.resolve();
    },
  };
  return { env, files, links, vars, fs };
}

/** An error with a `code`, as the file system raises. */
export function codedError(code: string): Error {
  return Object.assign(new Error(`${code}: operation failed`), { code });
}
