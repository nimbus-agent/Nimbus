import { expect, test } from "bun:test";
import { assetNameFor, SUPPORTED_TARGETS } from "./release-assets.ts";

const WORKFLOW = "./.github/workflows/release.yml";
const LINUX_PACKAGER = "./scripts/package-linux-installers.ts";

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
