#!/usr/bin/env bash
# verify-in-docker.sh — run the PREFLIGHT_GATES manifest inside a Linux container at a NORMAL path.
#
# Why: local gates can be blind to what CI sees. Two classes cause it — path exclusions (a worktree
# under .claude/ excluded itself from biome) and OS differences (audit:coverage-floor is
# CI-Linux-authoritative). Running the manifest at /src in oven/bun removes both at once.
#
# Gate commands come from the manifest's `cmd` arrays VERBATIM. Nothing is retyped here: in #1038
# `audit:any` was run without its `--check` flag and silently exited 0.
#
# Usage:
#   bun run verify:docker                     # fast-tier gates (default)
#   bun run verify:docker --full               # fast + full tier (build, test:ci, coverage-floor)
#   bun run verify:docker --rebuild             # force-rebuild the cached image first (stale bun
#                                                # version, changed apt package set)
#   bun run verify:docker --full --rebuild      # flags combine in any order
set -euo pipefail

# Git Bash / MSYS on Windows rewrites container-internal paths (/out, /src, /root/...) and
# the `-v host:container` colon args into Windows paths, breaking docker. Disable that.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# CI pins bun 1.3 (.github/actions/setup-nimbus-ci/action.yml default) — `latest` is NOT CI.
BASE_IMAGE="oven/bun:1.3"
IMAGE="nimbus-verify:local"      # BASE_IMAGE + the apt layer + non-root plumbing, built once
CACHE_VOL="nimbus-bun-cache"
# A deterministic name so an interrupted run can be force-removed. `docker run --rm` is a
# promise kept by the daemon on a NORMAL exit only — if this script is killed (e.g. the
# caller's own timeout), the docker CLI client dies but the container the daemon is running
# keeps burning CPU indefinitely. The EXIT/INT/TERM trap below is what actually reclaims it.
CONTAINER_NAME="nimbus-verify-run"
cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

TIER="fast"
REBUILD=0
# `while [[ $# -gt 0 ]]` rather than `for arg in "$@"`: under `set -u`, bash 3.2 (which is what
# /bin/bash is on macOS — 3.2.57, frozen at the last GPLv2 release) treats an EMPTY "$@" as an
# unbound variable and aborts. `bun run verify:docker` with no flags is the documented default
# usage, so on macOS the tool would die before doing anything. Not reproduced here (no macOS
# available); this is a defensive fix against bash 3.2 semantics.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --full) TIER="full" ;;
    --rebuild) REBUILD=1 ;;
    *)
      echo "verify-in-docker.sh: unknown flag '$1' (expected --full and/or --rebuild)" >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "${REBUILD}" == "1" ]]; then
  docker image rm -f "${IMAGE}" >/dev/null 2>&1 || true
  # The cache volume can carry root-owned entries from a run predating the switch to a non-root
  # container user (below). Reusing it as-is under the bun user produces EACCES on `bun install`
  # instead of a clean rebuild, so wipe it too — Docker re-initializes an empty named volume from
  # the (bun-owned) image directory the first time it's mounted.
  docker volume rm -f "${CACHE_VOL}" >/dev/null 2>&1 || true
fi

cd "${REPO_ROOT}"
docker volume create "${CACHE_VOL}" >/dev/null

# Build the apt layer ONCE. Running apt inside `docker run --rm` discards it every invocation —
# measured at 49.5s per run, which is precisely the kind of tax that makes a tool get skipped.
# `--rebuild` (above) is the escape hatch when BASE_IMAGE or this package set changes; without
# it a stale cached image would silently keep pinning an old bun version forever.
if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "--- building ${IMAGE} (one-time, ~1 min) ---"
  # `-` (not `-f - .`) reads the Dockerfile from stdin with an EMPTY build context. The Dockerfile
  # below has no COPY — the repo is streamed in by `tar | docker run` further down — so `.` only
  # served to ship the entire working tree (node_modules included, ~1 GB) to the daemon on every
  # cache miss for nothing.
  docker build -t "${IMAGE}" - <<DOCKERFILE
FROM ${BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
# Same packages CI's ubuntu runner has. Without libsecret/gnome-keyring/dbus the vault and PAL
# tests fail, which falsely un-covers every subsystem they exercise. gnupg is required by
# scripts/release/fixtures/gen-test-key.sh (the release signature-verification tests).
RUN apt-get update -qq \
 && apt-get install -y -qq git libsecret-tools gnome-keyring dbus gnupg \
 && rm -rf /var/lib/apt/lists/*
# Pre-create /src and the bun install-cache mount point owned by the image's built-in "bun" user
# (uid 1000 — oven/bun ships it) so the container can run non-root. GitHub Actions' ubuntu
# runner runs as a non-root "runner" user (uid 1000); running this container as root silently
# bypasses DAC permission checks some tests depend on (e.g. resolveDailyNotePath's
# chmodSync(0o000)-then-expect-EACCES test in obsidian-daily-note.test.ts).
RUN mkdir -p /src /home/bun/.bun/install/cache && chown -R bun:bun /src /home/bun/.bun
DOCKERFILE
fi

echo "--- docker: running ${TIER}-tier manifest gates (${IMAGE}) ---"
# Only .claude/worktrees/ is gitignored (project-local nested checkouts); everything else under
# .claude/ (commands/, agents/, hooks/) is tracked and audit:doc-refs resolves links into it —
# excluding the whole .claude/ directory (as reseed-docker.sh does, which never runs that audit)
# makes every `../.claude/commands/*.md` reference in docs/architecture.md fail as "missing".
tar --exclude=node_modules --exclude=.git --exclude=./coverage --exclude=dist \
    --exclude=.claude/worktrees -c -C "${REPO_ROOT}" . \
  | docker run --rm -i --name "${CONTAINER_NAME}" \
      -e CI=true -e TIER="${TIER}" -e HOME=/home/bun \
      -u bun \
      -v "${CACHE_VOL}:/home/bun/.bun/install/cache" \
      -w /src \
      "${IMAGE}" \
      bash -c '
        set -euo pipefail
        tar -x -C /src
        bun install --frozen-lockfile
        # CI never invokes a test-bearing gate bare — every test-suite.yml call site (unit
        # coverage per-package, the e2e suite, the coverage-gate matrix Vault leg) wraps it in
        # run-with-optional-dbus.sh, which opens a real D-Bus session + gnome-keyring Secret
        # Service (linux-dbus-tests.sh). Without it, LinuxSecretToolVault/PAL/assemblePlatformServices
        # boot a vault with no Secret Service to talk to, and e2e suites that spawn a real gateway
        # subprocess hang until their 60s timeout — CI-faithful failures caused by a CI-unfaithful
        # invocation. Wrap the whole gate run in ONE D-Bus session (matching the per-unit-of-work
        # granularity CI wraps at) rather than re-opening one per gate.
        bash scripts/ci/run-with-optional-dbus.sh bun scripts/ci/run-manifest-gates.ts "$TIER"
      '
