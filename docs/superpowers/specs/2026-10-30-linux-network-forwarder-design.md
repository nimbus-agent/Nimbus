# Linux per-host network: a local forwarder

Status: design, not built. Base: `main` at v10.11.1.

## Why

Nimbus promises that a sandboxed child reaches only the hosts it declared. On Linux that is false today, on every released package:

- No released Linux package contains `nimbus-sandbox-helper`, and `release.yml` builds only the Windows one.
- The helper could not do the job anyway. It holds `cap_net_admin`, `unshare(CLONE_NEWNET)` needs `CAP_SYS_ADMIN`, so it exits 4 and starts nothing (draft #1826). It also never builds a route out.
- So a child that declares network gets `--share-net`, which is the whole internet. `docs/sandbox.md` documents that as the fallback, and also promises per-host on Linux.

The owner's priority for the marketplace quality layer (Phase 9.5 project 6) is "what permissions an extension really uses versus what it declares". Per-host enforcement and a record of hosts by name both depend on this work.

## Goal

A Linux child with a declared network reaches exactly its declared `host:port` entries, on every Linux package, and any program in the sandbox can use them with no proxy settings.

## Non-goals

- Windows and macOS are unchanged. Windows stays all-or-nothing. macOS keeps its SBPL per-host rules.
- UDP, ICMP and QUIC stay blocked for a sandboxed child. Nothing first-party needs them. HTTP/3 clients fall back to TCP.
- Wildcard hosts stay unsupported, as the manifest validator already requires.
- The project 6 audit surface (`nimbus extension audit`, narrowing, warnings) is not built here. This design only leaves the seam for it, see "What project 6 gets".
- The egress ledger is not extended. Traffic to declared hosts stays unledgered, as `docs/SECURITY-INVARIANTS.md` states for I29.

## Anti-goals

These would make the work a failure even if the tests pass:

- A child gets network access that its policy does not list, by any route, including through a failure path in the forwarder.
- A credential, or the contents of a connection, reaches a log or a record.
- A binary with file capabilities, or a setuid binary, is added to any package.
- Failure to set up enforcement silently degrades to the whole internet for a child that would otherwise be filtered.

## The design

```
 gateway ── __nimbus-sandbox wrapper (outside, has network, enforces the policy)
                  │  listens on a unix socket
                  ▼
   outer bwrap: new user + net namespace, uid 0 mapped, adds the socket and /etc/hosts
                  │
           launcher (C): binds loopback listeners, forks the forwarder
                  ├── forwarder: no capabilities; relays each connection to the unix socket
                  └── exec inner bwrap: today's flags, real uid, real seccomp
                              └── the child
```

Only a policy in `per-host` mode takes this path. A no-network policy keeps today's single `bwrap --unshare-net`, unchanged.

1. **Name mapping.** Each declared host gets its own `127.0.0.x`, written to a generated `/etc/hosts` that the outer `bwrap` binds over the real one. No declared name needs DNS.
2. **Listeners.** The launcher binds `127.0.0.x:port` for each declared entry, on the real port, so a client's TLS name and port stay correct. Binding below 1024 needs `CAP_NET_BIND_SERVICE` in the new namespace. Entries are normalised with `parseNetworkEntry`, so a bare host means port 443.
3. **Forwarder.** It drops all capabilities first, then relays bytes. It tells the wrapper which declared entry the connection arrived on, and knows nothing about the policy.
4. **Enforcement** is in the wrapper, outside the sandbox. It checks the entry against the policy it parsed, resolves the name on the host, applies the address rules below, connects to the address it checked, and relays. An entry not in the policy is closed. So a compromised forwarder gains nothing.
5. **Undeclared names.** A generated `resolv.conf` points at `127.0.0.53`, where the forwarder relays each UDP datagram, unparsed, to the wrapper. The wrapper parses it in TypeScript. For a declared name it answers an `A` query with the mapped address and any other type with `NOERROR` and no records, so a dual-stack lookup still succeeds. For anything else it answers `NXDOMAIN`. Port 53 is UDP only, since these answers are too small to need TCP. No query leaves the machine. The wrapper writes one sanitised, rate-limited stderr line naming the refused host, which is how a broken connector gets diagnosed, since the child itself only sees a failed lookup. A direct connection to an undeclared IP uses no name and reaches nothing, so it is refused by the kernel and neither the wrapper nor the log sees it.
6. **The child** runs under today's `buildBwrapArgv` flags, nested inside, with the real seccomp filter. It does not see the socket or the forwarder.

### Address rules

A declared name can resolve to something the owner never meant to allow. An extension could declare a name it controls and point it at the owner's router, or at a cloud metadata address. So the rule depends on who chose the entry. The wrapper resolves once, filters the answers, and connects only to an address it kept, so a name that changes its answer between check and connect gains nothing.

- **Owner-configured:** the owner typed it. That means a host taken at spawn from a value the owner stored for that connector (`manifestWithExtraNetworkHosts`), or a `--net` on `connector add --mcp`. A default written in code or in a manifest is not owner-configured, even when it passes through the same code. The one exception is protonmail's `127.0.0.1` default, since Proton Bridge is a local app the owner chose to use, and this is first-party code. No other first-party connector defaults to loopback.
- **First-party:** a first-party manifest's fixed list, or a host our code builds from a template, such as `logs.<region>.amazonaws.com`. Enterprises resolve these privately through AWS VPC endpoints and Snowflake PrivateLink, so a private answer must work.
- **Package-declared:** an extension's manifest.

| Resolved address | Owner-configured | First-party | Package-declared |
|---|---|---|---|
| Public | Allowed | Allowed | Allowed |
| Private (RFC 1918, `100.64.0.0/10`, IPv6 unique-local) | Allowed, so a self-hosted Jenkins on a LAN or Tailscale name works | Allowed | Refused for a name. Allowed for that literal address, which the owner saw at approval |
| Loopback | Allowed only if the entry is `localhost` or that literal, on the declared port | Refused | Refused |
| Link-local, including `169.254.169.254` and `fe80::/10` | Refused | Refused | Refused |
| Anything else not globally routable, including `0.0.0.0/8`, `::`, multicast and reserved ranges | Refused | Refused | Refused |

"Public" means an address outside every range in this table, so a range nobody listed is refused rather than allowed. `0.0.0.0` must not count as public, because connecting to it reaches the host's loopback. Link-local is refused for everyone because nothing legitimate needs it and cloud credentials live there. Loopback is refused for everything the owner did not configure because the gateway's own local listeners are there. IPv4-mapped IPv6 answers are judged as the IPv4 address they carry. A refusal is logged the same way as an undeclared name.

The policy needs a new field naming the owner-configured entries, passed through `parseSandboxPolicy`. It must be set only by gateway code from the owner's settings, never read from a manifest.

### Limits

- A policy has at most 252 distinct hosts: `127.0.0.2` to `127.0.0.254`, without `127.0.0.53`, which the resolver holds. Over that, the spawn refuses.
- Every descriptor the launcher opens for its listeners is close-on-exec, so neither the inner `bwrap` nor the child inherits one.
- The wrapper allows at most 256 open connections per child and closes any above that, so a child cannot exhaust the gateway's file descriptors. There is no idle timeout, because Slack and Discord connections are long-lived on purpose. Relays apply backpressure rather than buffering without limit.

### Measured so far

Throwaway code on a GitHub `ubuntu-24.04` runner, AppArmor restriction on, profile from #1827 loaded, glibc 2.39, Bun 1.4, the real seccomp filter, branch `dev/asaf/linux-forwarder-spike`:

| Check | Result |
|---|---|
| `fetch` to the declared host, real TLS | 200 from `api.github.com` |
| Undeclared name | `EAI_AGAIN` |
| Declared name, wrong port | `ECONNREFUSED` |
| Direct IP | `ECONNREFUSED` |
| Child uid, and owner of a file it writes | 1001, the real uid |
| Child `CapPrm` / `CapEff` / `CapAmb` | 0 |
| Child binding `127.0.0.9:443` | `EACCES` |
| Socket visible to the child | No |
| Processes visible to the child | Its own namespace only |

`node:https`, WebSocket and raw TLS on port 993 reached the forward target in an earlier Docker variant, with the host name visible in the TLS hello. WebSocket was inferred from a count.

The nesting needs the outer `bwrap` to keep `CAP_SETFCAP`, because Linux 5.12 and later require it to map parent uid 0. Without it the inner `bwrap` fails with `setting up uid map: Operation not permitted`. The launcher must not drop capabilities before the inner `bwrap` runs.

### Not yet proven, and required before this ships

1. **Shutdown.** In the spike the run ended with no exit status, and I did not find out why. My guess, which the review shares, is that the forwarder holds the inherited stdout pipe open. The forwarder must close stdio it does not use and must die with the sandbox. The wrapper must report the child's real exit code, and MCP stdio must see EOF. A test must prove all three.
   The spike's launcher also sets `SIGCHLD` to ignored, and that survives `exec`, so a child's own `waitpid` could get `ECHILD`. The real launcher must restore the default before it runs the inner `bwrap`, and a test must prove a child can spawn and wait for a subprocess.
2. **A real connector** through the forwarder. So far only a Bun script has run through it.
3. **Residual bounding set.** The child's `CapBnd` was `0x80000500`, the three kept capabilities. With `NoNewPrivs` set and the other sets at 0 it grants nothing, and I believe that is fine, but the builder should drop them in the inner `bwrap` if that works.
4. **Forwarder confinement.** The C forwarder is outside the inner `bwrap` and handles bytes the child wrote. It should apply its own small seccomp filter once its sockets are set up.
5. **The stub resolver.** Nothing has measured `127.0.0.53` under this layout, or how `fetch`, `node:https` and the `aws` CLI behave when it answers. The spike's forwarder handles TCP only.
   The same goes for IP literals: the spike's outer `bwrap` does not hold `CAP_NET_ADMIN`, so adding an address to loopback has not been run.
6. **Other distros.** Only the Ubuntu 24.04 runner has run this. Before shipping, it runs on Debian and Fedora images, in privileged Docker since that is what is available, which does not prove their kernel defaults. Unprivileged namespaces being disabled entirely already fails today, and #1827's `nimbus doctor` check reports it.

## Host and port handling

- **Ports must survive.** `hostnameFromUrl` in `first-party-manifests.ts` keeps only the hostname, and `manifestWithExtraNetworkHosts` adds it, so the entry means port 443. A self-hosted Jenkins at `http://jenkins:8080` works today only because nothing enforces. It must become `jenkins:8080`, and `http://` with no port must become port 80. This affects every connector that adds a host from a URL at spawn.
- **Host list audit, a gate for the release that enforces.** Enforcement will find every incomplete list. Each of the 94 first-party connectors' declared hosts is checked against what its source in `@nimbus-dev/connectors` calls, including redirect targets such as `objects.githubusercontent.com`. The lists live in this repo, in `first-party-manifests.ts`, so a fix lands here. A host the connector's own code calls must be declared before release. A host only a server could redirect to at runtime may ship as a recorded gap. macOS already enforces these lists, which lowers the risk but does not remove it.
- **IP literals and `localhost`.** The validator accepts a value like `192.168.1.5`, and a self-hosted URL can name one. `/etc/hosts` cannot remap an IP. The launcher adds that address to the namespace's loopback interface, which needs `CAP_NET_ADMIN` there, and listens on it. `localhost` and `127.0.0.1` declared this way reach the host's own loopback through the wrapper, and only on the declared port.
- **IPv6 literals** stay refused, as they are for `--net` today. A declared name is reached over whatever family the host resolves. The child only ever sees IPv4 loopback.

## Other parts of the change

- **Helper.** `nimbus-sandbox-helper` is rewritten as the launcher and forwarder, with no capabilities of its own and no `iptables`. `--check-caps` is replaced by a real check.
- **Packaging.** `release.yml` builds it for Linux, as a static binary so one build runs on every target distro, and every Linux package ships it: `.deb`, `.rpm`, tarball and AppImage. Windows and macOS builds skip it, as they skip the Linux helper today. The `setcap` steps, the `libcap2-bin` and `libcap` dependencies, and `docs/release/headless-postinst-linux-setcap.md` are removed.
- **AppArmor.** The profile from #1827 covers `/usr/bin/bwrap`, which is enough, since the launcher creates no namespaces itself. To confirm when built.
- **Runner.** `decideNetworkMode` still returns `no-net`, `per-host` or `fallback`, with `per-host` now meaning this. `resolverFileToBind` is not used in `per-host`. `canConfine` and `isFullyActive` test the launcher with a real start, not a capability check.
- **Tests.** A real-binary test replaces #1826's, and runs in the restriction-on CI step: allowed entry, undeclared name, wrong port, direct IP, no `/etc/resolv.conf` use, exit code, EOF, a killed forwarder. The strace test that counts `unshare` is deleted.
- **Invariant.** A new `I50`, under the triple rule: on Linux, a sandboxed child's only network path is the forwarder, and the wrapper checks each connection against the policy.
- **Docs.** `docs/sandbox.md`, `docs/SECURITY.md`, the roadmap line that claims this, `docs/architecture.md` and the `nimbus-sandbox-and-extensions` skill all change to match.

## What project 6 gets

The wrapper sees each connection by declared entry, so it can record host, port, time and byte counts without polling and without missing short connections. It also sees each refused name, so project 6 can report what an extension tried and failed to reach. This design adds a single no-op seam at those points and stores nothing. Undeclared hosts cannot be reached on Linux, so the owner's "warn when an extension contacted an undeclared host" ruling does not apply there. It still applies on Windows.

## Decisions

**Made by the owner:** the local forwarder over `pasta`, and the `.deb` installing a machine-wide AppArmor profile for `bwrap`.

**My calls, for the owner to check:**

1. **Enforce from the first release that ships it, with no off switch.** A connector with an incomplete list breaks, and the wrapper's stderr line names the host. A switch back to whole-internet would weaken the promise this work exists to make. The audit above is what makes this safe.
2. **A missing launcher behaves as a missing helper does today.** This only happens on a source build, since every package ships it. The fallback stays documented, `nimbus doctor` warns, and `canConfine` refuses for a network-declaring policy.
3. **Setup failure refuses the spawn**, whether a listener cannot bind or nesting does not work on this machine, even where plain `bwrap` does. It never falls back. `canConfine` and `nimbus doctor` run the full nested start, so they report it before the owner is asked.
4. **A stub resolver is in scope**, because with no off switch a broken connector has to say which host it wanted, and `EAI_AGAIN` does not. Its parsing is in TypeScript, so the C code stays a byte relay.
5. **The address rules above.** Today's whole-internet mode can reach all of these, so they only tighten. A connector the owner pointed at a LAN host keeps working. An extension that needs a LAN address must declare the literal, so the owner sees it at approval.
6. **The launcher stays in C**, in the existing helper's directory. A Bun self-role would add a full runtime start to every network spawn and cannot drop capabilities without FFI.
7. **x86-64 first.** It is the only Linux build today, and the seccomp filter is x86-64 only.

## Left to the builder

The wire format between forwarder and wrapper, given that the socket stays in a directory only the wrapper and the outer `bwrap` can reach, and the wrapper trusts nothing the forwarder says beyond which entry to check. How `127.0.0.x` addresses are assigned. How many PRs, though I suggest the host and port fixes and audit come first, since they are useful alone. How the wrapper stops a connection when the child exits. Performance is not expected to matter, since these are API calls, but a large-file connector should be checked.
