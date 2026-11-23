/**
 * Writing a kit's plan to disk (Phase 28 AD7b). The ONLY module of the agent kits that writes.
 *
 * It changes another product's configuration, so every step is conservative:
 *  - the file is read again just before the write, and a change since the plan was shown stops the
 *    run (the owner approved a diff against bytes that no longer exist);
 *  - an existing file is copied to a timestamped backup first, and a backup is never overwritten;
 *  - the new content goes to this run's own temporary file in the same directory and is renamed
 *    over the target, so a reader never sees half a file and two runs never share one;
 *  - on Windows a rename fails while another program holds the target open, so it is retried, and
 *    when it still fails the temporary file is removed and the target is left exactly as it was;
 *    the target is read again after every wait, so a save made meanwhile is not overwritten.
 *    (Between that last read and the rename itself there is no lock: a program that saves in
 *    that instant loses its save to the backup. Stated on the kit page.)
 *  - a link at the file or at a directory above it is refused here too, not only when planning;
 *  - nothing is ever deleted except that temporary file and, in an uninstall, a Nimbus-named file
 *    (`edit.remove`) that held nothing but the kit's part; it is backed up first like any other.
 */
import { randomBytes } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { assertWritableTarget, type FileEdit, type KitPlan, type PathKind } from "./kit-types.ts";
import { KitRefusal, sameText } from "./plan-files.ts";

/** The file operations `applyPlan` uses, injectable so a locked file can be simulated. */
export interface ApplyFs {
  read(path: string): string | null;
  /** What is at the path, WITHOUT following a link. */
  kind(path: string): PathKind;
  exists(path: string): boolean;
  mkdirp(dir: string): void;
  /** Copies to a NEW file: it must fail (`EEXIST`) when `to` exists, never overwrite it. */
  copy(from: string, to: string): void;
  /** A short random suffix, so two installs at once never share a temporary file. */
  unique(): string;
  /** Writes a NEW file; `mode` is the target's own when it exists. */
  write(path: string, text: string, mode: number | undefined): void;
  modeOf(path: string): number | undefined;
  rename(from: string, to: string): void;
  remove(path: string): void;
  sleep(ms: number): Promise<void>;
}

function lstatKind(path: string): PathKind {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch (e) {
    return (e as { code?: unknown }).code === "ENOENT" ? "absent" : "other";
  }
  if (st.isSymbolicLink()) return "link";
  if (st.isFile()) return "file";
  return st.isDirectory() ? "dir" : "other";
}

export const NODE_APPLY_FS: ApplyFs = {
  kind: lstatKind,
  read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
  exists: (p) => existsSync(p),
  mkdirp: (d) => {
    mkdirSync(d, { recursive: true });
  },
  copy: (from, to) => {
    copyFileSync(from, to, constants.COPYFILE_EXCL);
  },
  unique: () => randomBytes(6).toString("hex"),
  write: (p, text, mode) => {
    writeFileSync(p, text, mode === undefined ? { flag: "wx" } : { flag: "wx", mode });
  },
  modeOf: (p) => (existsSync(p) ? statSync(p).mode & 0o777 : undefined),
  rename: (from, to) => {
    renameSync(from, to);
  },
  remove: (p) => {
    unlinkSync(p);
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface AppliedFile {
  readonly path: string;
  /** Where the file as it was is kept; undefined when the kit created the file. */
  readonly backup: string | undefined;
  /** True when the file was deleted (an uninstall of a file that held only the kit's part). */
  readonly deleted?: boolean;
}

export interface ApplyResult {
  readonly written: readonly AppliedFile[];
  /** Set when a file could not be written: the run stopped there. */
  readonly failure: { readonly path: string; readonly message: string } | undefined;
}

const RENAME_ATTEMPTS = 5;
const RENAME_WAIT_MS = 200;
/** What a rename over a file another program holds open fails with on Windows. */
const BUSY_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);

/** `20261115T201500Z`: sorts by time and is valid in a file name on every OS. */
export function backupStamp(now: Date): string {
  return `${now.toISOString().replaceAll(/[-:]/g, "").slice(0, 15)}Z`;
}

function errorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

const CHANGED = (path: string): string =>
  `${path} changed after the plan was shown; nothing was written to it. Run the command again`;

/**
 * Renames `from` over `to`, retrying while another program holds `to`. After every wait the
 * target is read again: a program that saved the file meanwhile must not be overwritten by a
 * plan made against the bytes before it.
 */
async function renameWithRetry(
  fs: ApplyFs,
  from: string,
  to: string,
  stillAsPlanned: () => boolean,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.rename(from, to);
      return;
    } catch (e) {
      const busy = BUSY_CODES.has(errorCode(e) ?? "");
      if (!busy || attempt === RENAME_ATTEMPTS) throw e;
      await fs.sleep(RENAME_WAIT_MS);
      if (!stillAsPlanned()) throw new KitRefusal(CHANGED(to));
    }
  }
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Step 2: the file as it is now, copied to a NEW backup name. Undefined when there is no file yet. */
function backUp(fs: ApplyFs, edit: FileEdit, stamp: string): string | undefined {
  if (edit.before === null) return undefined;
  const backup = `${edit.path}.nimbus-bak-${stamp}`;
  try {
    // Exclusive: two installs in the same second cannot both write this name.
    fs.copy(edit.path, backup);
  } catch (e) {
    if (errorCode(e) === "EEXIST") {
      throw new KitRefusal(`${backup} already exists; nothing was written. Run the command again`);
    }
    throw new KitRefusal(
      `${edit.path} could not be backed up (${reasonOf(e)}); nothing was written`,
    );
  }
  return backup;
}

