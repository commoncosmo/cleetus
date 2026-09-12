#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  export CLEETUS_INSTALLER_TEST=1
  # shellcheck source=/dev/null
  source "$REPO_ROOT/install.sh"
  STUB_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$STUB_DIR"
}

@test "sourcing install.sh defines die and does not run main" {
  run type die
  [ "$status" -eq 0 ]
}

@test "die prints to stderr and exits 1" {
  run die "boom"
  [ "$status" -eq 1 ]
  [[ "$output" == *"cleetus install: boom"* ]]
}

# Write a stub `uname` into STUB_DIR that echoes $MOCK_UNAME_S / $MOCK_UNAME_M.
_stub_uname() {
  cat > "$STUB_DIR/uname" <<'EOF'
#!/bin/sh
case "$1" in
  -s) printf '%s\n' "$MOCK_UNAME_S" ;;
  -m) printf '%s\n' "$MOCK_UNAME_M" ;;
esac
EOF
  chmod +x "$STUB_DIR/uname"
}

@test "detect_os maps Linux to linux" {
  _stub_uname
  MOCK_UNAME_S=Linux run env PATH="$STUB_DIR:$PATH" bash -c \
    "source '$REPO_ROOT/install.sh'; detect_os"
  [ "$status" -eq 0 ]
  [ "$output" = "linux" ]
}

@test "detect_os maps Darwin to darwin" {
  _stub_uname
  MOCK_UNAME_S=Darwin run env PATH="$STUB_DIR:$PATH" bash -c \
    "source '$REPO_ROOT/install.sh'; detect_os"
  [ "$status" -eq 0 ]
  [ "$output" = "darwin" ]
}

@test "detect_os dies on unsupported OS" {
  _stub_uname
  MOCK_UNAME_S=Plan9 run env PATH="$STUB_DIR:$PATH" bash -c \
    "source '$REPO_ROOT/install.sh'; detect_os"
  [ "$status" -eq 1 ]
  [[ "$output" == *"unsupported OS"* ]]
}

@test "detect_arch maps x86_64 and amd64 to x64" {
  _stub_uname
  MOCK_UNAME_M=x86_64 run env PATH="$STUB_DIR:$PATH" bash -c \
    "source '$REPO_ROOT/install.sh'; detect_arch"
  [ "$status" -eq 0 ]
  [ "$output" = "x64" ]
  MOCK_UNAME_M=amd64 run env PATH="$STUB_DIR:$PATH" bash -c \
    "source '$REPO_ROOT/install.sh'; detect_arch"
  [ "$status" -eq 0 ]
  [ "$output" = "x64" ]
}

@test "detect_arch maps aarch64 and arm64 to arm64" {
  _stub_uname
  MOCK_UNAME_M=aarch64 run env PATH="$STUB_DIR:$PATH" bash -c \
    "source '$REPO_ROOT/install.sh'; detect_arch"
  [ "$status" -eq 0 ]
  [ "$output" = "arm64" ]
  MOCK_UNAME_M=arm64 run env PATH="$STUB_DIR:$PATH" bash -c \
    "source '$REPO_ROOT/install.sh'; detect_arch"
  [ "$status" -eq 0 ]
  [ "$output" = "arm64" ]
}

@test "detect_arch dies on unsupported arch" {
  _stub_uname
  MOCK_UNAME_M=mips run env PATH="$STUB_DIR:$PATH" bash -c \
    "source '$REPO_ROOT/install.sh'; detect_arch"
  [ "$status" -eq 1 ]
  [[ "$output" == *"unsupported architecture"* ]]
}

@test "asset_name composes cleetus-<os>-<arch>" {
  run asset_name linux x64
  [ "$output" = "cleetus-linux-x64" ]
  run asset_name darwin arm64
  [ "$output" = "cleetus-darwin-arm64" ]
}

