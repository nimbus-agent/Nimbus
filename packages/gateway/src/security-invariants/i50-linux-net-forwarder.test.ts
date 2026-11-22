import { describe, expect, test } from "bun:test";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { read, readDirFiles } from "../../test/helpers/security-invariants.ts";

describe("I50 — on Linux a sandboxed child's only network path is the forwarder, and the wrapper checks every connection", () => {
  const SANDBOX = "packages/gateway/src/platform/sandbox";

  /** The text of `function name(` up to the first closing brace at column 0. */
  const bodyOf = (src: string, name: string): string => {
    const start = src.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  const pathContext = {
    env: { HOME: "/home/owner", XDG_RUNTIME_DIR: "/run/user/1000" },
    home: "/home/owner",
    uid: 1000,
    realpath: (p: string): string => p,
  };

  async function perHostArgv(
    filesystem: { read: string[]; write: string[] } = { read: [], write: [] },
  ): Promise<{ argv: string[]; inner: string[] }> {
    const { buildForwarderArgv } = await import("../platform/sandbox/linux-forwarder.ts");
    const { buildForwarderInnerFlags } = await import("../platform/sandbox/linux.ts");
    const { planForwardEntries } = await import("../platform/sandbox/net-forward-host.ts");
    const policy = {
      id: "i50",
      permissions: { network: ["api.example.com"], filesystem },
      firstPartyPolicy: true,
    };
    const cwd = "/data/cache/nimbus/sandbox/i50";
    const inner = [
      "/usr/bin/bwrap",
      ...buildForwarderInnerFlags(policy, cwd),
      "--seccomp",
      "3",
      "/usr/bin/true",
    ];
    const argv = buildForwarderArgv(policy, {
      cwd,
      helperPath: "/usr/lib/nimbus/bin/nimbus-sandbox-helper",
      socketDir: "/data/cache/nimbus-fwd/nf-abc123",
      hostsFile: "/data/cache/nimbus-fwd/nf-abc123/hosts",
      resolvFile: "/data/cache/nimbus-fwd/nf-abc123/resolv.conf",
      resolvConfTarget: "/etc/resolv.conf",
      entries: planForwardEntries(policy),
      innerArgv: inner,
      pathContext,
      rootLookup: { readlink: () => null, exists: () => false },
    });
    return { argv, inner };
  }

  test("behavioural: a per-host argv unshares the network in the OUTER bwrap, and --share-net is only in the inner command", async () => {
    const { argv, inner } = await perHostArgv();
    const outer = argv.slice(0, argv.length - inner.length);
    expect(argv.slice(outer.length)).toEqual(inner);
    expect(outer).toContain("--unshare-net");
    expect(outer).not.toContain("--share-net");
    // The inner bwrap shares the (empty, forwarder-only) namespace it was started in. Asserting
    // the inner has no --unshare-net alone would pass vacuously, so assert it does share.
    expect(inner).toContain("--share-net");
    expect(inner).not.toContain("--unshare-net");
  });

  test("behavioural: the outer view never binds /, /run, /var/run, $HOME or $XDG_RUNTIME_DIR", async () => {
    const { argv, inner } = await perHostArgv({ read: ["/opt/tools"], write: [] });
    const outer = argv.slice(0, argv.length - inner.length);
    const bound: string[] = [];
    outer.forEach((flag, i) => {
      if (flag === "--bind" || flag === "--ro-bind") {
        bound.push(outer[i + 1] as string, outer[i + 2] as string);
      }
    });
    expect(bound).toContain("/opt/tools");
    for (const path of ["/", "/run", "/var/run", "/home/owner", "/run/user/1000"]) {
      expect(bound).not.toContain(path);
    }
  });

  test("behavioural: a policy path at or above the runtime directories is refused for a network policy", async () => {
    for (const path of ["/", "/run", "/var/run", "/run/user/1000", "/run/user"]) {
      await expect(perHostArgv({ read: [path], write: [] })).rejects.toThrow(/runtime directory/);
    }
  });

  test("source: per-host reaches a child only through spawnBehindForwarder, openForwarderSession and buildForwarderArgv", async () => {
    const linux = stripComments(await read(`${SANDBOX}/linux.ts`));
    const forwarder = stripComments(await read(`${SANDBOX}/linux-forwarder.ts`));
    expect(linux).toMatch(
      /mode === "per-host" && HELPER_PATH !== null\) \{\s*assertForwarderReady\(helper, probe\);\s*return spawnBehindForwarder\(/,
    );
    expect(bodyOf(linux, "spawnBehindForwarder")).toContain("openForwarderSession(");
    expect(bodyOf(forwarder, "openForwarderSession")).toContain("buildForwarderArgv(");
    // The plain-bwrap path never names the per-host mode.
    expect(bodyOf(linux, "spawnWithoutForwarder")).not.toContain("per-host");
    // A per-host buildBwrapArgv (the one that emits --share-net) is built only as the INNER flags.
    expect([...linux.matchAll(/mode:\s*"per-host"/g)]).toHaveLength(1);
    expect(bodyOf(linux, "buildForwarderInnerFlags")).toContain('mode: "per-host"');
  });

  test("static: --share-net is written only in linux.ts's buildBwrapArgv, and the outer builder unshares the network first", async () => {
    const files = await readDirFiles(SANDBOX);
    const withShare = files
      .filter((f) => stripComments(f.contents).includes("--share-net"))
      .map((f) => f.rel);
    expect(withShare).toEqual(["linux.ts"]);
    const linux = stripComments(await read(`${SANDBOX}/linux.ts`));
    expect([...linux.matchAll(/--share-net/g)]).toHaveLength(1);
    expect(bodyOf(linux, "buildBwrapArgv")).toContain('"--share-net"');
    const forwarder = stripComments(await read(`${SANDBOX}/linux-forwarder.ts`));
    const outerBuilder = bodyOf(forwarder, "buildForwarderArgv");
    expect(outerBuilder).toContain('"--unshare-net"');
    expect(outerBuilder.indexOf('"--unshare-net"')).toBeLessThan(outerBuilder.indexOf("--ro-bind"));
  });

  test("source: the wrapper dials only an address allowedAddresses kept, after resolving once", async () => {
    const src = stripComments(await read(`${SANDBOX}/net-forward-host.ts`));
    // connect is called in exactly one place, over the kept list.
    expect([...src.matchAll(/this\.opts\.connect\(/g)]).toHaveLength(1);
    expect(src).toMatch(/for \(const ip of kept\) \{[^}]*this\.opts\.connect\(ip, port\)/s);
    // The kept list is allowedAddresses' output and nothing else.
    expect([...src.matchAll(/allowedAddresses\(/g)]).toHaveLength(1);
    expect(src).toContain(
      "const kept = allowedAddresses({ host: name, trust: entry.trust }, answers);",
    );
    // dialAndRelay resolves and filters, returns on an empty list, and only then connects.
    const dial = src.slice(src.indexOf("async dialAndRelay("));
    const resolveAt = dial.indexOf("this.resolveAllowed(");
    const emptyAt = dial.indexOf("kept.length === 0");
    const connectAt = dial.indexOf("this.connectFirst(conn, kept,");
    expect(resolveAt).toBeGreaterThan(-1);
    expect(emptyAt).toBeGreaterThan(resolveAt);
    expect(connectAt).toBeGreaterThan(emptyAt);
    // The trust that picks the rule comes from the plan's entry, never from the wire.
    expect(src).toContain("const entry = this.opts.entries[index];");
  });

  test("behavioural: allowedAddresses keeps a public answer and drops link-local, loopback and unspecified ones", async () => {
    const { allowedAddresses } = await import("../platform/sandbox/net-address-rules.ts");
    const answers = ["93.184.216.34", "169.254.169.254", "127.0.0.1", "0.0.0.0", "::1", "fe80::1"];
    for (const trust of ["first-party", "package", "owner"] as const) {
      expect(allowedAddresses({ host: "example.com", trust }, answers)).toEqual(["93.184.216.34"]);
    }
    // A name an extension declared cannot reach the owner's LAN. A first-party one can.
    expect(allowedAddresses({ host: "example.com", trust: "package" }, ["10.0.0.5"])).toEqual([]);
    expect(allowedAddresses({ host: "example.com", trust: "first-party" }, ["10.0.0.5"])).toEqual([
      "10.0.0.5",
    ]);
  });

  test("source: a wildcard pattern originates only in first-party-manifests.ts's table, and the policy layer only copies it", async () => {
    const files = await readDirFiles("packages/gateway/src");
    const mentions = files
      .filter((f) =>
        /firstPartyWildcardHosts|FIRST_PARTY_WILDCARD_HOSTS/.test(stripComments(f.contents)),
      )
      .map((f) => f.rel)
      .sort();
    expect(mentions).toEqual([
      "connectors/lazy-mesh/first-party-manifests.ts",
      "extensions/manifest.ts",
      "platform/sandbox/linux-forwarder.ts",
      "platform/sandbox/linux.ts",
      "platform/sandbox/net-forward-host.ts",
      "platform/sandbox/sandbox-policy.ts",
    ]);
    // No manifest parser, here or in the shared package, names the field.
    const shared = await readDirFiles("packages/registry-format/src");
    expect(shared.filter((f) => /firstPartyWildcardHosts/.test(stripComments(f.contents)))).toEqual(
      [],
    );
    // The table is a literal in the one file, and manifestForFirstParty is the one function that
    // copies it into a manifest.
    const table = stripComments(
      await read("packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts"),
    );
    expect(table).toContain("export const FIRST_PARTY_WILDCARD_HOSTS");
    expect([...table.matchAll(/firstPartyWildcardHosts:/g)]).toHaveLength(1);
    expect(bodyOf(table, "manifestForFirstParty")).toContain(
      "FIRST_PARTY_WILDCARD_HOSTS[serviceId]",
    );
    // sandbox-policy.ts copies from the manifest or validates a parsed policy. It writes no pattern.
    const policy = stripComments(await read(`${SANDBOX}/sandbox-policy.ts`));
    expect(policy).not.toMatch(/firstPartyWildcardHosts:\s*\[/);
    expect(policy).not.toMatch(/["'`]\*[.\-a-z0-9*]*["'`]/);
  });

  test("behavioural: a manifest file cannot carry a wildcard, and a policy with one but no firstPartyPolicy is refused", async () => {
    const { parseExtensionManifestJson } = await import("../extensions/manifest.ts");
    const { manifestForFirstParty, FIRST_PARTY_WILDCARD_HOSTS } = await import(
      "../connectors/lazy-mesh/first-party-manifests.ts"
    );
    const { policyFromManifest } = await import("../platform/sandbox/sandbox-policy.ts");
    const { isValidWildcardHost } = await import("../platform/sandbox/net-wildcard-hosts.ts");
    const { planForwardEntries } = await import("../platform/sandbox/net-forward-host.ts");

    const parsed = parseExtensionManifestJson(
      JSON.stringify({
        id: "x",
        version: "1.0.0",
        permissions: { network: ["api.example.com"], filesystem: { read: [], write: [] } },
        firstPartyWildcardHosts: ["*.example.com"],
        firstPartyPolicy: true,
      }),
    );
    expect("firstPartyWildcardHosts" in parsed).toBe(false);
    expect("firstPartyWildcardHosts" in policyFromManifest(parsed)).toBe(false);

    // Every table entry is a valid pattern and reaches a policy through manifestForFirstParty.
    expect(Object.keys(FIRST_PARTY_WILDCARD_HOSTS).length).toBeGreaterThan(0);
    for (const [service, patterns] of Object.entries(FIRST_PARTY_WILDCARD_HOSTS)) {
      for (const p of patterns) expect(isValidWildcardHost(p)).toBe(true);
      expect(manifestForFirstParty(service).firstPartyWildcardHosts).toEqual([...patterns]);
    }
    expect(manifestForFirstParty("github").firstPartyWildcardHosts).toBeUndefined();

    const base = {
      id: "x",
      permissions: { network: ["api.example.com"], filesystem: { read: [], write: [] } },
      firstPartyWildcardHosts: ["*.sharepoint.com"],
    };
    expect(() => planForwardEntries(base)).toThrow(/first-party/);
    expect(() => planForwardEntries({ ...base, firstPartyPolicy: true })).not.toThrow();
  });

  test("source: a pool slot's name is re-matched against the wildcards before the wrapper dials", async () => {
    const src = stripComments(await read(`${SANDBOX}/net-forward-host.ts`));
    // nameOnSlot answers a name only while a wildcard still covers it.
    const slot = src.slice(src.indexOf("nameOnSlot: (index)"));
    expect(slot.slice(0, 400)).toMatch(/matchesWildcard\(/);
    // A connection whose entry has no name is closed, and the dial starts only after that check.
    const start = src.slice(src.indexOf("private startTcp("));
    expect(start.indexOf("name === null")).toBeGreaterThan(-1);
    expect(start.indexOf("name === null")).toBeLessThan(start.indexOf("this.dialAndRelay("));
    // The name comes from the plan or the table, never from a byte on the socket.
    expect(src).toContain("return entry.host ?? this.names.nameOnSlot(index);");
  });

  test("bound 6 (and I29's stated bound): the Windows/macOS poller looks up declared names only", async () => {
    const { startConnectionPoller } = await import(
      `../platform/sandbox/observe/connection-poller.ts`
    );
    const asked: string[] = [];
    let polls = 0;
    const poller = startConnectionPoller({
      source: {
        poll: () => {
          polls += 1;
          return [
            { pid: 1, localPort: polls, remoteIp: "203.0.113.7", remotePort: 443 },
            { pid: 1, localPort: 1000 + polls, remoteIp: "2001:db8::9", remotePort: 22 },
          ];
        },
        close: () => undefined,
      },
      declared: ["api.example.com:443", "*.sharepoint.com:443", "198.51.100.4:443"],
      observer: { used: () => undefined, unmatched: () => undefined },
      periodMs: 0,
      resolve: (host: string) => {
        asked.push(host);
        return Promise.resolve([]);
      },
    });
    for (let i = 0; i < 5; i += 1) poller.pollNow();
    await new Promise((r) => setTimeout(r, 0));
    poller.stop();
    // The one declared NAME, never a wildcard, a declared literal or an address the child reached.
    expect(asked).toEqual(["api.example.com"]);

    // And the wrapper hands the poller the policy's own declared list, nothing it derived elsewhere.
    const wrapper = stripComments(await read(`${SANDBOX}/sandbox-wrapper.ts`));
    expect(bodyOf(wrapper, "observeConnections")).toContain(
      "declared: policy.permissions.network,",
    );
    const poll = stripComments(await read(`${SANDBOX}/observe/connection-poller.ts`));
    expect(poll.match(/\bresolve\(/g)).toHaveLength(1);
    expect(poll).toContain("table.learn(host, await resolve(host));");
    expect(poll).not.toMatch(/\breverse\b|lookupService/);
  });
});
