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

1. **Name mapping.** Each declared host gets its own `127.0.0.x`, written to a generated `/etc/hosts` that the outer `bwrap` binds over the real one. No declared name needs DNS. An undeclared name has no resolver and no route, so it fails.
2. **Listeners.** The launcher binds `127.0.0.x:port` for each declared entry, on the real port, so a client's TLS name and port stay correct. Binding below 1024 needs `CAP_NET_BIND_SERVICE` in the new namespace.
3. **Forwarder.** It drops all capabilities first, then relays bytes. It tells the wrapper which declared entry the connection arrived on, and knows nothing about the policy.
4. **Enforcement** is in the wrapper, outside the sandbox. It checks the entry against the policy it parsed, resolves the name on the host, connects, and relays. An entry not in the policy is closed. So a compromised forwarder gains nothing.
5. **The child** runs under today's `buildBwrapArgv` flags, nested inside, with the real seccomp filter. It does not see the socket or the forwarder.

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

1. **Shutdown.** In the spike the run ended with no exit status, and I did not find out why. My guess is that the forwarder holds the inherited stdout pipe open. The forwarder must close stdio it does not use and must die with the sandbox. The wrapper must report the child's real exit code, and MCP stdio must see EOF. A test must prove all three.
2. **A real connector** through the forwarder. So far only a Bun script has run through it.
3. **Residual bounding set.** The child's `CapBnd` was `0x80000500`, the three kept capabilities. With `NoNewPrivs` set and the other sets at 0 it grants nothing, and I believe that is fine, but the builder should drop them in the inner `bwrap` if that works.
4. **Forwarder confinement.** The C forwarder is outside the inner `bwrap` and handles bytes the child wrote. It should apply its own small seccomp filter once its sockets are set up.

## Host and port handling

- **Ports must survive.** `hostnameFromUrl` in `first-party-manifests.ts` keeps only the hostname, and `manifestWithExtraNetworkHosts` adds it, so the entry means port 443. A self-hosted Jenkins at `http://jenkins:8080` works today only because nothing enforces. It must become `jenkins:8080`, and `http://` with no port must become port 80. This affects every connector that adds a host from a URL at spawn.
- **Host list audit.** Enforcement will find every incomplete list. Before this ships, each of the 94 first-party connectors' declared hosts is checked against what its source calls, including redirect targets such as `objects.githubusercontent.com`. Each list gets fixed or the gap is recorded. macOS already enforces these lists, which lowers the risk but does not remove it.
- **IP literals and `localhost`.** The validator accepts a value like `192.168.1.5`, and a self-hosted URL can name one. `/etc/hosts` cannot remap an IP. The launcher adds that address to the namespace's loopback interface, which needs `CAP_NET_ADMIN` there, and listens on it. `localhost` and `127.0.0.1` declared this way reach the host's own loopback through the wrapper, and only on the declared port.
- **IPv6 literals** stay refused, as they are for `--net` today. A declared name is reached over whatever family the host resolves. The child only ever sees IPv4 loopback.

## Other parts of the change

- **Helper.** `nimbus-sandbox-helper` is rewritten as the launcher and forwarder, with no capabilities of its own and no `iptables`. `--check-caps` is replaced by a real check.
- **Packaging.** `release.yml` builds it for Linux, and every Linux package ships it: `.deb`, `.rpm`, tarball and AppImage. The `setcap` steps, the `libcap2-bin` and `libcap` dependencies, and `docs/release/headless-postinst-linux-setcap.md` are removed.
- **AppArmor.** The profile from #1827 covers `/usr/bin/bwrap`, which is enough, since the launcher creates no namespaces itself. To confirm when built.
- **Runner.** `decideNetworkMode` still returns `no-net`, `per-host` or `fallback`, with `per-host` now meaning this. `resolverFileToBind` is not used in `per-host`. `canConfine` and `isFullyActive` test the launcher with a real start, not a capability check.
- **Tests.** A real-binary test replaces #1826's, and runs in the restriction-on CI step: allowed entry, undeclared name, wrong port, direct IP, no `/etc/resolv.conf` use, exit code, EOF, a killed forwarder. The strace test that counts `unshare` is deleted.
- **Invariant.** A new `I50`, under the triple rule: on Linux, a sandboxed child's only network path is the forwarder, and the wrapper checks each connection against the policy.
- **Docs.** `docs/sandbox.md`, `docs/SECURITY.md`, the roadmap line that claims this, `docs/architecture.md` and the `nimbus-sandbox-and-extensions` skill all change to match.

## What project 6 gets

The wrapper sees each connection by declared entry, so it can record host, port, time and byte counts without polling and without missing short connections. This design adds a single no-op seam at that point and writes nothing. Undeclared hosts cannot be reached on Linux, so the owner's "warn when an extension contacted an undeclared host" ruling does not apply there. It still applies on Windows. Recording what an extension tried and failed to reach would need a stub DNS listener, and is a separate decision for project 6.

## Decisions

**Made by the owner:** the local forwarder over `pasta`, and the `.deb` installing a machine-wide AppArmor profile for `bwrap`.

**My calls, for the owner to check:**

1. **Enforce from the first release that ships it, with no off switch.** A connector with an incomplete list breaks, so its error must name the host and how to report it. A switch back to whole-internet would weaken the promise this work exists to make. The audit above is what makes this safe.
2. **A missing launcher behaves as a missing helper does today.** This only happens on a source build, since every package ships it. The fallback stays documented, `nimbus doctor` warns, and `canConfine` refuses for a network-declaring policy. Anti-goal 4 is about a child whose filtering was set up and failed, and that case refuses.
3. **Setup failure refuses the spawn**, for example when a listener cannot bind. It never falls back.
4. **The launcher stays in C**, in the existing helper's directory. A Bun self-role would add a full runtime start to every network spawn and cannot drop capabilities without FFI.
5. **x86-64 first.** It is the only Linux build today, and the seccomp filter is x86-64 only.

## Left to the builder

The wire format between forwarder and wrapper. How `127.0.0.x` addresses are assigned. How many PRs, though I suggest the host and port fixes and audit come first, since they are useful alone. How the wrapper stops a connection when the child exits. Performance is not expected to matter, since these are API calls, but a large-file connector should be checked.
