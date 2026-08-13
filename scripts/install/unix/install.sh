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

MODE="auto"
WANT_VERSION=""
FETCHED=0

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --local) MODE="local"; shift ;;
    --from-release)
      MODE="remote"
      # A following token that looks like another flag (or is absent) means
      # "latest" — don't swallow e.g. the --yes in `--from-release --yes`.
      case "${2:-}" in
        ""|-*) shift ;;
        *) WANT_VERSION="$2"; shift 2 ;;
      esac
      ;;
    --from-release=*)
      MODE="remote"
      WANT_VERSION="${1#*=}"
      shift
      ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [-y|--yes] [--dry-run] [--local] [--from-release [<ver>]]
  -y, --yes              Skip confirmation prompts
  --dry-run              Print planned actions and exit
  --local                Require binaries staged beside this script (no network)
  --from-release [<ver>] Download a release tarball (latest, or a specific version)
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

REPO="nimbus-agent/Nimbus"
BASE_URL="${NIMBUS_INSTALL_BASE_URL:-}"   # testing seam; unset in real use
DOWNLOAD_DIR=""

# A temp dir must not survive a failed or interrupted install. The path is
# guarded before removal: an unset variable would make this `rm -rf ""`, which
# is harmless today but is one edit away from not being.
#
# GNUPGHOME is deliberately NOT cleaned up here. It is an inherited
# environment variable this script never sets — `export GNUPGHOME=...` is a
# common, documented way to point gpg at a real keyring — so removing it here
# would delete a directory this script does not own. Task 5 (signature
# verification) must clean up a SCRIPT-OWNED variable it sets itself (e.g. a
# dedicated SIG_TMPDIR created via mktemp -d), never an inherited one.
cleanup() {
  [ -n "${DOWNLOAD_DIR:-}" ] && [ -d "${DOWNLOAD_DIR:-}" ] && rm -rf "$DOWNLOAD_DIR"
  return 0
}
trap cleanup EXIT INT TERM

# Signature verification is added in a later task. For now these are working
# stubs: they print the skip notice and always succeed, so remote installs are
# not blocked on a check that does not exist yet.
skip_signature_notice() {
  echo "SIGNATURE NOT CHECKED — publisher verification is not implemented yet." >&2
}

verify_signature() {
  skip_signature_notice
  return 0
}

# Under `curl … | sh`, stdin IS the script — a bare `read -r` would consume
# script text instead of a real answer. Read from the controlling terminal
# when one exists; otherwise refuse to prompt and require --yes.
#
# [ -r /dev/tty ] is NOT a controlling-terminal test: the device node exists
# and reads as readable under cron, systemd, and `docker run` without -t —
# it's the OPEN that fails there (ENXIO), not the readability check. A real
# open attempt is required instead — but NOT via `exec`: per POSIX, a
# redirection failure on the `exec` special builtin terminates the whole
# (non-interactive) shell unconditionally, even inside `if`/`{ }` — dash
# does this in practice, verified: `exec 3<>/dev/tty` with no controlling
# terminal kills the entire script before the intended fallback ever runs.
# A plain `printf … > /dev/tty` is an ordinary simple command, so its
# redirection failure is just that command's exit status — safe to test in
# an `if`, even under `set -e`, because it sits in a tested position.
prompt_yes_no() {
  # $1 = prompt text. Returns 0 for yes.
  if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
  reply=""
  if printf '%s' "$1" 2>/dev/null > /dev/tty; then
    read -r reply < /dev/tty 2>/dev/null || reply=""
  elif [ -t 0 ]; then
    printf '%s' "$1"
    read -r reply || reply=""
  else
    echo "Refusing to prompt with no terminal — re-run with --yes." >&2
    exit 1
  fi
  case "$reply" in y|Y|yes) return 0 ;; *) return 1 ;; esac
}

