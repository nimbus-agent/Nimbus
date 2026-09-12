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
 * enforces the rule statically (`D30-sqlite-runtime-init`): a file that value-imports the
 * `Database` CONSTRUCTOR from `bun:sqlite` must also name `ensureFullSqlite`.
 *
 * D30's REACH IS NARROWER THAN THAT SENTENCE SOUNDS, and the gap is worth knowing before trusting
 * it. `scripts/structure-audit/lib.ts`'s `iterateSourceFiles()` scans every workspace's `src` tree
 * and skips `.test.ts`, `-sql.ts`, `.d.ts`, fixtures and anything under `/testing/`; `scripts/` is
 * outside it entirely. So three callers were wired VOLUNTARILY and are not policed:
 * `scripts/test-preload/hermetic-credentials.ts` (the bunfig preload — the one call that covers
 * every test process), `packages/gateway/src/testing/bun-test-support.ts`, and
 * `scripts/gen-agent-brief-fixtures.ts`. The helpers under `packages/gateway/test/` are unwired on
 * purpose: they only ever execute inside `bun test`, where the preload has already installed.
 *
 * OUT OF SCOPE, deliberately: what ships to a macOS end user who has no Homebrew SQLite. That
 * needs a decision about bundling a `libsqlite3.dylib` in the macOS package versus degrading
 * honestly (size, notarization and licensing consequences), and it is a separate change. What
 * this module guarantees is that such a user is TOLD — see `index/sqlite-vec-load.ts`, which now
 * surfaces the final failure at `warn` instead of `debug`.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join, posix as posixPath, win32 as winPath } from "node:path";
import { getLoadablePath } from "sqlite-vec";

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

/**
 * The `sqlite-vec` loadable-extension filename for a platform.
 *
 * Lives in the PAL rather than in `index/` because it is per-OS logic and nothing else: it moved
 * down here (with {@link sidecarPath}) so {@link resolveProbeExtension} could reach it without
 * `platform/ -> index/ -> platform/`. `index/sqlite-vec-load.ts` re-exports both, so every existing
 * importer — including the packaging scripts' prose and that module's own tests — is unchanged.
 */
export function sidecarFilename(platform: NodeJS.Platform): string {
  if (platform === "win32") return "vec0.dll";
  if (platform === "darwin") return "vec0.dylib";
  return "vec0.so";
}

