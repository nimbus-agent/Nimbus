#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Build the full SQLite that ships beside the macOS binaries.
 *
 * WHY THIS EXISTS. On macOS Bun links Apple's system SQLite, which has extension loading compiled
 * out, so `db.loadExtension()` — and therefore sqlite-vec, vector search, hybrid ranking and
 * session-memory recall — cannot work until `Database.setCustomSQLite()` has pointed the process at
 * a vanilla build (`packages/gateway/src/platform/sqlite-runtime.ts` explains that half). Until
 * this script existed the only vanilla build on a user's machine was Homebrew's, so a macOS user
 * without `brew install sqlite` had no semantic search at all — issue #1505, and a break of
 * non-negotiable #5 (platform equality), since Linux and Windows get it from Bun's own build with
 * no prerequisite at all.
 *
 * WHY WE COMPILE RATHER THAN COPY THE RUNNER'S HOMEBREW BUILD. The point is that the library we
 * SHIP is the library CI TESTED. `.github/actions/setup-nimbus-ci` builds this same artifact and
 * exports `NIMBUS_SQLITE_PATH` to it, so the 68 `skipIf(!VEC_AVAILABLE)` sites and the sqlite-vec
 * canary exercise these exact bytes. Copying whatever `brew` had installed that morning would test
 * one library and ship another.
 *
 * WHY THE FLAG SET IS EXPLICIT AND TESTED. `setCustomSQLite` repoints the WHOLE process, and this
 * library is resolved ahead of Homebrew's even on machines that have one. A build missing FTS5
 * would take keyword search AWAY from every macOS user in the act of giving them vector search, so
 * the flags are asserted in `build-sqlite-darwin.test.ts` rather than left to review.
 *
 * SQLite is public domain, so bundling it carries no license obligation — the third of the three
 * consequences (size, notarization, licensing) that `sqlite-runtime.ts` named as needing a decision.
 */

export interface SqlitePin {
  /** Dotted release version, as sqlite.org names it. */
  readonly version: string;
  /** The year directory sqlite.org files that release under. */
  readonly year: string;
  /** Amalgamation zip filename. */
  readonly zip: string;
  readonly sizeBytes: number;
  /** sqlite.org publishes SHA3-256, not SHA-256, in its download manifest. */
  readonly sha3_256: string;
}

/**
 * The pinned release.
 *
 * Every field is copied from the `PRODUCT` line on <https://sqlite.org/download.html>, which is why
 * the hash is SHA3-256: it is the hash sqlite.org itself publishes, so a reader can compare this
 * constant against the source rather than against a number we computed. Verified against that page
 * and against the downloaded bytes on 2026-09-12.
 *
 *   PRODUCT,3.53.4,2026/sqlite-amalgamation-3530400.zip,2946650,628a44cf…
 *
 * To bump: take the new PRODUCT line wholesale — version, year, zip, size and hash move together,
 * and `amalgamationNumericVersion` is asserted against the zip name, so a half-edit fails the tests
 * rather than 404ing inside a release job.
 */
export const SQLITE_PIN: SqlitePin = {
  version: "3.53.4",
  year: "2026",
  zip: "sqlite-amalgamation-3530400.zip",
  sizeBytes: 2_946_650,
  sha3_256: "628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e",
};

/**
 * sqlite.org's numeric version encoding: major, then minor, patch and a build field, each padded to
 * two digits — `3.53.4` is `3530400`, not `35304`.
 *
 * Worth its own function and its own test because it is the part of the URL a human gets wrong, and
 * getting it wrong means a 404 inside a release job rather than anywhere a test would see it.
 */
export function amalgamationNumericVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (m === null) {
    throw new Error(
      `build-sqlite-darwin: version must be three dotted numbers (e.g. 3.53.4), got "${version}"`,
    );
  }
  const [, major, minor, patch] = m as unknown as [string, string, string, string];
  return `${major}${minor.padStart(2, "0")}${patch.padStart(2, "0")}00`;
}

export function amalgamationUrl(pin: SqlitePin): string {
  return `https://sqlite.org/${pin.year}/${pin.zip}`;
}

/**
 * Refuse anything but the pinned bytes.
 *
 * The checksum is the trust anchor, not the URL: this runs in CI and in the release job, both of
 * which fetch over the network, and a mirror or redirect serving different bytes would otherwise be
 * compiled and shipped. Size is checked first so the common failure — a truncated download or an
 * error page — reports as a size, which is legible, rather than as a hash mismatch, which is not.
 */
