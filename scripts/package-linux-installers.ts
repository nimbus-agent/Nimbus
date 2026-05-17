#!/usr/bin/env bun
/**
 * Build Linux release artifacts from the headless binary bundle:
 * - `nimbus-headless-linux-amd64-v<ver>.tar.gz`
 * - `nimbus-headless_<ver>_amd64.deb`
 * - `nimbus-headless-<ver>-x86_64.AppImage`
 *
 * Prerequisites: `tar`, `dpkg-deb`, `appimagetool` (or pass `--appimagetool <path>`
 * to use a pre-downloaded copy; tests use a stub). `libfuse2` must be installed at
 * runtime of `appimagetool`.
 *
 * The .deb declares `bubblewrap` as a hard runtime dep (T2 PR 1 sandbox); the
 * `nimbus-sandbox-helper` binary (compiled from packages/gateway/src-native/
 * sandbox-helper/) is installed at /usr/lib/nimbus/bin/ and granted
 * `cap_net_admin+ep` via the postinst script. The tarball bundles a separate
 * `linux-postinstall.sh` that prints a `bwrap` pre-check banner and runs
 * `setcap` on the helper after the user copies binaries into place.
 *
 * Usage:
 *   bun scripts/package-linux-installers.ts
 *   bun scripts/package-linux-installers.ts --bundle dist/headless-bundle --version 0.2.0
 *   bun scripts/package-linux-installers.ts --skip-appimage             # tests, offline builds
 *   bun scripts/package-linux-installers.ts --appimagetool /tmp/stub    # test injection
 *   bun scripts/package-linux-installers.ts --sandbox-helper /tmp/helper  # pre-built helper
 *   bun scripts/package-linux-installers.ts --skip-sandbox-helper       # CI without make/libcap
 */
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

const repoRoot = resolve(import.meta.dir, "..");

/** Absolute paths avoid PATH hijack (Sonar S4036); script targets Debian/Ubuntu packagers. */
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

const gw = join(bundleDir, "nimbus-gateway");
const cli = join(bundleDir, "nimbus");

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
 * Resolve the path to a `nimbus-sandbox-helper` binary for bundling.
 *
 * Resolution order:
 *   1. `--sandbox-helper <path>` (test injection, pre-built artifacts).
 *   2. `<bundleDir>/nimbus-sandbox-helper` (release pipelines that pre-stage
 *      it alongside the other compiled binaries).
 *   3. `packages/gateway/src-native/sandbox-helper/nimbus-sandbox-helper` if
 *      already built.
 *   4. `make -C packages/gateway/src-native/sandbox-helper` on the fly.
 *
 * Returns `null` if `--skip-sandbox-helper` is set, the make build fails, or
 * the helper cannot be found. The .deb still ships and declares the
 * `bubblewrap` dependency; only the setcap step + helper file are skipped.
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
 * Linux-specific post-install helper bundled alongside `install.sh` in the
 * tarball. Prints a `bwrap` pre-check banner (with per-distro install hints)
 * and applies `setcap cap_net_admin+ep` to the sandbox helper if it was
 * copied into `~/.local/bin/`. Kept separate from the cross-platform
 * `install.sh` to avoid coupling Linux sandbox concerns to the macOS path.
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

