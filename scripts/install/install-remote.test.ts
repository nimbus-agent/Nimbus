import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetNameFor, type InstallTarget } from "./lib/release-assets.ts";

const isWindows = process.platform === "win32";

/**
 * The version every test here passes to `install.sh --from-release`. The
 * fixture asset name is derived from it, so the two can never drift apart.
 */
const FIXTURE_VERSION = "2.2.0";

/** This host as an `InstallTarget`, or null when no build is published for it. */
function hostTarget(): InstallTarget | null {
  const os = process.platform;
  const arch = process.arch;
  if (os !== "linux" && os !== "darwin" && os !== "win32") return null;
  if (arch !== "x64" && arch !== "arm64") return null;
  // assetNameFor() throws for Linux arm64 — no such build is published.
  if (os === "linux" && arch === "arm64") return null;
  return { os, arch };
}

const HOST_TARGET = hostTarget();

/**
 * The asset name install.sh will ACTUALLY request on this host, derived from
 * the same `release-assets.ts` SSoT that `release-assets-drift.test.ts` pins
 * install.sh's own `detect_asset()` against.
 *
 * This was previously hardcoded to the Linux name. Because the Linux tarball
 * is the ONE asset carrying its version in the filename
 * (`nimbus-headless-linux-amd64-v2.2.0.tar.gz`) while the macOS tarballs are
 * unversioned (`nimbus-headless-macos-arm64.tar.gz`), the fixture server
 * answered 404 for the name install.sh asked for on every macOS runner — so
 * five tests in this file failed on macos-15 while passing on ubuntu, and
 * main stayed red. Deriving the name means each OS exercises its own real
 * asset name instead of Linux's.
 */
const TARBALL_NAME = HOST_TARGET ? assetNameFor(HOST_TARGET, FIXTURE_VERSION) : "";

// A missing curl must read as SKIPPED, never as a checksum failure — the
// verify:docker image (oven/bun:1.3) ships neither curl nor wget. A host with
// no published build likewise skips rather than failing on a name it could
// never have served.
const skip = isWindows || !Bun.which("curl") || HOST_TARGET === null;
// The bad-signature test needs a REAL gpg to reject a bad signature with
// (rather than degrade via the best-effort skip path), so it needs its own,
// stricter guard on top of `skip`.
const skipSigCheck = skip || !Bun.which("gpg");

// Same exposure as the Windows twin (install-remote-windows.test.ts): every
// test here spawns multiple subprocesses (sh/bash/curl/tar/gpg, via
// runInstallSh and/or signManifestWithUntrustedKey) and cold subprocess spawn
// on a loaded CI runner can eat into bun's 5000ms default test timeout even
// when nothing is actually hung. Give every subprocess-driven test the same
// generous headroom the Windows twin got, for the same reason — don't trim
// it back.
const SUBPROCESS_TEST_TIMEOUT_MS = 60_000;

const GEN_KEY_SH = join("scripts", "release", "fixtures", "gen-test-key.sh");
const BASH_BIN = "/bin/bash";
function resolveGpgBin(): string {
  for (const p of ["/usr/bin/gpg", "/opt/homebrew/bin/gpg", "/usr/local/bin/gpg"]) {
    if (existsSync(p)) return p;
  }
  return "gpg";
}
const GPG_BIN = resolveGpgBin();

/**
 * Signs `manifestContent` with a FRESH, throwaway key (never the pinned
 * Nimbus key) via scripts/release/fixtures/gen-test-key.sh, which mirrors
 * production key hygiene (certify-only primary + dedicated signing
 * subkey — the same structure that made the brief's field-3 substring grep
 * wrong, see the VALIDSIG comment in install.sh). Returns the armored
 * detached-signature text.
 *
 * NOTE on what this does and doesn't exercise: install.sh's verification
 * keyring only ever imports the ONE pinned key, so gpg can never actually
 * find this throwaway key's public key to check the signature against —
 * verified directly (`gpg --status-fd 1 --verify` against a pinned-only
 * keyring): it emits `ERRSIG`/`NO_PUBKEY`, never `VALIDSIG`. That is a
 * cryptographically well-formed OpenPGP signature packet gpg fully PARSED
 * but cannot verify (no public key) — a genuinely different gpg code path
 * than a garbage-bytes ".asc" (which emits `NODATA`: gpg can't even find an
 * OpenPGP packet at all). It does NOT reach the primary-fingerprint STRING
 * COMPARISON specifically — that branch is structurally unreachable from
 * outside, since VALIDSIG never appears for a signer gpg doesn't hold the
 * key for. Both this and the garbage-bytes case fall through to the same
 * "did not verify — refusing to install" abort; this test's job is proving
 * that fallthrough is reached from a REAL, parseable-but-untrusted signature
 * too, not only from bytes gpg rejects outright.
 */
