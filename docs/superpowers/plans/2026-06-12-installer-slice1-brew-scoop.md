# Installer Slice 1 — Homebrew Tap + Scoop Bucket — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `brew install nimbus-agent/tap/nimbus` and `scoop install nimbus` for the headless Gateway + CLI, with the self-updater stepped aside so the package manager owns updates.

**Architecture:** A pure generator (`scripts/release/package-manager-manifests.ts`) renders a Homebrew formula and a Scoop manifest from the release version + the release `SHA256SUMS`. A new `publish-package-managers.yml` workflow runs on **stable** release publish, generates both files, and pushes them to two external channel repos under the `nimbus-agent` GitHub org. To prevent the Ed25519 self-updater from fighting the package manager, a small `distribution-channel` module disables the updater and turns `nimbus update` into a channel-appropriate nudge when Nimbus is running from a Homebrew/Scoop install path.

**Tech Stack:** Bun + TypeScript (strict, no `any`), `bun:test`, GitHub Actions, Homebrew Ruby formula, Scoop JSON manifest.

**Source spec:** [`2026-06-12-installer-distribution-design.md`](../specs/2026-06-12-installer-distribution-design.md) (§5 Slice 1, §6.1 updater coexistence, §9 pre-release policy).

---

## Grounding facts (verified against the codebase — do not re-derive)

- **GitHub org/repo:** `nimbus-agent/Nimbus` (the spec text says `nimbus-dev`; that is the **npm** scope. The GitHub org is `nimbus-agent`. External channel repos are `nimbus-agent/homebrew-tap` and `nimbus-agent/scoop-bucket`).
- **Release asset filenames** (`.github/workflows/release.yml`, "Build macOS + Windows archives" + `package-linux-installers.ts`):
  - macOS arm64: `nimbus-headless-macos-arm64.tar.gz` (extracts to `nimbus`, `nimbus-gateway`)
  - macOS x64: `nimbus-headless-macos-x64.tar.gz`
  - Linux x64: `nimbus-headless-linux-amd64-v<version>.tar.gz`
  - Windows x64: `nimbus-headless-windows-x64.zip` (extracts to `nimbus.exe`, `nimbus-gateway.exe`)
- **Download URL shape:** `https://github.com/nimbus-agent/Nimbus/releases/download/v<version>/<filename>`
- **`SHA256SUMS` format** (`release.yml` "Compute SHA256SUMS"): `LC_ALL=C sha256sum * | sort -k2`, i.e. each line is `<64-hex-hash><space><space><filename>`, sorted by filename. Attached as a release asset.
- **Updater enable-gate:** `packages/gateway/src/updater/factory.ts:19-23` — `createUpdaterFromConfig` returns `undefined` when `!updaterCfg.enabled`. This is the single construction gate; there is a unit test for it in `factory.test.ts`.
- **Existing disable env:** `NIMBUS_UPDATER_DISABLE=1` already forces `updater.enabled=false` (`config/nimbus-toml.ts:411`).
- **`nimbus update` CLI:** `packages/cli/src/commands/update.ts` — `runUpdate(argv)` dispatches to `runUpdateCheck`/`runUpdateApply` over IPC.
- **Compiled-binary path:** Nimbus binaries are `bun build --compile` standalone executables, so `process.execPath` is the path of the `nimbus` / `nimbus-gateway` binary itself (Homebrew resolves the symlink to the Cellar path; Scoop to `~/scoop/apps/nimbus/...`).
- **Test runner:** `test:scripts` = `bun test scripts`; root `bun test` also includes `scripts/**`. Gateway/CLI tests run under their package suites. Test style: `bun:test`, `mkdtempSync(join(tmpdir(), …))` for temp dirs (cross-platform), REPO_ROOT via `import.meta.url`.

---

## File Structure

**Phase A — Updater coexistence (gateway + CLI):**
- Create: `packages/gateway/src/config/distribution-channel.ts` — pure channel resolver.
- Create: `packages/gateway/src/config/distribution-channel.test.ts`
- Modify: `packages/gateway/src/updater/factory.ts` — skip construction when channel-managed.
- Modify: `packages/gateway/src/updater/factory.test.ts` — add managed-channel case.
- Modify: `packages/cli/src/commands/update.ts` — nudge when channel-managed.
- Modify: `packages/cli/src/commands/update.test.ts` — add nudge case.

**Phase B — Manifest generators (scripts):**
- Create: `scripts/release/package-manager-manifests.ts` — `parseSha256Sums`, `renderHomebrewFormula`, `renderScoopManifest`, CLI `main`.
- Create: `scripts/release/package-manager-manifests.test.ts`

**Phase C — Publish workflow:**
- Create: `.github/workflows/publish-package-managers.yml`

**Phase D — External repos + docs:**
- Prerequisite (run by a maintainer): create `nimbus-agent/homebrew-tap` + `nimbus-agent/scoop-bucket`.
- Create: `docs/install.md` (channel matrix + one-liners) — or extend the docs site if a page exists.
- Modify: `scripts/install/README.md` — point package-manager users at the new one-liners.

---

## Phase A — Updater ↔ package-manager coexistence

### Task 1: `distribution-channel` pure resolver

