# nimbus-sandbox-helper

Privileged helper for the Linux extension sandbox (T2 PR 1, I15).

Granted `cap_net_admin+ep` at install time (`setcap`); used by the Nimbus
Gateway to create a per-spawn network namespace, install per-host iptables
rules, drop capabilities, and `execv` the connector inside `bwrap`.

## Modes

- `nimbus-sandbox-helper --check-caps` — print `OK` and exit 0 iff
  `cap_net_admin` is in permitted set. Otherwise print reason and exit 1.
  Used by the Gateway startup probe.

- `nimbus-sandbox-helper --allow <host[:port]> [--allow <host[:port]> ...] -- <argv...>`
  — enforce-and-exec mode. A bare host opens TCP/443; an explicit `host:port`
  (e.g. `imap.example.com:993`) opens that TCP port instead — used by the email
  (IMAP/SMTP) connector class.

## Design

See `docs/sandbox.md` and the PR 1 design spec §4 Linux.
