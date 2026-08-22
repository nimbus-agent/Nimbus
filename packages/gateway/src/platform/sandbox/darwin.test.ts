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
    ["/private/var/db", "dyld closures, and the rest of the system state under db"],
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

  it("grants the /private/var pieces that carry no user data, and only those", () => {
    for (const p of ["/private/var/db", "/private/var/select", "/private/var/run"]) {
      expect(profile()).toContain(`(subpath "${p}")`);
    }
    // `folders` is the one that must never appear. A bisect named `/private/var` as the single
    // required read outside the system tree, but its `folders/<hash>/<hash>/T` leaf is the
    // per-user TEMP directory — a caller's scratch data in production, and in this repo's own
    // suite the file the denial test expects to be refused. Granting the parent to satisfy the
    // startup requirement would make that test pass while proving nothing.
    expect(profile()).not.toContain('(subpath "/private/var/folders")');
  });
});

describe("ancestor literals grant traversal, never a tree", () => {
  const CWD = "/private/var/folders/ab/cd/T/wrap/work";
  const SBX = "/private/var/folders/ab/cd/T/sbx";
  const built = (): string => generateSbplProfile({ cwd: CWD, tmpdir: SBX, policy: policy() });

  it("emits a (literal ...) for every ancestor of the cwd, up to /", () => {
    const p = built();
    for (const a of [
      "/private/var/folders/ab/cd/T/wrap",
      "/private/var/folders/ab/cd/T",
      "/private/var/folders/ab/cd",
      "/private/var/folders/ab",
      "/private/var/folders",
      "/private/var",
      "/private",
      "/",
    ]) {
      expect(p).toContain(`(literal "${a}")`);
    }
  });

  // The distinction the whole approach rests on. `(literal "/x")` permits opening that directory;
  // `(subpath "/x")` permits everything under it. The per-user temp tree must get the first and
  // never the second — it holds every other process's scratch data, and in the spawn suite the
  // file the denial test expects to be refused.
  it("never turns an ancestor into a subpath", () => {
    const p = built();
    for (const a of ["/private/var/folders", "/private/var", "/private", "/"]) {
      expect(p).not.toContain(`(subpath "${a}")`);
    }
  });

  it("does not duplicate an ancestor shared by the cwd and the sandbox dir", () => {
    const p = built();
    const occurrences = p.split('(literal "/private/var/folders")').length - 1;
    expect(occurrences).toBe(1);
  });
});
