import { describe, expect, test } from "bun:test";

import { decideAttestWrite, parseAttestation } from "./_bypass-attestation.ts";

describe("parseAttestation", () => {
  test("parses a well-formed attestation", () => {
    const raw = JSON.stringify({
      attested_at: "2026-07-30T06:15:00.000Z",
      attested_by: "asafgolombek",
      grace_days: 90,
      repos: ["Nimbus"],
      observed: { Nimbus: [] },
    });
    const parsed = parseAttestation(raw);
    expect(parsed).not.toBe("unparseable");
    if (parsed === "unparseable") throw new Error("unreachable");
    expect(parsed.attested_by).toBe("asafgolombek");
  });

  test("reports invalid JSON as unparseable", () => {
    expect(parseAttestation("{not json")).toBe("unparseable");
  });

  test("reports legal JSON that is not an object as unparseable", () => {
    expect(parseAttestation("[]")).toBe("unparseable");
    expect(parseAttestation('"a string"')).toBe("unparseable");
    expect(parseAttestation("null")).toBe("unparseable");
  });
});

describe("decideAttestWrite", () => {
  test("writes on a green, complete read", () => {
    expect(decideAttestWrite({ ok: true, queried: 5, total: 5, unreachable: [] }).write).toBe(true);
  });

  test("refuses on drift", () => {
    const d = decideAttestWrite({ ok: false, queried: 5, total: 5, unreachable: [] });
    expect(d.write).toBe(false);
    expect(d.reason).toContain("drift");
  });

  // The hole the design review caught: decideExit returns exit 0 for a partial
  // read with no drift, so keying --attest off the exit code alone would write an
  // attestation claiming 5 repos on 4 repos' evidence.
  test("refuses on a PARTIAL read even with zero drift", () => {
    const d = decideAttestWrite({
      ok: true,
      queried: 4,
      total: 5,
      unreachable: ["nimbus-sdk"],
    });
    expect(d.write).toBe(false);
    expect(d.reason).toContain("nimbus-sdk");
    expect(d.reason).toContain("read 4 of 5");
  });
});
