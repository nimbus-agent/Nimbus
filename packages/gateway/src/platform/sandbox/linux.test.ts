import { describe, expect, it } from "bun:test";

import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { buildBwrapArgv, decideNetworkMode } from "./linux.ts";

const baseManifest = (perms: Partial<ExtensionManifest["permissions"]> = {}): ExtensionManifest =>
  ({
    id: "test.ext",
    version: "1.0.0",
    entrypoint: "dist/server.js",
    runtime: "bun",
    permissions: { network: [], filesystem: { read: [], write: [] }, ...perms },
    updateChannel: "stable",
  }) as ExtensionManifest;

describe("decideNetworkMode", () => {
  it("returns 'no-net' when permissions.network is empty", () => {
    expect(decideNetworkMode(baseManifest({ network: [] }), { helperAvailable: true })).toBe(
      "no-net",
    );
  });
  it("returns 'per-host' when helper is available and network non-empty", () => {
    expect(decideNetworkMode(baseManifest({ network: ["a.com"] }), { helperAvailable: true })).toBe(
      "per-host",
    );
  });
  it("returns 'fallback' when helper is missing and network non-empty", () => {
    expect(
      decideNetworkMode(baseManifest({ network: ["a.com"] }), { helperAvailable: false }),
    ).toBe("fallback");
  });
});

describe("buildBwrapArgv", () => {
  it("uses --unshare-net for no-net mode", () => {
    const argv = buildBwrapArgv(baseManifest(), { mode: "no-net", cwd: "/tmp/cwd" });
    expect(argv).toContain("--unshare-net");
    expect(argv).not.toContain("--share-net");
  });
  it("uses --share-net for per-host and fallback", () => {
    const a1 = buildBwrapArgv(baseManifest({ network: ["a.com"] }), {
      mode: "per-host",
      cwd: "/tmp/cwd",
    });
    const a2 = buildBwrapArgv(baseManifest({ network: ["a.com"] }), {
      mode: "fallback",
      cwd: "/tmp/cwd",
    });
    expect(a1).toContain("--share-net");
    expect(a2).toContain("--share-net");
  });
  it("binds the cwd writable", () => {
    const argv = buildBwrapArgv(baseManifest(), { mode: "no-net", cwd: "/tmp/cwd" });
    const bindIdx = argv.indexOf("--bind");
    expect(bindIdx).toBeGreaterThanOrEqual(0);
    expect(argv[bindIdx + 1]).toBe("/tmp/cwd"); // cross-platform-ok — Linux-only bwrap sandbox; POSIX fixture input echoed into argv
    expect(argv[bindIdx + 2]).toBe("/tmp/cwd"); // cross-platform-ok — Linux-only bwrap sandbox; POSIX fixture input echoed into argv
  });
  it("ro-binds filesystem.read entries", () => {
    const argv = buildBwrapArgv(
      baseManifest({ filesystem: { read: ["/home/u/docs"], write: [] } }),
      { mode: "no-net", cwd: "/tmp/cwd" },
    );
    const idx = argv.findIndex((a, i) => a === "--ro-bind" && argv[i + 1] === "/home/u/docs");
    expect(idx).toBeGreaterThanOrEqual(0);
  });
});
