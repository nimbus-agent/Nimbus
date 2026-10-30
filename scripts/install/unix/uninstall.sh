#!/bin/sh
# Nimbus uninstaller for macOS + Linux.
set -eu

INSTALL_DIR="${HOME}/.local/bin"
BEGIN_MARKER="# >>> nimbus PATH >>>"
END_MARKER="# <<< nimbus PATH <<<"
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

cat <<EOF
About to uninstall Nimbus:
  Remove: ${INSTALL_DIR}/nimbus
  Remove: ${INSTALL_DIR}/nimbus-gateway
  Strip nimbus PATH block from: ~/.zshrc, ~/.bash_profile, ~/.bashrc, ~/.profile (if present)
EOF

if [ "$ASSUME_YES" -ne 1 ]; then
  printf "Continue? [y/N] "
  read -r answer
  case "$answer" in
    y|Y|yes) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

rm -f "${INSTALL_DIR}/nimbus" "${INSTALL_DIR}/nimbus-gateway"

for rc in "${HOME}/.zshrc" "${HOME}/.bash_profile" "${HOME}/.bashrc" "${HOME}/.profile"; do
  [ -f "$rc" ] || continue
  if grep -qF "$BEGIN_MARKER" "$rc" 2>/dev/null && grep -qF "$END_MARKER" "$rc" 2>/dev/null; then
    awk -v b="$BEGIN_MARKER" -v e="$END_MARKER" '
      $0==b {skip=1; next}
      skip && $0==e {skip=0; next}
      !skip {print}
    ' "$rc" > "${rc}.tmp.nimbus" && mv "${rc}.tmp.nimbus" "$rc"
  fi
done

echo "✓ Nimbus uninstalled."

# linux-postinstall.sh may have installed this machine-wide with sudo. This script does not use
# sudo, so it says how rather than leaving the profile behind unmentioned.
if [ -e /etc/apparmor.d/nimbus-bwrap ]; then
  echo "To also remove the AppArmor profile for bubblewrap:"
  echo "  sudo apparmor_parser -R /etc/apparmor.d/nimbus-bwrap && sudo rm /etc/apparmor.d/nimbus-bwrap"
fi