**Files:**
- Create: `packages/gateway/src/config/distribution-channel.ts`
- Test: `packages/gateway/src/config/distribution-channel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { resolveDistributionChannel } from "./distribution-channel.ts";

describe("resolveDistributionChannel", () => {
  test("returns null for an ordinary install path with no env marker", () => {
    expect(
      resolveDistributionChannel({ env: {}, execPath: "/home/u/.local/bin/nimbus" }),
    ).toBeNull();
  });

  test("honors a valid NIMBUS_DISTRIBUTION_CHANNEL env marker", () => {
    expect(
      resolveDistributionChannel({
        env: { NIMBUS_DISTRIBUTION_CHANNEL: "msi" },
        execPath: "/home/u/.local/bin/nimbus",
      }),
    ).toBe("msi");
  });

  test("ignores an unknown env marker value (fails closed to path detection)", () => {
    expect(
      resolveDistributionChannel({
        env: { NIMBUS_DISTRIBUTION_CHANNEL: "bogus" },
        execPath: "/home/u/.local/bin/nimbus",
      }),
    ).toBeNull();
  });

  test("detects a macOS Homebrew Cellar path", () => {
    expect(
      resolveDistributionChannel({
        env: {},
        execPath: "/opt/homebrew/Cellar/nimbus/0.1.0/bin/nimbus",
      }),
    ).toBe("homebrew");
  });

  test("detects a Linuxbrew path", () => {
    expect(
      resolveDistributionChannel({
        env: {},
        execPath: "/home/linuxbrew/.linuxbrew/Cellar/nimbus/0.1.0/bin/nimbus-gateway",
      }),
    ).toBe("homebrew");
  });

  test("detects a Scoop apps path (Windows-style backslashes)", () => {
    expect(
      resolveDistributionChannel({
        env: {},
        execPath: "C:\\Users\\u\\scoop\\apps\\nimbus\\current\\nimbus.exe",
      }),
    ).toBe("scoop");
  });

  test("env marker wins over a conflicting path", () => {
    expect(
      resolveDistributionChannel({
        env: { NIMBUS_DISTRIBUTION_CHANNEL: "homebrew" },
        execPath: "C:\\Users\\u\\scoop\\apps\\nimbus\\current\\nimbus.exe",
      }),
    ).toBe("homebrew");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gateway && bun test src/config/distribution-channel.test.ts`
Expected: FAIL — `Cannot find module './distribution-channel.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/gateway/src/config/distribution-channel.ts

/**
 * Channels a Nimbus binary can be distributed through. When Nimbus runs from a
 * package-manager install, the self-updater steps aside so the package manager
 * owns updates (see installer design spec §6.1).
 */
export type DistributionChannel =
  | "homebrew"
  | "scoop"
  | "winget"
  | "apt"
  | "yum"
  | "msi"
  | "pkg";

const KNOWN_CHANNELS: ReadonlySet<DistributionChannel> = new Set([
  "homebrew",
  "scoop",
  "winget",
  "apt",
  "yum",
  "msi",
  "pkg",
]);

export interface ResolveChannelOptions {
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Defaults to `process.execPath`. */
  execPath?: string;
}

function fromEnv(env: Record<string, string | undefined>): DistributionChannel | null {
  const raw = env["NIMBUS_DISTRIBUTION_CHANNEL"];
  if (raw && KNOWN_CHANNELS.has(raw as DistributionChannel)) {
    return raw as DistributionChannel;
  }
  return null;
}

function fromPath(execPath: string): DistributionChannel | null {
  // Normalize backslashes so Windows + POSIX paths match the same substrings.
  const p = execPath.replace(/\\/g, "/").toLowerCase();
  // Homebrew: macOS `/opt/homebrew/Cellar/...` or `/usr/local/Cellar/...`,
  // Linuxbrew `/home/linuxbrew/.linuxbrew/...`.
  if (p.includes("/cellar/") || p.includes("/.linuxbrew/")) {
    return "homebrew";
  }
  // Scoop: `~/scoop/apps/<app>/...`.
  if (p.includes("/scoop/apps/")) {
    return "scoop";
  }
  return null;
}

/**
 * Resolve the distribution channel this binary was installed through, or `null`
 * for a plain/direct-download install (where the self-updater stays enabled).
 * An explicit `NIMBUS_DISTRIBUTION_CHANNEL` env marker takes precedence over
 * path heuristics; an unknown marker value is ignored.
 */
export function resolveDistributionChannel(
  opts: ResolveChannelOptions = {},
): DistributionChannel | null {
  const env = opts.env ?? process.env;
  const execPath = opts.execPath ?? process.execPath;
  return fromEnv(env) ?? fromPath(execPath);
}

/** Human-facing upgrade hint per channel, used by `nimbus update`. */
export function channelUpgradeHint(channel: DistributionChannel): string {
  switch (channel) {
    case "homebrew":
      return "Installed via Homebrew — run 'brew upgrade nimbus' to update.";
    case "scoop":
      return "Installed via Scoop — run 'scoop update nimbus' to update.";
    case "winget":
      return "Installed via winget — run 'winget upgrade nimbus' to update.";
    case "apt":
      return "Installed via apt — run 'sudo apt update && sudo apt upgrade nimbus' to update.";
    case "yum":
      return "Installed via dnf/yum — run 'sudo dnf upgrade nimbus' to update.";
    case "msi":
      return "Installed via the Windows installer — download the latest .msi from the releases page.";
    case "pkg":
      return "Installed via the macOS installer — download the latest .pkg from the releases page.";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/gateway && bun test src/config/distribution-channel.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/config/distribution-channel.ts packages/gateway/src/config/distribution-channel.test.ts
git commit -m "feat(updater): distribution-channel resolver for package-manager installs"
```

