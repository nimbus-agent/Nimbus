/**
 * Build provenance (marketplace trust layer, spec G8, § 6.12): "this package was built from
 * <owner>/<repo> at <commit> by <workflow>", as checked by a registry's CI against GitHub's
 * attestation service (`gh attestation verify`) when it signed the version, and vouched for by the
 * registry root like every other index field. Optional throughout: a missing or malformed piece is
 * "no provenance", never a refusal.
 *
 * - `readManifestRepository`: the publisher-signed manifest's `repository` (`owner/repo`), or
 *   `undefined` — a malformed value is absent, never a manifest error.
 * - `provenanceFromGhVerify`: the rule that turns `gh attestation verify --format json` output into
 *   a version's `provenance` (shapes checked against gh 2.96.0's real output).
 * - `readVersionProvenance`: a never-throwing reader of a signed version entry's `provenance`.
 * - `readProvenanceBundleRef` / `provenanceBundlePath`: the Sigstore bundle the sign job keeps beside
 *   the package (`extensions/<id>/<version>/provenance.json`), pinned by the signed index's
 *   `provenance.bundleSha256`, so a client can re-verify the attestation offline. Optional: an entry
 *   without it is provenance with no bundle.
 */

/** `owner/repo` as GitHub allows them. */
export const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const WORKFLOW_RE = /^[A-Za-z0-9._/@+-]{1,200}$/;
const SLSA_V1 = "https://slsa.dev/provenance/v1";
const HEX64_RE = /^[0-9a-f]{64}$/;

/** The largest bundle kept or fetched (the measured SLSA bundle is about 14 KB). */
export const MAX_PROVENANCE_BUNDLE_BYTES = 64 * 1024;

/** The Sigstore bundle media types a bundle may declare (v0.2 and v0.3, as `gh` emits them). */
const BUNDLE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/vnd.dev.sigstore.bundle+json;version=0.2",
  "application/vnd.dev.sigstore.bundle.v0.3+json",
]);

export type ProvenanceRunner = "github-hosted" | "self-hosted";