/** Step 3: this run's own temporary file, renamed over the target. Another run's is never touched. */
async function replace(fs: ApplyFs, edit: FileEdit, asPlanned: () => boolean): Promise<void> {
  const temp = `${edit.path}.nimbus-new-${fs.unique()}`;
  try {
    fs.write(temp, edit.after, fs.modeOf(edit.path));
    await renameWithRetry(fs, temp, edit.path, asPlanned);
  } catch (e) {
    // A failed write can leave half a file: it goes too.
    if (fs.exists(temp)) fs.remove(temp);
    if (e instanceof KitRefusal) throw e;
    if (BUSY_CODES.has(errorCode(e) ?? "")) {
      throw new KitRefusal(
        `${edit.path} is in use by another program; it was left unchanged. Close the agent and run the command again`,
      );
    }
    throw new KitRefusal(
      `${edit.path} could not be replaced (${reasonOf(e)}); it was left unchanged`,
    );
  }
}

/** An uninstall's delete: the backup already exists, and a file another program holds stays. */
function deleteTarget(fs: ApplyFs, edit: FileEdit): void {
  try {
    fs.remove(edit.path);
  } catch (e) {
    if (BUSY_CODES.has(errorCode(e) ?? "")) {
      throw new KitRefusal(
        `${edit.path} is in use by another program; it was left in place. Close the agent and run the command again`,
      );
    }
    throw new KitRefusal(
      `${edit.path} could not be deleted (${reasonOf(e)}); it was left in place`,
    );
  }
}

async function applyOne(fs: ApplyFs, edit: FileEdit, stamp: string): Promise<AppliedFile> {
  if (edit.refusal !== undefined) throw new KitRefusal(edit.refusal);
  // Step 1: what the plan checked is checked again. A link can appear, and the file can change,
  // while the owner reads the plan.
  assertWritableTarget(fs.kind, edit.root, edit.path);
  const asPlanned = (): boolean => fs.read(edit.path) === edit.before;
  if (!asPlanned()) throw new KitRefusal(CHANGED(edit.path));
  fs.mkdirp(dirname(edit.path));
  const backup = backUp(fs, edit, stamp);
  if (edit.remove === true) {
    deleteTarget(fs, edit);
    return { path: edit.path, backup, deleted: true };
  }
  await replace(fs, edit, asPlanned);
  return { path: edit.path, backup };
}

/** The edits of a plan that would change their file (a line-ending-only difference is none). */
export function pendingEdits(plan: KitPlan): FileEdit[] {
  return plan.files.filter((f) => f.before === null || !sameText(f.before, f.after));
}

/**
 * Writes every pending edit of `plan`, in order, stopping at the first that cannot be written.
 * Files written before a failure stay written, each with its backup named in the result.
 */
export async function applyPlan(
  plan: KitPlan,
  fs: ApplyFs = NODE_APPLY_FS,
  now: Date = new Date(),
): Promise<ApplyResult> {
  const stamp = backupStamp(now);
  const written: AppliedFile[] = [];
  for (const edit of pendingEdits(plan)) {
    try {
      written.push(await applyOne(fs, edit, stamp));
    } catch (e) {
      return {
        written,
        failure: { path: edit.path, message: e instanceof Error ? e.message : String(e) },
      };
    }
  }
  return { written, failure: undefined };
}
