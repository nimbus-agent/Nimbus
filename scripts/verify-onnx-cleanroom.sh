#!/usr/bin/env bash
#
# Prove the embedded onnxruntime payload loads on a machine that has NOTHING of ours on it.
#
# This exists because the same bug was "fixed" twice and verified twice in environments that
# masked the failure:
#
#   1. #1399 was verified in the SOURCE TREE, which has `dist/bin/`. Users do not.
#   2. #1402 was verified on WINDOWS, which had `onnxruntime.dll` in System32. Users may not.
#
# Both passed. Neither worked. A test that cannot fail is worse than no test, because it is
# reported as evidence. So the rule here is that the run happens in a container with no repo, no
# node_modules, no bun and no system onnxruntime — the only thing mounted is the binary under test.
#
# Two stages, deliberately in different images:
#   build  oven/bun:1.3     repo mounted read-only; produces a standalone probe
#   run    debian:slim      nothing mounted but the probe
#
# Usage: bash scripts/verify-onnx-cleanroom.sh
# Exits non-zero if the addon does not load. Requires docker.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Docker needs host paths in the platform's own form. Under Git Bash/MSYS an absolute path like
# /tmp/xyz is not something the daemon can resolve, so translate both mounts when cygpath exists.
host_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}
REPO_M="$(host_path "$REPO")"
WORK_M="$(host_path "$WORK")"

cat > "$WORK/build.sh" <<'INNER'
set -euo pipefail
mkdir -p /work && cd /work
bun -e '
const { buildBindingModuleSource, readOnnxPayload } = await import("/repo/scripts/onnx-binding-plugin.ts");
require("node:fs").writeFileSync("/work/gen.cjs", buildBindingModuleSource(readOnnxPayload()));
'
cat > /work/probe.ts <<'TS'
const m = require("/work/gen.cjs") as { binding?: Record<string, unknown> };
const keys = Object.keys(m.binding ?? {});
if (keys.length === 0) throw new Error("binding loaded but exported nothing");
console.log("ONNX_OK " + keys.slice(0, 3).join(","));
TS
bun build /work/probe.ts --compile --outfile /host/probe
INNER

# Git Bash on Windows rewrites container-side absolute paths (/host -> C:/Program Files/Git/host),
# so path conversion is disabled for every docker invocation here.
export MSYS_NO_PATHCONV=1

echo "[cleanroom] building probe (repo mounted read-only)..."
docker run --rm -v "$REPO_M:/repo:ro" -v "$WORK_M:/host" oven/bun:1.3 bash /host/build.sh >/dev/null

echo "[cleanroom] running in a bare image with NOTHING of ours mounted..."
# `|| true` is load-bearing: under `set -e` a failing probe would kill this script before it could
# print WHY, and a harness that fails silently is the very thing this file exists to prevent.
OUT="$(docker run --rm -v "$WORK_M:/in:ro" debian:bookworm-slim bash -lc '
  cp /in/probe /probe && chmod +x /probe
  # Proves the image really is clean: if this is non-zero the result means nothing.
  echo "system-onnx-libs=$(ls /usr/lib/x86_64-linux-gnu/libonnxruntime* 2>/dev/null | wc -l)"
  /probe 2>&1
' 2>&1 || true)"

echo "$OUT" | sed 's/^/  /'

if ! grep -q "^system-onnx-libs=0$" <<<"$OUT"; then
  echo "[cleanroom] FAIL: the run image is not clean; a pass would prove nothing." >&2
  exit 1
fi
if ! grep -q "ONNX_OK" <<<"$OUT"; then
  echo "[cleanroom] FAIL: the embedded onnxruntime payload did not load." >&2
  exit 1
fi
echo "[cleanroom] PASS — addon and its runtime library load with nothing preinstalled."
