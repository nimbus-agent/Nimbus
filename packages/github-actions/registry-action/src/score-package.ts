/**
 * `mode: score-package` — scores ONE package for a registry that publishes through
 * `nimbus registry maintain add` instead of pull requests (spec ruling 8). The `package` input is a
 * directory or a `.tgz`; a directory is packed with `packExtensionDir`, the same deterministic
 * packer `maintain add` uses, so `packageSha256` here is the hash `maintain add` computes and its
 * `--scores` binding accepts. The bytes are read once into a private work directory and everything
 * after that works on those bytes.
 *
 * It runs extension code, so like `score` it holds no secret (`main.ts` refuses `root-key` and
 * `github-token`). It does not run `validatePublish`: `maintain add` validates against the real
 * index afterwards, and the hash binds the two. A package that cannot be inspected, or a missing
 * path, fails the job: there is nothing to publish. What is recorded is `scoreVersion`'s: the
 * baseline for every package that is not a starter pack, and the quality when it holds suites.
 * `scores.json` is `{}` when nothing was recorded, written through a temp sibling and a rename.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectPackage,
  isEvalSuiteFile,
  isStarterPack,
  packExtensionDir,
  parseExtensionManifestForRegistry,
} from "../../../registry-format/src/index.ts";
import { type ActionIo, GHA_IO } from "./report.ts";
import {
  assertGateway,
  reportScores,
  type ScoresFile,
  scoreVersion,
  writeFileAtomic,
} from "./score.ts";
import { baselineRoleRunner } from "./score-baseline.ts";
import { type RunRole, roleRunner, SCORE_RUN_BUDGET_MS } from "./score-role.ts";

export interface ScorePackageOptions {
  /** The `package` input: a package directory or a `.tgz`. */
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

/** The package's bytes: a `.tgz` as given, a directory packed deterministically. */
async function readPackageBytes(path: string, work: string): Promise<Uint8Array> {
  let isDir: boolean;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    throw new Error(`input "package" names a path that does not exist: ${JSON.stringify(path)}`);
  }
  if (!isDir) return new Uint8Array(readFileSync(path));
  const packed = join(work, "packed.tgz");
  await packExtensionDir(path, packed);
  return new Uint8Array(readFileSync(packed));
}

/**
 * Run the `score-package` mode: write `opts.out`. Throws (failing the run) on a refusal: a relative
 * or missing gateway, a missing path, or a package that cannot be inspected.
 */
export async function runScorePackage(
  opts: ScorePackageOptions,
  deps: ScorePackageDeps = SHARED,
): Promise<ScoresFile> {
  const deadline = deps.now() + SCORE_RUN_BUDGET_MS;
  assertGateway(opts.gateway);
  const work = mkdtempSync(join(deps.tmpdir(), "nimbus-registry-score-package-"));
  // Keys are `<id>@<version>` from the package's own manifest: a null prototype keeps them inert.
  const scores = Object.create(null) as ScoresFile;
  try {
    const packageBytes = await readPackageBytes(opts.package, work);
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
    const entry = await scoreVersion(
      { verdict, packageBytes },
      { gateway: opts.gateway, work, deadline },
      deps,
    );
    if (entry !== undefined) scores[`${verdict.id}@${verdict.version}`] = entry;
    if (verdict.starterPack) {
      deps.io.log(
        `${verdict.id}@${verdict.version} is a starter pack: it never runs, so nothing is scored`,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  writeFileAtomic(opts.out, `${JSON.stringify(scores, null, 2)}\n`);
  reportScores(deps.io, { scores, skipped: [] });
  return scores;
}
