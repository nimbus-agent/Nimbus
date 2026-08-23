import { describe, expect, test } from "bun:test";

import { resolveConnectorEntry, runStandalone, standaloneEligibility } from "./launcher.ts";

describe("resolveConnectorEntry", () => {
  test("resolves a known connector id to its server entry", () => {
    expect(resolveConnectorEntry("github")).toMatch(
      /mcp-connectors[\\/]github[\\/]src[\\/]server\.ts$/,
    );
  });

  test("rejects an id containing a path separator — no traversal via the id", () => {
    expect(() => resolveConnectorEntry("../gateway/src/index")).toThrow(/invalid connector id/);
    expect(() => resolveConnectorEntry("a/b")).toThrow(/invalid connector id/);
    expect(() => resolveConnectorEntry("a\\b")).toThrow(/invalid connector id/);
  });

  test("rejects uppercase and empty ids", () => {
    expect(() => resolveConnectorEntry("GitHub")).toThrow(/invalid connector id/);
    expect(() => resolveConnectorEntry("")).toThrow(/invalid connector id/);
  });
});

describe("standaloneEligibility", () => {
  test("a read-only connector qualifies with no work — nothing to gate", () => {
    // athena exposes only list/get/search and declares no write or delete.
    expect(standaloneEligibility("athena")).toEqual({ eligible: true, reason: "no-writes" });
  });

  test("github qualifies because its write tools were hardened", () => {
    expect(standaloneEligibility("github")).toEqual({ eligible: true, reason: "hardened" });
  });

  test("a write-declaring connector that has NOT been migrated is refused", () => {
    // snowflake declares writes and has not been routed through the consent kit yet.
    const v = standaloneEligibility("snowflake");
    expect(v.eligible).toBe(false);
    expect(v.reason).toMatch(/not been routed through the consent kit/);
  });

  test("a connector that MUTATES but declares nothing is still refused", () => {
    // snyk issues mutating HTTP requests while its manifest says hitlRequired: []. Trusting the
    // manifest alone would admit it as write-free; the verb signal catches it.
    const v = standaloneEligibility("snyk");
    expect(v.eligible).toBe(false);
  });

  test("an unknown connector is refused rather than assumed safe", () => {
    expect(standaloneEligibility("definitely-not-a-connector").eligible).toBe(false);
  });
});

describe("runStandalone", () => {
  test("exits non-zero with usage when no id is given", async () => {
    expect(await runStandalone([])).toBe(2);
  });

  test("exits non-zero for an unknown connector", async () => {
    expect(await runStandalone(["definitely-not-a-connector"])).toBe(2);
  });

  test("exits non-zero for an invalid id", async () => {
    expect(await runStandalone(["../../etc/passwd"])).toBe(2);
  });

  test("refuses an unmigrated write-capable connector with its own exit code", async () => {
    // 3, not 2: "this connector is not safe standalone yet" is a different fact from "no such
    // connector", and a human triaging the failure should not have to read the message to tell.
    expect(await runStandalone(["snowflake"])).toBe(3);
  });
});
