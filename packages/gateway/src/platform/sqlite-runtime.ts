/**
 * Point `bun:sqlite` at a FULL SQLite build on macOS, so `db.loadExtension()` works at all.
 *
 * WHY THIS EXISTS. On macOS Bun links Apple's system `libsqlite3.dylib` — a ~50% throughput win,
 * and a build with extension loading COMPILED OUT. `Database.loadExtension()` therefore cannot
 * succeed on darwin until `Database.setCustomSQLite(path)` has pointed the process at a vanilla
 * build, which is what Bun's own docs say:
 *
 *   > By default, macOS ships with Apple's proprietary build of SQLite, which doesn't support
 *   > extensions. To use extensions, install a vanilla build of SQLite … call
 *   > `Database.setCustomSQLite(path)` before creating any `Database` instances. (On other
 *   > operating systems, this is a no-op.)
 *
 * Nothing in this repo called it, which is the real cause of issue #1029: sqlite-vec has never
 * loaded on macOS, in CI *or on a user's machine*. Both of `index/sqlite-vec-load.ts`'s paths —
 * the upstream `sqlite-vec` package and the packaged `vec0.dylib` sidecar — bottom out in the
 * same `db.loadExtension()` call, so both fail together and a macOS install has no vector
 * search, no hybrid ranking and no session-memory recall. Linux and Windows use Bun's own
 * full SQLite build and are unaffected; every function here is a no-op there.
 *
 * WHY IT LIVES IN THE PAL. CLAUDE.md: OS-specific logic lives under `platform/`. Business logic
 * calls {@link ensureFullSqlite} and never learns which OS it is on — the same shape as
 * `platform/runtime-layout.ts`, which is likewise a plain module rather than a member of
 * `PlatformServices` because it must answer before the async service graph exists. A
 * process-wide install that has to run before the FIRST `new Database(...)` cannot wait for an
 * `await createPlatformServices()`.
 *
 * WHY IT IS CALLED IN SO MANY PLACES. `setCustomSQLite` is process-wide and only works before
 * SQLite is loaded, so the call has to happen in every process — and every Bun `Worker` realm —
 * that opens a database, ahead of the first open. A change landing in three of four entry points
 * looks fixed and stays broken in the fourth, so `scripts/structure-audit/check-nimbus-invariants.ts`
 * enforces the rule statically (`D30-sqlite-runtime-init`): a non-test source file that imports
 * the `Database` CONSTRUCTOR from `bun:sqlite` must also name `ensureFullSqlite`.
 *
 * OUT OF SCOPE, deliberately: what ships to a macOS end user who has no Homebrew SQLite. That
 * needs a decision about bundling a `libsqlite3.dylib` in the macOS package versus degrading
 * honestly (size, notarization and licensing consequences), and it is a separate change. What
 * this module guarantees is that such a user is TOLD — see `index/sqlite-vec-load.ts`, which now
 * surfaces the final failure at `warn` instead of `debug`.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

/**
 * Plain `process.stderr.write`, not pino, and not `console` (which `noConsole` forbids in gateway
 * source anyway).
 *
 * The reason is bundle weight in a place that matters. `db/query-guard-worker.ts` is one of the two
 * pre-bundled, binary-embedded Worker entries, and it is TINY — 996 bytes of emitted JavaScript.
 * A module-scope `pino()` here made it 140,886 bytes, a 140x increase for two log lines that worker
 * will never emit. `config/nimbus-toml.ts` already writes its loud, user-facing config refusals
 * this way, which is the same case: a boot-time message the user must see, before any logger is
 * configured.
 */
function writeStderr(prefix: string, fields: Record<string, unknown>, msg: string): void {
  const extra = Object.keys(fields).length === 0 ? "" : ` ${JSON.stringify(fields)}`;
  process.stderr.write(`${prefix} sqlite-runtime: ${msg}${extra}\n`);
}

function debugEnabled(): boolean {
  const level = process.env["NIMBUS_LOG_LEVEL"];
  return level === "debug" || level === "trace";
}

/** Environment override, checked before any built-in candidate. */
export const SQLITE_PATH_ENV = "NIMBUS_SQLITE_PATH";

/**
 * Where a Homebrew `sqlite` formula puts its library, Apple Silicon first.
 *
 * The `opt/` symlink form rather than `Cellar/sqlite/<version>/`: the versioned path changes on
 * every `brew upgrade`, and a hardcoded version is a path that rots silently.
 */
export const DARWIN_SQLITE_CANDIDATES: readonly string[] = [
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
];

export type FullSqliteState =
  /** Not darwin: Bun already uses a full SQLite build and nothing needs installing. */
  | "not-applicable"
  /** darwin, and `setCustomSQLite` accepted a library that exists on disk. */
  | "installed"
  /** darwin, and no candidate library exists. `loadExtension` will fail; the user must act. */
  | "not-found"
  /** darwin, a library existed, and `setCustomSQLite` returned false. */
  | "rejected"
  /** darwin, a library existed, and `setCustomSQLite` threw. */
  | "error";

export interface FullSqliteStatus {
  readonly state: FullSqliteState;
  /** The library actually handed to `setCustomSQLite`, or null when none was found. */
  readonly path: string | null;
  /** Every path considered, in order. Empty off darwin. */
  readonly candidates: readonly string[];
  /** One line a human can act on. Safe to log and to put on the IPC wire — no secrets. */
  readonly detail: string;
}

