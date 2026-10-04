import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
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

  test("set() resolves only after EVERY stale temp file of its key is removed, and spares other keys'", async () => {
    // The removals run concurrently. One is HELD open here, so a `set` that waited only for the
    // first removal to finish — or for none of them — resolves while that one is still pending,
    // which a sweep whose removals all finish together could never show.
    const { DpapiVault } = await import("./win32.ts");
    const cfg = mkdtempSync(join(tmpdir(), "nimbus-vault-atomic-"));
    const vaultDir = join(cfg, "vault");
    const stale = ["1.aa", "2.bb", "3.cc"].map((tag) =>
      join(vaultDir, `github.pat.enc.tmp.${tag}`),
    );
    const held = stale[1] ?? "";
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested: string[] = [];
    const vault = new DpapiVault({ configDir: cfg } as never, async (path) => {
      requested.push(path);
      if (path === held) await gate;
      await unlink(path);
    });
    await vault.set("github.pat", "value-one");
    expect(requested).toEqual([]); // nothing stale yet, so the first set removed nothing

    for (const path of stale) writeFileSync(path, "junk");
    const otherKeysLeftover = join(vaultDir, "gitlab.pat.enc.tmp.4.dd");
    writeFileSync(otherKeysLeftover, "junk");
    let resolved = false;
    const second = vault.set("github.pat", "value-two").then(() => {
      resolved = true;
    });

    // Once the held removal is asked for and every other one asked for so far has finished, give
    // a `set` that does not wait for the held one time to settle anyway.
    const deadline = Date.now() + 10_000;
    while (!(requested.includes(held) && requested.every((p) => p === held || !existsSync(p)))) {
      if (Date.now() > deadline) {
        throw new Error(`the sweep never reached the held file: [${requested.join(", ")}]`);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 25));
    expect(resolved).toBe(false);
    expect(existsSync(held)).toBe(true);

    release();
    await second;
    expect(stale.filter((path) => existsSync(path))).toEqual([]);
    expect([...requested].sort()).toEqual([...stale].sort());
    expect(existsSync(otherKeysLeftover)).toBe(true);
    expect(await vault.get("github.pat")).toBe("value-two");
  });
});
