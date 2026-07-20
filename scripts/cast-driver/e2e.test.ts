import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("cast-driver e2e (incident-response committed snapshot)", () => {
  test("committed snapshot files exist", () => {
    const root = process.cwd();
    expect(existsSync(join(root, "docs/demos/scripts/incident-response.yaml"))).toBe(true);
    expect(existsSync(join(root, "docs/demos/snapshots/incident-response.hash"))).toBe(true);
    expect(existsSync(join(root, "docs/demos/snapshots/incident-response.txt"))).toBe(true);
    expect(existsSync(join(root, "docs/demos/incident-response.cast"))).toBe(true);
  });

  test("--check passes against committed snapshot", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "scripts/cast-driver/run.ts", "--check"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    // The driver's output was previously piped and then discarded, so any
    // failure surfaced only as "expected 0, received 1" with no reason. That
    // hid the most common cause outright: in a fresh worktree with no
    // `bun install`, the spawned CLI cannot resolve its imports, crashes with
    // no stdout, and the harness reports a misleading `expect missed` on the
    // first step — which reads like a stale snapshot rather than absent deps.
    //
    // Fold the diagnostic into the assertion's own message rather than a
    // separate `if (code !== 0) throw` before it: that prior form made this
    // `expect` unreachable on failure (dead code) since the throw always
    // fired first. One assertion path, still with the same diagnostic detail.
    expect(
      code,
      `cast-driver --check failed (exit ${code}).\n` +
        `If stderr mentions an unresolved module, run \`bun install\` in this worktree.\n` +
        `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    ).toBe(0);
  });
});
