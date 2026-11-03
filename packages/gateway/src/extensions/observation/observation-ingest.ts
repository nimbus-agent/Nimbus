import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
} from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";

import {
  MAX_ENTRIES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_LABEL_EXTENSION_ID_LENGTH,
  MAX_LABEL_VERSION_LENGTH,
  MAX_NAME_LENGTH,
  OBSERVATION_FILE_VERSION,
} from "../../platform/sandbox/network-observation-writer.ts";
import { deriveExtensionServiceId } from "../extension-service-id.ts";
import { getRunGrant } from "../run-grant-store.ts";
import {
  ageOutObservations,
  applyObservationWindow,
  type ObservationEntry,
  type ObservationWindow,
} from "./observation-store.ts";

/**
 * The gateway's half of the observation channel (project 6): where the wrapper is told to write,
 * and the pass that reads what it wrote into V81. The directory is the gateway's own: it is never a
 * grant, never a runtime read path, and the variables that name it reach the wrapper only, never
 * the child (`wrapServerSpecInCwd`'s `wrapperEnv`).
 *
 * Every file is untrusted until parsed: the exact key set, the version, every integer range, the
 * name alphabet the writer's sanitiser produces (an IP literal for `unmatched`), an installed extension in the label whose service
 * id names the file, and a file name whose seq is the body's. A bad file is deleted and counted,
 * never applied in part; a good one is deleted only after its rows commit, and is applied at most
 * once per (run, seq) whatever happens to the delete (V81 `extension_observation_applied`).
 * Observation is evidence only: nothing here decides a spawn, a grant or a network rule.
 */

export const OBSERVATION_DIR_NAME = "extension-observations";
/** How often the running gateway ingests, beside the pass at boot. */
export const OBSERVATION_INGEST_INTERVAL_MS = 60_000;
/**
 * A temp file older than this is a crashed writer's leftover, and is removed; so is any other entry
 * that is not a window file, and a window file that has stayed unreadable this long.
 */
export const STALE_TEMP_MS = 10 * 60_000;

/** `<dataDir>/extension-observations`: the one spelling of the directory. */
export function extensionObservationDirFor(dataDir: string): string {
  return join(dataDir, OBSERVATION_DIR_NAME);
}

/** Creates the directory owner-only (0700) and returns it. On Windows, chmod keeps the write bit, so it never sets the read-only attribute. */
export function ensureObservationDir(dataDir: string): string {
  const dir = extensionObservationDirFor(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** The per-spawn prefix the wrapper writes `<prefix>.<seq>.json` under. */
export function observationPrefixFor(
  dir: string,
  serviceId: string,
  now: () => number = Date.now,
): string {
  return join(dir, `${serviceId}.${String(now())}.${randomBytes(4).toString("hex")}`);
}

/** `<serviceId>.<runStartMs>.<8 hex>.<seq>.json`. */
const FILE_NAME_RE = /^([A-Za-z0-9_-]{1,128})\.(\d{1,16})\.([0-9a-f]{8})\.(\d{1,5})\.json$/;
/** What `sanitiseName` can produce: the alphabet plus its `?` replacement. */
const NAME_RE = /^[A-Za-z0-9._?-]+$/;
const MAX_PORT = 65_535;

type ParsedName = { name: string; serviceId: string; run: string; seq: number };

function parseFileName(name: string): ParsedName | null {
  const m = FILE_NAME_RE.exec(name);
  if (m === null) return null;
  return { name, serviceId: m[1] ?? "", run: `${m[1]}.${m[2]}.${m[3]}`, seq: Number(m[4]) };
}

/**
 * The `.json` files in `dir`, in apply order: by run, then by sequence number (numerically, so
 * `.10.` follows `.9.`). A name that does not parse sorts last; ingest rejects it.
 */
export function listObservationFiles(dir: string): string[] {
  const names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  const parsed = names.map((n) => ({ n, p: parseFileName(n) }));
  parsed.sort(compareWindowFiles);
  return parsed.map((x) => x.n);
}

type ListedFile = { n: string; p: ParsedName | null };

function compareWindowFiles(a: ListedFile, b: ListedFile): number {
  if (a.p === null && b.p === null) return a.n < b.n ? -1 : 1;
  if (a.p === null) return 1;
  if (b.p === null) return -1;
  if (a.p.run !== b.p.run) return a.p.run < b.p.run ? -1 : 1;
  return a.p.seq - b.p.seq;
}

/** Deletes every pending file (window and temp) a spawn of `serviceId` wrote. Best-effort. */
export function deleteObservationFilesFor(dir: string, serviceId: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (n.split(".")[0] !== serviceId) continue;
    try {
      rmSync(join(dir, n), { force: true });
    } catch {
      /* best-effort: ingest rejects a file whose extension is gone */
    }
  }
}

const TOP_KEYS = [
  "v",
  "label",
  "seq",
  "runStart",
  "os",
  "networkObserved",
  "fromMs",
  "toMs",
  "final",
  "entries",
  "dropped",
] as const;
const ENTRY_KEYS = ["o", "h", "p", "n"] as const;
const LABEL_KEYS = ["extensionId", "version"] as const;

class BadFile extends Error {}

function bad(why: string): never {
  throw new BadFile(why);
}

function record(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) bad(`${what} is not an object`);
  return v as Record<string, unknown>;
}

