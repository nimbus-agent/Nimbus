import { expect, test } from "bun:test";
import { assetNameFor, SUPPORTED_TARGETS } from "./release-assets.ts";

const WORKFLOW = "./.github/workflows/release.yml";
const LINUX_PACKAGER = "./scripts/package-linux-installers.ts";
const INSTALL_SH = "./scripts/install/unix/install.sh";

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
    if (target.os === "win32") continue; // install.sh is the macOS/Linux installer only
    const name = assetNameFor(target, "0.0.0").replace("-v0.0.0", "");
    const stem = name.replace(/\.tar\.gz$|\.zip$/, "");
    expect(installSh).toContain(stem);
  }
});
