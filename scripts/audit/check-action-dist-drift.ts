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
 * Bun's bundler output changes between releases (the CommonJS interop helpers did between 1.3.14
 * and 1.4.3), so a byte comparison is only meaningful against the SAME Bun. The package's build
 * (`--build`, which its `package.json` `build` script runs) therefore writes a first-line header
 * recording the exact Bun version that built the bundle and an `inputHash`: SHA-256 over the
 * canonical build command plus every module the bundler read (path and content, `node_modules`
 * packages included, so a lockfile bump counts). The gate strips the header and checks two things:
 *
 * 1. ALWAYS, on any Bun: `inputHash` recomputed from a fresh metafile equals the recorded one. The
 *    input set and contents do not depend on the Bun version, so this runs on dev machines too.
 * 2. The stripped body is byte-identical to a fresh build made with the RECORDED Bun. When the
 *    running Bun is that version, it builds directly. Otherwise, in CI (`CI=true`), it runs
 *    `bun x bun@<recorded> build …`, and failing to obtain or run that Bun is a failure, never a
 *    skip. Locally, off that version, it says only the input hash was checked and passes.
 *
 * CRLF is normalised to LF on both sides, so a checkout that converted line endings despite
 * `.gitattributes`' `eol=lf` does not read as drift. Every build runs with the package as its cwd,
 * because Bun writes each module's path, relative to the cwd, into the bundle as a comment.
 *
 * The other two actions (`annotate-action`, `preflight-query`) are not gated yet.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

/** Action packages whose committed `dist/index.js` is gated, relative to the repo root. */
export const ACTION_PACKAGES: readonly string[] = ["packages/github-actions/registry-action"];

/** The `build` script a gated package must have: this file's `--build` mode, run from the package. */
export const ACTION_BUILD_SCRIPT = "bun ../../../scripts/audit/check-action-dist-drift.ts --build";

/** The bundler invocation, minus `--outfile`; hashed into `inputHash` in this spelling. */
const BUNDLE_ARGS = ["build", "src/main.ts", "--target=node", "--format=esm"] as const;
const CANONICAL_COMMAND = `bun ${BUNDLE_ARGS.join(" ")} --outfile=dist/index.js`;

const HEADER_RE = /^\/\/ nimbus-action-dist bun=(\S+) inputHash=sha256:([0-9a-f]{64})\n/;
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface DistHeader {
  /** The exact Bun version that built the bundle. */
  bun: string;
  /** Hex SHA-256 over the canonical command and every bundled input. */
  inputHash: string;
}

/** Runs a command; `status` 0 is success. Injected so tests can stand in for `bun x bun@…`. */
export type Spawn = (
  argv: readonly string[],
  cwd: string,
) => { status: number | null; output: string };

export const realSpawn: Spawn = (argv, cwd) => {
  const [cmd, ...args] = argv;
  if (cmd === undefined) throw new Error("empty argv");
  const r = spawnSync(cmd, args, { cwd, windowsHide: true, encoding: "utf8" });
  return {
    status: r.status,
    output: `${r.stderr ?? ""}${r.stdout ?? ""}${r.error ? String(r.error) : ""}`,
  };
};

export interface GateEnv {
  /** Whether this is CI, where an unverifiable byte comparison fails instead of passing. */
  ci: boolean;
  /** `Bun.version` of the running process. */
  runningVersion: string;
  /** The running Bun executable. */
  bunExe: string;
  spawn: Spawn;
}

export type DistCheck = { ok: true; notice?: string } | { ok: false; reason: string };

const normalise = (s: string): string => s.replaceAll("\r\n", "\n");
const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

export function formatHeader(h: DistHeader): string {
  return `// nimbus-action-dist bun=${h.bun} inputHash=sha256:${h.inputHash}\n`;
}

/** Split a committed bundle into its header and body; `null` when the header is absent. */
export function parseDist(text: string): { header: DistHeader; body: string } | null {
  const t = normalise(text);
  const m = HEADER_RE.exec(t);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  return { header: { bun: m[1], inputHash: m[2] }, body: t.slice(m[0].length) };
}

/**
 * `inputHash` from a bundler metafile: the canonical command, then each real input (Bun's virtual
 * `bun:` modules excluded) as its package-relative path and the SHA-256 of its content, sorted.
 */
export function computeInputHash(pkgDir: string, metafileJson: string): string {
  const meta: unknown = JSON.parse(metafileJson);
  if (meta === null || typeof meta !== "object" || !("inputs" in meta)) {
    throw new Error("bundler metafile has no inputs");
  }
  const inputs: unknown = meta.inputs;
  if (inputs === null || typeof inputs !== "object")
    throw new Error("bundler metafile has no inputs");
  const lines = Object.keys(inputs)
    .filter((k) => !k.startsWith("bun:"))
    .map((k) => {
      const abs = resolve(pkgDir, k);
      const rel = relative(pkgDir, abs).replaceAll("\\", "/");
      const content = normalise(readFileSync(abs).toString("latin1"));
      return `${rel}\0${sha256(Buffer.from(content, "latin1"))}`;
    })
    .sort();
  return sha256(`${CANONICAL_COMMAND}\n${lines.join("\n")}\n`);
}

/**
 * Bundle `pkgDir` with the Bun `runner` argv prefix; returns the body and the metafile. Every build
 * passes `--metafile`, so the committed and the fresh bodies come from the same invocation shape.
 */
