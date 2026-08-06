#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
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
import { renderNfpmConfig } from "./release/nfpm-config.ts";

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
  --skip-sandbox-helper   Skip bundling the sandbox helper. The .deb will still
                          declare bubblewrap as a dep, but the helper-setcap
                          step in postinst becomes a no-op and the sandbox
                          runs in fallback mode at runtime.
  --rpm                   Also build an .rpm via nfpm.
  --nfpm <path>           Path to the nfpm binary (default: nfpm on PATH).
  --help, -h              Show this message.

Prerequisites: /usr/bin/tar, /usr/bin/dpkg-deb, and (unless --skip-appimage)
an appimagetool binary. libfuse2 is required at runtime of appimagetool — on
Ubuntu 22.04 install via 'sudo apt install libfuse2'; on Ubuntu 24.04+ install
libfuse2t64 or pass --skip-appimage and build AppImage elsewhere.

For the sandbox helper: unless --sandbox-helper or --skip-sandbox-helper is
passed, the script attempts 'make -C packages/gateway/src-native/sandbox-helper'
which requires a C99 compiler and libcap-dev. See docs/release/headless-
postinst-linux-setcap.md for the runtime setcap flow.
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
const skipSandboxHelper = hasFlag("--skip-sandbox-helper");
const buildRpmFlag = hasFlag("--rpm");
const nfpmOverride = parseArg("--nfpm");

const gw = join(bundleDir, "nimbus-gateway");
const cli = join(bundleDir, "nimbus");

/**
 * The sqlite-vec loadable extension. `tryLoadFromSidecar()` resolves it from
 * `dirname(process.execPath)`, so every layout below has to place it beside `nimbus-gateway`.
 * Optional, like the sandbox helper: a bundle built on a machine where `bun install` skipped the
 * platform binary still packages, it just ships without semantic memory.
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
 * Resolve the privileged Linux sandbox helper to bundle: an explicit
 * `--sandbox-helper`/bundled binary if present, else one built from
 * `src-native`, else `null` (the sandbox then runs in fallback mode).
 */
function resolveSandboxHelper(): string | null {
  if (skipSandboxHelper) {
    return null;
  }
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
  if (existsSync(built)) {
    return built;
  }
  if (!existsSync(MAKE_BIN)) {
    console.warn(
      `package-linux-installers: ${MAKE_BIN} not available; skipping sandbox-helper bundling.\n` +
        `  Sandbox will run in fallback mode at runtime. Pass --sandbox-helper <path>\n` +
        `  with a pre-built binary or install build-essential + libcap-dev.`,
    );
    return null;
  }
  const make = spawnSync(MAKE_BIN, ["-C", helperDir], { stdio: "inherit", cwd: repoRoot });
  if (make.status !== 0 || !existsSync(built)) {
    console.warn(
      "package-linux-installers: make failed for nimbus-sandbox-helper; skipping bundling.\n" +
        "  Sandbox will run in fallback mode at runtime. Install libcap-dev and a C99\n" +
        "  compiler (build-essential) to enable per-host network filtering.",
    );
    return null;
  }
  return built;
}

const sandboxHelper = resolveSandboxHelper();

/**
 * Render the tarball's `linux-postinstall.sh`: a bubblewrap pre-check plus, when
 * the helper is bundled, the `setcap cap_net_admin+ep` grant for it.
 */
