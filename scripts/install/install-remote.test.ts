import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isWindows = process.platform === "win32";
// A missing curl must read as SKIPPED, never as a checksum failure — the
// verify:docker image (oven/bun:1.3) ships neither curl nor wget.
const skip = isWindows || !Bun.which("curl");
// The bad-signature test needs a REAL gpg to reject a bad signature with
// (rather than degrade via the best-effort skip path), so it needs its own,
// stricter guard on top of `skip`.
const skipSigCheck = skip || !Bun.which("gpg");

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
    ["sh", "scripts/install/unix/install.sh", "--from-release", "2.2.0", "--yes"],
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

test.skipIf(skip)("install.sh installs from a served release", async () => {
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
  }
});

test.skipIf(skip)("install.sh aborts on a tampered archive", async () => {
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
  }
});

test.skipIf(skip)("install.sh installs and prints the skip notice when gpg is absent", async () => {
  const work = await mkdtemp(join(tmpdir(), "nimbus-nogpg-remote-"));
  const home = join(work, "home");
  await mkdir(home, { recursive: true });
  const tarballName = "nimbus-headless-linux-amd64-v2.2.0.tar.gz";
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
  }
});

test.skipIf(skipSigCheck)(
  "install.sh aborts and installs nothing on a bad signature (gpg present)",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "nimbus-badsig-"));
    const home = join(work, "home");
    await mkdir(home, { recursive: true });
    const tarballName = "nimbus-headless-linux-amd64-v2.2.0.tar.gz";
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
    }
  },
);