export interface VersionProvenance {
  /** `owner/repo`, as the attestation's certificate names it. */
  readonly sourceRepository: string;
  /** The commit the package was built from (40 or 64 hex). */
  readonly commit: string;
  /** The top-level workflow: its path in the repository and `@<ref>`. */
  readonly workflow: string;
  readonly runner: ProvenanceRunner;
  /** When the registry verified it (the sign run's commit time). */
  readonly verifiedAt: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** The manifest's `repository` when it is a well-formed `owner/repo`; anything else is absent. */
export function readManifestRepository(rawManifest: unknown): string | undefined {
  if (!isObject(rawManifest)) return undefined;
  const v = rawManifest["repository"];
  return typeof v === "string" && REPOSITORY_RE.test(v) ? v : undefined;
}

const sameRepository = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A version entry's `provenance` when it has exactly the expected shape; otherwise `undefined`. */
export function readVersionProvenance(entry: unknown): VersionProvenance | undefined {
  if (!isObject(entry)) return undefined;
  const p = entry["provenance"];
  if (!isObject(p)) return undefined;
  const { sourceRepository, commit, workflow, runner, verifiedAt } = p;
  if (typeof sourceRepository !== "string" || !REPOSITORY_RE.test(sourceRepository)) {
    return undefined;
  }
  if (typeof commit !== "string" || !COMMIT_RE.test(commit)) return undefined;
  if (typeof workflow !== "string" || !WORKFLOW_RE.test(workflow)) return undefined;
  if (runner !== "github-hosted" && runner !== "self-hosted") return undefined;
  if (typeof verifiedAt !== "string" || Number.isNaN(Date.parse(verifiedAt))) return undefined;
  return { sourceRepository, commit, workflow, runner, verifiedAt };
}

/** Where the sign job keeps a version's provenance bundle: beside its `package.tgz`. */
export function provenanceBundlePath(id: string, version: string): string {
  return `extensions/${id}/${version}/provenance.json`;
}

/** The bundle a version entry's provenance pins, or `undefined` for none or anything off-shape. */
export interface ProvenanceBundleRef {
  readonly path: string;
  readonly sha256: string;
}

/**
 * `{ path, sha256 }` when the entry has well-formed provenance AND its `provenance` object names the
 * canonical bundle path for `id`@`version` with a lowercase 64-hex `bundleSha256`; else `undefined`.
 */
export function readProvenanceBundleRef(
  entry: unknown,
  id: string,
  version: string,
): ProvenanceBundleRef | undefined {
  if (readVersionProvenance(entry) === undefined || !isObject(entry)) return undefined;
  const p = entry["provenance"];
  if (!isObject(p)) return undefined;
  const { bundle, bundleSha256 } = p;
  if (bundle !== provenanceBundlePath(id, version)) return undefined;
  if (typeof bundleSha256 !== "string" || !HEX64_RE.test(bundleSha256)) return undefined;
  return { path: bundle, sha256: bundleSha256 };
}

/** The provenance to show for `entry`, only when it names the repository the manifest declares. */
export function provenanceMatching(
  entry: unknown,
  manifestRepository: string | undefined,
): VersionProvenance | undefined {
  const p = readVersionProvenance(entry);
  if (p === undefined || manifestRepository === undefined) return undefined;
  return sameRepository(p.sourceRepository, manifestRepository) ? p : undefined;
}

/**
 * `https://github.com/<owner>/<repo>[/<rest>]` split into its repository and the rest of the path
 * (original case kept), or `undefined` for anything else.
 */
function githubPath(uri: unknown): { repository: string; rest: string } | undefined {
  if (typeof uri !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.search !== "") {
    return undefined;
  }
  const segments = url.pathname.split("/").slice(1);
  const [owner, repo, ...rest] = segments;
  if (owner === undefined || repo === undefined) return undefined;
  const repository = `${owner}/${repo}`;
  if (!REPOSITORY_RE.test(repository)) return undefined;
  return { repository, rest: rest.join("/") };
}

type Refusal = { ok: false; reason: string };

/** Provenance, and the qualifying entry's Sigstore bundle as canonical JSON when it has a usable one. */
export type GhVerifyProvenance = { ok: true; provenance: VersionProvenance; bundle?: string };

/**
 * The entry's `attestation.bundle` as canonical JSON when it is an object with a known Sigstore media
 * type and fits `MAX_PROVENANCE_BUNDLE_BYTES` (UTF-8); otherwise `undefined`. Shape only: the bundle
 * is verified by the client that reads it, never trusted here.
 */
function bundleOf(entry: Record<string, unknown>): string | undefined {
  const attestation = entry["attestation"];
  const bundle = isObject(attestation) ? attestation["bundle"] : undefined;
  if (!isObject(bundle)) return undefined;
  const mediaType = bundle["mediaType"];
  if (typeof mediaType !== "string" || !BUNDLE_MEDIA_TYPES.has(mediaType)) return undefined;
  const text = JSON.stringify(bundle);
  return new TextEncoder().encode(text).length <= MAX_PROVENANCE_BUNDLE_BYTES ? text : undefined;
}

/** One attestation entry, as provenance for `repository`, or why it is not. */
function fromEntry(
  entry: unknown,
  repository: string,
  verifiedAt: string,
): GhVerifyProvenance | Refusal {
  if (!isObject(entry)) return { ok: false, reason: "an attestation entry is not an object" };
  const result = entry["verificationResult"];
  const statement = isObject(result) ? result["statement"] : undefined;
  if (!isObject(statement) || statement["predicateType"] !== SLSA_V1) {
    return { ok: false, reason: "not a SLSA v1 build provenance attestation" };
  }
  const signature = isObject(result) ? result["signature"] : undefined;
  const cert = isObject(signature) ? signature["certificate"] : undefined;
  if (!isObject(cert)) return { ok: false, reason: "the attestation carries no certificate" };
  const source = githubPath(cert["sourceRepositoryURI"]);
  if (source?.rest !== "" || !sameRepository(source.repository, repository)) {
    return { ok: false, reason: `the attestation was not built from ${repository}` };
  }
  const commit = cert["sourceRepositoryDigest"];
  if (typeof commit !== "string" || !COMMIT_RE.test(commit)) {
    return { ok: false, reason: "the attestation names no source commit" };
  }
  // The TOP-LEVEL workflow: with a reusable workflow, buildSignerURI is the reusable one (often in
  // another repository) while buildConfigURI stays the caller's, in this repository.
  const config = githubPath(cert["buildConfigURI"]);
  if (config === undefined || !sameRepository(config.repository, repository)) {
    return { ok: false, reason: `the attestation's workflow is not in ${repository}` };
  }
  const workflow = config.rest;
  if (!WORKFLOW_RE.test(workflow)) {
    return { ok: false, reason: "the attestation's workflow path is not recognisable" };
  }
  const runner = cert["runnerEnvironment"] === "github-hosted" ? "github-hosted" : "self-hosted";
  const bundle = bundleOf(entry);
  return {
    ok: true,
    provenance: {
      sourceRepository: source.repository,
      commit,
      workflow,
      runner,
      verifiedAt,
    },
    ...(bundle !== undefined && { bundle }),
  };
}

/**
 * Provenance for `repository` from `gh attestation verify --format json` output (already parsed).
 * `gh` matched the file's digest; this decides whether any verified attestation is a SLSA v1 build
 * provenance from THIS repository — every entry is considered (a file may also carry, say, an SBOM
 * attestation), and the first that qualifies is used.
 */
export function provenanceFromGhVerify(
  output: unknown,
  repository: string,
  verifiedAt: string,
): GhVerifyProvenance | Refusal {
  if (!REPOSITORY_RE.test(repository)) return { ok: false, reason: "malformed repository" };
  if (!Array.isArray(output) || output.length === 0) {
    return { ok: false, reason: "gh returned no attestations" };
  }
  let last: Refusal = { ok: false, reason: "no attestation qualified" };
  for (const entry of output) {
    const r = fromEntry(entry, repository, verifiedAt);
    if (r.ok) return r;
    last = r;
  }
  return last;
}

/** The one sentence a client shows for a version's provenance, naming the registry that vouched. */
export function provenanceNote(p: VersionProvenance, registry: string): string {
  const runner = p.runner === "self-hosted" ? " on a self-hosted runner" : "";
  return `Provenance verified by ${registry}: built from ${p.sourceRepository} at ${p.commit.slice(0, 12)} by ${p.workflow}${runner}`;
}
