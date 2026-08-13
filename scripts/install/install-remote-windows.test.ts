import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const pwsh = Bun.which("pwsh");
const skip = !pwsh;
// The bad-signature test needs a REAL gpg to reject a bad signature with
// (rather than degrade via the best-effort skip path), so it needs its own,
// stricter guard on top of `skip`.
const skipSigCheck = skip || !Bun.which("gpg");
// gen-test-key.sh is a bash script; the untrusted-key test additionally
// needs bash on PATH (Git for Windows bundles it, same as gpg).
const skipUntrustedKeyTest = skipSigCheck || !Bun.which("bash");

// Every test in this file spawns `pwsh` at least twice (createZip and/or
// runInstallPs1, plus cleanupUserPathContaining in every `finally`) — pwsh
// cold start on the Linux `pr-quality` runner is slow enough to blow past
// bun's 5000ms default test timeout even though nothing is actually hung
// (two tests timed out there while passing locally in a faster container).
// Give every pwsh-driven test real headroom instead of trimming it back.
const PWSH_TEST_TIMEOUT_MS = 60_000;

const ASSET_NAME = "nimbus-headless-windows-x64.zip";
const INSTALL_PS1 = join("scripts", "install", "windows", "install.ps1");
// MSYS bash mishandles Windows-style backslash paths as arguments (backslash
// is a shell escape character). `toUnix` (script path) and `toMsys2` (the
// GNUPGHOME target dir, which bash's `export GNUPGHOME=...` inside
// gen-test-key.sh must also resolve correctly) mirror
// scripts/release/nimbus-verify-ps1.test.ts's identical conversions for the
// identical gen-test-key.sh call verbatim -- an already-proven-working
// pattern, not a fresh guess.
const toUnix = (p: string) => p.replaceAll("\\", "/");
const toMsys2 = (p: string) =>
  p.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`).replaceAll("\\", "/");
const REPO_ROOT = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const GEN_KEY_SH = toUnix(join(REPO_ROOT, "scripts", "release", "fixtures", "gen-test-key.sh"));
const BASH_BIN = "bash";
const GPG_BIN = Bun.which("gpg") ?? "gpg";

/**
 * Builds a full process environment (same shape `runInstallPs1` accepts)
 * with every PATH entry that could resolve "gpg" removed. This file's guard
 * is only `!pwsh` (no win32-only skip) — ubuntu-latest ships pwsh, so this
 * ALSO runs on the Linux `pr-quality` gate, where the PATH delimiter is `:`
 * (never hardcode `;`).
 *
 * Deliberately NOT "remove gpg's own directory (dirname) from PATH": on a
 * merged-/usr Linux distro (Debian/Ubuntu, including ubuntu-latest) `/bin`
 * is a SYMLINK to `/usr/bin`, so a gpg living in `/usr/bin` is reachable via
 * BOTH the `/usr/bin` PATH entry AND the separate `/bin` PATH entry —
 * removing only the directory the resolved path happens to report leaves
 * the alias intact and gpg still gets found. Reproduced directly (Docker
 * `oven/bun:1.3`): `readlink -f /bin/gpg` and `readlink -f /usr/bin/gpg`
 * both resolve to the identical `/usr/bin/gpg`, and with only `/usr/bin`
 * excluded, `Get-Command gpg` inside pwsh still found `/bin/gpg`.
 * Instead: for EVERY PATH segment, check whether a `gpg`/`gpg.exe` file
 * exists there, and if its REALPATH (symlinks resolved) matches the
 * REALPATH of the gpg this process itself resolved — exclude that segment.
 * This closes every alias, not just the one `dirname` happens to report.
 */
function envWithoutGpg(
  extra: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const gpgPath = Bun.which("gpg");
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  if (!gpgPath) return env;
  let gpgReal: string;
  try {
    gpgReal = realpathSync(gpgPath);
  } catch {
    gpgReal = gpgPath;
  }
  const candidateNames = process.platform === "win32" ? ["gpg.exe", "gpg"] : ["gpg"];
  const resolvesToGpg = (segment: string): boolean => {
    if (!segment) return false;
    for (const name of candidateNames) {
      const candidate = join(segment, name);
      if (!existsSync(candidate)) continue;
      try {
        if (realpathSync(candidate) === gpgReal) return true;
      } catch {
        // Unreadable/broken entry — not a match, keep scanning.
      }
    }
    return false;
  };
  // Windows env var names are case-insensitive; process.env may key this as
  // "Path" rather than "PATH" -- find whichever key is actually present so
  // we rewrite it in place instead of leaving two ambiguous PATH-ish keys.
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const filtered = (env[pathKey] ?? "").split(delimiter).filter((seg) => !resolvesToGpg(seg));
  env[pathKey] = filtered.join(delimiter);
  return env;
}

/**
 * Builds a zip from a payload directory using PowerShell's own
 * Compress-Archive. Deliberately not a JS zip library: Compress-Archive is
 * the same tool a real release build never uses to CREATE the fixture (that
 * happens in release.yml), but ships with PowerShell 7+ on every OS pwsh
 * itself runs on, so this stays dependency-free and this whole file's
 * `skip` guard already covers "pwsh unavailable".
 */
async function createZip(payloadDir: string, destZip: string): Promise<void> {
  const wildcard = join(payloadDir, "*");
  const script = `Compress-Archive -Path '${wildcard}' -DestinationPath '${destZip}' -Force`;
  const proc = Bun.spawn([pwsh ?? "pwsh", "-NoProfile", "-Command", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`Compress-Archive failed (exit ${exitCode}): ${stderr}`);
}

/**
 * Signs `manifestContent` with a FRESH, throwaway key (never the pinned
 * Nimbus key) via scripts/release/fixtures/gen-test-key.sh. Returns the
 * armored detached-signature text.
 *
 * NOTE on what this does and doesn't exercise (mirrors install-remote.test.ts's
 * Unix twin): install.ps1's verification GNUPGHOME only ever imports the ONE
 * pinned key, so gpg can never find this throwaway key's public key to
 * check the signature against — it emits ERRSIG/NO_PUBKEY, never VALIDSIG.
 * That is a cryptographically well-formed OpenPGP packet gpg fully PARSED
 * but cannot verify, a different gpg code path than a garbage-bytes ".asc"
 * (NODATA: gpg can't find OpenPGP data at all). It does NOT reach the
 * primary-fingerprint comparison specifically — that branch is structurally
 * unreachable from outside, since VALIDSIG never appears for a signer gpg
 * doesn't hold the key for. Both fall through to the same "did not verify"
 * abort; this proves that fallthrough is reached from a real, parseable-but-
 * untrusted signature too, not only from bytes gpg rejects outright.
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
  // gen-test-key.sh runs under bash (MSYS on Windows). GPG_BIN below is the
  // native gpg.exe, which is ALSO MSYS2-linked on Git for Windows and reads
  // GNUPGHOME through its own POSIX path translation -- a Windows-style
  // `--homedir C:\...` argument gets misinterpreted as relative and
  // concatenated onto gpg's msys-style CWD (reproduced directly: gpg then
  // reported a keyblock resource path like
  // "/c/.../repo/C:\Users\...\nimbus-ps1-untrusted-key-XXXX/pubring.kbx").
  // Passing GNUPGHOME as an msys2-style env var (never a `--homedir` CLI
  // flag) instead is the exact pattern
  // scripts/release/nimbus-verify-ps1.test.ts already uses successfully for
  // this identical gen-test-key.sh + gpg --detach-sign combination.
  const gen = spawnSync(BASH_BIN, [GEN_KEY_SH, toMsys2(gnupghome)], { encoding: "utf8" });
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
      "--detach-sign",
      "--armor",
      "--output",
      toUnix(ascPath),
      toUnix(manifestPath),
    ],
    { encoding: "utf8", env: { ...process.env, GNUPGHOME: toMsys2(gnupghome) } },
  );
  if (sign.status !== 0) {
    throw new Error(`gpg --detach-sign (untrusted key) failed: ${sign.stderr}`);
  }
  return await Bun.file(ascPath).text();
}

/** Serves a fixed set of bytes for the asset and a fixed SHA256SUMS body. */
function serveFakeRelease(zipBytes: Uint8Array, sums: string) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/SHA256SUMS")) return new Response(sums);
      if (path.endsWith(`/${ASSET_NAME}`)) return new Response(zipBytes);
      return new Response("not found", { status: 404 });
    },
  });
}

/**
 * Runs install.ps1 as a child process. Deliberately async `Bun.spawn`, not
 * `Bun.spawnSync`: the fake release server in this file runs on this same
 * Bun process's event loop. `spawnSync` fully blocks that loop for as long
 * as the child runs — including while the child's `Invoke-WebRequest` is
 * waiting on a response from `Bun.serve` — which is a self-deadlock. This is
 * the exact trap `install-remote.test.ts` documents (and hit) for
 * `install.sh`'s equivalent `curl` call; it applies identically here.
 *
 * Uses the pwsh path RESOLVED AT MODULE LOAD (`pwsh` from `Bun.which`), never
 * the bare string "pwsh": `env` here is a fully custom environment (built by
 * `envWithoutGpg` for the gpg-absent test), and `Bun.spawn` resolves argv[0]
 * against the CHILD's PATH, not the parent's — confirmed by the Unix twin's
 * `pathWithoutGpg`, which has to symlink `sh` itself into its shim dir for
 * exactly this reason. Once gpg's directory is correctly excluded (the C1
 * fix above), that can be /usr/bin on Linux, which is also where `pwsh`
 * lives on Ubuntu — an unresolved "pwsh" would then fail to spawn at all.
 */
async function runInstallPs1(args: string[], env: Record<string, string | undefined>) {
  const proc = Bun.spawn([pwsh ?? "pwsh", "-NoProfile", "-File", INSTALL_PS1, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/**
 * install.ps1 always writes the real HKCU\Environment User PATH via .NET's
 * `Environment.SetEnvironmentVariable(..., "User")`, regardless of the
 * sandboxed LOCALAPPDATA a test passes in — that install-dir registry write
 * is not something a test can sandbox away on Windows. (On non-Windows this
 * call is a documented no-op, which is also why running this file's tests
 * via `pwsh` on Linux CI is side-effect-free: nothing to clean up there.)
 * Every test below uses a fresh, uniquely-named LOCALAPPDATA specifically so
 * this cleanup can surgically remove only the PATH segment IT added, never
 * anything a real user's shell put there.
 */
async function cleanupUserPathContaining(fragment: string): Promise<void> {
  if (process.platform !== "win32") return;
  const script = `
    $p = [Environment]::GetEnvironmentVariable('PATH','User')
    if ($p) {
      $clean = ($p -split ';' | Where-Object { $_ -notlike '*${fragment}*' }) -join ';'
      if ($clean -ne $p) { [Environment]::SetEnvironmentVariable('PATH', $clean, 'User') }
    }
  `;
  const proc = Bun.spawn([pwsh ?? "pwsh", "-NoProfile", "-Command", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  // This is the one helper in this file that mutates the REAL, machine-wide
  // HKCU\Environment PATH on a Windows dev box — a silently-swallowed
  // failure here leaves a test-fixture segment behind in a real user's
  // shell PATH forever. Fail loudly instead.
  if (exitCode !== 0) {
    throw new Error(`cleanupUserPathContaining failed (exit ${exitCode}): ${stderr}`);
  }
}

async function makePayload(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nimbus-ps1-payload-"));
  await writeFile(join(dir, "nimbus.exe"), content);
  await writeFile(join(dir, "nimbus-gateway.exe"), content);
  return dir;
}

test.skipIf(skip)(
  "install.ps1 installs from a served release",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "nimbus-ps1-remote-"));
    const localAppData = await mkdtemp(join(work, "lad-"));

    const payload = await makePayload("genuine-cli\n");
    const zipPath = join(work, ASSET_NAME);
    await createZip(payload, zipPath);
    const zipBytes = new Uint8Array(await Bun.file(zipPath).arrayBuffer());
    const digest = new Bun.CryptoHasher("sha256").update(zipBytes).digest("hex");
    const sums = `${digest}  ${ASSET_NAME}\n`;

    const server = serveFakeRelease(zipBytes, sums);
    try {
      const { stdout, stderr, exitCode } = await runInstallPs1(["-FromRelease", "2.2.0", "-Yes"], {
        ...process.env,
        LOCALAPPDATA: localAppData,
        NIMBUS_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}`,
      });
      // `not.toContain("Cannot locate")` + exit 0 + the file existing are all
      // also satisfiable by LOCAL mode if binaries happen to sit beside the
      // real scripts/install/windows/install.ps1 in this repo (they don't, but
      // the assertion must not rely on that being true forever) — assert the
      // remote path was actually taken.
      expect(stderr + stdout).not.toContain("Cannot locate");
      expect(stdout).toContain("Downloading");
      expect(stdout).toContain("sha256 verified");
      expect(exitCode).toBe(0);
      const installed = join(localAppData, "Programs", "Nimbus", "bin", "nimbus.exe");
      expect(await Bun.file(installed).exists()).toBe(true);
    } finally {
      server.stop(true);
      await cleanupUserPathContaining(localAppData);
      await rm(work, { recursive: true, force: true });
    }
  },
  PWSH_TEST_TIMEOUT_MS,
);

