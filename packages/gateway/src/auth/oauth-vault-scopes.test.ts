import { describe, expect, test } from "bun:test";
import { perServiceOAuthVaultKey } from "../connectors/connector-vault.ts";
import { createMemoryVault } from "../testing/bun-test-support.ts";
import {
  readGoogleOAuthScopesForCalendarEnv,
  readGoogleOAuthScopesForGmailEnv,
  readGoogleOAuthScopesForSpawnEnv,
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

describe("readGoogleOAuthScopesForCalendarEnv (connectors 0.20.0: own key only)", () => {
  const payload = (scopes?: unknown): string =>
    JSON.stringify({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 60_000,
      ...(scopes === undefined ? {} : { scopes }),
    });
  const own = (): string => {
    const key = perServiceOAuthVaultKey("google_calendar");
    if (key === undefined) throw new Error("google_calendar has no per-service key");
    return key;
  };

  test("returns Calendar's own credential's scopes, space-separated", async () => {
    const vault = createMemoryVault();
    await vault.set(own(), payload(["s1", "s2"]));
    expect(await readGoogleOAuthScopesForCalendarEnv(vault)).toBe("s1 s2");
  });

  test("never falls back to the shared google.oauth: absent, empty or scope-less own key gives nothing", async () => {
    const vault = createMemoryVault();
    await vault.set("google.oauth", payload(["https://www.googleapis.com/auth/calendar"]));
    expect(await readGoogleOAuthScopesForCalendarEnv(vault)).toBeUndefined();
    await vault.set(own(), "");
    expect(await readGoogleOAuthScopesForCalendarEnv(vault)).toBeUndefined();
    await vault.set(own(), payload());
    expect(await readGoogleOAuthScopesForCalendarEnv(vault)).toBeUndefined();
    await vault.set(own(), "not json");
    expect(await readGoogleOAuthScopesForCalendarEnv(vault)).toBeUndefined();
  });
});

describe("readGoogleOAuthScopesForSpawnEnv", () => {
  test("Gmail and Google Calendar get their own readers' scopes; every other service none", async () => {
    const vault = createMemoryVault();
    const stored = (scopes: string[]): string =>
      JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: 1, scopes });
    await vault.set("google.oauth", stored(["shared"]));
    const calendarKey = perServiceOAuthVaultKey("google_calendar");
    if (calendarKey === undefined) throw new Error("google_calendar has no per-service key");
    await vault.set(calendarKey, stored(["cal"]));
    expect(await readGoogleOAuthScopesForSpawnEnv(vault, "gmail")).toBe("shared");
    expect(await readGoogleOAuthScopesForSpawnEnv(vault, "google_calendar")).toBe("cal");
    for (const id of ["google_drive", "google_photos", "google_meet"]) {
      expect(await readGoogleOAuthScopesForSpawnEnv(vault, id), id).toBeUndefined();
    }
  });
});