function exactKeys(
  o: Record<string, unknown>,
  keys: readonly string[],
  optional: readonly string[],
  what: string,
): void {
  for (const k of keys) if (!Object.hasOwn(o, k)) bad(`${what} lacks ${k}`);
  for (const k of Object.keys(o)) {
    if (!keys.includes(k) && !optional.includes(k)) bad(`${what} has an unknown key`);
  }
}

function int(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    bad(`${what} is out of range`);
  }
  return v;
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") bad(`${what} is not a boolean`);
  return v;
}

function boundedString(v: unknown, max: number, what: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) bad(`${what} is not valid`);
  return v;
}

function parseLabel(
  v: unknown,
  isInstalled: (id: string) => boolean,
): { extensionId: string; version: string } {
  const o = record(v, "label");
  exactKeys(o, LABEL_KEYS, [], "label");
  const extensionId = boundedString(o["extensionId"], MAX_LABEL_EXTENSION_ID_LENGTH, "extensionId");
  const version = boundedString(o["version"], MAX_LABEL_VERSION_LENGTH, "version");
  if (!isInstalled(extensionId)) bad("the label names an extension that is not installed");
  return { extensionId, version };
}

function parseEntry(v: unknown): ObservationEntry {
  const o = record(v, "entry");
  exactKeys(o, ENTRY_KEYS, [], "entry");
  const outcome = o["o"];
  if (outcome !== "used" && outcome !== "refused" && outcome !== "unmatched") {
    bad("entry outcome is not valid");
  }
  const destination = boundedString(o["h"], MAX_NAME_LENGTH, "entry name");
  // An `unmatched` destination is the address a connection reached, which matched no declared host
  // (Windows, macOS): the writer keeps it verbatim only when it is an IP literal, so nothing else is
  // accepted here, and a host name never arrives under it. `used` and `refused` carry names, which
  // the writer sanitised.
  if (outcome === "unmatched") {
    if (isIP(destination) === 0) bad("an unmatched entry is not an IP address");
  } else if (!NAME_RE.test(destination)) {
    bad("entry name is outside the sanitised alphabet");
  }
  return {
    outcome,
    destination,
    port: int(o["p"], 0, MAX_PORT, "entry port"),
    count: int(o["n"], 1, Number.MAX_SAFE_INTEGER, "entry count"),
  };
}

function parseEntries(v: unknown): ObservationEntry[] {
  if (!Array.isArray(v)) bad("entries is not an array");
  if (v.length > MAX_ENTRIES) bad("too many entries");
  return v.map(parseEntry);
}

function parseOs(v: unknown): ObservationWindow["os"] {
  if (v !== "linux" && v !== "darwin" && v !== "win32") bad("os is not valid");
  return v;
}

