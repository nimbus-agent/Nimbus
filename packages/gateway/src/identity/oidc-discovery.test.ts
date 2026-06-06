// oidc-discovery.test.ts
import { describe, expect, test } from "bun:test";
import { fetchOidcDiscovery } from "./oidc-discovery.ts";

const META = {
  issuer: "https://acme",
  device_authorization_endpoint: "https://acme/dev",
  token_endpoint: "https://acme/token",
  jwks_uri: "https://acme/jwks",
};

describe("fetchOidcDiscovery", () => {
  test("requests .well-known/openid-configuration and maps endpoints", async () => {
    let requested = "";
    const fetchLike = async (url: string) => {
      requested = url;
      return new Response(JSON.stringify(META));
    };
    const d = await fetchOidcDiscovery("https://acme", fetchLike);
    expect(requested).toBe("https://acme/.well-known/openid-configuration");
    expect(d.tokenEndpoint).toBe("https://acme/token");
    expect(d.deviceAuthorizationEndpoint).toBe("https://acme/dev");
    expect(d.jwksUri).toBe("https://acme/jwks");
  });

  test("throws when the IdP lacks a device_authorization_endpoint", async () => {
    const fetchLike = async () =>
      new Response(JSON.stringify({ issuer: "https://acme", token_endpoint: "x", jwks_uri: "y" }));
    await expect(fetchOidcDiscovery("https://acme", fetchLike)).rejects.toThrow();
  });
});
