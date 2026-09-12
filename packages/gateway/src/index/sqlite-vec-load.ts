import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join, posix as posixPath, win32 as winPath } from "node:path";
import pino from "pino";
import { load as loadSqliteVec } from "sqlite-vec";
import { ensureFullSqlite } from "../platform/sqlite-runtime.ts";

const log = pino({
  name: "sqlite-vec-load",
  level: process.env["NIMBUS_LOG_LEVEL"] ?? "info",
});

/**
 * Why sqlite-vec is not loaded, after BOTH load paths have been tried.
 *
 * Recorded rather than only logged so `diag.snapshot` — and therefore `nimbus doctor` — can
 * answer the question without the user having to re-run the gateway at `NIMBUS_LOG_LEVEL=debug`.
 */
export interface VecLoadFailure {
  /** Message from the upstream `sqlite-vec` package's own `load()`. */
  readonly upstreamError: string;
  /** Where the packaged sidecar was looked for. */
  readonly sidecarPath: string;
  /** Why the sidecar did not load — a thrown message, or that the file is absent. */
  readonly sidecarError: string;
  /** What the PAL did about a full SQLite build on this host (macOS is the interesting case). */
  readonly sqliteRuntime: string;
}

let lastFailure: VecLoadFailure | undefined;

/**
 * The composed reason string already warned about, so a gateway that opens dozens of connections
 * emits ONE warning and not dozens. Keyed on the reason rather than a plain boolean: a genuinely
 * different failure later in the run is new information and still gets said out loud.
 */
let warnedReason: string | undefined;

/** How many times {@link warnVecUnavailable} has actually emitted a warning. Test-only reader. */
let warnCount = 0;

/** The most recent both-paths-failed reason, or undefined if vec has never failed to load. */
export function lastVecLoadFailure(): VecLoadFailure | undefined {
  return lastFailure;
}

/** Test-only: forget the recorded failure, the warn-once key and the emitted-warning count. */
export function resetVecLoadFailureForTest(): void {
  lastFailure = undefined;
  warnedReason = undefined;
  warnCount = 0;
}

/** Test-only: how many warnings have actually been emitted since the last reset. */
export function vecLoadWarnCountForTest(): number {
  return warnCount;
}

interface SidecarAttempt {
  readonly ok: boolean;
  readonly path: string;
  readonly error: string;
}

function attemptSidecar(db: Database, baseDir: string): SidecarAttempt {
  const path = join(baseDir, sidecarFilename(process.platform));
  if (!existsSync(path)) {
    log.debug({ sidecar: path }, "sqlite-vec sidecar not found; semantic memory disabled");
    return { ok: false, path, error: "sidecar file not present" };
  }
  try {
    db.loadExtension(path);
    log.debug({ via: "sidecar", sidecar: path }, "sqlite-vec loaded");
    return { ok: true, path, error: "" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.debug({ sidecar: path, err: msg }, "sqlite-vec sidecar load failed");
    return { ok: false, path, error: msg };
  }
}

/**
 * Say — once, at a level the default logger actually prints — that semantic search is off.
 *
 * BEFORE THIS, the only record of a vec load failure was `log.debug`, on a logger built at
 * `NIMBUS_LOG_LEVEL ?? "info"`. Debug is suppressed by default, so the sqlite-vec failure that
 * has affected every macOS install since the feature shipped (issue #1029) produced no output
 * at all: the product silently had no vector search, no hybrid ranking and no session-memory
 * recall, and the first person to see the underlying error saw it five weeks later.
 *
 * It fires only after BOTH paths have failed. Warning per attempt would put a line on every
 * healthy Linux and Windows run too, since the sidecar is only consulted when the upstream
 * package has already failed — and a warning that fires when nothing is wrong is one users learn
 * to filter out.
 */
function warnVecUnavailable(failure: VecLoadFailure): void {
  const reason =
    `${failure.upstreamError} | sidecar ${failure.sidecarPath}: ${failure.sidecarError} | ` +
    failure.sqliteRuntime;
  if (warnedReason === reason) {
    log.debug({ reason }, "sqlite-vec still unavailable");
    return;
  }
  warnedReason = reason;
  warnCount += 1;
  log.warn(
    {
      upstreamError: failure.upstreamError,
      sidecarPath: failure.sidecarPath,
      sidecarError: failure.sidecarError,
      sqliteRuntime: failure.sqliteRuntime,
    },
    "sqlite-vec could not be loaded — semantic search (vector search, hybrid ranking and " +
      "session-memory recall) is UNAVAILABLE for this run. Keyword search still works. " +
      "Run `nimbus doctor` for the remedy.",
  );
}

export function tryLoadSqliteVec(db: Database): boolean {
  try {
    loadSqliteVec(db);
    log.debug({ via: "npm" }, "sqlite-vec loaded");
    return true;
  } catch (e) {
    const upstreamError = e instanceof Error ? e.message : String(e);
    log.debug({ err: upstreamError }, "upstream sqlite-vec load failed; trying sidecar");
    const sidecar = attemptSidecar(db, dirname(process.execPath));
    if (sidecar.ok) {
      return true;
    }
    // `ensureFullSqlite()` is idempotent and every entry point has already called it, so this is
    // a read of what the PAL decided, not a late install. It is what turns "loadExtension failed"
    // into "…because this macOS host has no full SQLite build; run `brew install sqlite`".
    const failure: VecLoadFailure = {
      upstreamError,
      sidecarPath: sidecar.path,
      sidecarError: sidecar.error,
      sqliteRuntime: ensureFullSqlite().detail,
    };
    lastFailure = failure;
    warnVecUnavailable(failure);
    return false;
  }
}

export function loadSqliteVecOrThrow(db: Database): void {
  if (!tryLoadSqliteVec(db)) {
    throw new Error(
      "sqlite-vec could not be loaded. Embeddings require a supported platform (see sqlite-vec npm optionalDependencies).",
    );
  }
}

export function isVecLoaded(db: Database): boolean {
  try {
    db.query("SELECT vec_version()").get();
    return true;
  } catch {
    return false;
  }
}

export function ensureSqliteVecForConnection(db: Database, indexedUserVersion: number): boolean {
  if (indexedUserVersion < 6) {
    return true;
  }
  try {
    db.query("SELECT vec_version()").get();
    return true;
  } catch {
    return tryLoadSqliteVec(db);
  }
}

export function sidecarFilename(platform: NodeJS.Platform): string {
  if (platform === "win32") return "vec0.dll";
  if (platform === "darwin") return "vec0.dylib";
  return "vec0.so";
}

export function sidecarPath(execPath: string, platform: NodeJS.Platform): string {
  const p = platform === "win32" ? winPath : posixPath;
  return p.join(p.dirname(execPath), sidecarFilename(platform));
}

export function tryLoadFromSidecar(
  db: Database,
  baseDir: string = dirname(process.execPath),
): boolean {
  return attemptSidecar(db, baseDir).ok;
}
