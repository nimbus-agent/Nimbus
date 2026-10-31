import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestWithExtraNetworkHosts } from "../../connectors/lazy-mesh/first-party-manifests.ts";
import { createDarwinSandboxRunner, generateSbplProfile } from "./darwin.ts";
import { policyFromManifest, type SandboxPolicy } from "./sandbox-policy.ts";

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

  const networkRules = (network: string[]): string[] =>
    generateSbplProfile({ cwd: CWD, tmpdir: CWD_TMP, policy: policy({ network }) })
      .split("\n")
      .filter((line) => line.includes("network"));
  const DNS_RULES = [
    '(allow network-outbound (remote udp "*:53"))',
    '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
  ];

  // The text only. Whether `sandbox-exec` accepts it, and what it does, is pinned in
  // `sandbox-wrapper-spawn.test.ts`: this text being "right" is how a profile that could not start
  // any child with a network shipped for five months.
  it("allows the port of a declared host, and names no host", () => {
    expect(networkRules(["api.github.com"])).toEqual([
      '(allow network-outbound (remote tcp "*:443"))',
      ...DNS_RULES,
    ]);
  });

  it("never emits a host filter, which sandbox-exec rejects", () => {
    const profile = generateSbplProfile({
      cwd: CWD,
      tmpdir: CWD_TMP,
      policy: policy({ network: ["api.github.com", "imap.fastmail.com:993"] }),
    });
    expect(profile).not.toContain("(host");
    expect(profile).not.toContain("github");
    expect(profile).not.toContain("fastmail");
  });

  it("emits each distinct port once, ascending, for host:port entries (IMAP/SMTP)", () => {
    expect(
      networkRules([
        "imap.fastmail.com:993",
        "smtp.fastmail.com:465",
        "a.com",
        "b.com",
        "c.com:993",
      ]),
    ).toEqual([
      '(allow network-outbound (remote tcp "*:443"))',
      '(allow network-outbound (remote tcp "*:465"))',
      '(allow network-outbound (remote tcp "*:993"))',
      ...DNS_RULES,
    ]);
  });

  it("gives a localhost or loopback entry the same *:port rule", () => {
    expect(networkRules(["localhost:8080", "127.0.0.1:9090"])).toEqual([
      '(allow network-outbound (remote tcp "*:8080"))',
      '(allow network-outbound (remote tcp "*:9090"))',
      ...DNS_RULES,
    ]);
  });

  it("emits no network rule, DNS included, when permissions.network is empty", () => {
    expect(networkRules([])).toEqual([]);
  });

  it.each([["a.com:notaport"], ["a.com:0"], ["a.com:65536"], ["a.com:1.5"], ["a.com:"]])(
    "opens nothing for %s, whose port is not a port",
    (entry) => {
      expect(networkRules([entry])).toEqual([]);
    },
  );

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

describe("generateSbplProfile, from a policy built by manifestWithExtraNetworkHosts", () => {
  it("has no injected quote, whatever a stored value carried", () => {
    const hostile = ['x")) (allow network*) (host "y', 'a"b.com:443', "a\nb.com", "a b.com"];
    const leaked = ["(host", '"y', 'a"b', "a\nb", "a b.com", "ok.example.com"];
    const manifest = manifestWithExtraNetworkHosts("jenkins", [...hostile, "ok.example.com:8443"], {
      ownerConfigured: hostile,
      onDropped: () => {},
    });
    const profile = generateSbplProfile({
      cwd: CWD,
      tmpdir: CWD_TMP,
      policy: policyFromManifest(manifest),
    });
    expect(profile.split("\n").filter((line) => line.includes("remote tcp"))).toEqual([
      '(allow network-outbound (remote tcp "*:8443"))',
    ]);
    for (const text of leaked) expect(profile).not.toContain(text);
  });

  // The door above no longer carries this: only a port reaches the profile, so a hostile value that
  // skipped it, straight from a policy, still cannot.
  it("has no injected text from a policy that skipped that door", () => {
    const hostile = ['x")) (allow network*) (host "y:443', 'a")) (allow default)\n:8443'];
    const profile = generateSbplProfile({
      cwd: CWD,
      tmpdir: CWD_TMP,
      policy: policy({ network: hostile }),
    });
    expect(profile).not.toContain("(host");
    expect(profile).not.toContain("(allow default)");
    expect(profile).not.toContain("(allow network*)");
    expect(profile.split("\n").filter((line) => line.includes("remote tcp"))).toEqual([
      '(allow network-outbound (remote tcp "*:443"))',
      '(allow network-outbound (remote tcp "*:8443"))',
    ]);
  });
});

describe("the macOS runner reports what it enforces", () => {
  const runner = createDarwinSandboxRunner();

  it("is per port, with a reason, and still fully active", () => {
    expect(runner.networkScope?.()).toBe("per_port");
    expect(runner.degradedReason()).toContain("limits ports, not hosts");
    expect(runner.isFullyActive()).toBe(true);
  });

  // Like Windows: the accepted asymmetry is reported, and refuses nothing.
  it("can confine a policy that names hosts, and one with no network", () => {
    expect(runner.canConfine(policy({ network: ["api.github.com"] }))).toBeNull();
    expect(runner.canConfine(policy())).toBeNull();
  });
});
