// nimbus-toml-identity.test.ts
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NIMBUS_IDENTITY_TOML,
  DEFAULT_NIMBUS_SCIM_TOML,
  parseNimbusIdentityToml,
  parseNimbusScimToml,
} from "./nimbus-toml.ts";

describe("[identity] config", () => {
  test("defaults: disabled, device_code, sensible grace", () => {
    expect(DEFAULT_NIMBUS_IDENTITY_TOML.enabled).toBe(false);
    expect(DEFAULT_NIMBUS_IDENTITY_TOML.flow).toBe("device_code");
    expect(DEFAULT_NIMBUS_IDENTITY_TOML.sessionGraceSeconds).toBeGreaterThan(0);
  });
  test("parses issuer/client_id/scopes/grace", () => {
    const cfg = parseNimbusIdentityToml(
      [
        "[identity]",
        'issuer = "https://acme.okta.com"',
        'client_id = "0oaABC"',
        "enabled = true",
        'scopes = ["openid", "email"]',
        "session_grace_seconds = 120",
        "jwks_max_age_seconds = 3600",
      ].join("\n"),
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.issuer).toBe("https://acme.okta.com");
    expect(cfg.clientId).toBe("0oaABC");
    expect(cfg.scopes).toEqual(["openid", "email"]);
    expect(cfg.sessionGraceSeconds).toBe(120);
    expect(cfg.jwksMaxAgeSeconds).toBe(3600);
  });
});

describe("[scim] config", () => {
  test("default disabled", () => {
    expect(DEFAULT_NIMBUS_SCIM_TOML.enabled).toBe(false);
  });
  test("parses enabled", () => {
    expect(parseNimbusScimToml("[scim]\nenabled = true").enabled).toBe(true);
  });
});
