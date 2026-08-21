#!/usr/bin/env bash
# Install the Linux sandbox test dependencies: bubblewrap (the sandbox itself),
# libcap-dev (the helper's setcap build), strace (the syscall-confinement
# assertions), and cppcheck (the helper's static analysis).
#
# Why this is a script and not an inline `apt-get` step:
# 1. The GitHub Actions ubuntu runner image ships preconfigured Microsoft apt
#    repos (packages.microsoft.com azure-cli + prod). During Microsoft signing-key
#    rotations those repos return `403 Forbidden` / "no longer signed", and because
#    `apt-get update` fails whole-hog when ANY configured repo can't be refreshed,
#    our unrelated install of four stock-Ubuntu packages goes red with it. We don't
#    need those repos here, so remove them before updating.
# 2. The inline version carried none of the non-interactive settings below and
#    WEDGED: on 2026-08-19 two concurrent runs sat in this step for 2h20m with no
#    output and no timeout, blocking the release PR (#1247). A prompt on stdin
#    blocks forever on a runner; `-y` alone does not prevent one, because debconf
#    and needrestart ask outside apt's own confirmation. The three defenses are
#    layered on purpose: `DEBIAN_FRONTEND` + `NEEDRESTART_MODE` stop the prompts
#    that are known to exist, and `< /dev/null` turns any prompt we did not
#    anticipate into an immediate EOF failure rather than an indefinite hang.
#
# Privilege: does NOT call sudo itself — invoke with `sudo bash scripts/linux/install-sandbox-deps.sh`
# on CI runners, or run directly when already root. See `_test-suite.yml`.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# `a`utomatically restart affected services instead of opening needrestart's
# interactive "which services should be restarted?" list.
export NEEDRESTART_MODE=a

# Drop the flaky/unneeded Microsoft repos so `apt-get update` only refreshes the
# Ubuntu archive. `rm -f` is a no-op when the files are absent (non-GHA environments).
rm -f /etc/apt/sources.list.d/*microsoft* /etc/apt/sources.list.d/*azure* 2>/dev/null || true

apt-get -o Acquire::Retries=3 update -qq < /dev/null
apt-get -o Acquire::Retries=3 install -y -qq bubblewrap libcap-dev strace cppcheck < /dev/null

# ── Unprivileged user namespaces ─────────────────────────────────────────────
# Installing bwrap is NOT the same as being able to run it. `--unshare-user`
# needs unprivileged user-namespace creation, and two distros gate that
# differently — with the gate shut by default in both cases on a stock image:
#
#  * Ubuntu >= 23.10 (this repo's ubuntu-24.04 runner) ships AppArmor's
#    `kernel.apparmor_restrict_unprivileged_userns=1`, which denies the unshare
#    to any unconfined program that has no `userns`-granting AppArmor profile.
#    Ubuntu's bubblewrap package ships no such profile — `dpkg -L bubblewrap`
#    on 24.04 (0.9.0-1ubuntu0.1) lists only the binary, docs, a sysctl.d file
#    and shell completions.
#  * Debian gates it on `kernel.unprivileged_userns_clone`. The package's own
#    /usr/lib/sysctl.d/50-bubblewrap.conf sets that to 1, but sysctl.d files
#    are applied at boot by systemd-sysctl, not by dpkg — so installing
#    bubblewrap on an already-running machine does not take effect.
#
# With the gate shut, bwrap dies BEFORE exec'ing anything:
#   bwrap: No permissions to create new namespace, likely because the kernel
#   does not allow non-privileged user namespaces.
# and exits 1 with no stdout — which is indistinguishable, at the exit code
# alone, from "the child binary was not reachable inside the sandbox".
#
# `|| true` on each line: a knob that does not exist on this kernel is not an
# error (`sysctl -w` exits non-zero for an unknown key, and `set -e` is on).
sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 > /dev/null 2>&1 || true
sysctl -w kernel.unprivileged_userns_clone=1 > /dev/null 2>&1 || true

# Assert the dependency WORKS, not merely that it is installed. Without this,
# an unusable bwrap surfaces four assertions deep inside
# sandbox-wrapper-spawn.test.ts with no reason attached; here it is named at
# the step that owns it. The bind set mirrors buildBwrapArgv (linux.ts) so the
# smoke run exercises the same namespace setup the product uses.
smoke_argv=(--unshare-user --unshare-net --new-session
  --ro-bind /usr /usr --ro-bind /etc /etc --ro-bind /lib /lib
  --proc /proc --dev /dev --tmpfs /tmp)
if [ -d /lib64 ]; then
  smoke_argv+=(--ro-bind /lib64 /lib64)
fi

# Probe as the UNPRIVILEGED user, not as root.
#
# This script runs under `sudo bash` on CI, and root is exempt from the very gate
# this probe exists to detect: `kernel.apparmor_restrict_unprivileged_userns`
# restricts UNPRIVILEGED user-namespace creation, so root creates one whether or
# not the `sysctl -w` above took effect. Both knob writes are `|| true`, so a
# silent failure there is exactly the case the probe must catch — and a root-only
# probe would pass through it and hand the false green straight to the test suite,
# which then fails as the runner user with the diagnosis missing. That is the same
# defect shape as a readiness check that asks a narrower question than production.
#
# `SUDO_USER` is set by sudo to the invoking account. Absent (already unprivileged,
# or a genuine root shell with no sudo hop) there is no other principal to drop to,
# so run in place and say so rather than inventing one.
if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
  smoke_as="${SUDO_USER}"
  smoke_cmd=(sudo -u "${SUDO_USER}" bwrap)
else
  smoke_as="$(id -un)"
  smoke_cmd=(bwrap)
fi

smoke_err="$(mktemp)"
if ! "${smoke_cmd[@]}" "${smoke_argv[@]}" /usr/bin/true 2> "${smoke_err}"; then
  echo "install-sandbox-deps: bubblewrap is installed but cannot create a sandbox" >&2
  echo "as user '${smoke_as}':" >&2
  cat "${smoke_err}" >&2
  echo "" >&2
  echo "Every sandboxed spawn (and sandbox-wrapper-spawn.test.ts) fails at bwrap" >&2
  echo "startup in this state. Check the unprivileged-userns knobs above:" >&2
  echo "  kernel.apparmor_restrict_unprivileged_userns = $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo '<absent>')" >&2
  echo "  user.max_user_namespaces                     = $(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo '<absent>')" >&2
  rm -f "${smoke_err}"
  exit 1
fi
rm -f "${smoke_err}"
echo "install-sandbox-deps: bwrap smoke test passed as user '${smoke_as}'."
