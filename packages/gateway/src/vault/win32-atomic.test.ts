import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isWin = process.platform === "win32";
const describeWin = isWin ? describe : describe.skip;

describeWin("DpapiVault atomic write (S2-F3)", () => {
  test("set() never leaves a partial .enc or .tmp.* file in the vault dir", async () => {
    const { DpapiVault } = await import("./win32.ts");
    const cfg = mkdtempSync(join(tmpdir(), "nimbus-vault-atomic-"));
    const fakePaths = {
      configDir: cfg,
      dataDir: "",
      logDir: "",
      cacheDir: "",
    };
    const vault = new DpapiVault(fakePaths as never);
    await vault.set("github.pat", "ghp_value_v1");
    await vault.set("github.pat", "ghp_value_v2");
    const vaultDir = join(cfg, "vault");
    const entries = readdirSync(vaultDir);
    const tmpLeftovers = entries.filter((f) => f.includes(".tmp."));
    expect(tmpLeftovers).toEqual([]);
    const final = entries.filter((f) => f.endsWith(".enc"));
    expect(final).toEqual(["github.pat.enc"]);
    const st = statSync(join(vaultDir, "github.pat.enc"));
    expect(st.size).toBeGreaterThan(0);
    const got = await vault.get("github.pat");
    expect(got).toBe("ghp_value_v2");
  });

  test("an interrupted write does not corrupt the previous .enc", async () => {
    const { DpapiVault } = await import("./win32.ts");
    const cfg = mkdtempSync(join(tmpdir(), "nimbus-vault-atomic-"));
    const vault = new DpapiVault({ configDir: cfg } as never);
    await vault.set("github.pat", "value-one");
    const vaultDir = join(cfg, "vault");
    const target = join(vaultDir, "github.pat.enc");
    const stale = join(vaultDir, "github.pat.enc.tmp.99999.deadbeef");
    writeFileSync(stale, "junk");
    await vault.set("github.pat", "value-two");
    expect(existsSync(stale)).toBe(false);
    expect(await vault.get("github.pat")).toBe("value-two");
    expect(existsSync(target)).toBe(true);
  });

  test("set() has swept EVERY stale temp file of its own key by the time it resolves, and no other key's", async () => {
    // The removals run concurrently, so this pins both halves of that: `set` waits for each of
    // them rather than for the first, and the prefix filter still spares another key's leftover.
    const { DpapiVault } = await import("./win32.ts");
    const cfg = mkdtempSync(join(tmpdir(), "nimbus-vault-atomic-"));
    const vault = new DpapiVault({ configDir: cfg } as never);
    await vault.set("github.pat", "value-one");
    const vaultDir = join(cfg, "vault");
    const stale = ["1.aa", "2.bb", "3.cc"].map((tag) =>
      join(vaultDir, `github.pat.enc.tmp.${tag}`),
    );
    for (const path of stale) writeFileSync(path, "junk");
    const otherKeysLeftover = join(vaultDir, "gitlab.pat.enc.tmp.4.dd");
    writeFileSync(otherKeysLeftover, "junk");
    await vault.set("github.pat", "value-two");
    expect(stale.filter((path) => existsSync(path))).toEqual([]);
    expect(existsSync(otherKeysLeftover)).toBe(true);
    expect(await vault.get("github.pat")).toBe("value-two");
  });
});
