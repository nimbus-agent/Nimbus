# Installer Slice 2 — Native Installers (.msi/.pkg/.rpm) + Signing Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native double-click installers (`.msi`, `.pkg`, `.rpm`) to the Nimbus headless release pipeline plus a secret-gated, unsigned-ready code-signing seam, all flowing through `SHA256SUMS` and `nimbus-verify`.

**Architecture:** Pure-TS generators (nfpm config) are unit-tested following the existing `package-linux-installers.test.ts` pattern; native installer binaries (`.msi` via WiX v5, `.pkg` via pkgbuild/productbuild) cannot be built cross-platform so they get a smoke build in their native CI job. New `scripts/sign/` signers follow the exact `scripts/sign-linux-gpg.sh` convention (`secret present → sign, else warn + exit 0`). Managed installs disable the Slice-1 self-updater and stamp `NIMBUS_DISTRIBUTION_CHANNEL` using the env-in-launcher mechanism (`.deb`/`.rpm`/`.pkg` wrappers) or a resolver path heuristic (`.msi`) — no new gateway mechanism.

**Tech Stack:** Bun + TypeScript (generators, tests), WiX v5 (`wix` dotnet tool), `pkgbuild`/`productbuild` (macOS), `nfpm` (Linux `.rpm`), `signtool` (Windows), `codesign`/`notarytool` (macOS), GitHub Actions.

---

## Design Decisions (read before implementing — these resolve the spec's impl-level choices)

These are deliberate engineering calls made while grounding the plan in the codebase. If the reviewer disagrees with any, flag at plan-review before coding.

1. **`.deb` stays bespoke; nfpm adds `.rpm` alongside.** The spec (§5 Slice 2) permits "nfpm runs alongside (or replaces only the `.deb` internals if the swap is clean and tests stay green)." The existing `.deb` path is proven and covered by 4 assertions (name, `Depends`, postinst setcap, content paths). Replacing it risks those tests and the setcap/`/usr/local/bin`-wrapper behavior for zero user benefit. We keep `buildDeb()` and add `buildRpm()` via nfpm. The nfpm config is authored generically (it *could* emit `.deb` too), satisfying "one config."

2. **`.msi` PATH via WiX-native `<Environment>` element, not a CustomAction shelling to `install.ps1`.** The spec says "reuse the PATH logic in `scripts/install/windows/install.ps1` … the `.NET SetEnvironmentVariable` approach, never `setx`." Both `install.ps1`'s `[Environment]::SetEnvironmentVariable("PATH", …, "User")` and WiX's `<Environment Part="last" System="no">` write to the **same registry target** — `HKCU\Environment` — idempotently appended. Inside an MSI the declarative element is strictly better: it is transactional, removes the PATH entry on uninstall for free, and needs no PowerShell execution-policy/Constrained-Language-Mode handling. We reuse the *approach and registry target*, expressed natively. (A CustomAction running `install.ps1` would break MSI rollback and leak the PATH entry on uninstall — an anti-pattern.)

3. **Updater coexistence per new channel (spec §6.1) — mechanism per platform:**
   - `.deb` → `/usr/local/bin` wrappers already exist; bake `NIMBUS_DISTRIBUTION_CHANNEL=apt` + `NIMBUS_UPDATER_DISABLE=1` into them.
   - `.rpm` → nfpm installs identical wrappers; channel `yum`.
   - `.pkg` → ship `~/.local/bin` wrappers (channel `pkg` + updater-disable) that `exec` the real binaries from `~/.local/nimbus/bin` — `~/.local/bin` is shared with the manual `curl | install.sh` path, so a resolver *path* heuristic there would wrongly flag manual installs; an explicit wrapper is unambiguous.
   - `.msi` → resolver path heuristic: `%LOCALAPPDATA%\Programs\Nimbus` is installer-exclusive, so extend `fromPath()` to map it to `msi` (mirrors the existing Homebrew/Scoop heuristics). Avoids a fragile Windows `.cmd` wrapper (arg-escaping pitfalls).

   All four reuse the Slice-1 mechanism (`NIMBUS_UPDATER_DISABLE` env + `resolveDistributionChannel` + `channelUpgradeHint`). No gateway runtime change beyond one resolver heuristic.

4. **Signing seam ships unsigned-ready.** No certs exist yet. Every signer's secret-absent branch is the tested path (`warn + exit 0`); the signed branch runs only when cert secrets land, with zero pipeline reshape.

5. **Stable WiX GUIDs are minted once here and must never change.** `UpgradeCode` and the PATH-component `Guid` below are fixed constants; changing `UpgradeCode` breaks in-place upgrades.

---

## File Structure

**Create:**

- `scripts/release/nfpm-config.ts` — pure `renderNfpmConfig(inputs)` → nfpm YAML (unit-tested).
- `scripts/release/nfpm-config.test.ts` — unit tests for the generator.
- `scripts/windows/nimbus.wxs` — WiX v5 authoring (perUser, PATH env, ARP, MajorUpgrade).
- `scripts/package-windows-installer.ps1` — bootstrap-check + `wix build` driver.
- `scripts/package-macos-installer.sh` — pkgbuild/productbuild driver (user-scoped).
- `scripts/macos/distribution.xml` — productbuild distribution (enable_currentUserHome).
- `scripts/macos/uninstall-nimbus.sh` — shipped macOS uninstaller (reuses unix uninstall logic).
- `scripts/sign/sign-windows.ps1` — signtool seam (secret-gated).
- `scripts/sign/sign-macos.sh` — codesign + notarytool seam (secret-gated).
- `scripts/sign/sign-macos.test.ts` — unit-tests the no-secret skip path (Linux-runnable).
- `scripts/sign/README.md` — documents the seam convention + the existing `sign-linux-gpg.sh`/`sign-ed25519.ts` members.
- `docs/install.md` — channel matrix + per-platform one-liners.

**Modify:**

- `scripts/package-linux-installers.ts` — `--rpm`/`--nfpm` flags + `buildRpm()`; channel-marker env in `.deb` wrappers.
- `scripts/package-linux-installers.test.ts` — tests for `.deb` wrapper markers + `.rpm` config (via nfpm stub).
- `packages/sdk/src/distribution-channel.ts` — `fromPath()` detects the `.msi` install path → `msi`.
- `packages/sdk/src/distribution-channel.test.ts` — test for the msi path heuristic.
- `scripts/release/nimbus-verify.test.ts` — fixtures proving `.msi`/`.pkg`/`.rpm` names verify.
- `scripts/release/nimbus-verify-ps1.test.ts` — same for the PowerShell verifier.
- `.github/workflows/release.yml` — `build-msi` + `build-pkg` jobs; `.rpm` in the Linux step; stage new artifacts into `SHA256SUMS`.
- `scripts/install/README.md` — point package users at `docs/install.md`.

---

## Task 1: nfpm `.rpm` config generator (pure, unit-tested)

**Files:**

- Create: `scripts/release/nfpm-config.ts`
- Test: `scripts/release/nfpm-config.test.ts`

The pure generator renders the nfpm YAML config from `(version, paths)`. The actual `nfpm package` invocation lives in Task 2's script wiring; this task is the unit-testable render only, mirroring how `package-manager-manifests.ts` is a pure renderer.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/release/nfpm-config.test.ts
import { expect, test } from "bun:test";
import { renderNfpmConfig } from "./nfpm-config.ts";