export function assertDownloadMatchesPin(bytes: Uint8Array, pin: SqlitePin): void {
  if (bytes.byteLength !== pin.sizeBytes) {
    throw new Error(
      `build-sqlite-darwin: ${pin.zip} is ${String(bytes.byteLength)} bytes, expected ` +
        `${String(pin.sizeBytes)} — refusing to compile an unexpected download`,
    );
  }
  const got = createHash("sha3-256").update(bytes).digest("hex");
  if (got !== pin.sha3_256) {
    throw new Error(
      `build-sqlite-darwin: ${pin.zip} SHA3-256 is ${got}, expected ${pin.sha3_256} — ` +
        "refusing to compile an unexpected download",
    );
  }
}

/**
 * Just enough of `fetch` to make the download policy testable.
 *
 * Narrower than `typeof fetch` deliberately: that type carries Bun's `preconnect` property, which a
 * test double would have to fake for no reason. What this arm actually uses is a URL, a signal and
 * a `Response`.
 */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface FetchDeps {
  readonly fetch: FetchLike;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface DownloadPolicy {
  /** Total attempts, not retries after the first. */
  readonly attempts: number;
  /** Per-attempt deadline. Applies to the whole attempt, headers and body alike. */
  readonly timeoutMs: number;
  readonly backoffMs: number;
}

/**
 * Bounded, because the alternative is unbounded.
 *
 * Bun's `fetch` has NO default timeout, so a half-open connection to sqlite.org would block until
 * the JOB timeout — 45 minutes of a paid macOS runner on the release workflow, reported as a
 * timeout with no indication of which step stalled. The retry exists for the same reason the step
 * is fatal: this is now a payload component, so a transient mirror blip should cost 2 seconds
 * rather than a release.
 */
export const DOWNLOAD_POLICY: DownloadPolicy = { attempts: 3, timeoutMs: 60_000, backoffMs: 2_000 };

/** A status worth trying again: rate limiting and server-side faults, never a client error. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Download the pinned amalgamation, verify it, and return the bytes.
 *
 * Retries only what can plausibly succeed on a second try — a thrown transport error (which
 * includes the abort raised by the per-attempt timeout) and a retryable status. A 404 is NOT
 * retried: it means the pin names something that does not exist, and three attempts would turn a
 * clear error into a slow one. A CHECKSUM failure is not retried either — wrong bytes from a mirror
 * are not a transient condition, and retrying into them would be asking a bad source twice.
 */
export async function fetchAmalgamation(
  pin: SqlitePin,
  deps: FetchDeps,
  policy: DownloadPolicy = DOWNLOAD_POLICY,
): Promise<Uint8Array> {
  const url = amalgamationUrl(pin);
  let last = "";
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    try {
      const res = await deps.fetch(url, { signal: AbortSignal.timeout(policy.timeoutMs) });
      if (!res.ok) {
        if (!isRetryableStatus(res.status)) {
          throw new Error(
            `build-sqlite-darwin: GET ${url} -> ${String(res.status)} (not retryable)`,
          );
        }
        last = `HTTP ${String(res.status)}`;
      } else {
        const bytes = new Uint8Array(await res.arrayBuffer());
        // Outside the retry decision on purpose: a mismatch throws straight out of the loop.
        assertDownloadMatchesPin(bytes, pin);
        return bytes;
      }
    } catch (e) {
      if (e instanceof Error && /not retryable|SHA3-256|refusing to compile/.test(e.message))
        throw e;
      last = e instanceof Error ? e.message : String(e);
    }
    if (attempt < policy.attempts) await deps.sleep(policy.backoffMs * attempt);
  }
  throw new Error(
    `build-sqlite-darwin: GET ${url} failed after ${String(policy.attempts)} attempts (${last})`,
  );
}

/** Node's `process.arch` spelling mapped to the one `clang -arch` wants. */
const CLANG_ARCH: Readonly<Record<string, string>> = { arm64: "arm64", x64: "x86_64" };

export interface ClangArgsOptions {
  readonly sourceC: string;
  readonly outDylib: string;
  /** A `process.arch` value. */
  readonly arch: string;
  readonly minMacos: string;
}

/**
 * Deployment target.
 *
 * Deliberately older than anything Bun itself supports, so this library is never the component that
 * decides which macOS versions Nimbus runs on.
 */
