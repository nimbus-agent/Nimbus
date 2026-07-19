import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlatformPaths } from "../platform/paths.ts";
import { isWellFormedVaultKey } from "./index.ts";
import { extractNimbusVaultKeysFromSecretToolSearchOutput } from "./linux.ts";
import { MockVault } from "./mock.ts";

function dpapiVaultTestPaths(root: string, socketPath: string): PlatformPaths {
  return {
    configDir: root,
    dataDir: join(root, "data"),
    logDir: join(root, "logs"),
    socketPath,
    extensionsDir: join(root, "ext"),
    tempDir: join(root, "tmp"),
  };
}

describe("vault key validation", () => {
  test("accepts documented service.type shape", () => {
    expect(isWellFormedVaultKey("gmail.oauth")).toBe(true);
    expect(isWellFormedVaultKey("onedrive.refresh")).toBe(true);
    expect(isWellFormedVaultKey("google_drive.oauth")).toBe(true);
  });

  test("accepts N-segment keys with publisher-id char set in trailing segments (T2 PR 2)", () => {
    expect(isWellFormedVaultKey("extension.publisher_key.foo")).toBe(true);
    expect(isWellFormedVaultKey("extension.publisher_key.nimbus.test")).toBe(true);
    expect(isWellFormedVaultKey("extension.publisher_key.acme-corp")).toBe(true);
    expect(isWellFormedVaultKey("extension.publisher_key.0abc")).toBe(true);
  });

  test("rejects empty and oversize keys", () => {
    expect(isWellFormedVaultKey("")).toBe(false);
    expect(isWellFormedVaultKey(`${"x".repeat(255)}.y`)).toBe(false);
  });

  test("rejects malformed segments", () => {
    expect(isWellFormedVaultKey(".oauth")).toBe(false);
    expect(isWellFormedVaultKey("gmail.")).toBe(false);
    expect(isWellFormedVaultKey("gmail..oauth")).toBe(false);
    expect(isWellFormedVaultKey("9mail.oauth")).toBe(false);
    expect(isWellFormedVaultKey("gmail.o auth")).toBe(false);
    expect(isWellFormedVaultKey("extension.publisher_key.")).toBe(false);
    expect(isWellFormedVaultKey("extension.publisher_key.UPPER")).toBe(false);
  });

  test("rejects uppercase to prevent NTFS / HFS+ case-fold collisions", () => {
    expect(isWellFormedVaultKey("Github.pat")).toBe(false);
    expect(isWellFormedVaultKey("github.PAT")).toBe(false);
    expect(isWellFormedVaultKey("GITHUB.pat")).toBe(false);
    expect(isWellFormedVaultKey("OneDrive.Refresh")).toBe(false);
    expect(isWellFormedVaultKey("Onedrive.refresh")).toBe(false);
  });
});

describe("MockVault", () => {
  test("get returns null for missing keys", async () => {
    const v = new MockVault();
    expect(await v.get("none.here")).toBeNull();
  });

  test("set, get, delete, listKeys", async () => {
    const v = new MockVault();
    await v.set("svc.token", "a");
    await v.set("svc.other", "b");
    await v.set("other.x", "c");
    expect(await v.get("svc.token")).toBe("a");
    await v.delete("svc.token");
    expect(await v.get("svc.token")).toBeNull();
    expect(await v.listKeys()).toEqual(["other.x", "svc.other"]);
    expect(await v.listKeys("svc.")).toEqual(["svc.other"]);
  });

  test("delete on missing key is a no-op", async () => {
    const v = new MockVault();
    await expect(v.delete("nope.here")).resolves.toBeUndefined();
  });

  test("listKeys returns key names only, never secret values", async () => {
    const v = new MockVault();
    const secret = "super-secret-payload-unique-77291";
    await v.set("svc.token", secret);
    const keys = await v.listKeys();
    expect(keys).toEqual(["svc.token"]);
    expect(keys.some((k) => k.includes(secret))).toBe(false);
    expect(keys).not.toContain(secret);
  });

  test("rejects malformed keys without echoing secret material", async () => {
    const v = new MockVault();
    const secret = "x".repeat(4000);
    try {
      await v.set("not_a_key", secret);
      expect.unreachable();
    } catch (e: unknown) {
      expect(String(e)).toContain("Invalid vault key format");
      expect(String(e)).not.toContain(secret);
    }
    await expect(v.get("!!!")).rejects.toThrow("Invalid vault key format");
    await expect(v.delete("")).rejects.toThrow("Invalid vault key format");
  });
});