async function signManifestWithUntrustedKey(
  work: string,
  manifestContent: string,
): Promise<string> {
  // Nested under `work` (not a sibling mkdtemp under the OS tmpdir) so the
  // caller's `work` cleanup also removes this throwaway, UNENCRYPTED
  // (gen-test-key.sh's `%no-protection`) private key + agent socket instead
  // of leaking it outside the tracked work tree on every test run.
  const gnupghome = join(work, "gnupg");
  const gen = spawnSync(BASH_BIN, [GEN_KEY_SH, gnupghome], { encoding: "utf8" });
  if (gen.status !== 0) throw new Error(`gen-test-key.sh failed: ${gen.stderr}`);
  const fingerprint = gen.stdout.trim();
  if (!/^[0-9A-F]{40}$/.test(fingerprint)) {
    throw new Error(`unexpected fingerprint from gen-test-key.sh: "${fingerprint}"`);
  }
  const manifestPath = join(work, "SHA256SUMS-untrusted-src");
  await writeFile(manifestPath, manifestContent);
  const ascPath = join(work, "SHA256SUMS.untrusted.asc");
  const sign = spawnSync(
    GPG_BIN,
    [
      "--batch",
      "--yes",
      "--pinentry-mode",
      "loopback",
      "--homedir",
      gnupghome,
      "--detach-sign",
      "--armor",
      "--output",
      ascPath,
      manifestPath,
    ],
    { encoding: "utf8" },
  );
  if (sign.status !== 0) {
    throw new Error(`gpg --detach-sign (untrusted key) failed: ${sign.stderr}`);
  }
  return await Bun.file(ascPath).text();
}

/**
 * Builds a PATH that resolves every external command install.sh's happy
 * path needs, EXCEPT gpg. A naive "remove gpg's directory from PATH" does
 * not work here: on a typical Linux box (Ubuntu CI runners, WSL Ubuntu)
 * gpg, curl, tar and sha256sum all live in the SAME directory (/usr/bin),
 * so excluding that directory would also remove tools the happy path still
 * needs. Instead, symlink each required tool (resolved from the CURRENT
 * PATH) into a fresh, gpg-free directory and use ONLY that directory as
 * PATH for the child process.
 */
async function pathWithoutGpg(): Promise<string> {
  const required = [
    "sh",
    "dirname",
    "uname",
    "curl",
    "tar",
    "gzip", // GNU tar shells out to an external gzip for -z; not built in.
    "sha256sum",
    "shasum",
    "awk",
    "grep",
    "cut",
    "cat", // `cat <<EOF` heredocs invoke the external `cat`, not a shell builtin.
    "mkdir",
    "cp",
    "chmod",
    "mv",
    "rm",
    "touch",
    "basename",
    "mktemp",
  ];
  const shimDir = await mkdtemp(join(tmpdir(), "nimbus-nogpg-"));
  for (const tool of required) {
    const real = Bun.which(tool);
    if (real) await symlink(real, join(shimDir, tool));
  }
  return shimDir;
}

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

/** Builds a stand-in nimbus/nimbus-gateway payload and tarballs it. Returns the tarball path. */
async function makeTarball(work: string, tarballName: string): Promise<string> {
  const payload = join(work, "payload");
  await mkdir(join(payload, "bin"), { recursive: true });
  for (const name of ["nimbus", "nimbus-gateway"]) {
    const p = join(payload, "bin", name);
    await writeFile(p, "#!/bin/sh\necho 2.2.0\n");
    await chmod(p, 0o755);
  }
  const tarballPath = join(work, tarballName);
  await Bun.$`tar -czf ${tarballPath} -C ${payload} .`.quiet();
  return tarballPath;
}

/**
 * Runs install.sh as a child process. Deliberately `Bun.spawn` (async), not
 * `Bun.spawnSync`: the fake release server in this same test file runs on
 * this same Bun process's event loop, and `spawnSync` blocks that loop for
 * as long as the child runs — including while the child is waiting on an
 * HTTP response from `Bun.serve`. That is a self-deadlock (verified: the
 * child's `curl` hangs past its own `--max-time` because the JS callback
 * that would answer it never gets to run), not merely a slow test.
 */