---

### Task 2: Skip the self-updater when channel-managed

**Files:**
- Modify: `packages/gateway/src/updater/factory.ts`
- Test: `packages/gateway/src/updater/factory.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `factory.test.ts` (it already imports `createUpdaterFromConfig`; mirror the existing `enabled = false` test). Use a minimal enabled config and an injected managed channel:

```ts
import { resolveDistributionChannel } from "../config/distribution-channel.ts";

test("returns undefined when running from a package-manager channel", () => {
  const cfg = { enabled: true, url: "https://example.invalid/latest.json" } as Parameters<
    typeof createUpdaterFromConfig
  >[0]["updaterCfg"];
  const updater = createUpdaterFromConfig({
    updaterCfg: cfg,
    currentVersion: "0.1.0",
    emit: () => {},
    logger: { warn() {}, info() {} } as unknown as Parameters<
      typeof createUpdaterFromConfig
    >[0]["logger"],
    _channelOverride: "homebrew",
  });
  expect(updater).toBeUndefined();
});

// Sanity: resolver is null for a normal path so default behavior is unchanged.
test("resolver returns null for a plain install path", () => {
  expect(resolveDistributionChannel({ env: {}, execPath: "/usr/bin/nimbus" })).toBeNull();
});
```

> Note: match the exact shape `factory.test.ts` already uses to build a config + logger; if it has a `makeCfg()`/`fakeLogger()` helper, reuse it and pass `_channelOverride: "homebrew"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/gateway && bun test src/updater/factory.test.ts`
Expected: FAIL — `_channelOverride` is not an accepted arg / updater is constructed (not undefined).

- [ ] **Step 3: Write minimal implementation**

In `factory.ts`, import the resolver, add an optional override to the args interface, and gate construction:

```ts
import { resolveDistributionChannel, type DistributionChannel } from "../config/distribution-channel.ts";

export interface CreateUpdaterFromConfigArgs {
  updaterCfg: NimbusUpdaterToml;
  currentVersion: string;
  emit: UpdaterEmit;
  logger: Logger;
  _platformOverride?: PlatformTarget | undefined;
  _forceUnsupported?: boolean;
  /** Test seam: override the detected distribution channel. */
  _channelOverride?: DistributionChannel | null;
}

