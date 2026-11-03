/**
 * What a sandboxed child's network did, written by its `__nimbus-sandbox` wrapper for the gateway
 * to read later (project 6, the observation half of the quality layer).
 *
 * The wrapper is the only writer and the gateway the only reader. Each window is one JSON file,
 * published atomically (a uniquely named temp file, then a rename), so a crash leaves at most a
 * stray `.tmp` and never half a file. The child never sees the channel: the two variables that name
 * it are wrapper-only (`isSandboxWrapperOnlyEnv`), and the directory is outside every grant.
 *
 * Everything recorded is a bound: a name is untrusted, child-chosen text, so it is sanitised and
 * capped before it is keyed, a window holds at most {@link MAX_ENTRIES} keys and
 * {@link MAX_FILE_BYTES} bytes, and a run writes at most {@link MAX_FILES} windows. What a bound
 * turns away is counted in `dropped`, never silently lost. Observation never breaks the child:
 * every write failure is swallowed and counted in the next file.
 *
 * File body, one JSON object:
 *   { "v": 1, "label": { "extensionId", "version" }, "seq", "runStart", "os", "networkObserved",
 *     "fromMs", "toMs", "final", "entries": [{ "o", "h", "p", "n" }], "dropped", "stopped"? }
 */

import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { sanitiseName } from "./net-forward-host.ts";

/** What the wrapper's network path reports. A refusal happens before any port is known. */
export interface NetworkObserver {
  used(host: string, port: number): void;
  refused(name: string): void;
  /**
   * The runner started the child behind a network path that reports (the Linux forwarder). Called
   * by the runner for what it DID, never inferred from the policy: until it is called every file
   * says `networkObserved: false`, which is what a fallback spawn, a no-network spawn, macOS and
   * Windows all leave it.
   */
  markObserved(): void;
}

export type ObservationLabel = { readonly extensionId: string; readonly version: string };

export type ObservationOs = "linux" | "darwin" | "win32";

export type NetworkObservationWriter = NetworkObserver & {
  /** Writes the current window. `final` marks the run's last file. */
  flush(final: boolean): void;
  /** Writes the final window, stops the timer and ignores every later event. Idempotent. */
  close(): void;
};

export type NetworkObservationWriterOptions = {
  /** `<dir>/<serviceId>.<runStartMs>.<8 hex>`; each file is `<prefix>.<seq>.json`. */
  prefix: string;
  /** Fixed at spawn, echoed in every file so a file is attributed to the version that ran. */
  label: ObservationLabel;
  os: ObservationOs;
  now?: () => number;
  /** The window length, and the period of the writer's own unref'd timer. 0 starts no timer. */
  flushMs?: number;
  writeFileAtomic?: (path: string, bytes: Uint8Array) => void;
};

export const OBSERVATION_FILE_VERSION = 1;
export const DEFAULT_OBSERVATION_FLUSH_MS = 60_000;
/** Distinct `(outcome, name, port)` keys in one window. */
export const MAX_ENTRIES = 256;
/** One window file's body. */
export const MAX_FILE_BYTES = 64 * 1024;
/** Window files per run: one day of minutes. The next file is the last, and says so. */
export const MAX_FILES = 1440;
/** The label's bounds, so it can never crowd the entries out of {@link MAX_FILE_BYTES}. */
export const MAX_LABEL_EXTENSION_ID_LENGTH = 256;
export const MAX_LABEL_VERSION_LENGTH = 64;
/** Bytes, in UTF-8. */
export const MAX_LABEL_JSON_LENGTH = 1024;
/** The longest DNS name. */
export const MAX_NAME_LENGTH = 253;

type Outcome = "used" | "refused";
type Entry = { o: Outcome; h: string; p: number; n: number };

/** The temp name for a final path: `<prefix>.<seq>.<pid>.<4 hex>.tmp`. */
export function observationTempPath(path: string, pid: number, suffix: string): string {
  const stem = path.endsWith(".json") ? path.slice(0, -".json".length) : path;
  return `${stem}.${String(pid)}.${suffix}.tmp`;
}

const TEMP_ATTEMPTS = 4;

