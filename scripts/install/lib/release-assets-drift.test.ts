import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetNameFor, type InstallTarget, SUPPORTED_TARGETS } from "./release-assets.ts";

const WORKFLOW = join(".github", "workflows", "release.yml");
const LINUX_PACKAGER = join("scripts", "package-linux-installers.ts");
const INSTALL_SH = join("scripts", "install", "unix", "install.sh");
const INSTALL_PS1 = join("scripts", "install", "windows", "install.ps1");

// The macOS/Windows archive names are literal strings in release.yml. The
// Linux tarball name, though, is never spelled out there — it's built in
// scripts/package-linux-installers.ts (as `nimbus-headless-linux-amd64-v${version}.tar.gz`)
// and staged into the release only via the glob `cp dist/installers/*`.
// Pinned PER TARGET, not `producedByWorkflow || producedByLinuxPackager` for
// every target: an OR across both files would let a stale mac/win stem
// linger in package-linux-installers.ts (a file that has no business naming
// them at all) mask a real break in release.yml — the OR would still pass
// via the wrong file. Each target is checked against the ONE file that
// actually produces it.
test("every asset the installer requests is produced by its actual producer (release.yml, or the Linux packager for the Linux target)", async () => {
  const yaml = await Bun.file(WORKFLOW).text();
  const linuxPackager = await Bun.file(LINUX_PACKAGER).text();
  for (const target of SUPPORTED_TARGETS) {
    // Version is a placeholder: strip it so the linux name matches the
    // workflow's/packager's `${version}`-interpolated form.
    const name = assetNameFor(target, "0.0.0").replace("-v0.0.0", "");
    const stem = name.replace(/\.tar\.gz$|\.zip$/, "");
    if (target.os === "linux") {
      expect(linuxPackager).toContain(stem);
    } else {
      expect(yaml).toContain(stem);
    }
  }
});

test("SHA256SUMS is staged, since verification is mandatory", async () => {
  const yaml = await Bun.file(WORKFLOW).text();
  expect(yaml).toContain("SHA256SUMS");
});

// install.sh is a standalone, single-file script by design (it's fetched on
// its own and cannot source siblings) and so re-hardcodes the macOS/Linux
// asset name patterns rather than importing assetNameFor. That constraint
// applies to the SCRIPT, not to this guard: this test reads install.sh as
// data and asserts each stem it should be requesting is actually present,
// so a rename in release.yml/the Linux packager (which the tests above
// already catch) also gets caught here before install.sh silently 404s for
// every user — the exact failure class #1167 was.
test("install.sh's remote-mode asset names match the release-assets SSoT", async () => {
  const installSh = await Bun.file(INSTALL_SH).text();
  for (const target of SUPPORTED_TARGETS) {
    // install.sh is the macOS/Linux installer only — win32 is install.ps1's
    // job, covered by the test immediately below. Skipping win32 here used
    // to leave it with NO drift guard at all (a stale comment claimed the
    // opposite); that gap is exactly the failure class #1167 was, on the
    // one platform where it had never been fixed.
    if (target.os === "win32") continue;
    const name = assetNameFor(target, "0.0.0").replace("-v0.0.0", "");
    const stem = name.replace(/\.tar\.gz$|\.zip$/, "");
    expect(installSh).toContain(stem);
  }
});

// The Windows counterpart of the guard above: install.ps1 also re-hardcodes
// its asset name (it too is a standalone, single-file script, fetched and
// run on its own). Only win32 applies here — install.ps1 is the Windows
// installer only.
test("install.ps1's remote-mode asset name matches the release-assets SSoT", async () => {
  const installPs1 = await Bun.file(INSTALL_PS1).text();
  for (const target of SUPPORTED_TARGETS) {
    if (target.os !== "win32") continue;
    const name = assetNameFor(target, "0.0.0").replace("-v0.0.0", "");
    const stem = name.replace(/\.tar\.gz$|\.zip$/, "");
    expect(installPs1).toContain(stem);
  }
});

/**
 * The `toContain` guards above prove each stem is PRESENT in install.sh. They
 * cannot prove install.sh actually RESOLVES to that name on a given platform —
 * a stem can sit in a dead branch, or be paired with the wrong `uname` arm.
 *
 * This runs install.sh for real, in `--dry-run` mode (which "prints planned
 * actions and exits", touching neither disk nor network), with `uname` stubbed
 * to each supported platform, and compares the name it would request against
 * the SSoT by EXACT equality.
 *
 * The point is that it does this for macOS from a Linux runner. install.sh's
 * macOS naming previously had no executable cover at PR time at all: the
 * PR-time cross-platform job runs gateway/CLI unit tests only, so a macOS-only
 * naming break could only ever be caught by the post-merge matrix — which is
 * exactly how five install tests stayed red on main for six consecutive runs.
 */
const UNAME_FOR: Record<string, { readonly s: string; readonly m: string }> = {
  "linux/x64": { s: "Linux", m: "x86_64" },
  "darwin/arm64": { s: "Darwin", m: "arm64" },
  "darwin/x64": { s: "Darwin", m: "x86_64" },
};

/** A directory holding a `uname` that reports the given platform. */
function unameShimDir(os: string, machine: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-uname-"));
  const shim = join(dir, "uname");
  writeFileSync(
    shim,
    `#!/bin/sh\ncase "$1" in\n  -m) echo ${machine} ;;\n  *) echo ${os} ;;\nesac\n`,
  );
  chmodSync(shim, 0o755);
  return dir;
}

async function dryRunAssetName(target: InstallTarget, version: string): Promise<string> {
  const uname = UNAME_FOR[`${target.os}/${target.arch}`];
  if (uname === undefined) throw new Error(`no uname mapping for ${target.os}/${target.arch}`);
  const shim = unameShimDir(uname.s, uname.m);
  const proc = Bun.spawn(["sh", INSTALL_SH, "--dry-run", "--from-release", version, "--yes"], {
    // POSIX-only by construction (skipped on Windows), so ":" is correct here.
    env: { ...process.env, PATH: `${shim}:${process.env["PATH"]}` }, // cross-platform-ok
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const line = stdout.split("\n").find((l) => l.includes("Would download:"));
  if (line === undefined) {
    throw new Error(
      `install.sh --dry-run printed no download plan.\nstdout:${stdout}\nstderr:${stderr}`,
    );
  }
  return line.slice(line.lastIndexOf("/") + 1).trim();
}

const skipDryRun = process.platform === "win32" || !Bun.which("sh");

test.skipIf(skipDryRun)(
  "install.sh --dry-run resolves EXACTLY the SSoT asset name on every supported target",
  async () => {
    const version = "2.2.0";
    for (const target of SUPPORTED_TARGETS) {
      if (target.os === "win32") continue; // install.ps1's job.
      expect(await dryRunAssetName(target, version)).toBe(assetNameFor(target, version));
    }
  },
  30_000,
);

// `/releases/latest/download/` resolves an exact filename and silently
// ignores a pinned version — forbidden by both installers' own remote-mode
// contract (a pinned -FromRelease/--from-release must not be ignored). Cheap
// guard against either script regressing onto it.
test("neither installer uses the forbidden /releases/latest/download/ URL form", async () => {
  const installSh = await Bun.file(INSTALL_SH).text();
  const installPs1 = await Bun.file(INSTALL_PS1).text();
  expect(installSh).not.toContain("/releases/latest/download/");
  expect(installPs1).not.toContain("/releases/latest/download/");
});
