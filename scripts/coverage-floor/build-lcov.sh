#!/usr/bin/env bash
# Build coverage/lcov.info by running bun test --coverage --coverage-reporter=lcov
# from inside each bun-tested workspace package and merging the per-package
# shards with SF: paths rewritten to be repo-root-relative.
#
# Mirrors the per-package merge in .github/workflows/_test-suite.yml
# ("Unit tests (with coverage) — Linux" step). Run locally before
# `bun run audit:coverage-floor` to reproduce CI input. Tolerates test
# failures so partial lcov still seeds the baseline.

set -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO_ROOT}" || exit 1

rm -rf coverage
mkdir -p coverage
: > coverage/lcov.info

run_pkg () {
  local pkg="$1"
  if [ -z "$(find "${pkg}" -path "${pkg}/node_modules" -prune -o \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' \) -print -quit)" ]; then
    echo "Skipping ${pkg} — no test files."
    return 0
  fi
  echo "=== ${pkg} ==="
  (
    cd "${pkg}"
    bun test --coverage --coverage-reporter=lcov
  ) || true  # tolerate failing tests; whatever lcov was emitted still merges
  if [ -f "${pkg}/coverage/lcov.info" ]; then
    sed "s|^SF:|SF:${pkg}/|" "${pkg}/coverage/lcov.info" >> coverage/lcov.info
  fi
}

for pkg in packages/gateway packages/cli packages/sdk packages/client; do
  run_pkg "${pkg}"
done

for pkg in packages/mcp-connectors/*; do
  if [ -f "${pkg}/package.json" ]; then
    run_pkg "${pkg}"
  fi
done

echo "---"
echo "coverage/lcov.info: $(wc -l < coverage/lcov.info) lines, $(grep -c '^SF:' coverage/lcov.info) source files indexed"