function buildTarball(): string {
  const tarStage = join(outRoot, "tar-stage");
  const tarBin = join(tarStage, "bin");
  mkdirSync(tarBin, { recursive: true });
  copyFileSync(gw, join(tarBin, "nimbus-gateway"));
  copyFileSync(cli, join(tarBin, "nimbus"));
  chmodSync(join(tarBin, "nimbus-gateway"), 0o755);
  chmodSync(join(tarBin, "nimbus"), 0o755);
  if (sandboxHelper !== null) {
    copyFileSync(sandboxHelper, join(tarBin, "nimbus-sandbox-helper"));
    chmodSync(join(tarBin, "nimbus-sandbox-helper"), 0o755);
  }
  const helperNote =
    sandboxHelper !== null
      ? `bin/nimbus-sandbox-helper is the privileged Linux sandbox helper. After
running install.sh, run ./linux-postinstall.sh — it will grant the helper
cap_net_admin+ep so the sandbox can enforce per-host network filtering
without running the Gateway as root. See
docs/release/headless-postinst-linux-setcap.md for details.

`
      : "";
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

  // Bundle install scripts at the top level of the tarball so users can run
  // ./install.sh immediately after extracting the archive.
  const installSrcDir = join(repoRoot, "scripts", "install", "unix");
  copyFileSync(join(installSrcDir, "install.sh"), join(tarStage, "install.sh"));
  copyFileSync(join(installSrcDir, "uninstall.sh"), join(tarStage, "uninstall.sh"));
  chmodSync(join(tarStage, "install.sh"), 0o755);
  chmodSync(join(tarStage, "uninstall.sh"), 0o755);

  // Linux-specific post-install (bwrap banner + helper setcap). Shipped as a
  // sibling to install.sh so the cross-platform installer stays untouched.
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

function buildDeb(): string {
  const debName = `nimbus-headless_${version}_amd64.deb`;
  const debRoot = join(outRoot, "deb-stage");
  const debInst = join(debRoot, "usr", "lib", "nimbus", "bin");
  const debBin = join(debRoot, "usr", "local", "bin");
  mkdirSync(debInst, { recursive: true });
  mkdirSync(debBin, { recursive: true });
  copyFileSync(gw, join(debInst, "nimbus-gateway"));
  copyFileSync(cli, join(debInst, "nimbus"));
  chmodSync(join(debInst, "nimbus-gateway"), 0o755);
  chmodSync(join(debInst, "nimbus"), 0o755);

  // Sandbox helper lives alongside the other gateway binaries. The postinst
  // script grants it cap_net_admin+ep so the Gateway can spawn it without
  // running as root (T2 PR 1 — invariant I15).
  if (sandboxHelper !== null) {
    copyFileSync(sandboxHelper, join(debInst, "nimbus-sandbox-helper"));
    chmodSync(join(debInst, "nimbus-sandbox-helper"), 0o755);
  }

  writeFileSync(
    join(debBin, "nimbus"),
    '#!/bin/sh\nexec /usr/lib/nimbus/bin/nimbus "$@"\n',
    "utf8",
  );
  writeFileSync(
    join(debBin, "nimbus-gateway"),
    '#!/bin/sh\nexec /usr/lib/nimbus/bin/nimbus-gateway "$@"\n',
    "utf8",
  );
  chmodSync(join(debBin, "nimbus"), 0o755);
  chmodSync(join(debBin, "nimbus-gateway"), 0o755);

  mkdirSync(join(debRoot, "DEBIAN"), { recursive: true });
  // `Depends: bubblewrap` is a hard runtime dep — the Linux SandboxRunner
  // refuses to spawn extensions without `bwrap` (T2 PR 1). `libcap2-bin`
  // provides `setcap`, used by the postinst below.
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

  // postinst: apply cap_net_admin+ep to the sandbox helper. Tolerates
  // unavailable setcap (rare on Debian/Ubuntu since libcap2-bin is in
  // Depends, but the warning makes the fallback path obvious).
  // See docs/release/headless-postinst-linux-setcap.md.
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

function buildAppImage(toolPath: string): string {
  const appDirName = `nimbus-headless-${version}.AppDir`;
  const appDir = join(outRoot, appDirName);
  const usrBin = join(appDir, "usr", "bin");
  const usrShare = join(appDir, "usr", "share", "applications");

  mkdirSync(usrBin, { recursive: true });
  mkdirSync(usrShare, { recursive: true });

  // Binaries
  copyFileSync(gw, join(usrBin, "nimbus-gateway"));
  copyFileSync(cli, join(usrBin, "nimbus"));
  chmodSync(join(usrBin, "nimbus-gateway"), 0o755);
  chmodSync(join(usrBin, "nimbus"), 0o755);

  // AppRun shim (must be at AppDir root, executable)
  const appRunSrc = join(repoRoot, "scripts", "linux", "nimbus-headless.AppRun");
  const appRunDst = join(appDir, "AppRun");
  copyFileSync(appRunSrc, appRunDst);
  chmodSync(appRunDst, 0o755);

  // Desktop entry with {{VERSION}} substituted
  const desktopSrc = join(repoRoot, "scripts", "linux", "nimbus-headless.desktop");
  const desktopContent = readFileSync(desktopSrc, "utf8").replaceAll("{{VERSION}}", version);
  const desktopDst = join(appDir, "nimbus-headless.desktop");
  writeFileSync(desktopDst, desktopContent, "utf8");
  // Copy to usr/share/applications as well (FreeDesktop convention)
  writeFileSync(join(usrShare, "nimbus-headless.desktop"), desktopContent, "utf8");

  // Icon (must be at AppDir root with same base name as desktop Icon= field)
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

  // Emit install scripts as siblings to the .AppImage so users who download
  // just the AppImage can run ./install.sh from the same directory.
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
