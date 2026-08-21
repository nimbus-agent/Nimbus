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

### Per-host ports {#per-host-ports}

A `permissions.network` entry is either a bare host (which opens **TCP/443**,
the default) or an explicit `host:port` such as `imap.fastmail.com:993`. The
port must be an integer in `1..65535`. This lets the email (IMAP/SMTP)
connector class reach non-443 ports — e.g. IMAP `993`, SMTP submission `465`
or `587` — while everything else keeps the HTTPS-only default:

    {
      "permissions": {
        "network": [
          "api.fastmail.com",
          "imap.fastmail.com:993",
          "smtp.fastmail.com:465"
        ]
      }
    }

Enforcement is per-host **and** per-port on Linux (helper) and macOS; the
bare-host form is identical to the pre-Tier-4 behaviour (TCP/443). On Windows
the port is not enforced (all-or-nothing `internetClient`, as for hosts — see
[#platform-asymmetry](#platform-asymmetry)).

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

`AppContainer` profiles isolate each extension by SID, enforced through
a native, **unprivileged** helper — `nimbus-sandbox-helper.exe` — that
ships beside `nimbus-gateway.exe` in every Windows release artifact
(zip and MSI) and is resolved by `dirname(process.execPath)` at
startup. `CreateAppContainerProfile` is a per-user API: ACL edits
inside the user's own profile need no elevation, so there is no
install-time `setcap`-equivalent step, unlike the Linux helper.

On every spawn the helper:

- creates or derives the extension's per-profile AppContainer SID
  (`nimbus-ext-<extension id>`);
- grants that SID an inheritable ACL — Read+Execute+Write on the
  working directory, Read+Execute (or +Write) on each declared
  `permissions.filesystem.read` / `write` path — and grants **nothing**
  to any ancestor directory. A grant failure aborts the spawn (exit
  `66`) rather than falling back to running unconfined; the same code
  covers a target on a filesystem without DACL support (FAT32/exFAT,
  some network shares), since `SetNamedSecurityInfoW` cannot write an
  ACL there either;
- grants the `internetClient` capability SID iff `permissions.network`
  is non-empty — see [#platform-asymmetry](#platform-asymmetry) below;
  per-host filtering is still not enforced on Windows, unchanged by
  this work;
- assigns the (suspended) child to a Job Object with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` **before** resuming it, so a
  crashed or killed helper cannot orphan the child — the Windows
  analogue of bwrap's `--die-with-parent`; and
- `CreateProcessW`s the child, waits, and propagates its exit code.
  Helper-originated failures (profile, ACL, Job Object, or
  `CreateProcessW` failures) use reserved exit codes `65`–`68`; stderr
  is the authoritative failure channel. Full contract:
  `packages/gateway/src-native/sandbox-helper-win32/README.md`.

Startup probes the helper (`--check-caps`); if it is missing or fails,
the runner **refuses to spawn unconfined** and the extension does not
start — the same fail-closed posture the pre-implementation stub had,
now conditional on a measured fact instead of permanent.

#### Known limitation: `bun <script>` under a profile-nested cwd

Measured on this branch, not theoretical: **a `bun <script>` child
cannot start when its working directory is nested inside the user
profile** (e.g. `%LOCALAPPDATA%\Nimbus\extensions\<ext>\workdir`, the
real production shape). It fails with:

    error loading current directory
    error: An internal error occurred (CouldntReadCurrentDirectory)

The cause is Bun's own startup, not the sandbox — but what exactly Bun
does at startup is not fully pinned down: what was measured is that
Bun fails this way under a profile-nested cwd, and that a `package.json`
placed directly at the leaf does not stop the failure (so "Bun walks
upward looking for `package.json`/`bunfig.toml` and reaches `C:\Users`,
whose DACL a non-elevated token cannot rewrite" was an earlier
explanation for this, tried and disproved by that leaf-`package.json`
experiment — see the "Consequence, measured rather than assumed" note
in the helper's own README). A plain Win32 binary (e.g. `powershell.exe`)
spawned through the identical helper invocation, at the identical path,
with the identical grants, runs fine — which is what pins the failure
on Bun's own startup rather than on AppContainer or Windows itself. The
helper does not grant ancestor directories anything to work around
this: an earlier revision did, and removed it — see the "used to be a
third category" note in the helper's own README for why (a modified
DACL on a directory the helper does not own is itself an unwanted side
effect, independent of a separate hang one such walk produced on a
production-shaped tree).

**What this means in practice.** The shipped product spawns the
**compiled** `nimbus-gateway.exe __nimbus-connector <id>` — no script
path, so Bun's own startup walk never runs, and the failure above does
not occur. A **dev tree** spawns `bun <entry> __nimbus-connector <id>`
instead, which does hit the walk, so a Windows contributor running
from source with a profile-nested cwd will see this error where a
packaged install would not. If you hit
`CouldntReadCurrentDirectory` while developing on Windows, that is
this limitation, not a regression — relocate the sandboxed cwd out
from under the user profile, or run against a built `nimbus-gateway.exe`
instead of `bun run`.

## Platform asymmetry {#platform-asymmetry}

| OS | Network policy when `permissions.network: ["a.com", "b.com:993"]` |
| -- | ----------------------------------------------------- |
| Linux (helper available) | Per-host + per-port: only `a.com:443` and `b.com:993` reachable |
| Linux (helper missing) | All-or-nothing: full network |
| macOS | Per-host + per-port (SBPL host + `remote tcp "*:port"` matching) |
| Windows | All-or-nothing (AppContainer `internetClient`; port not enforced) |

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
