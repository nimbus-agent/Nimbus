import { expect, test } from "bun:test";
import { assetNameFor, SUPPORTED_TARGETS } from "./release-assets.ts";

const WORKFLOW = "./.github/workflows/release.yml";
const LINUX_PACKAGER = "./scripts/package-linux-installers.ts";
const INSTALL_SH = "./scripts/install/unix/install.sh";
const INSTALL_PS1 = "./scripts/install/windows/install.ps1";

// The macOS/Windows archive names are literal strings in release.yml. The
// Linux tarball name, though, is never spelled out there — it's built in
// scripts/package-linux-installers.ts (as `nimbus-headless-linux-amd64-v${version}.tar.gz`)
// and staged into the release only via the glob `cp dist/installers/*`. So a
// name that release.yml never mentions verbatim isn't necessarily undrifted:
// it may still be produced by the packager script that the glob picks up.
// This guard treats an asset as "produced" if EITHER file accounts for it —
// that matches how the release pipeline actually stages assets, not just how
// one workflow file happens to spell them.
test("every asset the installer requests is produced by release.yml or the Linux packager script", async () => {
  const yaml = await Bun.file(WORKFLOW).text();
  const linuxPackager = await Bun.file(LINUX_PACKAGER).text();
  for (const target of SUPPORTED_TARGETS) {
    // Version is a placeholder: strip it so the linux name matches the
    // workflow's/packager's `${version}`-interpolated form.
    const name = assetNameFor(target, "0.0.0").replace("-v0.0.0", "");
    const stem = name.replace(/\.tar\.gz$|\.zip$/, "");
    const producedByWorkflow = yaml.includes(stem);
    const producedByLinuxPackager = linuxPackager.includes(stem);
    expect(producedByWorkflow || producedByLinuxPackager).toBe(true);
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
