#!/usr/bin/env bash
# scripts/package-macos-installer.sh — build a user-scoped Nimbus .pkg (no sudo).
# Usage: package-macos-installer.sh --bin-dir <dir> --version <v> --out <path.pkg>
set -euo pipefail

BIN_DIR="" VERSION="" OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) echo "Usage: $0 --bin-dir <dir> --version <v> --out <path.pkg>"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$BIN_DIR" ] && [ -n "$VERSION" ] && [ -n "$OUT" ] || { echo "missing required arg" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PV="$(printf '%s' "$VERSION" | sed -E 's/^v//; s/-.*$//')"
case "$PV" in *.*.*) ;; *) echo "invalid pkg version '$VERSION' -> '$PV'" >&2; exit 2 ;; esac

for b in nimbus nimbus-gateway; do
  [ -f "${BIN_DIR}/${b}" ] || { echo "missing ${b} in ${BIN_DIR}" >&2; exit 2; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ROOT="${WORK}/root"          # payload, installed relative to ~ (install-location .local)
SCRIPTS="${WORK}/scripts"
mkdir -p "${ROOT}/nimbus/bin" "${ROOT}/bin" "$SCRIPTS"

# Real binaries -> ~/.local/nimbus/bin
install -m 0755 "${BIN_DIR}/nimbus"         "${ROOT}/nimbus/bin/nimbus"
install -m 0755 "${BIN_DIR}/nimbus-gateway" "${ROOT}/nimbus/bin/nimbus-gateway"

# sqlite-vec loadable extension, next to the gateway binary because tryLoadFromSidecar()
# resolves it from dirname(process.execPath). Optional: on a platform where bun install
# skipped the binary, semantic memory is disabled but everything else works.
if [ -f "${BIN_DIR}/vec0.dylib" ]; then
  install -m 0644 "${BIN_DIR}/vec0.dylib" "${ROOT}/nimbus/bin/vec0.dylib"
fi

# Channel-marked wrappers -> ~/.local/bin
for t in nimbus nimbus-gateway; do
  cat > "${ROOT}/bin/${t}" <<EOF
#!/bin/sh
export NIMBUS_DISTRIBUTION_CHANNEL=pkg
export NIMBUS_UPDATER_DISABLE=1
exec "\${HOME}/.local/nimbus/bin/${t}" "\$@"
EOF
  chmod 0755 "${ROOT}/bin/${t}"
done
install -m 0755 "${SCRIPT_DIR}/macos/uninstall-nimbus.sh" "${ROOT}/bin/uninstall-nimbus"

# postinstall: add ~/.local/bin to PATH using the same marker block as install.sh.
cat > "${SCRIPTS}/postinstall" <<'EOF'
#!/bin/sh
set -eu
INSTALL_DIR="${HOME}/.local/bin"
BEGIN_MARKER="# >>> nimbus PATH >>>"
END_MARKER="# <<< nimbus PATH <<<"
BLOCK="${BEGIN_MARKER}
export PATH=\"${INSTALL_DIR}:\$PATH\"
${END_MARKER}"
set --
[ -f "${HOME}/.zshrc" ] && set -- "$@" "${HOME}/.zshrc"
[ -f "${HOME}/.bash_profile" ] && set -- "$@" "${HOME}/.bash_profile"
[ -f "${HOME}/.bashrc" ] && set -- "$@" "${HOME}/.bashrc"
[ "$#" -eq 0 ] && set -- "${HOME}/.profile"
for rc in "$@"; do
  [ -f "$rc" ] || touch "$rc"
  if grep -qF "$BEGIN_MARKER" "$rc" 2>/dev/null && grep -qF "$END_MARKER" "$rc" 2>/dev/null; then
    awk -v b="$BEGIN_MARKER" -v e="$END_MARKER" '$0==b{skip=1;next} skip&&$0==e{skip=0;next} !skip{print}' "$rc" > "${rc}.tmp.nimbus" && mv "${rc}.tmp.nimbus" "$rc"
  fi
  printf "\n%s\n" "$BLOCK" >> "$rc"
done
exit 0
EOF
chmod 0755 "${SCRIPTS}/postinstall"

mkdir -p "$(dirname "$OUT")"
COMPONENT="${WORK}/nimbus-component.pkg"
pkgbuild --root "$ROOT" --install-location ".local" --scripts "$SCRIPTS" \
  --identifier "dev.nimbus.headless" --version "$PV" "$COMPONENT"

# The component pkg already sits at ${WORK}/nimbus-component.pkg, the name the
# distribution's <pkg-ref> references; productbuild finds it via --package-path.
productbuild --distribution "${SCRIPT_DIR}/macos/distribution.xml" \
  --package-path "$WORK" "$OUT"

echo "✓ Built $OUT (version $PV)"
