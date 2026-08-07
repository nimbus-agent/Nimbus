#!/usr/bin/env bash
#
# Collect a triage bundle from a test job that has ALREADY FAILED, before the
# job's cleanup step deletes the evidence.
#
# Why this exists: the dominant CI pain in this repo is a Linux-only failure that
# does not reproduce on Windows/macOS (see CLAUDE.md "CI-Linux-only failures").
# The JUnit XML says WHICH test failed; it never says what the spawned gateway
# printed or what ended up in its SQLite index. `verify:docker` exists largely to
# re-obtain, locally, output the CI runner already had and threw away.
#
# What it can and cannot reach — be precise, because a bundle that looks empty is
# worse than no bundle:
#   * JUnit XML — always present. Today it is only RENDERED into the Checks UI by
#     dorny/test-reporter, which runs with `fail-on-error: false`, so a reporter
#     hiccup loses it with no trace. A downloadable copy costs nothing.
#   * Gateway working directories — the e2e tests `rmSync` their own `mkdtemp`
#     directory from a `finally` block, so after an ORDINARY assertion failure
#     nothing survives and this bundle will legitimately contain no dirs. What
#     DOES survive is exactly the class with no other evidence: a hang killed by
#     the job timeout, a segfault, an early `process.exit` that skips the
#     `finally`. Preserving a directory across an ordinary assertion failure
#     needs harness cooperation at 43 bespoke `Bun.spawn` sites across 14 files;
#     that is a separate change, not a widening of this one.
#
# Not `set -e`: this runs only when the job is already red. It must never mask the
# real failure, and a missing directory is an expected outcome, not an error.
set -uo pipefail

label="${1:?usage: collect-failure-artifacts.sh <label>}"
out="failure-artifacts"
manifest="${out}/MANIFEST.txt"

# Per-file and total ceilings. A test index can grow large, and an artifact upload
# that takes longer than the test run helps nobody.
max_file_bytes=$((25 * 1024 * 1024))
max_total_bytes=$((200 * 1024 * 1024))

mkdir -p "$out"
{
  echo "job label : ${label}"
  echo "os        : $(uname -s 2>/dev/null || echo unknown) $(uname -m 2>/dev/null || echo '')"
  echo "bun       : $(bun --version 2>/dev/null || echo 'not on PATH')"
  echo "collected : the bundle below is what SURVIVED the failure, not everything the run touched."
  echo
} > "$manifest"

# Git Bash on the Windows runner receives Windows-shaped paths in RUNNER_TEMP /
# TEMP (`D:\a\_temp`), which `find` cannot walk. Convert when cygpath is present.
to_unix() {
  if command -v cygpath > /dev/null 2>&1; then
    cygpath -u "$1" 2> /dev/null || printf '%s\n' "$1"
  else
    printf '%s\n' "$1"
  fi
}

