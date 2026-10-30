# Linux Per-Host Network Forwarder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Linux child with a declared network reaches exactly its declared `host:port` entries, on every Linux package, with no proxy settings.

**Architecture:** An outer `bwrap` creates an empty network namespace holding loopback listeners on the declared ports. A C forwarder relays each connection over a unix socket to the `__nimbus-sandbox` wrapper outside, which checks it against the policy. The child runs under today's `bwrap` argv, nested inside.

**Tech Stack:** Bun/TypeScript (gateway, CLI), C99 (helper), bubblewrap, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-30-linux-network-forwarder-design.md`

## Global Constraints

- Three PRs, each based on `main` after the previous merges, no stacking. Auto-merge off. The owner merges. This plan and the spec never land on `main`.
- Never compile the gateway on Windows; it kills the running gateway. Prove binaries with a published release or on a runner.
- Docker hid three real bugs in this area. A Linux sandbox claim is proven only on a GitHub `ubuntu-24.04` runner with `kernel.apparmor_restrict_unprivileged_userns=1`.
- Linux-only tests run with `bun run verify:docker --changed` locally, and CI is their real proof.
- No `any`. Every `Bun.spawn` or `spawn` carries `windowsHide` or the `// windows-console-ok:` comment.
- Run `bun run preflight:fast` before each push, plus Sonar-shape and CodeQL-shape checks on new code. Resolve every review thread, one `resolveReviewThread` call each.
- A child's only network path is the forwarder. Setup failure refuses the spawn and never falls back. Only a missing helper falls back, as the spec's call 2 says.
- Neither connection contents nor credentials reach a log. Only host, port and refusal reason do.

## Review Focus

- The host's resolver returns a mix of public and private addresses for one package-declared name: connect only to the public ones. Test in Task 4.
- A declared host's server is down or refuses: the child sees a closed connection, the wrapper logs once, and the child keeps running. Test in Task 6.
- A child opens 300 connections at once: the extras close, and the gateway stays healthy. Test in Task 6.
- A child that spawns a subprocess and waits for it, such as a connector running the `aws` CLI: it works. Test in Task 8.
- The wrapper dies while the child runs: the child and the forwarder die too, with no leftover process. Test in Task 8.

---

## PR 1: host and port correctness

Useful alone, with no enforcement change. Title: `fix(connectors): keep the port of a self-hosted connector's URL, and declare every host a connector calls`.

### Task 1: Keep the port from a configured URL

**Files:**
- Modify: `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts:563`, and every caller of `hostnameFromUrl`
- Test: `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.test.ts`

**Interfaces:**
- Produces: `networkEntryFromUrl(input: string): string | null`, returning `host`, or `host:port` when the port is not 443. It replaces `hostnameFromUrl`, which is deleted.

- [ ] **Step 1: Write the failing test**

```ts
expect(networkEntryFromUrl("https://jenkins.corp")).toBe("jenkins.corp");
expect(networkEntryFromUrl("https://jenkins.corp:8443/x")).toBe("jenkins.corp:8443");
expect(networkEntryFromUrl("http://jenkins:8080")).toBe("jenkins:8080");
expect(networkEntryFromUrl("http://jenkins")).toBe("jenkins:80");
expect(networkEntryFromUrl("https://JENKINS.corp")).toBe("jenkins.corp");
expect(networkEntryFromUrl("not a url")).toBeNull();
expect(networkEntryFromUrl("https://[::1]:8080")).toBeNull(); // IPv6 literals stay refused
```

- [ ] **Step 2: Run it, expect FAIL with "networkEntryFromUrl is not defined"**

Run: `bun test packages/gateway/src/connectors/lazy-mesh/first-party-manifests.test.ts`

- [ ] **Step 3: Implement it, and replace every `hostnameFromUrl` caller**

Use `new URL`. A caller that needs a bare hostname for something other than a network grant keeps its own `new URL(...).hostname`; check each one. Check that `manifestWithExtraNetworkHosts` dedupes `host` and `host:port` as separate entries.

