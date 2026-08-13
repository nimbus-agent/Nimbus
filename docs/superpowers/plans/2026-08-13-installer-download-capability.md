# Installer Download Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the published `install.sh` / `install.ps1` able to download what they install (#1167), and give `nimbus doctor` a remedy that works on the headless Linux boxes it targets (#1168).

**Architecture:** Each installer gains a second mode. With binaries beside it, behaviour is unchanged; with none, it resolves the latest release tag by following the `/releases/latest` redirect, downloads the platform archive from `/releases/download/<tag>/<name>`, verifies it against `SHA256SUMS` (mandatory) and `SHA256SUMS.asc` (best-effort, embedded key), extracts to a temp dir, and hands off to the existing install logic. Pure URL/asset logic lives in a testable TypeScript module; the scripts themselves are proven by a locally-served fake release and, post-release, by the real one.

**Tech Stack:** POSIX `sh`, Windows PowerShell 5.1 **and** PowerShell 7, TypeScript on Bun, GitHub Actions.

**Spec:** [`docs/superpowers/specs/2026-08-13-installer-download-capability-design.md`](../specs/2026-08-13-installer-download-capability-design.md)
**Review + response:** [`…-design-review.md`](../specs/2026-08-13-installer-download-capability-design-review.md) · [`…-design-review-response.md`](../specs/2026-08-13-installer-download-capability-design-review-response.md)

## Scope note

This plan covers two independent subsystems — Part A (installer) and Part B
(doctor). They share a PR at the user's direction, alongside 11 already-built
Sentry indexing commits. **Part B can be executed and reviewed independently of
Part A**; if the PR grows unwieldy, split Part B out first — it has no code
dependency on Part A.

## Global Constraints

- **Trust:** SHA-256 verification is **mandatory** and aborts on mismatch. GPG is
  best-effort; when it does not run, the script must say so. Never print a
  signature claim that was not earned.
- **Pinned fingerprint:** `5A20457CCD8B53FFAA945240886ADA6B487CAB6E` (same value
  as `scripts/release/nimbus-verify.sh`).
- **One base URL:** every asset is fetched from `/releases/download/<tag>/<name>`
  after the tag is resolved. Never `/releases/latest/download/` — that ignores
  `--from-release <ver>`.
- **No asset renaming.** The unversioned names are load-bearing for docs.
- **PowerShell floor: 5.1.** `#Requires` is inert under `iex`; the check must be
  a runtime one. TLS 1.2 must be set explicitly; `Invoke-WebRequest` needs
  `-UseBasicParsing`.
