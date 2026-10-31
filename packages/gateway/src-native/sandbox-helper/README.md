# nimbus-sandbox-helper

The launcher and forwarder of Linux per-host networking. It holds no capability of
its own: it runs inside the outer `bwrap`'s new user and network namespaces, using
the capabilities that `bwrap` kept for it.

The launcher binds the sandbox's loopback listeners and execs the inner `bwrap`,
keeping its capabilities, since the inner `bwrap` needs `CAP_SETFCAP` and drops them
all itself. It forks the forwarder first.

The forwarder handles bytes a hostile child wrote. It keeps only its sockets, drops
every capability, installs its own seccomp allowlist (x86-64 only, `socket` limited
to `AF_UNIX`, anything unnamed kills it), and then relays bytes to the wrapper's unix
socket, parsing none of them. The policy is enforced outside the sandbox, in
`packages/gateway/src/platform/sandbox/net-forward-host.ts`, which also defines the
wire format.

## Modes

- `nimbus-sandbox-helper --check` prints `OK` and exits 0. It does no capability,
  namespace or file work.

- `nimbus-sandbox-helper --socket <path> [--alias <ip>]... --listen <ip>:<port>:<index>... --dns <ip> -- <argv...>`
  - `--socket`: the wrapper's unix socket. Must fit in `sockaddr_un`, so 107 bytes at most.
  - `--alias`: adds an IPv4 address to `lo` as a /32, for an IP-literal entry. Needs `CAP_NET_ADMIN`.
  - `--listen`: one TCP listener. `<index>` is the wrapper's entry index, 0 to 65535. At most 65535 entries.
  - `--dns`: the address whose UDP port 53 carries the stub resolver's datagrams.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | `--check` |
| 2 | Usage |
| 3 | A bind, listen or fork failed. Stderr names the address |
| 5 | An alias failed. Stderr names the address |
| 127 | The exec failed |

Otherwise the exit code is the exec'd program's.

## Limits

- At most 512 live relay processes. Over that an accepted connection closes at once and a datagram is dropped.
- A datagram or a reply over 4096 bytes is dropped. A datagram's relay gives up after 5 seconds with no reply.
- If the forwarder exits or the socket goes away, listeners stop relaying. Nothing falls back to a route.
- It logs nothing about connections. Stderr carries only the startup failures above, and the forwarder's stderr is `/dev/null`.

## Build

`make` in this directory, with a C99 compiler and a static libc (`libc6-dev` on Debian and Ubuntu). x86-64 only.

Test: `packages/gateway/src/platform/sandbox/linux-helper-launcher.test.ts`, against the real binary under `bwrap`.
