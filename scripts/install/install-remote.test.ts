import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isWindows = process.platform === "win32";
// A missing curl must read as SKIPPED, never as a checksum failure — the
// verify:docker image (oven/bun:1.3) ships neither curl nor wget.
const skip = isWindows || !Bun.which("curl");

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
