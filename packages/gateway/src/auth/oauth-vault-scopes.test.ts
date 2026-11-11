import { describe, expect, test } from "bun:test";
import { perServiceOAuthVaultKey } from "../connectors/connector-vault.ts";
import { createMemoryVault } from "../testing/bun-test-support.ts";
import {
  readGoogleOAuthScopesForGmailEnv,
  readMicrosoftOAuthScopesForOutlookEnv,
} from "./oauth-vault-tokens.ts";

describe("readMicrosoftOAuthScopesForOutlookEnv", () => {
  test("returns undefined when vault empty or scopes missing", async () => {
    const vault = createMemoryVault();
    expect(await readMicrosoftOAuthScopesForOutlookEnv(vault)).toBeUndefined();

    await vault.set(
      "microsoft.oauth",
      JSON.stringify({
        accessToken: "a",
        refreshToken: "r",
        expiresAt: Date.now() + 60_000,
      }),
    );
    expect(await readMicrosoftOAuthScopesForOutlookEnv(vault)).toBeUndefined();
  });

  test("returns space-separated scopes when present", async () => {
    const vault = createMemoryVault();
    await vault.set(
      "microsoft.oauth",
      JSON.stringify({
        accessToken: "a",
        refreshToken: "r",
        expiresAt: Date.now() + 60_000,
        scopes: ["Calendars.Read", "offline_access"],
      }),
    );
    expect(await readMicrosoftOAuthScopesForOutlookEnv(vault)).toBe(
      "Calendars.Read offline_access",
    );
  });
});

describe("readGoogleOAuthScopesForGmailEnv", () => {
  const payload = (scopes?: unknown): string =>
    JSON.stringify({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 60_000,
      ...(scopes === undefined ? {} : { scopes }),
    });

  test("returns undefined with no Google credential, or one with no scopes", async () => {
    const vault = createMemoryVault();
    expect(await readGoogleOAuthScopesForGmailEnv(vault)).toBeUndefined();
    await vault.set("google.oauth", payload());
    expect(await readGoogleOAuthScopesForGmailEnv(vault)).toBeUndefined();
    await vault.set("google.oauth", payload([]));
    expect(await readGoogleOAuthScopesForGmailEnv(vault)).toBeUndefined();
  });

  test("returns the shared credential's scopes, space-separated", async () => {
    const vault = createMemoryVault();
    await vault.set("google.oauth", payload(["s1", "s2"]));
    expect(await readGoogleOAuthScopesForGmailEnv(vault)).toBe("s1 s2");
  });

  test("Gmail's own credential wins over the shared one; an empty own key falls through", async () => {
    const own = perServiceOAuthVaultKey("gmail");
    if (own === undefined) throw new Error("gmail has no per-service key");
    const vault = createMemoryVault();
    await vault.set("google.oauth", payload(["shared"]));
    await vault.set(own, payload(["own"]));
    expect(await readGoogleOAuthScopesForGmailEnv(vault)).toBe("own");
    await vault.set(own, "");
    expect(await readGoogleOAuthScopesForGmailEnv(vault)).toBe("shared");
  });

  test("an unparseable credential, or scopes that are not strings, give nothing", async () => {
    const vault = createMemoryVault();
    await vault.set("google.oauth", "not json");
    expect(await readGoogleOAuthScopesForGmailEnv(vault)).toBeUndefined();
    await vault.set("google.oauth", "[1]");
    expect(await readGoogleOAuthScopesForGmailEnv(vault)).toBeUndefined();
    await vault.set("google.oauth", payload([1, " ", null]));
    expect(await readGoogleOAuthScopesForGmailEnv(vault)).toBeUndefined();
  });
});
