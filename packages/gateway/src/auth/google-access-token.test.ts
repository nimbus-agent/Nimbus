import { describe, expect, test } from "bun:test";

import { createMemoryVault } from "../testing/bun-test-support.ts";
import {
  anyGoogleOAuthVaultPresent,
  GOOGLE_OWN_KEY_ONLY_SERVICES,
  getValidGoogleAccessToken,
  resolveGoogleOAuthVaultKey,
} from "./google-access-token.ts";

describe("resolveGoogleOAuthVaultKey", () => {
  test("prefers per-service key when non-empty", async () => {
    const vault = createMemoryVault();
    await vault.set("google_gmail.oauth", '{"accessToken":"a","refreshToken":"r","expiresAt":9}');
    await vault.set("google.oauth", '{"accessToken":"shared","refreshToken":"rs","expiresAt":9}');
    expect(await resolveGoogleOAuthVaultKey(vault, "gmail")).toBe("google_gmail.oauth");
  });

  test("falls back to google.oauth when per-service is empty", async () => {
    const vault = createMemoryVault();
    await vault.set("google.oauth", '{"accessToken":"s","refreshToken":"r","expiresAt":9}');
    expect(await resolveGoogleOAuthVaultKey(vault, "google_drive")).toBe("google.oauth");
  });

  test("returns null when no credential exists", async () => {
    const vault = createMemoryVault();
    expect(await resolveGoogleOAuthVaultKey(vault, "google_photos")).toBeNull();
  });
});

describe("google_calendar is own-key-only (its own consent, never the shared key)", () => {
  test("the shared google.oauth and the siblings' keys never resolve for google_calendar", async () => {
    const vault = createMemoryVault();
    await vault.set("google.oauth", '{"accessToken":"s","refreshToken":"r","expiresAt":9}');
    await vault.set("google_gmail.oauth", '{"accessToken":"g","refreshToken":"r","expiresAt":9}');
    expect(await resolveGoogleOAuthVaultKey(vault, "google_calendar")).toBeNull();
    await expect(getValidGoogleAccessToken(vault, "google_calendar")).rejects.toThrow(
      /google_calendar/,
    );
  });

  test("its own per-service key resolves", async () => {
    const vault = createMemoryVault();
    await vault.set(
      "google_calendar.oauth",
      '{"accessToken":"c","refreshToken":"r","expiresAt":9}',
    );
    expect(await resolveGoogleOAuthVaultKey(vault, "google_calendar")).toBe(
      "google_calendar.oauth",
    );
  });

  test("the set names exactly google_calendar; the siblings keep the shared fallback", async () => {
    expect([...GOOGLE_OWN_KEY_ONLY_SERVICES]).toEqual(["google_calendar"]);
    const vault = createMemoryVault();
    await vault.set("google.oauth", '{"accessToken":"s","refreshToken":"r","expiresAt":9}');
    for (const id of ["google_drive", "gmail", "google_photos", "google_meet"] as const) {
      expect(await resolveGoogleOAuthVaultKey(vault, id), id).toBe("google.oauth");
    }
  });
});

describe("anyGoogleOAuthVaultPresent", () => {
  test("is false for empty vault", async () => {
    const vault = createMemoryVault();
    expect(await anyGoogleOAuthVaultPresent(vault)).toBe(false);
  });

  test("is true when any Google OAuth key is set", async () => {
    const vault = createMemoryVault();
    await vault.set("google_drive.oauth", "{}");
    expect(await anyGoogleOAuthVaultPresent(vault)).toBe(true);
  });
});