export type AtomicWriteDeps = {
  /** The temp name's random part. Tests only. */
  suffix?: () => string;
  /** The exclusive create of the temp file. Tests only, to make it fail part-way. */
  writeTemp?: (temp: string, bytes: Uint8Array) => void;
};

function writeTempExclusive(temp: string, bytes: Uint8Array): void {
  writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
}

/**
 * Exclusive create (`wx`, 0600) of a fresh temp name, then a rename over the final path. A temp
 * name that already exists, a stale one from a crashed run say, is skipped for another, so it never
 * blocks a write. Any other failure removes the temp this call may have created before rethrowing,
 * so a disk that stays full does not leave one stray `.tmp` behind per window.
 */
export function writeObservationFileAtomic(
  path: string,
  bytes: Uint8Array,
  deps: AtomicWriteDeps = {},
): void {
  const suffix = deps.suffix ?? (() => randomBytes(2).toString("hex"));
  const writeTemp = deps.writeTemp ?? writeTempExclusive;
  for (let attempt = 0; attempt < TEMP_ATTEMPTS; attempt += 1) {
    const temp = observationTempPath(path, process.pid, suffix());
    try {
      writeTemp(temp, bytes);
    } catch (e) {
      // EEXIST: the name was someone else's, so it is left alone and another is tried.
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      rmSync(temp, { force: true });
      throw e;
    }
    try {
      renameSync(temp, path);
    } catch (e) {
      rmSync(temp, { force: true });
      throw e;
    }
    return;
  }
  throw new Error("no free temporary name for the observation file");
}

/** The name as it is keyed: the forwarder's sanitiser, then the DNS length cap. */
function boundedName(name: string): string {
  return sanitiseName(name).slice(0, MAX_NAME_LENGTH);
}

/** `used` before `refused`, then the most frequent, then by name and port: what a trim keeps. */
function byImportance(a: Entry, b: Entry): number {
  if (a.o !== b.o) return a.o === "used" ? -1 : 1;
  if (a.n !== b.n) return b.n - a.n;
  if (a.h !== b.h) return a.h < b.h ? -1 : 1;
  return a.p - b.p;
}

const encoder = new TextEncoder();
const byteLength = (s: string): number => encoder.encode(s).length;

/**
 * The entries that fit in {@link MAX_FILE_BYTES} beside `head`, most important first. `head` is the
 * body with an empty `entries` and the largest `dropped` it could carry, so the digits never push
 * a body that fit over the bound.
 */
function fitEntries(head: string, entries: readonly Entry[]): Entry[] {
  let size = byteLength(head);
  const kept: Entry[] = [];
  for (const entry of entries) {
    const add = byteLength(JSON.stringify(entry)) + (kept.length === 0 ? 0 : 1);
    if (size + add > MAX_FILE_BYTES) break;
    size += add;
    kept.push(entry);
  }
  return kept;
}

type Window = {
  fromMs: number;
  entries: Map<string, Entry>;
  dropped: number;
};

