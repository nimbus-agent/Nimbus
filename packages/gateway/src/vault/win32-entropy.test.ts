import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isWin = process.platform === "win32";
const describeWin = isWin ? describe : describe.skip;

describeWin("DpapiVault — optional entropy (S2-F4)", () => {
  test("set generates a 32-byte .entropy file in the vault dir", async () => {
    const { DpapiVault } = await import("./win32.ts");
    const cfg = mkdtempSync(join(tmpdir(), "nimbus-dpapi-entropy-"));
    const vault = new DpapiVault({ configDir: cfg } as never);
    await vault.set("github.pat", "ghp_test_value");
    const entropyPath = join(cfg, "vault", ".entropy");
    expect(existsSync(entropyPath)).toBe(true);
    const buf = readFileSync(entropyPath);
    expect(buf).toHaveLength(32);
  });

  test("round-trips a value across vault instances using the persisted entropy", async () => {
    const { DpapiVault } = await import("./win32.ts");
    const cfg = mkdtempSync(join(tmpdir(), "nimbus-dpapi-roundtrip-"));
    const v1 = new DpapiVault({ configDir: cfg } as never);
    await v1.set("github.pat", "ghp_round_trip");
    const v2 = new DpapiVault({ configDir: cfg } as never);
    expect(await v2.get("github.pat")).toBe("ghp_round_trip");
  });

  test("a tampered .entropy file makes existing entries unrecoverable (security boundary)", async () => {
    const { spawnSync } = await import("node:child_process");
    const { DpapiVault } = await import("./win32.ts");
    const cfg = mkdtempSync(join(tmpdir(), "nimbus-dpapi-tamper-"));
    const v1 = new DpapiVault({ configDir: cfg } as never);
    await v1.set("github.pat", "ghp_value");
    const entropyPath = join(cfg, "vault", ".entropy");
    const winDir = process.env["SystemRoot"] ?? process.env["windir"] ?? String.raw`C:\Windows`;
    spawnSync(String.raw`${winDir}\System32\attrib.exe`, ["-H", "-S", entropyPath], {
      windowsHide: true,
    });
    const newEntropy = Buffer.alloc(32, 0xab);
    writeFileSync(entropyPath, newEntropy);
    const v2 = new DpapiVault({ configDir: cfg } as never);
    await expect(v2.get("github.pat")).rejects.toThrow(/Vault decryption failed/i);
  });

  test("legacy entry without entropy is migrated on first read", async () => {
    const { DpapiVault, _legacyEncryptForTest } = await import("./win32.ts");
    const cfg = mkdtempSync(join(tmpdir(), "nimbus-dpapi-legacy-"));
    const vaultDir = join(cfg, "vault");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(vaultDir, { recursive: true });
    const blob = _legacyEncryptForTest("legacy_value");
    writeFileSync(join(vaultDir, "github.pat.enc"), blob.toString("base64"), "utf8");

    const v1 = new DpapiVault({ configDir: cfg } as never);
    expect(await v1.get("github.pat")).toBe("legacy_value");

    const v2 = new DpapiVault({ configDir: cfg } as never);
    expect(await v2.get("github.pat")).toBe("legacy_value");
  });
});
