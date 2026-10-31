import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const linuxTest = process.platform === "linux" ? test : test.skip;

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;
let bundleDir: string;
let outDir: string;
let stubToolPath: string;
let stubHelperPath: string;

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

function makeStub(name: string, body: string): string {
  const p = join(workDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\nset -e\n${body}\n`, "utf8");
  chmodSync(p, 0o755);
  return p;
}

const HELPER_FILE = "nimbus-sandbox-helper";

function runInstaller(extraArgs: string[]) {
  return runInstallerRaw(["--sandbox-helper", stubHelperPath, ...extraArgs]);
}

function runInstallerRaw(extraArgs: string[]) {
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
  // Mode 644 on purpose: every layout must set 755 itself, not inherit it from the source.
  stubHelperPath = join(workDir, "stub-helper");
  writeFileSync(stubHelperPath, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(stubHelperPath, 0o644);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

linuxTest("produces .deb with expected name", () => {
  const r = runInstaller(["--skip-appimage"]);
  expect(r.status).toBe(0);
  expect(existsSync(join(outDir, "nimbus-headless_0.1.0-rc1_amd64.deb"))).toBe(true);
});

linuxTest("produces tarball with expected name", () => {
  const r = runInstaller(["--skip-appimage"]);
  expect(r.status).toBe(0);
  expect(existsSync(join(outDir, "nimbus-headless-linux-amd64-v0.1.0-rc1.tar.gz"))).toBe(true);
});

linuxTest("produces .AppImage with stubbed appimagetool", () => {
  const r = runInstaller(["--appimagetool", stubToolPath]);
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

  const r = runInstaller(["--appimagetool", recordingStub]);
  expect(r.status).toBe(0);

  const listing = readFileSync(listingPath, "utf8");
  expect(listing).toContain("./AppRun");
  expect(listing).toContain("./nimbus-headless.desktop");
  expect(listing).toContain("./nimbus-headless.png");
  expect(listing).toContain("./usr/bin/nimbus");
  expect(listing).toContain("./usr/bin/nimbus-gateway");
  expect(listing).toContain("./usr/share/applications/nimbus-headless.desktop");
});

linuxTest("the AppDir names its build, so AppRun gives each build its own copy", () => {
  const idPath = join(workDir, "captured-build-id");
  const recordingStub = makeStub(
    "build-id-stub",
    `cp "$1/build-id" "${idPath}"\nprintf 'AITS' > "$2"`,
  );
  expect(runInstaller(["--appimagetool", recordingStub]).status).toBe(0);
  expect(readFileSync(idPath, "utf8")).toMatch(/^0\.1\.0-rc1-[0-9a-f]{16}$/);
});

describe("AppRun", () => {
  /** An AppDir whose `nimbus` prints where it runs from and its arguments. */
  function makeAppDir(): { appRun: string; bin: string; cache: string } {
    const appDir = join(workDir, "AppDir");
    const bin = join(appDir, "usr", "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["nimbus", "nimbus-gateway", "nimbus-sandbox-helper"]) {
      writeFileSync(join(bin, name), '#!/bin/sh\necho "$0 $*"\n', "utf8");
      chmodSync(join(bin, name), 0o755);
    }
    writeFileSync(join(bin, "vec0.so"), "so", "utf8");
    writeFileSync(join(appDir, "build-id"), "1.2.3-abc", "utf8");
    const appRun = join(appDir, "AppRun");
    copyFileSync(join(REPO_ROOT, "scripts", "linux", "nimbus-headless.AppRun"), appRun);
    chmodSync(appRun, 0o755);
    return { appRun, bin, cache: join(workDir, "cache") };
  }

  const run = (appRun: string, cache: string, ...args: string[]) =>
    spawnSync(appRun, args, {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "", XDG_CACHE_HOME: cache },
      windowsHide: true,
    });

  linuxTest("runs the CLI from a per-build copy that holds everything beside it", () => {
    const { appRun, cache } = makeAppDir();
    const copy = join(cache, "nimbus", "appimage", "1.2.3-abc");
    const r = run(appRun, cache, "start", "--x");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`${join(copy, "nimbus")} start --x`);
    expect(r.stderr).toBe("");
    expect(readdirSync(copy).sort()).toEqual([
      "nimbus",
      "nimbus-gateway",
      "nimbus-sandbox-helper",
      "vec0.so",
    ]);
    expect(statSync(join(copy, "nimbus-sandbox-helper")).mode & 0o777).toBe(0o755);
    // No stage directory is left beside it.
    expect(readdirSync(join(cache, "nimbus", "appimage"))).toEqual(["1.2.3-abc"]);
  });

  linuxTest("copies once, so a second run uses the first copy", () => {
    const { appRun, bin, cache } = makeAppDir();
    run(appRun, cache);
    writeFileSync(join(bin, "nimbus"), "#!/bin/sh\necho changed\n", "utf8");
    const again = run(appRun, cache, "status");
    expect(again.stdout).not.toContain("changed");
    expect(again.stdout).toContain("status");
  });

  linuxTest("a copy that cannot be made says so, and still runs from the AppImage", () => {
    const { appRun, bin } = makeAppDir();
    const notADirectory = join(workDir, "a-file");
    writeFileSync(notADirectory, "", "utf8");
    const r = run(appRun, notADirectory, "--version");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`${join(bin, "nimbus")} --version`);
    expect(r.stderr).toContain("a gateway started here stops when this command ends");
  });
});

linuxTest("substitutes {{VERSION}} placeholder in desktop entry", () => {
  const desktopOut = join(workDir, "captured.desktop");
  const recordingStub = makeStub(
    "desktop-recording-stub",
    `APPDIR="$1"\ncp "$APPDIR/nimbus-headless.desktop" "${desktopOut}"\nprintf 'AITS' > "$2"`,
  );

  runInstaller(["--appimagetool", recordingStub]);

  const desktop = readFileSync(desktopOut, "utf8");
  expect(desktop).toContain("X-AppImage-Version=0.1.0-rc1");
  expect(desktop).not.toContain("{{VERSION}}");
});

linuxTest("tarball contains install.sh and uninstall.sh", () => {
  const r = runInstaller(["--skip-appimage"]);
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
  const r = runInstaller(["--appimagetool", stubToolPath]);
  expect(r.status).toBe(0);
  expect(existsSync(join(outDir, "install.sh"))).toBe(true);
  expect(existsSync(join(outDir, "uninstall.sh"))).toBe(true);
});

linuxTest(".deb DEBIAN/control depends on bubblewrap, and on no libcap", () => {
  const r = runInstaller(["--skip-appimage"]);
  expect(r.status).toBe(0);
  const debPath = join(outDir, "nimbus-headless_0.1.0-rc1_amd64.deb");
  expect(existsSync(debPath)).toBe(true);
  const info = spawnSync("/usr/bin/dpkg-deb", ["-I", debPath], { encoding: "utf8" });
  expect(info.status).toBe(0);
  expect(info.stdout).toMatch(/Depends:\s*bubblewrap\n/);
  expect(info.stdout).not.toContain("libcap");
  expect(info.stdout).not.toContain("cap_net_admin");
});

linuxTest(".deb ships the helper at mode 755, and no script of it sets a capability", () => {
  const r = runInstaller(["--skip-appimage"]);
  expect(r.status).toBe(0);
  const debPath = join(outDir, "nimbus-headless_0.1.0-rc1_amd64.deb");
  const ctrlDir = join(workDir, "deb-ctrl");
  mkdirSync(ctrlDir, { recursive: true });
  const extract = spawnSync("/usr/bin/dpkg-deb", ["-e", debPath, ctrlDir], { encoding: "utf8" });
  expect(extract.status).toBe(0);
  for (const script of ["postinst", "postrm"]) {
    expect(readFileSync(join(ctrlDir, script), "utf8")).not.toContain("setcap");
  }
  const contents = spawnSync("/usr/bin/dpkg-deb", ["-c", debPath], { encoding: "utf8" });
  expect(contents.status).toBe(0);
  expect(contents.stdout).toMatch(
    /-rwxr-xr-x \S+ +\d+ .*\.\/usr\/lib\/nimbus\/bin\/nimbus-sandbox-helper\n/,
  );
});

linuxTest("tarball linux-postinstall.sh prints bwrap pre-check banner", () => {
  const r = runInstaller(["--skip-appimage"]);
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

linuxTest(
  ".deb installs the bubblewrap AppArmor profile, and removes it only on remove or purge",
  () => {
    const r = runInstaller(["--skip-appimage"]);
    expect(r.status).toBe(0);
    const ctrlDir = join(workDir, "deb-ctrl");
    mkdirSync(ctrlDir, { recursive: true });
    const debPath = join(outDir, "nimbus-headless_0.1.0-rc1_amd64.deb");
    const extract = spawnSync("/usr/bin/dpkg-deb", ["-e", debPath, ctrlDir], { encoding: "utf8" });
    expect(extract.status).toBe(0);
    const postinst = readFileSync(join(ctrlDir, "postinst"), "utf8");
    expect(postinst).toContain("apparmor_parser -r /etc/apparmor.d/nimbus-bwrap");
    // Printed on an upgrade only, and as an instruction: dpkg does not restart a gateway.
    expect(postinst).toContain('= "configure" ] && [ -n "$');
    expect(postinst).toContain("restart it: nimbus stop, then nimbus start");
    expect(postinst).not.toContain("sudo apparmor_parser");
    const postrm = readFileSync(join(ctrlDir, "postrm"), "utf8");
    expect(postrm).toContain("remove|purge)");
    expect(postrm).toContain("apparmor_parser -R /etc/apparmor.d/nimbus-bwrap");
    for (const script of [postinst, postrm]) {
      const syntax = spawnSync("/bin/sh", ["-n"], { input: script, encoding: "utf8" });
      expect(syntax.status).toBe(0);
    }
  },
);

linuxTest(
  "tarball linux-postinstall.sh installs the bubblewrap AppArmor profile through sudo",
  () => {
    const r = runInstaller(["--skip-appimage"]);
    expect(r.status).toBe(0);
    const extractDir = join(workDir, "tar-extract");
    mkdirSync(extractDir, { recursive: true });
    const tarballPath = join(outDir, "nimbus-headless-linux-amd64-v0.1.0-rc1.tar.gz");
    const x = spawnSync("/usr/bin/tar", ["-xzf", tarballPath, "-C", extractDir], {
      encoding: "utf8",
    });
    expect(x.status).toBe(0);
    const postScript = readFileSync(join(extractDir, "linux-postinstall.sh"), "utf8");
    expect(postScript).toContain("sudo apparmor_parser -r /etc/apparmor.d/nimbus-bwrap");
    const syntax = spawnSync("/bin/sh", ["-n", join(extractDir, "linux-postinstall.sh")], {
      encoding: "utf8",
    });
    expect(syntax.status).toBe(0);
  },
);

linuxTest("tarball ships the helper at mode 755, and its post-install sets no capability", () => {
  const r = runInstaller(["--skip-appimage"]);
  expect(r.status).toBe(0);
  const tarballPath = join(outDir, "nimbus-headless-linux-amd64-v0.1.0-rc1.tar.gz");
  const tarList = spawnSync("/usr/bin/tar", ["-tvzf", tarballPath], { encoding: "utf8" });
  expect(tarList.status).toBe(0);
  expect(tarList.stdout).toMatch(/-rwxr-xr-x .* bin\/nimbus-sandbox-helper\n/);
  const extractDir = join(workDir, "tar-extract");
  mkdirSync(extractDir, { recursive: true });
  const x = spawnSync("/usr/bin/tar", ["-xzf", tarballPath, "-C", extractDir], {
    encoding: "utf8",
  });
  expect(x.status).toBe(0);
  const postScript = readFileSync(join(extractDir, "linux-postinstall.sh"), "utf8");
  expect(postScript).not.toContain("setcap");
  expect(postScript).not.toContain("libcap");
  // The AppArmor block stays: without it nothing sandboxed starts on current Ubuntu.
  expect(postScript).toContain("apparmor_parser -r");
  const readme = readFileSync(join(extractDir, "README.txt"), "utf8");
  expect(readme).not.toContain("setcap");
  expect(readme).not.toContain("cap_net_admin");
});

linuxTest(
  "install.sh puts the tarball's helper beside the gateway, and uninstall.sh removes it",
  () => {
    const r = runInstaller(["--skip-appimage"]);
    expect(r.status).toBe(0);
    const extractDir = join(workDir, "tar-extract");
    mkdirSync(extractDir, { recursive: true });
    const tarballPath = join(outDir, "nimbus-headless-linux-amd64-v0.1.0-rc1.tar.gz");
    expect(spawnSync("/usr/bin/tar", ["-xzf", tarballPath, "-C", extractDir]).status).toBe(0);
    const home = join(workDir, "home");
    mkdirSync(home);
    const env = { PATH: "/usr/bin:/bin", HOME: home };
    const installed = spawnSync("/bin/sh", [join(extractDir, "install.sh"), "--yes"], {
      env,
      encoding: "utf8",
    });
    expect(installed.status).toBe(0);
    const helper = join(home, ".local", "bin", HELPER_FILE);
    expect(statSync(helper).mode & 0o7777).toBe(0o755);
    expect(existsSync(join(home, ".local", "bin", "nimbus-gateway"))).toBe(true);
    const removed = spawnSync("/bin/sh", [join(extractDir, "uninstall.sh"), "--yes"], {
      env,
      encoding: "utf8",
    });
    expect(removed.status).toBe(0);
    expect(existsSync(helper)).toBe(false);
  },
);

linuxTest("AppImage carries the helper beside the gateway at mode 755", () => {
  const listingPath = join(workDir, "appdir-modes.txt");
  const recordingStub = makeStub(
    "mode-recording-stub",
    `APPDIR="$1"\n(cd "$APPDIR" && find usr/bin -type f -printf '%m %p\\n' | sort -k2) > "${listingPath}"\nprintf 'AITS' > "$2"`,
  );
  const r = runInstaller(["--appimagetool", recordingStub]);
  expect(r.status).toBe(0);
  const listing = readFileSync(listingPath, "utf8");
  expect(listing).toContain("755 usr/bin/nimbus-gateway");
  expect(listing).toContain("755 usr/bin/nimbus-sandbox-helper");
});

linuxTest(".rpm ships the helper at mode 755, with no install script and no libcap", () => {
  const capture = join(workDir, "captured-nfpm.yaml");
  const modeCapture = join(workDir, "captured-helper-mode");
  const nfpmStub = makeStub(
    "helper-recording-nfpm",
    `prev=""\nfor a in "$@"; do\n` +
      `  if [ "$prev" = "-f" ]; then cp "$a" "${capture}"; stat -c %a "$(dirname "$a")/bin/${HELPER_FILE}" > "${modeCapture}"; fi\n` +
      `  if [ "$prev" = "-t" ]; then printf 'RPM' > "$a"; fi\n` +
      `  prev="$a"\ndone`,
  );
  const r = runInstaller(["--skip-appimage", "--rpm", "--nfpm", nfpmStub]);
  expect(r.status).toBe(0);
  const cfg = readFileSync(capture, "utf8");
  expect(cfg).toContain("dst: /usr/lib/nimbus/bin/nimbus-sandbox-helper");
  expect(cfg).not.toContain("libcap");
  expect(cfg).not.toContain("postinstall");
  expect(readFileSync(modeCapture, "utf8").trim()).toBe("755");
});

linuxTest("a helper the bundle carries is used, with nothing built", () => {
  writeFileSync(join(bundleDir, HELPER_FILE), "#!/bin/sh\necho bundled\n", "utf8");
  const failingMake = makeStub("make-must-not-run", "exit 1");
  const r = runInstallerRaw(["--skip-appimage", "--make", failingMake]);
  expect(r.status).toBe(0);
});

linuxTest("a build with no helper fails: make fails, and nothing is packaged", () => {
  const failingMake = makeStub("failing-make", "exit 1");
  const r = runInstallerRaw(["--skip-appimage", "--make", failingMake]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("could not build nimbus-sandbox-helper");
  expect(existsSync(join(outDir, "nimbus-headless_0.1.0-rc1_amd64.deb"))).toBe(false);
});

test("a build with no helper fails: --sandbox-helper naming nothing", () => {
  const r = runInstallerRaw(["--skip-appimage", "--sandbox-helper", join(workDir, "no-such")]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("--sandbox-helper not found");
});

test("the packager has no way left to skip the helper", () => {
  const source = readFileSync(join(REPO_ROOT, "scripts", "package-linux-installers.ts"), "utf8");
  expect(source).not.toContain("skip-sandbox-helper");
  expect(source).not.toContain("setcap");
  expect(source).not.toContain("libcap");
  expect(source).not.toContain("cap_net_admin");
});

linuxTest(".deb wrappers stamp the apt channel + disable the self-updater", () => {
  const r = runInstaller(["--skip-appimage"]);
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
  const r = runInstaller(["--skip-appimage", "--rpm", "--nfpm", nfpmStub]);
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
  const r = runInstaller(["--skip-appimage", "--rpm", "--nfpm", nfpmStub]);
  expect(r.status).toBe(0);
  const wrapper = readFileSync(wrapperOut, "utf8");
  expect(wrapper).toContain("NIMBUS_DISTRIBUTION_CHANNEL=yum");
  expect(wrapper).toContain("NIMBUS_UPDATER_DISABLE=1");
});

// Every package ships the helper, since a package without one hands a connector that declares a
// network the whole internet. The packager refuses a build with no helper, so a call only has to
// stay free of the old flag, which no longer exists.
test("every workflow call to the Linux packager ships the helper", () => {
  const dir = join(REPO_ROOT, ".github", "workflows");
  const calls: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
    const text = readFileSync(join(dir, name), "utf8");
    expect(text).not.toContain("--skip-sandbox-helper");
    // A trailing backslash continues the command onto the next line.
    const joined = text.replace(/\\\r?\n/g, " ");
    for (const line of joined.split(/\r?\n/)) {
      // A call is a `bun` command line: a path filter, a comment or a grep pattern is not one.
      if (!/^\s*bun\s.*(package-linux-installers\.ts|package:installers:linux)/.test(line))
        continue;
      calls.push(`${name}: ${line.trim()}`);
      // What the call is allowed to do about the helper. It may not name a helper of its own (that
      // flag is for tests, which pass a stub) or a `make` of its own, so what ships is what the
      // packager builds or the bundle carries. A call that names a bundle must be in a workflow
      // that puts the helper into that very bundle.
      expect(line).not.toMatch(/--sandbox-helper|--make\s/);
      const bundle = /--bundle\s+(\S+)/.exec(line)?.[1];
      if (bundle !== undefined) {
        expect(text).toContain(`${bundle}/nimbus-sandbox-helper`);
      }
    }
  }
  // At least the release and CI calls, so a rename of the call cannot make this pass vacuously.
  expect(calls.length).toBeGreaterThanOrEqual(2);
});

test("the release job builds the helper with make and checks that it is static", () => {
  const release = readFileSync(join(REPO_ROOT, ".github", "workflows", "release.yml"), "utf8");
  expect(release).toContain("make -C packages/gateway/src-native/sandbox-helper");
  // Captured, then matched with a here-string: a pipe into `grep -q` dies of SIGPIPE under pipefail.
  expect(release).toContain('helper_kind="$(file "$HELPER")"');
  expect(release).toContain("grep -q 'statically linked' <<< \"$helper_kind\"");
  expect(release).not.toContain('file "$HELPER" | grep');
  expect(release).toContain('cp "$HELPER" dist/headless-bundle/nimbus-sandbox-helper');
});

// `lister | grep -q` under `bash -eo pipefail` dies of SIGPIPE when grep exits on its match while the
// lister is still writing. A package of this size fails every time (5 of 5 on the Packaging job).
test("no workflow pipes a package listing into grep", () => {
  const dir = join(REPO_ROOT, ".github", "workflows");
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
    const text = readFileSync(join(dir, name), "utf8");
    expect(text).not.toMatch(/(?:dpkg-deb\s+-c|rpm\s+-qlp?|tar\s+-t\S*)\s[^\n|]*\|\s*grep/);
  }
});