export const MIN_MACOS = "11.0";

/** The library filename — must match `platform/sqlite-runtime.ts`'s `BUNDLED_SQLITE_FILENAME`. */
export const OUTPUT_FILENAME = "libsqlite3.dylib";

/**
 * The compile line.
 *
 * The feature flags are a superset of what a Homebrew `sqlite` build provides, because this library
 * is resolved AHEAD of Homebrew's — a user who has one must not lose capability by upgrading
 * Nimbus. `SQLITE_OMIT_LOAD_EXTENSION` is deliberately absent (extension loading is on unless
 * omitted, and there is no positive flag to assert instead), which is why the test asserts its
 * ABSENCE rather than some enabling flag's presence.
 */
export function clangArgs(opts: ClangArgsOptions): string[] {
  const arch = CLANG_ARCH[opts.arch];
  if (arch === undefined) {
    throw new Error(
      `build-sqlite-darwin: no macOS architecture name for "${opts.arch}" ` +
        `(known: ${Object.keys(CLANG_ARCH).join(", ")})`,
    );
  }
  return [
    "-O2",
    "-dynamiclib",
    "-arch",
    arch,
    `-mmacosx-version-min=${opts.minMacos}`,
    "-install_name",
    "@rpath/libsqlite3.dylib",
    "-DSQLITE_THREADSAFE=1",
    "-DSQLITE_ENABLE_FTS5",
    "-DSQLITE_ENABLE_FTS4",
    "-DSQLITE_ENABLE_RTREE",
    "-DSQLITE_ENABLE_GEOPOLY",
    "-DSQLITE_ENABLE_DBSTAT_VTAB",
    "-DSQLITE_ENABLE_COLUMN_METADATA",
    "-DSQLITE_ENABLE_MATH_FUNCTIONS",
    "-DSQLITE_ENABLE_DESERIALIZE",
    "-DSQLITE_MAX_VARIABLE_NUMBER=250000",
    opts.sourceC,
    "-o",
    opts.outDylib,
  ];
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`build-sqlite-darwin: ${cmd[0] ?? "?"} exited ${String(code)}`);
  }
}

/**
 * Download, verify, extract and compile. macOS only — it shells out to `clang`.
 *
 * The download is cached under the pinned zip name and re-verified on reuse, so a second invocation
 * in the same job (the CI action builds before the tests; the release job builds before packaging)
 * does not re-fetch, and a corrupted cache entry is refetched rather than compiled.
 */
export async function buildBundledSqlite(destDir: string, workDir: string): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error(
      `build-sqlite-darwin: darwin only — ${process.platform} uses Bun's own full SQLite build`,
    );
  }
  mkdirSync(workDir, { recursive: true });
  mkdirSync(destDir, { recursive: true });

  const zipPath = join(workDir, SQLITE_PIN.zip);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(zipPath));
    assertDownloadMatchesPin(bytes, SQLITE_PIN);
  } catch {
    const url = amalgamationUrl(SQLITE_PIN);
    process.stdout.write(`build-sqlite-darwin: fetching ${url}\n`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`build-sqlite-darwin: GET ${url} -> ${String(res.status)}`);
    }
    bytes = new Uint8Array(await res.arrayBuffer());
    assertDownloadMatchesPin(bytes, SQLITE_PIN);
    writeFileSync(zipPath, bytes);
  }

  const srcDir = join(
    workDir,
    `sqlite-amalgamation-${amalgamationNumericVersion(SQLITE_PIN.version)}`,
  );
  rmSync(srcDir, { recursive: true, force: true });
  await run(["unzip", "-q", "-o", zipPath, "-d", workDir]);

  const out = join(destDir, OUTPUT_FILENAME);
  await run([
    "clang",
    ...clangArgs({
      sourceC: join(srcDir, "sqlite3.c"),
      outDylib: out,
      arch: process.arch,
      minMacos: MIN_MACOS,
    }),
  ]);
  return out;
}

if (import.meta.main) {
  const arg = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const destDir = resolve(arg("--dest") ?? "dist");
  const workDir = resolve(arg("--work") ?? join(destDir, ".sqlite-build"));
  const out = await buildBundledSqlite(destDir, workDir);
  process.stdout.write(
    `build-sqlite-darwin: → ${out} (${String(statSync(out).size)} bytes, ` +
      `SQLite ${SQLITE_PIN.version})\n`,
  );
}