export interface FullSqliteDeps {
  readonly platform: NodeJS.Platform;
  readonly env: (name: string) => string | undefined;
  readonly exists: (path: string) => boolean;
  /** `Database.setCustomSQLite`. Returns false, or throws, when the library is unusable. */
  readonly setCustomSQLite: (path: string) => boolean;
  readonly warn: (fields: Record<string, unknown>, msg: string) => void;
  readonly debug: (fields: Record<string, unknown>, msg: string) => void;
}

const REMEDY =
  "install one with `brew install sqlite`, or set " +
  `${SQLITE_PATH_ENV} to a full libsqlite3.dylib`;

/**
 * The candidate list for a platform, in resolution order: the environment override first, then
 * the Homebrew prefixes. Pure, so every platform's list is exercised on every OS.
 */
export function fullSqliteCandidates(
  platform: NodeJS.Platform,
  env: (name: string) => string | undefined,
): readonly string[] {
  if (platform !== "darwin") return [];
  const override = env(SQLITE_PATH_ENV);
  const overrides = override === undefined || override.trim() === "" ? [] : [override.trim()];
  return [...overrides, ...DARWIN_SQLITE_CANDIDATES];
}

/**
 * Resolve a full SQLite and install it, reporting what happened. No caching and no module state:
 * {@link ensureFullSqlite} owns both, so this half stays a pure function of its dependencies and
 * every branch is reachable from a test on any host.
 *
 * It never throws and never exits. A macOS box with no vanilla SQLite still runs Nimbus — it just
 * runs it without semantic search, and says so.
 */
export function installFullSqlite(deps: FullSqliteDeps): FullSqliteStatus {
  const candidates = fullSqliteCandidates(deps.platform, deps.env);
  if (deps.platform !== "darwin") {
    return {
      state: "not-applicable",
      path: null,
      candidates,
      detail: `${deps.platform} uses Bun's own full SQLite build; no custom library needed`,
    };
  }

  const found = candidates.find((c) => deps.exists(c));
  if (found === undefined) {
    const detail =
      "no full SQLite build found on this macOS host, so SQLite extensions " +
      `(sqlite-vec) cannot load — ${REMEDY}`;
    // WARN, not debug. This is the whole point of the change: a user with no Homebrew SQLite has
    // no vector search, no hybrid ranking and no session-memory recall, and until now nothing
    // told them. `index/sqlite-vec-load.ts` reports the resulting vec failure at warn too; this
    // line is the one that names the CAUSE and the remedy.
    deps.warn({ candidates }, detail);
    return { state: "not-found", path: null, candidates, detail };
  }

  let accepted: boolean;
  try {
    accepted = deps.setCustomSQLite(found);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const detail = `Database.setCustomSQLite(${found}) threw: ${msg}`;
    deps.warn({ path: found, err: msg }, detail);
    return { state: "error", path: found, candidates, detail };
  }

  if (!accepted) {
    const detail =
      `Database.setCustomSQLite(${found}) returned false — either a database was already ` +
      "opened in this realm, or another realm already installed a custom SQLite for this process";
    // DEBUG, not warn, and the reason is stated rather than assumed: `setCustomSQLite` "can only
    // be run once because it loads the SQLite library into the process" (Bun's typedoc), and the
    // gateway calls this from several Worker realms in one process. A false return is therefore
    // the EXPECTED outcome of the second and later realms on a host where the first succeeded,
    // and warning on it would train the user to ignore the line that matters. The authoritative
    // signal is downstream and unambiguous: if extensions really cannot load, sqlite-vec's own
    // load fails and `index/sqlite-vec-load.ts` warns, naming this detail.
    deps.debug({ path: found }, detail);
    return { state: "rejected", path: found, candidates, detail };
  }

  const detail = `using full SQLite at ${found}`;
  deps.debug({ path: found }, detail);
  return { state: "installed", path: found, candidates, detail };
}

let cached: FullSqliteStatus | undefined;

/**
 * The real bindings {@link ensureFullSqlite} uses when a caller passes nothing.
 *
 * Exported so a test can exercise them DIRECTLY. Off darwin the production path returns
 * `not-applicable` before probing anything, so `exists`, `warn`, `debug` and `setCustomSQLite`
 * would otherwise be dead code on the two platforms that gate merges — the wiring most worth
 * checking, unchecked, on the runners that could check it.
 */
export const DEFAULT_FULL_SQLITE_DEPS: FullSqliteDeps = {
  platform: process.platform,
  env: (name) => process.env[name],
  exists: existsSync,
  setCustomSQLite: (path) => Database.setCustomSQLite(path),
  warn: (fields, msg) => writeStderr("nimbus:", fields, msg),
  debug: (fields, msg) => {
    if (debugEnabled()) writeStderr("nimbus [debug]:", fields, msg);
  },
};

/**
 * Install a full SQLite for this realm, once, and report the outcome.
 *
 * MUST be called before the first `new Database(...)` in any process or Worker realm that opens
 * one — see the file header and the `D30-sqlite-runtime-init` static rule. Idempotent: later
 * calls return the first call's status without touching SQLite again, so it is also the read
 * accessor (`diag.snapshot` uses it that way).
 */
export function ensureFullSqlite(
  deps: FullSqliteDeps = DEFAULT_FULL_SQLITE_DEPS,
): FullSqliteStatus {
  cached ??= installFullSqlite(deps);
  return cached;
}

/** Test-only: drop the memoised status so a fresh `ensureFullSqlite` runs its deps again. */
export function resetFullSqliteCacheForTest(): void {
  cached = undefined;
}