- [ ] **Step 4: Run the lazy-mesh tests, expect PASS, then commit**

Run: `bun test packages/gateway/src/connectors/lazy-mesh`

### Task 2: Label owner-configured entries

**Files:**
- Modify: `first-party-manifests.ts` (`manifestWithExtraNetworkHosts`), `packages/gateway/src/platform/sandbox/sandbox-policy.ts`, `packages/gateway/src/extensions/manifest.ts`, `connectors/lazy-mesh/user-mcp.ts`, and every `manifestWithExtraNetworkHosts` call site
- Test: `sandbox-policy.test.ts`, `first-party-manifests.test.ts`

**Interfaces:**
- Produces: `SandboxPolicy.ownerConfiguredNetwork?: readonly string[]`; `ExtensionManifest.ownerConfiguredNetwork?: readonly string[]`, set only by gateway code; `manifestWithExtraNetworkHosts(serviceId, extraHosts, { ownerConfigured: readonly string[] })`, where the third argument is required so each call site has to decide.

- [ ] **Step 1: Write the failing tests**

```ts
// A round trip through the wire keeps the field, and a wrong shape refuses.
expect(parseSandboxPolicy(JSON.stringify(policyWith(["jenkins:8080"]))).ownerConfiguredNetwork)
  .toEqual(["jenkins:8080"]);
expect(() => parseSandboxPolicy(JSON.stringify(policyWith("jenkins")))).toThrow();
// A manifest file cannot grant itself the label.
expect(parseExtensionManifest({ ...valid, ownerConfiguredNetwork: ["10.0.0.1"] }).ownerConfiguredNetwork)
  .toBeUndefined();
// user MCP: every --net entry is the owner's.
expect(userMcpManifestFromRow(row).manifest.ownerConfiguredNetwork).toEqual(row.netHosts);
```

- [ ] **Step 2: Run them, expect FAIL**

- [ ] **Step 3: Implement the field and classify each call site**

Owner-configured means the value came from a Vault secret or config value the owner stored, such as `jenkins.base_url` or `imap.host`. A host computed from a region default, or written in code, is not. Record each call site's answer in the PR description. Use the exact parser name `manifest.ts` exports in the test above. An extension's manifest is built in `buildExtensionRuntimeManifest` from its grants; confirm it never sets the field.

- [ ] **Step 4: Run the tests, expect PASS, run `bun run typecheck`, then commit**

### Task 3: Audit every connector's hosts

**Files:**
- Create: `scripts/structure-audit/check-connector-hosts.ts`, `scripts/structure-audit/check-connector-hosts.test.ts`, `scripts/structure-audit/connector-host-gaps.json`
- Modify: `first-party-manifests.ts`, `package.json` (`audit:connector-hosts`), `scripts/lib/preflight-gates.ts`

**Interfaces:**
- Produces: `findUndeclaredHosts(source: string, declared: readonly string[]): string[]`

- [ ] **Step 1: Write the failing test**

