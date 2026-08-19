#!/usr/bin/env bash
# Install the Linux vault / PAL test dependencies: libsecret-tools (secret-tool),
# gnome-keyring (Secret Service provider), and dbus (session bus).
#
# Why this is a script and not an inline `apt-get` step:
# The GitHub Actions ubuntu runner image ships preconfigured Microsoft apt repos
# (packages.microsoft.com azure-cli + prod). During Microsoft signing-key rotations
# those repos return `403 Forbidden` / "no longer signed", and because `apt-get update`
# fails whole-hog when ANY configured repo can't be refreshed, our unrelated install
# of three stock-Ubuntu packages goes red with it. We don't need those repos here, so
# remove them before updating. See `_test-suite.yml` / `_perf.yml` callers.
#
# Privilege: does NOT call sudo itself — invoke with `sudo bash scripts/linux/install-vault-deps.sh`
# on CI runners, or run directly when already root (e.g. inside a Docker container).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# `a`utomatically restart affected services instead of opening needrestart's
# interactive "which services should be restarted?" list. `DEBIAN_FRONTEND`
# alone does not cover needrestart, which is a post-install hook, not a debconf
# question — and a prompt on stdin blocks a runner forever. See the sibling
# `install-sandbox-deps.sh`, written after the inline step it replaced wedged
# for 2h20m with no output and no timeout.
export NEEDRESTART_MODE=a

# Drop the flaky/unneeded Microsoft repos so `apt-get update` only refreshes the
# Ubuntu archive. `rm -f` is a no-op when the files are absent (non-GHA environments).
rm -f /etc/apt/sources.list.d/*microsoft* /etc/apt/sources.list.d/*azure* 2>/dev/null || true

apt-get -o Acquire::Retries=3 update -qq < /dev/null
apt-get -o Acquire::Retries=3 install -y -qq libsecret-tools gnome-keyring dbus < /dev/null
