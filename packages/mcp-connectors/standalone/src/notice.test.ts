import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = (p: string): string => resolve(fileURLToPath(import.meta.url), p);

describe("security tiering is stated where it survives", () => {
  const notice = readFileSync(here("../../../NOTICE"), "utf8");

  test("NOTICE names what standalone does NOT provide", () => {
    for (const missing of ["sandbox", "keychain", "egress ledger", "owner-controlled consent"]) {
      expect(notice).toContain(missing);
    }
  });

  test("NOTICE does not claim gateway-equivalent protection", () => {
    expect(notice).not.toMatch(/equivalent to the gateway/i);
  });

  test("NOTICE reserves trademark rather than adding a licence restriction", () => {
    // AGPL section 7 forbids ADDING restrictions, so the lever is trademark, not copyright.
    expect(notice).toContain("trademark");
    expect(notice).toContain("AGPL-3.0-only");
  });

  test("the pilot connector ships machine-readable instructions", () => {
    const src = readFileSync(here("../../../github/src/server.ts"), "utf8");
    expect(src).toContain("instructions:");
    expect(src).toContain("not registered at all");
  });
});