```ts
expect(findUndeclaredHosts('fetch("https://api.foo.com/v1")', ["api.foo.com"])).toEqual([]);
expect(findUndeclaredHosts('fetch("https://api.foo.com/v1")', [])).toEqual(["api.foo.com"]);
expect(findUndeclaredHosts('// see https://docs.foo.com/x', [])).toEqual([]); // comments do not call
expect(findUndeclaredHosts('const u = `https://${host}/v1`', [])).toEqual([]); // dynamic, from config
```

- [ ] **Step 2: Run it, expect FAIL**

- [ ] **Step 3: Implement it, and run it over `@nimbus-dev/connectors`**

For each connector id in `FIRST_PARTY_MANIFESTS`, scan `connectors/<id>/src/**/*.ts` and any `shared/` file it imports for URL string literals outside comments. Compare with its manifest list, and exit 1 on an undeclared host unless `connector-host-gaps.json` records it with a reason. A link in a tool description or error message goes in the gaps file as `not called`.

- [ ] **Step 4: Fix each list, and read the source for redirects**

A host the connector's code calls must be declared. A host reached only through a server redirect may go in the gaps file as `redirect only`, for example `objects.githubusercontent.com` if the connector downloads release assets; if a tool's job is to follow it, declare it. Hosts of a connector that shells out, such as the `aws` CLI, come from its comments and docs. Check them by hand.

- [ ] **Step 5: Run the audit, expect exit 0, then wire it and commit**

Run: `bun run audit:connector-hosts`. Add it to `preflight-gates.ts`, then run `bun test scripts/lib`.

- [ ] **Step 6: Open PR 1, and get it green and merged before PR 2**

---

## PR 2: the forwarder, inert until packaged

No release package ships the helper yet, so a user sees no change. Title: `feat(sandbox): enforce declared hosts on Linux through a local forwarder`.

### Task 4: Address rules

**Files:**
- Create: `packages/gateway/src/platform/sandbox/net-address-rules.ts`, `net-address-rules.test.ts`

**Interfaces:**
- Produces:
  - `type AddressClass = "public" | "private" | "loopback" | "refused"`
  - `classifyAddress(ip: string): AddressClass`
  - `allowedAddresses(entry: { host: string; ownerConfigured: boolean }, answers: readonly string[]): string[]`

- [ ] **Step 1: Write the failing tests**

```ts
const cases: [string, AddressClass][] = [
  ["140.82.114.6", "public"], ["2606:4700::1", "public"],
  ["10.0.0.1", "private"], ["172.16.0.1", "private"], ["192.168.1.1", "private"],
  ["100.64.0.1", "private"], ["fd00::1", "private"],
  ["127.0.0.1", "loopback"], ["127.9.9.9", "loopback"], ["::1", "loopback"],
  ["169.254.169.254", "refused"], ["fe80::1", "refused"], ["0.0.0.0", "refused"], ["0.1.2.3", "refused"],
  ["::", "refused"], ["224.0.0.1", "refused"], ["240.0.0.1", "refused"], ["255.255.255.255", "refused"],
  ["192.0.0.1", "refused"], ["198.18.0.1", "refused"], ["ff02::1", "refused"], ["not-an-ip", "refused"],
  ["::ffff:127.0.0.1", "loopback"], ["::ffff:169.254.169.254", "refused"], ["::ffff:10.0.0.1", "private"],
];
for (const [ip, want] of cases) expect(classifyAddress(ip)).toBe(want);

