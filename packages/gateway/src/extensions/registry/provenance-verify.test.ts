/**
 * Offline provenance re-verification over REAL Sigstore bundles: the two attestations GitHub holds
 * for `cli/cli` v2.105.0's `gh_2.105.0_linux_amd64.tar.gz` (downloaded 2026-11-18 with
 * `gh attestation download`; public data), checked against the roots baked into this release.
 *
 * - `cli-cli-2.105.0-slsa.json`: SLSA v1 build provenance, public-good Fulcio and Rekor.
 * - `cli-cli-2.105.0-release.json`: a release attestation, GitHub's own Fulcio and timestamp
 *   authority (it proves the GitHub-instance path verifies; it is not build provenance).
 *
 * The runtime matters: Bun before 1.4 (BoringSSL) throws on `crypto.verify(null, …)` with an EC
 * key, which `@sigstore/core` turns into `false`, so every bundle reads `signature_unverified`
 * there. No public SLSA bundle signed by GitHub's own instance exists to record (that instance signs
 * private repositories' provenance), so its verified path is covered only up to the signature,
 * by the release bundle. The tests probe the runtime and assert the fail-safe result on such a runtime instead of
 * skipping, so they mean something everywhere (CI and releases run Bun 1.4).
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VersionProvenance } from "@nimbus-dev/registry-format";
import {
  bakedRootPolicies,
  parseTrustedRoots,
  recheckReasonText,
  verifyProvenanceBundle,
} from "./provenance-verify.ts";
import { BAKED_SIGSTORE_TRUSTED_ROOTS } from "./sigstore-trusted-roots.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__", "provenance");
const slsaText = readFileSync(join(FIXTURES, "cli-cli-2.105.0-slsa.json"), "utf8");
const releaseText = readFileSync(join(FIXTURES, "cli-cli-2.105.0-release.json"), "utf8");
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

const PACKAGE_SHA256 = "79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f";
const EXPECTED: VersionProvenance = {
  sourceRepository: "cli/cli",
  commit: "e1219499a578b69e3437adaa31cd60614e23c802",
  workflow: ".github/workflows/deployment.yml@refs/heads/trunk",
  runner: "github-hosted",
  verifiedAt: "2026-11-18T00:30:00.000Z",
};

/** Whether this runtime's `crypto.verify` picks a default digest for an EC key, as Node does. */
function ecDefaultDigestWorks(): boolean {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const data = Buffer.from("probe");
  try {
    return verify(null, data, publicKey, sign("sha256", data, privateKey));
  } catch {
    return false;
  }
}
const CAPABLE = ecDefaultDigestWorks();

const check = (over: Partial<Parameters<typeof verifyProvenanceBundle>[0]> = {}) =>
  verifyProvenanceBundle({
    bundleBytes: bytes(slsaText),
    packageSha256: PACKAGE_SHA256,
    expected: EXPECTED,
    ...over,
  });

describe("the baked roots", () => {
  test("hold exactly public-good and GitHub's instance", () => {
    expect(bakedRootPolicies().map((p) => p.instance)).toEqual(["public-good", "github"]);
    expect(parseTrustedRoots(BAKED_SIGSTORE_TRUSTED_ROOTS)).toHaveLength(2);
  });

  test("a root for an unknown Fulcio instance is dropped, never trusted", () => {
    const [first] = BAKED_SIGSTORE_TRUSTED_ROOTS.split("\n");
    const doc = JSON.parse(first ?? "{}") as { certificateAuthorities: Array<{ uri: string }> };
    for (const ca of doc.certificateAuthorities) ca.uri = "https://fulcio.example.com";
    expect(parseTrustedRoots(JSON.stringify(doc))).toEqual([]);
  });
});

describe("verifyProvenanceBundle over real bundles", () => {
  test("the cli/cli SLSA bundle re-verifies against the public-good root", () => {
    expect(check()).toEqual(
      CAPABLE
        ? { status: "verified", instance: "public-good" }
        : { status: "unverified", reason: "signature_unverified" },
    );
  });

  test("the GitHub-instance release bundle verifies its signature but is not build provenance", () => {
    expect(check({ bundleBytes: bytes(releaseText) })).toEqual({
      status: "unverified",
      reason: CAPABLE ? "not_build_provenance" : "signature_unverified",
    });
  });

  test("with no roots, or only the other instance's root, nothing verifies", () => {
    expect(check({ policies: [] })).toEqual({
      status: "unverified",
      reason: "signature_unverified",
    });
    const githubOnly = bakedRootPolicies().filter((p) => p.instance === "github");
    expect(check({ policies: githubOnly })).toEqual({
      status: "unverified",
      reason: "signature_unverified",
    });
  });

  test.if(CAPABLE)("the subject digest compares case-insensitively", () => {
    expect(check({ packageSha256: PACKAGE_SHA256.toUpperCase() }).status).toBe("verified");
  });

  test.if(CAPABLE)("another package's digest is a subject mismatch", () => {
    expect(check({ packageSha256: "0".repeat(64) })).toEqual({
      status: "unverified",
      reason: "subject_mismatch",
    });
  });

  test.if(CAPABLE)(
    "each recorded field the certificate does not carry is an identity mismatch",
    () => {
      for (const expected of [
        { ...EXPECTED, sourceRepository: "cli/other" },
        { ...EXPECTED, commit: "f".repeat(40) },
        { ...EXPECTED, workflow: ".github/workflows/other.yml@refs/heads/trunk" },
        { ...EXPECTED, runner: "self-hosted" as const },
      ]) {
        expect(check({ expected })).toEqual({ status: "unverified", reason: "identity_mismatch" });
      }
      // The repository matches case-insensitively, as everywhere else.
      expect(check({ expected: { ...EXPECTED, sourceRepository: "CLI/Cli" } }).status).toBe(
        "verified",
      );
    },
  );

  test("a tampered statement no longer verifies", () => {
    const b = JSON.parse(slsaText) as { dsseEnvelope: { payload: string } };
    const statement = JSON.parse(
      Buffer.from(b.dsseEnvelope.payload, "base64").toString("utf8"),
    ) as {
      subject: Array<{ digest: { sha256: string } }>;
    };
    const first = statement.subject[0];
    if (first !== undefined) first.digest.sha256 = "0".repeat(64);
    b.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    expect(check({ bundleBytes: bytes(JSON.stringify(b)), packageSha256: "0".repeat(64) })).toEqual(
      { status: "unverified", reason: "signature_unverified" },
    );
  });

  test("malformed, off-shape and oversized input is a reason, never a throw", () => {
    expect(check({ bundleBytes: bytes("not json") })).toEqual({
      status: "unverified",
      reason: "bundle_malformed",
    });
    expect(check({ bundleBytes: bytes(JSON.stringify({ mediaType: "x" })) })).toEqual({
      status: "unverified",
      reason: "bundle_malformed",
    });
    expect(check({ bundleBytes: new Uint8Array(64 * 1024 + 1) })).toEqual({
      status: "unverified",
      reason: "bundle_too_large",
    });
  });
});

describe("recheckReasonText", () => {
  test("every reason has a fixed sentence", () => {
    for (const r of [
      "bundle_unavailable",
      "bundle_too_large",
      "bundle_hash_mismatch",
      "bundle_malformed",
      "signature_unverified",
      "not_build_provenance",
      "subject_mismatch",
      "identity_mismatch",
    ] as const) {
      expect(recheckReasonText(r).length).toBeGreaterThan(10);
    }
  });
});
