/**
 * The refusal arms of `buildInstallerCommand` that `installer.test.ts` does not reach: a wrong
 * extension on macOS and on Windows, and a platform with no installer at all. Each refusal must
 * name ITS OWN platform — an updater that reported "unsupported Linux installer" for a macOS
 * download would send the reader to the wrong release asset.
 *
 * `buildInstallerCommand` is pure over the path string (nothing is opened or stat'ed), so no file
 * is created for any case here.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { buildInstallerCommand, type Platform } from "./installer.ts";

const DIR = join("downloads", "nimbus-update");

function refusal(platform: Platform, file: string): string {
  try {
    buildInstallerCommand(platform, join(DIR, file));
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`expected ${platform} to refuse ${file}`);
}

describe("buildInstallerCommand — refusals name the platform that refused", () => {
  test("macOS accepts only .pkg — a .dmg is refused as a macOS extension problem", () => {
    const msg = refusal("darwin", "nimbus-7.0.0.dmg");
    expect(msg).toBe("unsupported macOS installer extension: .dmg");
    expect(msg).not.toContain("Linux");
    expect(msg).not.toContain("Windows");
  });

  test("Windows accepts only .exe — an .msi is refused as a Windows extension problem", () => {
    const msg = refusal("win32", "nimbus-7.0.0.msi");
    expect(msg).toBe("unsupported Windows installer extension: .msi");
    expect(msg).not.toContain("macOS");
    expect(msg).not.toContain("Linux");
  });

  test("a platform with no installer at all is refused by name, whatever the file", () => {
    // `Platform` is a closed union, but the value reaches here from `process.platform` at runtime,
    // which can be any Node platform string — this is the arm that keeps it from falling through.
    const msg = refusal("freebsd" as Platform, "nimbus-7.0.0.pkg");
    expect(msg).toBe("unsupported platform: freebsd");
  });

  test("a bare .gz on Linux is refused: only the full .tar.gz suffix means replace-in-place", () => {
    // `extname` of `x.tar.gz` is `.gz`, so the tarball arm has to test the whole suffix itself.
    // A plain gzip file shares that extension and must NOT be mistaken for a release tarball.
    expect(refusal("linux", "nimbus-7.0.0.gz")).toBe("unsupported Linux installer extension: .gz");
    const tarball = buildInstallerCommand("linux", join(DIR, "nimbus-7.0.0.tar.gz"));
    expect(tarball.kind).toBe("replace-in-place");
  });
});

describe("buildInstallerCommand — accepted shapes", () => {
  test("extension matching ignores case on every platform", () => {
    const pkg = join(DIR, "NIMBUS-7.0.0.PKG");
    expect(buildInstallerCommand("darwin", pkg)).toEqual({
      kind: "subprocess",
      argv: ["open", "-W", pkg],
    });
    const exe = join(DIR, "Nimbus-Setup.EXE");
    expect(buildInstallerCommand("win32", exe)).toEqual({ kind: "subprocess", argv: [exe, "/S"] });
  });

  test("the Linux tarball replaces the RUNNING binary unless a target is given", () => {
    const tarball = join(DIR, "nimbus-7.0.0-x86_64.tar.gz");
    expect(buildInstallerCommand("linux", tarball)).toEqual({
      kind: "replace-in-place",
      targetBinary: process.execPath,
      sourceArchive: tarball,
    });
    const target = join(DIR, "bin", "nimbus-gateway");
    expect(buildInstallerCommand("linux", tarball, { targetBinary: target })).toEqual({
      kind: "replace-in-place",
      targetBinary: target,
      sourceArchive: tarball,
    });
  });
});
