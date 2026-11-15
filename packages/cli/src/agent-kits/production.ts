/**
 * The real machine behind the agent kits (Phase 28 AD7b): the file reads a kit plans from, how
 * this machine starts Nimbus, and an agent program's version.
 *
 * Everything here READS. The one module that writes is `apply.ts`.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, extname } from "node:path";

import type { KitEnv, PathKind } from "./kit-types.ts";
import { KitRefusal } from "./plan-files.ts";

function kindOf(path: string): PathKind {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") return "absent";
    return "other";
  }
  if (st.isSymbolicLink()) return "link";
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "dir";
  return "other";
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") return null;
    throw new KitRefusal(
      `${path} could not be read (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

export interface NodeKitEnvOptions {
  readonly home: string;
  readonly cwd: string;
  readonly nimbus: string;
  envVar(name: string): string | undefined;
}

/** A kit environment over the real file system. */
export function nodeKitEnv(o: NodeKitEnvOptions): KitEnv {
  return {
    home: o.home,
    cwd: o.cwd,
    nimbus: o.nimbus,
    read: readText,
    kind: kindOf,
    envVar: (name) => {
      const v = o.envVar(name);
      return v === undefined || v === "" ? undefined : v;
    },
  };
}

function sameFile(a: string, b: string, realpath: (p: string) => string): boolean {
  try {
    return realpath(a) === realpath(b);
  } catch {
    return false;
  }
}

/**
 * What an agent's server entry should run: `nimbus` when that name on PATH is this very program,
 * else this program's absolute path. A dev tree (the program is `bun`, not `nimbus`) is refused:
 * an entry pointing at a checkout would break the first time the checkout moves.
 */
export function resolveNimbusCommand(
  execPath: string,
  which: (name: string) => string | null,
  realpath: (p: string) => string = (p) => realpathSync.native(p),
): string {
  const name = basename(execPath).toLowerCase();
  if (!name.startsWith("nimbus")) {
    throw new KitRefusal(
      "nimbus agent install needs an installed nimbus: this one is running from a source tree, and an agent's configuration must not point at a checkout",
    );
  }
  const onPath = which("nimbus");
  return onPath !== null && sameFile(onPath, execPath, realpath) ? "nimbus" : execPath;
}

/** Script shims. Starting one needs a shell, and Nimbus starts no other program through a shell. */
const SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat", ".ps1"]);

const VERSION_LINE_MAX = 60;

/**
 * `<program> --version`, first line. `not found` when the program is not on PATH, `unknown` when
 * it is a script shim (never started), fails, prints nothing or takes too long.
 */
export async function agentVersion(
  program: string,
  which: (name: string) => string | null,
  run: (path: string, args: readonly string[]) => Promise<string>,
): Promise<string> {
  const path = which(program);
  if (path === null) return "not found";
  if (SHIM_EXTENSIONS.has(extname(path).toLowerCase())) return "unknown";
  try {
    const first = (await run(path, ["--version"])).split("\n")[0]?.trim() ?? "";
    return first === "" ? "unknown" : first.slice(0, VERSION_LINE_MAX);
  } catch {
    return "unknown";
  }
}

/** `node:child_process` `execFile`, as far as this module uses it. */
export type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean; shell: false },
  callback: (error: Error | null, stdout: string | Buffer) => void,
) => unknown;

/** How long an agent program gets to print its version. */
export const VERSION_TIMEOUT_MS = 3_000;

/** Starts a program directly: no shell, a hard time limit, its stdout as text. */
export function execForOutput(
  exec: ExecFileLike,
): (path: string, args: readonly string[]) => Promise<string> {
  return (path, args) =>
    new Promise((resolve, reject) => {
      exec(
        path,
        [...args],
        { timeout: VERSION_TIMEOUT_MS, windowsHide: true, shell: false },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(String(stdout));
        },
      );
    });
}

/** True when `probe` (one gateway call) returns; any failure, a missing gateway included, is false. */
export async function answers(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch {
    return false;
  }
}

/** This process's own environment variable, for the kits' directory overrides. */
export function readProcessEnv(name: string): string | undefined {
  return process.env[name];
}