const BASE = {
  version: "0.5.0",
  binDir: "/work/bundle",          // dir containing nimbus + nimbus-gateway (+ optional helper)
  wrapperDir: "/work/wrappers",    // dir containing the /usr/local/bin wrapper scripts
  hasSandboxHelper: true,
};

test("renders rpm package metadata", () => {
  const y = renderNfpmConfig(BASE);
  expect(y).toContain("name: nimbus-headless");
  expect(y).toContain("version: 0.5.0");
  expect(y).toContain("arch: amd64");
});

test("declares rpm runtime deps (bubblewrap + libcap, not the .deb's libcap2-bin)", () => {
  const y = renderNfpmConfig(BASE);
  // nfpm overrides.rpm.depends must use the RPM-distro package names.
  expect(y).toMatch(/overrides:\s*[\s\S]*rpm:[\s\S]*depends:[\s\S]*-\s*bubblewrap/);
  expect(y).toContain("- libcap");
});

test("maps binaries to /usr/lib/nimbus/bin and wrappers to /usr/local/bin", () => {
  const y = renderNfpmConfig(BASE);
  expect(y).toContain("dst: /usr/lib/nimbus/bin/nimbus");
  expect(y).toContain("dst: /usr/lib/nimbus/bin/nimbus-gateway");
  expect(y).toContain("dst: /usr/local/bin/nimbus");
  expect(y).toContain("dst: /usr/local/bin/nimbus-gateway");
});

test("includes the sandbox helper + a postinstall setcap scriptlet when present", () => {
  const y = renderNfpmConfig(BASE);
  expect(y).toContain("dst: /usr/lib/nimbus/bin/nimbus-sandbox-helper");
  expect(y).toContain("scripts:");
  expect(y).toContain("postinstall:");
});

