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