test.skipIf(skip)(
  "install.ps1 aborts on a tampered archive",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "nimbus-ps1-tamper-"));
    const localAppData = await mkdtemp(join(work, "lad-"));

    const zipBytes = new TextEncoder().encode("not a real zip");
    // SHA256SUMS advertises a digest that does not match the served bytes.
    const sums = `${"0".repeat(64)}  ${ASSET_NAME}\n`;

    const server = serveFakeRelease(zipBytes, sums);
    try {
      const { stderr, exitCode } = await runInstallPs1(["-FromRelease", "2.2.0", "-Yes"], {
        ...process.env,
        LOCALAPPDATA: localAppData,
        NIMBUS_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}`,
      });
      expect(exitCode).not.toBe(0);
      // Bind to the exact message the comparison itself emits, not a loose
      // /checksum|sha256/i pattern — that would also match the unrelated
      // signature-skip notice and let this test pass while the real
      // comparison never ran.
      expect(stderr).toContain("checksum mismatch");
      const installed = join(localAppData, "Programs", "Nimbus", "bin", "nimbus.exe");
      expect(await Bun.file(installed).exists()).toBe(false);
    } finally {
      server.stop(true);
      await cleanupUserPathContaining(localAppData);
      await rm(work, { recursive: true, force: true });
    }
  },
  PWSH_TEST_TIMEOUT_MS,
);

// C1 regression (review round 1): the checksum lookup used PowerShell's
// default `-eq`, which is case-INSENSITIVE for strings, combined with
// first-match-wins. A SHA256SUMS manifest with an UPPERCASE-named "shadow"
// line ahead of the genuine lowercase line let an attacker who controls a
// mirror/proxy have a tampered archive "verify" successfully. This test must
// be RED against the pre-fix `-eq`/first-match code (confirmed by stashing
// the fix and re-running — see the fix report) and GREEN only once the
// lookup is case-sensitive (`-ceq`) AND rejects anything but exactly one
// match.
test.skipIf(skip)(
  "install.ps1 rejects a case-varied shadow checksum entry (C1 regression)",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "nimbus-ps1-c1-"));
    const localAppData = await mkdtemp(join(work, "lad-"));

    const tamperedPayload = await makePayload("PWNED-CLI\n");
    const tamperedZip = join(work, ASSET_NAME);
    await createZip(tamperedPayload, tamperedZip);
    const tamperedBytes = new Uint8Array(await Bun.file(tamperedZip).arrayBuffer());
    const tamperedDigest = new Bun.CryptoHasher("sha256").update(tamperedBytes).digest("hex");

    // Line 1: an UPPERCASE-named shadow entry whose hash matches the
    // TAMPERED bytes actually served (this is what a case-insensitive,
    // first-match lookup would accept). Line 2: the correctly-cased entry,
    // carrying a different ("genuine") hash that does NOT match what was
    // actually served — so a correct case-sensitive, exactly-one-match
    // lookup rejects the install.
    const sums = `${tamperedDigest}  NIMBUS-HEADLESS-WINDOWS-X64.ZIP\n${"1".repeat(64)}  ${ASSET_NAME}\n`;

    const server = serveFakeRelease(tamperedBytes, sums);
    try {
      const { stderr, exitCode } = await runInstallPs1(["-FromRelease", "2.2.0", "-Yes"], {
        ...process.env,
        LOCALAPPDATA: localAppData,
        NIMBUS_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}`,
      });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("checksum mismatch");
      const installed = join(localAppData, "Programs", "Nimbus", "bin", "nimbus.exe");
      expect(await Bun.file(installed).exists()).toBe(false);
    } finally {
      server.stop(true);
      await cleanupUserPathContaining(localAppData);
      await rm(work, { recursive: true, force: true });
    }
  },
  PWSH_TEST_TIMEOUT_MS,
);