test("omits the helper + postinstall when absent", () => {
  const y = renderNfpmConfig({ ...BASE, hasSandboxHelper: false });
  expect(y).not.toContain("nimbus-sandbox-helper");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/release/nfpm-config.test.ts`
Expected: FAIL — `renderNfpmConfig` not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/release/nfpm-config.ts
import { join } from "node:path";

export interface NfpmInputs {
  /** Semver without a leading "v". */
  version: string;
  /** Directory holding the staged `nimbus`, `nimbus-gateway` (+ optional `nimbus-sandbox-helper`). */
  binDir: string;
  /** Directory holding the generated `/usr/local/bin` wrapper scripts (`nimbus`, `nimbus-gateway`). */
  wrapperDir: string;
  hasSandboxHelper: boolean;
}

/**
 * Render an nfpm v2 config that packages the Nimbus headless bundle as an `.rpm`
 * (and could emit a `.deb` from the same config). Mirrors the bespoke `.deb`
 * layout in package-linux-installers.ts: real binaries under /usr/lib/nimbus/bin,
 * thin wrappers in /usr/local/bin, bubblewrap + setcap helper.
 *
 * Pure: paths are interpolated, no filesystem access. The caller writes the YAML
 * and invokes `nfpm package`.
 */
export function renderNfpmConfig(i: NfpmInputs): string {
  const contents: string[] = [
    `  - src: ${join(i.binDir, "nimbus-gateway")}`,
    `    dst: /usr/lib/nimbus/bin/nimbus-gateway`,
    `    file_info:\n      mode: 0755`,
    `  - src: ${join(i.binDir, "nimbus")}`,
    `    dst: /usr/lib/nimbus/bin/nimbus`,
    `    file_info:\n      mode: 0755`,
    `  - src: ${join(i.wrapperDir, "nimbus")}`,
    `    dst: /usr/local/bin/nimbus`,
    `    file_info:\n      mode: 0755`,
    `  - src: ${join(i.wrapperDir, "nimbus-gateway")}`,
    `    dst: /usr/local/bin/nimbus-gateway`,
    `    file_info:\n      mode: 0755`,
  ];
  if (i.hasSandboxHelper) {
    contents.push(
      `  - src: ${join(i.binDir, "nimbus-sandbox-helper")}`,
      `    dst: /usr/lib/nimbus/bin/nimbus-sandbox-helper`,
      `    file_info:\n      mode: 0755`,
    );
  }

  const scriptsBlock = i.hasSandboxHelper
    ? `scripts:\n  postinstall: ${join(i.wrapperDir, "rpm-postinstall.sh")}\n`
    : "";

  return `# Generated by scripts/release/nfpm-config.ts — do not edit by hand.
name: nimbus-headless
arch: amd64
version: ${i.version}
maintainer: Nimbus Contributors <https://github.com/nimbus-agent/Nimbus>
description: Nimbus CLI and headless Gateway (local-first agent framework)
homepage: https://github.com/nimbus-agent/Nimbus
license: AGPL-3.0-only
section: utils
priority: optional
overrides:
  rpm:
    depends:
      - bubblewrap
      - libcap
  deb:
    depends:
      - bubblewrap
      - libcap2-bin
${scriptsBlock}contents:
${contents.join("\n")}
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/release/nfpm-config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck` (or `bunx tsc -p tsconfig.json --noEmit` if faster locally)
Expected: no new errors. (No `/// <reference types="bun-types" />` in the new files — it breaks gateway/cli typecheck per repo gotcha; `import from "bun:test"` is sufficient.)

- [ ] **Step 6: Commit**

```bash
git add scripts/release/nfpm-config.ts scripts/release/nfpm-config.test.ts
git commit -m "feat(release): pure nfpm config generator for .rpm"
```

---

## Task 2: Wire `.rpm` build into package-linux-installers.ts + bake channel markers into wrappers

**Files:**

- Modify: `scripts/package-linux-installers.ts`
- Modify: `scripts/package-linux-installers.test.ts`

Adds `buildRpm()` (shells to `nfpm`, gated like appimagetool — skip/error with an actionable message when the binary is absent) and bakes `NIMBUS_DISTRIBUTION_CHANNEL` + `NIMBUS_UPDATER_DISABLE=1` into the existing `.deb` wrappers (channel `apt`) and the new `.rpm` wrappers (channel `yum`). The rpm wrappers + postinstall are staged to a temp `wrapperDir` that `renderNfpmConfig` references.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/package-linux-installers.test.ts`:

```ts
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
  // Stub nfpm: record argv + emit a placeholder .rpm so the script's existence
  // check passes without a real nfpm install.
  const argvLog = join(workDir, "nfpm-argv.txt");
  const nfpmStub = makeStub(
    "stub-nfpm",
    `printf '%s\\n' "$@" > "${argvLog}"\n` +
      // nfpm package -f <cfg> -p rpm -t <target>; emit the --target file.
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
  const cfgOut = join(workDir, "captured-nfpm.yaml");
  // Stub nfpm that copies the rendered config out for inspection (config path follows -f/--config).
  const nfpmStub = makeStub(
    "cfg-recording-nfpm",
    `prev=""\nfor a in "$@"; do\n` +
      `  if [ "$prev" = "-f" ] || [ "$prev" = "--config" ]; then cp "$a" "${cfgOut}"; fi\n` +
      `  if [ "$prev" = "-t" ] || [ "$prev" = "--target" ]; then printf 'RPM' > "$a"; fi\n` +
      `  prev="$a"\ndone`,
  );
  const r = runInstaller(["--skip-appimage", "--skip-sandbox-helper", "--rpm", "--nfpm", nfpmStub]);
  expect(r.status).toBe(0);
  const cfg = readFileSync(cfgOut, "utf8");
  expect(cfg).toContain("dst: /usr/local/bin/nimbus");
  // The wrapper file referenced by the config carries the channel marker.
  const wrapperSrc = cfg.match(/src:\s*(\S+)\s*\n\s*dst:\s*\/usr\/local\/bin\/nimbus\b/)?.[1];
  expect(wrapperSrc).toBeTruthy();
  const wrapper = readFileSync(wrapperSrc as string, "utf8");
  expect(wrapper).toContain("NIMBUS_DISTRIBUTION_CHANNEL=yum");
  expect(wrapper).toContain("NIMBUS_UPDATER_DISABLE=1");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/package-linux-installers.test.ts`
Expected: FAIL on the three new tests — current `.deb` wrappers lack the markers; `--rpm` flag unrecognized so no `.rpm` produced.

- [ ] **Step 3: Implement — channel-marked `.deb` wrappers**

In `scripts/package-linux-installers.ts`, replace the two `.deb` wrapper `writeFileSync` calls in `buildDeb()` with channel-marked launchers:

```ts
  writeFileSync(
    join(debBin, "nimbus"),
    "#!/bin/sh\n" +
      "export NIMBUS_DISTRIBUTION_CHANNEL=apt\n" +
      "export NIMBUS_UPDATER_DISABLE=1\n" +
      'exec /usr/lib/nimbus/bin/nimbus "$@"\n',
    "utf8",
  );
  writeFileSync(
    join(debBin, "nimbus-gateway"),
    "#!/bin/sh\n" +
      "export NIMBUS_DISTRIBUTION_CHANNEL=apt\n" +
      "export NIMBUS_UPDATER_DISABLE=1\n" +
      'exec /usr/lib/nimbus/bin/nimbus-gateway "$@"\n',
    "utf8",
  );
```

- [ ] **Step 4: Implement — `--rpm` / `--nfpm` flags + `buildRpm()`**

Add near the other flag parsing (after `skipSandboxHelper`):

```ts
const buildRpmFlag = hasFlag("--rpm");
const nfpmOverride = parseArg("--nfpm");
```

Add the import at the top:

```ts
import { renderNfpmConfig } from "./release/nfpm-config.ts";
```

Add `buildRpm()` (a sibling of `buildDeb()`). It stages channel-marked `yum` wrappers + an optional postinstall, renders the nfpm config, and shells to nfpm:

```ts
function rpmWrapper(target: string): string {
  return (
    "#!/bin/sh\n" +
    "export NIMBUS_DISTRIBUTION_CHANNEL=yum\n" +
    "export NIMBUS_UPDATER_DISABLE=1\n" +
    `exec /usr/lib/nimbus/bin/${target} "$@"\n`
  );
}

function buildRpm(nfpmBin: string): string {
  const stage = join(outRoot, "rpm-stage");
  const wrapperDir = join(stage, "wrappers");
  mkdirSync(wrapperDir, { recursive: true });
  writeFileSync(join(wrapperDir, "nimbus"), rpmWrapper("nimbus"), "utf8");
  writeFileSync(join(wrapperDir, "nimbus-gateway"), rpmWrapper("nimbus-gateway"), "utf8");

  if (sandboxHelper !== null) {
    // RPM distros ship setcap in `libcap`; mirror the .deb postinst behavior.
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
    binDir: bundleDir,
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
    console.error(
      `package-linux-installers: nfpm failed (exit ${res.status ?? "null"}).\n` +
        "  Install a pinned nfpm binary or pass --nfpm <path>.",
    );
    process.exit(res.status ?? 1);
  }
  rmSync(stage, { recursive: true, force: true });
  return rpmPath;
}
```

Wire the call after `buildDeb()` (near the bottom, before the AppImage block):

```ts
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
```

Also document the two new flags in `printUsage()` (`--rpm`, `--nfpm <path>`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test scripts/package-linux-installers.test.ts`
Expected: PASS — all prior `.deb`/tarball/AppImage tests stay green; the three new tests pass.

- [ ] **Step 6: Typecheck + commit**

```bash
bun run typecheck
git add scripts/package-linux-installers.ts scripts/package-linux-installers.test.ts
git commit -m "feat(release): build .rpm via nfpm + stamp apt/yum channel markers"
```

---

## Task 3: SDK resolver — detect the `.msi` install path

**Files:**

- Modify: `packages/sdk/src/distribution-channel.ts`
- Modify: `packages/sdk/src/distribution-channel.test.ts`

The `.msi` installs to `%LOCALAPPDATA%\Programs\Nimbus\bin` — installer-exclusive — so `fromPath()` maps it to the `msi` channel (so the self-updater steps aside and `nimbus update` prints the `.msi` hint). Mirrors the existing Homebrew/Scoop path heuristics.

- [ ] **Step 1: Write the failing test**

Append to `packages/sdk/src/distribution-channel.test.ts`:

```ts
test("resolves the Windows .msi install path to the msi channel", () => {
  const channel = resolveDistributionChannel({
    env: {},
    execPath: "C:\\Users\\me\\AppData\\Local\\Programs\\Nimbus\\bin\\nimbus.exe",
    realpath: (p) => p,
  });
  expect(channel).toBe("msi");
});

test("a plain Windows path is not mistaken for an msi install", () => {
  const channel = resolveDistributionChannel({
    env: {},
    execPath: "C:\\tools\\nimbus\\nimbus.exe",
    realpath: (p) => p,
  });
  expect(channel).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/sdk/src/distribution-channel.test.ts`
Expected: FAIL — first new test gets `null`.

- [ ] **Step 3: Implement**

In `packages/sdk/src/distribution-channel.ts`, add to `fromPath()` after the Scoop check (the path is already lowercased + forward-slashed):

```ts
  // MSI: per-user install into %LOCALAPPDATA%\Programs\Nimbus\bin (installer-exclusive).
  if (p.includes("/programs/nimbus/")) {
    return "msi";
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/sdk/src/distribution-channel.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add packages/sdk/src/distribution-channel.ts packages/sdk/src/distribution-channel.test.ts
git commit -m "feat(sdk): resolve the .msi install path to the msi channel"
```

---

## Task 4: `.msi` — WiX v5 authoring + build driver

**Files:**

- Create: `scripts/windows/nimbus.wxs`
- Create: `scripts/package-windows-installer.ps1`

Per-user (`Scope="perUser"`, UAC-free, `%LOCALAPPDATA%`), PATH via native `<Environment>`, ARP entry + `MajorUpgrade` with a fixed `UpgradeCode`. No cross-platform unit test is possible; the test is the native CI smoke build in Task 7's `build-msi` job. **Stable GUIDs below are minted once and must never change.**

- [ ] **Step 1: Create the WiX authoring**

```xml
<!-- scripts/windows/nimbus.wxs -->
<!-- WiX v5 (schema v4 namespace). Per-user, UAC-free install of the Nimbus -->
<!-- headless CLI + Gateway into %LOCALAPPDATA%\Programs\Nimbus\bin. -->
<!-- Build: wix build scripts/windows/nimbus.wxs -arch x64 -d Version=<x.y.z> -d BinDir=<staged> -o <out>.msi -->
<!-- STABLE GUIDs — never change UpgradeCode (breaks in-place upgrades). -->
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package
      Name="Nimbus"
      Manufacturer="Nimbus Contributors"
      Version="$(Version)"
      UpgradeCode="7E9F3C2A-1B4D-4E6F-9A8C-2D5E1F0B3C7A"
      Scope="perUser"
      Compressed="yes">

    <MajorUpgrade DowngradeErrorMessage="A newer version of Nimbus is already installed." />
    <MediaTemplate EmbedCab="yes" />

    <!-- ARP metadata (Add/Remove Programs). Uninstall is handled natively by the MSI. -->
    <Property Id="ARPURLINFOABOUT" Value="https://github.com/nimbus-agent/Nimbus" />
    <Property Id="ARPNOREPAIR" Value="1" />

    <StandardDirectory Id="LocalAppDataFolder">
      <Directory Id="ProgramsFolder" Name="Programs">
        <Directory Id="NimbusFolder" Name="Nimbus">
          <Directory Id="INSTALLFOLDER" Name="bin" />
        </Directory>
      </Directory>
    </StandardDirectory>

    <ComponentGroup Id="NimbusComponents" Directory="INSTALLFOLDER">
      <Component Id="NimbusCli" Bitness="always64">
        <File Id="NimbusExe" Source="$(BinDir)\nimbus.exe" KeyPath="yes" />
      </Component>
      <Component Id="NimbusGateway" Bitness="always64">
        <File Id="NimbusGatewayExe" Source="$(BinDir)\nimbus-gateway.exe" KeyPath="yes" />
      </Component>
      <!-- PATH append to HKCU\Environment (same target as install.ps1's -->
      <!-- [Environment]::SetEnvironmentVariable(..,"User")); removed on uninstall. -->
      <Component Id="NimbusPath" Guid="3F1A8C6B-9D2E-4A7F-8B5C-6E0D2A4F1C9B">
        <Environment Id="UpdatePath" Name="PATH" Value="[INSTALLFOLDER]"
                     Part="last" Action="set" Permanent="no" System="no" />
        <RegistryValue Root="HKCU" Key="Software\Nimbus" Name="installed"
                       Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </ComponentGroup>

    <Feature Id="Main" Title="Nimbus">
      <ComponentGroupRef Id="NimbusComponents" />
    </Feature>
  </Package>
</Wix>
```

- [ ] **Step 2: Create the build driver**

```powershell
#Requires -Version 7.0
<#
.SYNOPSIS
  Build the per-user Nimbus .msi with WiX v5. Run on a Windows runner.
.PARAMETER BinDir
  Directory containing nimbus.exe + nimbus-gateway.exe.
.PARAMETER Version
  Release version (tag with/without leading 'v'; prerelease suffix is stripped —
  MSI ProductVersion must be numeric x.y.z).
.PARAMETER Out
  Output .msi path.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BinDir,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = "Stop"

# Normalize to a 3-field numeric ProductVersion (strip leading v + any -prerelease).
$pv = ($Version -replace '^v', '') -replace '-.*$', ''
if ($pv -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid MSI version '$Version' -> '$pv' (need x.y.z)." }

foreach ($exe in @("nimbus.exe", "nimbus-gateway.exe")) {
  if (-not (Test-Path (Join-Path $BinDir $exe))) { throw "Missing $exe in $BinDir" }
}

# WiX v5 is bootstrapped by the CI job via `dotnet tool install --global wix`.
if (-not (Get-Command wix -ErrorAction SilentlyContinue)) {
  throw "wix not found on PATH. CI bootstraps it via 'dotnet tool install --global wix --version <pinned>'."
}

$wxs = Join-Path $PSScriptRoot "windows\nimbus.wxs"
New-Item -ItemType Directory -Path (Split-Path -Parent $Out) -Force | Out-Null

& wix build $wxs -arch x64 -d "Version=$pv" -d "BinDir=$BinDir" -o $Out
if ($LASTEXITCODE -ne 0) { throw "wix build failed ($LASTEXITCODE)." }
if (-not (Test-Path $Out)) { throw "wix reported success but $Out is missing." }

Write-Host "✓ Built $Out (ProductVersion $pv)"
```

- [ ] **Step 3: Lint the PowerShell (no execution — WiX absent locally)**

Run: `pwsh -NoProfile -Command "$null = [System.Management.Automation.Language.Parser]::ParseFile('scripts/package-windows-installer.ps1', [ref]$null, [ref]$null); 'parse ok'"`
Expected: `parse ok` (syntax valid). Full build is exercised by the `build-msi` CI job (Task 7).

- [ ] **Step 4: Commit**

```bash
git add scripts/windows/nimbus.wxs scripts/package-windows-installer.ps1
git commit -m "feat(release): per-user .msi via WiX v5 (PATH + ARP, UAC-free)"
```

---

## Task 5: `.pkg` — user-scoped macOS installer

**Files:**

- Create: `scripts/macos/distribution.xml`
- Create: `scripts/macos/uninstall-nimbus.sh`
- Create: `scripts/package-macos-installer.sh`

User-scoped, no sudo: `productbuild` with `enable_currentUserHome="true"` + a payload installed relative to `~` (`--install-location .local`). Real binaries land in `~/.local/nimbus/bin`; channel-marked `pkg` wrappers in `~/.local/bin` (`exec` the real binaries, set `NIMBUS_DISTRIBUTION_CHANNEL=pkg` + `NIMBUS_UPDATER_DISABLE=1`); a `postinstall` adds `~/.local/bin` to PATH via the same marker block as `install.sh`; a shipped `uninstall-nimbus` removes everything (macOS `.pkg` has no ARP). The test is the native CI smoke build in Task 7's `build-pkg` job.

- [ ] **Step 1: Create the productbuild distribution**

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- scripts/macos/distribution.xml -->
<!-- User-domain install: no admin prompt, payload relative to the user's home. -->
<installer-gui-script minSpecVersion="2">
  <title>Nimbus</title>
  <organization>dev.nimbus</organization>
  <!-- enable_currentUserHome makes install-location relative to ~ and runs scripts as the user. -->
  <domains enable_anywhere="false" enable_currentUserHome="true" enable_localSystem="false" />
  <options customize="never" require-scripts="false" hostArchitectures="x86_64,arm64" />
  <choices-outline>
    <line choice="default" />
  </choices-outline>
  <choice id="default">
    <pkg-ref id="dev.nimbus.headless" />
  </choice>
  <pkg-ref id="dev.nimbus.headless">nimbus-component.pkg</pkg-ref>
</installer-gui-script>
```

- [ ] **Step 2: Create the shipped uninstaller**

```sh
#!/bin/sh
# scripts/macos/uninstall-nimbus.sh — installed to ~/.local/bin/uninstall-nimbus.
# Removes Nimbus binaries, wrappers, PATH markers, and the pkg receipt. No sudo.
set -eu

INSTALL_DIR="${HOME}/.local/bin"
LIB_DIR="${HOME}/.local/nimbus"
BEGIN_MARKER="# >>> nimbus PATH >>>"
END_MARKER="# <<< nimbus PATH <<<"

rm -f "${INSTALL_DIR}/nimbus" "${INSTALL_DIR}/nimbus-gateway" "${INSTALL_DIR}/uninstall-nimbus"
rm -rf "${LIB_DIR}"

for rc in "${HOME}/.zshrc" "${HOME}/.bash_profile" "${HOME}/.bashrc" "${HOME}/.profile"; do
  [ -f "$rc" ] || continue
  if grep -qF "$BEGIN_MARKER" "$rc" 2>/dev/null && grep -qF "$END_MARKER" "$rc" 2>/dev/null; then
    awk -v b="$BEGIN_MARKER" -v e="$END_MARKER" '
      $0==b {skip=1; next}
      skip && $0==e {skip=0; next}
      !skip {print}
    ' "$rc" > "${rc}.tmp.nimbus" && mv "${rc}.tmp.nimbus" "$rc"
  fi
done

# Forget the pkg receipt (user domain) so a reinstall is clean.
pkgutil --forget dev.nimbus.headless >/dev/null 2>&1 || true

echo "✓ Nimbus uninstalled."
```

- [ ] **Step 3: Create the build driver**

```sh
#!/usr/bin/env bash
# scripts/package-macos-installer.sh — build a user-scoped Nimbus .pkg (no sudo).
# Usage: package-macos-installer.sh --bin-dir <dir> --version <v> --out <path.pkg>
set -euo pipefail

BIN_DIR="" VERSION="" OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) echo "Usage: $0 --bin-dir <dir> --version <v> --out <path.pkg>"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$BIN_DIR" ] && [ -n "$VERSION" ] && [ -n "$OUT" ] || { echo "missing required arg" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PV="$(printf '%s' "$VERSION" | sed -E 's/^v//; s/-.*$//')"
case "$PV" in *.*.*) ;; *) echo "invalid pkg version '$VERSION' -> '$PV'" >&2; exit 2 ;; esac

