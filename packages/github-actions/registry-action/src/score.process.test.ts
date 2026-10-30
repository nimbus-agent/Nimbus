/**
 * The default role runner against REAL processes: a shell script stands in for the gateway, and
 * the script does what a hostile extension under the real role can do. The sandbox chain under
 * the real role (role, then the `__nimbus-sandbox` wrapper, then bwrap, then the extension) leaves
 * a process holding the role's stderr after the role is killed; these scripts reproduce that with
 * a grandchild in the role's process group.
 *
 * POSIX only: the runner's process-group kill is POSIX, and a script cannot be spawned without a
 * shell on Windows (the fake-spawn tests in `score.test.ts` run everywhere). Nothing else gates
 * them, so on Linux and macOS CI they always run; there is no silent-skip path to fail loudly on.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLE_DRAIN_GRACE_MS, ROLE_STDOUT_MAX_BYTES, roleRunner } from "./score.ts";

/** Whether `pid` is a live process (a zombie awaiting its reaper is not). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
  const stat = `/proc/${String(pid)}/stat`;
  if (!existsSync(stat)) return true;
  try {
    // `<pid> (<comm>) <state> ...`: the state follows the last `)`.
    const text = readFileSync(stat, "utf8");
    return text.slice(text.lastIndexOf(")") + 2, text.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

/** Polls until `pid` is gone or `withinMs` passes; whether it is gone. */
async function gone(pid: number, withinMs: number): Promise<boolean> {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await new Promise((res) => setTimeout(res, 100));
  }
  return !isAlive(pid);
}

/** The grandchild pid the script printed to stderr as `grandchild <pid>`. */
function grandchildOf(stderr: string): number {
  const m = /grandchild (\d+)/.exec(stderr);
  if (m === null) throw new Error(`no grandchild pid in stderr: ${JSON.stringify(stderr)}`);
  return Number(m[1]);
}

const killQuietly = (pid: number): void => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
};

describe.skipIf(process.platform === "win32")("the role runner over real processes", () => {
  let dir: string;
  let home: string;
  const spare: number[] = [];

  /** Writes an executable `#!/bin/sh` "gateway" and returns its absolute path. */
  function gateway(name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
    chmodSync(path, 0o755);
    return path;
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-role-process-"));
    home = join(dir, "homes");
    mkdirSync(home);
  });

  afterAll(() => {
    for (const pid of spare) killQuietly(pid);
    rmSync(dir, { recursive: true, force: true });
  });

  const runner = () => roleRunner(undefined, () => home);

  test("a role that ignores SIGTERM, with a grandchild holding its stderr, ends at the deadline and takes the grandchild with it", async () => {
    const g = gateway(
      "hang.sh",
      ["trap '' TERM", "sleep 600 &", 'echo "grandchild $!" >&2', "exec sleep 600"].join("\n"),
    );
    const started = Date.now();
    const r = await runner()(g, "/unused", 1_500);
    const took = Date.now() - started;
    const pid = grandchildOf(r.stderrTail);
    spare.push(pid);
    expect(r).toMatchObject({ code: null, timedOut: true, overflow: false });
    expect(took).toBeLessThan(30_000);
    expect(await gone(pid, 15_000)).toBe(true);
  }, 120_000);

  test("a role that exits cleanly while an escaped grandchild holds its stderr resolves after the drain grace, stdout intact", async () => {
    // The grandchild leaves the role's process group (setsid), so no group kill reaches it: only
    // the drain grace can end the run, since its stderr pipe never closes while it lives.
    const escaper = join(dir, "escape.js");
    writeFileSync(
      escaper,
      [
        'const { spawn } = require("node:child_process");',
        'const c = spawn("sleep", ["600"], { detached: true, stdio: ["ignore", "ignore", "inherit"] });',
        'process.stderr.write("grandchild " + String(c.pid) + "\\n");',
        "c.unref();",
      ].join("\n"),
      "utf8",
    );
    const g = gateway(
      "exit-held.sh",
      [`"${process.execPath}" "${escaper}"`, `echo '{"ok":true}'`, "exit 0"].join("\n"),
    );
    const started = Date.now();
    const r = await runner()(g, "/unused", 60_000);
    const took = Date.now() - started;
    const pid = grandchildOf(r.stderrTail);
    spare.push(pid);
    expect(r).toMatchObject({ code: 0, stdout: '{"ok":true}\n', timedOut: false, overflow: false });
    // It still held the pipe when the run resolved: the grace, not `close`, ended the run.
    expect(isAlive(pid)).toBe(true);
    expect(took).toBeGreaterThanOrEqual(ROLE_DRAIN_GRACE_MS - 100);
    expect(took).toBeLessThan(30_000);
  }, 120_000);

  test("stdout past the cap kills the whole group: overflow, not a timeout", async () => {
    const g = gateway(
      "flood.sh",
      [
        "trap '' TERM",
        "sleep 600 &",
        'echo "grandchild $!" >&2',
        `head -c ${String(ROLE_STDOUT_MAX_BYTES + 1024 * 1024)} /dev/zero`,
        "exec sleep 600",
      ].join("\n"),
    );
    const started = Date.now();
    const r = await runner()(g, "/unused", 90_000);
    const took = Date.now() - started;
    const pid = grandchildOf(r.stderrTail);
    spare.push(pid);
    expect(r).toMatchObject({ code: null, timedOut: false, overflow: true });
    expect(took).toBeLessThan(60_000);
    expect(await gone(pid, 15_000)).toBe(true);
  }, 120_000);
});
