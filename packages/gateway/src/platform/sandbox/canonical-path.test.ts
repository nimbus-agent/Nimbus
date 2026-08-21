import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalPath, canonicalPolicyPaths } from "./canonical-path.ts";
import type { SandboxPolicy } from "./sandbox-policy.ts";

describe("canonicalPath", () => {
  it("returns a real directory unchanged when it is already canonical", () => {
    const dir = mkdtempSync(join(canonicalPath(tmpdir()), "nimbus-canon-"));
    try {
      expect(canonicalPath(dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the input for a path that does not exist", () => {
    // A policy may legitimately name a directory that has not been created yet. Throwing here
    // would turn that into a refusal to spawn at all, which is worse than granting the
    // unresolved form.
    const missing = join(tmpdir(), "nimbus-canon-definitely-not-here-9f3a1c");
    expect(canonicalPath(missing)).toBe(missing);
  });

  it.skipIf(process.platform !== "win32")("expands an 8.3 short name on Windows", () => {
    // The exact CI failure: a runner's TEMP is C:\Users\RUNNER~1\... because `runneradmin` is
    // longer than eight characters. `C:\PROGRA~1` is the one 8.3 alias present on every Windows
    // install, so this asserts the mechanism without creating one.
    const short = "C:\\PROGRA~1";
    const long = canonicalPath(short);
    expect(long).not.toContain("~1");
    expect(long.toLowerCase()).toContain("program files");
  });

  it.skipIf(process.platform !== "darwin")("resolves /var to /private/var on macOS", () => {
    // The SBPL grant is compared against the kernel's path, and /var is a symlink.
    expect(canonicalPath("/var")).toBe("/private/var");
  });
});

describe("canonicalPolicyPaths", () => {
  const policy: SandboxPolicy = {
    id: "com.acme.x",
    permissions: {
      network: ["api.acme.com"],
      filesystem: { read: ["/nope/read"], write: ["/nope/write"] },
    },
  };

  it("carries id and network through untouched — neither is a path", () => {
    const out = canonicalPolicyPaths(policy);
    expect(out.id).toBe("com.acme.x");
    expect(out.permissions.network).toEqual(["api.acme.com"]);
  });

  it("maps both filesystem lists, preserving order and length", () => {
    const out = canonicalPolicyPaths(policy);
    expect(out.permissions.filesystem.read).toHaveLength(1);
    expect(out.permissions.filesystem.write).toHaveLength(1);
  });

  it("does not mutate the policy it was given", () => {
    const before = JSON.stringify(policy);
    canonicalPolicyPaths(policy);
    expect(JSON.stringify(policy)).toBe(before);
  });
});
