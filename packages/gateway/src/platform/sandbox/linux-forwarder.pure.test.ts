import { describe, expect, test } from "bun:test";

import {
  buildForwarderArgv,
  HELPER_IN_SANDBOX,
  innerResolvBind,
  renderHostsFile,
  renderResolvConf,
  resolvConfTarget,
  resolveHelperPath,
  rootDirFlags,
} from "./linux-forwarder.ts";
import { type ForwardEntry, RESOLVER_ADDRESS } from "./net-forward-host.ts";
import type { SandboxPolicy } from "./sandbox-policy.ts";

// Pure argv and file rendering: nothing here spawns bwrap or touches a socket, so it runs on every OS.

const entry = (over: Partial<ForwardEntry> = {}): ForwardEntry => ({
  host: "api.example.com",
  port: 443,
  trust: "package",
  loopbackIp: "127.0.0.2",
  ...over,
});

const policy = (read: string[] = []): SandboxPolicy => ({
  id: "pure",
  permissions: { network: ["api.example.com"], filesystem: { read, write: [] } },
});

const CONTEXT = { env: {}, home: "/home/o", uid: 1000, realpath: (p: string): string => p };

describe("resolveHelperPath", () => {
  test("a set override wins when it exists and is null when it does not, never a fall back", () => {
    const env = { NIMBUS_SANDBOX_HELPER_PATH: "/x/h" };
    expect(resolveHelperPath("/opt/gw", env, (p) => p === "/x/h")).toBe("/x/h");
    expect(resolveHelperPath("/opt/gw", env, (p) => p === "/opt/nimbus-sandbox-helper")).toBeNull();
  });
  test("falls to the installed helper, then null", () => {
    const installed = "/usr/lib/nimbus/bin/nimbus-sandbox-helper";
    expect(resolveHelperPath("/opt/gw", {}, (p) => p === installed)).toBe(installed);
    expect(resolveHelperPath("/opt/gw", {}, () => false)).toBeNull();
  });
});

describe("rootDirFlags", () => {
  test("a link into /usr stays a link, a real directory is bound, a missing one is skipped", () => {
    const links: Record<string, string> = {
      "/bin": "usr/bin",
      "/sbin": "/usr/sbin",
      "/lib64": "/elsewhere/lib64",
    };
    const exists = new Set(["/lib32"]);
    const flags = rootDirFlags({
      readlink: (p) => links[p] ?? null,
      exists: (p) => exists.has(p),
    });
    expect(flags).toEqual([
      "--symlink",
      "usr/bin",
      "/bin",
      "--symlink",
      "/usr/sbin",
      "/sbin",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind",
      "/lib64",
      "/lib64",
      "--ro-bind",
      "/lib32",
      "/lib32",
    ]);
  });
});

describe("renderHostsFile / renderResolvConf", () => {
  test("maps each exact name, with a trailing-dot twin, to its loopback address", () => {
    const text = renderHostsFile([
      entry(),
      entry({ port: 80 }),
      entry({ host: "b.example.com", loopbackIp: "127.0.0.3" }),
      entry({ host: null, loopbackIp: "127.0.0.4" }),
      entry({ host: "10.1.2.3", loopbackIp: "10.1.2.3" }),
    ]);
    expect(text).toBe(
      "127.0.0.1 localhost localhost.\n127.0.0.2 api.example.com api.example.com.\n127.0.0.3 b.example.com b.example.com.\n",
    );
  });
  test("an entry naming localhost owns the localhost line", () => {
    expect(renderHostsFile([entry({ host: "localhost", loopbackIp: "127.0.0.9" })])).toBe(
      "127.0.0.9 localhost localhost.\n",
    );
  });
  test("a name that could end the line is refused", () => {
    expect(() => renderHostsFile([entry({ host: "a b\nevil" })])).toThrow(/cannot be written/);
  });
  test("the resolver file names the stub resolver", () => {
    expect(renderResolvConf()).toBe(`nameserver ${RESOLVER_ADDRESS}\n`);
  });
});

