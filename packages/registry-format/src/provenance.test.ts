import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  provenanceFromGhVerify,
  provenanceMatching,
  readManifestRepository,
  readVersionProvenance,
  type VersionProvenance,
} from "./provenance.ts";

/**
 * Real `gh attestation verify gh_2.96.0_windows_amd64.zip --repo cli/cli --format json` output
 * (gh 2.96.0, 2026-10-27), trimmed to the certificate and the predicate type: public data.
 */
const SAMPLE: unknown = JSON.parse(
  readFileSync(join(import.meta.dir, "testdata", "gh-attestation-verify-cli-cli.json"), "utf8"),
);
const AT = "2026-10-27T12:00:00.000Z";

type Cert = Record<string, unknown>;
const sampleCert = (): Cert =>
  structuredClone(
    (SAMPLE as Array<{ verificationResult: { signature: { certificate: Cert } } }>)[0]
      ?.verificationResult.signature.certificate as Cert,
  );

function entry(cert: Cert, predicateType = "https://slsa.dev/provenance/v1"): unknown {
  return { verificationResult: { signature: { certificate: cert }, statement: { predicateType } } };
}

const OK: VersionProvenance = {
  sourceRepository: "cli/cli",
  commit: "b300f2ec7ec9dc9addc39b2ad88c54097ded7ca0",
  workflow: ".github/workflows/deployment.yml@refs/heads/trunk",
  runner: "github-hosted",
  verifiedAt: AT,
};

describe("provenanceFromGhVerify", () => {
  test("the real cli/cli output is provenance from cli/cli", () => {
    expect(provenanceFromGhVerify(SAMPLE, "cli/cli", AT)).toEqual({ ok: true, provenance: OK });
  });

  test("another repository, and the prefix-confusion case, are refused", () => {
    for (const repo of ["evil/cli", "cli/cli-malicious", "cli/cl"]) {
      const r = provenanceFromGhVerify(SAMPLE, repo, AT);
      expect(r.ok).toBe(false);
    }
    // The attacker's repository attesting the bytes: its certificate names the attacker.
    const cert = { ...sampleCert(), sourceRepositoryURI: "https://github.com/cli/cli-malicious" };
    expect(provenanceFromGhVerify([entry(cert)], "cli/cli", AT)).toMatchObject({
      ok: false,
      reason: "the attestation was not built from cli/cli",
    });
  });

  test("owner/repo match case-insensitively; the workflow keeps its original case", () => {
    const cert = {
      ...sampleCert(),
      buildConfigURI: "https://github.com/CLI/Cli/.github/workflows/Deploy.yml@refs/heads/Trunk",
    };
    const r = provenanceFromGhVerify([entry(cert)], "Cli/CLI", AT);
    expect(r).toMatchObject({
      ok: true,
      provenance: { workflow: ".github/workflows/Deploy.yml@refs/heads/Trunk" },
    });
  });

  test("a 64-hex (SHA-256 repository) commit is accepted; a short one is refused", () => {
    const long = { ...sampleCert(), sourceRepositoryDigest: "a".repeat(64) };
    expect(provenanceFromGhVerify([entry(long)], "cli/cli", AT).ok).toBe(true);
    const short = { ...sampleCert(), sourceRepositoryDigest: "abc123" };
    expect(provenanceFromGhVerify([entry(short)], "cli/cli", AT)).toMatchObject({
      reason: "the attestation names no source commit",
    });
  });

  test("an SBOM entry before the SLSA one: the SLSA entry is used", () => {
    const sbom = entry(sampleCert(), "https://spdx.dev/Document/v2.3");
    expect(provenanceFromGhVerify([sbom, ...(SAMPLE as unknown[])], "cli/cli", AT)).toEqual({
      ok: true,
      provenance: OK,
    });
    expect(provenanceFromGhVerify([sbom], "cli/cli", AT)).toMatchObject({
      reason: "not a SLSA v1 build provenance attestation",
    });
  });

  test("a reusable workflow signs from elsewhere: the caller's workflow is recorded", () => {
    const cert = {
      ...sampleCert(),
      buildSignerURI: "https://github.com/acme/workflows/.github/workflows/build.yml@refs/tags/v1",
    };
    expect(provenanceFromGhVerify([entry(cert)], "cli/cli", AT)).toEqual({
      ok: true,
      provenance: OK,
    });
    const outside = {
      ...sampleCert(),
      buildConfigURI: "https://github.com/acme/workflows/.github/workflows/build.yml@refs/tags/v1",
    };
    expect(provenanceFromGhVerify([entry(outside)], "cli/cli", AT)).toMatchObject({
      reason: "the attestation's workflow is not in cli/cli",
    });
  });

  test("a self-hosted runner is recorded as such", () => {
    const cert = { ...sampleCert(), runnerEnvironment: "self-hosted" };
    expect(provenanceFromGhVerify([entry(cert)], "cli/cli", AT)).toMatchObject({
      provenance: { runner: "self-hosted" },
    });
  });

  test("empty, malformed and off-shape output is refused with a reason", () => {
    expect(provenanceFromGhVerify([], "cli/cli", AT)).toMatchObject({
      reason: "gh returned no attestations",
    });
    expect(provenanceFromGhVerify({ not: "an array" }, "cli/cli", AT).ok).toBe(false);
    expect(provenanceFromGhVerify(["x"], "cli/cli", AT)).toMatchObject({
      reason: "an attestation entry is not an object",
    });
    expect(
      provenanceFromGhVerify(
        [
          {
            verificationResult: { statement: { predicateType: "https://slsa.dev/provenance/v1" } },
          },
        ],
        "cli/cli",
        AT,
      ),
    ).toMatchObject({ reason: "the attestation carries no certificate" });
    for (const uri of [
      "http://github.com/cli/cli",
      "https://gitlab.com/cli/cli",
      "https://github.com/cli",
      "https://github.com/cli/cli?x=1",
      "not a url",
    ]) {
      const cert = { ...sampleCert(), sourceRepositoryURI: uri };
      expect(provenanceFromGhVerify([entry(cert)], "cli/cli", AT).ok).toBe(false);
    }
    const weird = { ...sampleCert(), buildConfigURI: "https://github.com/cli/cli/<script>" };
    expect(provenanceFromGhVerify([entry(weird)], "cli/cli", AT)).toMatchObject({
      reason: "the attestation's workflow path is not recognisable",
    });
    expect(provenanceFromGhVerify(SAMPLE, "not a repo", AT)).toMatchObject({
      reason: "malformed repository",
    });
  });
});

