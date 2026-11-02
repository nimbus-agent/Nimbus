/**
 * `mode: score-package` — scores ONE package for a registry that publishes through
 * `nimbus registry maintain add` instead of pull requests. The `package` input is a `.tgz` file and
 * nothing else. A directory cannot be scored: this mode runs under the runner's Node and
 * `maintain add` under Bun, the two gzip the same tree into different bytes, and the `--scores`
 * binding is a hash of the bytes. So a job that runs no extension code packs once (`nimbus extension
 * pack`), and this mode and `maintain add` both take that file. The bytes are read once and
 * everything after that works on those bytes.
 *
 * It runs extension code, so like `score` it holds no secret (`main.ts` refuses `root-key` and
 * `github-token`). It does not run `validatePublish`: `maintain add` validates against the real
 * index afterwards, and the hash binds the two. A package that cannot be inspected, or a path that
 * is not a `.tgz`, fails the job: there is nothing to publish. What is recorded is `scoreVersion`'s: the
 * baseline for every package that is not a starter pack, and the quality when it holds suites.
 * `scores.json` is `{}` when nothing was recorded, written through a temp sibling and a rename.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectPackage,
  isEvalSuiteFile,
  isStarterPack,
  MAX_PACKAGE_BYTES,
  parseExtensionManifestForRegistry,
} from "../../../registry-format/src/index.ts";
import { type ActionIo, GHA_IO } from "./report.ts";
import {
  assertGateway,
  emptyRun,
  recordVersion,
  reportScores,
  type ScoresFile,
  writeFileAtomic,
} from "./score.ts";
import { baselineRoleRunner } from "./score-baseline.ts";
import { type RunRole, roleRunner, SCORE_RUN_BUDGET_MS } from "./score-role.ts";

export interface ScorePackageOptions {
  /** The `package` input: a `.tgz` file. */
  package: string;
  /** The `nimbus-gateway` input: an absolute path to a gateway executable. */
  gateway: string;
  /** Where `scores.json` is written. */
  out: string;
}

export interface ScorePackageDeps {
  io: ActionIo;
  /** Where the work directory goes. */
  tmpdir: () => string;
  runRole: RunRole;
  runBaseline: RunRole;
  /** The clock the run budget is measured with, in milliseconds. */
  now: () => number;
}

const SHARED: ScorePackageDeps = {
  io: GHA_IO,
  tmpdir: osTmpdir,
  runRole: roleRunner(),
  runBaseline: baselineRoleRunner(),
  now: Date.now,
};

const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** The refusal of a `package` input: what is wrong with it, and what to do instead. */
function notATgz(path: string, why: string): Error {
  return new Error(
    `input "package" must be a .tgz file: ${JSON.stringify(path)} ${why}. Pack a directory once with \`nimbus extension pack <dir> --out <file>\` and give that file to this mode and to \`maintain add\`: two runtimes gzip a directory differently, so it would never hash alike on both sides`,
  );
}

/** At most `max` bytes of `path`, read through one descriptor in chunks. */
function readAtMost(path: string, max: number): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < max) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, max - total));
      const got = readSync(fd, chunk, 0, chunk.length, null);
      if (got === 0) break;
      chunks.push(chunk.subarray(0, got));
      total += got;
    }
    return new Uint8Array(Buffer.concat(chunks, total));
  } finally {
    closeSync(fd);
  }
}

/** Why `bytes` cannot be a package (too large, not gzip), or `undefined` when they can. */
export function packageBytesProblem(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength > MAX_PACKAGE_BYTES)
    return `is larger than ${String(MAX_PACKAGE_BYTES)} bytes`;
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return "is not gzip data";
  return undefined;
}

/** The package's bytes, read once: the read itself says why a path is not a file. */
function readPackageBytes(path: string): Uint8Array {
  if (!path.endsWith(".tgz")) throw notATgz(path, "does not end in .tgz");
  let bytes: Uint8Array;
  try {
    bytes = readAtMost(path, MAX_PACKAGE_BYTES + 1);
  } catch (e) {
    const why = (e as NodeJS.ErrnoException).code ?? "an error";
    throw notATgz(path, `cannot be read as a file (${why})`);
  }
  const problem = packageBytesProblem(bytes);
  if (problem !== undefined) throw notATgz(path, problem);
  return bytes;
}

/**
 * Run the `score-package` mode: write `opts.out`. Throws (failing the run) on a refusal: a relative
 * or missing gateway, a path that is not a `.tgz` file, or a package that cannot be inspected.
 */
export async function runScorePackage(
  opts: ScorePackageOptions,
  deps: ScorePackageDeps = SHARED,
): Promise<ScoresFile> {
  const deadline = deps.now() + SCORE_RUN_BUDGET_MS;
  assertGateway(opts.gateway);
  const packageBytes = readPackageBytes(opts.package);
  const work = mkdtempSync(join(deps.tmpdir(), "nimbus-registry-score-package-"));
  const run = emptyRun();
  try {
    const inspectDir = join(work, "inspect");
    mkdirSync(inspectDir);
    const tgz = join(inspectDir, "package.tgz");
    writeFileSync(tgz, packageBytes, { flag: "wx" });
    const inspected = await inspectPackage(tgz, inspectDir);
    const { manifest } = parseExtensionManifestForRegistry(
      inspected.manifestBytes.toString("utf8"),
    );
    const verdict = {
      id: manifest.id,
      version: manifest.version,
      packageSha256: sha256Hex(packageBytes),
      hasEvals: inspected.files.some((f) => isEvalSuiteFile(f)),
      starterPack: isStarterPack(manifest),
    };
    await recordVersion(
      run,
      { verdict, packageBytes },
      { gateway: opts.gateway, work, deadline, mode: "score-package" },
      deps,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  writeFileAtomic(opts.out, `${JSON.stringify(run.scores, null, 2)}\n`);
  reportScores(deps.io, run, "score-package");
  return run.scores;
}
