// packages/gateway/src/connectors/lazy-mesh/obsidian-daily-note-grant.ts
// The Obsidian sandbox write grant is ONE FILE per vault: today's daily note (owner ruling on the
// final review's finding 1, 2026-11-05, superseding OR-B4-5's writable `.obsidian`). A whole-vault
// grant let a compromised child write `.obsidian/plugins/*/main.js`, which Obsidian runs with the
// user's full rights, or `.git/hooks`. This module turns the vaults `obsidianWriteGrantPaths` keeps
// into those files: it resolves today's note with the SAME resolver the connector's append uses
// (`connectors/obsidian-daily-note.ts`, a port of the connector's `resolveDailyNoteRelativePath`),
// refuses a path inside `.obsidian` or `.git` or leaving the vault, and creates the folder and an
// empty note ON THE HOST (outside the sandbox) without following a link, so the grant can name an
// existing file and nothing else.
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";

import { pathApiFor } from "../../util/path-overlap.ts";
import { dailyNotesSettings, resolveDailyNotePath } from "../obsidian-daily-note.ts";
import {
  type ObsidianGrantSkip,
  type ObsidianWriteGrantDeps,
  obsidianWriteGrantPaths,
} from "./obsidian-write-grant.ts";

/**
 * Why a vault's daily note is not granted:
 *  - `config-dir`: the note path is inside, or is, `.obsidian` or `.git` (where Obsidian plugins
 *    and git hooks live: never writable);
 *  - `outside-vault`: the path leaves the vault (`..`, an absolute folder);
 *  - `link`: a folder on the way, or the note, is a link, or its real path is not the vault's real
 *    path plus the same names;
 *  - `not-a-file`: something other than a regular file (or a folder) is in the way;
 *  - `hard-link`: the note exists with more than one name (a hard link planted to another file);
 *  - `unwritable`: the host could not create the folder or the empty note.
 */
export type DailyNoteSkip =
  | "config-dir"
  | "outside-vault"
  | "link"
  | "not-a-file"
  | "hard-link"
  | "unwritable";

/** The filesystem calls the host-side preparation makes. Injected only by tests. */
export interface DailyNoteFs {
  lstat(p: string): {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    nlink: number;
  };
  /** One folder, not recursive; throws when it exists. */
  mkdir(p: string): void;
  /** Create an EMPTY file that must not exist yet, never through a link (`O_EXCL`, `O_NOFOLLOW`). */
  createExclusive(p: string): void;
  realpath(p: string): string;
}

function nodeFs(platform: NodeJS.Platform): DailyNoteFs {
  const nofollow = platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  return {
    lstat: (p) => lstatSync(p),
    mkdir: (p) => mkdirSync(p, { mode: 0o755 }),
    createExclusive: (p) => {
      const fd = openSync(
        p,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | nofollow,
        0o644,
      );
      closeSync(fd);
    },
    realpath: (p) => realpathSync.native(p),
  };
}

export interface DailyNoteGrantDeps extends ObsidianWriteGrantDeps {
  /** The moment whose UTC date names today's note. Production: `new Date()`. */
  readonly now?: () => Date;
  /** Test seam; production is `node:fs`. */
  readonly fs?: DailyNoteFs;
}

export interface DailyNoteGrant {
  /** The UTC date (`YYYY-MM-DD`) the files were computed for. */
  readonly day: string;
  /** Canonical daily-note files the sandbox may write, sorted. */
  readonly files: readonly string[];
  /** Vaults not considered at all (`obsidianWriteGrantPaths`), with their reason. */
  readonly skippedVaults: readonly { readonly path: string; readonly reason: ObsidianGrantSkip }[];
  /** Kept vaults whose note was refused, with its reason. */
  readonly skippedNotes: readonly {
    readonly vault: string;
    readonly path: string;
    readonly reason: DailyNoteSkip;
  }[];
}

/** `YYYY-MM-DD` of `d` in UTC: the date the connector's append uses when `date_iso` is unset. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const CONFIG_DIRS = [".obsidian", ".git"];

function isConfigDir(platform: NodeJS.Platform, segment: string): boolean {
  const s = platform === "win32" ? segment.toLowerCase() : segment;
  return CONFIG_DIRS.includes(s);
}

function errCode(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
}

/**
 * Today's note of ONE canonical vault, created on the host if missing. Returns the canonical file
 * or the reason it is refused. Never follows a link: each folder on the way is `lstat`ed (created
 * one level at a time when missing, then `lstat`ed again), the note is created with `O_EXCL` (and
 * `O_NOFOLLOW` off win32), and the result's real path must be the vault's real path plus the same
 * names.
 */
