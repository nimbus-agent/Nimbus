import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix } from "node:path";
import {
  codeUnitCompare,
  deriveExtensionServiceId,
  type EvalSuite,
  extensionEntryRelPath,
  isStarterPack,
  listPackageFiles,
  loadEvalSuites,
  PACKAGE_MANIFEST_FILE,
  parseExtensionManifestForRegistry,
  RegistryError,
} from "@nimbus-dev/registry-format";

import { EXTENSION_STAGE_DIR_NAME } from "../../platform/sandbox/sandbox-cwd.ts";
import { isSameOrInside } from "../../util/path-overlap.ts";
import { removeBestEffort } from "../extension-stage.ts";
import { resolveExtensionManifestPath } from "../manifest.ts";
import {
  decodeBase64,
  type SignedManifestShape,
  verifyManifestSignature,
} from "../verify-signature.ts";
import type { EvalStagedPackage } from "./eval-spawn-spec.ts";

export type EvalErrorCode =
  | "ERR_EVAL_PACKAGE_INVALID"
  | "ERR_EVAL_SIGNATURE_INVALID"
  | "ERR_EVAL_NO_SUITES"
  | "ERR_EVAL_SUITE_INVALID"
  | "ERR_EVAL_SANDBOX_UNAVAILABLE"
  | "ERR_EVAL_START_FAILED"
  | "ERR_EVAL_RUN_TIMEOUT"
  | "ERR_EVAL_INTERNAL";

// biome-ignore lint/suspicious/noShadowRestrictedNames: the name is the eval error contract (spec 4.6); it shadows only the legacy global.
export class EvalError extends Error {
  constructor(
    readonly code: EvalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EvalError";
  }
}

/** A package verified and read for evaluation; the code under test is NOT yet staged. */
export interface EvalPackageSource {
  readonly dir: string;
  readonly extensionId: string;
  readonly version: string;
  readonly serviceId: string;
  readonly entryRel: string;
  readonly files: readonly string[];
  readonly filesDigest: string;
  readonly suites: readonly EvalSuite[];
}

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** SHA-256 hex of a regular file, classified and read through the one descriptor that opened it. */
function sha256OfFile(path: string): string {
  const fd = openSync(path, OPEN_FLAGS);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`not a regular file: ${path}`);
    return createHash("sha256").update(readFileSync(fd)).digest("hex");
  } finally {
    closeSync(fd);
  }
}

/** SHA-256 over sorted `<rel>\0<sha256(file)>\n` lines of exactly `files` (relative to `root`). */
export function evalFilesDigest(root: string, files: readonly string[]): string {
  const lines = files.map((rel) => `${rel}\0${sha256OfFile(join(root, ...rel.split("/")))}\n`);
  lines.sort(codeUnitCompare);
  const hash = createHash("sha256");
  for (const line of lines) hash.update(line);
  return hash.digest("hex");
}

function invalid(message: string): EvalError {
  return new EvalError("ERR_EVAL_PACKAGE_INVALID", message);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function readManifest(dir: string): { text: string; raw: SignedManifestShape } {
  const path = resolveExtensionManifestPath(dir);
  if (path === undefined || posix.basename(path.replaceAll("\\", "/")) !== PACKAGE_MANIFEST_FILE) {
    throw invalid(`${PACKAGE_MANIFEST_FILE} not found in ${dir}`);
  }
  const text = readFileSync(path, "utf8");
  return { text, raw: JSON.parse(text) as SignedManifestShape };
}

async function verifySigned(raw: SignedManifestShape): Promise<void> {
  if (raw.publisher === undefined) return; // an unsigned dev package is evaluable
  try {
    await verifyManifestSignature(raw, decodeBase64(raw.publisher.key));
  } catch (e) {
    throw new EvalError("ERR_EVAL_SIGNATURE_INVALID", `manifest signature: ${messageOf(e)}`);
  }
}

function selectSuites(dir: string, suiteFile: string | undefined): EvalSuite[] {
  let suites: EvalSuite[];
  try {
    suites = loadEvalSuites(dir);
  } catch (e) {
    if (e instanceof RegistryError) throw new EvalError("ERR_EVAL_SUITE_INVALID", e.message);
    throw e;
  }
  const kept = suiteFile === undefined ? suites : suites.filter((s) => s.file === suiteFile);
  if (kept.length === 0) {
    throw new EvalError(
      "ERR_EVAL_NO_SUITES",
      suiteFile === undefined ? "the package has no evals/*.eval.json" : `no suite ${suiteFile}`,
    );
  }
  return kept;
}

/** Load a package directory, verify it, and read its suites. Stages nothing. */
export async function loadEvalPackage(
  dir: string,
  opts: { suiteFile?: string } = {},
): Promise<EvalPackageSource> {
  if (!isAbsolute(dir)) throw invalid("the package directory must be an absolute path");
  try {
    const { text, raw } = readManifest(dir);
    const { manifest } = parseExtensionManifestForRegistry(text);
    if (isStarterPack(manifest)) throw invalid("a starter pack has no code to evaluate");
    await verifySigned(raw);
    const files = listPackageFiles(dir);
    const entryRel = posix.normalize(extensionEntryRelPath(manifest));
    if (!files.includes(entryRel)) {
      throw invalid(`the entry "${entryRel}" is not among the package files`);
    }
    const suites = selectSuites(dir, opts.suiteFile);
    return {
      dir,
      extensionId: manifest.id,
      version: manifest.version,
      serviceId: deriveExtensionServiceId(manifest.id),
      entryRel,
      files,
      filesDigest: evalFilesDigest(dir, files),
      suites,
    };
  } catch (e) {
    if (e instanceof EvalError) throw e;
    throw invalid(messageOf(e));
  }
}

/**
 * Copy ONLY the verified package files into a run-unique stage and re-digest the copy. The stage
 * is the eval child's working directory; its ancestors are gateway-owned and granted to no spawn.
 */
export function stageEvalPackage(src: EvalPackageSource, sandboxDir: string): EvalStagedPackage {
  const stagePath = join(sandboxDir, EXTENSION_STAGE_DIR_NAME, `eval-${randomUUID()}`);
  try {
    for (const rel of src.files) {
      const to = join(stagePath, ...rel.split("/"));
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(join(src.dir, ...rel.split("/")), to);
    }
    mkdirSync(stagePath, { recursive: true });
    if (evalFilesDigest(stagePath, src.files) !== src.filesDigest) {
      throw invalid("the staged copy differs from the verified package");
    }
    const entryPath = join(stagePath, ...src.entryRel.split("/"));
    if (
      !isSameOrInside(process.platform, entryPath, stagePath) ||
      isSameOrInside(process.platform, stagePath, entryPath)
    ) {
      throw invalid(`the entry "${entryPath}" lies outside its stage`);
    }
    return { serviceId: src.serviceId, version: src.version, stagePath, entryPath };
  } catch (e) {
    removeBestEffort(stagePath);
    if (e instanceof EvalError) throw e;
    throw invalid(`the staged copy could not be made: ${messageOf(e)}`);
  }
}

/** Remove a run-unique eval stage (best effort). */
export function discardEvalStage(stage: EvalStagedPackage): void {
  removeBestEffort(stage.stagePath);
}
