import { describe, expect, test } from "bun:test";

import {
  signatureLabel,
  verifiedPublisherCell,
  verifiedPublisherLine,
} from "./verified-publisher-text.ts";

const BADGE = { github: "acme-dev", verifiedAt: "2026-10-20T00:00:00Z" };

describe("verifiedPublisherLine", () => {
  test("names the handle and the verification date, or says unverified", () => {
    expect(verifiedPublisherLine(BADGE)).toBe(
      "Verified publisher: @acme-dev (verified 2026-10-20)",
    );
    expect(verifiedPublisherLine(null)).toBe("Unverified publisher");
    expect(verifiedPublisherLine(undefined)).toBe("Unverified publisher");
  });

  test("never prints a control character, whatever a gateway sends", () => {
    const line = verifiedPublisherLine({ github: "a\u001b[31mb", verifiedAt: "2026\u001b-10-20" });
    expect(line).not.toContain("\u001b");
    expect(line).toBe("Verified publisher: @a31mb (verified 2026-10-20)");
  });
});

describe("verifiedPublisherCell", () => {
  test("a marker and the handle, or a dash", () => {
    expect(verifiedPublisherCell(BADGE)).toBe("✓ @acme-dev");
    expect(verifiedPublisherCell(null)).toBe("-");
    expect(verifiedPublisherCell(undefined)).toBe("-");
  });
});

describe("signatureLabel", () => {
  test("is about the SIGNATURE, never 'publisher: verified'; a key conflict has no signature label", () => {
    expect(signatureLabel("verified")).toBe("signature verified");
    expect(signatureLabel("signature_failed")).toBe("signature failed");
    expect(signatureLabel("publisher_key_conflict")).toBe("");
  });
});