describe("DpapiVault (Windows)", () => {
  test.skipIf(process.platform !== "win32")(
    "set, get, delete, listKeys round-trip via DPAPI",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "nimbus-vault-dpapi-"));
      const paths = dpapiVaultTestPaths(root, String.raw`\\.\pipe\nimbus-vault-test`);
      const { DpapiVault } = await import("./win32.ts");
      const v = new DpapiVault(paths);
      await v.set("svc.token", "round-trip-secret");
      expect(await v.get("svc.token")).toBe("round-trip-secret");
      expect(await v.listKeys()).toEqual(["svc.token"]);
      expect(await v.listKeys("svc.")).toEqual(["svc.token"]);
      await v.delete("svc.token");
      expect(await v.get("svc.token")).toBeNull();
    },
  );

  test.skipIf(process.platform !== "win32")(
    "get on missing key returns null without throwing",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "nimbus-vault-dpapi-miss-"));
      const paths = dpapiVaultTestPaths(root, String.raw`\\.\pipe\nimbus-vault-miss`);
      const { DpapiVault } = await import("./win32.ts");
      const v = new DpapiVault(paths);
      expect(await v.get("missing.key")).toBeNull();
    },
  );

  test.skipIf(process.platform !== "win32")("delete on missing key is a no-op", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-vault-dpapi-del-"));
    const paths = dpapiVaultTestPaths(root, String.raw`\\.\pipe\nimbus-vault-del`);
    const { DpapiVault } = await import("./win32.ts");
    const v = new DpapiVault(paths);
    await expect(v.delete("absent.key")).resolves.toBeUndefined();
  });
});

describe("DarwinKeychainVault (macOS)", () => {
  test.skipIf(process.platform !== "darwin")(
    "set, get, delete, listKeys round-trip via Keychain",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "nimbus-vault-keychain-"));
      const paths: PlatformPaths = {
        configDir: root,
        dataDir: join(root, "data"),
        logDir: join(root, "logs"),
        socketPath: join(root, "nimbus-gateway.sock"),
        extensionsDir: join(root, "ext"),
        tempDir: join(root, "tmp"),
      };
      const { DarwinKeychainVault } = await import("./darwin.ts");
      const v = new DarwinKeychainVault(paths);
      const key = "ci.smoke";
      await v.set(key, "darwin-round-trip");
      expect(await v.get(key)).toBe("darwin-round-trip");
      expect(await v.listKeys()).toContain(key);
      expect(await v.listKeys("ci.")).toEqual([key]);
      await v.delete(key);
      expect(await v.get(key)).toBeNull();
    },
  );
});

describe("LinuxSecretToolVault search output parsing", () => {
  test("extracts keys from secret-tool label lines", () => {
    const raw = `[/org/freedesktop/secrets/item/x]
label = Nimbus: ci.t_1
secret = x
`;
    expect(extractNimbusVaultKeysFromSecretToolSearchOutput(raw)).toEqual(["ci.t_1"]);
  });

  test("sorts keys alphabetically", () => {
    const raw = `label = Nimbus: z.a
label = Nimbus: a.b
`;
    expect(extractNimbusVaultKeysFromSecretToolSearchOutput(raw)).toEqual(["a.b", "z.a"]);
  });

  test("extracts keys from secret-tool attribute lines on stderr", () => {
    const err = `attribute.application = nimbus
attribute.nimbus-key = ci.t_2
`;
    expect(extractNimbusVaultKeysFromSecretToolSearchOutput("", err)).toEqual(["ci.t_2"]);
  });

  test("merges label stdout and nimbus-key stderr without duplicates", () => {
    const out = "label = Nimbus: same.key\n";
    const err = "attribute.nimbus-key = same.key\n";
    expect(extractNimbusVaultKeysFromSecretToolSearchOutput(out, err)).toEqual(["same.key"]);
  });
});

describe("LinuxSecretToolVault (Linux)", () => {
  test.skipIf(process.platform !== "linux")(
    "set, get, delete, listKeys round-trip via secret-tool",
    async () => {
      const { LinuxSecretToolVault } = await import("./linux.ts");
      const v = new LinuxSecretToolVault();
      const key = `ci.t_${Date.now()}`;
      await v.set(key, "linux-round-trip");
      expect(await v.get(key)).toBe("linux-round-trip");
      expect(await v.listKeys("ci.")).toContain(key);
      await v.delete(key);
      expect(await v.get(key)).toBeNull();
    },
  );
});