resolve_latest_tag() {
  # Follow the /releases/latest redirect. No GitHub API: unauthenticated it is
  # 60 req/hour per IP, shared across CI runners.
  effective="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/${REPO}/releases/latest")" || return 1
  printf '%s\n' "${effective##*/}"
}

detect_asset() {
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in
    Linux)
      case "$arch" in
        x86_64|amd64) printf 'nimbus-headless-linux-amd64-v%s.tar.gz\n' "$1" ;;
        *) echo "Error: no Linux $arch build is published — build from source, or use x64 emulation" >&2; return 1 ;;
      esac ;;
    Darwin)
      case "$arch" in
        arm64) echo "nimbus-headless-macos-arm64.tar.gz" ;;
        x86_64) echo "nimbus-headless-macos-x64.tar.gz" ;;
        *) echo "Error: no macOS $arch build is published" >&2; return 1 ;;
      esac ;;
    *) echo "Error: unsupported OS: $os" >&2; return 1 ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else echo "Error: neither sha256sum nor shasum found; cannot verify download" >&2; return 1
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Error: '$1' is required to download a release. Install it, or download the tarball manually and run install.sh from inside it." >&2
    exit 1
  }
}

fetch_release() {
  FETCHED=1
  require_cmd curl
  require_cmd tar
  version="$1"
  if [ -z "$version" ]; then
    # Resolution is the one network step with no fallback, so its failure message
    # must name the escape hatch: --from-release skips resolution entirely, which
    # is what a proxied or policy-restricted machine needs.
    if ! tag="$(resolve_latest_tag)"; then
      echo "Error: could not resolve the latest release tag (network, proxy or firewall)." >&2
      echo "  Re-run with an explicit version to skip resolution:" >&2
      echo "    --from-release 2.2.0" >&2
      exit 1
    fi
    version="${tag#v}"
  else
    tag="v${version#v}"; version="${tag#v}"
  fi
  asset="$(detect_asset "$version")" || exit 1
  base="${BASE_URL:-https://github.com/${REPO}/releases/download/${tag}}"

  DOWNLOAD_DIR="$(mktemp -d)"
  echo "Downloading ${asset} (${tag})…"
  curl -fsSL "${base}/${asset}"     -o "${DOWNLOAD_DIR}/${asset}"   || { echo "Error: download failed" >&2; exit 1; }
  curl -fsSL "${base}/SHA256SUMS"   -o "${DOWNLOAD_DIR}/SHA256SUMS" || { echo "Error: could not fetch SHA256SUMS" >&2; exit 1; }

  # awk, not grep: $asset is interpolated as a literal field match here, never
  # as a regex — the asset name has five literal dots that a BRE would treat
  # as "any character", letting an unrelated line satisfy the match.
  expected="$(awk -v a="$asset" '$2 == a { print $1; exit }' "${DOWNLOAD_DIR}/SHA256SUMS")"
  actual="$(sha256_of "${DOWNLOAD_DIR}/${asset}")" || exit 1
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "Error: sha256 checksum mismatch for ${asset} — refusing to install." >&2
    rm -rf "$DOWNLOAD_DIR"; exit 1
  fi
  echo "✓ sha256 verified."

  verify_signature "${DOWNLOAD_DIR}" "${base}"

  case "$asset" in
    *.tar.gz) tar -xzf "${DOWNLOAD_DIR}/${asset}" -C "${DOWNLOAD_DIR}" ;;
    *) echo "Error: unexpected archive type: $asset" >&2; exit 1 ;;
  esac
  SCRIPT_DIR="$DOWNLOAD_DIR"
}

# Locate binaries shipped beside this script.
NIMBUS_SRC="${SCRIPT_DIR}/nimbus"
GATEWAY_SRC="${SCRIPT_DIR}/nimbus-gateway"
if [ ! -x "$NIMBUS_SRC" ] || [ ! -x "$GATEWAY_SRC" ]; then
  # Fall back to bin/ subdir for tarball-style layouts.
  NIMBUS_SRC="${SCRIPT_DIR}/bin/nimbus"
  GATEWAY_SRC="${SCRIPT_DIR}/bin/nimbus-gateway"
