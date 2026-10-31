import { describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBwrapArgv,
  createLinuxSandboxRunner,
  decideNetworkMode,
  ownExecutableBind,
  resolverFileToBind,
} from "./linux.ts";
import {
  buildForwarderArgv,
  createForwarderDir,
  type ForwarderArgvOpts,
  ForwarderSocketPathError,
  forwarderPathRefusal,
  HELPER_IN_SANDBOX,
  innerResolvBind,
  renderHostsFile,
  renderResolvConf,
  resolvConfTarget,
  resolveHelperPath,
  rootDirFlags,
} from "./linux-forwarder.ts";
import { type ForwardEntry, planForwardEntries } from "./net-forward-host.ts";
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
  it("counts wildcards as a declared network", () => {
    const policy: SandboxPolicy = {
      ...basePolicy(),
      firstPartyPolicy: true,
      firstPartyWildcardHosts: ["*-run.googleapis.com"],
    };
    expect(decideNetworkMode(policy, { helperAvailable: true })).toBe("per-host");
    expect(decideNetworkMode(policy, { helperAvailable: false })).toBe("fallback");
  });
});

describe("ownExecutableBind", () => {
  const TARBALL = "/home/owner/.local/bin/nimbus-gateway";

  it("binds this executable's one file, never its directory", () => {
    expect(ownExecutableBind(TARBALL, TARBALL)).toEqual(["--ro-bind", TARBALL, TARBALL]);
  });

  it("an AppImage's mount gets the same", () => {
    const mounted = "/tmp/.mount_nimbusAbC/usr/bin/nimbus-gateway";
    expect(ownExecutableBind(mounted, mounted)).toEqual(["--ro-bind", mounted, mounted]);
  });

  it("adds nothing under /usr, which every view binds", () => {
    const installed = "/usr/lib/nimbus/bin/nimbus-gateway";
    expect(ownExecutableBind(installed, installed)).toEqual([]);
  });

  it("adds nothing for any other command: a policy decides what that can see", () => {
    expect(ownExecutableBind("/home/owner/bin/server", TARBALL)).toEqual([]);
    expect(ownExecutableBind("aws", TARBALL)).toEqual([]);
  });
});

/** The bug this bind fixes: a gateway outside /usr, as a tarball installs it, started no connector. */
describe.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/bwrap"))(
  "a child that is this executable, outside every bound tree, with an empty policy",
  () => {
    function exitOf(cmd: string, ownExecutable: string): Promise<number | null> {
      const runner = createLinuxSandboxRunner({ ownExecutable });
      const cwd = join(mkdtempSync(join(TMP_ROOT, "own-exec-")), "cwd");
      mkdirSync(cwd);
      const child = runner.spawn(cmd, [], { policy: basePolicy(), env: {}, cwd, stdio: "ignore" });
      return new Promise((done) => child.once("exit", (code) => done(code)));
    }

    function installedCopy(): string {
      const dir = join(realpathSync(mkdtempSync(join(TMP_ROOT, "home-"))), ".local", "bin");
      mkdirSync(dir, { recursive: true });
      const copy = join(dir, "nimbus-gateway");
      copyFileSync(realpathSync("/usr/bin/true"), copy);
      chmodSync(copy, 0o755);
      return copy;
    }

    it("starts", async () => {
      const copy = installedCopy();
      expect(await exitOf(copy, copy)).toBe(0);
    });

    it("the same file does not start when it is not this executable, so the test proves the bind", async () => {
      const copy = installedCopy();
      expect(await exitOf(copy, "/usr/bin/nothing-else")).not.toBe(0);
    });
  },
);

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

