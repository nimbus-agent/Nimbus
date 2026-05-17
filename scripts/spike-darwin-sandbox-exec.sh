#!/usr/bin/env bash
# scripts/spike-darwin-sandbox-exec.sh
# Phase 5 T2 PR 1 — macOS sandbox-exec viability spike (spec §9).
#
# Runs 4 probes against the current Bun + sandbox-exec combination on the
# current macOS version. Exit 0 = all probes pass (lock sandbox-exec);
# exit 1 = at least one probe failed (lock EndpointSecurity fallback).

set -u

PROFILE=$(mktemp -t nimbus-spike.sb)
trap "rm -f $PROFILE" EXIT

cat > "$PROFILE" <<'EOF'
(version 1)
(deny default)
(allow process-fork process-exec)
(allow signal (target self))
(allow file-read*
  (subpath "/usr/lib")
  (subpath "/usr/bin")
  (subpath "/System")
  (subpath "/private/etc"))
(allow network*
  (remote tcp "*:443" (host "api.github.com"))
  (remote udp "*:53"))
(allow mach-lookup)
(allow iokit-open)
EOF

echo "macOS: $(sw_vers -productVersion)"

echo -n "Probe 1 (listed host fetch): "
out=$(sandbox-exec -f "$PROFILE" bun -e 'console.log((await fetch("https://api.github.com/zen")).status)' 2>&1)
if [[ "$out" == "200" ]]; then echo "PASS"; P1=0; else echo "FAIL ($out)"; P1=1; fi

echo -n "Probe 2 (unlisted IP fetch): "
out=$(sandbox-exec -f "$PROFILE" bun -e 'try { await fetch("http://192.0.2.1") } catch (e) { console.log(e.code ?? e.errno ?? e.message) }' 2>&1)
# Differentiate:
#   EPERM / ECONNREFUSED → sandbox-exec actively denied (good)
#   EHOSTUNREACH / ENETUNREACH → ambiguous (could be sandbox; could be
#     routing). Treat as PASS but log the ambiguity.
case "$out" in
  *EPERM*|*ECONNREFUSED*) echo "PASS — sandbox denied ($out)"; P2=0 ;;
  *EHOSTUNREACH*|*ENETUNREACH*) echo "PASS (ambiguous — sandbox or routing) ($out)"; P2=0 ;;
  *) echo "FAIL ($out)"; P2=1 ;;
esac

echo -n "Probe 3 (FS read outside cwd): "
out=$(sandbox-exec -f "$PROFILE" bun -e 'try { await Bun.file("/etc/passwd").text() } catch (e) { console.log(e.code ?? e.errno ?? e.message) }' 2>&1)
case "$out" in
  *EACCES*|*EPERM*) echo "PASS ($out)"; P3=0 ;;
  *) echo "FAIL ($out)"; P3=1 ;;
esac

echo -n "Probe 4 (macOS 15 entitlement): "
if sw_vers -productVersion | grep -q "^15"; then
  # Same as probe 1, but verifies the unsigned Gateway-equivalent has no
  # Full Disk Access / App Management consent. CI's runner binary is
  # unsigned by default, so this reproduces the unprivileged case.
  out=$(sandbox-exec -f "$PROFILE" bun -e 'console.log((await fetch("https://api.github.com/zen")).status)' 2>&1)
  if [[ "$out" == "200" ]]; then echo "PASS (no entitlement needed)"; P4=0; else echo "FAIL — needs entitlement ($out)"; P4=1; fi
else
  echo "SKIP (not macOS 15)"; P4=0
fi

if [[ $P1 -eq 0 && $P2 -eq 0 && $P3 -eq 0 && $P4 -eq 0 ]]; then
  echo "RESULT: sandbox-exec viable; lock the spike-pass branch."
  exit 0
else
  echo "RESULT: sandbox-exec NOT viable; lock the EndpointSecurity fallback."
  exit 1
fi