const pkg = { host: "evil.example", ownerConfigured: false };
expect(allowedAddresses(pkg, ["140.82.114.6", "10.0.0.1", "127.0.0.1"])).toEqual(["140.82.114.6"]);
expect(allowedAddresses({ host: "10.0.0.1", ownerConfigured: false }, ["10.0.0.1"])).toEqual(["10.0.0.1"]);
expect(allowedAddresses({ host: "127.0.0.1", ownerConfigured: false }, ["127.0.0.1"])).toEqual([]);
const own = { host: "jenkins", ownerConfigured: true };
expect(allowedAddresses(own, ["10.0.0.1", "127.0.0.1", "169.254.169.254"])).toEqual(["10.0.0.1"]);
expect(allowedAddresses({ host: "localhost", ownerConfigured: true }, ["127.0.0.1"])).toEqual(["127.0.0.1"]);
expect(allowedAddresses({ host: "127.0.0.1", ownerConfigured: true }, ["127.0.0.1"])).toEqual(["127.0.0.1"]);
```

- [ ] **Step 2: Run it, expect FAIL**

- [ ] **Step 3: Implement them**

"Public" must be the result of matching no listed range, per the spec. Expand IPv6 with a small parser rather than string prefixes, so that `0:0:0:0:0:ffff:7f00:1` also classifies as loopback, and add that as a test.

- [ ] **Step 4: Run it, expect PASS, then commit**

### Task 5: The stub resolver

**Files:**
- Create: `packages/gateway/src/platform/sandbox/net-dns-stub.ts`, `net-dns-stub.test.ts`

**Interfaces:**
- Produces: `answerDnsQuery(query: Uint8Array, mapped: ReadonlyMap<string, string>): { reply: Uint8Array | null; refusedName: string | null }`

- [ ] **Step 1: Write the failing tests**

Build query bytes with a test helper. Assert on the parsed reply:

```ts
const map = new Map([["api.github.com", "127.0.0.2"]]);
// A query for a declared name: NOERROR, one A record.
// AAAA for a declared name: NOERROR, no answers, refusedName null.
// A for an undeclared name: NXDOMAIN, refusedName "evil.example".
// AAAA for an undeclared name: NXDOMAIN, refusedName "evil.example".
// Case-insensitive: "API.GitHub.COM" is declared. The reply echoes the question's own bytes and id.
// Malformed (too short, a compression pointer in the question, a label running past the end, QDCOUNT != 1): reply null, no throw.
// refusedName with a control byte in a label: control bytes are stripped before it is returned.
```

- [ ] **Step 2: Run them, expect FAIL**

- [ ] **Step 3: Implement it**

Parse only the header and single question, bounded by the buffer. No compression pointers in a question.

- [ ] **Step 4: Run them, expect PASS, then commit**

### Task 6: The wrapper's forward host

**Files:**
- Create: `packages/gateway/src/platform/sandbox/net-forward-host.ts`, `net-forward-host.test.ts`

**Interfaces:**
- Consumes: `allowedAddresses`, `answerDnsQuery`, `parseNetworkEntry`
- Produces:
  - `interface ForwardEntry { host: string; port: number; ownerConfigured: boolean; loopbackIp: string }`
  - `planForwardEntries(policy: SandboxPolicy): ForwardEntry[]`, which throws above 252 hosts, and skips `127.0.0.53`
  - `startForwardHost(opts: { socketPath: string; entries: readonly ForwardEntry[]; resolve: (host: string) => Promise<string[]>; connect: (ip: string, port: number) => Promise<NetSocketLike>; log: (line: string) => void; onConnection?: (e: ForwardEntry) => void; onRefusedName?: (name: string) => void }): { close(): void }`

The wire format, one per unix connection: a 3-byte header, then the stream. Byte 0 is `T` (TCP) or `D` (DNS). Bytes 1 and 2 are the big-endian entry index, 0 for DNS. For `T`, relay until either side closes. For `D`, read a 2-byte big-endian length and the datagram, write back a 2-byte length and the reply, then close.

- [ ] **Step 1: Write the failing tests**

All use a real unix socket in a temp dir, with fake `resolve` and `connect`:

```ts
// T with a valid index: connects to the allowed address on the entry's port, and bytes relay both ways.
// T with an index past the end: closes, connect never called.
// A byte stream that is not T or D: closes.
// A header split across two writes: still works.
// Every answer refused: closes, one log line naming host and "refused address", connect never called.
// connect rejects: closes, one log line, the host stays up and takes the next connection.
// 256 open connections, then the 257th: closed at once, and after one closes, a new one works.
// D for an undeclared name: NXDOMAIN reply, onRefusedName called, one log line.
// The same refused name 1000 times: at most 1 log line per name per minute. Pass the clock in.
// The log never contains relayed bytes.
// onConnection is called once per T connection with the entry. It is the project 6 seam, and nothing in production passes it.
// A slow reader: the relay pauses reading rather than buffering past 1 MiB.
// close(): the socket file is gone.
```

- [ ] **Step 2: Run them, expect FAIL**

- [ ] **Step 3: Implement it**

Use `Bun.listen({ unix })`, whose bind is synchronous, so the socket exists before the helper spawns. Create the socket's directory with mode 0700. The production `connect` uses `Bun.connect`, and `resolve` uses `dns.lookup` with `all: true`.

- [ ] **Step 4: Run them, expect PASS on Linux and macOS, skipping on Windows, then commit**

Run: `bun run verify:docker --changed`

### Task 7: The C launcher and forwarder

**Files:**
- Rewrite: `packages/gateway/src-native/sandbox-helper/main.c`, `Makefile`
- Delete: `packages/gateway/test/integration/platform/sandbox/sandbox-helper-strace.test.ts`
- Create: `packages/gateway/src/platform/sandbox/linux-helper-launcher.test.ts`

**Interfaces:**
- Produces two CLI modes:
  - `nimbus-sandbox-helper --check`: prints `OK`, exit 0. No capability check.
  - `nimbus-sandbox-helper --socket <path> [--alias <ip>]... --listen <ip>:<port>:<index>... --dns <ip> -- <argv...>`
- Exit codes: 2 usage, 3 bind or listen failure, 5 alias failure, 127 exec failure.

- [ ] **Step 1: Write the failing test**

Follow the `linux-helper-network.test.ts` shape from draft #1826: the real binary under `bwrap`, with a real unix socket target, skipped unless the binary is built. `NIMBUS_REQUIRE_SANDBOX_HELPER=1` turns a skip into a failure.

```ts
// bwrap --unshare-user --unshare-net --uid 0 --gid 0 --cap-add NET_BIND,SETPCAP,SETFCAP helper --socket S --listen 127.0.0.2:443:7 -- <probe>
// Connecting to 127.0.0.2:443 inside: the target receives "T", 0x00, 0x07, then the bytes.
// Sending a UDP datagram to the --dns ip:53: the target receives "D", 0, 0, the length, the datagram, and the reply reaches the sender.
// The probe's /proc/self/fd lists no listening socket from the helper.
// SIGCHLD disposition in the probe's /proc/self/status: SigIgn has bit 17 clear.
// The forwarder's stdout is closed: the test's pipe sees EOF when the probe exits, and the process exit code is the probe's.
// Bad args: exit 2. A listener already bound: exit 3.
// Forwarder's /proc/<pid>/status: CapEff 0, NoNewPrivs 1, Seccomp 2.
```

- [ ] **Step 2: Run it in Docker, expect FAIL**

Run: `bun run verify:docker --changed`

- [ ] **Step 3: Implement `main.c`**

Order, each step needing the one before:

1. Parse args.
2. Apply each `--alias` to `lo` via `ioctl(SIOCSIFADDR)` on `lo:<n>`.
3. Bind and listen each entry, `SOCK_CLOEXEC`, and bind the UDP DNS socket, `SOCK_CLOEXEC`.
4. Fork the forwarder.
5. In the parent: restore `SIGCHLD` to default, then `execv`. It keeps its capabilities, since the inner `bwrap` needs `CAP_SETFCAP` and drops everything itself.

In the forwarder:

1. `prctl(PR_SET_PDEATHSIG, SIGKILL)`, then check the parent has not already gone.
2. Close 0, 1 and 2, opening `/dev/null` in their place, and close fd 3.
3. Clear ambient, bounding and all capability sets, and set `PR_SET_NO_NEW_PRIVS`.
4. Install its own seccomp allowlist, x86-64 only, killing anything else: `read`, `write`, `close`, `poll`, `ppoll`, `accept`, `accept4`, `socket`, `connect`, `sendto`, `recvfrom`, `fcntl`, `fork`, `clone`, `wait4`, `exit`, `exit_group`, `rt_sigaction`, `rt_sigreturn`, `rt_sigprocmask`, `brk`, `mmap`, `munmap`, `getpid`. Add what the test shows it needs and nothing that opens a path. `socket` is restricted to `AF_UNIX` by argument check, so a compromised forwarder cannot open a route.
5. Relay as the spec says, one process per connection, with one poll loop, and no parsing.

The `Makefile` drops `-lcap`, and links with `-static`. Keep `-Wall -Wextra -Werror`. Delete `install_firewall_rules`, `--check-caps` and everything else that used iptables.

- [ ] **Step 4: Run it in Docker, expect PASS, then `cppcheck` as CI runs it, then commit**

### Task 8: Wire it into the runner

**Files:**
- Modify: `packages/gateway/src/platform/sandbox/linux.ts`, `sandbox-wrapper.ts`, `scripts/linux/check-bwrap-apparmor.sh`, `.github/workflows/_test-suite.yml`
- Create: `packages/gateway/src/platform/sandbox/linux-forwarder-network.test.ts`, moving the #1826 test's shape here
- Test: `linux.test.ts`

**Interfaces:**
- Consumes: `planForwardEntries`, `startForwardHost`, helper CLI
- Produces: `buildForwarderArgv(policy, opts: { cwd, helperPath, socketDir, hostsFile, resolvConfTarget, entries, innerArgv }): string[]`; `HELPER_PATH` resolved by `resolveHelperPath(execPath, env, exists)`

- [ ] **Step 1: Write the failing unit tests**

```ts
// resolveHelperPath: NIMBUS_SANDBOX_HELPER_PATH wins; next, a helper beside execPath; next, /usr/lib/nimbus/bin; else null.
// buildForwarderArgv: outer has --unshare-user --unshare-net --unshare-pid --uid 0 --gid 0, the three --cap-add, and CAP_NET_ADMIN only when an entry is an IP literal.
// Outer ro-binds / and read-write-binds cwd and each policy write path, so the inner bwrap's binds resolve.
// Outer binds the generated hosts file at /etc/hosts and the generated resolv.conf at resolvConfTarget.
// Outer binds the helper at a fixed path under /run, so a helper in ~/.local/bin or an AppImage mount resolves.
// The socket dir is bound in the outer and NOT in the inner.
// Inner is buildBwrapArgv's result with --share-net and --uid <real uid> --gid <real gid>, and --seccomp 3 last before the command.
// A 253rd host: canConfine and spawn refuse.
// Mode per-host never calls resolverFileToBind's bind in the inner.
```

- [ ] **Step 2: Run them, expect FAIL**

- [ ] **Step 3: Implement the spawn path**

In `per-host` mode: create a 0700 temp dir, write the hosts and resolv files, call `startForwardHost`, spawn the outer `bwrap`, and remove the dir and close the host on child exit. `resolvConfTarget` is the existing `resolverFileToBind() ?? "/etc/resolv.conf"`, since `/etc/resolv.conf` can be a symlink. Replace `probeHelper` with `--check`, and make `canConfine` for a network policy run a real nested start of `/usr/bin/true` once at construction. If any step of the spawn path throws, the spawn throws.

- [ ] **Step 4: Write the real-network test**

`linux-forwarder-network.test.ts`, real helper, real `createLinuxSandboxRunner`, `NIMBUS_REQUIRE_SANDBOX_HELPER=1` in CI, listeners on the host loopback declared as owner-configured `127.0.0.1:<port>`:

```ts
// Reaches the declared port with fetch, node:http, raw net.connect and a WebSocket. All without proxy settings.
// Not the other port on that address; an undeclared name; a direct public IP; DNS to 8.8.8.8:53 by UDP.
// A package-declared entry for 127.0.0.1: closed by the wrapper, log line names it.
// Refused lookup: log line names the host.
// Exit code: the child's exit 7 reaches the wrapper's caller.
// EOF: the child's stdout closes when it exits, even with a connection open.
// A child that spawns a subprocess and waits: works.
// Kill the wrapper while the child sleeps: within 5 s no child or forwarder process is left.
// Kill the forwarder from outside: the child's next connection fails, and nothing falls back to a route.
// Owner uid: a file written in cwd is owned by the real uid on the host.
```

- [ ] **Step 5: Run it in CI with the restriction on**

Add the helper build and this test to `check-bwrap-apparmor.sh`, after the profile is installed. Remove `setcap` from the `_test-suite.yml` helper step. Run the real `github` connector through it once, with `release-proof.ts` from `dev/asaf/linux-forwarder-spike` and a locally built gateway in CI: a fake token must get GitHub's 401. Expected: all pass on `ubuntu-24.04`.

- [ ] **Step 6: Run the other distros once by hand**

Run the real-network test in privileged Docker on `debian:12` and `fedora:latest`. Put the results in the PR description, saying that this does not prove their kernel defaults.

- [ ] **Step 7: Open PR 2, and get it green and merged before PR 3**

---

## PR 3: ship it

This is the PR that changes behaviour for users. Title: `feat(sandbox): ship the Linux network forwarder, so a child reaches only its declared hosts`.

### Task 9: Packages and `nimbus doctor`

**Files:**
- Modify: `.github/workflows/release.yml`, `scripts/package-linux-installers.ts` and its test, `scripts/release/nfpm-config.ts` and its test, `scripts/install/unix/install.sh`, `packages/cli/src/commands/doctor-bwrap.ts` and its test
- Delete: `docs/release/headless-postinst-linux-setcap.md`

**Interfaces:**
- Consumes: helper `--check`

- [ ] **Step 1: Write the failing tests**

```ts
// .deb, .rpm, tarball and AppImage each contain nimbus-sandbox-helper, and it has mode 755.
// No postinst or linux-postinstall.sh contains "setcap". No control file or nfpm config depends on libcap.
// --skip-sandbox-helper is removed, and a build with no helper fails.
// doctor, helper beside the gateway: "[ok] Sandbox: declared hosts are enforced."
// doctor, no helper: "[warn] Sandbox: nimbus-sandbox-helper is missing, so a connector that declares a network reaches the whole internet."
```

- [ ] **Step 2: Run them in Docker, expect FAIL**

- [ ] **Step 3: Implement them**

`release.yml` builds the helper with `make` on `ubuntu-24.04` in the Linux bundle job, and checks `file` reports it static. `install.sh` copies it beside `nimbus-gateway`. Doctor's helper check is `[warn]`, exit severity 1, and does not change the AppArmor check from #1827. `linux-postinstall.sh` keeps the AppArmor block.

- [ ] **Step 4: Run them, expect PASS, then commit**

### Task 10: Invariant and docs

**Files:**
- Modify: `docs/SECURITY-INVARIANTS.md`, `packages/gateway/src/security-invariants.test.ts`, `docs/sandbox.md`, `docs/SECURITY.md`, `docs/architecture.md`, `docs/roadmap.md`, `CLAUDE.md`, `GEMINI.md`, `.claude/commands/nimbus-sandbox-and-extensions.md`, `scripts/linux/install-sandbox-deps.sh`

- [ ] **Step 1: Write the failing invariant tests**

```ts
// I50, behavioural: a per-host argv has --unshare-net in the outer, and buildForwarderArgv is the only path in linux.ts for a per-host policy.
// I50, source pin: net-forward-host.ts checks allowedAddresses before connect.
// I50, static: decideNetworkMode never returns --share-net for a per-host policy outside the nested argv.
```

- [ ] **Step 2: Run them, expect FAIL, then add the I50 row and rationale**

Triple rule: wiring, docs and test in one commit. The CLAUDE.md count moves to I1–I50, and GEMINI.md mirrors it. `audit:status-drift` must pass.

- [ ] **Step 3: Correct every claim**

Grep the concept, not one spelling: `per-host`, `per host`, `cap_net_admin`, `iptables`, `setcap`, across `docs/`, `.claude/commands/` and `packages/docs`. State the real limits: TCP only, IPv4 loopback inside, direct-IP attempts unseen, a missing helper means whole internet, and a server redirect to an undeclared host fails.

- [ ] **Step 4: Run `bun run preflight:fast`, expect PASS, then open PR 3**

- [ ] **Step 5: After it merges and releases, prove the published package on a stock runner**

Published `.deb`, restriction on, as a normal user. Expected: the fake-token `github` connector gets a 401, an undeclared host from inside the same child fails, doctor reports both `[ok]` lines. Then close #1826 and delete `dev/asaf/linux-forwarder-spike`.