- **Local mode must not regress.** It is the only path that works today.
- **No `any`** (non-negotiable #7). External data is `unknown`.
- **Cross-platform paths** — `path.join()`, never hardcoded separators.
- Branch is `dev/asafgolombek/incident-attribution`. Never commit on `main`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/install/lib/release-assets.ts` | **Create.** Pure: platform → asset name, tag → URL. No I/O. |
| `scripts/install/lib/release-assets.test.ts` | **Create.** Unit tests for the above. |
| `scripts/install/lib/release-assets-drift.test.ts` | **Create.** Asserts every requested asset is staged by `release.yml`. |
| `scripts/install/install-remote.test.ts` | **Create.** Spawns `install.sh` against a locally served fake release. |
| `scripts/install/serve-fixture.ts` | **Create.** One cross-platform fixture server for the CI job (no Python dependency). |
| `scripts/install/unix/install.sh` | **Modify.** Add remote mode. |
| `scripts/install/windows/install.ps1` | **Modify.** Add remote mode + 5.1 support. |
| `packages/cli/src/commands/doctor-core.ts` | **Modify.** Arg parsing + `--fix-keyring`. |
| `packages/cli/src/commands/doctor-fix-keyring.ts` | **Create.** The keyring remedy, DI-shaped. |
| `packages/cli/src/commands/doctor-fix-keyring.test.ts` | **Create.** Refusal + permissions tests. |
| `.github/workflows/install-smoke.yml` | **Modify.** Served-release job + 5.1 leg. |
| `.github/workflows/released-install-smoke.yml` | **Modify.** Real one-liner. |
| `docs/install.md`, `docs/README.md` | **Modify.** `dpkg -i` → `apt install`. |
| `.github/workflows/release.yml` | **Modify.** Correct the stale staging comment. |

---

# Part A — the downloading installer (#1167)

### Task 1: Pure asset + URL resolution

**Files:**
- Create: `scripts/install/lib/release-assets.ts`
- Test: `scripts/install/lib/release-assets.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type InstallTarget = { os: "linux" | "darwin" | "win32"; arch: "x64" | "arm64" }`;
  `assetNameFor(target: InstallTarget, version: string): string` (throws on an
  unpublished combination); `assetUrl(repo: string, tag: string, name: string): string`;
  `SUPPORTED_TARGETS: readonly InstallTarget[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { assetNameFor, assetUrl, SUPPORTED_TARGETS } from "./release-assets.ts";

test("linux x64 asset name carries the version", () => {
  expect(assetNameFor({ os: "linux", arch: "x64" }, "2.2.0")).toBe(
    "nimbus-headless-linux-amd64-v2.2.0.tar.gz",
  );
});

test("macOS and Windows asset names are unversioned", () => {
  expect(assetNameFor({ os: "darwin", arch: "arm64" }, "2.2.0")).toBe(
    "nimbus-headless-macos-arm64.tar.gz",
  );
  expect(assetNameFor({ os: "darwin", arch: "x64" }, "2.2.0")).toBe(
    "nimbus-headless-macos-x64.tar.gz",
  );
  expect(assetNameFor({ os: "win32", arch: "x64" }, "2.2.0")).toBe(
    "nimbus-headless-windows-x64.zip",
  );
});

test("linux arm64 is not published and must fail loudly", () => {
  expect(() => assetNameFor({ os: "linux", arch: "arm64" }, "2.2.0")).toThrow(
    /no Linux arm64 build is published/,
  );
});

// The whole point of the review's finding #2: a pinned version must be honoured
// on EVERY platform, including the ones whose asset name has no version in it.
test("every supported target resolves under the tag-pinned base", () => {
  for (const target of SUPPORTED_TARGETS) {
    const url = assetUrl("nimbus-agent/Nimbus", "v2.1.0", assetNameFor(target, "2.1.0"));
    expect(url).toStartWith("https://github.com/nimbus-agent/Nimbus/releases/download/v2.1.0/");
    expect(url).not.toContain("/releases/latest/");
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/install/lib/release-assets.test.ts`
Expected: FAIL — cannot resolve module `./release-assets.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface InstallTarget {
  readonly os: "linux" | "darwin" | "win32";
  readonly arch: "x64" | "arm64";
}

/** Every (os, arch) the release workflow actually publishes an archive for. */
export const SUPPORTED_TARGETS: readonly InstallTarget[] = [
  { os: "linux", arch: "x64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "arm64" },
  { os: "win32", arch: "x64" },
];

/**
 * Only the Linux tarball carries the version in its filename. The others are
 * deliberately unversioned so docs can link them across releases — see the
 * aliasing block in release.yml. Do NOT "harmonise" these names.
 */
export function assetNameFor(target: InstallTarget, version: string): string {
  const { os, arch } = target;
  if (os === "linux" && arch === "x64") {
    return `nimbus-headless-linux-amd64-v${version}.tar.gz`;
  }
  if (os === "linux") {
    throw new Error(
      "no Linux arm64 build is published — build from source, or use x64 emulation",
    );
  }
  if (os === "darwin") return `nimbus-headless-macos-${arch}.tar.gz`;
  if (os === "win32" && arch === "x64") return "nimbus-headless-windows-x64.zip";
  throw new Error(`unsupported target: ${os}/${arch}`);
}

/**
 * Always the tag-pinned base. `/releases/latest/download/` would silently ignore
 * a pinned --from-release on macOS and Windows, whose asset names carry no
 * version to disambiguate.
 */
export function assetUrl(repo: string, tag: string, name: string): string {
  return `https://github.com/${repo}/releases/download/${tag}/${name}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/install/lib/release-assets.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/install/lib/release-assets.ts scripts/install/lib/release-assets.test.ts
git commit -m "feat(install): pure release asset + URL resolution"
```

---

### Task 2: Drift test — requested assets must be staged

**Files:**
- Create: `scripts/install/lib/release-assets-drift.test.ts`

**Interfaces:**
- Consumes: `assetNameFor`, `SUPPORTED_TARGETS` from Task 1.
- Produces: nothing importable; a guard.

This is aimed squarely at the #1167 bug class — a promised artifact diverging
from a produced one.

- [ ] **Step 1: Write the test**

```ts
import { expect, test } from "bun:test";
import { assetNameFor, SUPPORTED_TARGETS } from "./release-assets.ts";

const WORKFLOW = "\.github/workflows/release.yml";

test("every asset the installer requests is produced by release.yml", async () => {
  const yaml = await Bun.file(WORKFLOW).text();
  for (const target of SUPPORTED_TARGETS) {
    // Version is a placeholder: strip it so the linux name matches the
    // workflow's `${V}`-interpolated form.
    const name = assetNameFor(target, "0.0.0").replace("-v0.0.0", "");
    const stem = name.replace(/\.tar\.gz$|\.zip$/, "");
    expect(yaml).toContain(stem);
  }
});

test("SHA256SUMS is staged, since verification is mandatory", async () => {
  const yaml = await Bun.file(WORKFLOW).text();
  expect(yaml).toContain("SHA256SUMS");
});
```

- [ ] **Step 2: Red-prove it**

Temporarily add `{ os: "linux", arch: "x64" }` renamed to a bogus stem in
`assetNameFor` (e.g. return `"nimbus-headless-linux-BOGUS.tar.gz"`), run the
test, and confirm it FAILS. Revert the edit.

Run: `bun test scripts/install/lib/release-assets-drift.test.ts`
Expected: FAIL while bogus, PASS after revert. **A guard never observed failing
is not a guard.**

- [ ] **Step 3: Commit**

```bash
git add scripts/install/lib/release-assets-drift.test.ts
git commit -m "test(install): assert requested assets are staged by release.yml"
```

---

### Task 3: `install.sh` remote mode

**Files:**
- Modify: `scripts/install/unix/install.sh`
- Test: `scripts/install/install-remote.test.ts` (created here)

**Interfaces:**
- Consumes: nothing from earlier tasks (the shell script is standalone by
  design — see the spec's "one file" constraint).
- Produces: env seam `NIMBUS_INSTALL_BASE_URL` (testing-only) and flags
  `--from-release [<ver>]`, `--local`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isWindows = process.platform === "win32";

/** Serves a fake release: one tarball plus a matching SHA256SUMS. */
async function serveFakeRelease(dir: string, tarballName: string) {
  const tarball = await Bun.file(join(dir, tarballName)).arrayBuffer();
  const digest = new Bun.CryptoHasher("sha256").update(tarball).digest("hex");
  const sums = `${digest}  ${tarballName}\n`;
  return Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/SHA256SUMS")) return new Response(sums);
      if (path.endsWith(`/${tarballName}`)) return new Response(tarball);
      return new Response("not found", { status: 404 });
    },
  });
}

test.skipIf(isWindows)("install.sh installs from a served release", async () => {
  const work = await mkdtemp(join(tmpdir(), "nimbus-remote-"));
  const home = join(work, "home");
  const payload = join(work, "payload");
  await mkdir(join(payload, "bin"), { recursive: true });
  await mkdir(home, { recursive: true });

  // A stand-in for the real binaries: install.sh only copies and chmods them.
  for (const name of ["nimbus", "nimbus-gateway"]) {
    const p = join(payload, "bin", name);
    await writeFile(p, "#!/bin/sh\necho 2.2.0\n");
    await chmod(p, 0o755);
  }
  const tarballName = "nimbus-headless-linux-amd64-v2.2.0.tar.gz";
  await Bun.$`tar -czf ${join(work, tarballName)} -C ${payload} .`.quiet();

  const server = await serveFakeRelease(work, tarballName);
  try {
    const proc = Bun.spawnSync(
      ["sh", "scripts/install/unix/install.sh", "--from-release", "2.2.0", "--yes"],
      {
        env: {
          ...process.env,
          HOME: home,
          NIMBUS_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}`,
        },
      },
    );
    expect(proc.stderr.toString() + proc.stdout.toString()).not.toContain("cannot locate");
    expect(proc.exitCode).toBe(0);
    expect(await Bun.file(join(home, ".local", "bin", "nimbus")).exists()).toBe(true);
  } finally {
    server.stop(true);
  }
});

test.skipIf(isWindows)("install.sh aborts on a tampered archive", async () => {
  const work = await mkdtemp(join(tmpdir(), "nimbus-tamper-"));
  const home = join(work, "home");
  await mkdir(home, { recursive: true });
  const tarballName = "nimbus-headless-linux-amd64-v2.2.0.tar.gz";
  await writeFile(join(work, tarballName), "not a real tarball");

  // SHA256SUMS advertises a digest that does not match the served bytes.
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/SHA256SUMS")) {
        return new Response(`${"0".repeat(64)}  ${tarballName}\n`);
      }
      return new Response("not a real tarball");
    },
  });
  try {
    const proc = Bun.spawnSync(
      ["sh", "scripts/install/unix/install.sh", "--from-release", "2.2.0", "--yes"],
      {
        env: {
          ...process.env,
          HOME: home,
          NIMBUS_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}`,
        },
      },
    );
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toMatch(/checksum|sha256/i);
    expect(await Bun.file(join(home, ".local", "bin", "nimbus")).exists()).toBe(false);
  } finally {
    server.stop(true);
  }
});
```

- [ ] **Step 2: Run to verify both fail**

Run: `bun test scripts/install/install-remote.test.ts`
Expected: FAIL — the script exits 1 with `cannot locate 'nimbus' …`, because
remote mode does not exist yet. The tamper test currently "passes for the wrong
reason" (it exits non-zero because there are no local binaries), so **also
confirm the tamper test fails once remote mode lands but before the checksum
check is added** — that ordering is what proves the check, not the absence of
binaries.

- [ ] **Step 3: Implement remote mode**

Insert after the argument-parsing loop, replacing the binary-location block at
`scripts/install/unix/install.sh:33-44`:

```sh
REPO="nimbus-agent/Nimbus"
BASE_URL="${NIMBUS_INSTALL_BASE_URL:-}"   # testing seam; unset in real use
MODE="auto"
WANT_VERSION=""
DOWNLOAD_DIR=""

# A temp dir must not survive a failed or interrupted install. Each path is
# guarded before removal: an unset variable would make this `rm -rf ""`, which
# is harmless today but is one edit away from not being.
cleanup() {
  [ -n "${DOWNLOAD_DIR:-}" ] && [ -d "${DOWNLOAD_DIR:-}" ] && rm -rf "$DOWNLOAD_DIR"
  [ -n "${GNUPGHOME:-}" ] && [ -d "${GNUPGHOME:-}" ] && rm -rf "$GNUPGHOME"
  return 0
}
trap cleanup EXIT INT TERM

resolve_latest_tag() {
  # Follow the /releases/latest redirect. No GitHub API: unauthenticated it is
  # 60 req/hour per IP, shared across CI runners.
  effective="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/${REPO}/releases/latest")" || return 1
  printf '%s\n' "${effective##*/}"
}

detect_asset() {
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in
    Linux)
      case "$arch" in
        x86_64|amd64) printf 'nimbus-headless-linux-amd64-v%s.tar.gz\n' "$1" ;;
        *) echo "Error: no Linux $arch build is published — build from source, or use x64 emulation" >&2; return 1 ;;
      esac ;;
    Darwin)
      case "$arch" in
        arm64) echo "nimbus-headless-macos-arm64.tar.gz" ;;
        x86_64) echo "nimbus-headless-macos-x64.tar.gz" ;;
        *) echo "Error: no macOS $arch build is published" >&2; return 1 ;;
      esac ;;
    *) echo "Error: unsupported OS: $os" >&2; return 1 ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else echo "Error: neither sha256sum nor shasum found; cannot verify download" >&2; return 1
  fi
}