function linuxPostInstallScript(hasHelper: boolean): string {
  const helperBlock = hasHelper
    ? `HELPER="$HOME/.local/bin/nimbus-sandbox-helper"
if [ -x "$HELPER" ]; then
    if command -v setcap >/dev/null 2>&1; then
        if ! sudo setcap cap_net_admin+ep "$HELPER" 2>/dev/null; then
            echo "WARNING: setcap on $HELPER failed; sandbox will run in fallback mode."
            echo "Run manually: sudo setcap cap_net_admin+ep $HELPER"
        fi
    else
        echo "WARNING: setcap not found; install libcap2-bin (Debian/Ubuntu)"
        echo "         or libcap (Fedora/RHEL/Arch), then run:"
        echo "  sudo setcap cap_net_admin+ep $HELPER"
    fi
fi
`
    : `# Sandbox helper not bundled in this tarball — sandbox runs in fallback mode.
`;
  return `#!/bin/sh
# Linux post-install for Nimbus tarball — bubblewrap pre-check + helper setcap.
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

${helperBlock}
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
  if (sandboxHelper !== null) {
    copyFileSync(sandboxHelper, join(tarBin, "nimbus-sandbox-helper"));
    chmodSync(join(tarBin, "nimbus-sandbox-helper"), 0o755);
  }
  const helperNote =
    sandboxHelper === null
      ? ""
      : `bin/nimbus-sandbox-helper is the privileged Linux sandbox helper. After
running install.sh, run ./linux-postinstall.sh — it will grant the helper
cap_net_admin+ep so the sandbox can enforce per-host network filtering
without running the Gateway as root. See
docs/release/headless-postinst-linux-setcap.md for details.

`;
  writeFileSync(
    join(tarStage, "README.txt"),
    `Nimbus headless bundle (Linux x64)

Runtime dependency: bubblewrap (sudo apt install bubblewrap / dnf install
bubblewrap / pacman -S bubblewrap). The Gateway refuses to spawn extensions
without it.

Add the bin/ directory to PATH, or symlink bin/nimbus and bin/nimbus-gateway
into /usr/local/bin.

${helperNote}`,
    "utf8",
  );

  const installSrcDir = join(repoRoot, "scripts", "install", "unix");
  copyFileSync(join(installSrcDir, "install.sh"), join(tarStage, "install.sh"));
  copyFileSync(join(installSrcDir, "uninstall.sh"), join(tarStage, "uninstall.sh"));
  chmodSync(join(tarStage, "install.sh"), 0o755);
  chmodSync(join(tarStage, "uninstall.sh"), 0o755);

  writeFileSync(
    join(tarStage, "linux-postinstall.sh"),
    linuxPostInstallScript(sandboxHelper !== null),
    "utf8",
  );
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
 * apt-channel-stamped wrappers in `/usr/local/bin`, and a `setcap` postinst.
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

  if (sandboxHelper !== null) {
    copyFileSync(sandboxHelper, join(debInst, "nimbus-sandbox-helper"));
    chmodSync(join(debInst, "nimbus-sandbox-helper"), 0o755);
  }

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
      "Depends: bubblewrap, libcap2-bin",
      "Maintainer: Nimbus Contributors <https://github.com/nimbus-dev/Nimbus>",
      "Description: Nimbus CLI and headless Gateway (local-first agent framework)",
      " Installs nimbus and nimbus-gateway under /usr/lib/nimbus/bin with wrappers in /usr/local/bin.",
      " The sandbox helper is granted cap_net_admin+ep via setcap so the Gateway",
      " can enforce per-host network filtering without running as root.",
      "",
    ].join("\n"),
    "utf8",
  );

  const postinst = `#!/bin/sh
set -e
HELPER="/usr/lib/nimbus/bin/nimbus-sandbox-helper"
if [ -x "$HELPER" ]; then
    if command -v setcap >/dev/null 2>&1; then
        setcap cap_net_admin+ep "$HELPER" || {
            echo "WARNING: setcap on $HELPER failed; sandbox will run in fallback mode."
            echo "Run manually: sudo setcap cap_net_admin+ep $HELPER"
        }
    else
        echo "WARNING: setcap not found in PATH; install libcap2-bin and re-run:"
        echo "  sudo setcap cap_net_admin+ep $HELPER"
    fi
fi
exit 0
`;
  writeFileSync(join(debRoot, "DEBIAN", "postinst"), postinst, "utf8");
  chmodSync(join(debRoot, "DEBIAN", "postinst"), 0o755);

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
 * Build the `.rpm` via nfpm: stage the binaries, helper, and yum-channel
 * wrappers into a temp dir, render the nfpm config, and shell out to the
 * (pinned) nfpm binary. Cleans up the stage on both success and failure.
 */
function buildRpm(nfpmBin: string): string {
  const stage = join(outRoot, "rpm-stage");
  const rpmBinDir = join(stage, "bin");
  const wrapperDir = join(stage, "wrappers");
  mkdirSync(rpmBinDir, { recursive: true });
  mkdirSync(wrapperDir, { recursive: true });

  // Stage the binaries (and the helper, wherever it was resolved from) into one
  // dir so the nfpm `src:` paths always exist. sandboxHelper may come from
  // --sandbox-helper or the built src-native path, not necessarily bundleDir.
  copyFileSync(gw, join(rpmBinDir, "nimbus-gateway"));
  copyFileSync(cli, join(rpmBinDir, "nimbus"));
  stageVec0(rpmBinDir);
  if (sandboxHelper !== null) {
    copyFileSync(sandboxHelper, join(rpmBinDir, "nimbus-sandbox-helper"));
  }
  writeFileSync(join(wrapperDir, "nimbus"), channelWrapper("yum", "nimbus"), "utf8");
  writeFileSync(
    join(wrapperDir, "nimbus-gateway"),
    channelWrapper("yum", "nimbus-gateway"),
    "utf8",
  );

  if (sandboxHelper !== null) {
    writeFileSync(
      join(wrapperDir, "rpm-postinstall.sh"),
      `#!/bin/sh
set -e
HELPER="/usr/lib/nimbus/bin/nimbus-sandbox-helper"
if [ -x "$HELPER" ] && command -v setcap >/dev/null 2>&1; then
  setcap cap_net_admin+ep "$HELPER" || echo "WARNING: setcap failed; sandbox runs in fallback mode."
fi
exit 0
`,
      "utf8",
    );
  }

  const cfg = renderNfpmConfig({
    version,
    binDir: rpmBinDir,
    wrapperDir,
    hasSandboxHelper: sandboxHelper !== null,
  });
  const cfgPath = join(stage, "nfpm.yaml");
  writeFileSync(cfgPath, cfg, "utf8");

  const rpmName = `nimbus-headless-${version}-x86_64.rpm`;
  const rpmPath = join(outRoot, rpmName);
  const res = spawnSync(nfpmBin, ["package", "-f", cfgPath, "-p", "rpm", "-t", rpmPath], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  if (res.status !== 0 || !existsSync(rpmPath)) {
    rmSync(stage, { recursive: true, force: true });
    if (res.status === null) {
      console.error(
        `package-linux-installers: could not spawn nfpm at '${nfpmBin}' — not found or not executable.\n` +
          "  Pass --nfpm <path> to a valid nfpm binary or install a pinned one. See docs/install.md.",
      );
    } else {
      console.error(
        `package-linux-installers: nfpm failed (exit ${res.status}).\n` +
          "  Install a pinned nfpm binary or pass --nfpm <path>.",
      );
    }
    process.exit(res.status ?? 1);
  }
  rmSync(stage, { recursive: true, force: true });
  return rpmPath;
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

  const appRunSrc = join(repoRoot, "scripts", "linux", "nimbus-headless.AppRun");
  const appRunDst = join(appDir, "AppRun");
  copyFileSync(appRunSrc, appRunDst);
  chmodSync(appRunDst, 0o755);

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
  const nfpmBin = nfpmOverride ?? "nfpm";
  if (!nfpmOverride && spawnSync(nfpmBin, ["--version"], { stdio: "ignore" }).status !== 0) {
    console.error(
      "package-linux-installers: --rpm requested but `nfpm` not found on PATH.\n" +
        "  Pass --nfpm <path> or install a pinned nfpm binary. See docs/install.md.",
    );
    process.exit(1);
  }
  const rpmPath = buildRpm(nfpmBin);
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
