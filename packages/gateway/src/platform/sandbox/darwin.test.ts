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

describe("SBPL runtime-startup grants", () => {
  // These exist because the profile had never launched a process: `darwin.test.ts` asserts on
  // generated TEXT and never spawns, and the one suite that spawns for real could not reach macOS
  // (the job's earlier unit step failed first and skipped it). The first real spawn aborted with
  // SIGABRT and an empty stderr.
  //
  // A previous attempt added a subset, saw the next run fail identically, and reverted. Pinning
  // them here means the next person to see an unfamiliar `(allow ...)` line finds a test that says
  // why it is there, rather than deleting it and re-opening a bug that costs a CI round-trip to
  // even observe.
  it.each([
    ["file-read-metadata", "dyld and libc stat every ANCESTOR of a path they open"],
    ["sysctl-read", "hw.ncpu / hw.memsize during allocator and thread-pool setup"],
    ["process-info*", "proc_pidinfo against self"],
    ["/dev/urandom", "JSC seeds its RNG at init"],
    ["/private/var/db/dyld", "dyld closures kept outside /System on some versions"],
  ])("grants %s — %s", (needle) => {
    const profile = generateSbplProfile({
      cwd: "/tmp/cwd",
      tmpdir: "/tmp/sbx",
      policy: policy(),
    });
    expect(profile).toContain(needle);
  });

  // The startup grants must not become a way around the policy. `file-read-metadata` is
  // deliberately unscoped, so this pins that it is METADATA only — content is still governed by
  // the `file-read*` block, and a path the policy never granted is still absent from it.
  it("does not grant read CONTENT anywhere the policy did not name", () => {
    const profile = generateSbplProfile({
      cwd: "/tmp/cwd",
      tmpdir: "/tmp/sbx",
      policy: policy(),
    });
    // The marker is asserted BEFORE it is used, and the slice is bounded to the block.
    //
    // As first written this could pass while enforcing nothing, twice over. `indexOf` returns -1
    // if the marker text ever changes, and `slice(-1)` is then the profile's LAST CHARACTER, which
    // trivially contains neither needle. And the first `(allow file-read*` in this profile is the
    // `/dev` literal line, not the block header, so the slice ran to the end of the document and
    // silently covered the `file-write*` and `network*` blocks too.
    const start = profile.indexOf("(allow file-read*\n");
    expect(start).toBeGreaterThan(-1);
    const end = profile.indexOf("\n)", start);
    expect(end).toBeGreaterThan(start);
    const readBlock = profile.slice(start, end);
    expect(readBlock).toContain('(subpath "/usr/lib")');
    expect(readBlock).not.toContain('(subpath "/Users")');
    expect(readBlock).not.toContain('(subpath "/")');
  });
});

describe("system-tree read grants stay clear of user data", () => {
  const profile = (): string =>
    generateSbplProfile({ cwd: "/tmp/cwd", tmpdir: "/tmp/sbx", policy: policy() });

  // The system tree is granted broadly, matching what the Linux runner binds wholesale. These
  // pin the two trees that must NOT follow it: `/private/var` carries the per-user temp
  // directories and `/Users` carries home directories. Granting either as a subpath would make
  // "refuses a path the policy does not grant" pass vacuously — the denied secret in that test
  // lives under the temp tree.
  it.each([['(subpath "/private/var")'], ['(subpath "/Users")'], ['(subpath "/")']])(
    "never grants read on %s",
    (needle) => {
      expect(profile()).not.toContain(needle);
    },
  );

  it("still grants /private/var/db/dyld specifically, which is not the same thing", () => {
    expect(profile()).toContain('(subpath "/private/var/db/dyld")');
  });
});