@test "asset_name outputs stay in sync with scripts/targets.ts" {
  for combo in "linux x64" "linux arm64" "darwin arm64" "darwin x64"; do
    # shellcheck disable=SC2086
    set -- $combo
    name="$(asset_name "$1" "$2")"
    grep -q "\"$name\"" "$REPO_ROOT/scripts/targets.ts" \
      || { echo "asset $name missing from scripts/targets.ts"; false; }
  done
}

@test "resolve_base_url defaults to latest" {
  unset CLEETUS_VERSION
  run resolve_base_url
  [ "$output" = "https://github.com/commoncosmo/cleetus/releases/latest/download/" ]
}

@test "resolve_base_url pins to a tag when CLEETUS_VERSION is set" {
  CLEETUS_VERSION=0.1.1 run resolve_base_url
  [ "$output" = "https://github.com/commoncosmo/cleetus/releases/download/v0.1.1/" ]
}

@test "resolve_base_url tolerates a leading v in CLEETUS_VERSION" {
  CLEETUS_VERSION=v0.1.1 run resolve_base_url
  [ "$output" = "https://github.com/commoncosmo/cleetus/releases/download/v0.1.1/" ]
}

# Write a stub named $1 into STUB_DIR that creates its output file and logs a marker.
# Also ensures a bash symlink exists in STUB_DIR so that `env PATH="$STUB_DIR" bash`
# works on macOS (where /bin/bash is not in a restricted PATH).
_stub_downloader() {
  cat > "$STUB_DIR/$1" <<EOF
#!/bin/sh
# Last arg is the URL; the path after -o/-O is the destination.
dest=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -o|-O) dest="\$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "$1" > "\$dest"
EOF
  chmod +x "$STUB_DIR/$1"
  # Ensure bash is reachable when PATH is restricted to STUB_DIR.
  ln -sf "$(command -v bash)" "$STUB_DIR/bash" 2>/dev/null || true
}

@test "download prefers curl" {
  _stub_downloader curl
  _stub_downloader wget
  run env PATH="$STUB_DIR:$PATH" bash -c \
    "source '$REPO_ROOT/install.sh'; download http://x/file '$STUB_DIR/out'"
  [ "$status" -eq 0 ]
  [ "$(cat "$STUB_DIR/out")" = "curl" ]
}

@test "download falls back to wget when curl is absent" {
  _stub_downloader wget
  # PATH has only STUB_DIR (no curl), so curl is not found.
  run env PATH="$STUB_DIR" bash -c \
    "source '$REPO_ROOT/install.sh'; download http://x/file '$STUB_DIR/out'"
  [ "$status" -eq 0 ]
  [ "$(cat "$STUB_DIR/out")" = "wget" ]
}

@test "download dies when neither curl nor wget exists" {
  # Ensure bash is reachable when PATH is restricted to STUB_DIR.
  ln -sf "$(command -v bash)" "$STUB_DIR/bash"
  run env PATH="$STUB_DIR" bash -c \
    "source '$REPO_ROOT/install.sh'; download http://x/file '$STUB_DIR/out'"
  [ "$status" -eq 1 ]
  [[ "$output" == *"neither curl nor wget"* ]]
}

# Create a fixture binary + a checksums.txt; echo the asset name.
_make_fixture() {
  printf 'fake-binary-bytes\n' > "$STUB_DIR/cleetus-darwin-arm64"
  hash="$(shasum -a 256 "$STUB_DIR/cleetus-darwin-arm64" | awk '{print $1}')"
  printf '%s  %s\n' "$hash" "cleetus-darwin-arm64" > "$STUB_DIR/checksums.txt"
  echo "cleetus-darwin-arm64"
}

@test "verify_checksum passes when the hash matches" {
  asset="$(_make_fixture)"
  run verify_checksum "$STUB_DIR/$asset" "$asset" "$STUB_DIR/checksums.txt"
  [ "$status" -eq 0 ]
}

@test "verify_checksum dies on a hash mismatch" {
  asset="$(_make_fixture)"
  # Corrupt checksums.txt with a wrong hash.
  printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" \
    "$asset" > "$STUB_DIR/checksums.txt"
  run verify_checksum "$STUB_DIR/$asset" "$asset" "$STUB_DIR/checksums.txt"
  [ "$status" -eq 1 ]
  [[ "$output" == *"checksum mismatch"* ]]
}

