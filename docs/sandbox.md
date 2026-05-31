# Nimbus Extension Sandbox

Phase 5 T2 PR 1 introduced OS-native kernel-level sandboxing for every
extension child process. This document is the operator-facing reference;
the load-bearing invariant is `I15` in [`docs/SECURITY-INVARIANTS.md`](./SECURITY-INVARIANTS.md).

## Model

Every extension declares a `permissions` object in its
`nimbus.extension.json`:

    {
      "permissions": {
        "network": ["api.github.com"],
        "filesystem": {
          "read":  ["/home/user/notes"],
          "write": ["/home/user/notes/.tmp"]
        }
      }
    }

The Gateway's `SandboxRunner` enforces these at the OS level — kernel
namespaces / sandbox profiles / AppContainer — so that even a fully
compromised extension cannot reach hosts or paths outside the declaration.

## Per-OS implementation

### Linux {#linux}

`bwrap` (Bubblewrap) creates user / PID / IPC / mount / network namespaces.
The `nimbus-sandbox-helper` binary (granted `cap_net_admin+ep` via `setcap`
at install) configures per-host iptables rules inside the netns and drops
the cap before exec'ing the connector. `bubblewrap` is a hard install
dependency (`.deb` `Depends:`, `.rpm` `Requires:`).

If the helper is missing or lacks the cap, the sandbox degrades to
all-or-nothing network — connectors with non-empty `permissions.network`
get full network access; connectors with empty `permissions.network` get
no network at all. The Gateway emits a structured-log warning at startup
and `nimbus diag --json` reports `sandbox.linux_helper.available: false`.

#### AppImage limitation

AppImage bundles cannot have file capabilities applied to binaries inside
the squashfs image — `setcap cap_net_admin+ep` only takes effect on a real
filesystem path. When Nimbus is launched from an AppImage, the
`nimbus-sandbox-helper` binary inside the bundle has no capability set, so
the sandbox detects the missing cap at startup and degrades to the
all-or-nothing network mode described above. The Gateway emits the same
structured-log warning; `nimbus diag --json` reports
`sandbox.linux_helper.available: false` and
`sandbox.linux_helper.reason: "appimage"`.

To get per-host network enforcement on Linux, install via `.deb` /
`.rpm` / tarball + manual `setcap`. The AppImage flow is supported for
convenience but runs in the documented fallback mode.

### macOS

`sandbox-exec` runs each extension under a per-spawn SBPL profile that
allows only the declared hosts and paths. macOS 14 (Sonoma) + macOS 15
(Sequoia) verified during PR 1's spike. If `sandbox-exec` is unavailable
on a future macOS version, Nimbus falls back to an `EndpointSecurity`
client (deferred to a follow-up).

### Windows {#windows-platform-status}

`AppContainer` profiles isolate each extension by SID. The
`internetClient` capability is granted iff `permissions.network` is
non-empty. **Per-host network filtering is not enforced on Windows in
PR 1** — see [#platform-asymmetry](#platform-asymmetry) below.

**Windows FFI status.** The AppContainer profile creation + capability
SID derivation are wired in PR 1. The `CreateProcessAsUserW` FFI
surface that actually spawns the connector inside the AppContainer is
a work-in-progress in PR 1; if you see a "Windows sandbox spawn FFI is
a work-in-progress" error, the gap is tracked as a follow-up sub-issue.
Linux and macOS connectors are unaffected.

## Platform asymmetry {#platform-asymmetry}

| OS | Network policy when `permissions.network: ["a.com"]` |
| -- | ----------------------------------------------------- |
| Linux (helper available) | Per-host: only `a.com` reachable |
| Linux (helper missing) | All-or-nothing: full network |
| macOS | Per-host (SBPL host matching) |
| Windows | All-or-nothing (AppContainer `internetClient`) |

Windows per-host filtering would require Windows Filtering Platform
(WFP) callout drivers (kernel-mode signing, Windows hardware program
enrollment); deferred to a tracked follow-up. The asymmetry is surfaced
on three operator-visible surfaces:

- `nimbus diag --json` → `sandbox.platform_capabilities`
- `nimbus extension info <id>` → "Network isolation:" line
- Gateway-startup structured log

## Pre-T2 extensions

Extensions installed before this PR don't have a `permissions` object
in their manifest. They are **hard-disabled** at registry-load with a
clear message; the install record is retained so the user can
`nimbus extension reinstall <id>` to opt into the new schema.

To list affected extensions:

    nimbus extension list --filter needs-reinstall

## Stale DNS rules {#stale-dns-rules}

The Linux helper resolves each `permissions.network` host once at exec
time. If a host's IP changes during a long-running connector session
(CDN rotation, regional failover), the connector starts seeing
`ECONNREFUSED` / `ETIMEDOUT` against an allowed host. PR 1's recovery
strategy is:

1. The connector retries the connection. The kernel resolver caches DNS
   for the connector process; a fresh DNS query may return the new IP,
   but the iptables rules still list the old IPs.
2. Persistent failures surface a `SandboxStaleRulesError` in the
   connector's health state machine.
3. `nimbus diag --json` reports the count under
   `sandbox.stale_rules_count`.
4. To recover, restart the extension:

       nimbus extension restart <id>

   or restart the Gateway. The sandbox spawns a fresh helper invocation
   which re-resolves the allow-list.

Periodic re-resolve inside the helper (avoiding the manual restart) is
a tracked follow-up. PR 1 ships the counter so operators can size the
problem before the follow-up lands.

## Linux veth model

The helper creates a per-spawn netns and a `veth` pair connecting it to
the host: `nb-out-<pid>` (host side) ↔ `nb-in-<pid>` (inside the new
netns). The host-side peer is in the host's network namespace, so the
connector inside the new netns cannot see it as an interface — namespace
isolation enforces this at the kernel level. The connector also lacks
`CAP_NET_ADMIN` in the host's user namespace (bwrap's `--unshare-user`
moves it to a fresh user namespace where caps don't translate to
host-namespace effects), so it cannot manipulate or escape the netns
boundary.

## See also

- `docs/SECURITY-INVARIANTS.md` §I15 — sandbox-runner-intrinsic-to-spawn invariant.
- `docs/release/headless-postinst-linux-setcap.md` — Linux installer setcap flow.
- The PR 1 design spec for the architectural rationale.
