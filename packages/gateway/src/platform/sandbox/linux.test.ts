import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBwrapArgv, decideNetworkMode, resolverFileToBind } from "./linux.ts";
import type { SandboxPolicy } from "./sandbox-policy.ts";

// Real, unique temp root for the fake sandbox cwd string (S5443). buildBwrapArgv
// is pure argv construction — the cwd is never written to.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "nimbus-sandbox-linux-test-"));
const CWD = join(TMP_ROOT, "cwd");

const basePolicy = (perms: Partial<SandboxPolicy["permissions"]> = {}): SandboxPolicy => ({
  id: "test.ext",
  permissions: { network: [], filesystem: { read: [], write: [] }, ...perms },
});

describe("decideNetworkMode", () => {
  it("returns 'no-net' when permissions.network is empty", () => {
    expect(decideNetworkMode(basePolicy({ network: [] }), { helperAvailable: true })).toBe(
      "no-net",
    );
  });
  it("returns 'per-host' when helper is available and network non-empty", () => {
    expect(decideNetworkMode(basePolicy({ network: ["a.com"] }), { helperAvailable: true })).toBe(
      "per-host",
    );
  });
  it("returns 'fallback' when helper is missing and network non-empty", () => {
    expect(decideNetworkMode(basePolicy({ network: ["a.com"] }), { helperAvailable: false })).toBe(
      "fallback",
    );
  });
});

describe("buildBwrapArgv", () => {
  it("uses --unshare-net for no-net mode", () => {
    const argv = buildBwrapArgv(basePolicy(), { mode: "no-net", cwd: CWD });
    expect(argv).toContain("--unshare-net");
    expect(argv).not.toContain("--share-net");
  });
  it("uses --share-net for per-host and fallback", () => {
    const a1 = buildBwrapArgv(basePolicy({ network: ["a.com"] }), {
      mode: "per-host",
      cwd: CWD,
    });
    const a2 = buildBwrapArgv(basePolicy({ network: ["a.com"] }), {
      mode: "fallback",
      cwd: CWD,
    });
    expect(a1).toContain("--share-net");
    expect(a2).toContain("--share-net");
  });
  it("binds the cwd writable", () => {
    const argv = buildBwrapArgv(basePolicy(), { mode: "no-net", cwd: CWD });
    const bindIdx = argv.indexOf("--bind");
    expect(bindIdx).toBeGreaterThanOrEqual(0);
    expect(argv[bindIdx + 1]).toBe(CWD);
    expect(argv[bindIdx + 2]).toBe(CWD);
  });
  it("starts the child IN the cwd, not wherever bwrap falls back to", () => {
    const argv = buildBwrapArgv(basePolicy(), { mode: "no-net", cwd: CWD });
    const idx = argv.indexOf("--chdir");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe(CWD);
  });
  it("ro-binds filesystem.read entries", () => {
    const argv = buildBwrapArgv(basePolicy({ filesystem: { read: ["/home/u/docs"], write: [] } }), {
      mode: "no-net",
      cwd: CWD,
    });
    const idx = argv.findIndex((a, i) => a === "--ro-bind" && argv[i + 1] === "/home/u/docs");
    expect(idx).toBeGreaterThanOrEqual(0);
  });
});

describe("the resolver file", () => {
  const bindOf = (argv: readonly string[], path: string): boolean =>
    argv.some((a, i) => a === "--ro-bind" && argv[i + 1] === path && argv[i + 2] === path);
  const STUB = "/run/systemd/resolve/stub-resolv.conf";

  it("a child with a network gets the file behind Ubuntu's symlink", () => {
    for (const mode of ["fallback", "per-host"] as const) {
      const argv = buildBwrapArgv(basePolicy({ network: ["a.com"] }), {
        mode,
        cwd: CWD,
        resolverFile: STUB,
      });
      expect(bindOf(argv, STUB)).toBe(true);
    }
  });

  it("a no-network child does not", () => {
    const argv = buildBwrapArgv(basePolicy(), { mode: "no-net", cwd: CWD, resolverFile: STUB });
    expect(bindOf(argv, STUB)).toBe(false);
  });

  it("nothing to bind adds nothing", () => {
    const argv = buildBwrapArgv(basePolicy({ network: ["a.com"] }), {
      mode: "fallback",
      cwd: CWD,
      resolverFile: null,
    });
    expect(argv).toEqual(
      buildBwrapArgv(basePolicy({ network: ["a.com"] }), { mode: "fallback", cwd: CWD }),
    );
  });

  it("resolverFileToBind returns a target outside the bound trees", () => {
    expect(resolverFileToBind(() => STUB)).toBe(STUB);
    expect(resolverFileToBind(() => "/run/NetworkManager/resolv.conf")).toBe(
      "/run/NetworkManager/resolv.conf",
    );
  });

  it("resolverFileToBind adds nothing for a target already bound", () => {
    expect(resolverFileToBind(() => "/etc/resolv.conf")).toBeNull();
    expect(resolverFileToBind(() => "/usr/lib/systemd/resolv.conf")).toBeNull();
  });

  it("resolverFileToBind adds nothing when the file cannot be resolved", () => {
    expect(
      resolverFileToBind(() => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });
});
