// The wrapper's write-directory checks (I15; Phase 28 AD5b-1): the order, the fixed sentences, and
// that the wrapper calls the ONE function before it creates a runner.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SandboxPolicy } from "./sandbox-policy.ts";
import type { WriteDirScan } from "./write-dir-scan.ts";
import { WRITE_DIR_SCAN_REASONS, writeDirGrantRefusal } from "./write-grant-check.ts";

const DIR = { isDirectory: () => true, isSymbolicLink: () => false };
const FILE = { isDirectory: () => false, isSymbolicLink: () => false };

function policy(over: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    id: "user.mcp_notes",
    permissions: { network: [], filesystem: { read: ["/out"], write: ["/out"] } },
    canonicalWritePaths: ["/out"],
    canonicalWriteDirs: ["/out"],
    ...over,
  };
}

/** Deps that pass every check, with a record of what ran. */
function passing(calls: string[], scan: WriteDirScan = "clean") {
  return {
    lstat: (p: string) => {
      calls.push(`lstat ${p}`);
      return DIR;
    },
    scan: (p: string): WriteDirScan => {
      calls.push(`scan ${p}`);
      return scan;
    },
  };
}

describe("writeDirGrantRefusal", () => {
  test("a declared directory that is real and clean passes, the kind before the tree", () => {
    const calls: string[] = [];
    expect(writeDirGrantRefusal(policy(), passing(calls))).toBeUndefined();
    expect(calls).toEqual(["lstat /out", "scan /out"]);
  });

  test("a policy with no declared directory reads nothing (every other spawn is unchanged)", () => {
    const calls: string[] = [];
    expect(
      writeDirGrantRefusal(
        {
          id: "com.nimbus.obsidian",
          permissions: { network: [], filesystem: { read: ["/r"], write: ["/n.md"] } },
          canonicalWritePaths: ["/n.md"],
          canonicalWriteFiles: ["/n.md"],
        },
        passing(calls),
      ),
    ).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("a declared directory that is now a file or a link refuses, and its tree is never read", () => {
    for (const st of [FILE, { ...DIR, isSymbolicLink: () => true }]) {
      const calls: string[] = [];
      expect(writeDirGrantRefusal(policy(), { ...passing(calls), lstat: () => st })).toBe(
        "refusing to spawn: the write grant /out is no longer a real directory",
      );
      expect(calls).toEqual([]);
    }
  });

  test("a declared directory that is not in the write list refuses before any read", () => {
    const calls: string[] = [];
    const p = policy({ permissions: { network: [], filesystem: { read: [], write: [] } } });
    expect(writeDirGrantRefusal(p, passing(calls))).toBe(
      "refusing to spawn: the write grant /out is no longer a real directory",
    );
    expect(calls).toEqual([]);
  });

  test("every tree verdict but clean refuses with its own fixed sentence", () => {
    const verdicts = Object.keys(WRITE_DIR_SCAN_REASONS).sort((a, b) => a.localeCompare(b));
    expect(verdicts).toEqual(["link", "marker", "multi-link", "over-cap", "special", "unreadable"]);
    for (const v of verdicts as Exclude<WriteDirScan, "clean">[]) {
      expect(writeDirGrantRefusal(policy(), passing([], v))).toBe(
        `refusing to spawn: the write grant /out ${WRITE_DIR_SCAN_REASONS[v]}`,
      );
    }
  });

  test("with two declared directories the second one's tree is checked too", () => {
    const p = policy({
      permissions: { network: [], filesystem: { read: [], write: ["/a", "/b"] } },
      canonicalWritePaths: ["/a", "/b"],
      canonicalWriteDirs: ["/a", "/b"],
    });
    const deps = {
      ...passing([]),
      scan: (d: string): WriteDirScan => (d === "/b" ? "link" : "clean"),
    };
    expect(writeDirGrantRefusal(p, deps)).toBe(
      "refusing to spawn: the write grant /b holds a link",
    );
  });
});

describe("the wrapper refuses a bad write directory before it creates a runner (source pin)", () => {
  const src = readFileSync(join(import.meta.dir, "sandbox-wrapper.ts"), "utf8");

  test("runSandboxWrapper calls writeDirGrantRefusal once, after the file check and before the runner", () => {
    const call = src.indexOf("writeDirGrantRefusal(policy)");
    expect(call).toBeGreaterThan(src.indexOf("writeFileDrift(policy,"));
    expect(src.indexOf("writeDirGrantRefusal(policy)", call + 1)).toBe(-1);
    expect(src.indexOf("createSandboxRunner(", call)).toBeGreaterThan(call);
    expect(src.indexOf("mkdirSync(cwd", call)).toBeGreaterThan(call);
    // The result is fatal: the statement after the call exits with the refusal.
    expect(src.slice(call, call + 120)).toMatch(
      /if \(badDir !== undefined\) \{\s*fatal\(badDir\);/,
    );
  });
});
