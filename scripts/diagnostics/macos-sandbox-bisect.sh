#!/usr/bin/env bash
# Which read path does the macOS sandbox profile still need?
#
# Run this on ANY Mac. It takes about ten seconds and needs nothing from this repo but bun.
#
#   bash scripts/diagnostics/macos-sandbox-bisect.sh
#
# Why it exists: `sandbox-exec` is a macOS kernel feature, so the profile cannot be exercised on
# Windows or Linux, in Docker, or in CI any faster than one push per question. Three kernel-side
# ways of asking WHAT was denied have already failed on macos-15 — a plain `(deny default)` logs
# nothing, `(trace "<file>")` writes no file on modern macOS, and `(deny default (with report))` is
# rejected at compile time ("report modifier does not apply to deny action"). So this asks the
# profile what it is missing instead: same profile, one extra rule at a time, report which flip it.
#
# CI has narrowed it this far already:
#   round 1 — only `(allow file-read* (subpath "/"))` fixes it; write/ioctl/mach/shm/sysctl/
#             process/system all change nothing. It is a file READ.
#   round 2 — none of cwd-parent, temp root, HOME, /dev, /private/var, /usr, /Library, /opt fix it.
# So the needed path is something `(subpath "/")` covers and none of those do.
set -uo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This only runs on macOS — sandbox-exec is a macOS kernel feature." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/work"
CWD="$(cd "$WORK/work" && pwd -P)"          # -P: /var is a symlink to /private/var
BUN="$(command -v bun)"
[[ -n "$BUN" ]] || { echo "bun not on PATH" >&2; exit 1; }
BUN_BIN="$(cd "$(dirname "$BUN")" && pwd -P)"
BUN_HOME="$(dirname "$BUN_BIN")"
printf 'process.stdout.write("ok")' > "$CWD/hello.js"

# The profile as `generateSbplProfile` builds it today (packages/gateway/src/platform/sandbox/
# darwin.ts). Keep these in sync by hand; this file is a diagnostic, not a second source of truth.
base_profile() {
  cat <<EOF
(version 1)
(deny default)
(allow process-fork process-exec)
(allow signal (target self))
(allow mach-lookup)
(allow iokit-open)
(allow file-read-metadata)
(allow sysctl-read)
(allow process-info* (target self))
(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))
(allow file-write-data (literal "/dev/null"))
(allow file-read*
  (subpath "$CWD")
  (subpath "/usr/lib")
  (subpath "/usr/bin")
  (subpath "/System")
  (subpath "/private/etc")
  (subpath "/bin")
  (subpath "/private/var/db/dyld")
  (subpath "/usr/share")
  (subpath "$BUN_BIN")
  (subpath "$BUN_HOME")
)
(allow file-write*
  (subpath "$CWD")
)
EOF
}

try() {
  local label="$1" rule="$2" prof="$WORK/p.sb"
  { base_profile; [[ -n "$rule" ]] && printf '%s\n' "$rule"; } > "$prof"
  local out status
  out="$(cd "$CWD" && TMPDIR="$CWD" /usr/bin/sandbox-exec -f "$prof" "$BUN" "$CWD/hello.js" 2>&1)"
  status=$?
  if [[ $status -eq 0 && "$out" == "ok" ]]; then
    printf '  FIXES IT   %-46s %s\n' "$label" "$rule"
  else
    printf '  no change  %-46s (exit %s)\n' "$label" "$status"
  fi
}

echo "baseline — the profile exactly as it ships:"
try "(no extra rule)" ""
echo
echo "sanity — the diagnostic that CI says works:"
try "read anywhere" '(allow file-read* (subpath "/"))'
echo
echo "candidates `(subpath \"/\")` covers that round 2 did not test:"
try "/private (all of it)"        '(allow file-read* (subpath "/private"))'
try "/private/tmp"                '(allow file-read* (subpath "/private/tmp"))'
try "/sbin"                       '(allow file-read* (subpath "/sbin"))'
try "/Applications"               '(allow file-read* (subpath "/Applications"))'
try "/Volumes"                    '(allow file-read* (subpath "/Volumes"))'
try "/System/Volumes/Data"        '(allow file-read* (subpath "/System/Volumes/Data"))'
try "/cores"                      '(allow file-read* (subpath "/cores"))'
try "the root directory itself"   '(allow file-read* (literal "/"))'
try "/Users (all users)"          '(allow file-read* (subpath "/Users"))'
echo
echo "Report the FIXES IT line. The fix is the narrowest rule that flips it —"
echo "never (subpath \"/\"), which is only the diagnostic."
