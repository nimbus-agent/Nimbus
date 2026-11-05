import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalPath, canonicalPolicyPaths } from "./canonical-path.ts";
import { generateSbplProfile, writeFilesOf } from "./darwin.ts";
import type { SandboxPolicy } from "./sandbox-policy.ts";
import { buildHelperArgv } from "./win32-argv.ts";

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

describe("canonicalPolicyPaths: a declared path that changed refuses the spawn (CodeRabbit, #1911)", () => {
  const note = "/n/v/2026-11-05.md";
  function declared(): SandboxPolicy {
    return {
      id: "com.nimbus.obsidian",
      permissions: { network: [], filesystem: { read: ["/n"], write: [note] } },
      canonicalWritePaths: [note],
      canonicalWriteFiles: [note],
    };
  }

  it("a declared write path whose canonical form differs THROWS", () => {
    const swapped = (p: string) => (p === note ? "/elsewhere/plugin.js" : p);
    expect(() => canonicalPolicyPaths(declared(), swapped)).toThrow(
      `refusing to spawn: the write grant ${note} changed since the gateway decided it`,
    );
  });

  it("a declared FILE whose canonical form differs THROWS, even when it is not a canonicalWritePaths entry", () => {
    const p = { ...declared(), canonicalWritePaths: [] };
    expect(() => canonicalPolicyPaths(p, (x) => (x === note ? "/x.md" : x))).toThrow(
      "changed since the gateway decided it",
    );
  });

  it("unchanged: the declarations are carried through with the same mapping", () => {
    const out = canonicalPolicyPaths(declared(), (p) => p);
    expect(out.canonicalWriteFiles).toEqual([note]);
    expect(out.canonicalWritePaths).toEqual([note]);
    expect(out.permissions.filesystem.write).toEqual([note]);
  });

  it("an undeclared path is still canonicalised as before (no new refusal)", () => {
    const out = canonicalPolicyPaths(
      {
        id: "x",
        permissions: { network: [], filesystem: { read: ["/var/a"], write: ["/var/b"] } },
      },
      (p) => p.replace("/var", "/private/var"),
    );
    expect(out.permissions.filesystem).toEqual({
      read: ["/private/var/a"],
      write: ["/private/var/b"],
    });
  });

  it("a real note swapped for a symlink after the wrapper check: refused, and no runner grant is ever built", () => {
    const dir = mkdtempSync(join(canonicalPath(tmpdir()), "nimbus-canon-swap-"));
    try {
      const real = join(dir, "2026-11-05.md");
      writeFileSync(real, "");
      const plugin = join(dir, "main.js");
      writeFileSync(plugin, "plugin code");
      const policy: SandboxPolicy = {
        id: "com.nimbus.obsidian",
        permissions: { network: [], filesystem: { read: [dir], write: [real] } },
        canonicalWritePaths: [real],
        canonicalWriteFiles: [real],
      };
      // The wrapper's checks passed on the real file; now the host swaps it for a link.
      rmSync(real);
      try {
        symlinkSync(plugin, real, "file");
      } catch {
        console.log("[canon-swap] file symlinks unavailable here; covered by the injected cases");
        return;
      }
      let built: string | undefined;
      expect(() => {
        const canon = canonicalPolicyPaths(policy);
        // Unreachable when the refusal holds: what each runner would have granted.
        built = `${generateSbplProfile({ cwd: dir, tmpdir: dir, policy: canon, writeFiles: writeFilesOf(canon) })}${buildHelperArgv(canon, { cwd: dir }).join(" ")}`;
      }).toThrow("changed since the gateway decided it");
      expect(built).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
