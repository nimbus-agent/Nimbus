#!/usr/bin/env bash
# Build coverage/lcov.info by running bun test with istanbul preloads
# (istanbul-register.ts + report-coverage.ts) per package and merging
# the per-package nyc shards via merge-coverage.ts.  Emits BRDA branch
# records in addition to line/function coverage.
#
# Mirrors the per-package merge in .github/workflows/_test-suite.yml
# ("Unit tests (with coverage) — Linux" step). Run locally before
# `bun run audit:coverage-floor` to reproduce CI input. Tolerates test
# failures so partial lcov still seeds the baseline.

set -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO_ROOT}" || exit 1

rm -rf coverage
mkdir -p coverage/.nyc-tmp

REGISTER="${REPO_ROOT}/scripts/coverage/istanbul-register.ts"
REPORT="${REPO_ROOT}/scripts/coverage/report-coverage.ts"

# Ensure standard Bun installation directories are in PATH for non-interactive shells
if [[ -z "${USERPROFILE}" ]] && command -v cmd.exe &> /dev/null; then
  WIN_UP="$(cmd.exe /c "echo %USERPROFILE%" 2>/dev/null | tr -d '\r')"
  if [[ -n "${WIN_UP}" ]] && command -v wslpath &> /dev/null; then
    USERPROFILE="$(wslpath "${WIN_UP}")"
  fi
fi

if [[ -n "${USERPROFILE}" ]]; then
  if [[ "${USERPROFILE}" == /mnt/* || "${USERPROFILE}" == /home/* ]]; then
    export PATH="${USERPROFILE}/.bun/bin:${PATH}"
  else
    UP_MSYS="$(echo "${USERPROFILE}" | sed -e 's/\\/\//g' -e 's/^\([A-Za-z]\):/\/\1/' | tr '[:upper:]' '[:lower:]')"
    export PATH="${UP_MSYS}/.bun/bin:${PATH}"
    if command -v wslpath &> /dev/null; then
      UP_WSL="$(wslpath "${USERPROFILE}")"
      export PATH="${UP_WSL}/.bun/bin:${PATH}"
    fi
  fi
fi
export PATH="${HOME}/.bun/bin:${PATH}"

run_pkg () {
  local pkg="$1"
  if [[ -z "$(find "${pkg}" -path "${pkg}/node_modules" -prune -o \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' \) -print -quit)" ]]; then
    echo "Skipping ${pkg} — no test files."
    return 0
  fi
  echo "=== ${pkg} ==="
  (
    cd "${pkg}"
    # Istanbul instrumentation makes heavy tests ~2-3x slower; raise the
    # per-test timeout (default 5000ms) so slow integration tests don't flake
    # out and drop coverage on the files they cover. The fast dev-loop
    # `bun test` (no preloads) keeps the default.
    bun test --timeout 60000 --preload "${REGISTER}" --preload "${REPORT}"
  ) || true  # tolerate failing tests; whatever coverage was collected still merges
}

# `mcp-launcher` is a published bin package with its own tests (resolve-binary,
# exit-status). It was absent from this list while `sonar.sources=packages`
# still scanned it, so Sonar reported its files at 0% coverage even though the
# tests existed and passed — a measurement gap, not a testing gap.
#
# Adding it HERE only made its tests run. The gap stayed open until
# `scripts/coverage/instrument-scope.ts` also claimed the package: running a
# package's tests and instrumenting its source are separate switches, and only
# this one was flipped. Sonar kept reporting 0% for both files afterwards. With
# both in place the real numbers are exit-status 100% and resolve-binary 88%.
for pkg in packages/gateway packages/cli packages/mcp-launcher; do
  run_pkg "${pkg}"
done

for pkg in packages/mcp-connectors/* packages/github-actions/*; do
  if [[ -f "${pkg}/package.json" ]]; then
    run_pkg "${pkg}"
  fi
done

# The two explicit shared-folder calls `_test-suite.yml` makes after its own
# package.json loop. Both are relative-import folders with NO package.json, so
# the loop above skips them, yet both carry their own `*.test.ts`.
#
# Omitting them is the same two-switch bug the `mcp-launcher` comment above
# describes, pointed the other way: `scripts/coverage/instrument-scope.ts:16`
# DOES claim `packages/mcp-connectors/shared/`, so those 16 files are in scope
# and expected to report coverage — but their tests never ran here, so the
# merged lcov had no data for them and `audit:coverage-floor` failed them at 0%.
# CI passed the whole time, because CI has these two lines. A local verifier
# that disagrees with CI in the failing direction is worse than no verifier: it
# trains you to ignore it. This script's header calls itself a CI mirror; these
# lines are what make that true.
run_pkg "packages/mcp-connectors/shared"
run_pkg "packages/github-actions/shared"

if ! bun "${REPO_ROOT}/scripts/coverage/merge-coverage.ts"; then
  echo "ERROR: coverage merge failed" >&2
  exit 1
fi
if [[ ! -f coverage/lcov.info ]]; then
  echo "ERROR: coverage/lcov.info was not generated (no shards merged?)" >&2
  exit 1
fi

echo "---"
echo "coverage/lcov.info: $(wc -l < coverage/lcov.info) lines, $(grep -c '^SF:' coverage/lcov.info) source files, $(grep -c '^BRDA:' coverage/lcov.info) branch records"
