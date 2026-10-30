/**
 * The unsigned candidates on the default branch, enumerated and validated ONE way for every mode
 * that judges them: `sign` signs what passes here, and `score` scores exactly the versions `sign`
 * would then consider, against the same bindings (design § 11.7–11.8; eval spec § 4.6, R8).
 */
import { createHash } from "node:crypto";
import {
  admitPublisherStatements,
  codeUnitCompare,
  type EvalQuality,
  type PublishCandidate,
  type PublishVerdict,
  publisherAfterPublish,
  type RegistryConfig,
  RegistryError,
  type RegistryExtensionEntry,
  type RegistryIndex,
  type StatementAdmission,
  type VersionProvenance,
  type validatePublish,
} from "../../../registry-format/src/index.ts";
import type * as gitTree from "./git-tree.ts";
import {
  CANDIDATE_FILES,
  readCandidate,
  readStatementFiles,
  splitExtensionDir,
  statementPath,
} from "./registry-state.ts";

/** A directory or file a run did not take, and why. */
export interface Skipped {
  dir: string;
  reason: string;
}

/** Every `extensions/<id>/<version>` on `ref` with the file names directly inside it. */
export function extensionDirs(
  git: typeof gitTree,
  ref: string,
  cwd: string,
): { dirs: Map<string, Set<string>>; paths: Set<string> } {
  const dirs = new Map<string, Set<string>>();
  const paths = new Set<string>();
  for (const e of git.listTreeEntries(ref, "extensions/", { cwd })) {
    paths.add(e.path);
    const slash = e.path.lastIndexOf("/");
    const dir = e.path.slice(0, slash);
    if (dir === "extensions") continue; // e.g. `extensions/.gitkeep`
    const names = dirs.get(dir) ?? new Set<string>();
    names.add(e.path.slice(slash + 1));
    dirs.set(dir, names);
  }
  return { dirs, paths };
}

const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/**
 * § 11.7: every signed version is still on `ref`, byte for byte. Returns the signed dirs. The
 * refusal names the mode that refuses (`verb`: "sign" or "score").
 */
export function assertSignedIntact(
  git: typeof gitTree,
  index: RegistryIndex,
  ref: string,
  paths: ReadonlySet<string>,
  cwd: string,
  verb: "sign" | "score",
): Set<string> {
  const problems: string[] = [];
  const signedDirs = new Set<string>();
  for (const [id, ext] of Object.entries(index.extensions)) {
    for (const [version, v] of Object.entries(ext.versions)) {
      signedDirs.add(`extensions/${id}/${version}`);
      for (const [path, want] of [
        [v.manifest, v.manifestSha256],
        [v.package, v.packageSha256],
      ] as const) {
        if (!paths.has(path)) {
          problems.push(`${path} is signed but was deleted`);
        } else if (sha256Hex(git.readBlob(ref, path, { cwd })) !== want) {
          problems.push(`${path} differs from the signed version`);
        }
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `refusing to ${verb}: already-signed versions changed on the default branch (a signed version is immutable): ${problems.join("; ")}`,
    );
  }
  return signedDirs;
}

function sameFileSet(names: ReadonlySet<string>): boolean {
  return names.size === CANDIDATE_FILES.length && CANDIDATE_FILES.every((f) => names.has(f));
}

/** The `statements/` files on `ref` admitted into `index`; refused files land in `skipped`. */
export function admitStatements(
  git: typeof gitTree,
  index: RegistryIndex,
  ref: string,
  cwd: string,
  skipped: Skipped[],
): StatementAdmission<RegistryIndex> {
  const files = readStatementFiles(git, ref, cwd);
  for (const f of files.skipped) skipped.push({ dir: f.path, reason: f.reason });
  const admission = admitPublisherStatements(index, files.values);
  for (const s of admission.skipped) skipped.push({ dir: statementPath(s.id), reason: s.reason });
  return admission;
}

/** One unsigned candidate directory: validated, or skipped with the reason. */
export type CandidateOutcome =
  | { kind: "valid"; dir: string; candidate: PublishCandidate; verdict: PublishVerdict }
  | ({ kind: "skipped" } & Skipped);

export interface UnsignedInput {
  git: typeof gitTree;
  validate: typeof validatePublish;
  /** The default branch's ref (`origin/<branch>`). */
  ref: string;
  cwd: string;
  dirs: ReadonlyMap<string, ReadonlySet<string>>;
  signedDirs: ReadonlySet<string>;
  config: RegistryConfig;
  /** The validator's scratch parent. */
  work: string;
  /**
   * The index each candidate is validated against, asked afresh per candidate: the signed
   * bindings plus whatever the caller added since, so two new dirs cannot disagree.
   */
  bindings: () => RegistryIndex;
}

/**
 * Every unsigned `extensions/<id>/<version>` on `ref`, in code-unit order, validated with
 * `validatePublish`. A dir that is not exactly the three candidate files, or that the validator
 * refuses, is yielded as skipped; any other error propagates.
 */
export async function* validateUnsigned(
  input: UnsignedInput,
): AsyncGenerator<CandidateOutcome, void, undefined> {
  const { git, ref, cwd } = input;
  const unsigned = [...input.dirs.keys()].filter((d) => !input.signedDirs.has(d));
  for (const dir of unsigned.sort(codeUnitCompare)) {
    const coords = splitExtensionDir(dir);
    const names = input.dirs.get(dir) ?? new Set<string>();
    if (coords === undefined || !sameFileSet(names)) {
      yield {
        kind: "skipped",
        dir,
        reason: `must hold exactly ${CANDIDATE_FILES.join(", ")}; holds ${[...names].sort(codeUnitCompare).join(", ")}`,
      };
      continue;
    }
    const candidate = readCandidate(git, ref, coords, cwd);
    let verdict: PublishVerdict;
    try {
      // NOSONAR S9382: sequential by design - each version is validated against the bindings this run already added, so two new dirs cannot disagree
      verdict = await input.validate(candidate, input.bindings(), input.config, input.work);
    } catch (e) {
      if (!(e instanceof RegistryError)) throw e;
      yield { kind: "skipped", dir, reason: e.message };
      continue;
    }
    yield { kind: "valid", dir, candidate, verdict };
  }
}

/**
 * `extensions` with `v` added as a version entry (the entry `sign` writes, so later candidates are
 * validated against it). Fixed fields only; `provenance` and `quality` (a registry-measured eval
 * score, already validated) are added explicitly when there is one.
 */
export function addVersion(
  extensions: Record<string, RegistryExtensionEntry>,
  v: PublishVerdict,
  publishedAt: string,
  provenance?: VersionProvenance,
  quality?: EvalQuality,
): void {
  const base = `extensions/${v.id}/${v.version}`;
  const existing = extensions[v.id];
  extensions[v.id] = {
    publisher: publisherAfterPublish(existing, v.publisher),
    versions: {
      ...existing?.versions,
      [v.version]: {
        channel: v.channel,
        name: v.name,
        manifest: `${base}/manifest.json`,
        manifestSha256: v.manifestSha256,
        package: `${base}/package.tgz`,
        packageSha256: v.packageSha256,
        packageSizeBytes: v.packageSizeBytes,
        entryHash: v.entryHash,
        publishedAt,
        ...(provenance !== undefined && { provenance }),
        ...(quality !== undefined && { quality }),
      },
    },
  };
}
