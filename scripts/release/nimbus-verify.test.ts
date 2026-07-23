import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shellTest = process.platform === "win32" ? test.skip : test;

const REPO_ROOT = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const toUnix = (p: string) => p.replaceAll("\\", "/");

const IS_WIN = process.platform === "win32";
function resolveBin(candidates: readonly string[]): string {
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0] ?? "";
}
const BASH_BIN = IS_WIN ? "bash" : "/bin/bash";
const GPG_BIN = IS_WIN
  ? "gpg"
  : resolveBin(["/usr/bin/gpg", "/opt/homebrew/bin/gpg", "/usr/local/bin/gpg"]);
const VERIFY_SH = toUnix(join(REPO_ROOT, "scripts", "release", "nimbus-verify.sh"));
const GEN_KEY = toUnix(join(REPO_ROOT, "scripts", "release", "fixtures", "gen-test-key.sh"));

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

function run(
  args: string[],
  opts: { env?: Record<string, string> } = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(BASH_BIN, [VERIFY_SH, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GNUPGHOME: gnupghome,
      NIMBUS_VERIFY_FINGERPRINT_OVERRIDE: fingerprint, // injects the test key's fp
      ...opts.env,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Primary (master) fingerprints in a keyring. `--with-colons` emits a `pub`
// record followed immediately by its `fpr` record (field 10 = fingerprint);
// subkey `fpr` records follow a `sub` record and are skipped here.
function primaryFingerprints(home: string): string[] {
  const out = spawnSync(GPG_BIN, ["--list-keys", "--with-colons"], {
    encoding: "utf8",
    env: { ...process.env, GNUPGHOME: home },
  }).stdout;
  const fps: string[] = [];
  let afterPub = false;
  for (const line of out.split("\n")) {
    if (line.startsWith("pub:")) {
      afterPub = true;
    } else if (afterPub && line.startsWith("fpr:")) {
      fps.push(line.split(":")[9] ?? "");
      afterPub = false;
    }
  }
  return fps;
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "nimbus-verify-test-"));
  gnupghome = join(work, "gnupg");
  cwd = join(work, "cwd");
  mkdirSync(cwd, { recursive: true });

  const genRes = spawnSync(BASH_BIN, [GEN_KEY, gnupghome], { encoding: "utf8" });
  if (genRes.status !== 0) {
    throw new Error(`gen-test-key.sh failed: ${genRes.stderr}`);
  }
  fingerprint = genRes.stdout.trim();
  if (!/^[0-9A-F]{40}$/.test(fingerprint)) {
    throw new Error(`unexpected fingerprint from gen-test-key.sh: "${fingerprint}"`);
  }

  // Write one dummy file per artifact and build a SHA256SUMS over all of them.
  let manifest = "";
  for (const name of ARTIFACTS) {
    writeFileSync(join(cwd, name), `dummy bytes for ${name}`, "utf8");
    const bytes = readFileSync(join(cwd, name));
    const hashHex = createHash("sha256").update(bytes).digest("hex");
    manifest += `${hashHex}  ${name}\n`;
  }
  writeFileSync(join(cwd, "SHA256SUMS"), manifest, "utf8");
  const sign = spawnSync(
    GPG_BIN,
    [
      "--batch",
      "--yes",
      "--pinentry-mode",
      "loopback",
      "--detach-sign",
      "--armor",
      "--output",
      join(cwd, "SHA256SUMS.asc"),
      join(cwd, "SHA256SUMS"),
    ],
    { encoding: "utf8", env: { ...process.env, GNUPGHOME: gnupghome } },
  );
  if (sign.status !== 0) {
    throw new Error(`gpg --detach-sign failed: ${sign.stderr}`);
  }
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

shellTest("exits 0 for valid chain with --no-fetch", () => {
  const r = run(["--no-fetch"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("✅");
  for (const name of ARTIFACTS) {
    expect(r.stdout).toContain(name);
  }
});

shellTest("exits 1 when SHA256SUMS is tampered", () => {
  const manifest = readFileSync(join(cwd, "SHA256SUMS"), "utf8");
  const tampered = manifest.replace(/^[0-9a-f]/, (c) => (c === "a" ? "b" : "a"));
  writeFileSync(join(cwd, "SHA256SUMS"), tampered, "utf8");
  const r = run(["--no-fetch"]);
  expect(r.status).toBe(1);
  expect(r.stdout + r.stderr).toMatch(/signature|MISMATCH|❌/i);
});

shellTest("exits 1 when SHA256SUMS is correct but hash doesn't match file", () => {
  writeFileSync(join(cwd, "hello.bin"), "different content", "utf8");
  const r = run(["--no-fetch"]);
  expect(r.status).toBe(1);
  expect(r.stdout + r.stderr).toMatch(/hash|MISMATCH|❌/);
});

shellTest("exits 1 when SHA256SUMS.asc is signed by untrusted key", () => {
  // Mint the untrusted key INSIDE the existing gnupghome — reusing the agent
  // beforeEach already started — rather than a second GNUPGHOME. A separate
  // `work/gnupg-other` home pushes the agent socket path past macOS's 104-byte
  // sun_path limit under the long /var/folders tmpdir, intermittently hanging
  // the agent so the re-sign fails silently and the trusted signature survives
  // (→ false exit 0). Both keys are cert-only primary + sign subkey (see
  // gen-test-key.sh); selecting the untrusted primary by `--local-user` lets
  // gpg auto-pick its sign subkey, and the verifier reports the primary fp.
  const before = new Set(primaryFingerprints(gnupghome));
  const untrustedBatch = join(work, "untrusted-key.batch");
  writeFileSync(
    untrustedBatch,
    [
      "%no-protection",
      "Key-Type: EDDSA",
      "Key-Curve: ed25519",
      "Key-Usage: cert",
      "Subkey-Type: EDDSA",
      "Subkey-Curve: ed25519",
      "Subkey-Usage: sign",
      "Name-Real: Nimbus Untrusted",
      "Name-Email: untrusted@nimbus.local",
      "Expire-Date: 1y",
      "%commit",
      "",
    ].join("\n"),
    "utf8",
  );
  const gen = spawnSync(GPG_BIN, ["--batch", "--generate-key", untrustedBatch], {
    encoding: "utf8",
    env: { ...process.env, GNUPGHOME: gnupghome },
  });
  if (gen.status !== 0) {
    throw new Error(`untrusted key-gen failed: ${gen.stderr}`);
  }
  const untrustedFp = primaryFingerprints(gnupghome).find((fp) => !before.has(fp)) ?? "";
  if (!/^[0-9A-F]{40}$/.test(untrustedFp)) {
    throw new Error(`could not capture untrusted fingerprint (got "${untrustedFp}")`);
  }

  const reSign = spawnSync(
    GPG_BIN,
    [
      "--batch",
      "--yes",
      "--pinentry-mode",
      "loopback",
      "--local-user",
      untrustedFp,
      "--detach-sign",
      "--armor",
      "--output",
      join(cwd, "SHA256SUMS.asc"),
      join(cwd, "SHA256SUMS"),
    ],
    { encoding: "utf8", env: { ...process.env, GNUPGHOME: gnupghome } },
  );
  if (reSign.status !== 0) {
    throw new Error(`untrusted re-sign failed: ${reSign.stderr}`);
  }

  const r = run(["--no-fetch"], { env: { NIMBUS_VERIFY_FINGERPRINT_OVERRIDE: fingerprint } });
  expect(r.status).toBe(1);
  expect(r.stdout + r.stderr).toMatch(/fingerprint|untrusted|❌/i);
  expect(untrustedFp).not.toBe(fingerprint);
});

shellTest("exits 2 when SHA256SUMS missing with --no-fetch", () => {
  rmSync(join(cwd, "SHA256SUMS"));
  const r = run(["--no-fetch"]);
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/SHA256SUMS/);
});

shellTest("prints imported fingerprint for bootstrap trust check", () => {
  const r = run(["--no-fetch"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(fingerprint);
});
