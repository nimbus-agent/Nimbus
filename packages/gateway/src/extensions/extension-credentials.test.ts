import { describe, expect, test } from "bun:test";

import { MockVault } from "../vault/mock.ts";
import type { ContinuityEntry } from "./continuity/continuity-table.ts";
import {
  credentialsConfigured,
  extensionCredentialVaultKey,
  readCredentialEnv,
  resolveRunCredentials,
  serializeRunCredentials,
} from "./extension-credentials.ts";

function binding(credentials: Record<string, string>): ContinuityEntry {
  return {
    legacyServiceId: "readwise",
    extensionId: "com.nimbus.readwise",
    publisherKey: "k",
    sourceRootFingerprint: "f",
    credentials,
    expectedPermissions: { network: ["readwise.io"], read: [], write: [] },
    itemTypes: ["readwise:highlight", "readwise:book"],
  };
}

describe("extensionCredentialVaultKey", () => {
  test("composes ext.<serviceId>.<name>", () => {
    expect(extensionCredentialVaultKey("ext_x", "token")).toBe("ext.ext_x.token");
  });
});

describe("resolveRunCredentials", () => {
  test("binding maps token to readwise.token", () => {
    const c = resolveRunCredentials(
      { credentials: { token: { env: "READWISE_TOKEN" } } },
      "ext_com_nimbus_readwise",
      binding({ token: "readwise.token" }),
    );
    expect(c).toEqual({ token: { env: "READWISE_TOKEN", vaultKey: "readwise.token" } });
  });

  test("unbound maps token to ext.ext_x.token", () => {
    const c = resolveRunCredentials(
      { credentials: { token: { env: "X_TOKEN" } } },
      "ext_x",
      undefined,
    );
    expect(c).toEqual({ token: { env: "X_TOKEN", vaultKey: "ext.ext_x.token" } });
  });

  test("a declared name the binding lacks falls back to the extension's own key", () => {
    const c = resolveRunCredentials(
      { credentials: { token: { env: "T" }, region: { env: "R" } } },
      "ext_x",
      binding({ token: "readwise.token", unused: "readwise.other" }),
    );
    expect(c).toEqual({
      region: { env: "R", vaultKey: "ext.ext_x.region" },
      token: { env: "T", vaultKey: "readwise.token" },
    });
    // A binding name the manifest does not declare is never granted.
    expect(Object.keys(c)).not.toContain("unused");
  });

  test("no credentials declared (absent or empty) resolves to an empty map", () => {
    expect(resolveRunCredentials({}, "ext_x", undefined)).toEqual({});
    expect(resolveRunCredentials({ credentials: {} }, "ext_x", binding({}))).toEqual({});
  });
});

describe("serializeRunCredentials", () => {
  test("canonical: key-sorted names, fixed field order, {} when empty", () => {
    expect(serializeRunCredentials({})).toBe("{}");
    const a = serializeRunCredentials({
      z: { vaultKey: "ext.e.z", env: "Z" },
      a: { env: "A", vaultKey: "ext.e.a" },
    });
    const b = serializeRunCredentials({
      a: { vaultKey: "ext.e.a", env: "A" },
      z: { env: "Z", vaultKey: "ext.e.z" },
    });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"env":"A","vaultKey":"ext.e.a"},"z":{"env":"Z","vaultKey":"ext.e.z"}}');
  });
});

describe("readCredentialEnv / credentialsConfigured", () => {
  const creds = {
    token: { env: "X_TOKEN", vaultKey: "ext.ext_x.token" },
    region: { env: "X_REGION", vaultKey: "ext.ext_x.region" },
    other: { env: "X_OTHER", vaultKey: "ext.ext_x.other" },
  };

  test("readCredentialEnv omits blank values", async () => {
    const vault = new MockVault();
    await vault.set("ext.ext_x.token", "s3cret");
    await vault.set("ext.ext_x.region", "   ");
    expect(await readCredentialEnv(vault, creds)).toEqual({ X_TOKEN: "s3cret" });
  });

  test("credentialsConfigured needs every key non-blank", async () => {
    const vault = new MockVault();
    expect(await credentialsConfigured(vault, creds)).toBe(false);
    await vault.set("ext.ext_x.token", "a");
    await vault.set("ext.ext_x.region", "b");
    expect(await credentialsConfigured(vault, creds)).toBe(false);
    await vault.set("ext.ext_x.other", " ");
    expect(await credentialsConfigured(vault, creds)).toBe(false);
    await vault.set("ext.ext_x.other", "c");
    expect(await credentialsConfigured(vault, creds)).toBe(true);
  });

  test("credentialsConfigured is true when none are declared", async () => {
    expect(await credentialsConfigured(new MockVault(), {})).toBe(true);
  });
});