export function createNetworkObservationWriter(
  opts: NetworkObservationWriterOptions,
): NetworkObservationWriter {
  const now = opts.now ?? Date.now;
  const write = opts.writeFileAtomic ?? ((path, bytes) => writeObservationFileAtomic(path, bytes));
  const label = { extensionId: opts.label.extensionId, version: opts.label.version };
  let seq = 0;
  /** What a failed write lost, carried into the next file's `dropped`. */
  let carried = 0;
  let stopped = false;
  let closed = false;
  let networkObserved = false;
  let window: Window = { fromMs: now(), entries: new Map(), dropped: 0 };

  /** A full window makes room for a `used` key by dropping a `refused` one: a flood never hides use. */
  const evictRefused = (): boolean => {
    for (const [key, entry] of window.entries) {
      if (entry.o === "refused") {
        window.entries.delete(key);
        window.dropped += 1;
        return true;
      }
    }
    return false;
  };

  const record = (o: Outcome, h: string, p: number): void => {
    if (stopped || closed) return;
    if (h === "" || !Number.isInteger(p) || p < 0 || p > 65_535) {
      window.dropped += 1;
      return;
    }
    const key = `${o}|${h}|${String(p)}`;
    const seen = window.entries.get(key);
    if (seen !== undefined) {
      seen.n += 1;
      return;
    }
    if (window.entries.size >= MAX_ENTRIES && !(o === "used" && evictRefused())) {
      window.dropped += 1;
      return;
    }
    window.entries.set(key, { o, h, p, n: 1 });
  };

  const body = (final: boolean, toMs: number): Uint8Array => {
    const isStop = seq >= MAX_FILES;
    const fields = (entries: readonly Entry[], dropped: number) => ({
      v: OBSERVATION_FILE_VERSION,
      label,
      seq,
      runStart: seq === 0,
      os: opts.os,
      networkObserved,
      fromMs: window.fromMs,
      toMs,
      final,
      entries,
      dropped,
      ...(isStop ? { stopped: true } : {}),
    });
    const all = [...window.entries.values()].sort(byImportance);
    const kept = fitEntries(JSON.stringify(fields([], Number.MAX_SAFE_INTEGER)), all);
    const dropped = window.dropped + carried + (all.length - kept.length);
    return encoder.encode(JSON.stringify(fields(kept, dropped)));
  };

  const flush = (final: boolean): void => {
    if (stopped || closed) return;
    const toMs = now();
    const bytes = body(final, toMs);
    const lost = window.entries.size + window.dropped + carried;
    try {
      write(`${opts.prefix}.${String(seq)}.json`, bytes);
    } catch {
      // Observation never breaks the child. This window's loss is counted in the next file, and
      // `seq` stays, so a lost first file still leaves the run's start on the next one.
      carried = lost;
      window = { fromMs: window.fromMs, entries: new Map(), dropped: 0 };
      return;
    }
    if (seq >= MAX_FILES) stopped = true;
    seq += 1;
    carried = 0;
    window = { fromMs: toMs, entries: new Map(), dropped: 0 };
  };

  /** The public face of `flush`: observation never throws into the wrapper or the forwarder. */
  const safeFlush = (final: boolean): void => {
    try {
      flush(final);
    } catch {
      // Building the body cannot fail on bounded input; this keeps the promise if it ever does.
    }
  };

  // File 0 at once, empty: a run killed before its first window (SIGKILL anywhere, TerminateProcess
  // on Windows, where no handler runs) is still counted as a run.
  safeFlush(false);

  const flushMs = opts.flushMs ?? DEFAULT_OBSERVATION_FLUSH_MS;
  const timer = flushMs > 0 ? setInterval(() => safeFlush(false), flushMs) : null;
  timer?.unref();

  return {
    used: (host, port) => {
      try {
        record("used", boundedName(host), port);
      } catch {
        // Never thrown into the forwarder.
      }
    },
    refused: (name) => {
      try {
        record("refused", boundedName(name), 0);
      } catch {
        // Never thrown into the forwarder.
      }
    },
    markObserved: () => {
      networkObserved = true;
    },
    flush: safeFlush,
    close: () => {
      if (closed) return;
      if (timer !== null) clearInterval(timer);
      safeFlush(true);
      closed = true;
    },
  };
}

/**
 * The label variable's value, or null when it is not exactly `{ extensionId, version }` with two
 * non-empty strings, `extensionId` at most 256 characters, `version` at most 64 and the whole value
 * at most 1 KiB. Set by the gateway at spawn; validated here because it crosses a process.
 */
export function parseObservationLabel(raw: string | undefined): ObservationLabel | null {
  if (raw === undefined || raw === "" || byteLength(raw) > MAX_LABEL_JSON_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort((a, b) => (a < b ? -1 : 1));
  if (keys.length !== 2 || keys[0] !== "extensionId" || keys[1] !== "version") return null;
  const { extensionId, version } = o;
  if (typeof extensionId !== "string" || extensionId === "") return null;
  if (extensionId.length > MAX_LABEL_EXTENSION_ID_LENGTH) return null;
  if (typeof version !== "string" || version === "" || version.length > MAX_LABEL_VERSION_LENGTH) {
    return null;
  }
  return { extensionId, version };
}
