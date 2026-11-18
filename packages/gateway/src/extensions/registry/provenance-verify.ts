/**
 * Offline re-verification of a registry version's build provenance (S4 carried-in row; owner
 * rulings OR-PROV-1 to OR-PROV-5). The registry's sign job verified the attestation with `gh` and
 * published its Sigstore bundle beside the package, pinned by the signed index. Here the client
 * checks that bundle itself, with no network, against the Sigstore trusted roots baked into this
 * release (public-good and GitHub's instance), and reads the identity from the Fulcio certificate.
 *
 * The result is EVIDENCE for the owner, never a decision (OR-PROV-2, the I51 rule): it changes one
 * line of the install approval and nothing else. It never throws: every failure is a fixed reason.
 *
 * Steps, in order: size and parse; signature, certificate chain, transparency log or timestamp
 * against each baked root (certificate validity is judged at the signed time, never "now"); the
 * DSSE statement is SLSA v1 build provenance whose subject names the package's sha256; the leaf
 * certificate's Fulcio extensions name the GitHub Actions issuer and the repository, commit,
 * workflow and runner the signed index records (the same rule the sign job applied to `gh`'s
 * output, `provenanceFromGhVerify`).
 *
 * `@sigstore/*` is imported nowhere else in the gateway (a source pin holds it).
 */

import {
  MAX_PROVENANCE_BUNDLE_BYTES,
  provenanceFromGhVerify,
  type VersionProvenance,
} from "@nimbus-dev/registry-format";
import { bundleFromJSON } from "@sigstore/bundle";
import { ASN1Obj, X509Certificate } from "@sigstore/core";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier, type VerifierOptions } from "@sigstore/verify";
import { BAKED_SIGSTORE_TRUSTED_ROOTS } from "./sigstore-trusted-roots.ts";

/** Why a bundle was not re-verified. Fixed codes: the owner sees a fixed sentence for each. */
export type ProvenanceRecheckReason =
  | "bundle_unavailable"
  | "bundle_too_large"
  | "bundle_hash_mismatch"
  | "bundle_malformed"
  | "signature_unverified"
  | "not_build_provenance"
  | "subject_mismatch"
  | "identity_mismatch";

export type SigstoreInstance = "public-good" | "github";

export type ProvenanceRecheck =
  | { readonly status: "verified"; readonly instance: SigstoreInstance }
  | { readonly status: "unverified"; readonly reason: ProvenanceRecheckReason };

/** One baked root and the evidence its bundles must carry. */
interface RootPolicy {
  readonly instance: SigstoreInstance;
  readonly root: TrustedRoot;
  readonly options: VerifierOptions;
}

const SLSA_V1 = "https://slsa.dev/provenance/v1";
const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

/** Fulcio certificate extensions (v2, DER UTF8String values). */
const OID = {
  issuer: "1.3.6.1.4.1.57264.1.8",
  runnerEnvironment: "1.3.6.1.4.1.57264.1.11",
  sourceRepositoryURI: "1.3.6.1.4.1.57264.1.12",
  sourceRepositoryDigest: "1.3.6.1.4.1.57264.1.13",
  buildConfigURI: "1.3.6.1.4.1.57264.1.18",
} as const;

/** ASN.1 universal tag number of a UTF8String. */
const UTF8_STRING_TAG = 12;

/**
 * Public-good: an embedded SCT, a Rekor entry and a signed time. GitHub's instance has no
 * transparency or CT log; it signs times with its timestamp authority.
 */
const POLICY_BY_INSTANCE: Readonly<Record<SigstoreInstance, VerifierOptions>> = {
  "public-good": { ctlogThreshold: 1, tlogThreshold: 1, timestampThreshold: 1 },
  github: { ctlogThreshold: 0, tlogThreshold: 0, timestampThreshold: 1 },
};

function instanceOf(root: TrustedRoot): SigstoreInstance | undefined {
  const uris = new Set(root.certificateAuthorities.map((c) => c.uri));
  if (uris.size !== 1) return undefined;
  if (uris.has("https://fulcio.sigstore.dev")) return "public-good";
  if (uris.has("fulcio.githubapp.com")) return "github";
  return undefined;
}

/** The baked roots as verification policies (an unrecognised root is dropped, never trusted). */
export function parseTrustedRoots(jsonl: string): RootPolicy[] {
  const out: RootPolicy[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    const root = TrustedRoot.fromJSON(JSON.parse(line));
    const instance = instanceOf(root);
    if (instance !== undefined) out.push({ instance, root, options: POLICY_BY_INSTANCE[instance] });
  }
  return out;
}

let bakedPolicies: RootPolicy[] | undefined;

/** The roots baked into this release, parsed once. */
export function bakedRootPolicies(): RootPolicy[] {
  bakedPolicies ??= parseTrustedRoots(BAKED_SIGSTORE_TRUSTED_ROOTS);
  return bakedPolicies;
}

const unverified = (reason: ProvenanceRecheckReason): ProvenanceRecheck => ({
  status: "unverified",
  reason,
});

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A Fulcio extension's string value, or `undefined` when absent or not a DER UTF8String. */
function fulcioString(cert: X509Certificate, oid: string): string | undefined {
  const ext = cert.extension(oid);
  if (ext === undefined) return undefined;
  try {
    const obj = ASN1Obj.parseBuffer(Buffer.from(ext.value));
    if (!obj.tag.isUniversal() || obj.tag.number !== UTF8_STRING_TAG || obj.tag.constructed) {
      return undefined;
    }
    return obj.value.toString("utf8");
  } catch {
    return undefined;
  }
}

