#!/bin/sh
# cleetus installer. POSIX sh. Usage:
#   curl -fsSL https://raw.githubusercontent.com/commoncosmo/cleetus/main/install.sh | bash
#
# NOTE: `set -eu` is enabled inside main(), NOT at file scope, so that sourcing
# this file (the bats tests do) does not leak strict mode into the caller.

# Print an error to stderr and exit non-zero.
die() {
  printf '%s\n' "cleetus install: $*" >&2
  exit 1
}

# Echo the normalized OS slug (linux|darwin) or die.
detect_os() {
  case "$(uname -s)" in
    Linux) echo "linux" ;;
    Darwin) echo "darwin" ;;
    *) die "unsupported OS: $(uname -s) (cleetus supports Linux and macOS)" ;;
  esac
}

# Echo the normalized arch slug (x64|arm64) or die.
detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) echo "x64" ;;
    aarch64 | arm64) echo "arm64" ;;
    *) die "unsupported architecture: $(uname -m) (cleetus supports x86_64 and arm64)" ;;
  esac
}

# Echo the Release asset filename for an os/arch pair.
# Mirrors the asset names in scripts/targets.ts (guarded by a bats drift test).
asset_name() {
  echo "cleetus-$1-$2"
}

# Echo the Release download base URL (trailing slash). Honors CLEETUS_VERSION.
resolve_base_url() {
  releases="https://github.com/commoncosmo/cleetus/releases"
  if [ -n "${CLEETUS_VERSION:-}" ]; then
    _ver="${CLEETUS_VERSION#v}"
    echo "$releases/download/v${_ver}/"
  else
    echo "$releases/latest/download/"
  fi
}

# Download URL ($1) to destination path ($2). Prefer curl, fall back to wget.
download() {
  _url="$1"
  _dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$_dest" "$_url" || die "download failed: $_url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$_dest" "$_url" || die "download failed: $_url"
  else
    die "neither curl nor wget found; cannot download $_url"
  fi
}

# Echo the available SHA-256 command ("sha256sum" or "shasum -a 256"), or "" if none.
sha256_tool() {
  if command -v sha256sum >/dev/null 2>&1; then
    echo "sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    echo "shasum -a 256"
  else
    echo ""
  fi
}

# Verify file ($1) for asset ($2) against checksums.txt ($3).
# Mismatch or missing entry: die. No sha256 tool: die (fail closed) unless
# CLEETUS_SKIP_CHECKSUM=1, which restores the old warn-and-continue behavior.
verify_checksum() {
  _file="$1"
  _asset="$2"
  _checksums="$3"
  _tool="$(sha256_tool)"
  if [ -z "$_tool" ]; then
    if [ "${CLEETUS_SKIP_CHECKSUM:-}" = "1" ]; then
      printf '%s\n' "cleetus install: WARNING: no sha256 tool found; skipping checksum verification (CLEETUS_SKIP_CHECKSUM=1)" >&2
      return 0
    fi
    die "no sha256 tool found (need sha256sum or shasum) — install coreutils (e.g. 'apt install coreutils' or 'dnf install coreutils'; macOS ships shasum), or re-run with CLEETUS_SKIP_CHECKSUM=1 to skip verification"
  fi
  _expected="$(awk -v a="$_asset" '$2 == a {print $1}' "$_checksums")"
  if [ -z "$_expected" ]; then
    die "no checksum found for $_asset in checksums.txt"
  fi
  # shellcheck disable=SC2086  # intentional: $_tool may be "shasum -a 256"
  _actual="$($_tool "$_file" | awk '{print $1}')"
  if [ "$_actual" != "$_expected" ]; then
    die "checksum mismatch for $_asset: expected $_expected, got $_actual"
  fi
}

# Re-sign a copied Mach-O in place on macOS. Copying a signed executable can make
# taskgated reject it at launch even when static `codesign --verify` succeeds.
resign_macos_binary() {
  _dest="$1"
  _os="$2"
  [ "$_os" = "darwin" ] || return 0
  command -v codesign >/dev/null 2>&1 || die "codesign is required to install Cleetus on macOS"
  codesign --force --sign - "$_dest" || die "cannot re-sign installed binary: $_dest"
}

# Install src binary ($1) into dir ($2) as an executable `cleetus`. OS ($3) controls
# the macOS re-sign step. Echo the dest path.
install_binary() {
  _src="$1"
  _dir="$2"
  _os="$3"
  mkdir -p "$_dir" || die "cannot create install directory: $_dir"
  _dest="$_dir/cleetus"
  cp "$_src" "$_dest" || die "cannot copy binary to $_dest"
  chmod 755 "$_dest" || die "cannot make $_dest executable"
  resign_macos_binary "$_dest" "$_os"
  echo "$_dest"
}

# If dir ($1) is not a colon-separated entry in pathenv ($2), print PATH guidance.
check_path() {
  _dir="$1"
  _pathenv="$2"
  case ":$_pathenv:" in
    *":$_dir:"*) return 0 ;;
    *)
      printf '%s\n' "cleetus install: $_dir is not on your PATH. Add this to your shell profile:" >&2
      printf '%s\n' "  export PATH=\"$_dir:\$PATH\"" >&2
      ;;
  esac
}

main() {
  set -eu

  _os="$(detect_os)"
  _arch="$(detect_arch)"
  _asset="$(asset_name "$_os" "$_arch")"
  _base="$(resolve_base_url)"

  _tmp="$(mktemp -d)"
  trap 'rm -rf "$_tmp"' EXIT

  printf '%s\n' "cleetus install: downloading $_asset..." >&2
  download "${_base}${_asset}" "$_tmp/$_asset"
  download "${_base}checksums.txt" "$_tmp/checksums.txt"

  verify_checksum "$_tmp/$_asset" "$_asset" "$_tmp/checksums.txt"

  _dir="${CLEETUS_INSTALL_DIR:-$HOME/.local/bin}"
  _dest="$(install_binary "$_tmp/$_asset" "$_dir" "$_os")"
  printf '%s\n' "cleetus install: installed $_dest" >&2

  check_path "$_dir" "${PATH:-}"
  printf '%s\n' "cleetus install: done. Run 'cleetus --version' to verify." >&2
}

# Run main only when executed, not when sourced by the bats tests.
if [ "${CLEETUS_INSTALLER_TEST:-}" != "1" ]; then
  main "$@"
fi