/** One window file's body, parsed strictly. Throws `BadFile` on anything the writer never writes. */
export function parseObservationFile(
  text: string,
  isInstalled: (extensionId: string) => boolean,
): ObservationWindow {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    bad("not JSON");
  }
  const o = record(json, "file");
  exactKeys(o, TOP_KEYS, ["stopped"], "file");
  if (o["v"] !== OBSERVATION_FILE_VERSION) bad("unknown version");
  const seq = int(o["seq"], 0, MAX_FILES, "seq");
  const stopped = Object.hasOwn(o, "stopped");
  // The writer marks only its last file, at the one-day bound, and only with `true`.
  if (stopped && (o["stopped"] !== true || seq !== MAX_FILES)) bad("stopped is not valid");
  const runStart = bool(o["runStart"], "runStart");
  if (runStart !== (seq === 0)) bad("runStart disagrees with seq");
  bool(o["final"], "final");
  const fromMs = int(o["fromMs"], 0, Number.MAX_SAFE_INTEGER, "fromMs");
  const toMs = int(o["toMs"], fromMs, Number.MAX_SAFE_INTEGER, "toMs");
  const label = parseLabel(o["label"], isInstalled);
  return {
    // The run is the file name's; `readWindow` sets it once the name and the body agree.
    runKey: "",
    seq,
    extensionId: label.extensionId,
    version: label.version,
    os: parseOs(o["os"]),
    networkObserved: bool(o["networkObserved"], "networkObserved"),
    runStart,
    fromMs,
    toMs,
    entries: parseEntries(o["entries"]),
    dropped: int(o["dropped"], 0, Number.MAX_SAFE_INTEGER, "dropped"),
    stopped,
  };
}

export type ObservationIngestDeps = {
  db: Database;
  dir: string;
  now: () => number;
  isInstalled: (extensionId: string) => boolean;
  /** The service id an installed extension spawns under (see {@link extensionServiceIdOf}). */
  serviceIdFor: (extensionId: string) => string | undefined;
  log: (line: string) => void;
  /** Test seam for the unlink; production passes none. */
  remove?: (path: string) => void;
  /** Test seam for reading one window file's body; production passes none. */
  readFile?: (path: string) => string;
};

/**
 * The service id an extension's spawns name their window files with: the run grant's, else the one
 * an approval would derive (the rule `extension.remove`'s cleanup uses). `undefined` for an id that
 * yields none, which could never have spawned.
 */
export function extensionServiceIdOf(db: Database, extensionId: string): string | undefined {
  const granted = getRunGrant(db, extensionId)?.service_id;
  if (granted !== undefined) return granted;
  try {
    return deriveExtensionServiceId(extensionId);
  } catch {
    return undefined;
  }
}