describe("readManifestRepository", () => {
  test("owner/repo is read; anything else is absent, never an error", () => {
    expect(readManifestRepository({ repository: "acme/tool" })).toBe("acme/tool");
    for (const bad of [
      "https://github.com/acme/tool",
      "git@github.com:acme/tool.git",
      "acme",
      "acme/tool/extra",
      42,
    ]) {
      expect(readManifestRepository({ repository: bad })).toBeUndefined();
    }
    expect(readManifestRepository({})).toBeUndefined();
    expect(readManifestRepository("x")).toBeUndefined();
  });
});

describe("readVersionProvenance / provenanceMatching", () => {
  test("the exact shape is read; each off-shape field is no provenance", () => {
    expect(readVersionProvenance({ provenance: OK })).toEqual(OK);
    for (const bad of [
      { ...OK, sourceRepository: "x" },
      { ...OK, commit: "zz" },
      { ...OK, workflow: "w".repeat(201) },
      { ...OK, runner: "laptop" },
      { ...OK, verifiedAt: "yesterday" },
    ]) {
      expect(readVersionProvenance({ provenance: bad })).toBeUndefined();
    }
    expect(readVersionProvenance({ provenance: "x" })).toBeUndefined();
    expect(readVersionProvenance(null)).toBeUndefined();
  });

  test("shown only when the manifest declares the same repository", () => {
    expect(provenanceMatching({ provenance: OK }, "CLI/cli")).toEqual(OK);
    expect(provenanceMatching({ provenance: OK }, "other/cli")).toBeUndefined();
    expect(provenanceMatching({ provenance: OK }, undefined)).toBeUndefined();
    expect(provenanceMatching({}, "cli/cli")).toBeUndefined();
  });
});