# ── 1. JUnit XML ────────────────────────────────────────────────────────────
if [ -d junit-reports ]; then
  mkdir -p "${out}/junit"
  cp junit-reports/*.xml "${out}/junit/" 2> /dev/null
  echo "junit: $(find "${out}/junit" -name '*.xml' 2> /dev/null | wc -l | tr -d ' ') report(s)" >> "$manifest"
else
  echo "junit: none (junit-reports/ absent)" >> "$manifest"
fi

# ── 2. Surviving gateway working directories ────────────────────────────────
# Every e2e/integration temp dir is `mkdtemp(join(tmpdir(), "nimbus-<suite>-"))`,
# so `nimbus-*` is the correct net. (The pre-existing cleanup steps matched
# `nimbus-test-*`, which no suite has ever produced — they were decorative.)
roots=""
for candidate in "${RUNNER_TEMP:-}" "${TMPDIR:-}" "${TEMP:-}" /tmp; do
  [ -n "$candidate" ] || continue
  unix_root="$(to_unix "$candidate")"
  [ -d "$unix_root" ] || continue
  case " ${roots} " in
    *" ${unix_root} "*) continue ;; # already scanned (TMPDIR often == /tmp)
  esac
  roots="${roots} ${unix_root}"
done
echo "temp roots scanned:${roots:- none}" >> "$manifest"

# Allow-list, not deny-list. This repository is public and workflow artifacts are
# downloadable by anyone who can read it, so the filter has to fail CLOSED: a file
# type nobody vetted must be skipped by default rather than uploaded because no
# rule happened to name it. `.log` is the gateway's own output; the SQLite index
# holds connector FIXTURE data, and Non-Negotiable #3 keeps real credentials in
# the OS Vault and out of the DB entirely. The `vault/` prune below is belt and
# braces on top of that guarantee, not a substitute for it.
copied=0
skipped_big=0
skipped_total=0
total_bytes=0

# Enumerate the suite directories FIRST, then descend only into those. Walking a
# whole temp root and filtering by `-path '*nimbus-*'` reads every unrelated file
# in it. Two bounds, both learned the hard way on a developer machine where /tmp is
# the user's real temp directory:
#
#   -mmin  : only directories touched recently can belong to THIS run. Without it
#            the scan found 42,400 historical `nimbus-*` directories and descended
#            into every one — the collector ran past two minutes and would have
#            become the reason a job hit its 30-minute timeout. `-mmin` is in both
#            GNU and BSD find, so it holds on the macOS runner too.
#   max_dirs: a hard backstop if a suite somehow creates thousands inside the
#            window. Anything dropped is NAMED in the manifest — a bundle that
#            silently truncates reads as "this is everything" when it is not.
max_age_min=240
max_dirs=100

suite_dirs=""
for root in $roots; do
  while IFS= read -r dir; do
    [ -n "$dir" ] && suite_dirs="${suite_dirs}${dir}"$'\n'
  done << EOF
$(find "$root" -maxdepth 1 -type d -name 'nimbus-*' -mmin "-${max_age_min}" 2> /dev/null)
EOF
done

found_dirs=$(printf '%s' "$suite_dirs" | grep -c . || true)
if [ "$found_dirs" -gt "$max_dirs" ]; then
  echo "suite dirs found: ${found_dirs} (modified in the last ${max_age_min} min) — CAPPED at ${max_dirs}, $((found_dirs - max_dirs)) NOT collected" >> "$manifest"
  suite_dirs=$(printf '%s' "$suite_dirs" | head -n "$max_dirs")
else
  echo "suite dirs found: ${found_dirs} (modified in the last ${max_age_min} min)" >> "$manifest"
fi

while IFS= read -r dir; do
  [ -n "$dir" ] || continue
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    size=$(wc -c < "$file" 2> /dev/null | tr -d ' ')
    [ -n "$size" ] || continue
    if [ "$size" -gt "$max_file_bytes" ]; then
      skipped_big=$((skipped_big + 1))
      echo "  SKIPPED (too large, ${size} B): ${file}" >> "$manifest"
      continue
    fi
    if [ $((total_bytes + size)) -gt "$max_total_bytes" ]; then
      skipped_total=$((skipped_total + 1))
      continue
    fi
    dest="${out}/workdirs/$(echo "$file" | sed 's#^/##; s#[:\\]#_#g')"
    mkdir -p "$(dirname "$dest")" 2> /dev/null
    if cp "$file" "$dest" 2> /dev/null; then
      copied=$((copied + 1))
      total_bytes=$((total_bytes + size))
    fi
  done << EOF
$(find "$dir" -maxdepth 5 -type d -name vault -prune -o \
  -type f \( -name '*.log' -o -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' \
  -o -name '*.sqlite' -o -name '*.sqlite3' \) -print 2> /dev/null)
EOF
done << EOF
${suite_dirs}
EOF

{
  echo
  echo "workdir files copied : ${copied} (${total_bytes} B)"
  echo "skipped, over ${max_file_bytes} B per file : ${skipped_big}"
  echo "skipped, bundle hit ${max_total_bytes} B  : ${skipped_total}"
  if [ "$copied" -eq 0 ]; then
    echo
    echo "No working directories survived. For an ordinary assertion failure that is"
    echo "EXPECTED — the suite deletes its own mkdtemp dir in a finally block. Read the"
    echo "JUnit report above. A surviving directory means the process died without"
    echo "unwinding (timeout kill, segfault, early exit)."
  fi
} >> "$manifest"

cat "$manifest"
exit 0