async function runInstallSh(env: Record<string, string | undefined>) {
  const proc = Bun.spawn(
    ["sh", "scripts/install/unix/install.sh", "--from-release", FIXTURE_VERSION, "--yes"],
    {
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test.skipIf(skip)(
  "install.sh installs from a served release",
  async () => {
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
    const tarballName = TARBALL_NAME;
    await Bun.$`tar -czf ${join(work, tarballName)} -C ${payload} .`.quiet();

    const server = await serveFakeRelease(work, tarballName);
    try {
      const { stdout, stderr, exitCode } = await runInstallSh({
        ...process.env,
        HOME: home,
        NIMBUS_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}`,
      });
      expect(stderr + stdout).not.toContain("cannot locate");
      // `not.toContain("cannot locate")` + exit 0 + the file existing are all
      // also satisfied by LOCAL mode if binaries happen to already sit beside
      // the script — this test invokes install.sh by a repo-relative path, so
      // SCRIPT_DIR resolves to the real scripts/install/unix/ (which has no
      // binaries in this repo, but the assertion must not rely on that being
      // true forever). Assert the remote path was actually taken.
      expect(stdout).toContain("Downloading");
      expect(stdout).toContain("sha256 verified");
      expect(exitCode).toBe(0);
      expect(await Bun.file(join(home, ".local", "bin", "nimbus")).exists()).toBe(true);
    } finally {
      server.stop(true);
      await rm(work, { recursive: true, force: true });
    }
  },
  SUBPROCESS_TEST_TIMEOUT_MS,
);

test.skipIf(skip)(
  "install.sh aborts on a tampered archive",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "nimbus-tamper-"));
    const home = join(work, "home");
    await mkdir(home, { recursive: true });
    const tarballName = TARBALL_NAME;
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
      const { stderr, exitCode } = await runInstallSh({
        ...process.env,
        HOME: home,
        NIMBUS_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}`,
      });
      expect(exitCode).not.toBe(0);
      // Bind to the exact message the checksum COMPARISON itself emits, not a
      // loose /checksum|sha256/i pattern — that pattern also matches unrelated
      // stderr lines ("could not fetch SHA256SUMS", "neither sha256sum nor
      // shasum found", the signature-skip notice), any of which would let this
      // test pass while the comparison never ran.
      expect(stderr).toContain("checksum mismatch");
      expect(await Bun.file(join(home, ".local", "bin", "nimbus")).exists()).toBe(false);
    } finally {
      server.stop(true);
      await rm(work, { recursive: true, force: true });
    }
  },
  SUBPROCESS_TEST_TIMEOUT_MS,
);

// N2 (final re-review): install.sh's checksum rule was harmonized to the
// stricter install.ps1 rule (exactly-one-match + `^[0-9a-f]{64}$` format
// guard, see the comment at install.sh's checksum block), but nothing here
// isolated the count half of that rule — a hash-only comparison would also
// pass this test if the count check were dropped, since first-match-wins
// would still land on a correct hash. This fixture mirrors install-remote-
// windows.test.ts's "duplicate identical checksum entry" case: TWO lines for
// the asset, byte-identical, BOTH carrying the hash of the bytes actually
// served. Only `[ "$match_count" -ne 1 ]` catches this; the final
// `$expected != $actual` hash comparison alone would accept it. Must be RED
// against a revert of install.sh's match-count check (confirmed manually)
// and GREEN with it restored.
test.skipIf(skip)(
  "install.sh rejects a duplicate identical checksum entry for the same asset (match-count regression)",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "nimbus-dup-"));
    const home = join(work, "home");
    await mkdir(home, { recursive: true });
    const tarballName = TARBALL_NAME;
    const tarballPath = await makeTarball(work, tarballName);
    const tarball = await Bun.file(tarballPath).arrayBuffer();
    const digest = new Bun.CryptoHasher("sha256").update(tarball).digest("hex");

    // Two byte-identical lines: same case-exact filename, same hash, and
    // that hash IS what was actually served. A hash-only check can never
    // reject this — only "exactly one match" can.
    const sums = `${digest}  ${tarballName}\n${digest}  ${tarballName}\n`;

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path.endsWith("/SHA256SUMS")) return new Response(sums);
        if (path.endsWith(`/${tarballName}`)) return new Response(tarball);
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const { stderr, exitCode } = await runInstallSh({
        ...process.env,
        HOME: home,
        NIMBUS_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}`,
      });
      expect(exitCode).not.toBe(0);
      // Bind to the exact message the comparison itself emits (matches the
      // tamper test's binding above), not a loose /checksum|sha256/i pattern.
      expect(stderr).toContain("checksum mismatch");
      expect(await Bun.file(join(home, ".local", "bin", "nimbus")).exists()).toBe(false);
    } finally {
      server.stop(true);
      await rm(work, { recursive: true, force: true });
    }
  },
  SUBPROCESS_TEST_TIMEOUT_MS,
);

test.skipIf(skip)(
  "install.sh installs and prints the skip notice when gpg is absent",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "nimbus-nogpg-remote-"));
    const home = join(work, "home");
    await mkdir(home, { recursive: true });
    const tarballName = TARBALL_NAME;
    await makeTarball(work, tarballName);

    const server = await serveFakeRelease(work, tarballName);
    const shimPath = await pathWithoutGpg();
    try {
      const { stdout, stderr, exitCode } = await runInstallSh({
        HOME: home,
        PATH: shimPath,
        NIMBUS_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}`,
      });
      const combined = stdout + stderr;
      expect(combined).toContain("SIGNATURE NOT CHECKED");
      expect(combined).toContain("gpg not found or not runnable");
      // The notice must say what WAS and was NOT established, not just fail silent.
      expect(combined).toContain("proves the file");
      expect(combined).toContain("NOT that Nimbus published it");
      expect(combined).toContain("scripts/release/nimbus-verify.sh --version <ver>");
      expect(stdout).toContain("sha256 verified");
      expect(exitCode).toBe(0);
      expect(await Bun.file(join(home, ".local", "bin", "nimbus")).exists()).toBe(true);
    } finally {
      server.stop(true);
      await rm(work, { recursive: true, force: true });
      await rm(shimPath, { recursive: true, force: true });
    }
  },
  SUBPROCESS_TEST_TIMEOUT_MS,
);