// S11 (final fix wave): the C1 regression test above pins only the CASE-
// SENSITIVITY half of the fix (`-ceq` vs `-eq`) — its shadow line carries a
// hash that does NOT match the served bytes, so a partial revert to
// `-ceq` + first-match-wins (dropping only the `$checksumMatches.Length -ne 1`
// exactly-one-match rule) still passes it: the first (and only accepted)
// match's hash still fails the final `-ne $actual` comparison. This fixture
// isolates the Length rule on its own: TWO lines for the asset, SAME case,
// BOTH carrying the hash of the bytes actually served — first-match-wins
// would accept either one and the final hash comparison would also pass, so
// only `-ne 1` catches this. Must be RED against a stash of the Length check
// (confirmed below) and GREEN with it restored.
test.skipIf(skip)(
  "install.ps1 rejects a duplicate identical checksum entry for the same asset (Length-1 regression)",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "nimbus-ps1-dup-"));
    const localAppData = await mkdtemp(join(work, "lad-"));

    const payload = await makePayload("genuine-cli\n");
    const zipPath = join(work, ASSET_NAME);
    await createZip(payload, zipPath);
    const zipBytes = new Uint8Array(await Bun.file(zipPath).arrayBuffer());
    const digest = new Bun.CryptoHasher("sha256").update(zipBytes).digest("hex");

    // Two byte-identical lines: same case-exact filename, same hash, and
    // that hash IS what was actually served. A hash-only check can never
    // reject this -- only "exactly one match" can.
    const sums = `${digest}  ${ASSET_NAME}\n${digest}  ${ASSET_NAME}\n`;

    const server = serveFakeRelease(zipBytes, sums);
    try {
      const { stderr, exitCode } = await runInstallPs1(["-FromRelease", "2.2.0", "-Yes"], {
        ...process.env,
        LOCALAPPDATA: localAppData,
        NIMBUS_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}`,
      });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("checksum mismatch");
      const installed = join(localAppData, "Programs", "Nimbus", "bin", "nimbus.exe");
      expect(await Bun.file(installed).exists()).toBe(false);
    } finally {
      server.stop(true);
      await cleanupUserPathContaining(localAppData);
      await rm(work, { recursive: true, force: true });
    }
  },
  PWSH_TEST_TIMEOUT_MS,
);

test.skipIf(skip)(
  "install.ps1 installs and prints the skip notice when gpg is absent",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "nimbus-ps1-nogpg-"));
    const localAppData = await mkdtemp(join(work, "lad-"));

    const payload = await makePayload("genuine-cli\n");
    const zipPath = join(work, ASSET_NAME);
    await createZip(payload, zipPath);
    const zipBytes = new Uint8Array(await Bun.file(zipPath).arrayBuffer());
    const digest = new Bun.CryptoHasher("sha256").update(zipBytes).digest("hex");
    const sums = `${digest}  ${ASSET_NAME}\n`;

    const server = serveFakeRelease(zipBytes, sums);
    try {
      const { stdout, stderr, exitCode } = await runInstallPs1(
        ["-FromRelease", "2.2.0", "-Yes"],
        envWithoutGpg({
          LOCALAPPDATA: localAppData,
          NIMBUS_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}`,
        }),
      );
      const combined = stdout + stderr;
      expect(combined).toContain("SIGNATURE NOT CHECKED");
      expect(combined).toContain("gpg not found");
      // The notice must say what WAS and was NOT established, not just fail silent.
      expect(combined).toContain("proves the file");
      expect(combined).toContain("NOT that Nimbus published it");
      expect(combined).toContain("scripts/release/nimbus-verify.sh --version <ver>");
      expect(stdout).toContain("sha256 verified");
      expect(exitCode).toBe(0);
      const installed = join(localAppData, "Programs", "Nimbus", "bin", "nimbus.exe");
      expect(await Bun.file(installed).exists()).toBe(true);
    } finally {
      server.stop(true);
      await cleanupUserPathContaining(localAppData);
      await rm(work, { recursive: true, force: true });
    }
  },
  PWSH_TEST_TIMEOUT_MS,
);