/** The leaf certificate a v0.2/v0.3 bundle carries. */
function leafCertificate(bundle: ReturnType<typeof bundleFromJSON>): X509Certificate | undefined {
  const content = bundle.verificationMaterial?.content;
  if (content === undefined) return undefined;
  const raw =
    content.$case === "certificate"
      ? content.certificate.rawBytes
      : content.$case === "x509CertificateChain"
        ? content.x509CertificateChain.certificates[0]?.rawBytes
        : undefined;
  return raw === undefined ? undefined : X509Certificate.parse(Buffer.from(raw));
}

/** The DSSE statement, when it is an in-toto SLSA v1 statement naming `sha256`. */
function statementCheck(
  bundle: ReturnType<typeof bundleFromJSON>,
  sha256: string,
): ProvenanceRecheckReason | undefined {
  if (bundle.content.$case !== "dsseEnvelope") return "not_build_provenance";
  const env = bundle.content.dsseEnvelope;
  if (env.payloadType !== IN_TOTO_PAYLOAD_TYPE) return "not_build_provenance";
  let statement: unknown;
  try {
    statement = JSON.parse(Buffer.from(env.payload).toString("utf8"));
  } catch {
    return "not_build_provenance";
  }
  if (!isObject(statement) || statement["predicateType"] !== SLSA_V1) {
    return "not_build_provenance";
  }
  const subjects = statement["subject"];
  const named =
    Array.isArray(subjects) &&
    subjects.some(
      (s: unknown) =>
        isObject(s) &&
        isObject(s["digest"]) &&
        typeof s["digest"]["sha256"] === "string" &&
        s["digest"]["sha256"].toLowerCase() === sha256.toLowerCase(),
    );
  return named ? undefined : "subject_mismatch";
}

/** Whether the leaf names the same build the signed index records (`expected`). */
function identityMatches(cert: X509Certificate, expected: VersionProvenance): boolean {
  if (fulcioString(cert, OID.issuer) !== GITHUB_ACTIONS_ISSUER) return false;
  // The certificate's fields, in the shape `gh` reports them, through the sign job's own rule.
  const fromCert = provenanceFromGhVerify(
    [
      {
        verificationResult: {
          statement: { predicateType: SLSA_V1 },
          signature: {
            certificate: {
              sourceRepositoryURI: fulcioString(cert, OID.sourceRepositoryURI),
              sourceRepositoryDigest: fulcioString(cert, OID.sourceRepositoryDigest),
              buildConfigURI: fulcioString(cert, OID.buildConfigURI),
              runnerEnvironment: fulcioString(cert, OID.runnerEnvironment),
            },
          },
        },
      },
    ],
    expected.sourceRepository,
    expected.verifiedAt,
  );
  if (!fromCert.ok) return false;
  const p = fromCert.provenance;
  return (
    p.sourceRepository.toLowerCase() === expected.sourceRepository.toLowerCase() &&
    p.commit === expected.commit &&
    p.workflow === expected.workflow &&
    p.runner === expected.runner
  );
}

/** The first baked root the bundle verifies against, or `undefined`. */
function verifiedInstance(
  bundle: ReturnType<typeof bundleFromJSON>,
  policies: readonly RootPolicy[],
): SigstoreInstance | undefined {
  for (const p of policies) {
    try {
      new Verifier(toTrustMaterial(p.root), p.options).verify(toSignedEntity(bundle));
      return p.instance;
    } catch {
      // Not signed under this root (or not verifiable): try the next one.
    }
  }
  return undefined;
}

/**
 * Re-verifies `bundleBytes` (already hash-checked against the signed index by the caller) as the
 * build provenance of the package whose sha256 is `packageSha256`, recorded as `expected`.
 */
export function verifyProvenanceBundle(input: {
  readonly bundleBytes: Uint8Array;
  readonly packageSha256: string;
  readonly expected: VersionProvenance;
  readonly policies?: readonly RootPolicy[];
}): ProvenanceRecheck {
  try {
    if (input.bundleBytes.byteLength > MAX_PROVENANCE_BUNDLE_BYTES) {
      return unverified("bundle_too_large");
    }
    let bundle: ReturnType<typeof bundleFromJSON>;
    try {
      bundle = bundleFromJSON(JSON.parse(new TextDecoder().decode(input.bundleBytes)));
    } catch {
      return unverified("bundle_malformed");
    }
    const instance = verifiedInstance(bundle, input.policies ?? bakedRootPolicies());
    if (instance === undefined) return unverified("signature_unverified");
    const statement = statementCheck(bundle, input.packageSha256);
    if (statement !== undefined) return unverified(statement);
    const leaf = leafCertificate(bundle);
    if (leaf === undefined || !identityMatches(leaf, input.expected)) {
      return unverified("identity_mismatch");
    }
    return { status: "verified", instance };
  } catch {
    return unverified("bundle_malformed");
  }
}

/** The fixed sentence for an unverified re-check. */
export function recheckReasonText(reason: ProvenanceRecheckReason): string {
  switch (reason) {
    case "bundle_unavailable":
      return "the attestation could not be fetched";
    case "bundle_too_large":
      return "the attestation is too large";
    case "bundle_hash_mismatch":
      return "the attestation does not match the signed index";
    case "bundle_malformed":
      return "the attestation is malformed";
    case "signature_unverified":
      return "its signature does not verify against the Sigstore roots in this Nimbus release";
    case "not_build_provenance":
      return "it is not a build provenance attestation";
    case "subject_mismatch":
      return "it does not name this package";
    case "identity_mismatch":
      return "its certificate names a different build";
  }
}
