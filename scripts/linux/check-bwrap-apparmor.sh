#!/usr/bin/env bash
# With Ubuntu's default restriction ON, prove what a stock machine gets: bwrap and the gateway's
# own `canConfine` fail without the profile, work with it, and fail again once it is removed.
#
# install-sandbox-deps.sh turns the restriction off for the test suite, which is why a stock
# Ubuntu 24.04 could not start any sandboxed child while every test stayed green. This script is
# the one place that runs with it on. Run as the unprivileged runner user; it calls sudo itself.
set -euo pipefail

KNOB=kernel.apparmor_restrict_unprivileged_userns
PROFILE=/etc/apparmor.d/nimbus-bwrap
work="$(mktemp -d)"
initial_knob="$(sysctl -n "${KNOB}")"

cleanup() {
  if [ -f "${work}/remove.sh" ]; then
    sudo sh "${work}/remove.sh" || true
  fi
  sudo sysctl -w "${KNOB}=${initial_knob}" > /dev/null
  rm -rf "${work}"
}
trap cleanup EXIT

# Both shapes the runner spawns, because they fail with different messages.
start_bwrap() {
  bwrap --unshare-user "$1" --new-session \
    --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind-try /lib64 /lib64 \
    --proc /proc --dev /dev /usr/bin/true 2> "${work}/stderr"
}

# Prints the runner's answer for a no-network policy: "null", or its reason.
can_confine() {
  bun --no-env-file -e '
    const { createLinuxSandboxRunner } = await import("./packages/gateway/src/platform/sandbox/linux.ts");
    const runner = createLinuxSandboxRunner();
    const policy = { id: "check", permissions: { network: [], filesystem: { read: [], write: [] } } };
    console.log(runner.canConfine(policy) ?? "null");
  '
}

expect_blocked() {
  for net in --unshare-net --share-net; do
    if start_bwrap "${net}"; then
      echo "check-bwrap-apparmor: bwrap ${net} started $1, expected the restriction to stop it" >&2
      exit 1
    fi
    echo "  bwrap ${net}: blocked ($(cat "${work}/stderr"))"
  done
  local answer
  answer="$(can_confine)"
  if [ "${answer}" = "null" ]; then
    echo "check-bwrap-apparmor: canConfine said yes $1, on a machine where bwrap cannot start" >&2
    exit 1
  fi
  echo "  canConfine: refused (${answer})"
}

expect_allowed() {
  for net in --unshare-net --share-net; do
    if ! start_bwrap "${net}"; then
      echo "check-bwrap-apparmor: bwrap ${net} failed $1: $(cat "${work}/stderr")" >&2
      exit 1
    fi
    echo "  bwrap ${net}: started"
  done
  local answer
  answer="$(can_confine)"
  if [ "${answer}" != "null" ]; then
    echo "check-bwrap-apparmor: canConfine refused $1: ${answer}" >&2
    exit 1
  fi
  echo "  canConfine: yes"
}

bun --no-env-file scripts/linux/print-bwrap-apparmor-shell.ts install > "${work}/install.sh"
bun --no-env-file scripts/linux/print-bwrap-apparmor-shell.ts remove > "${work}/remove.sh"

sudo sysctl -w "${KNOB}=1" > /dev/null

echo "Restriction on, no profile:"
expect_blocked "with no profile"

echo "Restriction on, the .deb's install block has run:"
sudo sh "${work}/install.sh"
test -f "${PROFILE}"
expect_allowed "with the profile"

echo "Restriction on, the profile loaded, name resolution through the real runner:"
bun --no-env-file scripts/linux/check-sandbox-dns.ts

# The whole per-host path, and the one place it runs with the restriction on: nested bwrap, the
# launcher, the forwarder and a real connector, under the profile the .deb installs. A failure here
# on an otherwise green test suite means stock Ubuntu cannot start a network child.
# No retry anywhere here, on purpose: this path has to work the first time. A host that cannot reach
# a service even outside the sandbox is a loud skip, and a sandbox failure with a working host is red.
echo "Restriction on, the profile loaded, the network forwarder:"
helper="${PWD}/packages/gateway/src-native/sandbox-helper/nimbus-sandbox-helper"
bun run build:sandbox-helper
NIMBUS_SANDBOX_HELPER_PATH="${helper}" bun --no-env-file scripts/linux/check-sandbox-dns.ts
# `nimbus doctor`'s own nested start, whose argv is a copy the CLI keeps because it cannot import the
# gateway's. Real helper, real namespaces, so this shows only a copy that no longer STARTS here under
# the profile. A copy that drifts and still starts passes this; scripts/sandbox-doctor-parity.test.ts
# compares its flags with the gateway's. And a passing probe here says nothing about the running
# gateway, which doctor asks for itself and which outranks it.
NIMBUS_SANDBOX_HELPER_PATH="${helper}" bun --no-env-file -e '
  const { createDoctorBwrapDeps, doctorPrintLinuxSandbox } = await import("./packages/cli/src/commands/doctor-bwrap.ts");
  process.exit(doctorPrintLinuxSandbox(createDoctorBwrapDeps("linux")));
' | tee "${work}/doctor.txt"
grep -qxF "[ok] Sandbox: the network forwarder can start here. Start the gateway to confirm enforcement." "${work}/doctor.txt"
CI=true NIMBUS_REQUIRE_SANDBOX_HELPER=1 NIMBUS_REQUIRE_REAL_NETWORK=1 \
  bun test packages/gateway/src/platform/sandbox/linux-forwarder-network.test.ts --timeout 60000
(cd packages/gateway && bun run build)
NIMBUS_SANDBOX_HELPER_PATH="${helper}" \
  bun --no-env-file scripts/linux/check-forwarder-connector.ts dist/nimbus-gateway

echo "Restriction on, the install block has run twice (an upgrade):"
sudo sh "${work}/install.sh"
expect_allowed "after a second install"

echo "Restriction on, the .deb's remove block has run:"
sudo sh "${work}/remove.sh"
test ! -e "${PROFILE}"
expect_blocked "after the profile was removed"

echo "check-bwrap-apparmor: passed"