function removeQuietly(path: string, deps: ObservationIngestDeps, name: string): void {
  try {
    // Recursive: a planted directory goes whole, rather than failing (and being logged) every pass.
    if (deps.remove === undefined) rmSync(path, { force: true, recursive: true });
    else deps.remove(path);
  } catch (e) {
    deps.log(
      `observation: could not delete ${name}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** A directory, or a name that is neither a window file's nor a temp file's: never ingested. */
function isStray(n: string, isDirectory: boolean): boolean {
  return isDirectory || !(n.endsWith(".json") || n.endsWith(".tmp"));
}

/**
 * Removes what no pass will ever ingest, once it is older than {@link STALE_TEMP_MS}: the temp files
 * a crashed writer left behind (a fresh one may still be renamed), and any stray entry, a directory
 * included. A stray is logged once, when it goes; only gateway-user processes can write here.
 */
function sweepStale(deps: ObservationIngestDeps): void {
  for (const n of readdirSync(deps.dir)) {
    const path = join(deps.dir, n);
    try {
      const st = lstatSync(path);
      const stray = isStray(n, st.isDirectory());
      if (!stray && n.endsWith(".json")) continue;
      if (deps.now() - st.mtimeMs < STALE_TEMP_MS) continue;
      if (stray) deps.log(`observation: removed stray ${n}`);
      removeQuietly(path, deps, n);
    } catch {
      /* renamed or removed meanwhile */
    }
  }
}

/** True for a directory entry the sweep owns, so the window pass leaves it alone. */
function isDirectoryEntry(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `O_NOFOLLOW` where the OS has it (POSIX), so a link is refused by the open itself. Windows has
 * none; there the directory is the guard: it is the user's own, created 0700-equivalent, and
 * making a symbolic link in it needs a privilege a sandboxed child does not hold.
 */
const OPEN_NO_FOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

/**
 * The file's body, read from ONE descriptor: opened without following a link, checked only by
 * `fstat` on that descriptor (a regular file within the cap; no check by path before the open, so
 * nothing can change between a check and the use) and read no further than one byte past the cap.
 */
function readWindowFile(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, OPEN_NO_FOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") bad("a symbolic link");
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) bad("not a regular file");
    if (st.size > MAX_FILE_BYTES) bad("larger than 64 KiB");
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      const n = readSync(fd, buf, length, buf.length - length, null);
      if (n === 0) break;
      length += n;
      if (length > MAX_FILE_BYTES) bad("larger than 64 KiB");
    }
    return buf.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** The window, checked against the name it was found under. */
function readWindow(deps: ObservationIngestDeps, name: string): ObservationWindow {
  const parsed = parseFileName(name);
  if (parsed === null) bad("the file name is not a window file's");
  const path = join(deps.dir, name);
  const text = deps.readFile === undefined ? readWindowFile(path) : deps.readFile(path);
  const window = parseObservationFile(text, deps.isInstalled);
  if (window.seq !== parsed.seq) bad("the body's seq is not the file name's");
  if (deps.serviceIdFor(window.extensionId) !== parsed.serviceId) {
    bad("the file name's service id is not the label's extension's");
  }
  return { ...window, runKey: parsed.run };
}

type FileOutcome = "applied" | "duplicate" | "rejected" | "deferred" | "db-failed";

/**
 * A read error (EBUSY or EPERM from a scanner, ENOENT racing a removal) says nothing about the file,
 * so it is left for the next pass. Only a file that has stayed unreadable for {@link STALE_TEMP_MS}
 * is rejected, so a permanent lock cannot hold the file forever.
 */
function deferUnreadable(deps: ObservationIngestDeps, name: string, e: unknown): FileOutcome {
  const path = join(deps.dir, name);
  let ageMs: number;
  try {
    ageMs = deps.now() - lstatSync(path).mtimeMs;
  } catch {
    return "deferred";
  }
  if (ageMs < STALE_TEMP_MS) return "deferred";
  deps.log(`observation: rejected ${name}: unreadable for 10 minutes (${errorText(e)})`);
  removeQuietly(path, deps, name);
  return "rejected";
}

function ingestOne(deps: ObservationIngestDeps, name: string): FileOutcome {
  const path = join(deps.dir, name);
  let window: ObservationWindow;
  try {
    window = readWindow(deps, name);
  } catch (e) {
    if (!(e instanceof BadFile)) return deferUnreadable(deps, name, e);
    deps.log(`observation: rejected ${name}: ${e.message}`);
    removeQuietly(path, deps, name);
    return "rejected";
  }
  let fresh: boolean;
  try {
    fresh = applyObservationWindow(deps.db, window, deps.now());
  } catch (e) {
    // Nothing was committed: the file stays for the next pass.
    deps.log(`observation: could not store ${name}: ${errorText(e)}`);
    return "db-failed";
  }
  // Applied now, or on an earlier pass whose delete failed or never ran: either way it goes.
  removeQuietly(path, deps, name);
  return fresh ? "applied" : "duplicate";
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * One ingest pass: every window file in apply order, then the 90-day age-out. A run needs no end
 * marker (`final` or `stopped`): a run that ended without one simply has fewer windows. A store
 * failure stops the pass and leaves that file and every later one in place.
 */
export function ingestObservationFiles(deps: ObservationIngestDeps): {
  applied: number;
  rejected: number;
} {
  const counts = { applied: 0, rejected: 0 };
  try {
    sweepStale(deps);
    for (const name of listObservationFiles(deps.dir)) {
      if (isDirectoryEntry(join(deps.dir, name))) continue;
      const outcome = ingestOne(deps, name);
      if (outcome === "db-failed") break;
      if (outcome === "applied") counts.applied += 1;
      else if (outcome === "rejected") counts.rejected += 1;
    }
  } catch (e) {
    deps.log(`observation: ingest pass failed: ${errorText(e)}`);
  }
  // Its own try: an unreadable directory never stops retention.
  try {
    ageOutObservations(deps.db, deps.now());
  } catch (e) {
    deps.log(`observation: age-out failed: ${errorText(e)}`);
  }
  return counts;
}

/**
 * The boot pass, then one pass every {@link OBSERVATION_INGEST_INTERVAL_MS}. Returns the stop the
 * gateway's shutdown calls. The timer is unref'd, so it never holds the process open.
 */
export function startObservationIngest(
  deps: ObservationIngestDeps,
  intervalMs: number = OBSERVATION_INGEST_INTERVAL_MS,
): () => void {
  ingestObservationFiles(deps);
  const timer = setInterval(() => ingestObservationFiles(deps), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
