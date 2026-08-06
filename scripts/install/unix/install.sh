#!/bin/sh
# Nimbus installer for macOS + Linux (tarball or AppImage).
# Per-user, no sudo required.

set -eu

INSTALL_DIR="${HOME}/.local/bin"
BEGIN_MARKER="# >>> nimbus PATH >>>"
END_MARKER="# <<< nimbus PATH <<<"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ASSUME_YES=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [-y|--yes] [--dry-run]
  -y, --yes    Skip confirmation prompts
  --dry-run    Print planned actions and exit
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

# Locate binaries shipped beside this script.
NIMBUS_SRC="${SCRIPT_DIR}/nimbus"
GATEWAY_SRC="${SCRIPT_DIR}/nimbus-gateway"
if [ ! -x "$NIMBUS_SRC" ] || [ ! -x "$GATEWAY_SRC" ]; then
  # Fall back to bin/ subdir for tarball-style layouts.
  NIMBUS_SRC="${SCRIPT_DIR}/bin/nimbus"
  GATEWAY_SRC="${SCRIPT_DIR}/bin/nimbus-gateway"
fi
if [ ! -x "$NIMBUS_SRC" ] || [ ! -x "$GATEWAY_SRC" ]; then
  echo "Error: cannot locate 'nimbus' or 'nimbus-gateway' beside $0" >&2
  exit 1
fi

# Detect rc files to update — use positional parameters to preserve paths with spaces.
set --
[ -f "${HOME}/.zshrc" ] && set -- "$@" "${HOME}/.zshrc"
[ -f "${HOME}/.bash_profile" ] && set -- "$@" "${HOME}/.bash_profile"
[ -f "${HOME}/.bashrc" ] && set -- "$@" "${HOME}/.bashrc"
# If none exist, default to ~/.profile (POSIX-portable login shell file).
if [ "$#" -eq 0 ]; then
  set -- "${HOME}/.profile"
fi

cat <<EOF
About to install Nimbus:
  Binaries:  ${NIMBUS_SRC}, ${GATEWAY_SRC}
  → into:    ${INSTALL_DIR}/
  Update PATH in:
EOF
for rc in "$@"; do
  printf "    %s\n" "$rc"
done

if [ "$DRY_RUN" -eq 1 ]; then
  echo "(--dry-run; no changes made)"
  exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  printf "Continue? [y/N] "
  read -r answer
  case "$answer" in
    y|Y|yes) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

mkdir -p "$INSTALL_DIR"

# Idempotent overwrite.
if { [ -e "${INSTALL_DIR}/nimbus" ] || [ -e "${INSTALL_DIR}/nimbus-gateway" ]; } && [ "$ASSUME_YES" -ne 1 ]; then
  printf "Existing install detected at %s. Overwrite? [y/N] " "$INSTALL_DIR"
  read -r answer2
  case "$answer2" in
    y|Y|yes) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

cp "$NIMBUS_SRC" "${INSTALL_DIR}/nimbus"
cp "$GATEWAY_SRC" "${INSTALL_DIR}/nimbus-gateway"
chmod +x "${INSTALL_DIR}/nimbus" "${INSTALL_DIR}/nimbus-gateway"

# sqlite-vec loadable extension. The gateway looks for it beside its own executable, so it has to
# be installed into the same directory. Optional: absent on an unsupported platform, which
# disables semantic memory and nothing else.
for cand in "${SCRIPT_DIR}/vec0.so" "${SCRIPT_DIR}/vec0.dylib" \
            "${SCRIPT_DIR}/bin/vec0.so" "${SCRIPT_DIR}/bin/vec0.dylib"; do
  if [ -f "$cand" ]; then
    cp "$cand" "${INSTALL_DIR}/$(basename "$cand")"
    break
  fi
done

# Append marker block to rc files (idempotent — strip first if present).
BLOCK="${BEGIN_MARKER}
export PATH=\"${INSTALL_DIR}:\$PATH\"
${END_MARKER}"

for rc in "$@"; do
  # Create rc file if missing.
  [ -f "$rc" ] || touch "$rc"
  # Strip any pre-existing nimbus block.
  if grep -qF "$BEGIN_MARKER" "$rc" 2>/dev/null && grep -qF "$END_MARKER" "$rc" 2>/dev/null; then
    awk -v b="$BEGIN_MARKER" -v e="$END_MARKER" '
      $0==b {skip=1; next}
      skip && $0==e {skip=0; next}
      !skip {print}
    ' "$rc" > "${rc}.tmp.nimbus" && mv "${rc}.tmp.nimbus" "$rc"
  fi
  # Append fresh block.
  printf "\n%s\n" "$BLOCK" >> "$rc"
done

echo
echo "✓ Nimbus installed."
echo "  Open a new shell, then run: nimbus --version"
