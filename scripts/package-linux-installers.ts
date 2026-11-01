#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  bwrapApparmorInstallShell,
  bwrapApparmorRemoveShell,
} from "../packages/cli/src/commands/doctor-bwrap.ts";
import { renderRpmSpec } from "./release/rpm-spec.ts";

const repoRoot = resolve(import.meta.dir, "..");

const TAR_BIN = "/usr/bin/tar";
const DPKG_DEB_BIN = "/usr/bin/dpkg-deb";
const MAKE_BIN = "/usr/bin/make";

function parseArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1] !== undefined) {
    return process.argv[i + 1];
  }
  return undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function printUsage(): void {
  console.log(`Usage: bun scripts/package-linux-installers.ts [options]

Builds Linux release artifacts from a headless bundle directory:
  - nimbus-headless-linux-amd64-v<ver>.tar.gz
  - nimbus-headless_<ver>_amd64.deb
  - nimbus-headless-<ver>-x86_64.AppImage
  - nimbus-headless-<ver>-x86_64.rpm           (with --rpm)

Options:
  --bundle <dir>          Input: directory containing nimbus + nimbus-gateway
                          (default: dist/headless-bundle — emitted by
                          scripts/package-headless-bundle.ts)
  --out <dir>             Output directory (default: dist/installers; wiped
                          clean before writing)
  --version <ver>         Version string used in artifact names. Leading 'v'
                          stripped. (default: $NIMBUS_RELEASE_VERSION or 0.0.0)
  --appimagetool <path>   Path to an appimagetool binary. If omitted, falls
                          back to /usr/local/bin/appimagetool. Required when
                          --skip-appimage is not set.
  --skip-appimage         Produce only .deb + tarball. Useful for tests and
                          offline builds.
  --sandbox-helper <path> Use a pre-built nimbus-sandbox-helper binary instead
                          of compiling from packages/gateway/src-native/. Tests
                          pass a stub via this flag.
  --make <path>           Path to make (default: /usr/bin/make).
  --rpm                   Also build an .rpm via rpmbuild.
  --rpmbuild <path>       Path to the rpmbuild binary (default: rpmbuild on PATH).
  --help, -h              Show this message.

Prerequisites: /usr/bin/tar, /usr/bin/dpkg-deb, and (unless --skip-appimage)
an appimagetool binary. libfuse2 is required at runtime of appimagetool — on
Ubuntu 22.04 install via 'sudo apt install libfuse2'; on Ubuntu 24.04+ install
libfuse2t64 or pass --skip-appimage and build AppImage elsewhere.

Every package ships the sandbox helper, so a build with no helper fails. Unless
--sandbox-helper is passed, or the bundle carries one, the script runs
'make -C packages/gateway/src-native/sandbox-helper', which requires a C99
compiler and a static libc (libc6-dev on Debian and Ubuntu).
`);
}

if (hasFlag("--help") || hasFlag("-h")) {
  printUsage();
  process.exit(0);
}

const bundleDir = resolve(repoRoot, parseArg("--bundle") ?? join("dist", "headless-bundle"));
const version = (parseArg("--version") ?? process.env["NIMBUS_RELEASE_VERSION"] ?? "0.0.0").replace(
  /^v/,
  "",
);
const outRoot = resolve(repoRoot, parseArg("--out") ?? join("dist", "installers"));
const skipAppImage = hasFlag("--skip-appimage");
const appImageToolOverride = parseArg("--appimagetool");
const sandboxHelperOverride = parseArg("--sandbox-helper");
const makeBin = parseArg("--make") ?? MAKE_BIN;
const buildRpmFlag = hasFlag("--rpm");
const rpmbuildOverride = parseArg("--rpmbuild");

const gw = join(bundleDir, "nimbus-gateway");
const cli = join(bundleDir, "nimbus");

/**
 * The sqlite-vec loadable extension. `tryLoadFromSidecar()` resolves it from
 * `dirname(process.execPath)`, so every layout below has to place it beside `nimbus-gateway`.
 * Optional: a bundle built on a machine where `bun install` skipped the platform binary still
 * packages, it just ships without semantic memory.
 */
const vec0 = join(bundleDir, "vec0.so");
const hasVec0 = existsSync(vec0);

/** Copy the sidecar into a staged bin directory when the bundle carries one. */
function stageVec0(binDir: string): void {
  if (hasVec0) copyFileSync(vec0, join(binDir, "vec0.so"));
}