fetch_release() {
  version="$1"
  if [ -z "$version" ]; then
    # Resolution is the one network step with no fallback, so its failure message
    # must name the escape hatch: --from-release skips resolution entirely, which
    # is what a proxied or policy-restricted machine needs.
    if ! tag="$(resolve_latest_tag)"; then
      echo "Error: could not resolve the latest release tag (network, proxy or firewall)." >&2
      echo "  Re-run with an explicit version to skip resolution:" >&2
      echo "    --from-release 2.2.0" >&2
      exit 1
    fi
    version="${tag#v}"
  else
    tag="v${version#v}"; version="${tag#v}"
  fi
  asset="$(detect_asset "$version")" || exit 1
  base="${BASE_URL:-https://github.com/${REPO}/releases/download/${tag}}"

  DOWNLOAD_DIR="$(mktemp -d)"
  echo "Downloading ${asset} (${tag})…"
  curl -fsSL "${base}/${asset}"     -o "${DOWNLOAD_DIR}/${asset}"   || { echo "Error: download failed" >&2; exit 1; }
  curl -fsSL "${base}/SHA256SUMS"   -o "${DOWNLOAD_DIR}/SHA256SUMS" || { echo "Error: could not fetch SHA256SUMS" >&2; exit 1; }

  expected="$(grep " ${asset}\$" "${DOWNLOAD_DIR}/SHA256SUMS" | cut -d' ' -f1 | head -n1)"
  actual="$(sha256_of "${DOWNLOAD_DIR}/${asset}")" || exit 1
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "Error: sha256 checksum mismatch for ${asset} — refusing to install." >&2
    rm -rf "$DOWNLOAD_DIR"; exit 1
  fi
  echo "✓ sha256 verified."

  verify_signature "${DOWNLOAD_DIR}" "${base}"

  case "$asset" in
    *.tar.gz) tar -xzf "${DOWNLOAD_DIR}/${asset}" -C "${DOWNLOAD_DIR}" ;;
    *) echo "Error: unexpected archive type: $asset" >&2; exit 1 ;;
  esac
  SCRIPT_DIR="$DOWNLOAD_DIR"
}

for arg in "$@"; do
  case "$arg" in
    --local) MODE="local" ;;
    --from-release) MODE="remote" ;;
    --from-release=*) MODE="remote"; WANT_VERSION="${arg#*=}" ;;
  esac
done

NIMBUS_SRC="${SCRIPT_DIR}/nimbus"
GATEWAY_SRC="${SCRIPT_DIR}/nimbus-gateway"
if [ ! -x "$NIMBUS_SRC" ] || [ ! -x "$GATEWAY_SRC" ]; then
  NIMBUS_SRC="${SCRIPT_DIR}/bin/nimbus"; GATEWAY_SRC="${SCRIPT_DIR}/bin/nimbus-gateway"
fi
if { [ ! -x "$NIMBUS_SRC" ] || [ ! -x "$GATEWAY_SRC" ]; } && [ "$MODE" != "local" ]; then
  fetch_release "$WANT_VERSION"
  NIMBUS_SRC="${SCRIPT_DIR}/nimbus"; GATEWAY_SRC="${SCRIPT_DIR}/nimbus-gateway"
  if [ ! -x "$NIMBUS_SRC" ] || [ ! -x "$GATEWAY_SRC" ]; then
    NIMBUS_SRC="${SCRIPT_DIR}/bin/nimbus"; GATEWAY_SRC="${SCRIPT_DIR}/bin/nimbus-gateway"
  fi
