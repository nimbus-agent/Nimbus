/**
 * The shapes every agent kit shares (Phase 28 AD7b).
 *
 * A kit is a PURE function from what the machine looks like (`KitEnv`) to what it would write
 * (`KitPlan`). Install prints the plan and applies it after a typed `yes`; status re-runs the plan
 * and reports whether it would change anything. Nothing in a kit touches the file system itself.
 */
import { dirname } from "node:path";

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
 * A file a kit may write: a regular file or nothing, in a real directory (or one not made yet).
 * A link at the file or at its directory is refused, so a kit never writes through one.
 */
export function assertWritableTarget(env: KitEnv, path: string): void {
  const kind = env.kind(path);
  if (kind !== "file" && kind !== "absent") {
    throw new KitRefusal(`${path} is not a regular file (${kind}), so Nimbus will not write it`);
  }
  const parent = env.kind(dirname(path));
  if (parent !== "dir" && parent !== "absent") {
    throw new KitRefusal(
      `${dirname(path)} is not a real directory (${parent}), so Nimbus will not write in it`,
    );
  }
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
  path: string,
  component: KitComponent,
  build: (before: string | null) => string,
  present: (before: string) => boolean,
): FileEdit {
  assertWritableTarget(env, path);
  const before = env.read(path);
  return {
    path,
    component,
    before,
    after: build(before),
    present: before !== null && present(before),
  };
}
