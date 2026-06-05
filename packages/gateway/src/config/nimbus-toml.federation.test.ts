import { describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_FEDERATION_TOML, parseNimbusFederationToml } from "./nimbus-toml.ts";

describe("federation config", () => {
  test("federation defaults: disabled, 30s consent timeout, mDNS on", () => {
    expect(DEFAULT_NIMBUS_FEDERATION_TOML).toEqual({
      enabled: false,
      consentTimeoutSeconds: 30,
      mdnsEnabled: true,
      mdnsBind: "0.0.0.0",
    });
  });

  test("parses federation overrides", () => {
    const r = parseNimbusFederationToml(
      `[federation]\nenabled = true\nconsent_timeout_seconds = 15\nmdns_enabled = false\nmdns_bind = "127.0.0.1"\n`,
    );
    expect(r).toEqual({
      enabled: true,
      consentTimeoutSeconds: 15,
      mdnsEnabled: false,
      mdnsBind: "127.0.0.1",
    });
  });

  test("rejects an out-of-range federation consent timeout (keeps default)", () => {
    const r = parseNimbusFederationToml(`[federation]\nconsent_timeout_seconds = 0\n`);
    expect(r.consentTimeoutSeconds).toBe(30);
  });
});
