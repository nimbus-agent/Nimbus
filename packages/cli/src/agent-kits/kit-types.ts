/**
 * The shapes every agent kit shares (Phase 28 AD7b).
 *
 * A kit is a PURE function from what the machine looks like (`KitEnv`) to what it would write
 * (`KitPlan`). Install prints the plan and applies it after a typed `yes`; status re-runs the plan
 * and reports whether it would change anything. Nothing in a kit touches the file system itself.
 */
import { dirname, isAbsolute, relative, sep } from "node:path";

import { KitRefusal } from "./plan-files.ts";

export const KIT_IDS = ["claude-code", "codex", "cursor", "vscode"] as const;
export type KitId = (typeof KIT_IDS)[number];
export type KitScope = "user" | "project";

export function isKitId(v: unknown): v is KitId {
  return typeof v === "string" && (KIT_IDS as readonly string[]).includes(v);
}

/** What is at a path, without following a link. */
export type PathKind = "file" | "dir" | "link" | "absent" | "other";

export interface KitEnv {
  /** The owner's home directory. User scope writes only beneath it. */
  readonly home: string;
  /** The working directory. Project scope writes only beneath it. */
  readonly cwd: string;
  /** How this machine starts Nimbus: `nimbus` when that is on PATH, else an absolute path. */
  readonly nimbus: string;
  /** The file's text, or null when there is no file. */
  read(path: string): string | null;
  kind(path: string): PathKind;
  envVar(name: string): string | undefined;
  /**
   * Set by `status` only: a file that cannot be planned (not strict JSON, a link, a file Nimbus
   * did not write) becomes an edit carrying its `refusal` instead of failing the whole kit, so
   * the kit's other files are still reported. Install never sets it.
   */
  readonly tolerant?: boolean;
}

export type KitComponent = "mcp" | "steer" | "instructions";

export interface FileEdit {
  readonly path: string;
  readonly component: KitComponent;
  /** The file as it is now; null when it does not exist. */
  readonly before: string | null;
  /** The file as the kit wants it. */
  readonly after: string;
  /**
   * Whether the file already holds something this kit owns (its block, its key, its hook). With
   * `before` and `after` this tells `missing` (nothing of ours) from `drifted` (ours, but not
   * what the kit would write now).
   */
  readonly present: boolean;
  /** The scope's tree this file belongs to; the link check runs from the file up to it. */
  readonly root: string;
  /** Why this file could not be planned (tolerant planning only). Such an edit is never applied. */
  readonly refusal?: string;
  /**
   * Set by an uninstall plan only: the file is a Nimbus-named file that holds nothing else after
   * the kit's part is taken out, so it is deleted (its backup stays beside it) rather than left
   * empty. `after` is then the empty string.
   */
  readonly remove?: boolean;
}

/** A step the OWNER runs. Nimbus never starts another vendor's program to change its settings. */
export interface ManualStep {
  readonly component: KitComponent;
  readonly why: string;
  readonly argv: readonly string[];
}

/**
 * How far the agent's own harness can hold the steering: a hook it runs, rules it evaluates,
 * instruction text it may or may not follow, or nothing at this scope. None is a security boundary.
 */
export type KitEnforcement = "hook" | "rules" | "guidance only" | "none";

export interface KitPlan {
  readonly kit: KitId;
  readonly scope: KitScope;
  readonly files: readonly FileEdit[];
  readonly manual: readonly ManualStep[];
  readonly enforcement: KitEnforcement;
  readonly notes: readonly string[];
}

/** The server entry every kit writes: the same command, labelled with the kit's own name. */
export function serverArgs(kit: KitId): string[] {
  return ["mcp-server", "--stdio", "--agent", kit];
}

/**
 * A file a kit may write: a regular file or nothing, reached from `root` through real directories
 * (or ones not made yet). A link at the file or at ANY directory between it and `root` is refused,
 * so a kit never writes through one. `root` itself is not looked at: it is the scope's own tree
 * (the home directory, the repository, or the directory the agent's own variable names).
 *
 * Takes the path reader as a function so planning and applying run the SAME check.
 */
export function assertWritableTarget(
  kind: (path: string) => PathKind,
  root: string,
  path: string,
): void {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new KitRefusal(`${path} is not inside ${root}, so Nimbus will not write it`);
  }
  const target = kind(path);
  if (target !== "file" && target !== "absent") {
    throw new KitRefusal(`${path} is not a regular file (${target}), so Nimbus will not write it`);
  }
  let dir = dirname(path);
  for (let left = rel.split(sep).length - 1; left > 0; left -= 1) {
    const k = kind(dir);
    if (k !== "dir" && k !== "absent") {
      throw new KitRefusal(`${dir} is not a real directory (${k}), so Nimbus will not write in it`);
    }
    dir = dirname(dir);
  }
}

/**
 * The directory an agent's own variable names (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`),
 * or undefined when it is unset. It must be absolute: a relative one would move with the working
 * directory, and a user-scope install must never land wherever the command happened to run.
 */
export function overrideDir(env: KitEnv, name: string): string | undefined {
  const value = env.envVar(name);
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) {
    throw new KitRefusal(
      `${name} is not an absolute path (${value}), so Nimbus will not write there`,
    );
  }
  return value;
}

/** Project scope means a repository: the working directory holds a `.git` entry. */
export function assertProject(env: KitEnv, gitEntry: string): void {
  if (env.kind(gitEntry) === "absent") {
    throw new KitRefusal(
      `--scope project writes into the current directory, and ${env.cwd} is not the root of a git repository`,
    );
  }
}

/** One planned edit, with its target checked. */
export function fileEdit(
  env: KitEnv,
  root: string,
  path: string,
  component: KitComponent,
  build: (before: string | null) => string,
  present: (before: string) => boolean,
): FileEdit {
  try {
    assertWritableTarget(env.kind, root, path);
    const before = env.read(path);
    return {
      path,
      component,
      before,
      after: build(before),
      present: before !== null && present(before),
      root,
    };
  } catch (e) {
    if (!(e instanceof KitRefusal) || env.tolerant !== true) throw e;
    return { path, component, before: null, after: "", present: false, root, refusal: e.message };
  }
}