for (const [label, p] of [
  ["gateway", gw],
  ["cli", cli],
] as const) {
  if (!existsSync(p)) {
    console.error(
      `package-linux-installers: missing ${label} at ${p}\n` +
        `Run: (cd packages/gateway && bun build src/index.ts --compile --outfile ../../dist/nimbus-gateway --target bun)\n` +
        `      (cd packages/cli && bun build src/index.ts --compile --outfile ../../dist/nimbus --target bun)\n` +
        `      bun run package:headless`,
    );
    process.exit(1);
  }
}

if (existsSync(outRoot)) {
  rmSync(outRoot, { recursive: true, force: true });
}
mkdirSync(outRoot, { recursive: true });

/**
 * Resolve the Linux sandbox helper to bundle: an explicit `--sandbox-helper`, else one the bundle
 * carries, else one built from `src-native`. There is no way to build without it: a package with no
 * helper would hand every connector that declares a network the whole internet.
 */
function resolveSandboxHelper(): string {
  if (sandboxHelperOverride !== undefined) {
    const p = resolve(repoRoot, sandboxHelperOverride);
    if (!existsSync(p)) {
      console.error(`package-linux-installers: --sandbox-helper not found at ${p}`);
      process.exit(1);
    }
    return p;
  }
  const bundled = join(bundleDir, "nimbus-sandbox-helper");
  if (existsSync(bundled)) {
    return bundled;
  }
  const helperDir = join(repoRoot, "packages", "gateway", "src-native", "sandbox-helper");
  const built = join(helperDir, "nimbus-sandbox-helper");
  const make = spawnSync(makeBin, ["-C", helperDir], { stdio: "inherit", cwd: repoRoot });
  if (make.status !== 0 || !existsSync(built)) {
    console.error(
      `package-linux-installers: could not build nimbus-sandbox-helper with ${makeBin}.\n` +
        "  Every package ships it. Install a C99 compiler and a static libc (build-essential),\n" +
        "  or pass --sandbox-helper <path> with a pre-built binary.",
    );
    process.exit(1);
  }
  return built;
}

const sandboxHelper = resolveSandboxHelper();

/** Copy the helper into a staged bin directory. Mode 755, no file capability and no setuid bit. */
function stageSandboxHelper(binDir: string): void {
  const staged = join(binDir, "nimbus-sandbox-helper");
  copyFileSync(sandboxHelper, staged);
  chmodSync(staged, 0o755);
}

/**
 * Render the tarball's `linux-postinstall.sh`: a bubblewrap pre-check, and the AppArmor profile
 * bubblewrap needs on current Ubuntu.
 */
function linuxPostInstallScript(): string {
  return `#!/bin/sh
# Linux post-install for Nimbus tarball — bubblewrap pre-check + its AppArmor profile.
# Run after install.sh has copied binaries into ~/.local/bin/.
set -eu

if ! command -v bwrap >/dev/null 2>&1; then
    cat <<EOF
========================================================================
WARNING: Nimbus will not start without bubblewrap.
Install before running:
  Debian/Ubuntu: sudo apt install bubblewrap
  Fedora/RHEL:   sudo dnf install bubblewrap
  Arch:          sudo pacman -S bubblewrap
========================================================================
EOF
fi

${bwrapApparmorInstallShell(true)}
echo "Linux post-install checks complete."
`;
}

/**
 * Build the portable `.tar.gz`: binaries under `bin/` plus the README,
 * install/uninstall scripts, and the Linux post-install script.
 */
