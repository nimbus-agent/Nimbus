import { describe, expect, test } from "bun:test";

import { SECTION_LOADERS } from "./config-explain.ts";
import { parseNimbusTomlIncidentScribe } from "./incident-scribe-toml.ts";

describe("[incident.scribe]", () => {
  test("is off by default and when the section is absent", () => {
    expect(parseNimbusTomlIncidentScribe("").enabled).toBe(false);
    expect(parseNimbusTomlIncidentScribe("[incident]\nenabled = true\n").enabled).toBe(false);
  });

  test("enabled = true turns it on; other sections do not", () => {
    expect(parseNimbusTomlIncidentScribe("[incident.scribe]\nenabled = true\n").enabled).toBe(true);
    expect(
      parseNimbusTomlIncidentScribe("[incident.scribe]\nenabled = true\n[x]\nenabled = false\n")
        .enabled,
    ).toBe(true);
  });

  test("a malformed value falls back to false and is reported", () => {
    const seen: string[] = [];
    expect(
      parseNimbusTomlIncidentScribe('[incident.scribe]\nenabled = "yes"\n', (m) => seen.push(m))
        .enabled,
    ).toBe(false);
    expect(seen).toHaveLength(1);
  });

  test("is registered for nimbus config explain", () => {
    expect(SECTION_LOADERS["incident.scribe"]).toBeDefined();
  });
});
