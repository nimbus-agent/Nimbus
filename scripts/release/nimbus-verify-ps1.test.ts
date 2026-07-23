import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const toUnix = (p: string) => p.replaceAll("\\", "/");
const toMsys2 = (p: string) =>
  p.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`).replaceAll("\\", "/");
const VERIFY_PS1 = toUnix(join(REPO_ROOT, "scripts", "release", "nimbus-verify.ps1"));
const GEN_KEY = toUnix(join(REPO_ROOT, "scripts", "release", "fixtures", "gen-test-key.sh"));

const IS_WIN = process.platform === "win32";

const WHERE_CMD = IS_WIN ? String.raw`C:\Windows\System32\where.exe` : "/usr/bin/which";
const BASH_BIN = IS_WIN ? "bash" : "/bin/bash";
function resolveBin(candidates: readonly string[]): string {
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0] ?? "";
}
const GPG_BIN = IS_WIN
  ? "gpg"
  : resolveBin(["/usr/bin/gpg", "/opt/homebrew/bin/gpg", "/usr/local/bin/gpg"]);

const PWSH_EXE = (() => {
  const r = spawnSync(WHERE_CMD, ["pwsh"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.trim().split(/\r?\n/)[0] ?? null;
})();

const HAS_PWSH = PWSH_EXE !== null;

if (!HAS_PWSH) {
  console.warn(
    "[nimbus-verify.ps1 tests] SKIPPED: 'pwsh' (PowerShell 7+) not found on PATH.\n" +
      "  - Install hint: macOS 'brew install powershell', Linux via https://learn.microsoft.com/powershell/,\n" +
      "    Windows 'winget install Microsoft.PowerShell'.\n" +
      "  - Windows PowerShell 5.1 (built-in, powershell.exe) is NOT supported for nimbus-verify.ps1.",
  );
}

// Dummy release artifacts the fixture writes + lists in SHA256SUMS. Includes the
// three native installers wired into release.yml (Task 7) so the verifier is
// exercised over real release-asset filenames, not just hello.bin.
const ARTIFACTS = [
  "hello.bin",
  "nimbus-headless-windows-x64.msi",
  "nimbus-headless-macos-arm64.pkg",
  "nimbus-headless-0.5.0-x86_64.rpm",
] as const;

let work: string;
let gnupghome: string;
let cwd: string;
let fingerprint: string;

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    PWSH_EXE ?? "",
    ["-NoProfile", "-NonInteractive", "-File", VERIFY_PS1, ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GNUPGHOME: toMsys2(gnupghome),
        NIMBUS_VERIFY_FINGERPRINT_OVERRIDE: fingerprint,
      },
    },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
  if (!HAS_PWSH) return;
  work = mkdtempSync(join(tmpdir(), "nimbus-verify-ps1-"));
  gnupghome = join(work, "gnupg");
  cwd = join(work, "cwd");
  mkdirSync(cwd, { recursive: true });

  const genRes = spawnSync(BASH_BIN, [GEN_KEY, toMsys2(gnupghome)], { encoding: "utf8" });
  if (genRes.status !== 0) throw new Error(`gen-test-key.sh failed: ${genRes.stderr}`);
  fingerprint = genRes.stdout.trim();

  // Write one dummy file per artifact and build a SHA256SUMS over all of them.
  let manifest = "";
  for (const name of ARTIFACTS) {
    writeFileSync(join(cwd, name), `dummy bytes for ${name}`, "utf8");
    const bytes = readFileSync(join(cwd, name));
    const hashHex = createHash("sha256").update(bytes).digest("hex");
    manifest += `${hashHex}  ${name}\n`;
  }
  writeFileSync(join(cwd, "SHA256SUMS"), manifest, "utf8");
  spawnSync(
    GPG_BIN,
    [
      "--batch",
      "--yes",
      "--pinentry-mode",
      "loopback",
      "--detach-sign",
      "--armor",
      "--output",
      toUnix(join(cwd, "SHA256SUMS.asc")),
      toUnix(join(cwd, "SHA256SUMS")),
    ],
    { env: { ...process.env, GNUPGHOME: toMsys2(gnupghome) } },
  );
});

afterEach(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

const PWSH_TEST_TIMEOUT_MS = 30000;

test.skipIf(!HAS_PWSH)(
  "ps1: exits 0 for valid chain with -NoFetch",
  () => {
    const r = run(["-NoFetch"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("✅");
    for (const name of ARTIFACTS) {
      expect(r.stdout).toContain(name);
    }
  },
  PWSH_TEST_TIMEOUT_MS,
);

test.skipIf(!HAS_PWSH)(
  "ps1: exits 1 for tampered manifest",
  () => {
    const manifest = readFileSync(join(cwd, "SHA256SUMS"), "utf8");
    const tampered = manifest.replace(/^[0-9a-f]/, (c) => (c === "a" ? "b" : "a"));
    writeFileSync(join(cwd, "SHA256SUMS"), tampered, "utf8");
    const r = run(["-NoFetch"]);
    expect(r.status).toBe(1);
  },
  PWSH_TEST_TIMEOUT_MS,
);

test.skipIf(!HAS_PWSH)(
  "ps1: exits 2 when SHA256SUMS missing with -NoFetch",
  () => {
    rmSync(join(cwd, "SHA256SUMS"));
    const r = run(["-NoFetch"]);
    expect(r.status).toBe(2);
  },
  PWSH_TEST_TIMEOUT_MS,
);

test.skipIf(!HAS_PWSH)(
  "ps1: prints imported fingerprint for bootstrap trust",
  () => {
    const r = run(["-NoFetch"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(fingerprint);
  },
  PWSH_TEST_TIMEOUT_MS,
);
