#!/bin/sh
# scripts/macos/uninstall-nimbus.sh — installed to ~/.local/bin/uninstall-nimbus.
# Removes Nimbus binaries, wrappers, PATH markers, and the pkg receipt. No sudo.
set -eu

INSTALL_DIR="${HOME}/.local/bin"
LIB_DIR="${HOME}/.local/nimbus"
BEGIN_MARKER="# >>> nimbus PATH >>>"
END_MARKER="# <<< nimbus PATH <<<"

rm -f "${INSTALL_DIR}/nimbus" "${INSTALL_DIR}/nimbus-gateway" "${INSTALL_DIR}/uninstall-nimbus"
rm -rf "${LIB_DIR}"

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

# Forget the pkg receipt (user domain) so a reinstall is clean.
pkgutil --forget dev.nimbus.headless >/dev/null 2>&1 || true

echo "✓ Nimbus uninstalled."
