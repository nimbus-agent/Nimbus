import { describe, expect, test } from "bun:test";
import { dbRun } from "../db/write.ts";
import { createMemoryVault, openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import {
  ALL_GOOGLE_OAUTH_VAULT_KEYS,
  type ConnectorSecretKeyOf,
  clearOAuthVaultIfProviderUnused,
  deleteConnectorSecret,
  migrateToPerServiceOAuthKeys,
  perServiceOAuthVaultKey,
  readConnectorSecret,
  sharedOAuthKey,
  writeConnectorSecret,
  writePerServiceOAuthKey,
} from "./connector-vault.ts";

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function assertEq<_A, _B>(_: Eq<_A, _B>): void {
  // Intentionally empty: assertion happens at the type-checker, not at runtime.
}

describe("readConnectorSecret", () => {
  test("returns the stored value when the key is set", async () => {
    const vault = createMemoryVault();
    await vault.set("github.pat", "ghp_test");
    expect(await readConnectorSecret(vault, "github", "pat")).toBe("ghp_test");
  });

  test("returns null when the key is absent", async () => {
    const vault = createMemoryVault();
    expect(await readConnectorSecret(vault, "github", "pat")).toBeNull();
  });

  test("does not trim or coerce empty string", async () => {
    const vault = createMemoryVault();
    await vault.set("slack.oauth", "  raw value  ");
    expect(await readConnectorSecret(vault, "slack", "oauth")).toBe("  raw value  ");

    await vault.set("notion.oauth", "");
    expect(await readConnectorSecret(vault, "notion", "oauth")).toBe("");
  });

  test("resolves api_key and app_key to distinct vault keys (datadog multi-key)", async () => {
    const vault = createMemoryVault();
    await vault.set("datadog.api_key", "API");
    await vault.set("datadog.app_key", "APP");
    expect(await readConnectorSecret(vault, "datadog", "api_key")).toBe("API");
    expect(await readConnectorSecret(vault, "datadog", "app_key")).toBe("APP");
  });

  test("resolves non-credential-shaped keys (gitlab.api_base)", async () => {
    const vault = createMemoryVault();
    await vault.set("gitlab.api_base", "https://gitlab.example.com/api/v4");
    expect(await readConnectorSecret(vault, "gitlab", "api_base")).toBe(
      "https://gitlab.example.com/api/v4",
    );
  });

  test("compile-time: rejects non-manifested keys", async () => {
    const vault = createMemoryVault();
    // @ts-expect-error — manifest is ["github.pat"]; "oauth" is not a github key.
    void readConnectorSecret(vault, "github", "oauth");

    // @ts-expect-error — google_drive manifest is empty; ConnectorSecretKeyOf resolves to never.
    void readConnectorSecret(vault, "google_drive", "oauth");

    // The @ts-expect-error directives above are the real (compile-time)
    // assertions; confirm a manifested read still resolves at runtime.
    await vault.set("github.pat", "ok");
    expect(await readConnectorSecret(vault, "github", "pat")).toBe("ok");
  });
});

describe("ConnectorSecretKeyOf — type pins", () => {
  // The earlier `@ts-expect-error` directives only assert that bad inputs are
  test("pins to manifest-derived bare-key suffixes (compile-time)", () => {
    assertEq<ConnectorSecretKeyOf<"github">, "pat">(true);
    assertEq<ConnectorSecretKeyOf<"slack">, "oauth" | "bot_token" | "app_token">(true);
    assertEq<ConnectorSecretKeyOf<"linear">, "api_key">(true);
    assertEq<ConnectorSecretKeyOf<"gitlab">, "pat" | "api_base">(true);
    assertEq<ConnectorSecretKeyOf<"datadog">, "api_key" | "app_key" | "site">(true);
    assertEq<ConnectorSecretKeyOf<"bitbucket">, "username" | "app_password">(true);

    assertEq<ConnectorSecretKeyOf<"google_drive">, never>(true);
    assertEq<ConnectorSecretKeyOf<"gmail">, never>(true);
    assertEq<ConnectorSecretKeyOf<"google_photos">, never>(true);
    assertEq<ConnectorSecretKeyOf<"google_meet">, never>(true);
    assertEq<ConnectorSecretKeyOf<"onedrive">, never>(true);
    assertEq<ConnectorSecretKeyOf<"outlook">, never>(true);
    assertEq<ConnectorSecretKeyOf<"teams">, "bot_app_id" | "bot_app_password">(true);
    assertEq<ConnectorSecretKeyOf<"github_actions">, never>(true);

    // @ts-expect-error — `ConnectorSecretKeyOf<"github">` is `"pat"`, not `string`.
    assertEq<ConnectorSecretKeyOf<"github">, string>(true);
    // @ts-expect-error — `ConnectorSecretKeyOf<"google_drive">` is `never`, not `string`.
    assertEq<ConnectorSecretKeyOf<"google_drive">, string>(true);

    assertEq<Parameters<typeof writeConnectorSecret<"github">>[2], "pat">(true);
    assertEq<Parameters<typeof writeConnectorSecret<"datadog">>[2], "api_key" | "app_key" | "site">(
      true,
    );

    assertEq<Parameters<typeof sharedOAuthKey>[0], "google" | "microsoft">(true);
    assertEq<ReturnType<typeof sharedOAuthKey>, "google.oauth" | "microsoft.oauth">(true);

    assertEq<Parameters<typeof deleteConnectorSecret<"github">>[2], "pat">(true);
    assertEq<ReturnType<typeof deleteConnectorSecret>, Promise<void>>(true);

    // The assertEq calls above are compile-time; exercise one symbol at runtime.
    expect(sharedOAuthKey("microsoft")).toBe("microsoft.oauth");
  });
});

describe("sharedOAuthKey", () => {
  test("returns google.oauth for google", () => {
    expect(sharedOAuthKey("google")).toBe("google.oauth");
  });

  test("returns microsoft.oauth for microsoft", () => {
    expect(sharedOAuthKey("microsoft")).toBe("microsoft.oauth");
  });

  test("compile-time: rejects non-provider strings", () => {
    // @ts-expect-error — SharedOAuthProvider is "google" | "microsoft" only.
    assertEq<Parameters<typeof sharedOAuthKey>[0], "github">(true);
    expect(sharedOAuthKey("google")).toBe("google.oauth");
  });
});

describe("writeConnectorSecret", () => {
  test("writes the value under the constructed key", async () => {
    const vault = createMemoryVault();
    await writeConnectorSecret(vault, "github", "pat", "ghp_test");
    expect(await vault.get("github.pat")).toBe("ghp_test");
  });

  test("overwrites an existing value at the same key", async () => {
    const vault = createMemoryVault();
    await vault.set("github.pat", "old");
    await writeConnectorSecret(vault, "github", "pat", "new");
    expect(await vault.get("github.pat")).toBe("new");
  });

  test("stores empty string and whitespace verbatim (no validation)", async () => {
    const vault = createMemoryVault();
    await writeConnectorSecret(vault, "slack", "oauth", "");
    expect(await vault.get("slack.oauth")).toBe("");
    await writeConnectorSecret(vault, "slack", "oauth", "  raw  ");
    expect(await vault.get("slack.oauth")).toBe("  raw  ");
  });

  test("multi-key services write to distinct vault keys", async () => {
    const vault = createMemoryVault();
    await writeConnectorSecret(vault, "datadog", "api_key", "API");
    await writeConnectorSecret(vault, "datadog", "app_key", "APP");
    expect(await vault.get("datadog.api_key")).toBe("API");
    expect(await vault.get("datadog.app_key")).toBe("APP");
  });

  test("compile-time: rejects non-manifested keys", async () => {
    const vault = createMemoryVault();
    // @ts-expect-error — github manifest is ["github.pat"].
    await writeConnectorSecret(vault, "github", "oauth", "x");
    // @ts-expect-error — google_drive manifest is empty; ConnectorSecretKeyOf resolves to never.
    await writeConnectorSecret(vault, "google_drive", "oauth", "x");
    // The calls above are type-rejected (compile-time) but still execute at
    // runtime, writing under the constructed `<service>.<key>` vault key.
    expect(await vault.get("github.oauth")).toBe("x");
    expect(await vault.get("google_drive.oauth")).toBe("x");
  });
});

describe("deleteConnectorSecret", () => {
  test("deletes the value at the constructed key", async () => {
    const vault = createMemoryVault();
    await vault.set("github.pat", "ghp_test");
    await deleteConnectorSecret(vault, "github", "pat");
    expect(await vault.get("github.pat")).toBeNull();
  });

  test("is a no-op when the key is absent", async () => {
    const vault = createMemoryVault();
    await deleteConnectorSecret(vault, "github", "pat");
    expect(await vault.get("github.pat")).toBeNull();
  });

  test("does not affect sibling keys on the same service", async () => {
    const vault = createMemoryVault();
    await vault.set("datadog.api_key", "API");
    await vault.set("datadog.app_key", "APP");
    await deleteConnectorSecret(vault, "datadog", "api_key");
    expect(await vault.get("datadog.api_key")).toBeNull();
    expect(await vault.get("datadog.app_key")).toBe("APP");
  });

  test("does not affect other services' keys", async () => {
    const vault = createMemoryVault();
    await vault.set("github.pat", "ghp");
    await vault.set("gitlab.pat", "glpat");
    await deleteConnectorSecret(vault, "github", "pat");
    expect(await vault.get("github.pat")).toBeNull();
    expect(await vault.get("gitlab.pat")).toBe("glpat");
  });

  test("compile-time: rejects non-manifested keys", async () => {
    const vault = createMemoryVault();
    // @ts-expect-error — github manifest is ["github.pat"].
    await deleteConnectorSecret(vault, "github", "oauth");
    // @ts-expect-error — google_drive manifest is empty; ConnectorSecretKeyOf resolves to never.
    await deleteConnectorSecret(vault, "google_drive", "oauth");
    // Type-rejected at compile time; at runtime they delete absent keys (no-op).
    expect(await vault.get("github.oauth")).toBeNull();
    expect(await vault.get("google_drive.oauth")).toBeNull();
  });
});

describe("perServiceOAuthVaultKey", () => {
  test("returns service-specific Google keys", () => {
    expect(perServiceOAuthVaultKey("google_drive")).toBe("google_drive.oauth");
    expect(perServiceOAuthVaultKey("gmail")).toBe("google_gmail.oauth");
    expect(perServiceOAuthVaultKey("google_photos")).toBe("google_photos.oauth");
  });

  test("returns service-specific Microsoft keys", () => {
    expect(perServiceOAuthVaultKey("onedrive")).toBe("onedrive.oauth");
    expect(perServiceOAuthVaultKey("outlook")).toBe("outlook.oauth");
    expect(perServiceOAuthVaultKey("teams")).toBe("teams.oauth");
  });

  test("returns undefined for non-Google/Microsoft services", () => {
    expect(perServiceOAuthVaultKey("github")).toBeUndefined();
    expect(perServiceOAuthVaultKey("slack")).toBeUndefined();
    expect(perServiceOAuthVaultKey("notion")).toBeUndefined();
    expect(perServiceOAuthVaultKey("datadog")).toBeUndefined();
  });
});

describe("ALL_GOOGLE_OAUTH_VAULT_KEYS", () => {
  test("includes the shared and all per-service Google OAuth keys", () => {
    expect(ALL_GOOGLE_OAUTH_VAULT_KEYS).toContain("google.oauth");
    expect(ALL_GOOGLE_OAUTH_VAULT_KEYS).toContain("google_drive.oauth");
    expect(ALL_GOOGLE_OAUTH_VAULT_KEYS).toContain("google_gmail.oauth");
    expect(ALL_GOOGLE_OAUTH_VAULT_KEYS).toContain("google_photos.oauth");
  });
});

describe("writePerServiceOAuthKey", () => {
  test("copies the value from the shared key under the per-service key", async () => {
    const vault = createMemoryVault();
    await vault.set("google.oauth", "shared-google-token");
    await writePerServiceOAuthKey(vault, "google_drive", "google.oauth");
    expect(await vault.get("google_drive.oauth")).toBe("shared-google-token");
  });

  test("is a no-op when the source shared key is missing (null)", async () => {
    const vault = createMemoryVault();
    await writePerServiceOAuthKey(vault, "google_drive", "google.oauth");
    expect(await vault.get("google_drive.oauth")).toBeNull();
  });

  test("is a no-op when the source shared key is empty string", async () => {
    const vault = createMemoryVault();
    await vault.set("microsoft.oauth", "");
    await writePerServiceOAuthKey(vault, "outlook", "microsoft.oauth");
    expect(await vault.get("outlook.oauth")).toBeNull();
  });

  test("is a no-op for services without a per-service key", async () => {
    const vault = createMemoryVault();
    await vault.set("github.oauth", "ghp_test");
    await writePerServiceOAuthKey(vault, "github", "github.oauth");
    expect(await vault.get("github.oauth")).toBe("ghp_test");
  });

  test("idempotent: overwrites existing per-service value on second call", async () => {
    const vault = createMemoryVault();
    await vault.set("microsoft.oauth", "first");
    await writePerServiceOAuthKey(vault, "outlook", "microsoft.oauth");
    expect(await vault.get("outlook.oauth")).toBe("first");
    await vault.set("microsoft.oauth", "second");
    await writePerServiceOAuthKey(vault, "outlook", "microsoft.oauth");
    expect(await vault.get("outlook.oauth")).toBe("second");
  });
});

describe("migrateToPerServiceOAuthKeys", () => {
  test("copies microsoft.oauth into empty per-service Microsoft keys", async () => {
    const vault = createMemoryVault();
    await vault.set("microsoft.oauth", "ms-shared-token");
    await migrateToPerServiceOAuthKeys(vault);
    expect(await vault.get("onedrive.oauth")).toBe("ms-shared-token");
    expect(await vault.get("outlook.oauth")).toBe("ms-shared-token");
    expect(await vault.get("teams.oauth")).toBe("ms-shared-token");
  });

  test("does not overwrite existing per-service Microsoft keys", async () => {
    const vault = createMemoryVault();
    await vault.set("microsoft.oauth", "shared");
    await vault.set("outlook.oauth", "outlook-specific");
    await migrateToPerServiceOAuthKeys(vault);
    expect(await vault.get("outlook.oauth")).toBe("outlook-specific");
    expect(await vault.get("onedrive.oauth")).toBe("shared");
    expect(await vault.get("teams.oauth")).toBe("shared");
  });

  test("overwrites an empty-string per-service Microsoft key", async () => {
    const vault = createMemoryVault();
    await vault.set("microsoft.oauth", "shared");
    await vault.set("teams.oauth", "");
    await migrateToPerServiceOAuthKeys(vault);
    expect(await vault.get("teams.oauth")).toBe("shared");
  });

  test("is a no-op when microsoft.oauth is absent", async () => {
    const vault = createMemoryVault();
    await migrateToPerServiceOAuthKeys(vault);
    expect(await vault.get("onedrive.oauth")).toBeNull();
    expect(await vault.get("outlook.oauth")).toBeNull();
    expect(await vault.get("teams.oauth")).toBeNull();
  });

  test("is a no-op when microsoft.oauth is empty string", async () => {
    const vault = createMemoryVault();
    await vault.set("microsoft.oauth", "");
    await migrateToPerServiceOAuthKeys(vault);
    expect(await vault.get("onedrive.oauth")).toBeNull();
  });

  test("never touches Google keys (Google migration is intentionally omitted)", async () => {
    const vault = createMemoryVault();
    await vault.set("google.oauth", "google-shared");
    await migrateToPerServiceOAuthKeys(vault);
    expect(await vault.get("google_drive.oauth")).toBeNull();
    expect(await vault.get("google_gmail.oauth")).toBeNull();
    expect(await vault.get("google_photos.oauth")).toBeNull();
  });
});

function insertItemRow(
  db: ReturnType<typeof openMemoryIndexDatabase>,
  service: string,
  externalId: string,
): void {
  dbRun(
    db,
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES (?, ?, 'file', ?, 'test', 0, 0)`,
    [`${service}:${externalId}`, service, externalId],
  );
}

describe("clearOAuthVaultIfProviderUnused", () => {
  test("clears Google keys when no Google items remain", async () => {
    const vault = createMemoryVault();
    const db = openMemoryIndexDatabase();
    await vault.set("google.oauth", "shared");
    await vault.set("google_drive.oauth", "drive");
    await vault.set("google_gmail.oauth", "gmail");
    await vault.set("google_photos.oauth", "photos");

    const cleared = await clearOAuthVaultIfProviderUnused(vault, db, "google_drive");

    expect(cleared).toContain("google.oauth");
    expect(cleared).toContain("google_drive.oauth");
    expect(cleared).toContain("google_gmail.oauth");
    expect(cleared).toContain("google_photos.oauth");
    expect(await vault.get("google.oauth")).toBeNull();
    expect(await vault.get("google_drive.oauth")).toBeNull();
    expect(await vault.get("google_gmail.oauth")).toBeNull();
    expect(await vault.get("google_photos.oauth")).toBeNull();
  });

  test("retains Google keys when other Google services still have items", async () => {
    const vault = createMemoryVault();
    const db = openMemoryIndexDatabase();
    await vault.set("google.oauth", "shared");
    await vault.set("google_drive.oauth", "drive");
    insertItemRow(db, "gmail", "msg-1");

    const cleared = await clearOAuthVaultIfProviderUnused(vault, db, "google_drive");

    expect(cleared).toEqual([]);
    expect(await vault.get("google.oauth")).toBe("shared");
    expect(await vault.get("google_drive.oauth")).toBe("drive");
  });

  test("clears Microsoft keys when no Microsoft items remain", async () => {
    const vault = createMemoryVault();
    const db = openMemoryIndexDatabase();
    await vault.set("microsoft.oauth", "shared");
    await vault.set("onedrive.oauth", "od");
    await vault.set("outlook.oauth", "ol");
    await vault.set("teams.oauth", "tm");

    const cleared = await clearOAuthVaultIfProviderUnused(vault, db, "outlook");

    expect(cleared).toContain("microsoft.oauth");
    expect(cleared).toContain("onedrive.oauth");
    expect(cleared).toContain("outlook.oauth");
    expect(cleared).toContain("teams.oauth");
    expect(await vault.get("microsoft.oauth")).toBeNull();
    expect(await vault.get("onedrive.oauth")).toBeNull();
    expect(await vault.get("outlook.oauth")).toBeNull();
    expect(await vault.get("teams.oauth")).toBeNull();
  });

  test("retains Microsoft keys when other Microsoft services still have items", async () => {
    const vault = createMemoryVault();
    const db = openMemoryIndexDatabase();
    await vault.set("microsoft.oauth", "shared");
    insertItemRow(db, "teams", "channel-1");

    const cleared = await clearOAuthVaultIfProviderUnused(vault, db, "outlook");

    expect(cleared).toEqual([]);
    expect(await vault.get("microsoft.oauth")).toBe("shared");
  });

  test("returns empty list and writes nothing for non-provider-family services", async () => {
    const vault = createMemoryVault();
    const db = openMemoryIndexDatabase();
    await vault.set("google.oauth", "shared");
    await vault.set("microsoft.oauth", "ms");

    const cleared = await clearOAuthVaultIfProviderUnused(vault, db, "github");

    expect(cleared).toEqual([]);
    expect(await vault.get("google.oauth")).toBe("shared");
    expect(await vault.get("microsoft.oauth")).toBe("ms");
  });
});
