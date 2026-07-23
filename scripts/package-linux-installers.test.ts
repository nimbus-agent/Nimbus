import { afterEach, beforeEach, expect, test } from "bun:test";

const linuxTest = process.platform === "linux" ? test : test.skip;

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;
let bundleDir: string;
let outDir: string;
let stubToolPath: string;

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

function makeStub(name: string, body: string): string {
  const p = join(workDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\nset -e\n${body}\n`, "utf8");
  chmodSync(p, 0o755);
  return p;
}

function runInstaller(extraArgs: string[]) {
  return spawnSync(
    process.execPath,
    [
      "scripts/package-linux-installers.ts",
      "--bundle",
      bundleDir,
      "--out",
      outDir,
      "--version",
      "0.1.0-rc1",
      ...extraArgs,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nimbus-pkg-linux-"));
  bundleDir = join(workDir, "bundle");
  outDir = join(workDir, "out");
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  writeFileSync(join(bundleDir, "nimbus-gateway"), "#!/bin/sh\necho gw\n", "utf8");
  writeFileSync(join(bundleDir, "nimbus"), "#!/bin/sh\necho cli\n", "utf8");
  chmodSync(join(bundleDir, "nimbus-gateway"), 0o755);
  chmodSync(join(bundleDir, "nimbus"), 0o755);

  stubToolPath = makeStub("stub-appimagetool", `OUT="$2"\nprintf 'AITS' > "$OUT"`);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

linuxTest("produces .deb with expected name", () => {
  const r = runInstaller(["--skip-appimage", "--skip-sandbox-helper"]);
  expect(r.status).toBe(0);
  expect(existsSync(join(outDir, "nimbus-headless_0.1.0-rc1_amd64.deb"))).toBe(true);
});

linuxTest("produces tarball with expected name", () => {
  const r = runInstaller(["--skip-appimage", "--skip-sandbox-helper"]);
  expect(r.status).toBe(0);
  expect(existsSync(join(outDir, "nimbus-headless-linux-amd64-v0.1.0-rc1.tar.gz"))).toBe(true);
});

linuxTest("produces .AppImage with stubbed appimagetool", () => {
  const r = runInstaller(["--appimagetool", stubToolPath, "--skip-sandbox-helper"]);
  expect(r.status).toBe(0);
  const appImage = join(outDir, "nimbus-headless-0.1.0-rc1-x86_64.AppImage");
  expect(existsSync(appImage)).toBe(true);
  const head = readFileSync(appImage).subarray(0, 4).toString();
  expect(head).toBe("AITS");
});

linuxTest("populates AppDir with AppRun, .desktop, icon, and binaries before invoking tool", () => {
  const listingPath = join(workDir, "appdir-listing.txt");
  const recordingStub = makeStub(
    "recording-stub",
    `APPDIR="$1"\n(cd "$APPDIR" && find . -type f | sort) > "${listingPath}"\nprintf 'AITS' > "$2"`,
  );

  const r = runInstaller(["--appimagetool", recordingStub, "--skip-sandbox-helper"]);
  expect(r.status).toBe(0);

  const listing = readFileSync(listingPath, "utf8");
  expect(listing).toContain("./AppRun");
  expect(listing).toContain("./nimbus-headless.desktop");
  expect(listing).toContain("./nimbus-headless.png");
  expect(listing).toContain("./usr/bin/nimbus");
  expect(listing).toContain("./usr/bin/nimbus-gateway");
  expect(listing).toContain("./usr/share/applications/nimbus-headless.desktop");
});

linuxTest("substitutes {{VERSION}} placeholder in desktop entry", () => {
  const desktopOut = join(workDir, "captured.desktop");
  const recordingStub = makeStub(
    "desktop-recording-stub",
    `APPDIR="$1"\ncp "$APPDIR/nimbus-headless.desktop" "${desktopOut}"\nprintf 'AITS' > "$2"`,
  );

  runInstaller(["--appimagetool", recordingStub, "--skip-sandbox-helper"]);

  const desktop = readFileSync(desktopOut, "utf8");
  expect(desktop).toContain("X-AppImage-Version=0.1.0-rc1");
  expect(desktop).not.toContain("{{VERSION}}");
});

linuxTest("tarball contains install.sh and uninstall.sh", () => {
  const r = runInstaller(["--skip-appimage", "--skip-sandbox-helper"]);
  expect(r.status).toBe(0);
  const tarballPath = join(outDir, "nimbus-headless-linux-amd64-v0.1.0-rc1.tar.gz");
  expect(existsSync(tarballPath)).toBe(true);
  const tarList = spawnSync("/usr/bin/tar", ["-tzf", tarballPath], {
    encoding: "utf8",
  });
  expect(tarList.status).toBe(0);
  expect(tarList.stdout).toContain("install.sh");
  expect(tarList.stdout).toContain("uninstall.sh");
});

linuxTest("AppImage output dir contains sibling install.sh and uninstall.sh", () => {
  const r = runInstaller(["--appimagetool", stubToolPath, "--skip-sandbox-helper"]);
  expect(r.status).toBe(0);
  expect(existsSync(join(outDir, "install.sh"))).toBe(true);
  expect(existsSync(join(outDir, "uninstall.sh"))).toBe(true);
});

linuxTest(".deb DEBIAN/control declares bubblewrap + libcap2-bin as Depends", () => {
  const r = runInstaller(["--skip-appimage", "--skip-sandbox-helper"]);
  expect(r.status).toBe(0);
  const debPath = join(outDir, "nimbus-headless_0.1.0-rc1_amd64.deb");
  expect(existsSync(debPath)).toBe(true);
  const info = spawnSync("/usr/bin/dpkg-deb", ["-I", debPath], { encoding: "utf8" });
  expect(info.status).toBe(0);
  expect(info.stdout).toMatch(/Depends:\s*bubblewrap,\s*libcap2-bin/);
});

linuxTest(".deb postinst runs setcap on nimbus-sandbox-helper", () => {
  const stubHelper = join(workDir, "stub-helper");
  writeFileSync(stubHelper, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(stubHelper, 0o755);

  const r = runInstaller(["--skip-appimage", "--sandbox-helper", stubHelper]);
  expect(r.status).toBe(0);
  const debPath = join(outDir, "nimbus-headless_0.1.0-rc1_amd64.deb");
  expect(existsSync(debPath)).toBe(true);
  const ctrlDir = join(workDir, "deb-ctrl");
  mkdirSync(ctrlDir, { recursive: true });
  const extract = spawnSync("/usr/bin/dpkg-deb", ["-e", debPath, ctrlDir], { encoding: "utf8" });
  expect(extract.status).toBe(0);
  const postinst = readFileSync(join(ctrlDir, "postinst"), "utf8");
  expect(postinst).toContain("setcap cap_net_admin+ep");
  expect(postinst).toContain("/usr/lib/nimbus/bin/nimbus-sandbox-helper");

  const contents = spawnSync("/usr/bin/dpkg-deb", ["-c", debPath], { encoding: "utf8" });
  expect(contents.status).toBe(0);
  expect(contents.stdout).toContain("./usr/lib/nimbus/bin/nimbus-sandbox-helper");
});

linuxTest("tarball linux-postinstall.sh prints bwrap pre-check banner", () => {
  const r = runInstaller(["--skip-appimage", "--skip-sandbox-helper"]);
  expect(r.status).toBe(0);
  const tarballPath = join(outDir, "nimbus-headless-linux-amd64-v0.1.0-rc1.tar.gz");
  expect(existsSync(tarballPath)).toBe(true);
  const extractDir = join(workDir, "tar-extract");
  mkdirSync(extractDir, { recursive: true });
  const x = spawnSync("/usr/bin/tar", ["-xzf", tarballPath, "-C", extractDir], {
    encoding: "utf8",
  });
  expect(x.status).toBe(0);
  const postScript = readFileSync(join(extractDir, "linux-postinstall.sh"), "utf8");
  expect(postScript).toContain("command -v bwrap");
  expect(postScript).toContain("sudo apt install bubblewrap");
  expect(postScript).toContain("sudo dnf install bubblewrap");
  expect(postScript).toContain("sudo pacman -S bubblewrap");
});

linuxTest("tarball ships nimbus-sandbox-helper when --sandbox-helper is set", () => {
  const stubHelper = join(workDir, "stub-helper");
  writeFileSync(stubHelper, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(stubHelper, 0o755);

  const r = runInstaller(["--skip-appimage", "--sandbox-helper", stubHelper]);
  expect(r.status).toBe(0);
  const tarballPath = join(outDir, "nimbus-headless-linux-amd64-v0.1.0-rc1.tar.gz");
  const tarList = spawnSync("/usr/bin/tar", ["-tzf", tarballPath], { encoding: "utf8" });
  expect(tarList.status).toBe(0);
  expect(tarList.stdout).toContain("bin/nimbus-sandbox-helper");
});

linuxTest(".deb wrappers stamp the apt channel + disable the self-updater", () => {
  const r = runInstaller(["--skip-appimage", "--skip-sandbox-helper"]);
  expect(r.status).toBe(0);
  const debPath = join(outDir, "nimbus-headless_0.1.0-rc1_amd64.deb");
  const extractDir = join(workDir, "deb-data");
  mkdirSync(extractDir, { recursive: true });
  const x = spawnSync("/usr/bin/dpkg-deb", ["-x", debPath, extractDir], { encoding: "utf8" });
  expect(x.status).toBe(0);
  const wrapper = readFileSync(join(extractDir, "usr/local/bin/nimbus"), "utf8");
  expect(wrapper).toContain("NIMBUS_DISTRIBUTION_CHANNEL=apt");
  expect(wrapper).toContain("NIMBUS_UPDATER_DISABLE=1");
});

linuxTest("--rpm renders an nfpm config and invokes the nfpm binary (stubbed)", () => {
  const argvLog = join(workDir, "nfpm-argv.txt");
  const nfpmStub = makeStub(
    "stub-nfpm",
    `printf '%s\\n' "$@" > "${argvLog}"\n` +
      `prev=""\nfor a in "$@"; do\n  if [ "$prev" = "-t" ] || [ "$prev" = "--target" ]; then printf 'RPM' > "$a"; fi\n  prev="$a"\ndone`,
  );
  const r = runInstaller(["--skip-appimage", "--skip-sandbox-helper", "--rpm", "--nfpm", nfpmStub]);
  expect(r.status).toBe(0);
  const rpmPath = join(outDir, "nimbus-headless-0.1.0-rc1-x86_64.rpm");
  expect(existsSync(rpmPath)).toBe(true);
  expect(readFileSync(rpmPath).subarray(0, 3).toString()).toBe("RPM");
  const argv = readFileSync(argvLog, "utf8");
  expect(argv).toContain("rpm");
});

linuxTest("rpm wrappers stamp the yum channel + disable the self-updater", () => {
  const wrapperOut = join(workDir, "captured-nimbus-wrapper");
  // The stub runs while buildRpm's temp stage still exists; copy the staged
  // wrapper out (config lives at <stage>/nfpm.yaml, wrappers at <stage>/wrappers/)
  // because buildRpm rmSync's the stage on success before the test could read it.
  const nfpmStub = makeStub(
    "cfg-recording-nfpm",
    `prev=""\nfor a in "$@"; do\n` +
      `  if [ "$prev" = "-f" ] || [ "$prev" = "--config" ]; then cp "$(dirname "$a")/wrappers/nimbus" "${wrapperOut}"; fi\n` +
      `  if [ "$prev" = "-t" ] || [ "$prev" = "--target" ]; then printf 'RPM' > "$a"; fi\n` +
      `  prev="$a"\ndone`,
  );
  const r = runInstaller(["--skip-appimage", "--skip-sandbox-helper", "--rpm", "--nfpm", nfpmStub]);
  expect(r.status).toBe(0);
  const wrapper = readFileSync(wrapperOut, "utf8");
  expect(wrapper).toContain("NIMBUS_DISTRIBUTION_CHANNEL=yum");
  expect(wrapper).toContain("NIMBUS_UPDATER_DISABLE=1");
});