export function createUpdaterFromConfig(args: CreateUpdaterFromConfigArgs): Updater | undefined {
  const { updaterCfg, currentVersion, emit, logger } = args;

  if (!updaterCfg.enabled) {
    return undefined;
  }

  const channel =
    args._channelOverride !== undefined ? args._channelOverride : resolveDistributionChannel();
  if (channel !== null) {
    logger.info(
      { channel },
      "updater: package-manager install detected; self-update disabled (manage via the package manager)",
    );
    return undefined;
  }

  // ... existing platform-target + new Updater(...) logic unchanged ...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/gateway && bun test src/updater/factory.test.ts`
Expected: PASS (existing tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/updater/factory.ts packages/gateway/src/updater/factory.test.ts
git commit -m "feat(updater): disable self-update on package-manager installs"
```

---

### Task 3: `nimbus update` nudges instead of self-updating when channel-managed

> **Architecture note (CLAUDE.md):** `cli` must reach the gateway **IPC-only — no source imports**.
> So the CLI cannot import the gateway's `distribution-channel.ts` from Task 1. Instead the CLI
> gets its own tiny copy of the same pure functions. Two ~30-line pure copies across a hard
> package boundary is the correct trade, not a smell.

**Files:**
- Create: `packages/cli/src/lib/distribution-channel.ts` (CLI-local copy of the resolver + hint)
- Create: `packages/cli/src/lib/distribution-channel.test.ts`
- Modify: `packages/cli/src/commands/update.ts`
- Test: `packages/cli/src/commands/update.test.ts`

- [ ] **Step 1: Write the failing test for the CLI-local module**

Create `packages/cli/src/lib/distribution-channel.test.ts` — the same 7 cases as Task 1's test
but importing from `./distribution-channel.ts` (the CLI-local path). Copy the Task 1 test body
verbatim, changing only the import to `from "./distribution-channel.ts"`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/cli && bun test src/lib/distribution-channel.test.ts`
Expected: FAIL — `Cannot find module './distribution-channel.ts'`.

- [ ] **Step 3: Create the CLI-local module**

Create `packages/cli/src/lib/distribution-channel.ts` with the **same code as Task 1's
`distribution-channel.ts`** (the `DistributionChannel` type, `KNOWN_CHANNELS`,
`ResolveChannelOptions`, `resolveDistributionChannel`, and `channelUpgradeHint`), minus the
gateway-specific doc comments.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd packages/cli && bun test src/lib/distribution-channel.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing test for `update.ts`**

Add to `update.test.ts`:

```ts
test("runUpdate prints the channel hint and skips IPC when channel-managed", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (m?: unknown) => {
    logs.push(String(m));
  };
  try {
    await runUpdate([], { channel: "homebrew" });
  } finally {
    console.log = origLog;
  }
  expect(logs.join("\n")).toContain("brew upgrade nimbus");
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd packages/cli && bun test src/commands/update.test.ts`
Expected: FAIL — `runUpdate` takes one arg; the second `opts` arg is unsupported.

- [ ] **Step 7: Wire the nudge into `update.ts`**

```ts
import {
  channelUpgradeHint,
  resolveDistributionChannel,
  type DistributionChannel,
} from "../lib/distribution-channel.ts";

export interface RunUpdateOptions {
  /** Test seam; defaults to the live channel resolver. */
  channel?: DistributionChannel | null;
}

export async function runUpdate(argv: string[], opts: RunUpdateOptions = {}): Promise<void> {
  const channel = opts.channel !== undefined ? opts.channel : resolveDistributionChannel();
  if (channel !== null) {
    console.log(channelUpgradeHint(channel));
    process.exitCode = 0;
    return;
  }

  const args = parseUpdateArgs(argv);
  // ... existing check/apply logic unchanged ...
}
```

> **Clean-exit requirement (verified):** the channel short-circuit MUST be the first thing in
> `runUpdate`, before `parseUpdateArgs` and before any `withGatewayIpc(...)` call. `withGatewayIpc`
> is the only thing that opens an IPC connection / keeps the event loop alive; reaching `return`
> above it means the managed-install path opens no connections and the process exits cleanly. The
> Step 5 test implicitly proves this — it injects no gateway and would hang/throw in `withGatewayIpc`
> if the short-circuit were placed too late.

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd packages/cli && bun test src/commands/update.test.ts src/lib/distribution-channel.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/lib/distribution-channel.ts packages/cli/src/lib/distribution-channel.test.ts packages/cli/src/commands/update.ts packages/cli/src/commands/update.test.ts
git commit -m "feat(cli): nimbus update nudges to the package manager on managed installs"
```

---

## Phase B — Manifest generators

### Task 4: `parseSha256Sums` + types

**Files:**
- Create: `scripts/release/package-manager-manifests.ts`
- Test: `scripts/release/package-manager-manifests.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { parseSha256Sums } from "./package-manager-manifests.ts";

describe("parseSha256Sums", () => {
  test("parses `<hash>␠␠<filename>` lines into a filename→hash map", () => {
    const text = [
      "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111  nimbus-headless-macos-arm64.tar.gz",
      "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222  nimbus-headless-windows-x64.zip",
      "",
    ].join("\n");
    const map = parseSha256Sums(text);
    expect(map.get("nimbus-headless-macos-arm64.tar.gz")).toBe(
      "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
    );
    expect(map.get("nimbus-headless-windows-x64.zip")).toBe(
      "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
    );
  });

  test("tolerates single-space separators and ignores blank lines", () => {
    const map = parseSha256Sums("cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333 file.tar.gz\n\n");
    expect(map.get("file.tar.gz")).toBe(
      "cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/release/package-manager-manifests.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/release/package-manager-manifests.ts

/**
 * Parse a GNU coreutils `SHA256SUMS` file (`<hex-hash>  <filename>`, sorted by
 * filename) into a filename→hash map. Tolerates one or more spaces between the
 * hash and the filename and ignores blank lines.
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!m) continue;
    map.set(m[2].trim(), m[1].toLowerCase());
  }
  return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/release/package-manager-manifests.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/package-manager-manifests.ts scripts/release/package-manager-manifests.test.ts
git commit -m "feat(release): SHA256SUMS parser for package-manager manifests"
```

---

### Task 5: `renderHomebrewFormula`

**Files:**
- Modify: `scripts/release/package-manager-manifests.ts`
- Test: `scripts/release/package-manager-manifests.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { renderHomebrewFormula, type ManifestInputs } from "./package-manager-manifests.ts";

const INPUTS: ManifestInputs = {
  version: "0.1.0",
  repo: "nimbus-agent/Nimbus",
  assets: {
    macArm64Sha256: "a".repeat(64),
    macX64Sha256: "b".repeat(64),
    linuxX64Sha256: "c".repeat(64),
    winX64Sha256: "d".repeat(64),
  },
};

describe("renderHomebrewFormula", () => {
  const rb = renderHomebrewFormula(INPUTS);
  test("declares class Nimbus and version 0.1.0", () => {
    expect(rb).toContain("class Nimbus < Formula");
    expect(rb).toContain('version "0.1.0"');
  });
  test("uses the macOS arm64 + x64 release URLs and their sha256", () => {
    expect(rb).toContain(
      "https://github.com/nimbus-agent/Nimbus/releases/download/v0.1.0/nimbus-headless-macos-arm64.tar.gz",
    );
    expect(rb).toContain(`sha256 "${"a".repeat(64)}"`);
    expect(rb).toContain(
      "https://github.com/nimbus-agent/Nimbus/releases/download/v0.1.0/nimbus-headless-macos-x64.tar.gz",
    );
    expect(rb).toContain(`sha256 "${"b".repeat(64)}"`);
  });
  test("supports Homebrew on Linux x64", () => {
    expect(rb).toContain("nimbus-headless-linux-amd64-v0.1.0.tar.gz");
    expect(rb).toContain(`sha256 "${"c".repeat(64)}"`);
  });
  test("installs both binaries and has a version smoke test", () => {
    expect(rb).toContain('bin.install "nimbus"');
    expect(rb).toContain('bin.install "nimbus-gateway"');
    expect(rb).toContain("--version");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/release/package-manager-manifests.test.ts`
Expected: FAIL — `renderHomebrewFormula` / `ManifestInputs` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `package-manager-manifests.ts`:

```ts
export interface ManifestAssets {
  macArm64Sha256: string;
  macX64Sha256: string;
  linuxX64Sha256: string;
  winX64Sha256: string;
}

export interface ManifestInputs {
  /** Semver without a leading "v". */
  version: string;
  /** "owner/repo", e.g. "nimbus-agent/Nimbus". */
  repo: string;
  assets: ManifestAssets;
}

const DESC = "Local-first AI agent framework (headless gateway + CLI)";
const LICENSE = "AGPL-3.0-only";

function releaseUrl(repo: string, version: string, file: string): string {
  return `https://github.com/${repo}/releases/download/v${version}/${file}`;
}

export function renderHomebrewFormula(i: ManifestInputs): string {
  const { version, repo, assets } = i;
  const homepage = `https://github.com/${repo}`;
  const macArm = releaseUrl(repo, version, "nimbus-headless-macos-arm64.tar.gz");
  const macX64 = releaseUrl(repo, version, "nimbus-headless-macos-x64.tar.gz");
  const linuxX64 = releaseUrl(repo, version, `nimbus-headless-linux-amd64-v${version}.tar.gz`);
  return `# typed: false
# frozen_string_literal: true

# Homebrew formula for Nimbus (headless gateway + CLI).
# Generated by scripts/release/package-manager-manifests.ts — do not edit by hand.
class Nimbus < Formula
  desc "${DESC}"
  homepage "${homepage}"
  version "${version}"
  license "${LICENSE}"

  on_macos do
    on_arm do
      url "${macArm}"
      sha256 "${assets.macArm64Sha256}"
    end
    on_intel do
      url "${macX64}"
      sha256 "${assets.macX64Sha256}"
    end
  end

  on_linux do
    on_intel do
      url "${linuxX64}"
      sha256 "${assets.linuxX64Sha256}"
    end
  end

  def install
    bin.install "nimbus"
    bin.install "nimbus-gateway"
  end

  test do
    assert_match "${version}", shell_output("#{bin}/nimbus --version")
  end
end
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/release/package-manager-manifests.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/package-manager-manifests.ts scripts/release/package-manager-manifests.test.ts
git commit -m "feat(release): render Homebrew formula from release inputs"
```

---

### Task 6: `renderScoopManifest`

**Files:**
- Modify: `scripts/release/package-manager-manifests.ts`
- Test: `scripts/release/package-manager-manifests.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { renderScoopManifest } from "./package-manager-manifests.ts";

describe("renderScoopManifest", () => {
  const json = renderScoopManifest(INPUTS); // reuse INPUTS from Task 5
  const parsed = JSON.parse(json) as {
    version: string;
    architecture: { "64bit": { url: string; hash: string } };
    bin: string[];
    checkver: unknown;
    autoupdate: unknown;
  };
  test("is valid JSON with version + windows url + hash", () => {
    expect(parsed.version).toBe("0.1.0");
    expect(parsed.architecture["64bit"].url).toBe(
      "https://github.com/nimbus-agent/Nimbus/releases/download/v0.1.0/nimbus-headless-windows-x64.zip",
    );
    expect(parsed.architecture["64bit"].hash).toBe("d".repeat(64));
  });
  test("exposes both executables on PATH", () => {
    expect(parsed.bin).toEqual(["nimbus.exe", "nimbus-gateway.exe"]);
  });
  test("includes checkver + autoupdate for Scoop self-bumping", () => {
    expect(parsed.checkver).toBeDefined();
    expect(parsed.autoupdate).toBeDefined();
  });
  test("autoupdate URL keeps the LITERAL $version token (Scoop substitutes it, not us)", () => {
    // Guards against accidentally writing `v${version}` (which JS would interpolate
    // to the build-time version) instead of `v$version` (Scoop's client-side token).
    const auto = parsed.autoupdate as { architecture: { "64bit": { url: string } } };
    expect(auto.architecture["64bit"].url).toContain("/download/v$version/");
    expect(auto.architecture["64bit"].url).not.toContain("/download/v0.1.0/");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/release/package-manager-manifests.test.ts`
Expected: FAIL — `renderScoopManifest` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `package-manager-manifests.ts`:

```ts
export function renderScoopManifest(i: ManifestInputs): string {
  const { version, repo, assets } = i;
  const winUrl = releaseUrl(repo, version, "nimbus-headless-windows-x64.zip");
  const manifest = {
    version,
    description: DESC,
    homepage: `https://github.com/${repo}`,
    license: LICENSE,
    architecture: {
      "64bit": {
        url: winUrl,
        hash: assets.winX64Sha256,
      },
    },
    bin: ["nimbus.exe", "nimbus-gateway.exe"],
    checkver: {
      github: `https://github.com/${repo}`,
    },
    autoupdate: {
      architecture: {
        "64bit": {
          url: `https://github.com/${repo}/releases/download/v$version/nimbus-headless-windows-x64.zip`,
        },
      },
    },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/release/package-manager-manifests.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/package-manager-manifests.ts scripts/release/package-manager-manifests.test.ts
git commit -m "feat(release): render Scoop manifest from release inputs"
```

---

### Task 7: CLI `main` — read version + SHA256SUMS, write both files

**Files:**
- Modify: `scripts/release/package-manager-manifests.ts`
- Test: `scripts/release/package-manager-manifests.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifestsToDir, type BuildOptions } from "./package-manager-manifests.ts";

describe("buildManifestsToDir", () => {
  test("writes nimbus.rb + nimbus.json resolving hashes from SHA256SUMS", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-mf-"));
    try {
      const sums = [
        `${"a".repeat(64)}  nimbus-headless-macos-arm64.tar.gz`,
        `${"b".repeat(64)}  nimbus-headless-macos-x64.tar.gz`,
        `${"c".repeat(64)}  nimbus-headless-linux-amd64-v0.1.0.tar.gz`,
        `${"d".repeat(64)}  nimbus-headless-windows-x64.zip`,
      ].join("\n");
      const sumsPath = join(dir, "SHA256SUMS");
      writeFileSync(sumsPath, sums, "utf8");
      const opts: BuildOptions = {
        version: "0.1.0",
        repo: "nimbus-agent/Nimbus",
        sha256SumsPath: sumsPath,
        outDir: dir,
      };
      const written = buildManifestsToDir(opts);
      expect(written.formulaPath.endsWith("nimbus.rb")).toBe(true);
      expect(written.scoopPath.endsWith("nimbus.json")).toBe(true);
      expect(readFileSync(written.formulaPath, "utf8")).toContain(`sha256 "${"a".repeat(64)}"`);
      const scoop = JSON.parse(readFileSync(written.scoopPath, "utf8")) as {
        architecture: { "64bit": { hash: string } };
      };
      expect(scoop.architecture["64bit"].hash).toBe("d".repeat(64));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws a clear error if a required asset is missing from SHA256SUMS", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-mf-"));
    try {
      const sumsPath = join(dir, "SHA256SUMS");
      writeFileSync(sumsPath, `${"a".repeat(64)}  nimbus-headless-macos-arm64.tar.gz\n`, "utf8");
      expect(() =>
        buildManifestsToDir({
          version: "0.1.0",
          repo: "nimbus-agent/Nimbus",
          sha256SumsPath: sumsPath,
          outDir: dir,
        }),
      ).toThrow(/nimbus-headless-windows-x64\.zip/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/release/package-manager-manifests.test.ts`
Expected: FAIL — `buildManifestsToDir` / `BuildOptions` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `package-manager-manifests.ts`:

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildOptions {
  version: string;
  repo: string;
  sha256SumsPath: string;
  outDir: string;
}

export interface BuildResult {
  formulaPath: string;
  scoopPath: string;
}

function requireHash(map: Map<string, string>, file: string): string {
  const h = map.get(file);
  if (!h) {
    throw new Error(
      `package-manager-manifests: required release asset not found in SHA256SUMS: ${file}`,
    );
  }
  return h;
}

export function buildManifestsToDir(opts: BuildOptions): BuildResult {
  const version = opts.version.replace(/^v/, "");
  const sums = parseSha256Sums(readFileSync(opts.sha256SumsPath, "utf8"));
  const inputs: ManifestInputs = {
    version,
    repo: opts.repo,
    assets: {
      macArm64Sha256: requireHash(sums, "nimbus-headless-macos-arm64.tar.gz"),
      macX64Sha256: requireHash(sums, "nimbus-headless-macos-x64.tar.gz"),
      linuxX64Sha256: requireHash(sums, `nimbus-headless-linux-amd64-v${version}.tar.gz`),
      winX64Sha256: requireHash(sums, "nimbus-headless-windows-x64.zip"),
    },
  };
  const formulaPath = join(opts.outDir, "nimbus.rb");
  const scoopPath = join(opts.outDir, "nimbus.json");
  writeFileSync(formulaPath, renderHomebrewFormula(inputs), "utf8");
  writeFileSync(scoopPath, renderScoopManifest(inputs), "utf8");
  return { formulaPath, scoopPath };
}

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

// CLI entry: bun scripts/release/package-manager-manifests.ts \
//   --version 0.1.0 --repo nimbus-agent/Nimbus --sha256sums dist/SHA256SUMS --out-dir out
if (import.meta.main) {
  const version = parseArg("--version") ?? process.env["NIMBUS_RELEASE_VERSION"];
  const repo = parseArg("--repo") ?? "nimbus-agent/Nimbus";
  const sha256SumsPath = parseArg("--sha256sums");
  const outDir = parseArg("--out-dir") ?? ".";
  if (!version || !sha256SumsPath) {
    console.error(
      "Usage: bun scripts/release/package-manager-manifests.ts --version <v> --sha256sums <path> [--repo owner/repo] [--out-dir dir]",
    );
    process.exit(1);
  }
  const res = buildManifestsToDir({ version, repo, sha256SumsPath, outDir });
  console.log(`wrote ${res.formulaPath}`);
  console.log(`wrote ${res.scoopPath}`);
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test scripts/release/package-manager-manifests.test.ts && bun run typecheck`
Expected: PASS; typecheck clean (no `any`).

- [ ] **Step 5: Commit**

```bash
git add scripts/release/package-manager-manifests.ts scripts/release/package-manager-manifests.test.ts
git commit -m "feat(release): CLI to emit nimbus.rb + nimbus.json from SHA256SUMS"
```

---

## Phase C — Publish workflow

### Task 8: `publish-package-managers.yml`

**Files:**
- Create: `.github/workflows/publish-package-managers.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: Publish package managers

# `released` (not `published`) fires only for non-prerelease releases, so
# rc/beta/alpha tags are skipped automatically (spec §9: channels track stable only).
# `workflow_dispatch` lets a maintainer re-run a publish by tag if the push failed
# transiently (GitHub outage, expired PAT) — re-running is idempotent (no-op if unchanged).
on:
  release:
    types: [released]
  workflow_dispatch:
    inputs:
      tag_name:
        description: "Tag to publish (e.g. v0.5.0)"
        required: true
        type: string

concurrency:
  group: publish-pkgmgr-${{ github.event.release.tag_name || github.event.inputs.tag_name }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  generate-and-publish:
    name: Generate + publish brew/scoop manifests
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - name: Harden Runner
        uses: step-security/harden-runner@9af89fc71515a100421586dfdb3dc9c984fbf411 # v2.19.4
        with:
          egress-policy: audit

      - name: Checkout Nimbus
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false

      - name: Setup Bun and install dependencies
        uses: ./.github/actions/setup-nimbus-ci
        with:
          verify-lock: "false"

      # Fail fast with an actionable message if the publish PAT is missing/empty.
      # On the upstream repo a missing secret means releases would silently fail to
      # publish, so we error loudly rather than skip. (Release events don't fire from
      # forks, so this is not a fork-noise concern.)
      - name: Require PACKAGE_MANAGER_PAT
        env:
          PKG_PAT: ${{ secrets.PACKAGE_MANAGER_PAT }}
        run: |
          set -euo pipefail
          if [ -z "${PKG_PAT}" ]; then
            echo "::error::PACKAGE_MANAGER_PAT is not set. Add a fine-grained PAT with contents:write on nimbus-agent/homebrew-tap + nimbus-agent/scoop-bucket (repo Settings → Secrets → Actions)."
            exit 1
          fi

      - name: Download SHA256SUMS from the release
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ github.event.release.tag_name || github.event.inputs.tag_name }}
        run: |
          set -euo pipefail
          mkdir -p out
          gh release download "$TAG" --repo "$GITHUB_REPOSITORY" --pattern SHA256SUMS --dir out

      - name: Generate manifests
        env:
          TAG: ${{ github.event.release.tag_name || github.event.inputs.tag_name }}
        run: |
          set -euo pipefail
          VERSION="${TAG#v}"
          bun scripts/release/package-manager-manifests.ts \
            --version "$VERSION" \
            --repo "$GITHUB_REPOSITORY" \
            --sha256sums out/SHA256SUMS \
            --out-dir out
          echo "--- nimbus.rb ---"; cat out/nimbus.rb
          echo "--- nimbus.json ---"; cat out/nimbus.json

      - name: Publish to homebrew-tap
        env:
          GH_TOKEN: ${{ secrets.PACKAGE_MANAGER_PAT }}
          TAG: ${{ github.event.release.tag_name || github.event.inputs.tag_name }}
        run: |
          set -euo pipefail
          git clone --depth 1 "https://x-access-token:${GH_TOKEN}@github.com/nimbus-agent/homebrew-tap.git" tap
          mkdir -p tap/Formula
          cp out/nimbus.rb tap/Formula/nimbus.rb
          cd tap
          git config user.name "nimbus-release-bot"
          git config user.email "release-bot@nimbus-agent.invalid"
          if git diff --quiet; then echo "no formula change"; exit 0; fi
          git add Formula/nimbus.rb
          git commit -m "nimbus ${TAG#v}"
          git push

      - name: Publish to scoop-bucket
        env:
          GH_TOKEN: ${{ secrets.PACKAGE_MANAGER_PAT }}
          TAG: ${{ github.event.release.tag_name || github.event.inputs.tag_name }}
        run: |
          set -euo pipefail
          git clone --depth 1 "https://x-access-token:${GH_TOKEN}@github.com/nimbus-agent/scoop-bucket.git" bucket
          mkdir -p bucket/bucket
          cp out/nimbus.json bucket/bucket/nimbus.json
          cd bucket
          git config user.name "nimbus-release-bot"
          git config user.email "release-bot@nimbus-agent.invalid"
          if git diff --quiet; then echo "no manifest change"; exit 0; fi
          git add bucket/nimbus.json
          git commit -m "nimbus ${TAG#v}"
          git push
```

- [ ] **Step 2: Lint the workflow**

Run: `actionlint .github/workflows/publish-package-managers.yml` (if `actionlint` is unavailable, skip — CI will surface YAML errors). Also confirm the pinned action SHAs match those already used in `release.yml` (`harden-runner`, `checkout`).
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/publish-package-managers.yml
git commit -m "ci: publish brew formula + scoop manifest on stable release"
```

> **Secret required:** `PACKAGE_MANAGER_PAT` — a fine-grained PAT with `contents: read+write` on **only** `nimbus-agent/homebrew-tap` and `nimbus-agent/scoop-bucket`. A maintainer adds it in repo Settings → Secrets → Actions. The workflow no-ops cleanly if the manifest is unchanged; without the secret, the publish steps fail (expected until the secret + repos exist — see Task 9).

---

## Phase D — External repos + docs

### Task 9: Create the channel repos (maintainer prerequisite — run once)

> This is infrastructure outside the Nimbus repo; it is **not** a code change and cannot be unit-tested. A maintainer with `nimbus-agent` org rights runs these once. Documented here so the workflow in Task 8 has somewhere to push.

- [ ] **Step 1: Create `homebrew-tap`**

```bash
gh repo create nimbus-agent/homebrew-tap --public \
  --description "Homebrew tap for Nimbus (headless gateway + CLI)"
# Seed structure:
#   Formula/nimbus.rb   (placeholder, overwritten by the first release)
#   README.md           ("brew tap nimbus-agent/tap && brew install nimbus")
```

- [ ] **Step 2: Create `scoop-bucket`**

```bash
gh repo create nimbus-agent/scoop-bucket --public \
  --description "Scoop bucket for Nimbus (headless gateway + CLI)"
# Seed structure:
#   bucket/nimbus.json  (placeholder, overwritten by the first release)
#   README.md           ("scoop bucket add nimbus https://github.com/nimbus-agent/scoop-bucket && scoop install nimbus")
```

- [ ] **Step 3: Add the `PACKAGE_MANAGER_PAT` secret** (fine-grained, scoped to those two repos only) under the Nimbus repo's Actions secrets.

- [ ] **Step 4: Verify** by triggering a test pre-release (e.g. `v0.0.1-test.1`) does NOT publish (proves the `released` filter), then a stable tag does. (No commit — verification only.)

---

### Task 10: Install docs + README pointer

**Files:**
- Create: `docs/install.md`
- Modify: `scripts/install/README.md`

- [ ] **Step 1: Write `docs/install.md`**

```markdown
# Installing Nimbus (headless gateway + CLI)

| Platform | One-liner |
|---|---|
| macOS / Linux (Homebrew) | `brew install nimbus-agent/tap/nimbus` |
| Windows (Scoop) | `scoop bucket add nimbus https://github.com/nimbus-agent/scoop-bucket && scoop install nimbus` |
| Any (script) | Download the latest release tarball/zip and run `install.sh` / `install.ps1` |

Updates are owned by your installer: `brew upgrade nimbus`, `scoop update nimbus`, or
re-running the install script. When Nimbus is installed via a package manager its built-in
self-updater is disabled automatically, and `nimbus update` will point you back at your
package manager.

Direct downloads (raw binaries, `.tar.gz`, `.zip`, Linux `.deb` / AppImage) and their
`SHA256SUMS` + GPG signature remain on the
[releases page](https://github.com/nimbus-agent/Nimbus/releases).
```

- [ ] **Step 2: Add a pointer at the top of `scripts/install/README.md`**

Insert after the H1:

```markdown
> **Most users:** prefer a package manager — `brew install nimbus-agent/tap/nimbus` (macOS/Linux)
> or `scoop install nimbus` (Windows). See [`docs/install.md`](../../docs/install.md).
> The scripts below remain the universal, read-it-yourself fallback.
```

- [ ] **Step 3: Validate doc links**

Run: `bun run audit:doc-refs` (the doc-refs audit scans CLAUDE/GEMINI/architecture/named docs + `.claude/commands/*`; `docs/install.md` backtick paths + markdown links are checked if referenced there). At minimum confirm no broken links you introduced.
Expected: no new broken-link failures.

- [ ] **Step 4: Commit**

```bash
git add docs/install.md scripts/install/README.md
git commit -m "docs: package-manager install one-liners (brew + scoop)"
```

---

## Final verification (run before opening the PR)

- [ ] `bun run typecheck` — clean (no `any`; new modules type-check).
- [ ] `bun test scripts/release/package-manager-manifests.test.ts` — PASS.
- [ ] `cd packages/gateway && bun test src/config/distribution-channel.test.ts src/updater/factory.test.ts` — PASS.
- [ ] `cd packages/cli && bun test src/commands/update.test.ts src/lib/distribution-channel.test.ts` — PASS.
- [ ] `bun run lint` (or `bunx biome check packages scripts` — biome is misconfigured inside `.claude/worktrees`, so prefer the explicit form) — clean.
- [ ] `bun run preflight:fast` — green (cheap static gates).
- [ ] Manually dry-run the generator end-to-end:
  ```bash
  printf '%s  nimbus-headless-macos-arm64.tar.gz\n%s  nimbus-headless-macos-x64.tar.gz\n%s  nimbus-headless-linux-amd64-v0.1.0.tar.gz\n%s  nimbus-headless-windows-x64.zip\n' \
    $(printf 'a%.0s' {1..64}) $(printf 'b%.0s' {1..64}) $(printf 'c%.0s' {1..64}) $(printf 'd%.0s' {1..64}) > /tmp/SHA256SUMS
  bun scripts/release/package-manager-manifests.ts --version 0.1.0 --sha256sums /tmp/SHA256SUMS --out-dir /tmp/out
  cat /tmp/out/nimbus.rb /tmp/out/nimbus.json
  ```
  Expected: a valid formula + a `JSON.parse`-able manifest with the four hashes wired in.

---

## Notes for the implementer

- **No `any`** (CLAUDE.md non-negotiable #7). Use `unknown` + narrowing for parsed JSON in tests.
- **Dependency boundary** (CLAUDE.md): `cli` must not import gateway source — that is why Task 3 ships a CLI-local copy of the channel resolver rather than importing the gateway module. The two copies are tiny pure functions; this duplication is the architecturally-correct choice, not a smell to refactor away.
- **Cross-platform paths:** use `join()` / `tmpdir()` in tests (never hardcoded separators); `bun run audit:cross-platform` flags violations.
- **Coverage gates:** new gateway code lands under the `config` (≥80%) + `updater` (≥80%) gates; new CLI code under the CLI suite; the new `scripts/` module is covered by its own `.test.ts` under the per-file coverage floor. Keep each new file ≥80% line+branch (the `audit:coverage-floor` ratchet is CI-Linux-authoritative).
- **This slice intentionally touches gateway/CLI** only for §6.1 coexistence — the smallest change that makes brew/scoop correct. Everything else is release infra.
```
