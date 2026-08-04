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
#   bun run verify:docker            # fast-tier gates (default)
#   bun run verify:docker --full     # fast + full tier (build, test:ci, coverage-floor)
#   bun run verify:docker --rebuild  # force-rebuild the cached image first (stale bun version,
#                                     # changed apt package set)
set -euo pipefail

# Git Bash / MSYS on Windows rewrites container-internal paths (/out, /src, /root/...) and
# the `-v host:container` colon args into Windows paths, breaking docker. Disable that.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# CI pins bun 1.3 (.github/actions/setup-nimbus-ci/action.yml default) — `latest` is NOT CI.
BASE_IMAGE="oven/bun:1.3"
IMAGE="nimbus-verify:local"      # BASE_IMAGE + the apt layer, built once
CACHE_VOL="nimbus-bun-cache"
TIER="fast"
[[ "${1:-}" == "--full" ]] && TIER="full"
[[ "${1:-}" == "--rebuild" ]] && docker image rm -f "${IMAGE}" >/dev/null 2>&1 || true

cd "${REPO_ROOT}"
docker volume create "${CACHE_VOL}" >/dev/null

# Build the apt layer ONCE. Running apt inside `docker run --rm` discards it every invocation —
# measured at 49.5s per run, which is precisely the kind of tax that makes a tool get skipped.
# `--rebuild` (above) is the escape hatch when BASE_IMAGE or this package set changes; without
# it a stale cached image would silently keep pinning an old bun version forever.
if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "--- building ${IMAGE} (one-time, ~1 min) ---"
  docker build -t "${IMAGE}" -f - . <<DOCKERFILE
FROM ${BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
# Same packages CI's ubuntu runner has. Without libsecret/gnome-keyring/dbus the vault and PAL
# tests fail, which falsely un-covers every subsystem they exercise.
RUN apt-get update -qq \\
 && apt-get install -y -qq git libsecret-tools gnome-keyring dbus \\
 && rm -rf /var/lib/apt/lists/*
DOCKERFILE
fi

echo "--- docker: running ${TIER}-tier manifest gates (${IMAGE}) ---"
# Only .claude/worktrees/ is gitignored (project-local nested checkouts); everything else under
# .claude/ (commands/, agents/, hooks/) is tracked and audit:doc-refs resolves links into it —
# excluding the whole .claude/ directory (as reseed-docker.sh does, which never runs that audit)
# makes every `../.claude/commands/*.md` reference in docs/architecture.md fail as "missing".
tar --exclude=node_modules --exclude=.git --exclude=./coverage --exclude=dist \
    --exclude=.claude/worktrees -c -C "${REPO_ROOT}" . \
  | docker run --rm -i \
      -e CI=true -e TIER="${TIER}" \
      -v "${CACHE_VOL}:/root/.bun/install/cache" \
      -w /src \
      "${IMAGE}" \
      bash -c '
        set -euo pipefail
        mkdir -p /src && tar -x -C /src
        bun install --frozen-lockfile
        bun scripts/ci/run-manifest-gates.ts "$TIER"
      '