describe("resolvConfTarget / innerResolvBind", () => {
  test("with no link the path is the file itself", () => {
    expect(resolvConfTarget(() => null)).toBe("/etc/resolv.conf");
  });
  test("follows a link by its text until it leaves /etc and /usr", () => {
    const links: Record<string, string> = {
      "/etc/resolv.conf": "../run/systemd/resolve/stub-resolv.conf",
    };
    expect(resolvConfTarget((p) => links[p] ?? null)).toBe("/run/systemd/resolve/stub-resolv.conf");
  });
  test("keeps following links that stay under /etc", () => {
    const links: Record<string, string> = { "/etc/resolv.conf": "/etc/real-resolv.conf" };
    expect(resolvConfTarget((p) => links[p] ?? null)).toBe("/etc/real-resolv.conf");
  });
  test("a loop of links is refused", () => {
    expect(() => resolvConfTarget(() => "/etc/resolv.conf")).toThrow(/too many symlinks/);
  });
  test("a target under /etc or /usr needs no extra bind, any other does", () => {
    expect(innerResolvBind("/etc/resolv.conf")).toEqual([]);
    expect(innerResolvBind("/usr/lib/x")).toEqual([]);
    expect(innerResolvBind("/run/x")).toEqual(["--ro-bind", "/run/x", "/run/x"]);
  });
});

describe("buildForwarderArgv", () => {
  const base = {
    cwd: "/work/proj",
    helperPath: "/opt/helper",
    socketDir: "/tmp/nf-abc123",
    hostsFile: "/tmp/nf-abc123/hosts",
    resolvFile: "/tmp/nf-abc123/resolv.conf",
    resolvConfTarget: "/etc/resolv.conf",
    pathContext: CONTEXT,
    rootLookup: { readlink: () => null, exists: () => false },
  };

  test("unshares the network, keeps the base capabilities and ends with the inner command", () => {
    const inner = [
      "/usr/bin/bwrap",
      "--ro-bind",
      "/opt/app",
      "/opt/app",
      "--seccomp",
      "9",
      "--",
      "child",
    ];
    const argv = buildForwarderArgv(policy(), { ...base, entries: [entry()], innerArgv: inner });
    expect(argv.slice(0, 4)).toEqual([
      "--unshare-user",
      "--unshare-net",
      "--unshare-pid",
      "--die-with-parent",
    ]);
    expect(argv).toContain("CAP_NET_BIND_SERVICE");
    expect(argv).not.toContain("CAP_NET_ADMIN");
    expect(argv.slice(-inner.length)).toEqual(inner);
    const helperAt = argv.indexOf(HELPER_IN_SANDBOX, argv.indexOf("--chdir"));
    expect(argv.slice(helperAt, helperAt + 3)).toEqual([
      HELPER_IN_SANDBOX,
      "--socket",
      "/tmp/nf-abc123/s",
    ]);
    expect(argv).toContain("--listen");
    expect(argv[argv.indexOf("--dns") + 1]).toBe(RESOLVER_ADDRESS);
  });

  test("mirrors the inner binds the outer view does not already provide", () => {
    const argv = buildForwarderArgv(policy(), {
      ...base,
      entries: [entry()],
      innerArgv: [
        "/opt/bwrap",
        "--ro-bind",
        "/opt/app",
        "/opt/app",
        "--bind",
        "/usr",
        "/usr",
        "--seccomp",
        "9",
      ],
    });
    const joined = argv.join(" ");
    expect(joined).toContain("--ro-bind /opt/bwrap /opt/bwrap");
    expect(joined).toContain("--ro-bind /opt/app /opt/app");
    expect(argv.slice(0, argv.indexOf("--")).join(" ").includes("--bind /usr /usr")).toBe(false);
  });

  test("an IP-literal alias adds CAP_NET_ADMIN and an --alias flag; localhost gets a second listener", () => {
    const argv = buildForwarderArgv(policy(), {
      ...base,
      entries: [
        entry({ host: "10.1.2.3", loopbackIp: "10.1.2.3" }),
        entry({ host: "localhost", port: 8080, loopbackIp: "127.0.0.5" }),
      ],
      innerArgv: ["/usr/bin/bwrap", "--seccomp", "9"],
    });
    expect(argv).toContain("CAP_NET_ADMIN");
    expect(argv[argv.indexOf("--alias") + 1]).toBe("10.1.2.3");
    expect(argv).toContain("127.0.0.5:8080:1");
    expect(argv).toContain("127.0.0.1:8080:1");
  });

  test("a policy path at or above the runtime directory throws", () => {
    expect(() =>
      buildForwarderArgv(policy(["/run"]), {
        ...base,
        entries: [entry()],
        innerArgv: ["/usr/bin/bwrap"],
      }),
    ).toThrow(/runtime directory/);
  });
});
