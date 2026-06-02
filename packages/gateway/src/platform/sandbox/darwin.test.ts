import { describe, expect, it } from "bun:test";

import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { generateSbplProfile } from "./darwin.ts";

function manifest(perms: Partial<ExtensionManifest["permissions"]> = {}): ExtensionManifest {
  return {
    id: "test.ext",
    version: "1.0.0",
    entrypoint: "x.js",
    runtime: "bun",
    permissions: { network: [], filesystem: { read: [], write: [] }, ...perms },
    updateChannel: "stable",
  } as ExtensionManifest;
}

describe("generateSbplProfile", () => {
  it("emits (deny default) and process-fork allowance", () => {
    const profile = generateSbplProfile({
      cwd: "/tmp/cwd",
      tmpdir: "/tmp/cwd-tmp",
      manifest: manifest(),
    });
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(allow process-fork process-exec)");
  });

  it("emits (allow network* (remote tcp ... (host ...))) for each declared host", () => {
    const profile = generateSbplProfile({
      cwd: "/tmp/cwd",
      tmpdir: "/tmp/cwd-tmp",
      manifest: manifest({ network: ["api.github.com"] }),
    });
    expect(profile).toMatch(/\(remote tcp "\*:443" \(host "api\.github\.com"\)\)/);
  });

  it("emits the explicit TCP port for a host:port entry (IMAP/SMTP)", () => {
    const profile = generateSbplProfile({
      cwd: "/tmp/cwd",
      tmpdir: "/tmp/cwd-tmp",
      manifest: manifest({ network: ["imap.fastmail.com:993", "smtp.fastmail.com:465"] }),
    });
    expect(profile).toMatch(/\(remote tcp "\*:993" \(host "imap\.fastmail\.com"\)\)/);
    expect(profile).toMatch(/\(remote tcp "\*:465" \(host "smtp\.fastmail\.com"\)\)/);
    // the port must not leak into the (host ...) clause
    expect(profile).not.toContain('host "imap.fastmail.com:993"');
  });

  it("emits no (allow network*) when permissions.network is empty", () => {
    const profile = generateSbplProfile({
      cwd: "/tmp/cwd",
      tmpdir: "/tmp/cwd-tmp",
      manifest: manifest(),
    });
    expect(profile).not.toMatch(/\(allow network\*/);
  });

  it("emits subpath rules for filesystem.read entries", () => {
    const profile = generateSbplProfile({
      cwd: "/tmp/cwd",
      tmpdir: "/tmp/cwd-tmp",
      manifest: manifest({ filesystem: { read: ["/home/u/docs"], write: [] } }),
    });
    expect(profile).toContain(`(subpath "/home/u/docs")`);
  });
});
