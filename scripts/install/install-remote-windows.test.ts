import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const pwsh = Bun.which("pwsh");
const skip = !pwsh;
// The bad-signature test needs a REAL gpg to reject a bad signature with
// (rather than degrade via the best-effort skip path), so it needs its own,
// stricter guard on top of `skip`.
const skipSigCheck = skip || !Bun.which("gpg");

const ASSET_NAME = "nimbus-headless-windows-x64.zip";
const INSTALL_PS1 = join("scripts", "install", "windows", "install.ps1");

/**
 * Builds a full process environment (same shape `runInstallPs1` accepts)
 * with gpg's directory removed from PATH. Unlike the Unix side, this is
 * safe as a plain directory-exclusion: install.ps1's happy path uses only
 * built-in PowerShell cmdlets (Invoke-WebRequest, Expand-Archive,
 * Get-FileHash, ...) for everything except gpg itself -- pwsh is already
 * resolved by the PARENT process's own spawn call, not by this env -- so
 * there is no risk of also removing some OTHER tool that happens to share
 * gpg's directory (the risk that rules out this approach on the Unix side,
 * where gpg/curl/tar/sha256sum commonly all live in /usr/bin together).
 */
function envWithoutGpg(
  extra: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const gpgPath = Bun.which("gpg");
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  if (!gpgPath) return env;
  const gpgDir = dirname(gpgPath).toLowerCase();
  // Windows env var names are case-insensitive; process.env may key this as
  // "Path" rather than "PATH" -- find whichever key is actually present so
  // we rewrite it in place instead of leaving two ambiguous PATH-ish keys.
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const filtered = (env[pathKey] ?? "").split(";").filter((seg) => seg.toLowerCase() !== gpgDir);
  env[pathKey] = filtered.join(";");
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
  const proc = Bun.spawn(["pwsh", "-NoProfile", "-Command", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`Compress-Archive failed (exit ${exitCode}): ${stderr}`);
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
 */
async function runInstallPs1(args: string[], env: Record<string, string | undefined>) {
  const proc = Bun.spawn(["pwsh", "-NoProfile", "-File", INSTALL_PS1, ...args], {
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
  const proc = Bun.spawn(["pwsh", "-NoProfile", "-Command", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}

async function makePayload(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nimbus-ps1-payload-"));
  await writeFile(join(dir, "nimbus.exe"), content);
  await writeFile(join(dir, "nimbus-gateway.exe"), content);
  return dir;
}

test.skipIf(skip)("install.ps1 installs from a served release", async () => {
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
  }
});

test.skipIf(skip)("install.ps1 aborts on a tampered archive", async () => {
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
  }
});

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
    }
  },
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
    }
  },
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
    }
  },
);