fi

NEED_FETCH=0
if { [ ! -x "$NIMBUS_SRC" ] || [ ! -x "$GATEWAY_SRC" ]; } && [ "$MODE" != "local" ]; then
  NEED_FETCH=1
fi

# --dry-run must "print planned actions and exit" — touching nothing,
# including the network. Handle the remote-fetch case here, before
# fetch_release (which downloads, verifies, and extracts) ever runs.
if [ "$DRY_RUN" -eq 1 ] && [ "$NEED_FETCH" -eq 1 ]; then
  echo "About to install Nimbus (dry run):"
  if [ -n "$WANT_VERSION" ]; then
    tag="v${WANT_VERSION#v}"
    asset="$(detect_asset "${tag#v}")" || exit 1
    base="${BASE_URL:-https://github.com/${REPO}/releases/download/${tag}}"
    echo "  Would download:  ${base}/${asset}"
    echo "  Would verify against: ${base}/SHA256SUMS"
  else
    echo "  Would resolve the latest release tag from https://github.com/${REPO}/releases/latest,"
    echo "  then download and sha256-verify the matching release asset."
  fi
  echo "(--dry-run; no changes made, no network request performed)"
  exit 0
fi

if [ "$NEED_FETCH" -eq 1 ]; then
  fetch_release "$WANT_VERSION"
  NIMBUS_SRC="${SCRIPT_DIR}/nimbus"; GATEWAY_SRC="${SCRIPT_DIR}/nimbus-gateway"
  if [ ! -x "$NIMBUS_SRC" ] || [ ! -x "$GATEWAY_SRC" ]; then
    NIMBUS_SRC="${SCRIPT_DIR}/bin/nimbus"; GATEWAY_SRC="${SCRIPT_DIR}/bin/nimbus-gateway"
  fi
fi
if [ ! -x "$NIMBUS_SRC" ] || [ ! -x "$GATEWAY_SRC" ]; then
  echo "Error: cannot locate 'nimbus' or 'nimbus-gateway' beside $0, and no release could be fetched" >&2
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

if ! prompt_yes_no "Continue? [y/N] "; then
  echo "Aborted."
  exit 1
fi

mkdir -p "$INSTALL_DIR"

# Idempotent overwrite.
if [ -e "${INSTALL_DIR}/nimbus" ] || [ -e "${INSTALL_DIR}/nimbus-gateway" ]; then
  if ! prompt_yes_no "Existing install detected at ${INSTALL_DIR}. Overwrite? [y/N] "; then
    echo "Aborted."
    exit 1
  fi
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

# Linux: the Gateway refuses to spawn extensions without bubblewrap. Warn now
# rather than let the first run fail with a sandbox error.
if [ "$(uname -s)" = "Linux" ] && ! command -v bwrap >/dev/null 2>&1; then
  cat <<EOF

WARNING: bubblewrap (bwrap) was not found. Nimbus will not start without it.
  Debian/Ubuntu: sudo apt install bubblewrap
  Fedora/RHEL:   sudo dnf install bubblewrap
  Arch:          sudo pacman -S bubblewrap
EOF
fi

# Remote mode's extracted tree also carries linux-postinstall.sh (sandbox-helper
# setcap + the same bubblewrap check). The cleanup trap deletes that tree on
# exit, so preserve a copy in the install dir. Never run it automatically —
# a curl | sh installer must not chain into another script, let alone sudo.
if [ "$FETCHED" -eq 1 ] && [ -f "${SCRIPT_DIR}/linux-postinstall.sh" ]; then
  cp "${SCRIPT_DIR}/linux-postinstall.sh" "${INSTALL_DIR}/linux-postinstall.sh"
  chmod +x "${INSTALL_DIR}/linux-postinstall.sh"
  echo
  echo "  Optional sandbox-helper setup: ${INSTALL_DIR}/linux-postinstall.sh"
fi
