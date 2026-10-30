import { describe, expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import { probeBwrap } from "./linux.ts";

type Result = { status: number | null; stderr?: string; error?: Error };

/** First call is `--version`, second is the start probe. */
function runner(version: Result, start: Result, calls: string[][] = []): typeof spawnSync {
  return ((_cmd: string, args: string[]) => {
    calls.push(args);
    return args[0] === "--version" ? version : start;
  }) as unknown as typeof spawnSync;
}

describe("probeBwrap", () => {
  test("no binary", () => {
    expect(probeBwrap(null)).toContain("bwrap not found");
  });

  test("a binary that cannot run", () => {
    expect(probeBwrap("/usr/bin/bwrap", runner({ status: 1 }, { status: 0 }))).toContain(
      "is not executable",
    );
  });

  test("a bwrap that starts its child is confining", () => {
    const calls: string[][] = [];
    expect(probeBwrap("/usr/bin/bwrap", runner({ status: 0 }, { status: 0 }, calls))).toBeNull();
    expect(calls[1]).toContain("--unshare-user");
    expect(calls[1]).toContain("--unshare-net");
  });

  test("--version passing is not enough: the AppArmor denial is the reason, and names the fix", () => {
    const reason = probeBwrap(
      "/usr/bin/bwrap",
      runner(
        { status: 0 },
        { status: 1, stderr: "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n" },
      ),
    );
    expect(reason).toContain("loopback: Failed RTM_NEWADDR");
    expect(reason).toContain("nimbus doctor");
  });

  test("a start probe that could not run also refuses", () => {
    const reason = probeBwrap(
      "/usr/bin/bwrap",
      runner({ status: 0 }, { status: null, error: new Error("ETIMEDOUT") }),
    );
    expect(reason).toContain("ETIMEDOUT");
  });
});