for b in nimbus nimbus-gateway; do
  [ -f "${BIN_DIR}/${b}" ] || { echo "missing ${b} in ${BIN_DIR}" >&2; exit 2; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ROOT="${WORK}/root"          # payload, installed relative to ~ (install-location .local)
SCRIPTS="${WORK}/scripts"
mkdir -p "${ROOT}/nimbus/bin" "${ROOT}/bin" "$SCRIPTS"

# Real binaries -> ~/.local/nimbus/bin
install -m 0755 "${BIN_DIR}/nimbus"         "${ROOT}/nimbus/bin/nimbus"
install -m 0755 "${BIN_DIR}/nimbus-gateway" "${ROOT}/nimbus/bin/nimbus-gateway"

# Channel-marked wrappers -> ~/.local/bin
for t in nimbus nimbus-gateway; do
  cat > "${ROOT}/bin/${t}" <<EOF
#!/bin/sh
export NIMBUS_DISTRIBUTION_CHANNEL=pkg
export NIMBUS_UPDATER_DISABLE=1
exec "\${HOME}/.local/nimbus/bin/${t}" "\$@"
EOF
  chmod 0755 "${ROOT}/bin/${t}"
done
install -m 0755 "${SCRIPT_DIR}/macos/uninstall-nimbus.sh" "${ROOT}/bin/uninstall-nimbus"

# postinstall: add ~/.local/bin to PATH using the same marker block as install.sh.
cat > "${SCRIPTS}/postinstall" <<'EOF'
#!/bin/sh
set -eu
INSTALL_DIR="${HOME}/.local/bin"
BEGIN_MARKER="# >>> nimbus PATH >>>"
END_MARKER="# <<< nimbus PATH <<<"
BLOCK="${BEGIN_MARKER}
export PATH=\"${INSTALL_DIR}:\$PATH\"
${END_MARKER}"
set --
[ -f "${HOME}/.zshrc" ] && set -- "$@" "${HOME}/.zshrc"
[ -f "${HOME}/.bash_profile" ] && set -- "$@" "${HOME}/.bash_profile"
[ -f "${HOME}/.bashrc" ] && set -- "$@" "${HOME}/.bashrc"
[ "$#" -eq 0 ] && set -- "${HOME}/.profile"
for rc in "$@"; do
  [ -f "$rc" ] || touch "$rc"
  if grep -qF "$BEGIN_MARKER" "$rc" 2>/dev/null && grep -qF "$END_MARKER" "$rc" 2>/dev/null; then
    awk -v b="$BEGIN_MARKER" -v e="$END_MARKER" '$0==b{skip=1;next} skip&&$0==e{skip=0;next} !skip{print}' "$rc" > "${rc}.tmp.nimbus" && mv "${rc}.tmp.nimbus" "$rc"
  fi
  printf "\n%s\n" "$BLOCK" >> "$rc"
done
exit 0
EOF
chmod 0755 "${SCRIPTS}/postinstall"

mkdir -p "$(dirname "$OUT")"
COMPONENT="${WORK}/nimbus-component.pkg"
pkgbuild --root "$ROOT" --install-location ".local" --scripts "$SCRIPTS" \
  --identifier "dev.nimbus.headless" --version "$PV" "$COMPONENT"

# productbuild expects the component pkg beside the distribution by reference name.
cp "$COMPONENT" "${WORK}/nimbus-component.pkg"
productbuild --distribution "${SCRIPT_DIR}/macos/distribution.xml" \
  --package-path "$WORK" "$OUT"

echo "✓ Built $OUT (version $PV)"
```

- [ ] **Step 4: Syntax-check the shell scripts**

Run: `bash -n scripts/package-macos-installer.sh && bash -n scripts/macos/uninstall-nimbus.sh && echo OK`
Expected: `OK`. Full build is exercised by the `build-pkg` CI job (Task 7).

- [ ] **Step 5: Commit**

```bash
git add scripts/macos/distribution.xml scripts/macos/uninstall-nimbus.sh scripts/package-macos-installer.sh
git commit -m "feat(release): user-scoped macOS .pkg (no sudo, ~/.local/bin)"
```

---

## Task 6: Signing seam — `scripts/sign/`

**Files:**

- Create: `scripts/sign/sign-windows.ps1`
- Create: `scripts/sign/sign-macos.sh`
- Create: `scripts/sign/sign-macos.test.ts`
- Create: `scripts/sign/README.md`

Both signers follow the exact `scripts/sign-linux-gpg.sh` convention: **secret present → sign; else warn + exit 0.** Built unsigned-ready (no certs yet). The no-secret skip path is unit-tested (Linux-runnable for the bash signer).

- [ ] **Step 1: Write the failing test (the gate path)**

```ts
// scripts/sign/sign-macos.test.ts
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-sign-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("sign-macos.sh skips (exit 0 + warning) when no cert secrets are present", () => {
  const target = join(dir, "nimbus-headless-macos-x64.pkg");
  writeFileSync(target, "PKG");
  const r = spawnSync("bash", ["scripts/sign/sign-macos.sh", target], {
    encoding: "utf8",
    env: { ...process.env, APPLE_CERT_P12_BASE64: "", APPLE_TEAM_ID: "" },
  });
  expect(r.status).toBe(0);
  expect(`${r.stdout}${r.stderr}`).toContain("signing skipped");
});

test("sign-macos.sh errors on a missing target argument", () => {
  const r = spawnSync("bash", ["scripts/sign/sign-macos.sh"], { encoding: "utf8" });
  expect(r.status).not.toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/sign/sign-macos.test.ts`
Expected: FAIL — script does not exist.

- [ ] **Step 3: Implement `sign-macos.sh`**

```sh
#!/usr/bin/env bash
# scripts/sign/sign-macos.sh — codesign (binaries) / productsign (.pkg) + notarize.
# Convention (matches sign-linux-gpg.sh): cert secrets present -> sign; else warn + exit 0.
# Required secrets when signing:
#   APPLE_CERT_P12_BASE64, APPLE_CERT_PASSWORD, APPLE_TEAM_ID,
#   APPLE_DEVELOPER_ID_APP, APPLE_DEVELOPER_ID_INSTALLER,
#   APPLE_NOTARY_ID, APPLE_NOTARY_PASSWORD   (notarytool Apple-ID creds)
set -euo pipefail

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then echo "usage: $0 <path>" >&2; exit 1; fi

if [[ -z "${APPLE_CERT_P12_BASE64:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
  echo "signing skipped: APPLE_CERT_P12_BASE64 / APPLE_TEAM_ID not set"
  exit 0
fi

KEYCHAIN="$(mktemp -d)/nimbus-signing.keychain-db"
KEYCHAIN_PW="$(uuidgen)"
cleanup() { security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true; }
trap cleanup EXIT

security create-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
echo "$APPLE_CERT_P12_BASE64" | base64 --decode > "$KEYCHAIN.p12"
security import "$KEYCHAIN.p12" -k "$KEYCHAIN" -P "${APPLE_CERT_PASSWORD:-}" \
  -T /usr/bin/codesign -T /usr/bin/productsign
security set-key-partition-list -S apple-tool:,apple: -k "$KEYCHAIN_PW" "$KEYCHAIN" >/dev/null
security list-keychains -d user -s "$KEYCHAIN" "$(security list-keychains -d user | tr -d '"')"
rm -f "$KEYCHAIN.p12"

case "$TARGET" in
  *.pkg)
    SIGNED="${TARGET%.pkg}-signed.pkg"
    productsign --sign "${APPLE_DEVELOPER_ID_INSTALLER:?}" "$TARGET" "$SIGNED"
    mv "$SIGNED" "$TARGET"
    ;;
  *)
    codesign --force --timestamp --options runtime \
      --sign "${APPLE_DEVELOPER_ID_APP:?}" "$TARGET"
    ;;
esac

# Notarize + staple (best-effort: requires notary creds; skip if absent).
if [[ -n "${APPLE_NOTARY_ID:-}" && -n "${APPLE_NOTARY_PASSWORD:-}" ]]; then
  xcrun notarytool submit "$TARGET" --apple-id "$APPLE_NOTARY_ID" \
    --password "$APPLE_NOTARY_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
  xcrun stapler staple "$TARGET" || echo "stapler: target type not staple-able; skipping"
else
  echo "notarization skipped: APPLE_NOTARY_ID / APPLE_NOTARY_PASSWORD not set"
fi

echo "signed: $TARGET"
```

- [ ] **Step 4: Implement `sign-windows.ps1`**

```powershell
#Requires -Version 7.0
<#
.SYNOPSIS
  Sign a Windows artifact (.msi/.exe) with signtool. Convention matches
  sign-linux-gpg.sh: cert secrets present -> sign; else warn + exit 0.
.DESCRIPTION
  Required env when signing:
    WINDOWS_CERT_PFX_BASE64, WINDOWS_CERT_PASSWORD
  Optional: WINDOWS_CERT_TIMESTAMP_URL (default: http://timestamp.digicert.com)
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Target)
$ErrorActionPreference = "Stop"

if (-not (Test-Path $Target)) { Write-Error "sign-windows: target not found: $Target"; exit 1 }

if (-not $env:WINDOWS_CERT_PFX_BASE64 -or -not $env:WINDOWS_CERT_PASSWORD) {
  Write-Host "signing skipped: WINDOWS_CERT_PFX_BASE64 / WINDOWS_CERT_PASSWORD not set"
  exit 0
}

$signtool = Get-Command signtool -ErrorAction SilentlyContinue
if (-not $signtool) {
  # signtool ships with the Windows SDK; CI adds it to PATH. Fail loudly if signing was requested.
  Write-Error "sign-windows: signtool not found on PATH (install the Windows SDK)."; exit 1
}

$pfx = Join-Path ([System.IO.Path]::GetTempPath()) "nimbus-cert.pfx"
try {
  [System.IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:WINDOWS_CERT_PFX_BASE64))
  $ts = if ($env:WINDOWS_CERT_TIMESTAMP_URL) { $env:WINDOWS_CERT_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }
  & signtool sign /fd SHA256 /td SHA256 /tr $ts /f $pfx /p $env:WINDOWS_CERT_PASSWORD $Target
  if ($LASTEXITCODE -ne 0) { Write-Error "signtool failed ($LASTEXITCODE)"; exit 1 }
  Write-Host "signed: $Target"
} finally {
  if (Test-Path $pfx) { Remove-Item $pfx -Force }
}
```

- [ ] **Step 5: Create the seam README**

```markdown
<!-- scripts/sign/README.md -->
# Code-signing seam

Each signer follows one convention: **cert secrets present → sign; else warn and `exit 0`.**
The pipeline shape is identical signed or unsigned — adding cert secrets later flips
every channel to trusted with zero pipeline rework.

| Script | Tool | Secret gate |
| --- | --- | --- |
| `sign-windows.ps1` | `signtool` | `WINDOWS_CERT_PFX_BASE64` + `WINDOWS_CERT_PASSWORD` |
| `sign-macos.sh` | `codesign`/`productsign` + `notarytool` | `APPLE_CERT_P12_BASE64` + `APPLE_TEAM_ID` (+ notary creds) |
| `../sign-linux-gpg.sh` | `gpg --detach-sign` | `GPG_PRIVATE_KEY` + `GPG_PASSPHRASE` |
| `../sign-ed25519.ts` | Ed25519 updater sig | `UPDATER_SIGNING_KEY` |

Nimbus currently ships **unsigned-ready**: no cert secrets are configured, so the
Windows/macOS signers no-op. Linux GPG + Ed25519 updater signing are already active.
```

- [ ] **Step 6: Run tests + syntax-check**

Run: `bun test scripts/sign/sign-macos.test.ts && pwsh -NoProfile -Command "$null=[System.Management.Automation.Language.Parser]::ParseFile('scripts/sign/sign-windows.ps1',[ref]$null,[ref]$null); 'ok'"`
Expected: tests PASS; `ok` printed. (On a non-Windows dev box, run only the bun test; the pwsh parse runs in CI.)

- [ ] **Step 7: Commit**

```bash
git add scripts/sign/
git commit -m "feat(release): secret-gated signing seam (signtool + codesign/notarytool)"
```

---

## Task 7: Wire into release.yml + extend verification

**Files:**

- Modify: `.github/workflows/release.yml`
- Modify: `scripts/release/nimbus-verify.test.ts`
- Modify: `scripts/release/nimbus-verify-ps1.test.ts`

Adds a Windows `build-msi` job and a macOS `build-pkg` job (each builds → signs via the seam → uploads its installer artifact), bootstraps a pinned `nfpm` and adds `--rpm` to the existing Linux step, and stages every new artifact into `SHA256SUMS`. The verify scripts already iterate the manifest generically, so the only verifier change is fixtures proving the new filenames pass.

- [ ] **Step 1: Add the `build-msi` job**

Insert after the `build-cli` job (before `publish-release`). Uses the version-pinned WiX tool.

```yaml
  build-msi:
    name: Build .msi (Windows)
    needs: [build-gateway, build-cli]
    runs-on: windows-2025
    timeout-minutes: 30
    permissions:
      contents: read
    steps:
      - name: Harden Runner
        uses: step-security/harden-runner@9af89fc71515a100421586dfdb3dc9c984fbf411 # v2.19.4
        with:
          egress-policy: audit
      - name: Checkout
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false
      - name: Download Windows binaries
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8
        with:
          path: dist/
      - name: Stage exes
        shell: pwsh
        run: |
          New-Item -ItemType Directory -Path dist/msi-bin -Force | Out-Null
          Copy-Item dist/nimbus-gateway-windows-x64/nimbus-gateway-windows-x64.exe dist/msi-bin/nimbus-gateway.exe
          Copy-Item dist/nimbus-cli-windows-x64/nimbus-cli-windows-x64.exe          dist/msi-bin/nimbus.exe
      - name: Install WiX v5 (pinned)
        shell: pwsh
        run: dotnet tool install --global wix --version 5.0.2
      - name: Build .msi
        shell: pwsh
        run: |
          $v = "${{ github.ref_name }}".TrimStart("v")
          New-Item -ItemType Directory -Path dist/installers -Force | Out-Null
          ./scripts/package-windows-installer.ps1 -BinDir (Resolve-Path dist/msi-bin) -Version $v -Out dist/installers/nimbus-headless-windows-x64.msi
      - name: Sign .msi (seam — no-op until certs land)
        shell: pwsh
        env:
          WINDOWS_CERT_PFX_BASE64: ${{ secrets.WINDOWS_CERT_PFX_BASE64 }}
          WINDOWS_CERT_PASSWORD: ${{ secrets.WINDOWS_CERT_PASSWORD }}
        run: ./scripts/sign/sign-windows.ps1 -Target dist/installers/nimbus-headless-windows-x64.msi
      - name: Upload .msi
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
        with:
          name: nimbus-installer-msi
          path: dist/installers/nimbus-headless-windows-x64.msi
          if-no-files-found: error
          retention-days: 30
```

- [ ] **Step 2: Add the `build-pkg` job**

```yaml
  build-pkg:
    name: Build .pkg (macOS)
    needs: [build-gateway, build-cli]
    runs-on: macos-15
    timeout-minutes: 30
    permissions:
      contents: read
    steps:
      - name: Harden Runner
        uses: step-security/harden-runner@9af89fc71515a100421586dfdb3dc9c984fbf411 # v2.19.4
        with:
          egress-policy: audit
      - name: Checkout
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false
      - name: Download macOS binaries
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8
        with:
          path: dist/
      - name: Build + sign per-arch .pkg
        env:
          APPLE_CERT_P12_BASE64: ${{ secrets.APPLE_CERT_P12_BASE64 }}
          APPLE_CERT_PASSWORD: ${{ secrets.APPLE_CERT_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          APPLE_DEVELOPER_ID_APP: ${{ secrets.APPLE_DEVELOPER_ID_APP }}
          APPLE_DEVELOPER_ID_INSTALLER: ${{ secrets.APPLE_DEVELOPER_ID_INSTALLER }}
          APPLE_NOTARY_ID: ${{ secrets.APPLE_NOTARY_ID }}
          APPLE_NOTARY_PASSWORD: ${{ secrets.APPLE_NOTARY_PASSWORD }}
        run: |
          set -e
          V="${GITHUB_REF_NAME#v}"
          mkdir -p dist/installers
          for arch in x64 arm64; do
            stage="dist/pkg-bin-$arch"
            mkdir -p "$stage"
            cp "dist/nimbus-gateway-macos-$arch/nimbus-gateway-macos-$arch" "$stage/nimbus-gateway"
            cp "dist/nimbus-cli-macos-$arch/nimbus-cli-macos-$arch"         "$stage/nimbus"
            chmod +x "$stage/nimbus" "$stage/nimbus-gateway"
            out="dist/installers/nimbus-headless-macos-$arch.pkg"
            bash scripts/package-macos-installer.sh --bin-dir "$stage" --version "$V" --out "$out"
            bash scripts/sign/sign-macos.sh "$out"
          done
      - name: Upload .pkg
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7
        with:
          name: nimbus-installer-pkg
          path: dist/installers/nimbus-headless-macos-*.pkg
          if-no-files-found: error
          retention-days: 30
```

- [ ] **Step 3: Bootstrap nfpm + build `.rpm` in the existing Linux step**

In `publish-release`, edit the **"Linux installers (.deb + tarball + AppImage)"** step: after the appimagetool download, add a pinned, checksum-verified nfpm bootstrap, then pass `--rpm`:

```yaml
          # Pinned nfpm (checksum-verified) for the .rpm. Update both when bumping.
          NFPM_VERSION="2.43.0"
          NFPM_TGZ="nfpm_${NFPM_VERSION}_Linux_x86_64.tar.gz"
          NFPM_SHA256="<PIN_AT_IMPLEMENTATION>"   # from the release's checksums.txt
          curl -fsSL "https://github.com/goreleaser/nfpm/releases/download/v${NFPM_VERSION}/${NFPM_TGZ}" -o /tmp/nfpm.tgz
          echo "${NFPM_SHA256}  /tmp/nfpm.tgz" | sha256sum -c -
          mkdir -p /tmp/nfpm && tar -xzf /tmp/nfpm.tgz -C /tmp/nfpm nfpm
          chmod +x /tmp/nfpm/nfpm
```

and change the `bun scripts/package-linux-installers.ts` invocation to add:

```yaml
            --rpm \
            --nfpm /tmp/nfpm/nfpm
```

> **Implementation note:** pin `NFPM_SHA256` from `https://github.com/goreleaser/nfpm/releases/download/v2.43.0/checksums.txt` (the `Linux_x86_64.tar.gz` line) when writing the YAML. Do not ship the placeholder.

- [ ] **Step 4: Sign the `.rpm` + stage all new artifacts**

In the **"Sign Linux installer artifacts"** step, add `dist/installers/*.rpm` to the `for f in …` glob (GPG-detach-sign the `.rpm` like the `.deb`).

Add `build-msi` and `build-pkg` to `publish-release.needs`:

```yaml
    needs:
      - build-gateway
      - build-cli
      - build-msi
      - build-pkg
```

In the **"Stage release assets"** step, after the `cp dist/installers/*` and `cp dist/archives/*` lines, add the downloaded installer artifacts:

```bash
          # Native installers built in dedicated OS jobs
          cp dist/nimbus-installer-msi/*.msi   dist/stage/
          cp dist/nimbus-installer-pkg/*.pkg   dist/stage/
```

(The `.rpm` is already in `dist/installers/*` and copied by the existing line. `SHA256SUMS` is computed over `dist/stage/*` in the next step, so all three flow through automatically, as does GitHub-Release attachment via `files: dist/stage/*`.)

- [ ] **Step 5: Validate the workflow YAML**

Run: `bunx --bun yaml-lint .github/workflows/release.yml 2>/dev/null || python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('yaml ok')"`
Expected: `yaml ok` (no parse error). Also eyeball that every `needs:` target exists.

- [ ] **Step 6: Extend the verifier fixtures**

The verify scripts loop over `SHA256SUMS` generically — no logic change. Add the new filenames to the existing fixture-driven tests so coverage is explicit. In `scripts/release/nimbus-verify.test.ts`, find the test that builds a `SHA256SUMS` over a set of staged dummy artifacts and add three entries:

```ts
  "nimbus-headless-windows-x64.msi",
  "nimbus-headless-macos-arm64.pkg",
  "nimbus-headless-0.5.0-x86_64.rpm",
```

(Add them to the same array/loop the existing artifacts use, write dummy bytes for each, regenerate the manifest, and assert the verify run reports them OK. Mirror the existing `.tar.gz`/`.zip` fixture handling exactly.) Do the same in `scripts/release/nimbus-verify-ps1.test.ts`.

- [ ] **Step 7: Run the verifier tests**

Run: `bun test scripts/release/nimbus-verify.test.ts scripts/release/nimbus-verify-ps1.test.ts`
Expected: PASS, with the three new artifacts verified. (The `.ps1` test is gated to platforms with `pwsh`; it skips elsewhere — confirm it still passes/skips as before.)

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/release.yml scripts/release/nimbus-verify.test.ts scripts/release/nimbus-verify-ps1.test.ts
git commit -m "ci(release): build+sign .msi/.pkg/.rpm and flow through SHA256SUMS"
```

---

## Task 8: Docs — install page + README pointer

**Files:**

- Create: `docs/install.md`
- Modify: `scripts/install/README.md`

- [ ] **Step 1: Write the install page**

```markdown
# Installing Nimbus (headless)

Nimbus ships a headless Gateway + CLI. Pick the channel that fits your platform.
All downloads are checksummed in `SHA256SUMS` and GPG-signed; verify with
`scripts/release/nimbus-verify.sh --version <ver>` (or `nimbus-verify.ps1`).

## Package managers (recommended — auto-updating)

| Platform | Command |
| --- | --- |
| macOS / Linux (Homebrew) | `brew install nimbus-agent/tap/nimbus` |
| Windows (Scoop) | `scoop bucket add nimbus https://github.com/nimbus-agent/scoop-bucket; scoop install nimbus` |

## Native installers (double-click)

| Platform | Artifact | Scope |
| --- | --- | --- |
| Windows | `nimbus-headless-windows-x64.msi` | Per-user (`%LOCALAPPDATA%`), no admin |
| macOS (Apple Silicon) | `nimbus-headless-macos-arm64.pkg` | Per-user (`~/.local`), no sudo |
| macOS (Intel) | `nimbus-headless-macos-x64.pkg` | Per-user (`~/.local`), no sudo |
| Linux (RPM) | `nimbus-headless-<ver>-x86_64.rpm` | `sudo dnf install ./...rpm` |
| Linux (DEB) | `nimbus-headless_<ver>_amd64.deb` | `sudo dpkg -i ...deb` |

Native installers and package-manager builds disable the self-updater — the
installer/package owns updates. The standalone tarball keeps the self-updater on.

To remove: Windows → Add/Remove Programs; macOS → run `uninstall-nimbus`;
RPM/DEB → `sudo dnf remove nimbus-headless` / `sudo apt remove nimbus-headless`.

## Universal fallback (scripted)

The read-it-yourself `install.sh` / `install.ps1` in each release archive install
per-user with no admin and keep the self-updater enabled. See
[`scripts/install/README.md`](../scripts/install/README.md).

> **Signing status:** Windows/macOS installers are currently **unsigned** (no
> certificates yet). You may see a SmartScreen / Gatekeeper warning. Verify the
> download's checksum + GPG signature as your trust anchor until signing lands.
```

- [ ] **Step 2: Point the install README at the new page**

Add near the top of `scripts/install/README.md`:

```markdown
> **Package-manager & native-installer users:** see [`docs/install.md`](../../docs/install.md)
> for `brew`/`scoop` one-liners and the `.msi`/`.pkg`/`.rpm`/`.deb` matrix. The
> scripts below are the universal, read-it-yourself fallback.
```

- [ ] **Step 3: Lint markdown (docs are markdownlint-gated)**

Run: `bunx markdownlint-cli2 "docs/install.md" "scripts/install/README.md"`
Expected: no errors. (Auto-fix trivially with `--fix`; MD040 fenced-code-language + stray fences are manual. Use relative links only — lychee fails on absolute `file:///` links.)

- [ ] **Step 4: Commit**

```bash
git add docs/install.md scripts/install/README.md
git commit -m "docs(install): channel matrix + native-installer guide"
```

---

## Task 9: Full pre-flight + PR

- [ ] **Step 1: Run the script tests + typecheck + targeted gates**

```bash
bun test scripts
bun run typecheck
bun run audit:cross-platform   # flags Windows-separator path assertions in new tests
bunx biome check scripts packages/sdk   # NOT `bun run lint` in a .claude worktree (biome excludes it)
```

Expected: all green. Fix any cross-platform path-assertion flags with `path.join()` (or the `// cross-platform-ok` escape hatch only where genuinely intended).

- [ ] **Step 2: Run the full pre-flight (CI parity)**

```bash
bun run preflight:fast   # cheap static gates (~2-3 min)
```

Expected: green. If touching anything the preflight manifest gates (`scripts/lib/preflight-gates.ts`), ensure no drift-test failure.

- [ ] **Step 3: Push + open the PR**

```bash
git push -u origin worktree-installer-slice2
gh pr create --title "Installer Slice 2: native .msi/.pkg/.rpm + signing seam (headless)" \
  --body "<summary: native installers, signing seam, SHA256SUMS flow, updater coexistence; links to docs/superpowers/specs/2026-06-12-installer-distribution-design.md §5/§6 and this plan>"
```

Expected: PR opens; CI runs `pr-quality` on Ubuntu. The `.msi`/`.pkg` smoke builds only run on a release tag (release.yml), not on PRs — call this out in the PR body and verify the new release-job YAML by inspection + a manual `workflow_dispatch` dry-run on the branch if the reviewer wants it.

---

## Self-Review Checklist (completed during authoring)

**Spec coverage (§5 Slice 2 + §6):**

- `.msi` WiX v5, `Scope="perUser"`, `%LOCALAPPDATA%`, User PATH, ARP, `MajorUpgrade`/`UpgradeCode` → Task 4 ✓
- `.pkg` pkgbuild/productbuild, user-scoped `~/.local/bin`, no sudo, reuse unix PATH-marker, uninstall script → Task 5 ✓
- `.rpm` via nfpm in package-linux-installers.ts, one config, keep `.deb`/AppImage/tarball → Tasks 1–2 ✓
- All three attached to Release, flow through `SHA256SUMS`, pass through signing seam → Task 7 ✓
- Signing seam `scripts/sign/` signtool + codesign/notarytool, secret-gated, existing signers adopt convention → Task 6 ✓
- WiX bootstrap (`dotnet tool install --global wix`, pinned) → Task 7 ✓
- nfpm bootstrap (version-pinned, checksum-verified) → Task 7 ✓
- Updater↔package-manager coexistence (§6.1): disable updater + channel marker per channel → Tasks 2, 3, 5 ✓
- Verification extended to new artifacts → Task 7 ✓
- Docs install page + README pointer → Task 8 ✓
- Unit-test the generators (nfpm config) following existing pattern; native binaries get CI smoke → Tasks 1, 7 ✓
- Pre-release policy: msi/pkg/rpm ride the stable `release.yml` tag flow (release.yml already flags prereleases); package-manager channels (Slice 1) already stable-only — no change needed ✓

**Type consistency:** `renderNfpmConfig(NfpmInputs)`, `resolveDistributionChannel`, channel literals (`apt`/`yum`/`pkg`/`msi`) match the SDK's `DistributionChannel` union and Slice-1 `channelUpgradeHint`. Artifact filenames are consistent across release.yml staging, verify fixtures, and docs (`nimbus-headless-windows-x64.msi`, `nimbus-headless-macos-{x64,arm64}.pkg`, `nimbus-headless-<ver>-x86_64.rpm`).

**Placeholder scan:** the only intentional placeholder is `NFPM_SHA256=<PIN_AT_IMPLEMENTATION>` (Task 7 Step 3) with an explicit note to pin from the upstream checksums.txt — it cannot be hardcoded without the chosen nfpm version's real hash.
