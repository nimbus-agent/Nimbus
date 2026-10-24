// The file-backed pack-layer store: `<configDir>/packs/<profile>/<id>.toml` plus that
// directory's `active.json` (`{"version":1,"packs":[...]}`, low to high). It is both the
// layered reader's `PackLayerSource` and the one writer of pack layers. Every write is
// allowlist-checked and conflict-checked before anything touches disk, and a read never throws:
// a broken pack is skipped whole and reported, never fatal. The user's own config files are
// never read or written here.

import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { PROFILE_NAME_RE } from "../config/active-profile.ts";
import {
  basenameSafeMessage,
  type ConfigSnapshot,
  type PackLayerSource,
  type PackLayersRead,
  type PackLayerText,
  peekLayeredConfig,
  type SkippedPack,
} from "../config/layered-config.ts";
import {
  checkPackFragment,
  PACK_FRAGMENT_MAX_BYTES,
  PACK_ID_RE,
  type PackJobChecker,
  type PackScalar,
} from "../config/pack-settable.ts";
import { writeUtf8FileAtomicReplace } from "../config/toml-section-writer.ts";
import { checkPackFleetJobs } from "./pack-job-check.ts";

const ACTIVE_FILE = "active.json";
const ACTIVE_VERSION = 1;

/** A record holds a whole manifest (at most 128 KiB) plus a few fields. */
export const PACK_RECORD_MAX_BYTES = 256 * 1024;

/**
 * `O_NONBLOCK` so opening a FIFO returns at once instead of waiting for a writer; `fstat` on the
 * same descriptor then refuses anything that is not a regular file. Windows has no FIFOs (`0`).
 */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

type RegularRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "missing" | "not a regular file" | "too large" }
  | { readonly ok: false; readonly reason: "error"; readonly err: unknown };

/** Reads a regular file of at most `maxBytes` through the one descriptor that was checked. */
function readRegularFile(path: string, maxBytes: number): RegularRead {
  let fd: number | undefined;
  try {
    fd = openSync(path, READ_FLAGS);
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "not a regular file" };
    if (st.size > maxBytes) return { ok: false, reason: "too large" };
    return { ok: true, text: readFileSync(fd, "utf8") };
  } catch (err) {
    if (isEnoent(err)) return { ok: false, reason: "missing" };
    // Windows refuses to open a directory at all; Linux and macOS open it and fstat says so.
    if (hasCode(err, "EISDIR")) return { ok: false, reason: "not a regular file" };
    return { ok: false, reason: "error", err };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Why a layer was refused: the store is unreadable, the input is bad, or it clashes with a pack. */
export type PackLayerRefusalReason = "store" | "invalid" | "conflict";

/** Every refusal from `setPackLayer`/`removePackLayer`; the message joins `problems`. */
export class PackLayerRefusedError extends Error {
  readonly problems: readonly string[];
  readonly reason: PackLayerRefusalReason;

  constructor(problems: readonly string[], reason: PackLayerRefusalReason) {
    super(problems.join("; "));
    this.name = "PackLayerRefusedError";
    this.problems = problems;
    this.reason = reason;
  }
}

/** The result of `checkPackLayer`: what `setPackLayer` would refuse, without writing anything. */
export type PackLayerCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: PackLayerRefusalReason;
      readonly problems: readonly string[];
    };

export type PackWriteResult = {
  readonly path: string;
  /** The running reader's snapshot version after the write; null for another profile or no write. */
  readonly snapshotVersion: number | null;
};

/**
 * Refusals (allowlist, conflict, bad names, unreadable `active.json`) throw
 * `PackLayerRefusedError`; raw filesystem I/O errors propagate unwrapped. `removePackLayer` that
 * fails at the unlink has already delisted the pack, which is inert.
 */
export type PackLayerStore = PackLayerSource & {
  /** `opts.record` is written beside the layer as `<id>.pack.json`, between the layer and the list. */
  setPackLayer(
    profile: string,
    packId: string,
    fragment: string,
    opts?: { readonly record?: string },
  ): PackWriteResult;
  /** The refusals `setPackLayer` would throw, as a value; writes nothing. */
  checkPackLayer(profile: string, packId: string, fragment: string): PackLayerCheck;
  /** The raw `<id>.pack.json`; undefined when absent or unreadable. */
  readPackRecord(profile: string, packId: string): string | undefined;
  /** The raw on-disk `<id>.toml`; undefined when absent or unreadable. */
  readPackLayerText(profile: string, packId: string): string | undefined;
  removePackLayer(profile: string, packId: string): PackWriteResult & { readonly removed: boolean };
};

