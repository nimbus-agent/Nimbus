import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInstallerCommand,
  type InstallerCommandSubprocess,
  type Platform,
} from "./installer.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "nimbus-installer-"));
}

describe("buildInstallerCommand", () => {
  test("macOS invokes open -W on .pkg", () => {
    const dir = tmp();
    const pkg = join(dir, "nimbus-0.2.0.pkg");
    writeFileSync(pkg, "");
    const cmd = buildInstallerCommand("darwin" as Platform, pkg);
    expect(cmd.kind).toBe("subprocess");
    const subprocess = cmd as InstallerCommandSubprocess;
    expect(subprocess.argv[0]).toBe("open");
    expect(subprocess.argv).toContain("-W");
    expect(subprocess.argv.at(-1)).toBe(pkg);
  });

  test("Linux .deb uses dpkg -i with sudo", () => {
    const dir = tmp();
    const deb = join(dir, "nimbus_0.2.0_amd64.deb");
    writeFileSync(deb, "");
    const cmd = buildInstallerCommand("linux" as Platform, deb);
    expect(cmd.kind).toBe("subprocess");
    const subprocess = cmd as InstallerCommandSubprocess;
    expect(subprocess.argv[0]).toBe("sudo");
    expect(subprocess.argv).toContain("dpkg");
  });

  test("Linux tarball is replace-in-place (no subprocess)", () => {
    const dir = tmp();
    const tar = join(dir, "nimbus-0.2.0-x86_64.tar.gz");
    writeFileSync(tar, "");
    const cmd = buildInstallerCommand("linux" as Platform, tar);
    expect(cmd.kind).toBe("replace-in-place");
  });

  test("Windows invokes NSIS installer silently", () => {
    const dir = tmp();
    const exe = join(dir, "nimbus-0.2.0-setup.exe");
    writeFileSync(exe, "");
    const cmd = buildInstallerCommand("win32" as Platform, exe);
    expect(cmd.kind).toBe("subprocess");
    const subprocess = cmd as InstallerCommandSubprocess;
    expect(subprocess.argv[0]).toBe(exe);
    expect(subprocess.argv).toContain("/S");
  });

  test("unknown extension throws", () => {
    const dir = tmp();
    const bogus = join(dir, "nimbus-0.2.0.foo");
    writeFileSync(bogus, "");
    expect(() => buildInstallerCommand("linux" as Platform, bogus)).toThrow(/unsupported/i);
  });
});

describe("executeReplaceInPlace", () => {
  test("copies source over target and chmod +x on POSIX", async () => {
    const { executeReplaceInPlace } = await import("./installer.ts");
    const { statSync } = await import("node:fs");
    const dir = tmp();
    const src = join(dir, "new-binary");
    const dst = join(dir, "live-binary");
    writeFileSync(src, "NEW");
    writeFileSync(dst, "OLD");
    await executeReplaceInPlace({
      kind: "replace-in-place",
      sourceArchive: src,
      targetBinary: dst,
    });
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(dst, "utf8")).toBe("NEW");
    if (process.platform !== "win32") {
      const mode = statSync(dst).mode & 0o777;
      expect(mode).toBe(0o755);
    }
  });
});