function buildTarball(): string {
  const tarStage = join(outRoot, "tar-stage");
  const tarBin = join(tarStage, "bin");
  mkdirSync(tarBin, { recursive: true });
  copyFileSync(gw, join(tarBin, "nimbus-gateway"));
  copyFileSync(cli, join(tarBin, "nimbus"));
  stageVec0(tarBin);
  chmodSync(join(tarBin, "nimbus-gateway"), 0o755);
  chmodSync(join(tarBin, "nimbus"), 0o755);
  stageSandboxHelper(tarBin);
  writeFileSync(
    join(tarStage, "README.txt"),
    `Nimbus headless bundle (Linux x64)

Runtime dependency: bubblewrap (sudo apt install bubblewrap / dnf install
bubblewrap / pacman -S bubblewrap). The Gateway refuses to spawn extensions
without it.

Run ./install.sh, or add the bin/ directory to PATH. Keep the files in bin/
together: the Gateway looks for nimbus-sandbox-helper beside itself, and without it
a connector that declares a network reaches the whole internet rather than only
the hosts it declared. "nimbus doctor" reports this.

On Ubuntu 23.10 and later, also run ./linux-postinstall.sh after install.sh. It
asks for sudo to install the AppArmor profile bubblewrap needs there; without it
nothing sandboxed can start. "nimbus doctor" reports this and prints the commands.
`,
    "utf8",
  );

  const installSrcDir = join(repoRoot, "scripts", "install", "unix");
  copyFileSync(join(installSrcDir, "install.sh"), join(tarStage, "install.sh"));
  copyFileSync(join(installSrcDir, "uninstall.sh"), join(tarStage, "uninstall.sh"));
  chmodSync(join(tarStage, "install.sh"), 0o755);
  chmodSync(join(tarStage, "uninstall.sh"), 0o755);

  writeFileSync(join(tarStage, "linux-postinstall.sh"), linuxPostInstallScript(), "utf8");
  chmodSync(join(tarStage, "linux-postinstall.sh"), 0o755);

  const tgzName = `nimbus-headless-linux-amd64-v${version}.tar.gz`;
  const tgzPath = join(outRoot, tgzName);
  const tar = spawnSync(
    TAR_BIN,
    [
      "-czf",
      tgzPath,
      "-C",
      tarStage,
      "bin",
      "README.txt",
      "install.sh",
      "uninstall.sh",
      "linux-postinstall.sh",
    ],
    {
      stdio: "inherit",
      cwd: repoRoot,
    },
  );
  if (tar.status !== 0) {
    process.exit(tar.status ?? 1);
  }
  rmSync(tarStage, { recursive: true, force: true });
  return tgzPath;
}

/**
 * Build the bespoke `.deb`: real binaries under `/usr/lib/nimbus/bin`,
 * apt-channel-stamped wrappers in `/usr/local/bin`, a postinst that installs the
 * AppArmor profile for bubblewrap, and a postrm that removes the profile.
 */
