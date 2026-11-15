/**
 * Writing a kit's plan to disk (Phase 28 AD7b). The ONLY module of the agent kits that writes.
 *
 * It changes another product's configuration, so every step is conservative:
 *  - the file is read again just before the write, and a change since the plan was shown stops the
 *    run (the owner approved a diff against bytes that no longer exist);
 *  - an existing file is copied to a timestamped backup first, and a backup is never overwritten;
 *  - the new content goes to a temporary file in the same directory and is renamed over the
 *    target, so a reader never sees half a file;
 *  - on Windows a rename fails while another program holds the target open, so it is retried, and
 *    when it still fails the temporary file is removed and the target is left exactly as it was;
 *  - nothing is ever deleted except that temporary file.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { FileEdit, KitPlan } from "./kit-types.ts";
import { KitRefusal, sameText } from "./plan-files.ts";

/** The file operations `applyPlan` uses, injectable so a locked file can be simulated. */
export interface ApplyFs {
  read(path: string): string | null;
  exists(path: string): boolean;
  mkdirp(dir: string): void;
  copy(from: string, to: string): void;
  /** Writes a NEW file; `mode` is the target's own when it exists. */
  write(path: string, text: string, mode: number | undefined): void;
  modeOf(path: string): number | undefined;
  rename(from: string, to: string): void;
  remove(path: string): void;
  sleep(ms: number): Promise<void>;
}

export const NODE_APPLY_FS: ApplyFs = {
  read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
  exists: (p) => existsSync(p),
  mkdirp: (d) => {
    mkdirSync(d, { recursive: true });
  },
  copy: (from, to) => {
    copyFileSync(from, to);
  },
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

async function renameWithRetry(fs: ApplyFs, from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.rename(from, to);
      return;
    } catch (e) {
      const busy = BUSY_CODES.has(errorCode(e) ?? "");
      if (!busy || attempt === RENAME_ATTEMPTS) throw e;
      await fs.sleep(RENAME_WAIT_MS);
    }
  }
}

async function applyOne(fs: ApplyFs, edit: FileEdit, stamp: string): Promise<AppliedFile> {
  const now = fs.read(edit.path);
  if (now !== edit.before) {
    throw new KitRefusal(
      `${edit.path} changed after the plan was shown; nothing was written to it. Run the command again`,
    );
  }
  fs.mkdirp(dirname(edit.path));
  let backup: string | undefined;
  if (edit.before !== null) {
    backup = `${edit.path}.nimbus-bak-${stamp}`;
    if (fs.exists(backup)) {
      throw new KitRefusal(`${backup} already exists; nothing was written. Run the command again`);
    }
    fs.copy(edit.path, backup);
  }
  const temp = `${edit.path}.nimbus-new`;
  if (fs.exists(temp)) fs.remove(temp);
  fs.write(temp, edit.after, fs.modeOf(edit.path));
  try {
    await renameWithRetry(fs, temp, edit.path);
  } catch (e) {
    fs.remove(temp);
    const held = BUSY_CODES.has(errorCode(e) ?? "");
    throw new KitRefusal(
      held
        ? `${edit.path} is in use by another program; it was left unchanged. Close the agent and run the command again`
        : `${edit.path} could not be replaced (${e instanceof Error ? e.message : String(e)}); it was left unchanged`,
    );
  }
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
