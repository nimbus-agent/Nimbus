#!/usr/bin/env bun
/**
 * A committed action bundle must be the build of the current sources.
 *
 * A GitHub Action runs its committed `dist/index.js` as-is: the runner never builds it. So a source
 * edit without a rebuild ships the OLD behaviour, and a `dist/` edited by hand ships code no
 * reviewer saw as source. For the registry action that matters more than for the others: its
 * `sign` mode is the content boundary of a registry (design § 7.4), so what runs must be what the
 * sources say.
 *
 * The gate rebuilds each package listed below into a temp dir with the package's own build
 * command and byte-compares the result with the committed file, after one normalisation that leaves
 * the code unchanged: CRLF becomes LF, so a checkout that converted line endings despite
 * `.gitattributes`' `eol=lf` does not read as drift. The build runs with the package as its cwd,
 * because Bun writes each module's path, relative to the cwd, into the bundle as a comment.
 *
 * Bun's bundler output changes between releases (the CommonJS interop helpers did between 1.3 and
 * 1.4), so the committed bundle is built with the Bun release line CI uses: the `bun-version`
 * default of `.github/actions/setup-nimbus-ci/action.yml`, read from that file rather than
 * restated. Under any other Bun the gate cannot tell drift from a bundler difference: locally it
 * says so and passes (rebuild or verify in `oven/bun:<line>`); in CI it fails. A Bun PATCH release
 * inside that line can change the output too; the fix is then a rebuild with the new patch.
 *
 * The other two actions (`annotate-action`, `preflight-query`) are not gated yet: preflight-query's
 * build omits `--format=esm` and its committed dist is not a fresh build today.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Action packages whose committed `dist/index.js` is gated, relative to the repo root. */
export const ACTION_PACKAGES: readonly string[] = ["packages/github-actions/registry-action"];

/** The one build command a gated package may use; the gate reproduces exactly this. */
export const ACTION_BUILD_SCRIPT =
  "bun build src/main.ts --target=node --outfile=dist/index.js --format=esm";

const DIST_OUTFILE_ARG = "--outfile=dist/index.js";

export type DistCheck = { ok: true } | { ok: false; reason: string };

const normalise = (s: string): string => s.replaceAll("\r\n", "\n");

/** The `bun-version` input default in setup-nimbus-ci's `action.yml` (e.g. `1.4`). */
export function ciBunLine(actionYml: string): string {
  const m = /bun-version:[\s\S]*?default:\s*["']?(\d+(?:\.\d+)*)["']?/.exec(actionYml);
  if (m?.[1] === undefined)
    throw new Error("setup-nimbus-ci action.yml has no bun-version default");
  return m[1];
}

/** Whether Bun `version` (e.g. `1.4.3`) belongs to release line `line` (e.g. `1.4` or `1.4.3`). */
export function isOnReleaseLine(version: string, line: string): boolean {
  return version === line || version.startsWith(`${line}.`);
}

/** Build `pkgDir`'s bundle with {@link ACTION_BUILD_SCRIPT} into a temp file and return its text. */
export function buildActionBundle(pkgDir: string): string {
  const out = mkdtempSync(join(tmpdir(), "nimbus-action-dist-build-"));
  try {
    const outfile = join(out, "index.js");
    const args = ACTION_BUILD_SCRIPT.split(" ")
      .slice(1)
      .map((a) => (a === DIST_OUTFILE_ARG ? `--outfile=${outfile}` : a));
    const r = spawnSync(process.execPath, args, {
      cwd: pkgDir,
      windowsHide: true,
      encoding: "utf8",
    });
    if (r.status !== 0) {
      throw new Error(`bun build failed in ${pkgDir}: ${r.stderr || r.stdout || String(r.error)}`);
    }
    return readFileSync(outfile, "utf8");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function buildScriptOf(pkgDir: string): unknown {
  const raw: unknown = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  if (raw === null || typeof raw !== "object" || !("scripts" in raw)) return undefined;
  const scripts: unknown = raw.scripts;
  if (scripts === null || typeof scripts !== "object" || !("build" in scripts)) return undefined;
  return scripts.build;
}

/** Whether `pkgDir`'s committed `dist/index.js` is the build of its current sources. */
export function checkActionDist(pkgDir: string): DistCheck {
  const script = buildScriptOf(pkgDir);
  if (script !== ACTION_BUILD_SCRIPT) {
    return {
      ok: false,
      reason: `package.json build script must be exactly "${ACTION_BUILD_SCRIPT}" (got ${JSON.stringify(script)})`,
    };
  }
  const committedPath = join(pkgDir, "dist", "index.js");
  if (!existsSync(committedPath)) {
    return { ok: false, reason: "dist/index.js is missing; run `bun run build` in the package" };
  }
  const committed = normalise(readFileSync(committedPath, "utf8"));
  const fresh = normalise(buildActionBundle(pkgDir));
  if (committed !== fresh) {
    return {
      ok: false,
      reason:
        "dist/index.js is not the build of the current sources; run `bun run build` in the package and commit dist/index.js",
    };
  }
  return { ok: true };
}

function main(): void {
  const repoRoot = resolve(import.meta.dir, "..", "..");
  const line = ciBunLine(
    readFileSync(join(repoRoot, ".github", "actions", "setup-nimbus-ci", "action.yml"), "utf8"),
  );
  if (!isOnReleaseLine(Bun.version, line)) {
    const msg = `action-dist: committed bundles are built with Bun ${line}.x (CI's); this is Bun ${Bun.version}, whose bundler output can differ, so drift cannot be checked here. Verify or rebuild in Docker: oven/bun:${line}`;
    if (process.env["CI"] === "true") {
      console.error(msg);
      process.exit(1);
    }
    console.warn(`${msg} (skipped)`);
    return;
  }
  let failed = false;
  for (const rel of ACTION_PACKAGES) {
    const r = checkActionDist(join(repoRoot, rel));
    if (r.ok) {
      console.log(`action-dist: ${rel} OK`);
    } else {
      failed = true;
      console.error(`action-dist: ${rel}: ${r.reason}`);
    }
  }
  if (failed) process.exit(1);
}

if (import.meta.main) {
  main();
}