function buildDeb(): string {
  const debName = `nimbus-headless_${version}_amd64.deb`;
  const debRoot = join(outRoot, "deb-stage");
  const debInst = join(debRoot, "usr", "lib", "nimbus", "bin");
  const debBin = join(debRoot, "usr", "local", "bin");
  mkdirSync(debInst, { recursive: true });
  mkdirSync(debBin, { recursive: true });
  copyFileSync(gw, join(debInst, "nimbus-gateway"));
  copyFileSync(cli, join(debInst, "nimbus"));
  stageVec0(debInst);
  chmodSync(join(debInst, "nimbus-gateway"), 0o755);
  chmodSync(join(debInst, "nimbus"), 0o755);
  stageSandboxHelper(debInst);

  writeFileSync(join(debBin, "nimbus"), channelWrapper("apt", "nimbus"), "utf8");
  writeFileSync(join(debBin, "nimbus-gateway"), channelWrapper("apt", "nimbus-gateway"), "utf8");
  chmodSync(join(debBin, "nimbus"), 0o755);
  chmodSync(join(debBin, "nimbus-gateway"), 0o755);

  mkdirSync(join(debRoot, "DEBIAN"), { recursive: true });
  writeFileSync(
    join(debRoot, "DEBIAN", "control"),
    [
      "Package: nimbus-headless",
      `Version: ${version}`,
      "Section: utils",
      "Priority: optional",
      "Architecture: amd64",
      "Depends: bubblewrap",
      "Maintainer: Nimbus Contributors <https://github.com/nimbus-dev/Nimbus>",
      "Description: Nimbus CLI and headless Gateway (local-first agent framework)",
      " Installs nimbus and nimbus-gateway under /usr/lib/nimbus/bin with wrappers in /usr/local/bin.",
      " The sandbox helper holds no capability of its own; it runs inside bubblewrap's namespaces,",
      " so the Gateway can enforce per-host network filtering without running as root.",
      "",
    ].join("\n"),
    "utf8",
  );

  // $2 is the version being replaced, so this prints on an upgrade and not on a first install.
  const postinst = `#!/bin/sh
set -e
${bwrapApparmorInstallShell(false)}if [ "$1" = "configure" ] && [ -n "$2" ]; then
    echo "If a Nimbus gateway is running, restart it: nimbus stop, then nimbus start. Until then it keeps its old code and nimbus doctor reports its old sandbox posture."
fi
exit 0
`;
  writeFileSync(join(debRoot, "DEBIAN", "postinst"), postinst, "utf8");
  chmodSync(join(debRoot, "DEBIAN", "postinst"), 0o755);

  // Only on remove and purge: an upgrade also runs postrm, and must keep the profile.
  const postrm = `#!/bin/sh
set -e
case "$1" in
    remove|purge)
${bwrapApparmorRemoveShell(false)}        ;;
esac
exit 0
`;
  writeFileSync(join(debRoot, "DEBIAN", "postrm"), postrm, "utf8");
  chmodSync(join(debRoot, "DEBIAN", "postrm"), 0o755);

  const debPath = join(outRoot, debName);
  const dpkg = spawnSync(DPKG_DEB_BIN, ["--build", "--root-owner-group", debRoot, debPath], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  if (dpkg.status !== 0) {
    console.error("package-linux-installers: dpkg-deb failed (install dpkg-deb on Debian/Ubuntu)");
    process.exit(dpkg.status ?? 1);
  }
  rmSync(debRoot, { recursive: true, force: true });
  return debPath;
}

/**
 * Render a `/usr/local/bin` launcher that stamps the distribution channel and
 * disables the self-updater, then execs the real binary under `/usr/lib/nimbus/bin`.
 */
function channelWrapper(channel: string, target: string): string {
  return (
    "#!/bin/sh\n" +
    `export NIMBUS_DISTRIBUTION_CHANNEL=${channel}\n` +
    "export NIMBUS_UPDATER_DISABLE=1\n" +
    `exec /usr/lib/nimbus/bin/${target} "$@"\n`
  );
}

/**
 * Build the `.rpm` via rpmbuild: stage the binaries, helper, and yum-channel
 * wrappers into a temp dir, render the spec, and shell out to rpmbuild.
 * Cleans up the stage on both success and failure.
 */
function buildRpm(rpmbuildBin: string): string {
  const stage = join(outRoot, "rpm-stage");
  const rpmBinDir = join(stage, "bin");
  const wrapperDir = join(stage, "wrappers");
  mkdirSync(rpmBinDir, { recursive: true });
  mkdirSync(wrapperDir, { recursive: true });

  // Stage the binaries (and the helper, wherever it was resolved from) into one
  // dir so the spec's source paths always exist. sandboxHelper may come from
  // --sandbox-helper or the built src-native path, not necessarily bundleDir.
  copyFileSync(gw, join(rpmBinDir, "nimbus-gateway"));
  copyFileSync(cli, join(rpmBinDir, "nimbus"));
  stageVec0(rpmBinDir);
  stageSandboxHelper(rpmBinDir);
  writeFileSync(join(wrapperDir, "nimbus"), channelWrapper("yum", "nimbus"), "utf8");
  writeFileSync(
    join(wrapperDir, "nimbus-gateway"),
    channelWrapper("yum", "nimbus-gateway"),
    "utf8",
  );

  const spec = renderRpmSpec({ version, binDir: rpmBinDir, wrapperDir, hasVec0 });
  const specPath = join(stage, "nimbus-headless.spec");
  writeFileSync(specPath, spec, "utf8");

  const rpmName = `nimbus-headless-${version}-x86_64.rpm`;
  const rpmPath = join(outRoot, rpmName);
  const res = spawnSync(
    rpmbuildBin,
    [
      "-bb",
      "--quiet",
      "--target",
      "x86_64",
      "--define",
      `_topdir ${join(stage, "top")}`,
      "--define",
      `_rpmdir ${outRoot}`,
      "--define",
      `_rpmfilename ${rpmName}`,
      specPath,
    ],
    { stdio: "inherit", cwd: repoRoot },
  );
  if (res.status !== 0 || !existsSync(rpmPath)) {
    rmSync(stage, { recursive: true, force: true });
    if (res.status === null) {
      console.error(
        `package-linux-installers: could not spawn rpmbuild at '${rpmbuildBin}' — not found or not executable.\n` +
          "  Pass --rpmbuild <path>, or install it (sudo apt-get install rpm).",
      );
    } else {
      console.error(
        `package-linux-installers: rpmbuild failed (exit ${res.status}).\n` +
          "  Install rpm 4.14 or later (sudo apt-get install rpm), or pass --rpmbuild <path>.",
      );
    }
    // Not `??`: a build that exits 0 and writes no package is still a failure.
    process.exit(res.status || 1);
  }
  rmSync(stage, { recursive: true, force: true });
  return rpmPath;
}

/** The version, and a hash of the binaries in case two builds carry one version. */
function appImageBuildId(binDir: string): string {
  const hash = createHash("sha256");
  for (const name of ["nimbus", "nimbus-gateway", "nimbus-sandbox-helper"]) {
    hash.update(readFileSync(join(binDir, name)));
  }
  return `${version}-${hash.digest("hex").slice(0, 16)}`;
}

/**
 * Build the `.AppImage` from a staged AppDir (AppRun + desktop entry + icon +
 * binaries) using the provided appimagetool.
 */
function buildAppImage(toolPath: string): string {
  const appDirName = `nimbus-headless-${version}.AppDir`;
  const appDir = join(outRoot, appDirName);
  const usrBin = join(appDir, "usr", "bin");
  const usrShare = join(appDir, "usr", "share", "applications");

  mkdirSync(usrBin, { recursive: true });
  mkdirSync(usrShare, { recursive: true });

  copyFileSync(gw, join(usrBin, "nimbus-gateway"));
  copyFileSync(cli, join(usrBin, "nimbus"));
  stageVec0(usrBin);
  chmodSync(join(usrBin, "nimbus-gateway"), 0o755);
  chmodSync(join(usrBin, "nimbus"), 0o755);
  // Beside the gateway, which is where `resolveHelperPath` looks. The outer `bwrap` binds this one
  // file at a fixed path, so it does not matter that the AppImage's mount is not in the sandbox.
  stageSandboxHelper(usrBin);

  const appRunSrc = join(repoRoot, "scripts", "linux", "nimbus-headless.AppRun");
  const appRunDst = join(appDir, "AppRun");
  copyFileSync(appRunSrc, appRunDst);
  chmodSync(appRunDst, 0o755);
  // Names the directory AppRun copies these binaries into, so a different build gets its own copy.
  writeFileSync(join(appDir, "build-id"), appImageBuildId(usrBin), "utf8");

  const desktopSrc = join(repoRoot, "scripts", "linux", "nimbus-headless.desktop");
  const desktopContent = readFileSync(desktopSrc, "utf8").replaceAll("{{VERSION}}", version);
  const desktopDst = join(appDir, "nimbus-headless.desktop");
  writeFileSync(desktopDst, desktopContent, "utf8");
  writeFileSync(join(usrShare, "nimbus-headless.desktop"), desktopContent, "utf8");

  const iconSrc = join(repoRoot, "scripts", "linux", "nimbus-headless.png");
  copyFileSync(iconSrc, join(appDir, "nimbus-headless.png"));

  const appImageName = `nimbus-headless-${version}-x86_64.AppImage`;
  const appImagePath = join(outRoot, appImageName);

  const result = spawnSync(toolPath, [appDir, appImagePath], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  if (result.status !== 0) {
    console.error(
      `package-linux-installers: appimagetool failed (exit ${result.status ?? "null"})`,
    );
    process.exit(result.status ?? 1);
  }
  rmSync(appDir, { recursive: true, force: true });
  return appImagePath;
}

const tgzPath = buildTarball();
const debPath = buildDeb();
console.log(`Linux installers written to ${outRoot}`);
console.log(`  ${tgzPath}`);
console.log(`  ${debPath}`);

if (buildRpmFlag) {
  const rpmbuildBin = rpmbuildOverride ?? "rpmbuild";
  if (
    !rpmbuildOverride &&
    spawnSync(rpmbuildBin, ["--version"], { stdio: "ignore" }).status !== 0
  ) {
    console.error(
      "package-linux-installers: --rpm requested but `rpmbuild` not found on PATH.\n" +
        "  Pass --rpmbuild <path>, or install it (sudo apt-get install rpm).",
    );
    process.exit(1);
  }
  const rpmPath = buildRpm(rpmbuildBin);
  console.log(`  ${rpmPath}`);
}

if (!skipAppImage) {
  const toolPath = appImageToolOverride ?? "/usr/local/bin/appimagetool";
  if (!appImageToolOverride && !existsSync(toolPath)) {
    console.error(
      `package-linux-installers: appimagetool not found at ${toolPath}.\n` +
        `Pass --appimagetool <path> or --skip-appimage.\n` +
        `Download: https://appimage.github.io/appimagetool/`,
    );
    process.exit(1);
  }
  const appImagePath = buildAppImage(toolPath);
  console.log(`  ${appImagePath}`);

  const installSrcDir = join(repoRoot, "scripts", "install", "unix");
  const appImageInstall = join(outRoot, "install.sh");
  const appImageUninstall = join(outRoot, "uninstall.sh");
  copyFileSync(join(installSrcDir, "install.sh"), appImageInstall);
  copyFileSync(join(installSrcDir, "uninstall.sh"), appImageUninstall);
  chmodSync(appImageInstall, 0o755);
  chmodSync(appImageUninstall, 0o755);
  console.log(`  ${appImageInstall}`);
  console.log(`  ${appImageUninstall}`);
}