test.skipIf(skipSigCheck)(
  "install.ps1 aborts and installs nothing on a bad signature (gpg present)",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "nimbus-ps1-badsig-"));
    const localAppData = await mkdtemp(join(work, "lad-"));

    const payload = await makePayload("genuine-cli\n");
    const zipPath = join(work, ASSET_NAME);
    await createZip(payload, zipPath);
    const zipBytes = new Uint8Array(await Bun.file(zipPath).arrayBuffer());
    const digest = new Bun.CryptoHasher("sha256").update(zipBytes).digest("hex");
    const sums = `${digest}  ${ASSET_NAME}\n`;

    // Not a valid PGP signature at all — Test-NimbusSignature must reject
    // this, never treat an unparsable .asc as "unavailable" (that would
    // silently downgrade an abort into a skip).
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path.endsWith("/SHA256SUMS.asc")) return new Response("this is not a signature\n");
        if (path.endsWith("/SHA256SUMS")) return new Response(sums);
        if (path.endsWith(`/${ASSET_NAME}`)) return new Response(zipBytes);
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const { stdout, stderr, exitCode } = await runInstallPs1(["-FromRelease", "2.2.0", "-Yes"], {
        ...process.env,
        LOCALAPPDATA: localAppData,
        NIMBUS_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}`,
      });
      expect(exitCode).not.toBe(0);
      // This is the top-level `throw` message at the Test-NimbusSignature
      // call site (uncaught, so it lands on stderr) — Test-NimbusSignature's
      // own more detailed Write-Warning text lands on stdout instead (Write-
      // Warning is not a pipeline write, so it never risks the array-
      // coercion trap, but it also does not land on stderr under `pwsh
      // -File`; measured).
      expect(stderr).toContain("signature verification failed");
      const combined = stdout + stderr;
      expect(combined).toContain("did not verify against the pinned Nimbus key");
      // sha256 passed; only the signature failed — the abort must be reached,
      // not the checksum-mismatch path from another test in this file.
      expect(stdout).toContain("sha256 verified");
      const installed = join(localAppData, "Programs", "Nimbus", "bin", "nimbus.exe");
      expect(await Bun.file(installed).exists()).toBe(false);
    } finally {
      server.stop(true);
      await cleanupUserPathContaining(localAppData);
      await rm(work, { recursive: true, force: true });
    }
  },
  PWSH_TEST_TIMEOUT_MS,
);

