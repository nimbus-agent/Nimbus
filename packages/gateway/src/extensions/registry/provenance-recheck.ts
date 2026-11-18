/**
 * The install door's offline provenance re-check (owner rulings OR-PROV-1 to OR-PROV-5): fetch the
 * Sigstore bundle the signed index pins for this version, check its hash against the index, and
 * re-verify it with `verifyProvenanceBundle` against the roots baked into this release.
 *
 * Called only by `installFromRegistry`, after the verified fetch and the liveness read, so
 * `fetchVerifiedRegistryPackage` (which the migration engine also uses) makes no provenance request.
 * It runs only when the package already has provenance AND its signed entry names a bundle. It
 * never throws and never refuses: the result is one line of the approval (the I51 rule).
 */
import {
  MAX_PROVENANCE_BUNDLE_BYTES,
  provenanceNote,
  readProvenanceBundleRef,
  type VersionProvenance,
} from "@nimbus-dev/registry-format";
import { sha256HexEqualConstantTime } from "../../util/timing-safe-compare.ts";
import {
  type ProvenanceRecheck,
  recheckReasonText,
  verifyProvenanceBundle,
} from "./provenance-verify.ts";
import { fetchRegistryBytes, type RegistryFetchDeps } from "./registry-fetch.ts";
import { sha256Hex } from "./registry-manifest.ts";
import type { RegistryRow } from "./registry-store.ts";

/** What the re-check needs of a verified package: its identity, provenance and signed entry. */
export interface RecheckSubject {
  readonly id: string;
  readonly version: string;
  readonly reg: Pick<RegistryRow, "name" | "url">;
  readonly provenance: VersionProvenance | null;
  /** The signed version entry the package was fetched by (carries `packageSha256` and the bundle). */
  readonly versionEntry: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The re-check result, and the bundle text when it was fetched and matched the signed index (so the
 * installed copy can keep it), or `undefined` when there is nothing to re-check (no provenance, or a
 * signed entry that names no bundle: the approval then reads exactly as before).
 */
export async function readProvenanceRecheck(
  deps: RegistryFetchDeps,
  subject: RecheckSubject,
): Promise<{ recheck: ProvenanceRecheck; bundle?: string } | undefined> {
  if (subject.provenance === null) return undefined;
  const ref = readProvenanceBundleRef(subject.versionEntry, subject.id, subject.version);
  if (ref === undefined) return undefined;
  const entry = subject.versionEntry;
  const packageSha256 = isObject(entry) ? entry["packageSha256"] : undefined;
  if (typeof packageSha256 !== "string") return undefined;
  let bytes: Uint8Array;
  try {
    bytes = await fetchRegistryBytes(deps, subject.reg, ref.path, {
      method: "registry.provenance",
      extensionId: subject.id,
      version: subject.version,
      maxBytes: MAX_PROVENANCE_BUNDLE_BYTES,
    });
  } catch {
    return { recheck: { status: "unverified", reason: "bundle_unavailable" } };
  }
  if (!sha256HexEqualConstantTime(sha256Hex(bytes), ref.sha256)) {
    return { recheck: { status: "unverified", reason: "bundle_hash_mismatch" } };
  }
  const recheck = verifyProvenanceBundle({
    bundleBytes: bytes,
    packageSha256,
    expected: subject.provenance,
  });
  return { recheck, bundle: new TextDecoder().decode(bytes) };
}

/** The approval's provenance sentence: the registry's note, plus what the offline re-check found. */
export function recheckedProvenanceNote(
  p: VersionProvenance,
  registry: string,
  recheck: ProvenanceRecheck | undefined,
): string {
  const note = provenanceNote(p, registry);
  if (recheck === undefined) return note;
  return recheck.status === "verified"
    ? `${note}; re-verified offline against the Sigstore roots in this Nimbus release`
    : `${note}; not re-verified offline: ${recheckReasonText(recheck.reason)}`;
}
