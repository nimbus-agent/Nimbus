import { describe, expect, it } from "bun:test";

import type { SandboxPolicy } from "./sandbox-policy.ts";
import { buildHelperArgv } from "./win32-argv.ts";

// NO `describe.skipIf(process.platform !== "win32")` here — deliberately. See the comment at
// the top of win32.test.ts: buildHelperArgv is pure string/array derivation, no OS calls, and
// gating this file on the host platform made a sibling file read 0% on the CI-Linux-authoritative
// coverage run.

function policy(over: Partial<SandboxPolicy["permissions"]> = {}): SandboxPolicy {
  return {
    id: "com.nimbus.github",
    permissions: { network: [], filesystem: { read: [], write: [] }, ...over },
  };
}

describe("buildHelperArgv", () => {
  it("names the profile from the policy id", () => {
    const argv = buildHelperArgv(policy(), { cwd: "C:\\data" });
    expect(argv.slice(0, 2)).toEqual(["--profile", "nimbus-ext-com.nimbus.github"]);
  });

  it("passes the cwd under its own flag, not as a policy grant", () => {
    // The helper treats the cwd differently from a policy path: Modify + inheritable on the
    // leaf, and NOTHING granted on any ancestor — Windows bypasses traverse checking by default,
    // so a known full path opens without listing rights on the way down, and an ancestor grant
    // would only risk exposing sibling subtrees for no benefit. That distinction (cwd vs. policy
    // path) is only possible if the helper knows which path is the cwd, so it travels under
    // --cwd rather than folded into --grant-write. See docs/sandbox.md for the one case this
    // still fails: a `bun <script>` child under a cwd nested inside the user profile fails at
    // Bun's own startup (measured, mechanism not fully pinned down — a leaf `package.json` does
    // not stop it) — a plain Win32 binary at the same path with the same grants is unaffected.
    const argv = buildHelperArgv(policy(), { cwd: "C:\\data" });
    expect(argv).toEqual(expect.arrayContaining(["--cwd", "C:\\data"]));
    expect(argv).not.toContain("--grant-write");
  });

  it("requests internetClient only when the policy declares a network host", () => {
    expect(buildHelperArgv(policy(), { cwd: "C:\\d" })).not.toContain("--capability");
    const withNet = buildHelperArgv(policy({ network: ["api.github.com"] }), { cwd: "C:\\d" });
    expect(withNet).toContain("--capability");
    expect(withNet).toContain("internetClient");
  });

  it("grants internetClient exactly once regardless of host count", () => {
    const argv = buildHelperArgv(
      policy({ network: ["api.github.com", "gitlab.com", "slack.com"] }),
      { cwd: "C:\\d" },
    );
    expect(argv.filter((a) => a === "internetClient")).toHaveLength(1);
  });

  it("maps filesystem read and write permissions to their own grant flags", () => {
    const argv = buildHelperArgv(policy({ filesystem: { read: ["C:\\ro"], write: ["C:\\rw"] } }), {
      cwd: "C:\\d",
    });
    expect(argv).toEqual(expect.arrayContaining(["--grant-read", "C:\\ro"]));
    expect(argv).toEqual(expect.arrayContaining(["--grant-write", "C:\\rw"]));
  });

  it("terminates the helper flags with a bare -- so child argv cannot be read as flags", () => {
    expect(buildHelperArgv(policy(), { cwd: "C:\\d" }).at(-1)).toBe("--");
  });
});

describe("buildHelperArgv: a declared file is --grant-write-file (re-review finding 2)", () => {
  it("each canonicalWriteFiles entry is passed as a file; every other write stays --grant-write", () => {
    const argv = buildHelperArgv(
      {
        id: "com.nimbus.obsidian",
        permissions: {
          network: [],
          filesystem: { read: [], write: ["C:\\n\\v\\2026-11-05.md", "C:\\data"] },
        },
        canonicalWriteFiles: ["C:\\n\\v\\2026-11-05.md"],
      },
      { cwd: "C:\\cwd" },
    );
    expect(argv).toContain("--grant-write-file");
    // Pure argv derivation over literal Windows paths (no filesystem): the helper's own spelling.
    expect(argv[argv.indexOf("--grant-write-file") + 1]).toBe("C:\\n\\v\\2026-11-05.md"); // cross-platform-ok
    expect(argv[argv.indexOf("--grant-write") + 1]).toBe("C:\\data"); // cross-platform-ok
    expect(argv.filter((a) => a === "--grant-write")).toHaveLength(1);
  });
});

describe("buildHelperArgv: a declared file never falls back to an inheritable grant", () => {
  it("a declared file that is not in the write list throws instead of passing --grant-write", () => {
    expect(() =>
      buildHelperArgv(
        {
          id: "com.nimbus.obsidian",
          permissions: { network: [], filesystem: { read: [], write: ["C:/n/other.md"] } },
          canonicalWriteFiles: ["C:/n/2026-11-05.md"],
        },
        { cwd: "C:/cwd" },
      ),
    ).toThrow("is not in the write list");
  });
});

describe("buildHelperArgv: a declared directory is --grant-write-dir (Phase 28 AD5b-1)", () => {
  const dirPolicy = (over: Record<string, unknown> = {}) => ({
    id: "user.mcp_notes",
    permissions: {
      network: [],
      filesystem: { read: ["C:/out"], write: ["C:/out", "C:/n/note.md", "C:/data"] },
    },
    canonicalWritePaths: ["C:/out", "C:/n/note.md"],
    canonicalWriteFiles: ["C:/n/note.md"],
    canonicalWriteDirs: ["C:/out"],
    ...over,
  });

  it("each kind of write path gets its own flag, in the write list's order", () => {
    const argv = buildHelperArgv(dirPolicy(), { cwd: "C:/cwd" });
    const writes = argv.filter((_, i) => argv[i - 1]?.startsWith("--grant-write") === true);
    expect(writes).toEqual(["C:/out", "C:/n/note.md", "C:/data"]);
    expect(argv[argv.indexOf("--grant-write-dir") + 1]).toBe("C:/out");
    expect(argv[argv.indexOf("--grant-write-file") + 1]).toBe("C:/n/note.md");
    expect(argv[argv.indexOf("--grant-write") + 1]).toBe("C:/data");
    expect(argv.filter((a) => a === "--grant-write-dir")).toHaveLength(1);
    expect(argv.at(-1)).toBe("--");
  });

  it("a declared directory that is not in the write list throws instead of being skipped", () => {
    expect(() =>
      buildHelperArgv(dirPolicy({ canonicalWriteDirs: ["C:/elsewhere"] }), { cwd: "C:/cwd" }),
    ).toThrow("the declared directory grant C:/elsewhere is not in the write list");
  });

  it("a path declared both a file and a directory throws", () => {
    expect(() =>
      buildHelperArgv(dirPolicy({ canonicalWriteDirs: ["C:/n/note.md"] }), { cwd: "C:/cwd" }),
    ).toThrow("is declared both a file and a directory");
  });

  it("a policy with no declared directory is unchanged: no --grant-write-dir", () => {
    const argv = buildHelperArgv(dirPolicy({ canonicalWriteDirs: undefined }), { cwd: "C:/cwd" });
    expect(argv).not.toContain("--grant-write-dir");
    expect(argv[argv.indexOf("--grant-write") + 1]).toBe("C:/out");
  });
});