type ActiveList =
  | { readonly ok: true; readonly ids: readonly string[] }
  | { readonly ok: false; readonly error: string };

/** A pack that reads clean, with what it sets (for conflict checks). */
type CleanPack = {
  readonly id: string;
  readonly scalars: ReadonlyMap<string, PackScalar>;
  readonly jobNames: readonly string[];
};

type DetailedRead = PackLayersRead & {
  readonly clean: readonly CleanPack[];
  readonly ids: readonly string[];
};

function hasCode(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

function isEnoent(err: unknown): boolean {
  return hasCode(err, "ENOENT");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isActiveDoc(v: unknown): v is { version: number; packs: unknown } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `"fleet.retention_days"` as `"[fleet] retention_days"`. */
function scalarLabel(id: string): string {
  const dot = id.indexOf(".");
  return `[${id.slice(0, dot)}] ${id.slice(dot + 1)}`;
}

const SKIP_REASON_MAX = 200;

/** `refused: <first problem>` (+ a count of the rest), capped so a skip reason stays short. */
function refusedReason(problems: readonly string[], safe: (m: string) => string): string {
  const first = safe(problems[0] ?? "refused");
  const more = problems.length > 1 ? ` (+${problems.length - 1} more)` : "";
  const full = `refused: ${first}${more}`;
  if (full.length <= SKIP_REASON_MAX) return full;
  const keep = SKIP_REASON_MAX - 1;
  return `${full.slice(0, keep)}…`;
}

/** The boot log lines for a snapshot's skipped packs and pack-list error (one per skip). */
export function packSkipLogLines(
  snapshot: Pick<ConfigSnapshot, "skippedPacks" | "packListError">,
): string[] {
  const lines = snapshot.skippedPacks.map((s) => `config: pack "${s.packId}" skipped: ${s.reason}`);
  if (snapshot.packListError !== undefined) {
    lines.push(`config: packs not applied: ${snapshot.packListError}`);
  }
  return lines;
}

function nameProblems(profile: string, packId: string): string[] {
  const problems: string[] = [];
  if (!PROFILE_NAME_RE.test(profile)) problems.push("invalid profile name");
  if (!PACK_ID_RE.test(packId)) problems.push("invalid pack id");
  return problems;
}

/** The text of a regular file of at most `maxBytes`; anything else (missing, FIFO, …) is undefined. */
function readText(path: string, maxBytes: number): string | undefined {
  const read = readRegularFile(path, maxBytes);
  return read.ok ? read.text : undefined;
}

export function createPackLayerStore(opts: {
  configDir: string;
  checkJobs?: PackJobChecker;
  onChange?: (profile: string) => number | null;
  /** Test seam: the atomic file writer. */
  writeFile?: (path: string, content: string) => void;
}): PackLayerStore {
  const configDir = resolve(opts.configDir);
  const checkJobs = opts.checkJobs ?? checkPackFleetJobs;
  const writeFile =
    opts.writeFile ??
    ((path: string, content: string) => writeUtf8FileAtomicReplace(path, content));
  const onChange =
    opts.onChange ??
    ((profile: string): number | null => {
      const reader = peekLayeredConfig(configDir);
      // Exact match: on Linux `Default` and `default` are different directories, and the running
      // reader never reads the other one.
      return reader !== undefined && reader.profile.name === profile
        ? reader.snapshot().version
        : null;
    });

  // Every reason this store produces goes through here: no absolute path, and no control
  // character from a hand-edited file reaching diag, the log or `config explain`.
  const safe = (message: string): string =>
    basenameSafeMessage(message, configDir).replace(/\p{Cc}/gu, " ");
  const profileDir = (profile: string): string => join(configDir, "packs", profile);
  const packPath = (profile: string, id: string): string => join(profileDir(profile), `${id}.toml`);

  const recordPath = (profile: string, id: string): string =>
    join(profileDir(profile), `${id}.pack.json`);

  function readActive(profile: string): ActiveList {
    const read = readRegularFile(join(profileDir(profile), ACTIVE_FILE), PACK_FRAGMENT_MAX_BYTES);
    if (!read.ok && read.reason === "missing") return { ok: true, ids: [] };
    if (!read.ok) {
      const why = readFailure(read, PACK_FRAGMENT_MAX_BYTES);
      return { ok: false, error: `could not read ${ACTIVE_FILE}: ${why}` };
    }
    let doc: unknown;
    try {
      doc = JSON.parse(read.text);
    } catch {
      return { ok: false, error: `${ACTIVE_FILE} is not valid JSON` };
    }
    if (!isActiveDoc(doc)) return { ok: false, error: `${ACTIVE_FILE} is not a JSON object` };
    if (doc.version !== ACTIVE_VERSION) {
      return { ok: false, error: `${ACTIVE_FILE} version must be ${ACTIVE_VERSION}` };
    }
    const packs = doc.packs;
    if (!Array.isArray(packs) || !packs.every((p): p is string => typeof p === "string")) {
      return { ok: false, error: `${ACTIVE_FILE} packs must be an array of strings` };
    }
    return { ok: true, ids: packs };
  }

  /** One listed pack: its text and what it sets, or why it is skipped. */
  function readPack(
    profile: string,
    id: string,
  ): { text: string; pack: CleanPack } | { reason: string } {
    const read = readRegularFile(packPath(profile, id), PACK_FRAGMENT_MAX_BYTES);
    if (!read.ok) return { reason: readFailure(read, PACK_FRAGMENT_MAX_BYTES) };
    const check = checkPackFragment(read.text, checkJobs);
    if (!check.ok) return { reason: refusedReason(check.problems, safe) };
    return { text: read.text, pack: { id, scalars: check.scalars, jobNames: check.jobNames } };
  }

  function readFailure(read: Exclude<RegularRead, { ok: true }>, maxBytes: number): string {
    if (read.reason === "too large") return `larger than ${maxBytes} bytes`;
    if (read.reason === "error") return safe(errMessage(read.err));
    return read.reason;
  }

  function readDetailed(profile: string): DetailedRead {
    if (!PROFILE_NAME_RE.test(profile)) {
      return { layers: [], skipped: [], clean: [], ids: [], listError: "invalid profile name" };
    }
    const active = readActive(profile);
    if (!active.ok) return { layers: [], skipped: [], clean: [], ids: [], listError: active.error };
    const layers: PackLayerText[] = [];
    const skipped: SkippedPack[] = [];
    const clean: CleanPack[] = [];
    const seen = new Set<string>();
    for (const [index, id] of active.ids.entries()) {
      if (!PACK_ID_RE.test(id)) {
        // A hand-edited entry can be anything (an absolute path naming a user, control
        // characters); it is never echoed, only its position in `packs`.
        skipped.push({ packId: `#${index}`, reason: "invalid pack id" });
        continue;
      }
      if (seen.has(id)) {
        skipped.push({ packId: id, reason: `listed twice in ${ACTIVE_FILE}` });
        continue;
      }
      seen.add(id);
      const r = readPack(profile, id);
      if ("reason" in r) {
        skipped.push({ packId: id, reason: r.reason });
        continue;
      }
      layers.push({ id, path: packPath(profile, id), text: r.text });
      clean.push(r.pack);
    }
    return { layers, skipped, clean, ids: active.ids };
  }

  function assertNames(profile: string, packId: string): void {
    const problems = nameProblems(profile, packId);
    if (problems.length > 0) throw new PackLayerRefusedError(problems, "invalid");
  }

  function activeIds(profile: string): readonly string[] {
    const active = readActive(profile);
    if (!active.ok) throw new PackLayerRefusedError([active.error], "store");
    return active.ids;
  }

  /** The one check, in write order. A pass carries the listed ids so the writer reads once. */
  function check(
    profile: string,
    packId: string,
    fragment: string,
  ): PackLayerCheck & { readonly ids?: readonly string[] } {
    const names = nameProblems(profile, packId);
    if (names.length > 0) return { ok: false, reason: "invalid", problems: names };
    const current = readDetailed(profile);
    if (current.listError !== undefined) {
      return { ok: false, reason: "store", problems: [current.listError] };
    }
    const parsed = checkPackFragment(fragment, checkJobs);
    if (!parsed.ok) return { ok: false, reason: "invalid", problems: parsed.problems };
    const clash = conflicts(packId, parsed.scalars, parsed.jobNames, current.clean);
    if (clash.length > 0) return { ok: false, reason: "conflict", problems: clash };
    return { ok: true, ids: current.ids };
  }

  function writeActive(profile: string, ids: readonly string[]): void {
    writeFile(
      join(profileDir(profile), ACTIVE_FILE),
      `${JSON.stringify({ version: ACTIVE_VERSION, packs: ids })}\n`,
    );
  }

  function conflicts(
    packId: string,
    scalars: ReadonlyMap<string, PackScalar>,
    jobNames: readonly string[],
    others: readonly CleanPack[],
  ): string[] {
    const problems: string[] = [];
    for (const other of others) {
      if (other.id === packId) continue;
      for (const [key, value] of scalars) {
        const theirs = other.scalars.get(key);
        if (theirs !== undefined && theirs !== value) {
          problems.push(`${scalarLabel(key)}: pack ${other.id} sets ${String(theirs)}`);
        }
      }
      for (const name of jobNames) {
        if (other.jobNames.includes(name)) {
          problems.push(`[[fleet.job]] ${name} is also set by pack ${other.id}`);
        }
      }
    }
    return problems;
  }

  return {
    read(profile: string): PackLayersRead {
      try {
        const { layers, skipped, listError } = readDetailed(profile);
        return { layers, skipped, ...(listError !== undefined ? { listError } : {}) };
      } catch (err) {
        return { layers: [], skipped: [], listError: safe(errMessage(err)) };
      }
    },

    checkPackLayer(profile: string, packId: string, fragment: string): PackLayerCheck {
      const r = check(profile, packId, fragment);
      return r.ok ? { ok: true } : r;
    },

    readPackRecord(profile: string, packId: string): string | undefined {
      if (nameProblems(profile, packId).length > 0) return undefined;
      return readText(recordPath(profile, packId), PACK_RECORD_MAX_BYTES);
    },

    readPackLayerText(profile: string, packId: string): string | undefined {
      if (nameProblems(profile, packId).length > 0) return undefined;
      return readText(packPath(profile, packId), PACK_FRAGMENT_MAX_BYTES);
    },

    setPackLayer(
      profile: string,
      packId: string,
      fragment: string,
      opts?: { readonly record?: string },
    ): PackWriteResult {
      const checked = check(profile, packId, fragment);
      if (!checked.ok) throw new PackLayerRefusedError(checked.problems, checked.reason);
      const ids = checked.ids ?? [];
      const path = packPath(profile, packId);
      mkdirSync(profileDir(profile), { recursive: true });
      // Order: layer, record, list. A crash before the list write leaves an unlisted file, which
      // is inert. On an UPDATE the id is already listed, so a crash between the layer and the
      // record leaves the new, approved defaults live under the old record. That heals itself:
      // `pack list` shows the old version and the next install sees a different digest and
      // prompts as an update. Writing the record first would only give the mirror case (new
      // record, old layer), which prompts as a repair.
      writeFile(path, fragment);
      if (opts?.record !== undefined) {
        writeFile(recordPath(profile, packId), opts.record);
      }
      if (!ids.includes(packId)) writeActive(profile, [...ids, packId]);
      return { path, snapshotVersion: onChange(profile) };
    },

    removePackLayer(profile: string, packId: string) {
      assertNames(profile, packId);
      const ids = activeIds(profile);
      const path = packPath(profile, packId);
      const listed = ids.includes(packId);
      if (listed)
        writeActive(
          profile,
          ids.filter((id) => id !== packId),
        );
      let deleted = false;
      for (const file of [path, recordPath(profile, packId)]) {
        try {
          unlinkSync(file);
          deleted = true;
        } catch (err) {
          if (!isEnoent(err)) throw err;
        }
      }
      const removed = listed || deleted;
      return { path, snapshotVersion: removed ? onChange(profile) : null, removed };
    },
  };
}