test.skipIf(skipSigCheck)(
  "install.sh aborts and installs nothing on a bad signature (gpg present)",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "nimbus-badsig-"));
    const home = join(work, "home");
    await mkdir(home, { recursive: true });
    const tarballName = TARBALL_NAME;
    const tarballPath = await makeTarball(work, tarballName);
    const tarball = await Bun.file(tarballPath).arrayBuffer();
    const digest = new Bun.CryptoHasher("sha256").update(tarball).digest("hex");
    const sums = `${digest}  ${tarballName}\n`;

    // Not a valid PGP signature at all — verify_signature must reject this,
    // never treat an unparsable .asc as "unavailable" (that would silently
    // downgrade an abort into a skip).
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path.endsWith("/SHA256SUMS.asc")) return new Response("this is not a signature\n");
        if (path.endsWith("/SHA256SUMS")) return new Response(sums);
        if (path.endsWith(`/${tarballName}`)) return new Response(tarball);
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const { stdout, stderr, exitCode } = await runInstallSh({
        ...process.env,
        HOME: home,
        NIMBUS_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}`,
      });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("did not verify against the pinned Nimbus key");
      // sha256 passed; only the signature failed — the abort must be reached,
      // not the checksum-mismatch path from the OTHER test in this file.
      expect(stdout).toContain("sha256 verified");
      expect(await Bun.file(join(home, ".local", "bin", "nimbus")).exists()).toBe(false);
    } finally {
      server.stop(true);
      await rm(work, { recursive: true, force: true });
    }
  },
  SUBPROCESS_TEST_TIMEOUT_MS,
);

test.skipIf(skipSigCheck)(
  "install.sh aborts and installs nothing when signed by an UNTRUSTED key",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "nimbus-untrusted-"));
    const home = join(work, "home");
    await mkdir(home, { recursive: true });
    const tarballName = TARBALL_NAME;
    const tarballPath = await makeTarball(work, tarballName);
    const tarball = await Bun.file(tarballPath).arrayBuffer();
    const digest = new Bun.CryptoHasher("sha256").update(tarball).digest("hex");
    const sums = `${digest}  ${tarballName}\n`;

    // A cryptographically well-formed OpenPGP signature gpg fully PARSES —
    // signed by a throwaway key, never the pinned Nimbus key, so gpg (whose
    // verification keyring only ever holds the ONE pinned key) reports
    // NO_PUBKEY, not VALIDSIG. Different gpg code path from "bad signature"
    // below (garbage bytes -> NODATA: gpg can't find OpenPGP data at all);
    // see signManifestWithUntrustedKey's docstring for exactly what this
    // does and does not prove.
    const asc = await signManifestWithUntrustedKey(work, sums);

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path.endsWith("/SHA256SUMS.asc")) return new Response(asc);
        if (path.endsWith("/SHA256SUMS")) return new Response(sums);
        if (path.endsWith(`/${tarballName}`)) return new Response(tarball);
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const { stdout, stderr, exitCode } = await runInstallSh({
        ...process.env,
        HOME: home,
        NIMBUS_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}`,
      });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("did not verify against the pinned Nimbus key");
      expect(stdout).toContain("sha256 verified");
      expect(await Bun.file(join(home, ".local", "bin", "nimbus")).exists()).toBe(false);
    } finally {
      server.stop(true);
      await rm(work, { recursive: true, force: true });
    }
  },
  SUBPROCESS_TEST_TIMEOUT_MS,
);
