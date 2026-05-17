# Linux setcap postinst flow

The Nimbus Linux package grants `cap_net_admin+ep` to
`/usr/lib/nimbus/bin/nimbus-sandbox-helper` so the sandbox can enforce
per-host network filtering without running the Gateway as root.

## Verifying

    getcap /usr/lib/nimbus/bin/nimbus-sandbox-helper

Expected: `cap_net_admin+ep`. If empty, run:

    sudo setcap cap_net_admin+ep /usr/lib/nimbus/bin/nimbus-sandbox-helper

The Gateway falls back to all-or-nothing network (with a startup warning)
if the cap is missing.

## See also

- `docs/sandbox.md#linux` for the full sandbox model
- T2 PR 1 design spec §4 Linux