fi
if [ ! -x "$NIMBUS_SRC" ] || [ ! -x "$GATEWAY_SRC" ]; then
  echo "Error: cannot locate 'nimbus' or 'nimbus-gateway' beside $0, and no release could be fetched" >&2
  exit 1
fi
```

Also extend the argument parser's `case` (line 14-31) to accept `--local`,
`--from-release`, and `--from-release=<ver>` so they no longer hit the
`Unknown argument` branch, and take `--from-release <ver>`'s value.

- [ ] **Step 4: Fix the piped-stdin prompt**

Under `curl … | sh`, stdin is the script; today's `read -r answer` would consume
script text. Replace both prompt sites (lines 71-78 and 83-90) with:

```sh
prompt_yes_no() {
  # $1 = prompt text. Returns 0 for yes.
  if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
  if [ -r /dev/tty ]; then
    printf '%s' "$1" > /dev/tty
    read -r reply < /dev/tty
  elif [ -t 0 ]; then
    printf '%s' "$1"
    read -r reply
  else
    echo "Refusing to prompt with no terminal — re-run with --yes." >&2
    exit 1
  fi
  case "$reply" in y|Y|yes) return 0 ;; *) return 1 ;; esac
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test scripts/install/install-remote.test.ts`
Expected: PASS, both tests.

- [ ] **Step 6: Confirm local mode did not regress**

Run: `bun test scripts/install/`
Expected: PASS. Then manually stage binaries beside a copy of the script and run
it with `--yes`, confirming it never touches the network.

- [ ] **Step 7: Commit**

```bash
git add scripts/install/unix/install.sh scripts/install/install-remote.test.ts
git commit -m "feat(install): download capability for install.sh"
```

---

### Task 4: `install.ps1` remote mode + PowerShell 5.1 support

**Files:**
- Modify: `scripts/install/windows/install.ps1`

**Interfaces:**
- Consumes: nothing.
- Produces: same flags/seam as Task 3, plus `-FromRelease <ver>` / `-Local`.

**Verified runtime differences — do not infer these, they were measured:**

| | PS 5.1 | PS 7.6 |
| --- | --- | --- |
| `BaseResponse` type | `System.Net.HttpWebResponse` | `System.Net.Http.HttpResponseMessage` |
| `.RequestMessage` | **`<NULL>`** | resolved URI |
| `.ResponseUri` | resolved URI | **absent** |

- [ ] **Step 1: Replace the throwing script-root resolution**

`scripts/install/windows/install.ps1:19` currently does
`Split-Path -Parent $MyInvocation.MyCommand.Path`, which throws under
`irm | iex` because the path is `$null`. Replace with:

```powershell
# Under `irm | iex` there is no script file, so every script-path variable is
# null. That is REMOTE mode, not an error — the null-deref here was #1167.
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot }
             elseif ($PSCommandPath) { Split-Path -Parent $PSCommandPath }
             else { $null }
```

Every later use of `$ScriptDir` must tolerate `$null` (use `if ($ScriptDir) { Join-Path … }`).

- [ ] **Step 2: Add the runtime version floor and TLS**

`#Requires -Version 7.0` on line 1 is inert under `iex` — verified: on
5.1.26100.9168, `Invoke-Expression "#Requires -Version 7.0\`nWrite-Host RAN-ANYWAY"`
prints `RAN-ANYWAY`. Lower the declared requirement to the supported floor and
add a runtime check:

```powershell
if ($PSVersionTable.PSVersion -lt [Version]"5.1") {
  throw "Nimbus requires Windows PowerShell 5.1 or later. Found $($PSVersionTable.PSVersion)."
}
# 5.1 does not reliably negotiate TLS 1.2 by default; GitHub requires it.
if ($PSVersionTable.PSVersion.Major -lt 6) {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}
```

- [ ] **Step 3: Add cross-runtime redirect resolution + download**

```powershell
function Resolve-LatestTag {
  param([string]$Repo)
  $r = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" `
                         -MaximumRedirection 5 -UseBasicParsing
  # 5.1 exposes ResponseUri; 7+ exposes RequestMessage.RequestUri. Probe both —
  # reaching for RequestMessage unconditionally null-derefs on 5.1.
  $uri = if ($r.BaseResponse.PSObject.Properties.Name -contains 'ResponseUri') {
    $r.BaseResponse.ResponseUri
  } elseif ($r.BaseResponse.RequestMessage) {
    $r.BaseResponse.RequestMessage.RequestUri
  } else { $null }
  if (-not $uri) { throw "Could not resolve the latest release tag." }
  return ($uri.ToString() -split '/')[-1]
}