describe("the root's program and library directories", () => {
  const MERGED = {
    readlink: (p: string): string | null =>
      ({ "/bin": "usr/bin", "/sbin": "usr/sbin", "/lib": "usr/lib", "/lib64": "usr/lib64" })[p] ??
      null,
    exists: (): boolean => false,
  };
  const SPLIT = {
    readlink: (): string | null => null,
    exists: (p: string): boolean => ["/bin", "/sbin", "/lib", "/lib64"].includes(p),
  };

  it("a merged-usr host gets its own links, since /usr is bound", () => {
    expect(rootDirFlags(MERGED)).toEqual([
      "--symlink",
      "usr/bin",
      "/bin",
      "--symlink",
      "usr/sbin",
      "/sbin",
      "--symlink",
      "usr/lib",
      "/lib",
      "--symlink",
      "usr/lib64",
      "/lib64",
    ]);
  });

  it("a split host gets each directory bound, and what it lacks is left out", () => {
    expect(rootDirFlags(SPLIT)).toEqual([
      "--ro-bind",
      "/bin",
      "/bin",
      "--ro-bind",
      "/sbin",
      "/sbin",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind",
      "/lib64",
      "/lib64",
    ]);
  });

  it("a link out of /usr is bound through, since its target is not otherwise there", () => {
    const flags = rootDirFlags({
      readlink: (p) => (p === "/lib64" ? "/opt/lib64" : null),
      exists: () => false,
    });
    expect(flags.join(" ")).toContain("--ro-bind /lib64 /lib64");
  });

  it("every mode gets them, and every mode unshares the pid namespace that bounds a child's signals", () => {
    for (const mode of ["no-net", "per-host", "fallback"] as const) {
      const argv = buildBwrapArgv(basePolicy(), { mode, cwd: CWD, rootLookup: MERGED });
      expect(argv.join(" ")).toContain("--symlink usr/bin /bin");
      expect(argv).toContain("--unshare-pid");
    }
  });
});

