#!/usr/bin/env bash
# reseed-docker.sh — generate a CI-Linux-authoritative coverage/lcov.info via Docker,
# then reseed the branch-coverage baseline + run the gate on the host. Use before every
# Sub-project B PR so the ratchet sees Linux branch percentages, never per-OS-skewed local
# numbers. The host's node_modules is never touched (working tree is streamed in; install
# happens inside the container against a named cache volume).
#
# Usage: scripts/coverage-floor/reseed-docker.sh [--clean|-c]
#   --clean / -c   drop + recreate the bun-cache volume first (use if deps changed or the
#                  cache is corrupt; the next run re-installs from scratch).
set -euo pipefail

# Git Bash / MSYS on Windows rewrites container-internal paths (/out, /src, /root/...) and
# the `-v host:container` colon args into Windows paths, breaking docker. Disable that.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="oven/bun:latest"        # bun 1.3.14 == CI
CACHE_VOL="nimbus-bun-cache"   # named volume: bun install cache, paid once

if [[ "${1:-}" == "--clean" || "${1:-}" == "-c" ]]; then
  echo "--- cleaning bun-cache volume ${CACHE_VOL} ---"
  docker volume rm "${CACHE_VOL}" 2>/dev/null || true
fi

cd "${REPO_ROOT}"
docker volume create "${CACHE_VOL}" >/dev/null
mkdir -p coverage

echo "--- docker: build instrumented lcov (oven/bun:latest) ---"
# Stream tracked + untracked working-tree files (node_modules/.git/coverage/dist excluded)
# into the container, extract, install, build the client, run build-lcov.sh, copy lcov out.
# NB: `./coverage` is anchored to the repo root so it excludes the top-level output dir
# WITHOUT excluding `scripts/coverage/` (the istanbul preloads live there, force-tracked
# past .gitignore). A bare `--exclude=coverage` would drop the preloads → "preload not found".
tar --exclude=node_modules --exclude=.git --exclude=./coverage --exclude=dist \
    --exclude=.claude -c -C "${REPO_ROOT}" . \
  | docker run --rm -i \
      -e CI=true \
      -v "${CACHE_VOL}:/root/.bun/install/cache" \
      -v "${REPO_ROOT}/coverage:/out" \
      -w /src \
      "${IMAGE}" \
      bash -c '
        set -euo pipefail
        export DEBIAN_FRONTEND=noninteractive
        # Match the CI coverage job (_test-suite.yml unit-coverage): the ubuntu runner ships git
        # and installs libsecret-tools + gnome-keyring + dbus, then runs the suite inside a D-Bus
        # session via run-with-optional-dbus.sh. oven/bun:latest has none of these, so the PAL /
        # vault tests and the assemblePlatformServices boot fail — which falsely un-covers every
        # subsystem they exercise (scheduler, graph-populator, latency-ring-buffer,
        # delegated-request-remote, and the filesystem-v2-sync git path). Install + wrap to match.
        apt-get update -qq && apt-get install -y -qq git libsecret-tools gnome-keyring dbus >/dev/null
        mkdir -p /src && tar -x -C /src
        bun install --frozen-lockfile
        bash scripts/ci/run-with-optional-dbus.sh bash scripts/coverage-floor/build-lcov.sh
        cp coverage/lcov.info /out/lcov.info
      '

echo "--- host: reseed baseline + gate (lcov is Docker/Linux) ---"
bun run audit:coverage-floor:update-baseline
bun run audit:coverage-floor
