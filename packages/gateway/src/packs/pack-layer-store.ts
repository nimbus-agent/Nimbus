// The file-backed pack-layer store: `<configDir>/packs/<profile>/<id>.toml` plus that
// directory's `active.json` (`{"version":1,"packs":[...]}`, low to high). It is both the
// layered reader's `PackLayerSource` and the one writer of pack layers. Every write is
// allowlist-checked and conflict-checked before anything touches disk, and a read never throws:
// a broken pack is skipped whole and reported, never fatal. The user's own config files are
// never read or written here.

import { mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
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

/** Every refusal from `setPackLayer`/`removePackLayer`; the message joins `problems`. */
export class PackLayerRefusedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(problems.join("; "));
    this.name = "PackLayerRefusedError";
    this.problems = problems;
  }
}

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
  setPackLayer(profile: string, packId: string, fragment: string): PackWriteResult;
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

function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
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

export function createPackLayerStore(opts: {
  configDir: string;
  checkJobs?: PackJobChecker;
  onChange?: (profile: string) => number | null;
}): PackLayerStore {
  const configDir = resolve(opts.configDir);
  const checkJobs = opts.checkJobs ?? checkPackFleetJobs;
  const onChange =
    opts.onChange ??
    ((profile: string): number | null => {
      const reader = peekLayeredConfig(configDir);
      // PROFILE_NAME_RE is case-insensitive, so `Default` and `default` are one directory on
      // Windows/macOS.
      return reader !== undefined && reader.profile.name.toLowerCase() === profile.toLowerCase()
        ? reader.snapshot().version
        : null;
    });

  const safe = (message: string): string => basenameSafeMessage(message, configDir);
  const profileDir = (profile: string): string => join(configDir, "packs", profile);
  const packPath = (profile: string, id: string): string => join(profileDir(profile), `${id}.toml`);

  function readActive(profile: string): ActiveList {
    let raw: string;
    try {
      raw = readFileSync(join(profileDir(profile), ACTIVE_FILE), "utf8");
    } catch (err) {
      if (isEnoent(err)) return { ok: true, ids: [] };
      return { ok: false, error: `could not read ${ACTIVE_FILE}: ${safe(errMessage(err))}` };
    }
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
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
    const path = packPath(profile, id);
    try {
      const st = statSync(path);
      if (!st.isFile()) return { reason: "not a regular file" };
      if (st.size > PACK_FRAGMENT_MAX_BYTES) {
        return { reason: `larger than ${PACK_FRAGMENT_MAX_BYTES} bytes` };
      }
      const text = readFileSync(path, "utf8");
      const check = checkPackFragment(text, checkJobs);
      if (!check.ok) return { reason: refusedReason(check.problems, safe) };
      return { text, pack: { id, scalars: check.scalars, jobNames: check.jobNames } };
    } catch (err) {
      if (isEnoent(err)) return { reason: "missing" };
      return { reason: safe(errMessage(err)) };
    }
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
    for (const id of active.ids) {
      if (!PACK_ID_RE.test(id)) {
        skipped.push({ packId: id, reason: "invalid pack id" });
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
    const problems: string[] = [];
    if (!PROFILE_NAME_RE.test(profile)) problems.push("invalid profile name");
    if (!PACK_ID_RE.test(packId)) problems.push("invalid pack id");
    if (problems.length > 0) throw new PackLayerRefusedError(problems);
  }

  function activeIds(profile: string): readonly string[] {
    const active = readActive(profile);
    if (!active.ok) throw new PackLayerRefusedError([active.error]);
    return active.ids;
  }

  function writeActive(profile: string, ids: readonly string[]): void {
    writeUtf8FileAtomicReplace(
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

    setPackLayer(profile: string, packId: string, fragment: string): PackWriteResult {
      assertNames(profile, packId);
      const current = readDetailed(profile);
      if (current.listError !== undefined) throw new PackLayerRefusedError([current.listError]);
      const check = checkPackFragment(fragment, checkJobs);
      if (!check.ok) throw new PackLayerRefusedError(check.problems);
      const clash = conflicts(packId, check.scalars, check.jobNames, current.clean);
      if (clash.length > 0) throw new PackLayerRefusedError(clash);
      const ids = current.ids;
      const path = packPath(profile, packId);
      mkdirSync(profileDir(profile), { recursive: true });
      // A crash between the two writes leaves an unlisted file, which is inert.
      writeUtf8FileAtomicReplace(path, fragment);
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
      try {
        unlinkSync(path);
        deleted = true;
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
      const removed = listed || deleted;
      return { path, snapshotVersion: removed ? onChange(profile) : null, removed };
    },
  };
}