function Get-NimbusRelease {
  param([string]$Version)
  $repo = "nimbus-agent/Nimbus"
  $tag = if ($Version) { "v" + $Version.TrimStart('v') } else { Resolve-LatestTag -Repo $repo }
  $asset = "nimbus-headless-windows-x64.zip"
  $base = if ($env:NIMBUS_INSTALL_BASE_URL) { $env:NIMBUS_INSTALL_BASE_URL }
          else { "https://github.com/$repo/releases/download/$tag" }

  $work = Join-Path ([System.IO.Path]::GetTempPath()) ("nimbus-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  $zip = Join-Path $work $asset
  Write-Host "Downloading $asset ($tag)..."
  Invoke-WebRequest -Uri "$base/$asset"   -OutFile $zip -UseBasicParsing
  Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile (Join-Path $work "SHA256SUMS") -UseBasicParsing

  $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
  $line = Select-String -Path (Join-Path $work "SHA256SUMS") -Pattern ([regex]::Escape($asset)) |
          Select-Object -First 1
  $expected = if ($line) { ($line.Line -split '\s+')[0].ToLower() } else { $null }
  if (-not $expected -or $expected -ne $actual) {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    throw "sha256 checksum mismatch for $asset - refusing to install."
  }
  Write-Host "OK: sha256 verified."

  $dest = Join-Path $work "extracted"
  Expand-Archive -Path $zip -DestinationPath $dest -Force
  return $dest
}
```

- [ ] **Step 4: Wire remote mode into binary resolution, with cleanup**

Where lines 23-29 currently `throw "Cannot locate ..."`, first attempt
`Get-NimbusRelease` unless `-Local` was passed, then re-resolve
`$NimbusSrc` / `$GatewaySrc` from the extracted directory (top level, then `bin\`).

Wrap the download-and-install body in `try`/`finally` so an interrupted or
failed run does not leave the temp tree behind — the PowerShell equivalent of
the shell `trap`:

```powershell
$work = $null
try {
  # ... Get-NimbusRelease assigns $work, verify, extract, install ...
} finally {
  if ($work -and (Test-Path $work)) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
  Remove-Item Env:\GNUPGHOME -ErrorAction SilentlyContinue
}
```

Also give `Resolve-LatestTag` the same actionable failure message as the shell
side — resolution is the one step with no fallback, and `-FromRelease <ver>`
skips it entirely:

```powershell
catch {
  throw "Could not resolve the latest release tag (network, proxy or firewall). " +
        "Re-run with an explicit version to skip resolution: -FromRelease 2.2.0"
}
```

- [ ] **Step 5: Verify on PowerShell 7**

Run: `pwsh -NoProfile -File scripts/install/windows/install.ps1 -DryRun`
Expected: prints the plan and exits 0, no throw.

- [ ] **Step 6: Verify on Windows PowerShell 5.1**

Run: `powershell.exe -NoProfile -File scripts/install/windows/install.ps1 -DryRun`
Expected: prints the plan and exits 0. **This is the leg that has never been
tested; do not skip it.**

- [ ] **Step 7: Verify the `iex` form on 5.1**

```powershell
powershell.exe -NoProfile -Command "& ([scriptblock]::Create((Get-Content -Raw scripts/install/windows/install.ps1))) -DryRun"
```
Expected: exits 0 with no null-path error — the original #1167 repro.

- [ ] **Step 8: Commit**

```bash
git add scripts/install/windows/install.ps1
git commit -m "feat(install): download capability for install.ps1, with PS 5.1 support"
```

---

### Task 5: Embed the signing key and verify best-effort

**Files:**
- Modify: `scripts/install/unix/install.sh`, `scripts/install/windows/install.ps1`

**Interfaces:**
- Consumes: `fetch_release` / `Get-NimbusRelease` from Tasks 3-4.
- Produces: `verify_signature <dir> <base>` (sh) and `Test-NimbusSignature` (ps1).

- [ ] **Step 1: Export the public key**

```bash
gpg --armor --export 5A20457CCD8B53FFAA945240886ADA6B487CAB6E > /tmp/nimbus-signing-key.asc
```

If the key is not in the local keyring, fetch it once with
`gpg --keyserver keys.openpgp.org --recv-keys 5A20457CCD8B53FFAA945240886ADA6B487CAB6E`,
then confirm the fingerprint matches **exactly** before embedding it.

- [ ] **Step 2: Implement the shell side**

```sh
NIMBUS_SIGNING_FPR="5A20457CCD8B53FFAA945240886ADA6B487CAB6E"
# Embedded so no keyserver is contacted. NOTE: this is a RELIABILITY measure,
# not a stronger trust root — an attacker who can swap the script can swap this
# key too. It defends a tampered release asset given an authentic script.
NIMBUS_SIGNING_KEY='-----BEGIN PGP PUBLIC KEY BLOCK-----
<paste the armored key from Step 1 here, verbatim>
-----END PGP PUBLIC KEY BLOCK-----'

skip_signature_notice() {
  # Say exactly what was and was not established. The sha256 manifest came down
  # the same channel as the archive, so it proves integrity, NOT publisher
  # authenticity — do not let the output imply otherwise.
  echo "! $1"
  echo "  Installed after SHA-256 verification only. The checksum manifest was"
  echo "  fetched over the same channel as the archive, so this proves the file"
  echo "  arrived intact — NOT that Nimbus published it."
  echo "  To verify the publisher signature: scripts/release/nimbus-verify.sh --version <ver>"
}

verify_signature() {
  dir="$1"; base="$2"
  # `command -v` succeeds for a broken symlink or a stub. Since signature
  # checking is best-effort, a gpg that cannot run must degrade, not abort.
  if ! command -v gpg >/dev/null 2>&1 || ! gpg --version >/dev/null 2>&1; then
    skip_signature_notice "gpg not found or not runnable — SIGNATURE NOT CHECKED."
    return 0
  fi
  if ! curl -fsSL "${base}/SHA256SUMS.asc" -o "${dir}/SHA256SUMS.asc"; then
    skip_signature_notice "SHA256SUMS.asc unavailable — SIGNATURE NOT CHECKED."
    return 0
  fi
  GNUPGHOME="$(mktemp -d)"; export GNUPGHOME
  printf '%s\n' "$NIMBUS_SIGNING_KEY" | gpg --quiet --import 2>/dev/null
  if gpg --quiet --status-fd 1 --verify "${dir}/SHA256SUMS.asc" "${dir}/SHA256SUMS" 2>/dev/null \
      | grep -q "VALIDSIG ${NIMBUS_SIGNING_FPR}"; then
    echo "✓ GPG signature verified (${NIMBUS_SIGNING_FPR})."
    rm -rf "$GNUPGHOME"; unset GNUPGHOME
  else
    echo "Error: SHA256SUMS.asc did not verify against the pinned Nimbus key — refusing to install." >&2
    rm -rf "$GNUPGHOME" "$dir"; exit 1
  fi
}
```

- [ ] **Step 3: Implement the PowerShell equivalent**

**The key must be written as UTF-8 without a BOM, explicitly.** Measured: on
Windows PowerShell 5.1 `Out-File` writes UTF-16LE with a BOM (`FF FE 2D 00 …`),
while PS7 writes UTF-8 (`2D 2D 2D …`). `gpg --import` cannot parse a UTF-16
armored block, so the embedded key would fail to import on exactly the runtime
we committed to supporting. `-Encoding utf8` is **also** wrong on 5.1 — it emits
a BOM, which `gpg` likewise rejects. Never use `Out-File`, `>`, or a pipeline
into `gpg`.

This path is not rare on Windows: Git for Windows bundles `gpg` and commonly
puts it on `PATH`.

```powershell
function Test-NimbusSignature {
  param([string]$Dir, [string]$Base)

  # Get-Command succeeds for a stub or broken shim; require that it actually runs.
  $gpg = Get-Command gpg -ErrorAction SilentlyContinue
  if (-not $gpg) { Write-NimbusSkipNotice "gpg not found - SIGNATURE NOT CHECKED."; return }
  try { & gpg --version *>$null; if ($LASTEXITCODE -ne 0) { throw } }
  catch { Write-NimbusSkipNotice "gpg is present but not runnable - SIGNATURE NOT CHECKED."; return }

  try {
    Invoke-WebRequest -Uri "$Base/SHA256SUMS.asc" -OutFile (Join-Path $Dir "SHA256SUMS.asc") -UseBasicParsing
  } catch { Write-NimbusSkipNotice "SHA256SUMS.asc unavailable - SIGNATURE NOT CHECKED."; return }

  $home = Join-Path $Dir "gnupg"
  New-Item -ItemType Directory -Path $home -Force | Out-Null
  $keyPath = Join-Path $Dir "nimbus-key.asc"
  # UTF8Encoding($false) == no BOM. This line is the fix; do not simplify it.
  [System.IO.File]::WriteAllText($keyPath, $NimbusSigningKey, [System.Text.UTF8Encoding]::new($false))

  $env:GNUPGHOME = $home
  & gpg --quiet --import $keyPath *>$null
  $out = & gpg --quiet --status-fd 1 --verify (Join-Path $Dir "SHA256SUMS.asc") (Join-Path $Dir "SHA256SUMS") 2>$null
  Remove-Item Env:\GNUPGHOME -ErrorAction SilentlyContinue
  if ($out -match "VALIDSIG $NimbusSigningFpr") {
    Write-Host "OK: GPG signature verified ($NimbusSigningFpr)."
  } else {
    throw "SHA256SUMS.asc did not verify against the pinned Nimbus key - refusing to install."
  }
}
```

`Write-NimbusSkipNotice` prints the same wording as the shell
`skip_signature_notice`: SHA-256 only, manifest fetched over the same channel,
integrity not authenticity, plus the `nimbus-verify` pointer.

- [ ] **Step 3b: Verify the encoding fix on 5.1**

```powershell
powershell.exe -NoProfile -Command "[System.IO.File]::WriteAllText(\"$env:TEMP\k.asc\", '-----BEGIN PGP PUBLIC KEY BLOCK-----', [System.Text.UTF8Encoding]::new(`$false)); [System.IO.File]::ReadAllBytes(\"$env:TEMP\k.asc\")[0..2]"
```
Expected: `45 45 45`-style ASCII bytes (`2D 2D 2D`), **not** `FF FE`.

- [ ] **Step 4: Test the absent-gpg path**

Run the Task 3 tests with `PATH` stripped of `gpg`, and assert the output
contains `SIGNATURE NOT CHECKED` and the install still succeeds. Add this as a
third case in `install-remote.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add scripts/install/unix/install.sh scripts/install/windows/install.ps1 scripts/install/install-remote.test.ts
git commit -m "feat(install): embedded-key GPG verification, best-effort"
```

---

### Task 6: PR-time served-release CI job

**Files:**
- Modify: `.github/workflows/install-smoke.yml`

- [ ] **Step 1: Add the job**

Add a job (not a step inside the existing one) named `served-release-install`,
3-OS matrix, that builds the binaries as the existing job does, packs them into
an archive named exactly as the platform's real asset, computes `SHA256SUMS`,
serves the directory on `127.0.0.1`, and runs the installer with
`NIMBUS_INSTALL_BASE_URL` pointed at it.

**One server implementation, not three.** The first draft used a Python
one-liner on Unix and left Windows as "mirror this", which is both a plan gap
and a second OS-divergent implementation depending on Python being present and
identical on all three runners. Instead, create
`scripts/install/serve-fixture.ts` and use it verbatim on every OS — Bun is
already provisioned on all runners by `.github/actions/setup-nimbus-ci`, and
this reuses the same `Bun.serve` shape as the Task 3 unit test.

```ts
// scripts/install/serve-fixture.ts
// Serves a directory of release fixtures for the install smoke test.
// Usage: bun scripts/install/serve-fixture.ts <dir> <port>
const dir = process.argv[2];
const port = Number(process.argv[3] ?? 8788);
if (!dir) throw new Error("usage: serve-fixture.ts <dir> <port>");

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const name = new URL(req.url).pathname.split("/").pop() ?? "";
    const file = Bun.file(`${dir}/${name}`);
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
console.log(`serving ${dir} on 127.0.0.1:${port}`);
```

Started in the background per OS, with teardown in an `always()` step so a
failed install never orphans the process:

```yaml
      - name: Start the release fixture server
        shell: bash
        run: |
          bun scripts/install/serve-fixture.ts "$RUNNER_TEMP/serve" 8788 &
          echo $! > "$RUNNER_TEMP/serve.pid"
          for _ in $(seq 1 50); do
            curl -fsS "http://127.0.0.1:8788/SHA256SUMS" >/dev/null && break
            sleep 0.2
          done

      # ... install steps ...

      - name: Stop the release fixture server
        if: always()
        shell: bash
        run: kill "$(cat "$RUNNER_TEMP/serve.pid")" 2>/dev/null || true
```

`shell: bash` works on the Windows runner too (Git Bash), so the server
lifecycle is one implementation across the matrix; only the packing and the
installer invocation differ per OS.

The Unix packing + install step, concretely:

```yaml
      - name: Serve a release fixture and install from it (Unix)
        if: runner.os != 'Windows'
        shell: bash
        run: |
          set -euo pipefail
          VER=0.0.0-test
          SERVE="$RUNNER_TEMP/serve"; PAYLOAD="$RUNNER_TEMP/payload"
          mkdir -p "$SERVE" "$PAYLOAD/bin"
          cp packages/cli/dist/nimbus "$PAYLOAD/bin/nimbus"
          cp dist/nimbus-gateway     "$PAYLOAD/bin/nimbus-gateway"
          chmod +x "$PAYLOAD/bin/nimbus" "$PAYLOAD/bin/nimbus-gateway"

          if [ "$RUNNER_OS" = "Linux" ]; then
            ASSET="nimbus-headless-linux-amd64-v${VER}.tar.gz"
          else
            ASSET="nimbus-headless-macos-$( [ "$(uname -m)" = "arm64" ] && echo arm64 || echo x64 ).tar.gz"
          fi
          tar -czf "$SERVE/$ASSET" -C "$PAYLOAD" .
          ( cd "$SERVE" && shasum -a 256 "$ASSET" > SHA256SUMS )

          # Sandboxed HOME so the runner's real profile is untouched.
          export HOME="$RUNNER_TEMP/fakehome"; mkdir -p "$HOME"
          NIMBUS_INSTALL_BASE_URL="http://127.0.0.1:8788" \
            sh scripts/install/unix/install.sh --from-release "$VER" --yes

          test -x "$HOME/.local/bin/nimbus" || { echo "::error::installer did not place the binary"; exit 1; }
          "$HOME/.local/bin/nimbus" --version
```

For Windows, pack `nimbus-headless-windows-x64.zip` with `Compress-Archive`,
write `SHA256SUMS` with `Get-FileHash` (lower-cased, two-space separated to match
the `shasum` format the installer parses), sandbox `$env:LOCALAPPDATA` to
`$env:RUNNER_TEMP\fakelocal`, and invoke the installer with the same
`NIMBUS_INSTALL_BASE_URL`. Run this leg **twice** — once under `shell: pwsh` and
once under `shell: powershell` — per Step 2.

**Naming caution:** `install-smoke.yml` already has a step called *"Stage a fake
release dir"* which serves nothing — it is the local-staging copy. Do not reuse
that name or the workflow will read as if the remote path were already covered.

- [ ] **Step 2: Add the Windows PowerShell 5.1 leg**

The existing Windows steps use `shell: pwsh` (PS7). Add a leg with
`shell: powershell` so 5.1 is actually exercised — a PS7 run proves nothing
about 5.1, since `#Requires` and the redirect properties both differ.

- [ ] **Step 3: Red-prove the job**

Push a commit that deliberately breaks remote mode (e.g. corrupt the asset name),
confirm the new job FAILS, then revert. Record the failing run URL in the PR
description.

- [ ] **Step 4: Confirm no preflight-manifest drift**

Run: `bun test scripts/lib/preflight-gates.test.ts`
Expected: PASS. (No new `bun run` gate is introduced — the new unit tests are
already covered by the `scripts` glob in `test`/`test:ci`. Verify rather than
assume.)

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/install-smoke.yml
git commit -m "ci(install): prove the download path against a served release"
```

---

### Task 7: Post-release verification of the real one-liner

**Files:**
- Modify: `.github/workflows/released-install-smoke.yml`

- [ ] **Step 1: Add the one-liner steps**

Add, alongside the existing archive-based steps, the documented standalone form
per platform:

```yaml
- name: Linux — standalone installer one-liner
  if: runner.os == 'Linux'
  shell: bash
  run: |
    set -euo pipefail
    curl -fsSL https://github.com/nimbus-agent/Nimbus/releases/latest/download/install.sh | sh -s -- --yes
    echo "$HOME/.local/bin" >> "$GITHUB_PATH"
```

Mirror for macOS. For Windows use **both** `shell: pwsh` and `shell: powershell`
legs of:

```powershell
& ([scriptblock]::Create((irm https://github.com/nimbus-agent/Nimbus/releases/latest/download/install.ps1))) -Yes
```

- [ ] **Step 2: Note the gating reality in the workflow comment**

These steps can only pass once a release ships the new scripts. Add a comment
stating that, so a red run on the current `v2.2.0` assets is understood as
expected rather than a regression.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/released-install-smoke.yml
git commit -m "ci(install): verify the documented one-liner post-release"
```

---

# Part B — headless-Linux keyring remedy (#1168)

### Task 8: Container spike — determine the mechanism

**Files:** none (spike). Output is a verified command sequence.

The spec deliberately does not specify the mechanism. Settle it empirically
before writing code.

- [ ] **Step 1: Reproduce the failure**

```bash
docker run --rm -it ubuntu:24.04 bash -c '
  apt-get update -qq && apt-get install -y -qq libsecret-tools gnome-keyring dbus-x11 >/dev/null
  dbus-run-session -- bash -c "echo \"\" | gnome-keyring-daemon --unlock --components=secrets; echo exit=\$?"
'
```
Expected: failure referencing `gcr-prompter` / `cannot open display`.

- [ ] **Step 2: Find the sequence that works**

Try, in order, recording exactly what succeeds:
1. `--unlock` with the password on stdin after pre-creating the directory at `0700`.
2. `gnome-keyring-daemon --start --components=secrets` with `--daemonize`.
3. Pre-creating `~/.local/share/keyrings/` (mode `0700`) plus a `default` file
   naming a keyring, then `--unlock`.

- [ ] **Step 3: Verify end to end**

In the same container, after the candidate sequence, confirm a real write:
`secret-tool store --label=test application nimbus-spike key value <<< "s"`
then `secret-tool lookup application nimbus-spike key`.
Expected: the stored value comes back. **Nothing short of this counts as
working.**

- [ ] **Step 4: Record the result**

Write the verified sequence into
`docs/superpowers/plans/2026-08-13-installer-download-capability.md` under this
task as a fenced block, and commit. Later tasks quote it verbatim.

```bash
git add docs/superpowers/plans/2026-08-13-installer-download-capability.md
git commit -m "docs: record the verified headless keyring sequence"
```

---

### Task 9: `--fix-keyring` implementation

**Files:**
- Create: `packages/cli/src/commands/doctor-fix-keyring.ts`
- Create: `packages/cli/src/commands/doctor-fix-keyring.test.ts`
- Modify: `packages/cli/src/commands/doctor-core.ts` (arg parsing; `runDoctor` at line 440 currently ignores `_args`)

**Interfaces:**
- Consumes: `DoctorVaultExec` (`doctor-core.ts:43`) for command execution.
- Produces: `export interface FixKeyringDeps { readonly exec: DoctorVaultExec; readonly homeDir: () => string; readonly statMode: (p: string) => number | null; readonly mkdirMode: (p: string, mode: number) => void; readonly writeFileMode: (p: string, data: string, mode: number) => void; }`
  and `export function fixKeyring(deps: FixKeyringDeps, opts: { dryRun: boolean }): { exit: number; lines: readonly string[] }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from "bun:test";
import { fixKeyring, type FixKeyringDeps } from "./doctor-fix-keyring.ts";

function deps(overrides: Partial<FixKeyringDeps> = {}): FixKeyringDeps {
  return {
    exec: {
      findSecretTool: () => "/usr/bin/secret-tool",
      lookupStderr: () => "",
      hasBinary: () => true,
      runQuery: () => ({ code: 0, stdout: "", stderr: "" }),
    },
    homeDir: () => "/home/tester",
    statMode: () => null,          // nothing exists yet
    mkdirMode: () => {},
    writeFileMode: () => {},
    ...overrides,
  };
}

test("refuses to touch an existing keyring", () => {
  const created: string[] = [];
  const result = fixKeyring(
    deps({
      statMode: (p) => (p.endsWith("login.keyring") ? 0o600 : 0o700),
      writeFileMode: (p) => { created.push(p); },
    }),
    { dryRun: false },
  );
  expect(result.exit).not.toBe(0);
  expect(result.lines.join("\n")).toMatch(/already exists/i);
  // The whole point: destroying this file would lose every stored credential.
  expect(created).toEqual([]);
});

test("dry run writes nothing but reports the plan", () => {
  const writes: string[] = [];
  const result = fixKeyring(
    deps({
      mkdirMode: (p) => { writes.push(p); },
      writeFileMode: (p) => { writes.push(p); },
    }),
    { dryRun: true },
  );
  expect(writes).toEqual([]);
  expect(result.lines.join("\n")).toMatch(/0700/);
});

test("creates the directory at 0700 and files at 0600", () => {
  const modes = new Map<string, number>();
  fixKeyring(
    deps({
      mkdirMode: (p, m) => modes.set(p, m),
      writeFileMode: (p, _d, m) => modes.set(p, m),
    }),
    { dryRun: false },
  );
  const dir = [...modes.entries()].find(([p]) => p.endsWith("keyrings"));
  expect(dir?.[1]).toBe(0o700);
  for (const [p, m] of modes) if (!p.endsWith("keyrings")) expect(m).toBe(0o600);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/cli/src/commands/doctor-fix-keyring.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `doctor-fix-keyring.ts`**

Implement using the sequence recorded in Task 8. Requirements, all covered by
the tests above: refuse when `login.keyring` exists; `0700` on the directory;
`0600` on files; `dryRun` performs no writes and prints the plan.

- [ ] **Step 4: Wire the flag**

In `doctor-core.ts`, change `runDoctor(_args, deps)` (line 440) to parse `args`.
When `--fix-keyring` is present, run the fixer (honouring `--dry-run`) and
return its exit code **instead of** the normal diagnostic sweep. A plain
`nimbus doctor` must remain read-only — do not call the fixer implicitly.

- [ ] **Step 5: Run the tests**

Run: `bun test packages/cli/src/commands/doctor-fix-keyring.test.ts packages/cli/src/commands/doctor-core.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove it in the container**

Re-run the Task 8 container, install the built CLI, run
`nimbus doctor --fix-keyring`, then confirm a real `secret-tool store` +
`lookup` round-trip succeeds.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/doctor-fix-keyring.ts packages/cli/src/commands/doctor-fix-keyring.test.ts packages/cli/src/commands/doctor-core.ts
git commit -m "feat(cli): nimbus doctor --fix-keyring"
```

---

### Task 10: Point the remedy at the new command

**Files:**
- Modify: `packages/cli/src/commands/doctor-core.ts:80-81`

- [ ] **Step 1: Replace `VAULT_UNLOCK_HINT`**

The current string tells a headless user to run a `gnome-keyring-daemon --unlock`
sequence that **cannot work** on a box with no login keyring. Replace it with a
pointer to `nimbus doctor --fix-keyring` plus the verified sequence from Task 8.

Only the `no-collection` (and, if the spike shows it applies, `locked`) states
should mention `--fix-keyring`; `no-session-bus` and `not-installed` have
different causes and must not print a remedy that does not address them.

- [ ] **Step 2: Update the affected tests**

Run: `bun test packages/cli/src/commands/doctor-vault.test.ts`
Fix assertions that pin the old hint text.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/commands/doctor-core.ts packages/cli/src/commands/doctor-vault.test.ts
git commit -m "fix(cli): a headless-Linux vault remedy that works"
```

---

# Part C — docs, release wiring, and the PR

### Task 11: Correct the stale docs and release comment

**Files:**
- Modify: `docs/install.md:31`, `docs/README.md:362`, `.github/workflows/release.yml:625-633`

- [ ] **Step 1: Fix `dpkg -i`**

Both surfaces still document `sudo dpkg -i`, which exits 1 leaving the package
unconfigured — the `.deb` depends on `bubblewrap` and `libcap2-bin`. #1169 fixed
the root `README.md` and `install.mdx` and missed these two. Change to
`sudo apt install ./<file>.deb`, matching the comment already in
`released-install-smoke.yml`.

- [ ] **Step 2: Correct the release.yml comment**

Lines 625-633 justify staging the standalone scripts by citing a README
quickstart that #1169 deleted. Replace with the real reason: the scripts are
self-bootstrapping and the standalone assets are the documented remote-install
entry point.

- [ ] **Step 3: Do NOT restore the one-liner to the docs**

Deliberate — see the spec's Sequencing section. The capability is only true for
users after the next release; promising it now repeats #1167. A follow-up PR
restores it once `released-install-smoke` is green against a real release.

- [ ] **Step 4: Verify docs gates**

Run: `bun run lint:markdown && bun run audit:doc-refs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/install.md docs/README.md .github/workflows/release.yml
git commit -m "docs: apt, not dpkg -i; correct the installer staging rationale"
```

---

### Task 12: CHANGELOG, preflight, and the PR

- [ ] **Step 1: Add CHANGELOG entries**

`docs/CHANGELOG.md`, under "Post-Phase-6 deliveries", newest first. One entry
for the installer capability, one for `--fix-keyring`. The Sentry entry is
already present from the rebased commits — do not duplicate it.

- [ ] **Step 2: Run the full preflight**

Run: `bun run preflight`
Expected: PASS. Do not pipe it — `| tail` hides the exit code and has previously
reported "exit 0" on a failing run.

- [ ] **Step 3: Docker-verify the Linux-authoritative gates**

Run: `bun run verify:docker`
Expected: PASS. Coverage-floor is CI-Linux-authoritative; a Windows-local pass
does not count.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin dev/asafgolombek/incident-attribution
```

PR title (this is the squash commit subject, and what release-please parses):

```
feat(connectors): index Sentry issues, and make the published installers able to install
```

The description must carry, as its own section, the installer fix and the
doctor fix — a `feat(connectors)` title otherwise buries them in the changelog.
Include the red-prove run URL from Task 6 Step 3. Do **not** include a bare
`Release-As:` line.

- [ ] **Step 5: Verify CI honestly**

Run: `bun run verify:pr`
Expected: refuses to call a conflicted or pending PR green. Read **all** review
threads, never `| head` — a partial view has previously led to resolving threads
that were never seen.

---

## After merge — not part of this plan's tasks, but required

These close the loop the spec's Sequencing section opens. Track them; the work
is not finished when the PR merges.

1. **Cut a release.** The capability reaches users only in a published artifact.
2. **Hand-dispatch `released-install-smoke.yml`.** Its `release:` trigger has
   never fired — the workflow merged after `v2.2.0` was published — so it ships
   unproven until someone runs it manually via `workflow_dispatch`.
3. **Only once that is green,** open the follow-up PR restoring the
   `curl | sh` / `irm | iex` one-liner to `README.md` and `install.mdx`.
4. **Close #1167 and #1168** against that follow-up, not against this PR — this
   PR makes the scripts capable; step 3 is what makes the documented path true
   again.