export function prepareDailyNote(
  vault: string,
  date: Date,
  platform: NodeJS.Platform,
  fs: DailyNoteFs,
): { file: string } | { path: string; reason: DailyNoteSkip } {
  const api = pathApiFor(platform);
  const rel = resolveDailyNotePath(vault, date).relativePath;
  const segments = rel.split(/[\\/]+/).filter((s) => s !== "");
  const target = api.join(vault, ...segments);
  if (
    segments.length === 0 ||
    api.isAbsolute(rel) ||
    segments.some((s) => s === "." || s === "..")
  ) {
    return { path: target, reason: "outside-vault" };
  }
  if (segments.some((s) => isConfigDir(platform, s))) return { path: target, reason: "config-dir" };
  let cur = vault;
  for (const seg of segments.slice(0, -1)) {
    cur = api.join(cur, seg);
    try {
      const st = fs.lstat(cur);
      if (st.isSymbolicLink()) return { path: target, reason: "link" };
      if (!st.isDirectory()) return { path: target, reason: "not-a-file" };
    } catch (err) {
      if (errCode(err) !== "ENOENT") return { path: target, reason: "unwritable" };
      try {
        fs.mkdir(cur);
        const made = fs.lstat(cur);
        if (made.isSymbolicLink() || !made.isDirectory()) return { path: target, reason: "link" };
      } catch {
        return { path: target, reason: "unwritable" };
      }
    }
  }
  try {
    const st = fs.lstat(target);
    if (st.isSymbolicLink()) return { path: target, reason: "link" };
    if (!st.isFile()) return { path: target, reason: "not-a-file" };
    if (st.nlink > 1) return { path: target, reason: "hard-link" };
  } catch (err) {
    if (errCode(err) !== "ENOENT") return { path: target, reason: "unwritable" };
    try {
      fs.createExclusive(target);
      const made = fs.lstat(target);
      if (made.isSymbolicLink() || !made.isFile() || made.nlink > 1) {
        return { path: target, reason: "link" };
      }
    } catch {
      return { path: target, reason: "unwritable" };
    }
  }
  try {
    const real = fs.realpath(target);
    const expected = api.join(fs.realpath(vault), ...segments);
    const same =
      platform === "win32" ? real.toLowerCase() === expected.toLowerCase() : real === expected;
    return same ? { file: real } : { path: target, reason: "link" };
  } catch {
    return { path: target, reason: "unwritable" };
  }
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * The Obsidian sandbox write grant: today's daily note (UTC) of every vault
 * `obsidianWriteGrantPaths` keeps, each prepared on the host by {@link prepareDailyNote}. Creates
 * at most one folder chain and one empty file per vault; grants nothing by itself.
 */
export function obsidianDailyNoteGrant(
  roots: readonly string[],
  deps: DailyNoteGrantDeps,
): DailyNoteGrant {
  const date = (deps.now ?? (() => new Date()))();
  const fs = deps.fs ?? nodeFs(deps.platform);
  const vaults = obsidianWriteGrantPaths(roots, deps);
  const files: string[] = [];
  const skippedNotes: { vault: string; path: string; reason: DailyNoteSkip }[] = [];
  for (const vault of vaults.paths) {
    const r = prepareDailyNote(vault, date, deps.platform, fs);
    if ("file" in r) files.push(r.file);
    else skippedNotes.push({ vault, path: r.path, reason: r.reason });
  }
  files.sort(compareStrings);
  return { day: utcDay(date), files, skippedVaults: vaults.skipped, skippedNotes };
}

/**
 * What the enable prompt shows for a vault, WITHOUT touching the filesystem beyond reading the
 * vault's daily-notes settings: `<vault>/<daily folder>/<format>.md` (for example
 * `/notes/Work/Daily/YYYY-MM-DD.md`), or the reason no note there can ever be granted.
 */
export function dailyNotePattern(
  vault: string,
  platform: NodeJS.Platform,
): { pattern: string } | { path: string; reason: DailyNoteSkip } {
  const api = pathApiFor(platform);
  const { folder, format } = dailyNotesSettings(vault);
  const segments = [...folder.split(/[\\/]+/), `${format}.md`].filter((s) => s !== "");
  const pattern = api.join(vault, ...segments);
  if (api.isAbsolute(folder) || segments.some((s) => s === "." || s === "..")) {
    return { path: pattern, reason: "outside-vault" };
  }
  if (segments.some((s) => isConfigDir(platform, s)))
    return { path: pattern, reason: "config-dir" };
  return { pattern };
}