describe("the resolver file", () => {
  const bindOf = (argv: readonly string[], path: string): boolean =>
    argv.some((a, i) => a === "--ro-bind" && argv[i + 1] === path && argv[i + 2] === path);
  const STUB = "/run/systemd/resolve/stub-resolv.conf";

  it("a child on the host's network gets the file behind Ubuntu's symlink", () => {
    const argv = buildBwrapArgv(basePolicy({ network: ["a.com"] }), {
      mode: "fallback",
      cwd: CWD,
      resolverFile: STUB,
    });
    expect(bindOf(argv, STUB)).toBe(true);
  });

  it("a child behind the forwarder never does: it reads the generated file", () => {
    const argv = buildBwrapArgv(basePolicy({ network: ["a.com"] }), {
      mode: "per-host",
      cwd: CWD,
      resolverFile: STUB,
    });
    expect(bindOf(argv, STUB)).toBe(false);
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

describe("resolveHelperPath", () => {
  const OVERRIDE = "/opt/helper";
  const BESIDE = "/opt/nimbus/nimbus-sandbox-helper";
  const INSTALLED = "/usr/lib/nimbus/bin/nimbus-sandbox-helper";
  const EXEC = "/opt/nimbus/nimbus-gateway";
  const only =
    (...present: string[]) =>
    (p: string): boolean =>
      present.includes(p);

  it("an override wins over everything", () => {
    const env = { NIMBUS_SANDBOX_HELPER_PATH: OVERRIDE };
    expect(resolveHelperPath(EXEC, env, only(OVERRIDE, BESIDE, INSTALLED))).toBe(OVERRIDE);
  });
  it("an override naming nothing is null, and does not fall through to another binary", () => {
    const env = { NIMBUS_SANDBOX_HELPER_PATH: OVERRIDE };
    expect(resolveHelperPath(EXEC, env, only(BESIDE, INSTALLED))).toBeNull();
  });
  it("next, a helper beside the executable", () => {
    expect(resolveHelperPath(EXEC, {}, only(BESIDE, INSTALLED))).toBe(BESIDE);
  });
  it("next, the installed path", () => {
    expect(resolveHelperPath(EXEC, {}, only(INSTALLED))).toBe(INSTALLED);
  });
  it("else null", () => {
    expect(resolveHelperPath(EXEC, {}, only())).toBeNull();
  });
});

describe("buildForwarderArgv", () => {
  const HOME = "/home/owner";
  const RUNTIME = "/run/user/1000";
  const SOCKET_DIR = "/tmp/nf-abc";
  const FWD_CWD = "/home/owner/.local/share/nimbus/sandbox/x";
  const pathContext = {
    env: { XDG_RUNTIME_DIR: RUNTIME },
    home: HOME,
    uid: 1000,
    realpath: (p: string): string => p,
  };
  const REAL_FLAGS = ["--uid", "1000", "--gid", "1000"];

  function innerFor(policy: SandboxPolicy, bwrap = "/usr/bin/bwrap"): string[] {
    return [
      bwrap,
      ...REAL_FLAGS,
      ...buildBwrapArgv(policy, { mode: "per-host", cwd: FWD_CWD }),
      "--seccomp",
      "3",
      "/opt/app/run",
      "--flag",
    ];
  }

  function argvFor(
    policy: SandboxPolicy,
    over: Partial<ForwarderArgvOpts> = {},
  ): { outer: string[]; inner: string[]; all: string[] } {
    const innerArgv = over.innerArgv ?? innerFor(policy);
    const all = buildForwarderArgv(policy, {
      cwd: FWD_CWD,
      helperPath: "/home/owner/.local/bin/nimbus-sandbox-helper",
      socketDir: SOCKET_DIR,
      hostsFile: `${SOCKET_DIR}/hosts`,
      resolvFile: `${SOCKET_DIR}/resolv.conf`,
      resolvConfTarget: "/etc/resolv.conf",
      entries: planForwardEntries(policy),
      pathContext,
      ...over,
      innerArgv,
    });
    const split = all.indexOf("--");
    return { outer: all.slice(0, split), inner: all.slice(split + 1), all };
  }

  /** Every `--bind`/`--ro-bind` of an argv, as "source -> destination". */
  function bindsOf(argv: readonly string[]): string[] {
    const out: string[] = [];
    argv.forEach((arg, i) => {
      if (arg === "--bind" || arg === "--ro-bind") out.push(`${argv[i + 1]} -> ${argv[i + 2]}`);
    });
    return out;
  }
  const destinations = (argv: readonly string[]): string[] =>
    bindsOf(argv).map((b) => b.split(" -> ")[1] ?? "");

  const webPolicy = basePolicy({ network: ["api.example.com"] });

  it("makes the namespaces, as uid 0, keeping exactly the three capabilities", () => {
    const { outer } = argvFor(webPolicy);
    for (const flag of ["--unshare-user", "--unshare-net", "--unshare-pid", "--die-with-parent"]) {
      expect(outer).toContain(flag);
    }
    expect(outer.join(" ")).toContain("--uid 0 --gid 0");
    const caps = outer.filter((_a, i) => outer[i - 1] === "--cap-add");
    expect(caps).toEqual(["CAP_NET_BIND_SERVICE", "CAP_SETPCAP", "CAP_SETFCAP"]);
  });

  it("never shares the host network, whatever the policy", () => {
    expect(argvFor(webPolicy).outer).not.toContain("--share-net");
  });

  it("adds CAP_NET_ADMIN and an alias only for a literal outside 127.0.0.0/8", () => {
    const lan = argvFor(basePolicy({ network: ["192.168.1.5:8080", "192.168.1.5:9090"] })).outer;
    expect(lan).toContain("CAP_NET_ADMIN");
    expect(lan.filter((a) => a === "--alias")).toHaveLength(1);
    expect(lan[lan.indexOf("--alias") + 1]).toBe("192.168.1.5");

    const local = argvFor(basePolicy({ network: ["127.0.0.1:1143"] })).outer;
    expect(local).not.toContain("CAP_NET_ADMIN");
    expect(local).not.toContain("--alias");
    expect(local).toContain("127.0.0.1:1143:0");

    expect(argvFor(webPolicy).outer).not.toContain("CAP_NET_ADMIN");
  });

  it("a localhost entry listens on its own address and on the 127.0.0.1 a client may assume", () => {
    const { outer } = argvFor(basePolicy({ network: ["localhost:1143"] }));
    expect(outer).toContain("127.0.0.2:1143:0");
    expect(outer).toContain("127.0.0.1:1143:0");
    // Without this, the same port on two entries would make the launcher exit 3 on the second bind.
    const both = argvFor(basePolicy({ network: ["localhost:1143", "127.0.0.1:1143"] })).outer;
    expect(both.filter((a) => a.startsWith("127.0.0.1:1143:"))).toHaveLength(1);
  });

  it("binds exactly the spec's list and what the inner bwrap binds, and none of the host's sockets", () => {
    const policy = basePolicy({
      network: ["api.example.com"],
      filesystem: { read: ["/opt/app"], write: ["/srv/data"] },
    });
    const { outer } = argvFor(policy);
    const dests = destinations(outer);
    for (const forbidden of ["/", "/run", "/var/run", HOME, RUNTIME, "/home", "/var"]) {
      expect(dests).not.toContain(forbidden);
    }
    const expected = new Set([
      "/usr",
      "/etc",
      FWD_CWD,
      "/opt/app",
      "/srv/data",
      "/etc/hosts",
      "/etc/resolv.conf",
      HELPER_IN_SANDBOX,
      SOCKET_DIR,
    ]);
    const rootDirs = ["/bin", "/sbin", "/lib", "/lib64", "/lib32", "/libx32"];
    const unknown = dests.filter((d) => !expected.has(d) && !rootDirs.includes(d));
    expect(unknown).toEqual([]);
    expect(outer.join(" ")).toContain("--tmpfs /tmp");
    expect(outer.join(" ")).toContain("--proc /proc");
    expect(outer.join(" ")).toContain("--dev /dev");
  });

  it("keeps a writable path writable, so the inner bind can use it", () => {
    const policy = basePolicy({
      network: ["api.example.com"],
      filesystem: { read: ["/srv/data"], write: ["/srv/data"] },
    });
    const { outer } = argvFor(policy);
    expect(outer.join(" ")).toContain("--bind /srv/data /srv/data");
    expect(outer.join(" ")).toContain(`--bind ${FWD_CWD} ${FWD_CWD}`);
  });

  it("binds a bwrap outside /usr at its own path, and only then", () => {
    const nix = "/nix/store/abc/bin/bwrap";
    expect(bindsOf(argvFor(webPolicy, { innerArgv: innerFor(webPolicy, nix) }).outer)).toContain(
      `${nix} -> ${nix}`,
    );
    expect(destinations(argvFor(webPolicy).outer)).not.toContain("/usr/bin/bwrap");
  });

  it("binds the generated files over the real ones, after everything else", () => {
    const { outer } = argvFor(webPolicy, { resolvConfTarget: "/run/systemd/resolve/stub.conf" });
    const binds = bindsOf(outer);
    expect(binds).toContain(`${SOCKET_DIR}/hosts -> /etc/hosts`);
    expect(binds).toContain(`${SOCKET_DIR}/resolv.conf -> /run/systemd/resolve/stub.conf`);
    const etc = binds.indexOf("/etc -> /etc");
    expect(binds.indexOf(`${SOCKET_DIR}/hosts -> /etc/hosts`)).toBeGreaterThan(etc);
    expect(destinations(outer)).not.toContain("/run");
  });

  it("binds the helper at a fixed path under /run, and runs it from there", () => {
    const { outer } = argvFor(webPolicy);
    expect(bindsOf(outer)).toContain(
      `/home/owner/.local/bin/nimbus-sandbox-helper -> ${HELPER_IN_SANDBOX}`,
    );
    const socketFlag = outer.indexOf("--socket");
    expect(outer[socketFlag - 1]).toBe(HELPER_IN_SANDBOX);
    expect(outer[socketFlag + 1]).toBe(`${SOCKET_DIR}/s`);
    expect(destinations(outer)).not.toContain("/home/owner/.local/bin");
  });

  it("binds the socket directory in the outer view and not in the inner one", () => {
    const { outer, inner } = argvFor(webPolicy);
    expect(destinations(outer)).toContain(SOCKET_DIR);
    expect(inner.join(" ")).not.toContain(SOCKET_DIR);
  });

  it("the inner command is bwrap, today's flags, the real uid, and --seccomp 3 last", () => {
    const { inner } = argvFor(webPolicy);
    expect(inner[0]).toBe("/usr/bin/bwrap");
    expect(inner).toContain("--share-net");
    expect(inner).not.toContain("--unshare-net");
    expect(inner.join(" ")).toContain("--uid 1000 --gid 1000");
    expect(inner.slice(-4)).toEqual(["--seccomp", "3", "/opt/app/run", "--flag"]);
    expect(inner.slice(1, -4).filter((a) => a === "--seccomp")).toEqual([]);
  });

  it("does not mirror a path that only looks like a bind after --seccomp", () => {
    const innerArgv = [...innerFor(webPolicy), "--bind", "/etc/shadow", "/x"];
    expect(destinations(argvFor(webPolicy, { innerArgv }).outer)).not.toContain("/etc/shadow");
  });

  it("gives every pool slot a listener, and passes each entry's own index", () => {
    const policy: SandboxPolicy = {
      ...basePolicy({ network: ["api.example.com"] }),
      firstPartyPolicy: true,
      firstPartyWildcardHosts: ["*-run.googleapis.com"],
    };
    const entries = planForwardEntries(policy);
    expect(entries).toHaveLength(49);
    const { outer } = argvFor(policy, { entries });
    entries.forEach((entry, index) => {
      expect(outer).toContain(`${entry.loopbackIp}:${String(entry.port)}:${String(index)}`);
    });
    expect(renderHostsFile(entries)).toBe(
      "127.0.0.1 localhost localhost.\n127.0.0.2 api.example.com api.example.com.\n",
    );
  });

  it("a wildcard-only policy still has a listener, which the helper requires", () => {
    const policy: SandboxPolicy = {
      ...basePolicy(),
      firstPartyPolicy: true,
      firstPartyWildcardHosts: ["*.sharepoint.com"],
    };
    const { outer } = argvFor(policy);
    expect(outer.filter((a) => a === "--listen")).toHaveLength(48);
    expect(renderHostsFile(planForwardEntries(policy))).toBe("127.0.0.1 localhost localhost.\n");
  });

  it("252 exact hosts plus wildcards has no pool, and every exact entry still listens", () => {
    const network = Array.from({ length: 252 }, (_v, i) => `h${String(i)}.example.com`);
    const policy: SandboxPolicy = {
      ...basePolicy({ network }),
      firstPartyPolicy: true,
      firstPartyWildcardHosts: ["*.sharepoint.com"],
    };
    const entries = planForwardEntries(policy);
    expect(entries.every((e) => e.host !== null)).toBe(true);
    expect(argvFor(policy, { entries }).outer.filter((a) => a === "--listen")).toHaveLength(252);
  });

  it("a 253rd host is refused by the planner every path goes through", () => {
    const network = Array.from({ length: 253 }, (_v, i) => `h${String(i)}.example.com`);
    expect(() => planForwardEntries(basePolicy({ network }))).toThrow(/at most 252/);
  });

  it("refuses to build a view the policy would widen", () => {
    for (const path of ["/", "/run", "/var/run", "/var", RUNTIME, "/run/user"]) {
      const policy = basePolicy({
        network: ["a.com"],
        filesystem: { read: [path], write: [] },
      });
      expect(() => argvFor(policy)).toThrow(/runtime directory/);
    }
    expect(() => argvFor(webPolicy, { cwd: HOME })).toThrow(/\$HOME/);
    expect(() => argvFor(webPolicy, { cwd: "/home" })).toThrow(/\$HOME/);
  });

  it("keeps a policy path at $HOME, the owner's grant, which the child could reach anyway", () => {
    const policy = basePolicy({ network: ["a.com"], filesystem: { read: [HOME], write: [] } });
    expect(destinations(argvFor(policy).outer)).toContain(HOME);
  });

  it("a symlink to a refused directory is refused by where it leads", () => {
    const policy = basePolicy({
      network: ["a.com"],
      filesystem: { read: ["/opt/sockets"], write: [] },
    });
    expect(
      forwarderPathRefusal(policy, {
        ...pathContext,
        realpath: (p) => (p === "/opt/sockets" ? "/run" : p),
      }),
    ).toContain("/opt/sockets");
  });

  it("a path below the runtime directory is narrow enough to keep", () => {
    const policy = basePolicy({
      network: ["a.com"],
      filesystem: { read: [`${RUNTIME}/app/data`], write: [] },
    });
    expect(forwarderPathRefusal(policy, pathContext)).toBeNull();
  });
});

describe("the generated files", () => {
  const entry = (host: string | null, loopbackIp: string, port = 443): ForwardEntry => ({
    host,
    port,
    trust: "owner",
    loopbackIp,
  });

  it("maps each name once, with both spellings, and two ports share a line", () => {
    expect(
      renderHostsFile([
        entry("jenkins.corp", "127.0.0.2", 8080),
        entry("jenkins.corp", "127.0.0.2", 8443),
        entry("my_jenkins", "127.0.0.3"),
      ]),
    ).toBe(
      "127.0.0.1 localhost localhost.\n127.0.0.2 jenkins.corp jenkins.corp.\n127.0.0.3 my_jenkins my_jenkins.\n",
    );
  });

  it("writes no line for an IP literal or a pool slot", () => {
    expect(renderHostsFile([entry("192.168.1.5", "192.168.1.5"), entry(null, "127.0.0.2")])).toBe(
      "127.0.0.1 localhost localhost.\n",
    );
  });

  it("maps localhost to the address an entry holds, and otherwise to 127.0.0.1", () => {
    const named = planForwardEntries(basePolicy({ network: ["localhost:1143", "a.example.com"] }));
    expect(renderHostsFile(named)).toBe(
      "127.0.0.2 localhost localhost.\n127.0.0.3 a.example.com a.example.com.\n",
    );
    const unnamed = planForwardEntries(basePolicy({ network: ["a.example.com"] }));
    expect(renderHostsFile(unnamed)).toBe(
      "127.0.0.1 localhost localhost.\n127.0.0.2 a.example.com a.example.com.\n",
    );
  });

  it.each([
    ["a newline that would inject a mapping", "evil\n1.2.3.4 api.github.com"],
    ["a space that would add a name", "a.com b.com"],
    ["a comment marker", "a.com#"],
    ["a tab", "a\tb"],
    ["a trailing newline", "a.com\n"],
    ["upper case, which the planner never produces", "A.com"],
  ])("refuses %s rather than write it", (_name, host) => {
    expect(() => renderHostsFile([entry(host, "127.0.0.2")])).toThrow(/hosts/);
  });

  it("points the resolver at the stub and nothing else", () => {
    expect(renderResolvConf()).toBe("nameserver 127.0.0.53\n");
  });
});

describe("resolvConfTarget", () => {
  const links =
    (map: Record<string, string>) =>
    (p: string): string | null =>
      map[p] ?? null;

  it("is /etc/resolv.conf itself when that is a plain file", () => {
    expect(resolvConfTarget(links({}))).toBe("/etc/resolv.conf");
  });
  it("follows Ubuntu's relative link out of /etc, so the bind lands where the link reaches", () => {
    const target = resolvConfTarget(
      links({ "/etc/resolv.conf": "../run/systemd/resolve/stub-resolv.conf" }),
    );
    expect(target).toBe("/run/systemd/resolve/stub-resolv.conf");
    expect(innerResolvBind(target)).toEqual(["--ro-bind", target, target]);
  });
  it("keeps /var/run as written, since /etc/resolv.conf reaches it by that spelling", () => {
    expect(
      resolvConfTarget(links({ "/etc/resolv.conf": "/var/run/NetworkManager/resolv.conf" })),
    ).toBe("/var/run/NetworkManager/resolv.conf");
  });
  it("follows a chain inside /etc to the file itself, which the inner view already carries", () => {
    const target = resolvConfTarget(
      links({ "/etc/resolv.conf": "resolvconf/run/link", "/etc/resolvconf/run/link": "real" }),
    );
    expect(target).toBe("/etc/resolvconf/run/real");
    expect(innerResolvBind(target)).toEqual([]);
  });
  it("gives up on a loop rather than spin", () => {
    expect(() => resolvConfTarget(() => "/etc/resolv.conf")).toThrow(/symlinks/);
  });
});

describe("createForwarderDir", () => {
  it("refuses, by name, when no candidate can hold the socket", () => {
    const long = `/${"x".repeat(120)}`;
    expect(() => createForwarderDir(["/tmp"], { XDG_RUNTIME_DIR: long, TMPDIR: long })).toThrow(
      ForwarderSocketPathError,
    );
  });
  it("skips a directory a bound path would show the child", () => {
    expect(() => createForwarderDir(["/"], {})).toThrow(ForwarderSocketPathError);
  });
});
