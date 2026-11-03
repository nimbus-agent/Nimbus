import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
 * name alphabet the writer's sanitiser produces, and an installed extension in the label. A bad file
 * is deleted and counted, never applied in part; a good one is deleted only after its rows commit.
 * Observation is evidence only: nothing here decides a spawn, a grant or a network rule.
 */

export const OBSERVATION_DIR_NAME = "extension-observations";
/** How often the running gateway ingests, beside the pass at boot. */
export const OBSERVATION_INGEST_INTERVAL_MS = 60_000;
/** A temp file older than this is a crashed writer's leftover, and is removed. */
export const STALE_TEMP_MS = 10 * 60_000;

/** `<dataDir>/extension-observations`: the one spelling of the directory. */
export function extensionObservationDirFor(dataDir: string): string {
  return join(dataDir, OBSERVATION_DIR_NAME);
}

/** Creates the directory owner-only (0700; the mode is a no-op on Windows) and returns it. */
export function ensureObservationDir(dataDir: string): string {
  const dir = extensionObservationDirFor(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
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

type ParsedName = { name: string; run: string; seq: number };

function parseFileName(name: string): ParsedName | null {
  const m = FILE_NAME_RE.exec(name);
  if (m === null) return null;
  return { name, run: `${m[1]}.${m[2]}.${m[3]}`, seq: Number(m[4]) };
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
  if (outcome !== "used" && outcome !== "refused") bad("entry outcome is not valid");
  const destination = boundedString(o["h"], MAX_NAME_LENGTH, "entry name");
  if (!NAME_RE.test(destination)) bad("entry name is outside the sanitised alphabet");
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
  if (Object.hasOwn(o, "stopped") && o["stopped"] !== true) bad("stopped is not true");
  const seq = int(o["seq"], 0, MAX_FILES, "seq");
  const runStart = bool(o["runStart"], "runStart");
  if (runStart !== (seq === 0)) bad("runStart disagrees with seq");
  bool(o["final"], "final");
  const fromMs = int(o["fromMs"], 0, Number.MAX_SAFE_INTEGER, "fromMs");
  const toMs = int(o["toMs"], fromMs, Number.MAX_SAFE_INTEGER, "toMs");
  const label = parseLabel(o["label"], isInstalled);
  return {
    extensionId: label.extensionId,
    version: label.version,
    os: parseOs(o["os"]),
    networkObserved: bool(o["networkObserved"], "networkObserved"),
    runStart,
    fromMs,
    toMs,
    entries: parseEntries(o["entries"]),
    dropped: int(o["dropped"], 0, Number.MAX_SAFE_INTEGER, "dropped"),
  };
}

export type ObservationIngestDeps = {
  db: Database;
  dir: string;
  now: () => number;
  isInstalled: (extensionId: string) => boolean;
  log: (line: string) => void;
};

function removeQuietly(path: string, deps: ObservationIngestDeps, name: string): void {
  try {
    rmSync(path, { force: true });
  } catch (e) {
    deps.log(
      `observation: could not delete ${name}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Removes temp files a crashed writer left behind; a fresh one may still be renamed. */
function sweepTemps(deps: ObservationIngestDeps): void {
  for (const n of readdirSync(deps.dir)) {
    if (!n.endsWith(".tmp")) continue;
    const path = join(deps.dir, n);
    try {
      if (deps.now() - lstatSync(path).mtimeMs >= STALE_TEMP_MS) removeQuietly(path, deps, n);
    } catch {
      /* renamed or removed meanwhile */
    }
  }
}

/** The file's body, or a reason it is not a window file at all. */
function readWindowFile(path: string, name: string): string {
  if (parseFileName(name) === null) bad("the file name is not a window file's");
  const st = lstatSync(path);
  if (!st.isFile()) bad("not a regular file");
  if (st.size > MAX_FILE_BYTES) bad("larger than 64 KiB");
  return readFileSync(path, "utf8");
}

type FileOutcome = "applied" | "rejected" | "db-failed";

function ingestOne(deps: ObservationIngestDeps, name: string): FileOutcome {
  const path = join(deps.dir, name);
  let window: ObservationWindow;
  try {
    window = parseObservationFile(readWindowFile(path, name), deps.isInstalled);
  } catch (e) {
    const why = e instanceof BadFile ? e.message : "unreadable";
    deps.log(`observation: rejected ${name}: ${why}`);
    removeQuietly(path, deps, name);
    return "rejected";
  }
  try {
    applyObservationWindow(deps.db, window);
  } catch (e) {
    // Nothing was committed: the file stays for the next pass.
    deps.log(`observation: could not store ${name}: ${e instanceof Error ? e.message : String(e)}`);
    return "db-failed";
  }
  removeQuietly(path, deps, name);
  return "applied";
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
  let applied = 0;
  let rejected = 0;
  try {
    sweepTemps(deps);
    for (const name of listObservationFiles(deps.dir)) {
      const outcome = ingestOne(deps, name);
      if (outcome === "db-failed") break;
      if (outcome === "applied") applied += 1;
      else rejected += 1;
    }
    ageOutObservations(deps.db, deps.now());
  } catch (e) {
    deps.log(`observation: ingest pass failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { applied, rejected };
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