/** Where the packaged sidecar sits relative to an executable, on a given platform. */
export function sidecarPath(execPath: string, platform: NodeJS.Platform): string {
  const p = platform === "win32" ? winPath : posixPath;
  return p.join(p.dirname(execPath), sidecarFilename(platform));
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
  /**
   * darwin, `setCustomSQLite` returned false, AND the discriminator probe proved this process can
   * still load a SQLite extension. Benign: another realm got here first.
   */
  | "rejected"
  /**
   * darwin, `setCustomSQLite` returned false, AND the probe proved this process CANNOT load a
   * SQLite extension. Semantic search is off for this run and the install ran too late.
   */
  | "no-extensions"
  /**
   * darwin, `setCustomSQLite` returned false, and the probe could not run at all — so which of the
   * two above holds is unknown. Reported loudly rather than assumed benign.
   */
  | "unverified"
  /** darwin, a library existed, and `setCustomSQLite` threw. */
  | "error";

/**
 * What {@link FullSqliteDeps.probeExtensionLoad} found.
 *
 * `"unverified"` is a real third answer, not a failure to try: it means the extension FILE could
 * not be resolved, which says nothing about whether the SQLite build supports extensions.
 * Collapsing it into `"broken"` would report a resolution problem as a build problem.
 */
export type ExtensionProbeResult = "works" | "broken" | "unverified";

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
  /**
   * Can THIS process load a SQLite extension right now?
   *
   * Called ONLY on darwin, and only after `setCustomSQLite` returned false — see
   * {@link discriminateRejection}. It opens a throwaway `:memory:` database, so it never runs on
   * a healthy path.
   */
  readonly probeExtensionLoad: () => ExtensionProbeResult;
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
 * `setCustomSQLite` returned `false`. Decide, by MEASUREMENT, whether that mattered.
 *
 * Bun's typedoc documents two preconditions — the call "only works before SQLite is loaded" and
 * "can only be run once because it loads the SQLite library into the process" — and says nothing
 * about what the return value means. So `false` covers two outcomes with opposite consequences:
 *
 *   BENIGN    another realm, or an earlier call, already installed a full SQLite for this process.
 *             The gateway calls this from several Worker realms, so on a healthy macOS host this
 *             is the EXPECTED answer for the second and later realms. Extensions still work.
 *   TOO LATE  a database was already opened, so the process is stuck on Apple's extension-less
 *             build. Semantic search is off for this run and nothing else will say so.
 *
 * An earlier revision logged the whole state at `debug` with a `detail` string naming both
 * possibilities. The string was honest; the LEVEL was not — it acted on the benign reading only,
 * and `debug` is the exact level that hid issue #1029 for five weeks. Shipping an indistinguishable
 * state at `debug`, in the change whose whole purpose is to stop hiding this, would repeat the
 * original mistake.
 *
 * So we stop inferring and measure: open a throwaway `:memory:` database and try to load an
 * extension into it. That reads the only property anyone actually cares about, and it is cheap —
 * it runs on darwin only, and only on a path that is already anomalous.
 *
 * The probe resolves the SAME two candidates the product itself loads, in the same order — see
 * {@link resolveProbeExtension}. An earlier revision used only the NPM-resolved path, and that was
 * a real defect rather than an acceptable bound: `sqlite-vec`'s `getLoadablePath()` is
 * `import.meta.resolve`, which the worker pre-bundler inlines VERBATIM, so inside a compiled binary
 * it resolves against Bun's virtual root (`Cannot find module 'sqlite-vec-<plat>/vec0.<ext>' from
 * 'B:\~BUN\root\...'`). On the HAPPY path of the only artifact end users have — a compiled macOS
 * install with Homebrew SQLite present and semantic search working perfectly — the embedding worker
 * spawns at every boot, gets `false`, failed to resolve, and warned "semantic search is unproven"
 * on every gateway start, while `nimbus doctor` stayed green because it short-circuits on
 * `loaded === true`. Two surfaces contradicting each other, and exactly the "train the reader to
 * ignore the line that matters" failure this module invokes elsewhere. The sidecar fallback closes
 * it with no duplication, because `sidecarFilename`/`sidecarPath` live HERE now and
 * `index/sqlite-vec-load.ts` re-exports them — the dependency direction that already existed.
 */
function discriminateRejection(
  deps: FullSqliteDeps,
  found: string,
  candidates: readonly string[],
): FullSqliteStatus {
  const prefix = `Database.setCustomSQLite(${found}) returned false`;
  const probe = deps.probeExtensionLoad();
  if (probe === "works") {
    const detail =
      `${prefix}, but this process CAN still load SQLite extensions — another realm, or an ` +
      "earlier call, already installed one. Benign.";
    // Debug is correct HERE, and only here, because it is now a measured fact rather than the
    // charitable half of an ambiguity.
    deps.debug({ path: found }, detail);
    return { state: "rejected", path: found, candidates, detail };
  }
  // NEITHER message points the reader at `nimbus doctor`, and that is deliberate. Only the MAIN
  // realm's status reaches `diag.snapshot` (`ipc/diagnostics-rpc.ts`), so a Worker realm that lands
  // in either state below warns to stderr and the doctor line never mentions it — doctor would
  // print whatever the main realm found, which on a healthy install is `[ok]`. Telling the user to
  // check a surface that will disagree is worse than telling them nothing; the gateway log is the
  // record for these two.
  if (probe === "broken") {
    const detail =
      `${prefix}, and this process CANNOT load SQLite extensions — a database was opened before ` +
      "the install ran, so it is stuck on Apple's build. Semantic search is off for this run; " +
      "restarting the gateway should clear it, and the gateway log is worth attaching to a report.";
    deps.warn({ path: found }, detail);
    return { state: "no-extensions", path: found, candidates, detail };
  }
  const detail =
    `${prefix}, and whether this process can load SQLite extensions could not be determined ` +
    "(no sqlite-vec extension file resolved, from the NPM package or beside the executable). " +
    "Treat semantic search as unproven for this run.";
  deps.warn({ path: found }, detail);
  return { state: "unverified", path: found, candidates, detail };
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
    //
    // EXPECT IT MORE THAN ONCE PER GATEWAY START, and do not read that as a bug. The memo below is
    // MODULE state, so it is per REALM: on a bare macOS host the main realm, the embedding-worker
    // realm and later the query-guard realm each emit this line, with `sqlite-vec-load`'s own warn
    // on top. That is intended — each realm really did fail to install, independently — and
    // deduplicating across realms would need cross-realm state this module deliberately does not
    // have. The lines are identical, and the remedy is the same one.
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
    return discriminateRejection(deps, found, candidates);
  }

  const detail = `using full SQLite at ${found}`;
  deps.debug({ path: found }, detail);
  return { state: "installed", path: found, candidates, detail };
}

let cached: FullSqliteStatus | undefined;

/**
 * The extension file the gateway would actually load, or `null` when there is none to try.
 *
 * Both candidates, in the order `index/sqlite-vec-load.ts` tries them: the NPM package first, then
 * the packaged sidecar beside the executable. Covering only the first is what made a healthy
 * compiled macOS install warn on every boot (see the header) — in a compiled binary the NPM branch
 * CANNOT resolve, because the pre-bundler inlines `import.meta.resolve` and it evaluates against
 * Bun's virtual root, so the sidecar is the only real answer there.
 *
 * The filename is pinned to darwin rather than read from `process.platform`, because the ONE
 * production caller is the darwin-only rejection branch. A direct call from anywhere else (only the
 * unit test does this) still resolves via the NPM branch on its own platform; if that branch also
 * failed, the darwin filename would not exist and the honest answer is `"unverified"` — "we could
 * not run the probe" — which is what the caller then reports.
 */
function resolveProbeExtension(): string | null {
  try {
    return getLoadablePath();
  } catch {
    // A compiled binary: no node_modules to resolve against, only the sidecar we shipped.
  }
  const sidecar = join(dirname(process.execPath), sidecarFilename("darwin"));
  return existsSync(sidecar) ? sidecar : null;
}

/**
 * The real discriminator: open a throwaway database and try to load sqlite-vec into it.
 *
 * Resolution and loading are SEPARATE steps on purpose. No candidate existing at all means the
 * extension FILE could not be found, which says nothing about whether SQLite supports extensions,
 * so it answers `"unverified"`. Only a load that actually fails against a file that IS there
 * answers `"broken"`.
 *
 * `vec_version()` is queried after the load because `loadExtension` returning is not by itself
 * proof the module registered. The statement is finalized before `close()`: an unfinalized
 * `prepare()` makes `close()` a silent no-op in `bun:sqlite`.
 */
function defaultExtensionProbe(): ExtensionProbeResult {
  const loadable = resolveProbeExtension();
  if (loadable === null) {
    return "unverified";
  }
  const probe = new Database(":memory:");
  try {
    probe.loadExtension(loadable);
    const stmt = probe.query("SELECT vec_version()");
    try {
      stmt.get();
    } finally {
      stmt.finalize();
    }
    return "works";
  } catch {
    return "broken";
  } finally {
    probe.close();
  }
}

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
  probeExtensionLoad: defaultExtensionProbe,
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