function bundle(
  pkgDir: string,
  runner: readonly string[],
  spawn: Spawn,
): { body: string; metafile: string } {
  const out = mkdtempSync(join(tmpdir(), "nimbus-action-dist-build-"));
  try {
    const outfile = join(out, "index.js");
    const metafile = join(out, "meta.json");
    const argv = [...runner, ...BUNDLE_ARGS, `--outfile=${outfile}`, `--metafile=${metafile}`];
    const r = spawn(argv, pkgDir);
    if (r.status !== 0 || !existsSync(outfile) || !existsSync(metafile)) {
      throw new Error(`\`${argv.join(" ")}\` failed in ${pkgDir}: ${r.output.trim()}`);
    }
    return {
      body: normalise(readFileSync(outfile, "utf8")),
      metafile: readFileSync(metafile, "utf8"),
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Build with the running Bun: the body plus the header that records it. */
export function buildDistText(
  pkgDir: string,
  env: Pick<GateEnv, "runningVersion" | "bunExe" | "spawn">,
): string {
  const r = bundle(pkgDir, [env.bunExe], env.spawn);
  const inputHash = computeInputHash(pkgDir, r.metafile);
  return formatHeader({ bun: env.runningVersion, inputHash }) + r.body;
}

function buildScriptOf(pkgDir: string): unknown {
  const raw: unknown = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  if (raw === null || typeof raw !== "object" || !("scripts" in raw)) return undefined;
  const scripts: unknown = raw.scripts;
  if (scripts === null || typeof scripts !== "object" || !("build" in scripts)) return undefined;
  return scripts.build;
}

const REBUILD = "rebuild it with `bun run build` in the package under the Bun that CI uses";

/** Whether `pkgDir`'s committed `dist/index.js` is the build of its current sources. */
export function checkActionDist(pkgDir: string, env: GateEnv): DistCheck {
  const script = buildScriptOf(pkgDir);
  if (script !== ACTION_BUILD_SCRIPT) {
    return {
      ok: false,
      reason: `package.json build script must be exactly "${ACTION_BUILD_SCRIPT}" (got ${JSON.stringify(script)})`,
    };
  }
  const distPath = join(pkgDir, "dist", "index.js");
  if (!existsSync(distPath)) return { ok: false, reason: `dist/index.js is missing; ${REBUILD}` };
  const committed = parseDist(readFileSync(distPath, "utf8"));
  if (committed === null) {
    return { ok: false, reason: `dist/index.js has no nimbus-action-dist header; ${REBUILD}` };
  }
  const recorded = committed.header.bun;
  if (!EXACT_VERSION_RE.test(recorded)) {
    return { ok: false, reason: `dist/index.js header names no exact Bun version: ${recorded}` };
  }

  const fresh = bundle(pkgDir, [env.bunExe], env.spawn);
  if (computeInputHash(pkgDir, fresh.metafile) !== committed.header.inputHash) {
    return {
      ok: false,
      reason: `dist/index.js inputHash does not match the current sources and dependencies; ${REBUILD}`,
    };
  }

  let freshBody: string;
  if (env.runningVersion === recorded) {
    freshBody = fresh.body;
  } else if (env.ci) {
    try {
      freshBody = bundle(pkgDir, [env.bunExe, "x", `bun@${recorded}`], env.spawn).body;
    } catch (err) {
      return {
        ok: false,
        reason: `could not build with Bun ${recorded}, which built dist/index.js: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    return {
      ok: true,
      notice: `only the input hash was checked: dist/index.js was built with Bun ${recorded} and this is Bun ${env.runningVersion}, whose bundler output can differ (CI compares the bytes with Bun ${recorded})`,
    };
  }
  if (freshBody !== committed.body) {
    return {
      ok: false,
      reason: `dist/index.js is not the Bun ${recorded} build of the current sources (edited by hand?); ${REBUILD}`,
    };
  }
  return { ok: true };
}

export interface MainDeps extends GateEnv {
  repoRoot: string;
  cwd: string;
  packages: readonly string[];
  log: (msg: string) => void;
  error: (msg: string) => void;
}

/** `--build` writes the cwd package's `dist/index.js`; no argument checks every gated package. */
export function main(args: readonly string[], deps: MainDeps): number {
  if (args[0] === "--build") {
    writeFileSync(join(deps.cwd, "dist", "index.js"), buildDistText(deps.cwd, deps));
    deps.log(`action-dist: wrote dist/index.js (Bun ${deps.runningVersion})`);
    return 0;
  }
  if (args.length > 0) {
    deps.error(`action-dist: unknown arguments: ${args.join(" ")}`);
    return 2;
  }
  let failed = false;
  for (const rel of deps.packages) {
    const r = checkActionDist(join(deps.repoRoot, rel), deps);
    if (!r.ok) {
      failed = true;
      deps.error(`action-dist: ${rel}: ${r.reason}`);
    } else {
      deps.log(`action-dist: ${rel} OK${r.notice === undefined ? "" : ` (${r.notice})`}`);
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  process.exit(
    main(process.argv.slice(2), {
      ci: process.env["CI"] === "true",
      runningVersion: Bun.version,
      bunExe: process.execPath,
      spawn: realSpawn,
      repoRoot: resolve(import.meta.dir, "..", ".."),
      cwd: process.cwd(),
      packages: ACTION_PACKAGES,
      log: console.log,
      error: console.error,
    }),
  );
}
