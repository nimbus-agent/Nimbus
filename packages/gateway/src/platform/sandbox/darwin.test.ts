import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSbplProfile } from "./darwin.ts";
import type { SandboxPolicy } from "./sandbox-policy.ts";

// Real, unique temp root for the fake sandbox cwd/tmpdir strings (S5443). The
// SBPL profile is pure string generation — these paths are never written to.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "nimbus-sandbox-darwin-test-"));
const CWD = join(TMP_ROOT, "cwd");
const CWD_TMP = join(TMP_ROOT, "cwd-tmp");

function policy(perms: Partial<SandboxPolicy["permissions"]> = {}): SandboxPolicy {
  return {
    id: "test.ext",
    permissions: { network: [], filesystem: { read: [], write: [] }, ...perms },
  };
}

describe("generateSbplProfile", () => {
  it("emits (deny default) and process-fork allowance", () => {
    const profile = generateSbplProfile({
      cwd: CWD,
      tmpdir: CWD_TMP,
      policy: policy(),
    });
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(allow process-fork process-exec)");
  });

  it("emits (allow network* (remote tcp ... (host ...))) for each declared host", () => {
    const profile = generateSbplProfile({
      cwd: CWD,
      tmpdir: CWD_TMP,
      policy: policy({ network: ["api.github.com"] }),
    });
    expect(profile).toMatch(/\(remote tcp "\*:443" \(host "api\.github\.com"\)\)/);
  });

  it("emits the explicit TCP port for a host:port entry (IMAP/SMTP)", () => {
    const profile = generateSbplProfile({
      cwd: CWD,
      tmpdir: CWD_TMP,
      policy: policy({ network: ["imap.fastmail.com:993", "smtp.fastmail.com:465"] }),
    });
    expect(profile).toMatch(/\(remote tcp "\*:993" \(host "imap\.fastmail\.com"\)\)/);
    expect(profile).toMatch(/\(remote tcp "\*:465" \(host "smtp\.fastmail\.com"\)\)/);
    // the port must not leak into the (host ...) clause
    expect(profile).not.toContain('host "imap.fastmail.com:993"');
  });

  it("emits no (allow network*) when permissions.network is empty", () => {
    const profile = generateSbplProfile({
      cwd: CWD,
      tmpdir: CWD_TMP,
      policy: policy(),
    });
    expect(profile).not.toMatch(/\(allow network\*/);
  });

  it("emits subpath rules for filesystem.read entries", () => {
    const profile = generateSbplProfile({
      cwd: CWD,
      tmpdir: CWD_TMP,
      policy: policy({ filesystem: { read: ["/home/u/docs"], write: [] } }),
    });
    expect(profile).toContain(`(subpath "/home/u/docs")`);
  });
});

describe("generateSbplProfile — startup prerequisites", () => {
  const profile = generateSbplProfile({
    cwd: "/tmp/cwd",
    tmpdir: "/tmp/sbx",
    policy: { id: "x", permissions: { network: [], filesystem: { read: [], write: [] } } },
  });

  // Regression guard. Without these the child dies with SIGABRT before it can say why —
  // silent and total, and it took a post-merge push-matrix failure to find. See the comment
  // block in darwin.ts for why each one is needed.
  it("allows sysctl-read, which every runtime does at startup", () => {
    expect(profile).toContain("(allow sysctl-read)");
  });

  it("allows the RNG seed and the null sink", () => {
    expect(profile).toContain('(literal "/dev/urandom")');
    expect(profile).toContain('(literal "/dev/random")');
    expect(profile).toContain('(literal "/dev/null")');
  });

  it("grants /dev by LITERAL, never the whole device tree", () => {
    // `(subpath "/dev")` would hand the sandbox every raw block device to fix three nodes.
    expect(profile).not.toContain('(subpath "/dev")');
  });

  it("still denies by default — the additions are grants, not an opening", () => {
    expect(profile).toContain("(deny default)");
  });
});