test.skipIf(skipUntrustedKeyTest)(
  "install.ps1 aborts and installs nothing when signed by an UNTRUSTED key",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "nimbus-ps1-untrusted-"));
    const localAppData = await mkdtemp(join(work, "lad-"));

    const payload = await makePayload("genuine-cli\n");
    const zipPath = join(work, ASSET_NAME);
    await createZip(payload, zipPath);
    const zipBytes = new Uint8Array(await Bun.file(zipPath).arrayBuffer());
    const digest = new Bun.CryptoHasher("sha256").update(zipBytes).digest("hex");
    const sums = `${digest}  ${ASSET_NAME}\n`;

    // See signManifestWithUntrustedKey's docstring for exactly what this
    // does and does not prove (mirrors the Unix twin's identical test).
    const asc = await signManifestWithUntrustedKey(work, sums);

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path.endsWith("/SHA256SUMS.asc")) return new Response(asc);
        if (path.endsWith("/SHA256SUMS")) return new Response(sums);
        if (path.endsWith(`/${ASSET_NAME}`)) return new Response(zipBytes);
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const { stdout, stderr, exitCode } = await runInstallPs1(["-FromRelease", "2.2.0", "-Yes"], {
        ...process.env,
        LOCALAPPDATA: localAppData,
        NIMBUS_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}`,
      });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("signature verification failed");
      const combined = stdout + stderr;
      expect(combined).toContain("did not verify against the pinned Nimbus key");
      expect(stdout).toContain("sha256 verified");
      const installed = join(localAppData, "Programs", "Nimbus", "bin", "nimbus.exe");
      expect(await Bun.file(installed).exists()).toBe(false);
    } finally {
      server.stop(true);
      await cleanupUserPathContaining(localAppData);
      await rm(work, { recursive: true, force: true });
    }
  },
  PWSH_TEST_TIMEOUT_MS,
);