@test "verify_checksum dies when the asset is absent from checksums.txt" {
  asset="$(_make_fixture)"
  printf '%s  %s\n' "deadbeef" "some-other-file" > "$STUB_DIR/checksums.txt"
  run verify_checksum "$STUB_DIR/$asset" "$asset" "$STUB_DIR/checksums.txt"
  [ "$status" -eq 1 ]
  [[ "$output" == *"no checksum found"* ]]
}

@test "verify_checksum dies when no sha256 tool is present (fail closed)" {
  asset="$(_make_fixture)"
  # Override the tool-detection helper to report no tool.
  sha256_tool() { echo ""; }
  run verify_checksum "$STUB_DIR/$asset" "$asset" "$STUB_DIR/checksums.txt"
  [ "$status" -eq 1 ]
  [[ "$output" == *"no sha256 tool"* ]]
  [[ "$output" == *"coreutils"* ]]
  [[ "$output" == *"CLEETUS_SKIP_CHECKSUM=1"* ]]
}

@test "install_binary copies to <dir>/cleetus, executable, and echoes the path" {
  printf 'binary\n' > "$STUB_DIR/src"
  dest_dir="$STUB_DIR/bin"
  run install_binary "$STUB_DIR/src" "$dest_dir"
  [ "$status" -eq 0 ]
  [ "$output" = "$dest_dir/cleetus" ]
  [ -x "$dest_dir/cleetus" ]
  [ "$(cat "$dest_dir/cleetus")" = "binary" ]
}

@test "install_binary dies when the destination dir cannot be created" {
  printf 'binary\n' > "$STUB_DIR/src"
  # A regular file where a directory is expected makes mkdir -p fail.
  printf 'x\n' > "$STUB_DIR/blocker"
  run install_binary "$STUB_DIR/src" "$STUB_DIR/blocker/sub"
  [ "$status" -eq 1 ]
  [[ "$output" == *"cannot create install directory"* ]]
}

@test "check_path is silent when dir is already on PATH" {
  run check_path "/usr/local/bin" "/usr/local/bin:/usr/bin"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "check_path prints export guidance when dir is missing from PATH" {
  run check_path "$HOME/.local/bin" "/usr/bin:/bin"
  [ "$status" -eq 0 ]
  [[ "$output" == *"is not on your PATH"* ]]
  [[ "$output" == *"export PATH=\"$HOME/.local/bin:\$PATH\""* ]]
}

# --- Finding 7: fail closed when no sha256 tool exists ---

_write_checksum_fixture() {
  printf '%s\n' "deadbeef  cleetus-linux-x64" > "$STUB_DIR/checksums.txt"
  printf '%s\n' "binary" > "$STUB_DIR/cleetus-linux-x64"
}

@test "verify_checksum dies when no sha256 tool and no override" {
  _write_checksum_fixture
  run bash -c "source '$REPO_ROOT/install.sh'; sha256_tool() { echo ''; }; \
    verify_checksum '$STUB_DIR/cleetus-linux-x64' cleetus-linux-x64 '$STUB_DIR/checksums.txt'"
  [ "$status" -eq 1 ]
  [[ "$output" == *"no sha256 tool"* ]]
  [[ "$output" == *"coreutils"* ]]
  [[ "$output" == *"CLEETUS_SKIP_CHECKSUM=1"* ]]
}

@test "verify_checksum proceeds with warning when CLEETUS_SKIP_CHECKSUM=1" {
  _write_checksum_fixture
  run env CLEETUS_INSTALLER_TEST=1 CLEETUS_SKIP_CHECKSUM=1 bash -c \
    "source '$REPO_ROOT/install.sh'; sha256_tool() { echo ''; }; \
    verify_checksum '$STUB_DIR/cleetus-linux-x64' cleetus-linux-x64 '$STUB_DIR/checksums.txt'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"WARNING"* ]]
  [[ "$output" == *"skipping checksum verification"* ]]
}
